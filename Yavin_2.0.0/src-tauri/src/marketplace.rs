//! The extension marketplace's network and installation commands (IDE-09).
//!
//! The renderer's marketplace providers ask for documents of a *registry* -- a base URL -- by
//! path; they never name an arbitrary URL, and nothing an extension's manifest says becomes a
//! download target. Every request:
//!
//! - is HTTPS (plain `http://` to the loopback interface only in test builds, the
//!   `test-registry` feature, for the end-to-end test's local registry);
//! - stays inside its registry: a path is checked segment by segment and joined to the base;
//!   redirects are followed here (at most 3), each hop parsed again and allowed only to the
//!   registry's own origin -- scheme, host and port -- and only over HTTPS (EXT-06: `split_url`);
//! - is bounded in time and size, its size counted as it arrives;
//! - is refused when its content type is not what was asked for (an HTML error page, a captive
//!   portal) and, for a package, when its size or SHA-256 differ from what the registry's
//!   index says.
//!
//! A package is downloaded into its install operation's staging folder, validated and unpacked
//! there (`extension_package`), and only then -- after the renderer has validated its manifest --
//! put in place by the inventory (`extension_service`, EXT-02). Its size and SHA-256 are the
//! registry index's, read here, never only the renderer's word. Installing never runs
//! extension code.

use crate::extension_package::{self, unpack, Format, Unpacked, LIMITS};
use crate::extension_service::{operation_id_ok, Committed, ExtensionService};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::Duration;
use tauri::State;

/// Whether `http://127.0.0.1` / `http://localhost` registries are accepted (tests only).
const LOOPBACK_ALLOWED: bool = cfg!(any(test, feature = "test-registry"));
const MAX_REDIRECTS: usize = 3;
/// A registry index; a readme or changelog; an icon.
const MAX_INDEX: u64 = 4 * 1024 * 1024;
const MAX_DOCUMENT: u64 = 512 * 1024;
const MAX_ICON: u64 = 256 * 1024;

/// A registry: where its documents are, and the origins (scheme, host and port) they may come
/// from -- its own, plus any file origins it is known to redirect downloads to (Open VSX's CDN,
/// EXT-03). Origins are compared whole (EXT-06).
#[derive(Debug, Clone, PartialEq)]
pub struct Registry {
    pub(crate) base: String,
    pub(crate) origin: String,
    pub(crate) file_origins: Vec<String>,
    /// The longest one request may take, start to end.
    pub(crate) timeout: Duration,
}

fn invalid(message: impl Into<String>) -> String {
    format!("InvalidRegistry: {}", message.into())
}

/// `scheme://host[:port]` (the default port left out), the host, and the path of an absolute
/// URL -- or why it is not one Yavin accepts (EXT-06). Strict, and never rewritten into another:
///
/// - HTTPS (plain HTTP to the loopback interface only where `loopback` allows it: tests);
/// - a host of DNS labels (`a-z`, `0-9`, `-`; no empty label), no credentials (`user@`), and a
///   port only if it is a number from 1 to 65535;
/// - no whitespace, control characters or backslashes anywhere;
/// - a path with no query or fragment, no `.` or `..` segment (written or percent-encoded), no
///   encoded `/` or `\`, no empty segment (`//`), and only well-formed `%XX` escapes -- so a
///   path that starts with a registry's base stays inside it.
fn split_url(url: &str, loopback: bool) -> Result<(String, String, String), String> {
    if url
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || c == '\\')
    {
        return Err(invalid(format!(
            "\"{url}\" contains a space, a control character or a backslash"
        )));
    }
    let (scheme, rest) = url
        .split_once("://")
        .ok_or_else(|| invalid(format!("\"{url}\" is not an absolute URL")))?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "https" && scheme != "http" {
        return Err(format!(
            "InsecureTransport: \"{url}\" is not HTTPS; Yavin downloads extensions over HTTPS only."
        ));
    }
    let (authority, path) = match rest.find(['/', '?', '#']) {
        Some(at) => (&rest[..at], &rest[at..]),
        None => (rest, "/"),
    };
    if authority.contains('@') {
        return Err(invalid(format!("\"{url}\" names credentials (user@host)")));
    }
    if authority.contains('[') || authority.contains(']') {
        return Err(invalid(format!(
            "\"{url}\" has no plain host (an IP v6 literal)"
        )));
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => {
            let port = port
                .parse::<u16>()
                .ok()
                .filter(|p| *p != 0 && port.bytes().all(|b| b.is_ascii_digit()))
                .ok_or_else(|| invalid(format!("\"{url}\" has an invalid port")))?;
            (host, Some(port))
        }
        None => (authority, None),
    };
    let host = host.to_ascii_lowercase();
    let label_ok = |label: &str| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    };
    if host.is_empty() || host.len() > 253 || !host.split('.').all(label_ok) {
        return Err(invalid(format!("\"{url}\" has no plain host")));
    }
    let is_loopback = host == "127.0.0.1" || host == "localhost";
    let default_port = match scheme.as_str() {
        "https" => 443,
        "http" if loopback && is_loopback => 80,
        _ => {
            return Err(format!(
                "InsecureTransport: \"{url}\" is not HTTPS; Yavin downloads extensions over HTTPS only."
            ))
        }
    };
    if path.contains('?') || path.contains('#') {
        return Err(invalid(format!("\"{url}\" has a query or fragment")));
    }
    path_ok(path).map_err(|why| invalid(format!("\"{url}\" {why}")))?;
    let origin = match port {
        Some(port) if port != default_port => format!("{scheme}://{host}:{port}"),
        _ => format!("{scheme}://{host}"),
    };
    Ok((origin, host, path.to_string()))
}

/// A URL path that means what it says: see `split_url`.
fn path_ok(path: &str) -> Result<(), &'static str> {
    let bytes = path.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = path
                .get(i + 1..i + 3)
                .filter(|h| h.bytes().all(|b| b.is_ascii_hexdigit()));
            match hex.map(|h| h.to_ascii_lowercase()) {
                None => return Err("has a malformed % escape"),
                Some(h) if h == "2f" || h == "5c" => return Err("has an encoded path separator"),
                Some(_) => i += 3,
            }
        } else {
            i += 1;
        }
    }
    let segments: Vec<&str> = path.split('/').skip(1).collect();
    for (n, segment) in segments.iter().enumerate() {
        let decoded = segment.to_ascii_lowercase().replace("%2e", ".");
        if decoded == "." || decoded == ".." {
            return Err("has a . or .. path segment");
        }
        // An empty segment is a `//`; only the last may be empty (a trailing `/`).
        if segment.is_empty() && n + 1 < segments.len() {
            return Err("has an empty path segment (//)");
        }
    }
    Ok(())
}

/// A registry from its base URL (`https://host/path/`).
pub fn registry(base: &str) -> Result<Registry, String> {
    registry_with(base, LOOPBACK_ALLOWED)
}

fn registry_with(base: &str, loopback: bool) -> Result<Registry, String> {
    let (origin, _, path) = split_url(base.trim(), loopback)?;
    if !path.ends_with('/') {
        return Err(invalid(format!("\"{base}\" must end with \"/\"")));
    }
    Ok(Registry {
        base: format!("{origin}{path}"),
        origin,
        file_origins: Vec::new(),
        timeout: Duration::from_secs(120),
    })
}

/// The URL of `path` inside `registry`: relative, `/`-separated, plain segments only.
pub fn url_in(registry: &Registry, path: &str) -> Result<String, String> {
    let ok = !path.is_empty()
        && path.len() <= 512
        && path.split('/').all(|segment| {
            !segment.is_empty()
                && segment != "."
                && segment != ".."
                && segment
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
        });
    if !ok {
        return Err(format!(
            "OutsideRegistry: \"{path}\" is not a path inside the registry."
        ));
    }
    Ok(format!("{}{path}", registry.base))
}

/// `url`, when it is a document of `registry`: HTTPS (loopback in tests), no query, and inside
/// its base -- or on one of its file origins. For URLs a registry's own answers name (Open VSX).
pub fn url_on(registry: &Registry, url: &str) -> Result<String, String> {
    let (origin, _, path) = split_url(url, LOOPBACK_ALLOWED)?;
    let whole = format!("{origin}{path}");
    if whole.starts_with(&registry.base) || registry.file_origins.contains(&origin) {
        Ok(whole)
    } else {
        Err(format!(
            "OutsideRegistry: \"{url}\" is not a file of this registry ({}).",
            registry.base
        ))
    }
}

/// Where a redirect from `from` to `location` leads, if it stays on the registry's host.
pub fn redirect(registry: &Registry, from: &str, location: &str) -> Result<String, String> {
    let refused = || {
        format!("UnexpectedRedirect: {from} redirected to \"{location}\", which is not allowed.")
    };
    let target = if location.contains("://") {
        // Absolute: checked exactly as written, never normalized first.
        location.to_string()
    } else {
        // Relative (EXT-08): resolved against this hop -- not the registry's origin -- as a
        // browser would (root-, path- and parent-relative). What a URL parser would reinterpret
        // is refused first: a backslash (a slash to it), encoded dots or separators (`%2e%2e` is
        // `..` to it), a malformed escape, whitespace or control characters.
        if location.is_empty() || !relative_ok(location) {
            return Err(refused());
        }
        let base = url::Url::parse(from).map_err(|_| refused())?;
        base.join(location).map_err(|_| refused())?.to_string()
    };
    let (origin, _, path) = split_url(&target, LOOPBACK_ALLOWED)?;
    if origin != registry.origin && !registry.file_origins.contains(&origin) {
        return Err(format!(
            "UnexpectedRedirect: {from} redirected to {origin}; only {} is trusted for this registry.",
            registry.origin
        ));
    }
    Ok(format!("{origin}{path}"))
}

/// A relative `Location` with nothing a URL parser would read otherwise than written.
fn relative_ok(location: &str) -> bool {
    if location
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || c == '\\')
    {
        return false;
    }
    let bytes = location.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let Some(hex) = location
                .get(i + 1..i + 3)
                .filter(|h| h.bytes().all(|b| b.is_ascii_hexdigit()))
            else {
                return false;
            };
            if matches!(hex.to_ascii_lowercase().as_str(), "2e" | "2f" | "5c") {
                return false;
            }
            i += 3;
        } else {
            i += 1;
        }
    }
    true
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind {
    Text,
    Icon,
    Package,
}

/// Whether a response's content type is acceptable for what was asked.
pub fn content_type_ok(kind: Kind, content_type: Option<&str>) -> bool {
    let value = content_type
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match kind {
        Kind::Text => {
            value.is_empty()
                || matches!(
                    value.as_str(),
                    "application/json" | "text/plain" | "text/markdown" | "text/x-markdown"
                )
        }
        Kind::Icon => matches!(value.as_str(), "image/png" | "application/octet-stream"),
        Kind::Package => matches!(
            value.as_str(),
            "application/octet-stream"
                | "application/zip"
                | "application/x-zip-compressed"
                | "binary/octet-stream"
        ),
    }
}

fn agent(timeout: Duration) -> ureq::Agent {
    let tls = ureq::tls::TlsConfig::builder()
        .provider(ureq::tls::TlsProvider::NativeTls)
        .build();
    ureq::Agent::config_builder()
        .tls_config(tls)
        .https_only(!LOOPBACK_ALLOWED)
        .max_redirects(0)
        .http_status_as_error(false)
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_global(Some(timeout))
        .user_agent(concat!("Yavin/", env!("CARGO_PKG_VERSION")))
        .build()
        .into()
}

/// GETs `path` from `registry`, following allowed redirects, streaming at most `max` bytes of
/// the body to `sink`. Returns how many bytes it read.
pub fn fetch(
    registry: &Registry,
    path: &str,
    kind: Kind,
    max: u64,
    sink: &mut dyn FnMut(&[u8]) -> Result<(), String>,
) -> Result<u64, String> {
    fetch_url(registry, &url_in(registry, path)?, path, kind, max, sink)
}

/// The same for an absolute `url` Yavin built or checked (`url_on`) for `registry`; `path`
/// names it in messages.
pub fn fetch_url(
    registry: &Registry,
    url: &str,
    path: &str,
    kind: Kind,
    max: u64,
    sink: &mut dyn FnMut(&[u8]) -> Result<(), String>,
) -> Result<u64, String> {
    let agent = agent(registry.timeout);
    let mut url = url.to_string();
    for _ in 0..=MAX_REDIRECTS {
        let mut response = agent.get(&url).call().map_err(|e| {
            format!("MarketplaceUnavailable: the marketplace could not be reached ({e}).")
        })?;
        let status = response.status().as_u16();
        if (300..400).contains(&status) {
            let location = response
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| format!("UnexpectedRedirect: {url} redirected nowhere."))?
                .to_string();
            url = redirect(registry, &url, &location)?;
            continue;
        }
        if status == 404 {
            return Err(format!("NotFound: {path} is not in the marketplace."));
        }
        if status == 429 {
            let after = response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.trim().parse::<u64>().ok());
            return Err(match after {
                Some(seconds) => format!("RateLimited: try again in {seconds} s."),
                None => "RateLimited: try again later.".into(),
            });
        }
        if !(200..300).contains(&status) {
            return Err(format!(
                "MarketplaceUnavailable: the marketplace answered {status} for {path}."
            ));
        }
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        if !content_type_ok(kind, content_type.as_deref()) {
            return Err(format!(
                "UnexpectedContent: {path} came back as {}, not what was asked for.",
                content_type.as_deref().unwrap_or("an unknown type")
            ));
        }
        let mut reader = response.body_mut().as_reader();
        let mut buffer = vec![0u8; 64 * 1024];
        let mut total = 0u64;
        loop {
            let count = reader
                .read(&mut buffer)
                .map_err(|e| format!("MarketplaceUnavailable: the download failed ({e})."))?;
            if count == 0 {
                break;
            }
            total += count as u64;
            if total > max {
                return Err(format!(
                    "TooLarge: {path} is larger than {max} bytes; it was not downloaded."
                ));
            }
            sink(&buffer[..count])?;
        }
        return Ok(total);
    }
    Err(format!(
        "UnexpectedRedirect: {path} redirected more than {MAX_REDIRECTS} times."
    ))
}

// --- Commands --------------------------------------------------------------------------------

/// Yavin's own registry: static files in Yavin's public repository, served over HTTPS.
pub const OFFICIAL_REGISTRY: &str =
    "https://raw.githubusercontent.com/salmanwnl44/Yavin-Rust-1/main/Yavin_2.0.0/registry/";

/// The registry Yavin uses unless the user's settings name another. A `test-registry` build
/// (the end-to-end test's) may point it elsewhere with `YAVIN_TEST_REGISTRY`; no other build
/// reads that.
#[tauri::command]
pub fn marketplace_default_registry() -> String {
    if cfg!(feature = "test-registry") {
        if let Ok(url) = std::env::var("YAVIN_TEST_REGISTRY") {
            return url;
        }
    }
    OFFICIAL_REGISTRY.to_string()
}

/// A registry document as text: its index (`index.json`), a readme, a changelog.
#[tauri::command(async)]
pub fn marketplace_get_text(registry_url: String, path: String) -> Result<String, String> {
    let registry = registry(&registry_url)?;
    let max = if path.ends_with(".json") {
        MAX_INDEX
    } else {
        MAX_DOCUMENT
    };
    let mut bytes = Vec::new();
    fetch(&registry, &path, Kind::Text, max, &mut |chunk| {
        bytes.extend_from_slice(chunk);
        Ok(())
    })?;
    String::from_utf8(bytes).map_err(|_| format!("UnexpectedContent: {path} is not UTF-8 text."))
}

/// A registry's PNG icon, as a `data:` URL (the window loads no images from the network).
#[tauri::command(async)]
pub fn marketplace_get_icon(registry_url: String, path: String) -> Result<String, String> {
    let registry = registry(&registry_url)?;
    let mut bytes = Vec::new();
    fetch(&registry, &path, Kind::Icon, MAX_ICON, &mut |chunk| {
        bytes.extend_from_slice(chunk);
        Ok(())
    })?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(format!("UnexpectedContent: {path} is not a PNG image."));
    }
    Ok(format!("data:image/png;base64,{}", base64(&bytes)))
}

pub(crate) fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(TABLE[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Where a package comes from: a registry (with the size and SHA-256 its index states), or a
/// file the user chose.
#[derive(Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PackageSource {
    #[serde(rename_all = "camelCase")]
    Registry {
        registry_url: String,
        path: String,
        sha256: String,
        size: u64,
    },
    #[serde(rename_all = "camelCase")]
    File { path: String },
    /// A version on an Open VSX registry (EXT-03): its metadata is read natively, and gives the
    /// package and its checksum.
    #[serde(rename_all = "camelCase")]
    OpenVsx {
        registry_url: String,
        namespace: String,
        name: String,
    },
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Staged {
    pub token: String,
    pub manifest: String,
    pub files: usize,
    pub bytes: u64,
    pub sha256: String,
    pub package_size: u64,
}

/// What `registry`'s own index says of `id` at `version`: its package's path, SHA-256 and size.
fn index_entry(
    registry: &Registry,
    id: &str,
    version: &str,
) -> Result<(String, String, u64), String> {
    let mut bytes = Vec::new();
    fetch(
        registry,
        "index.json",
        Kind::Text,
        MAX_INDEX,
        &mut |chunk| {
            bytes.extend_from_slice(chunk);
            Ok(())
        },
    )?;
    let index: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| "UnexpectedContent: the registry's index is not JSON.".to_string())?;
    let published = index["extensions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|one| {
            one["id"]
                .as_str()
                .and_then(ide_workspace::extension_id::canonical_id)
                .as_deref()
                == Some(id)
        })
        .flat_map(|one| one["versions"].as_array().into_iter().flatten())
        .find(|one| one["version"].as_str() == Some(version))
        .ok_or_else(|| format!("NotFound: {id} {version} is not in the registry's index."))?;
    match (
        published["package"].as_str(),
        published["sha256"].as_str(),
        published["size"].as_u64(),
    ) {
        (Some(path), Some(sha256), Some(size)) => Ok((path.to_string(), sha256.to_string(), size)),
        _ => Err(format!(
            "NotFound: the registry's index has no package for {id} {version}."
        )),
    }
}

/// Downloads (or copies), verifies and unpacks a package as a new install operation of
/// `expected_id` at `expected_version`, into the operation's own staging folder.
pub fn stage(
    service: &ExtensionService,
    source: PackageSource,
    expected_id: &str,
    expected_version: &str,
) -> Result<Staged, String> {
    let label = match &source {
        PackageSource::Registry { registry_url, .. } => format!("registry {registry_url}"),
        PackageSource::File { .. } => "file".to_string(),
        PackageSource::OpenVsx { registry_url, .. } => format!("openvsx {registry_url}"),
    };
    // What each source serves: Yavin's registry Yavin packages, Open VSX VS Code packages; a
    // file may be either. The archive's contents decide its format, never this.
    let expected = match source {
        PackageSource::Registry { .. } => Some(Format::Yavin),
        PackageSource::OpenVsx { .. } => Some(Format::Vsix),
        PackageSource::File { .. } => None,
    };
    let (op, folder) = service.begin(expected_id, expected_version, &label)?;
    let archive = folder.join("package.yvx");
    let result = (|| {
        let (sha256, size) = match source {
            PackageSource::Registry {
                registry_url,
                path,
                sha256,
                size,
            } => {
                let registry = registry(&registry_url)?;
                // The renderer names the package; the registry's index vouches for it.
                let (indexed_path, indexed_sha256, indexed_size) =
                    index_entry(&registry, expected_id, expected_version)?;
                if indexed_path != path
                    || !indexed_sha256.eq_ignore_ascii_case(&sha256)
                    || indexed_size != size
                {
                    return Err(format!(
                        "IntegrityFailed: the registry's index describes {expected_id} {expected_version} differently ({indexed_path}, {indexed_size} bytes, SHA-256 {indexed_sha256})."
                    ));
                }
                if size > LIMITS.package {
                    return Err(format!(
                        "UnsafePackage: the registry says the package is {size} bytes (the limit is {}).",
                        LIMITS.package
                    ));
                }
                let mut file =
                    fs::File::create(&archive).map_err(|e| format!("InstallFailed: {e}"))?;
                let mut hasher = Sha256::new();
                let read = fetch(&registry, &path, Kind::Package, size, &mut |chunk| {
                    hasher.update(chunk);
                    file.write_all(chunk)
                        .map_err(|e| format!("InstallFailed: {e}"))
                })?;
                drop(file);
                let actual = extension_package::hex(&hasher.finalize());
                if read != size {
                    return Err(format!(
                        "IntegrityFailed: the package is {read} bytes, but the registry says {size}."
                    ));
                }
                if !actual.eq_ignore_ascii_case(&sha256) {
                    return Err(format!(
                        "IntegrityFailed: the package's SHA-256 is {actual}, but the registry says {sha256}."
                    ));
                }
                (actual, read)
            }
            PackageSource::File { path } => {
                let from = PathBuf::from(&path);
                let meta = fs::metadata(&from)
                    .map_err(|_| format!("PackageMissing: {path} does not exist."))?;
                if !meta.is_file() {
                    return Err(format!("PackageMissing: {path} is not a file."));
                }
                fs::copy(&from, &archive).map_err(|e| format!("InstallFailed: {e}"))?;
                (extension_package::sha256_file(&archive)?, meta.len())
            }
            PackageSource::OpenVsx {
                registry_url,
                namespace,
                name,
            } => crate::openvsx::download(
                &crate::openvsx::registry(&registry_url)?,
                &namespace,
                &name,
                expected_id,
                expected_version,
                &archive,
            )?,
        };
        let files_dir = folder.join("files");
        let Unpacked {
            manifest,
            format,
            files,
            bytes,
        } = unpack(&archive, &files_dir, &LIMITS)?;
        match (expected, format) {
            (Some(Format::Yavin), Format::Vsix) => {
                return Err(format!(
                    "UnsupportedPackage: {expected_id} {expected_version} from Yavin's registry is a VS Code package; the registry serves Yavin packages."
                ))
            }
            (Some(Format::Vsix), Format::Yavin) => {
                return Err(format!(
                    "InvalidPackage: {expected_id} {expected_version} from Open VSX is not a VS Code package (.vsix)."
                ))
            }
            _ => {}
        }
        // A VS Code package: its declarative contributions, adapted (EXT-04).
        if format == Format::Vsix {
            crate::vsix::adapt(&files_dir, &manifest, expected_id, expected_version)?;
        }
        Ok((sha256, size, files, bytes))
    })();
    let _ = fs::remove_file(&archive);
    let (sha256, package_size, files, bytes) = match result {
        Ok(done) => done,
        Err(error) => {
            service.abort(&op);
            return Err(error);
        }
    };
    // The inventory checks that the unpacked manifest is the id and version asked for.
    let manifest = service.staged(&op, &sha256)?;
    Ok(Staged {
        token: op,
        manifest,
        files,
        bytes,
        sha256,
        package_size,
    })
}

#[tauri::command(async)]
pub fn extensions_stage(
    service: State<'_, ExtensionService>,
    source: PackageSource,
    expected_id: String,
    expected_version: String,
) -> Result<Staged, String> {
    stage(&service, source, &expected_id, &expected_version)
}

/// Puts a staged package in place (the inventory's `commit`: the id is the staged manifest's,
/// and `id` must name the same extension).
#[tauri::command(async)]
pub fn extensions_commit(
    service: State<'_, ExtensionService>,
    token: String,
    id: String,
) -> Result<Committed, String> {
    service.commit(&token, &id)
}

/// Keeps the new installation or rolls back to the one before.
#[tauri::command(async)]
pub fn extensions_finish(
    service: State<'_, ExtensionService>,
    token: String,
    id: String,
    keep: bool,
) -> Result<(), String> {
    service.finish(&token, &id, keep)
}

/// Throws a staged package away.
#[tauri::command(async)]
pub fn extensions_discard(
    service: State<'_, ExtensionService>,
    token: String,
) -> Result<(), String> {
    operation_id_ok(&token)?;
    service.discard(&token)
}

/// Uninstalls an extension from Yavin's extensions folder.
#[tauri::command(async)]
pub fn extensions_uninstall(
    service: State<'_, ExtensionService>,
    id: String,
) -> Result<String, String> {
    service.uninstall(&id)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::extension_package::tests::{package, temp, MANIFEST};
    use crate::extensions::MANIFEST_FILE;
    use std::io::BufRead;
    use std::net::TcpListener;
    use std::path::Path;

    #[test]
    fn registries_are_https_and_paths_stay_inside_them() {
        let r = registry_with("https://Example.com/registry/", false).unwrap();
        assert_eq!(
            url_in(&r, "packages/acme.hello-1.0.0.yvx").unwrap(),
            "https://example.com/registry/packages/acme.hello-1.0.0.yvx"
        );
        for bad in [
            "../x",
            "/abs",
            "a//b",
            "a/./b",
            "https://evil.com/x",
            "a?b",
            "a%2e%2e/b",
            "",
        ] {
            assert!(
                url_in(&r, bad).unwrap_err().starts_with("OutsideRegistry"),
                "{bad}"
            );
        }
        for (base, why) in [
            ("http://example.com/r/", "InsecureTransport"),
            ("ftp://example.com/r/", "InsecureTransport"),
            ("http://127.0.0.1:8080/r/", "InsecureTransport"),
            ("https://user@example.com/r/", "InvalidRegistry"),
            ("https://example.com/r", "InvalidRegistry"),
            ("https://example.com/r/?q=1", "InvalidRegistry"),
            ("example.com/r/", "InvalidRegistry"),
        ] {
            assert!(
                registry_with(base, false).unwrap_err().starts_with(why),
                "{base}"
            );
        }
        // Loopback over HTTP only where explicitly allowed (tests, the test-registry build).
        assert!(registry_with("http://127.0.0.1:8080/r/", true).is_ok());
        assert!(registry_with("http://example.com/r/", true).is_err());
    }

    #[test]
    fn redirects_stay_on_the_registry_host_and_on_https() {
        let r = registry_with("https://example.com/registry/", false).unwrap();
        let from = "https://example.com/registry/index.json";
        assert_eq!(
            redirect(&r, from, "/registry/moved.json").unwrap(),
            "https://example.com/registry/moved.json"
        );
        assert!(redirect(&r, from, "https://example.com/elsewhere").is_ok());
        for (location, why) in [
            ("https://evil.example.net/x.yvx", "UnexpectedRedirect"),
            ("http://example.com/x", "InsecureTransport"),
            ("//evil.com/x", "UnexpectedRedirect"),
            ("file:///C:/Windows/x", "InsecureTransport"),
        ] {
            assert!(
                redirect(&r, from, location).unwrap_err().starts_with(why),
                "{location}"
            );
        }
    }

    #[test]
    fn content_types_must_match_what_was_asked() {
        assert!(content_type_ok(
            Kind::Text,
            Some("text/plain; charset=utf-8")
        ));
        assert!(content_type_ok(Kind::Text, Some("application/json")));
        assert!(!content_type_ok(Kind::Text, Some("text/html")));
        assert!(content_type_ok(
            Kind::Package,
            Some("application/octet-stream")
        ));
        assert!(!content_type_ok(
            Kind::Package,
            Some("text/html; charset=utf-8")
        ));
        assert!(!content_type_ok(Kind::Package, None));
        assert!(content_type_ok(Kind::Icon, Some("image/png")));
        assert!(!content_type_ok(Kind::Icon, Some("image/svg+xml")));
    }

    /// Every package Yavin's registry publishes passes the installer's own validation, matches
    /// the size and SHA-256 its index states, and is the extension and version it claims.
    #[test]
    fn the_published_registry_packages_are_valid_and_match_their_index() {
        let registry = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("registry");
        let index: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(registry.join("index.json")).unwrap())
                .unwrap();
        let mut checked = 0;
        for extension in index["extensions"].as_array().unwrap() {
            let id = extension["id"].as_str().unwrap();
            for version in extension["versions"].as_array().unwrap() {
                let file = registry.join(version["package"].as_str().unwrap());
                let bytes = fs::read(&file).unwrap();
                assert_eq!(
                    bytes.len() as u64,
                    version["size"].as_u64().unwrap(),
                    "{id}"
                );
                assert_eq!(sha(&bytes), version["sha256"].as_str().unwrap(), "{id}");
                let out = temp(&format!("published-{checked}"));
                let unpacked = unpack(&file, &out.join("x"), &LIMITS).unwrap();
                assert_eq!(
                    extension_package::identity(&unpacked.manifest).unwrap(),
                    (
                        id.to_string(),
                        version["version"].as_str().unwrap().to_string()
                    )
                );
                let _ = fs::remove_dir_all(&out);
                checked += 1;
            }
        }
        assert!(checked >= 4, "{checked} packages");
    }

    /// The real network (run on purpose: `cargo test -p yavin-ide --lib live_ -- --ignored`).
    /// HTTPS through the platform's TLS to GitHub, the host Yavin's registry is served from.
    #[test]
    #[ignore = "uses the network"]
    fn live_https_fetch_through_the_platform_tls() {
        let repository =
            registry("https://raw.githubusercontent.com/salmanwnl44/Yavin-Rust-1/main/").unwrap();
        let mut text = Vec::new();
        let read = fetch(
            &repository,
            "LICENSE",
            Kind::Text,
            64 * 1024,
            &mut |chunk| {
                text.extend_from_slice(chunk);
                Ok(())
            },
        )
        .unwrap();
        assert!(read > 0);
        assert!(String::from_utf8(text).unwrap().starts_with("MIT License"));
        // A size limit is enforced on the real stream too.
        let small = fetch(&repository, "LICENSE", Kind::Text, 10, &mut |_| Ok(())).unwrap_err();
        assert!(small.starts_with("TooLarge"), "{small}");
        let missing = fetch(
            &repository,
            "no-such-file.json",
            Kind::Text,
            1024,
            &mut |_| Ok(()),
        );
        assert!(missing.unwrap_err().starts_with("NotFound"));
    }

    /// Yavin's published registry, end to end: its index over HTTPS, then every package of
    /// every extension downloaded, size- and SHA-256-checked, validated and unpacked.
    #[test]
    #[ignore = "uses the network; needs the registry published"]
    fn live_official_registry_index_and_packages() {
        let official = registry(OFFICIAL_REGISTRY).unwrap();
        let mut bytes = Vec::new();
        fetch(
            &official,
            "index.json",
            Kind::Text,
            MAX_INDEX,
            &mut |chunk| {
                bytes.extend_from_slice(chunk);
                Ok(())
            },
        )
        .unwrap_or_else(|e| panic!("the published index: {e}"));
        let index: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(index["schema"], 1);
        let root = temp("live-registry");
        let service = ExtensionService::new(root.clone(), Vec::new());
        let mut installed = 0;
        for extension in index["extensions"].as_array().unwrap() {
            let id = extension["id"].as_str().unwrap();
            for version in extension["versions"].as_array().unwrap() {
                let staged = stage(
                    &service,
                    PackageSource::Registry {
                        registry_url: OFFICIAL_REGISTRY.into(),
                        path: version["package"].as_str().unwrap().into(),
                        sha256: version["sha256"].as_str().unwrap().into(),
                        size: version["size"].as_u64().unwrap(),
                    },
                    id,
                    version["version"].as_str().unwrap(),
                )
                .unwrap_or_else(|e| panic!("{id}: {e}"));
                assert!(staged.files > 0);
                installed += 1;
            }
        }
        assert!(installed >= 4, "{installed}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn base64_matches_the_standard_alphabet() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"\x89PNG"), "iVBORw==");
    }

    /// A loopback HTTP server answering each request from `respond(path)`.
    pub(crate) fn serve(
        respond: impl Fn(&str) -> (u16, Vec<(&'static str, String)>, Vec<u8>) + Send + 'static,
    ) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() {
                    continue;
                }
                let path = line.split_whitespace().nth(1).unwrap_or("/").to_string();
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).unwrap_or(0) == 0 || header == "\r\n" {
                        break;
                    }
                }
                let (status, headers, body) = respond(&path);
                let mut head = format!(
                    "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n",
                    body.len()
                );
                for (name, value) in headers {
                    head.push_str(&format!("{name}: {value}\r\n"));
                }
                head.push_str("\r\n");
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&body);
            }
        });
        format!("http://127.0.0.1:{port}/registry/")
    }

    pub(crate) fn sha(bytes: &[u8]) -> String {
        extension_package::hex(&Sha256::digest(bytes))
    }

    #[test]
    fn a_package_is_downloaded_verified_and_unpacked_and_bad_ones_are_refused() {
        let dir = temp("download");
        let good = fs::read(package(
            &dir,
            &[
                (MANIFEST_FILE, MANIFEST.as_bytes()),
                ("extension.js", b"module.exports={}"),
            ],
        ))
        .unwrap();
        let body = good.clone();
        // The registry's index: what each case says the package is.
        let index = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let served = index.clone();
        let base = serve(move |path| {
            let octet = vec![("Content-Type", "application/octet-stream".to_string())];
            match path {
                "/registry/index.json" => (
                    200,
                    vec![("Content-Type", "application/json".into())],
                    served.lock().unwrap().clone().into_bytes(),
                ),
                "/registry/good.yvx" => (200, octet, body.clone()),
                "/registry/html.yvx" => (
                    200,
                    vec![("Content-Type", "text/html".into())],
                    b"<html>".to_vec(),
                ),
                "/registry/away.yvx" => (
                    302,
                    vec![("Location", "https://evil.example.net/x.yvx".into())],
                    vec![],
                ),
                "/registry/moved.yvx" => {
                    (301, vec![("Location", "/registry/good.yvx".into())], vec![])
                }
                _ => (404, vec![], vec![]),
            }
        });
        let describe = |id: &str, version: &str, path: &str, sha256: &str, size: u64| {
            *index.lock().unwrap() = serde_json::json!({"schema": 1, "extensions": [{"id": id, "versions": [{"version": version, "package": path, "sha256": sha256, "size": size}]}]}).to_string();
        };
        let service = ExtensionService::new(dir.join("root"), Vec::new());
        // Each case stages again at once, as if the one before had lost its window.
        *service.abandoned_after.lock().unwrap() = Some(std::time::Duration::ZERO);
        let from = |path: &str, sha256: &str, size: u64| PackageSource::Registry {
            registry_url: base.clone(),
            path: path.into(),
            sha256: sha256.into(),
            size,
        };
        let n = good.len() as u64;
        describe("acme.hello", "1.0.0", "good.yvx", &sha(&good), n);
        let staged = stage(
            &service,
            from("good.yvx", &sha(&good), n),
            "acme.hello",
            "1.0.0",
        )
        .unwrap();
        assert_eq!(staged.manifest, MANIFEST);
        let staging = dir.join("root").join(crate::extension_service::STAGING);
        assert!(staging
            .join(&staged.token)
            .join("files")
            .join("extension.js")
            .is_file());
        // A same-host redirect is followed.
        describe("acme.hello", "1.0.0", "moved.yvx", &sha(&good), n);
        assert!(stage(
            &service,
            from("moved.yvx", &sha(&good), n),
            "acme.hello",
            "1.0.0"
        )
        .is_ok());
        for (path, sha256, size, why) in [
            ("good.yvx", "0".repeat(64), n, "IntegrityFailed"),
            ("good.yvx", sha(&good), n - 1, "TooLarge"),
            ("good.yvx", sha(&good), n + 1, "IntegrityFailed"),
            ("html.yvx", sha(&good), n, "UnexpectedContent"),
            ("away.yvx", sha(&good), n, "UnexpectedRedirect"),
            ("missing.yvx", sha(&good), n, "NotFound"),
            ("../good.yvx", sha(&good), n, "OutsideRegistry"),
            ("good.yvx", sha(&good), LIMITS.package + 1, "UnsafePackage"),
        ] {
            describe("acme.hello", "1.0.0", path, &sha256, size);
            let error =
                stage(&service, from(path, &sha256, size), "acme.hello", "1.0.0").unwrap_err();
            assert!(error.starts_with(why), "{why}: {error}");
        }
        // The renderer's word is not enough: the index must say the same.
        describe("acme.hello", "1.0.0", "good.yvx", &sha(&good), n);
        for (path, sha256, size) in [
            ("good.yvx", "0".repeat(64), n),
            ("good.yvx", sha(&good), n + 1),
            ("moved.yvx", sha(&good), n),
        ] {
            let error =
                stage(&service, from(path, &sha256, size), "acme.hello", "1.0.0").unwrap_err();
            assert!(error.contains("index describes"), "{error}");
        }
        let unlisted = stage(
            &service,
            from("good.yvx", &sha(&good), n),
            "acme.hello",
            "3.0.0",
        )
        .unwrap_err();
        assert!(unlisted.starts_with("NotFound"), "{unlisted}");
        describe("acme.other", "1.0.0", "good.yvx", &sha(&good), n);
        let mismatch = stage(
            &service,
            from("good.yvx", &sha(&good), n),
            "acme.other",
            "1.0.0",
        )
        .unwrap_err();
        assert!(mismatch.starts_with("ManifestMismatch"), "{mismatch}");
        describe("acme.hello", "2.0.0", "good.yvx", &sha(&good), n);
        let version = stage(
            &service,
            from("good.yvx", &sha(&good), n),
            "acme.hello",
            "2.0.0",
        )
        .unwrap_err();
        assert!(version.starts_with("ManifestMismatch"), "{version}");
        // Nothing of a refused package is left in staging; a newer staging of the same id
        // replaced the idle one before it.
        let left: Vec<_> = fs::read_dir(&staging).unwrap().collect();
        assert_eq!(left.len(), 0);
        let missing = stage(
            &service,
            PackageSource::File {
                path: dir.join("nope.yvx").to_string_lossy().into(),
            },
            "acme.hello",
            "1.0.0",
        )
        .unwrap_err();
        assert!(missing.starts_with("PackageMissing"), "{missing}");
        let _ = fs::remove_dir_all(&dir);
    }
}

/// EXT-06: URLs and redirects, adversarially.
#[cfg(test)]
mod hardening_tests {
    use super::*;
    use crate::marketplace::tests::serve;

    #[test]
    fn hostile_urls_and_registry_bases_are_refused() {
        for (url, why) in [
            ("https://user:secret@example.com/registry/", "credentials"),
            ("https://example.com@evil.net/registry/", "credentials"),
            ("https://example.com:0/registry/", "invalid port"),
            ("https://example.com:99999/registry/", "invalid port"),
            ("https://example.com:/registry/", "invalid port"),
            ("https://example.com:44a3/registry/", "invalid port"),
            ("https://[::1]/registry/", "no plain host"),
            ("https:///registry/", "no plain host"),
            ("https://exa_mple.com/registry/", "no plain host"),
            ("https://example..com/registry/", "no plain host"),
            ("https://-example.com/registry/", "no plain host"),
            ("https://exa mple.com/registry/", "space"),
            ("https://example.com/re\tgistry/", "control"),
            ("https://example.com\registry/", "backslash"),
            ("ftp://example.com/registry/", "InsecureTransport"),
            ("http://example.com/registry/", "InsecureTransport"),
            ("https://example.com/registry/../admin/", ". or .."),
            ("https://example.com/registry/./", ". or .."),
            ("https://example.com/registry/%2e%2e/admin/", ". or .."),
            ("https://example.com/registry/%2E./admin/", ". or .."),
            ("https://example.com/registry/.%2e/admin/", ". or .."),
            (
                "https://example.com/registry%2f..%2fadmin/",
                "encoded path separator",
            ),
            (
                "https://example.com/registry%5cadmin/",
                "encoded path separator",
            ),
            ("https://example.com/registry%zz/", "malformed"),
            ("https://example.com/registry%2/", "malformed"),
            ("https://example.com//registry/", "empty path segment"),
            ("https://example.com/registry//x/", "empty path segment"),
            ("https://example.com/registry/?q=1", "query or fragment"),
            ("https://example.com/registry/#top", "query or fragment"),
            ("https://example.com?/registry/", "query or fragment"),
            ("https://example.com/registry", "must end with"),
        ] {
            let error = registry_with(url, false).unwrap_err();
            assert!(error.contains(why), "{url}: {error}");
        }
        // The default port is the same origin; nothing else is rewritten.
        let plain = registry_with("https://Example.com/registry/", false).unwrap();
        let explicit = registry_with("https://example.com:443/registry/", false).unwrap();
        assert_eq!(plain, explicit);
        assert_eq!(plain.base, "https://example.com/registry/");
        let other_port = registry_with("https://example.com:8443/registry/", false).unwrap();
        assert_eq!(other_port.origin, "https://example.com:8443");
    }

    #[test]
    fn a_redirect_must_stay_on_the_registrys_whole_origin() {
        let r = registry_with("https://example.com/registry/", false).unwrap();
        let from = "https://example.com/registry/index.json";
        assert_eq!(
            redirect(&r, from, "https://example.com:443/registry/x.yvx").unwrap(),
            "https://example.com/registry/x.yvx"
        );
        for location in [
            "https://example.com:8443/registry/x.yvx",
            "https://cdn.example.com/registry/x.yvx",
            "http://example.com/registry/x.yvx",
            "https://user@example.com/registry/x.yvx",
            "https://example.com/registry/../../etc/x",
            "https://example.com/registry/%2e%2e/x",
            "https://example.com/registry/x.yvx?token=1",
            "//evil.net/x.yvx",
            "javascript:alert(1)",
        ] {
            assert!(redirect(&r, from, location).is_err(), "{location}");
        }
        // A relative location is checked as the URL it makes.
        assert!(redirect(&r, from, "/registry/%2e%2e/x").is_err());
        assert!(redirect(&r, from, "/registry/y.yvx").is_ok());
    }

    /// A relative `Location` is resolved against the hop that sent it (EXT-08): root-, path-
    /// and parent-relative as a browser would; a query or fragment is still refused, and so is
    /// anything a URL parser would read otherwise than written. Every result is checked again.
    #[test]
    fn a_relative_redirect_resolves_against_its_own_hop() {
        let r = registry_with("https://example.com/registry/", false).unwrap();
        let from = "https://example.com/registry/sub/a.json";
        for (location, to) in [
            ("/registry/b.json", "https://example.com/registry/b.json"),
            ("b.json", "https://example.com/registry/sub/b.json"),
            ("./b.json", "https://example.com/registry/sub/b.json"),
            ("../c.json", "https://example.com/registry/c.json"),
            (
                "deeper/d.json",
                "https://example.com/registry/sub/deeper/d.json",
            ),
        ] {
            assert_eq!(redirect(&r, from, location).unwrap(), to, "{location}");
        }
        for location in [
            "?x=1",
            "#f",
            "b.json?token=1",
            "%2e%2e/c.json",
            "..%2fc.json",
            "..%2Fc.json",
            "%5cevil",
            "a%zz",
            "a%2",
            "\\evil.com\\x",
            "..\\c.json",
            " b.json",
            "b\njson",
            "//evil.com/x",
            "",
        ] {
            assert!(redirect(&r, from, location).is_err(), "{location:?}");
        }
        // Open VSX: a relative redirect from its file host stays on its file host (it went to
        // open-vsx.org before) -- and the file host's relatives are still only those two origins.
        let official = registry_with("https://open-vsx.org/", false).unwrap();
        let mut official = official;
        official
            .file_origins
            .push("https://openvsx.eclipsecontent.org".into());
        let cdn = "https://openvsx.eclipsecontent.org/redhat/vscode-yaml/1.15.0/file/a.vsix";
        assert_eq!(
            redirect(&official, cdn, "b.vsix").unwrap(),
            "https://openvsx.eclipsecontent.org/redhat/vscode-yaml/1.15.0/file/b.vsix"
        );
        assert!(redirect(&official, cdn, "//evil.com/a.vsix").is_err());
    }

    #[test]
    fn a_redirect_chain_is_checked_hop_by_hop() {
        // A second server: the same host, another port -- another origin.
        let elsewhere = serve(|_| {
            (
                200,
                vec![("Content-Type", "application/json".into())],
                b"{}".to_vec(),
            )
        });
        let other = elsewhere.trim_end_matches("registry/").to_string();
        let base = serve(move |path| match path {
            "/registry/a.json" => (302, vec![("Location", "/registry/b.json".into())], vec![]),
            "/registry/b.json" => (
                302,
                vec![("Location", format!("{other}registry/c.json"))],
                vec![],
            ),
            "/registry/loop.json" => (
                302,
                vec![("Location", "/registry/loop.json".into())],
                vec![],
            ),
            "/registry/ok.json" => (302, vec![("Location", "/registry/end.json".into())], vec![]),
            // A chain of relative hops, each resolved against the one before (EXT-08).
            "/registry/rel/a.json" => (302, vec![("Location", "b.json".into())], vec![]),
            "/registry/rel/b.json" => (302, vec![("Location", "../end.json".into())], vec![]),
            "/registry/end.json" => (
                200,
                vec![("Content-Type", "application/json".into())],
                b"{}".to_vec(),
            ),
            _ => (404, vec![], vec![]),
        });
        let r = registry(&base).unwrap();
        let get = |path: &str| fetch(&r, path, Kind::Text, 1024, &mut |_| Ok(()));
        assert_eq!(get("ok.json").unwrap(), 2, "a same-origin hop is followed");
        assert_eq!(
            get("rel/a.json").unwrap(),
            2,
            "relative hops resolve against each hop"
        );
        let error = get("a.json").unwrap_err();
        assert!(
            error.starts_with("UnexpectedRedirect") && error.contains(":"),
            "{error}"
        );
        assert!(get("loop.json").unwrap_err().contains("more than 3 times"));
    }
}
