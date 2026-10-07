//! The extension marketplace's network and installation commands (IDE-09).
//!
//! The renderer's marketplace providers ask for documents of a *registry* -- a base URL -- by
//! path; they never name an arbitrary URL, and nothing an extension's manifest says becomes a
//! download target. Every request:
//!
//! - is HTTPS (plain `http://` to the loopback interface only in test builds, the
//!   `test-registry` feature, for the end-to-end test's local registry);
//! - stays inside its registry: a path is checked segment by segment and joined to the base;
//!   redirects are followed here (at most 3), each one only to the registry's own host and
//!   only over HTTPS;
//! - is bounded in time and size, its size counted as it arrives;
//! - is refused when its content type is not what was asked for (an HTML error page, a captive
//!   portal) and, for a package, when its size or SHA-256 differ from what the registry's
//!   index says.
//!
//! A package is downloaded into the extensions root's `.staging` folder, validated and
//! unpacked there (`extension_package`), and only then -- after the renderer has validated its
//! manifest -- put in place. Installing never runs extension code.

use crate::extension_package::{self, commit, finish, recover, unpack, Unpacked, LIMITS, STAGING};
use crate::extensions::roots;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::AppHandle;

/// Whether `http://127.0.0.1` / `http://localhost` registries are accepted (tests only).
const LOOPBACK_ALLOWED: bool = cfg!(any(test, feature = "test-registry"));
const MAX_REDIRECTS: usize = 3;
/// A registry index; a readme or changelog; an icon.
const MAX_INDEX: u64 = 4 * 1024 * 1024;
const MAX_DOCUMENT: u64 = 512 * 1024;
const MAX_ICON: u64 = 256 * 1024;

/// A registry: where its documents are, and the one host they may come from.
#[derive(Debug, Clone, PartialEq)]
pub struct Registry {
    base: String,
    origin: String,
    host: String,
}

fn invalid(message: impl Into<String>) -> String {
    format!("InvalidRegistry: {}", message.into())
}

/// `scheme://authority` and the path of an absolute URL, or why it is not one Yavin accepts.
fn split_url(url: &str, loopback: bool) -> Result<(String, String, String), String> {
    let (scheme, rest) = url
        .split_once("://")
        .ok_or_else(|| invalid(format!("\"{url}\" is not an absolute URL")))?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "https" && scheme != "http" {
        return Err(format!(
            "InsecureTransport: \"{url}\" is not HTTPS; Yavin downloads extensions over HTTPS only."
        ));
    }
    let (authority, path) = match rest.find('/') {
        Some(at) => (&rest[..at], &rest[at..]),
        None => (rest, "/"),
    };
    if authority.is_empty() || authority.contains('@') || authority.contains('\\') {
        return Err(invalid(format!("\"{url}\" has no plain host")));
    }
    let host = authority
        .rsplit_once(':')
        .filter(|(_, port)| port.chars().all(|c| c.is_ascii_digit()))
        .map(|(host, _)| host)
        .unwrap_or(authority)
        .to_ascii_lowercase();
    let is_loopback = host == "127.0.0.1" || host == "localhost";
    match scheme.as_str() {
        "https" => {}
        "http" if loopback && is_loopback => {}
        _ => {
            return Err(format!(
                "InsecureTransport: \"{url}\" is not HTTPS; Yavin downloads extensions over HTTPS only."
            ))
        }
    }
    if path.contains('?') || path.contains('#') {
        return Err(invalid(format!("\"{url}\" has a query or fragment")));
    }
    Ok((
        format!("{scheme}://{}", authority.to_ascii_lowercase()),
        host,
        path.to_string(),
    ))
}

/// A registry from its base URL (`https://host/path/`).
pub fn registry(base: &str) -> Result<Registry, String> {
    registry_with(base, LOOPBACK_ALLOWED)
}

fn registry_with(base: &str, loopback: bool) -> Result<Registry, String> {
    let (origin, host, path) = split_url(base.trim(), loopback)?;
    if !path.ends_with('/') {
        return Err(invalid(format!("\"{base}\" must end with \"/\"")));
    }
    Ok(Registry {
        base: format!("{origin}{path}"),
        origin,
        host,
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

/// Where a redirect from `from` to `location` leads, if it stays on the registry's host.
pub fn redirect(registry: &Registry, from: &str, location: &str) -> Result<String, String> {
    let target = if location.starts_with('/') && !location.starts_with("//") {
        format!("{}{location}", registry.origin)
    } else if location.contains("://") {
        location.to_string()
    } else {
        return Err(format!(
            "UnexpectedRedirect: {from} redirected to \"{location}\", which is not allowed."
        ));
    };
    let (_, host, _) = split_url(&target, LOOPBACK_ALLOWED)?;
    if host != registry.host {
        return Err(format!(
            "UnexpectedRedirect: {from} redirected to another host ({host}); only {} is trusted for this registry.",
            registry.host
        ));
    }
    Ok(target)
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

fn agent() -> ureq::Agent {
    let tls = ureq::tls::TlsConfig::builder()
        .provider(ureq::tls::TlsProvider::NativeTls)
        .build();
    ureq::Agent::config_builder()
        .tls_config(tls)
        .https_only(!LOOPBACK_ALLOWED)
        .max_redirects(0)
        .http_status_as_error(false)
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_global(Some(Duration::from_secs(120)))
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
    let agent = agent();
    let mut url = url_in(registry, path)?;
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

fn base64(bytes: &[u8]) -> String {
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

fn new_token() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!(
        "{:x}{:x}{:x}",
        nanos,
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

fn token_ok(token: &str) -> Result<(), String> {
    if (8..=64).contains(&token.len()) && token.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(format!(
            "InvalidRequest: \"{token}\" is not an install token."
        ))
    }
}

/// Downloads (or copies), verifies and unpacks a package into `root/.staging/<token>/`.
pub fn stage(
    root: &Path,
    source: PackageSource,
    expected_id: &str,
    expected_version: &str,
) -> Result<Staged, String> {
    if !extension_package::valid_id(expected_id) {
        return Err(format!(
            "InvalidRequest: \"{expected_id}\" is not an extension id."
        ));
    }
    let staging = root.join(STAGING);
    fs::create_dir_all(&staging).map_err(|e| format!("InstallFailed: {e}"))?;
    let token = new_token();
    let archive = staging.join(format!("{token}.yvx"));
    let result = (|| {
        let (sha256, size) = match source {
            PackageSource::Registry {
                registry_url,
                path,
                sha256,
                size,
            } => {
                if size > LIMITS.package {
                    return Err(format!(
                        "UnsafePackage: the registry says the package is {size} bytes (the limit is {}).",
                        LIMITS.package
                    ));
                }
                let registry = registry(&registry_url)?;
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
        };
        let Unpacked {
            manifest,
            files,
            bytes,
        } = unpack(&archive, &staging.join(&token), &LIMITS)?;
        let (id, version) = extension_package::identity(&manifest)?;
        if id != expected_id {
            return Err(format!(
                "ManifestMismatch: the package is {id}, not {expected_id}."
            ));
        }
        if !expected_version.is_empty() && version != expected_version {
            return Err(format!(
                "ManifestMismatch: the package is version {version}, not {expected_version}."
            ));
        }
        Ok(Staged {
            token: token.clone(),
            manifest,
            files,
            bytes,
            sha256,
            package_size: size,
        })
    })();
    let _ = fs::remove_file(&archive);
    if result.is_err() {
        let _ = fs::remove_dir_all(staging.join(&token));
    }
    result
}

fn user_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = roots(app)?.remove(0);
    fs::create_dir_all(&root).map_err(|e| format!("InstallFailed: {e}"))?;
    Ok(root)
}

#[tauri::command(async)]
pub fn extensions_stage(
    app: AppHandle,
    source: PackageSource,
    expected_id: String,
    expected_version: String,
) -> Result<Staged, String> {
    stage(&user_root(&app)?, source, &expected_id, &expected_version)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Committed {
    folder: String,
    replaced: bool,
}

/// Puts a staged package in place (the installed version, if any, is kept aside).
#[tauri::command(async)]
pub fn extensions_commit(app: AppHandle, token: String, id: String) -> Result<Committed, String> {
    token_ok(&token)?;
    let root = user_root(&app)?;
    let staged = root.join(STAGING).join(&token);
    if !staged.is_dir() {
        return Err(format!("InvalidRequest: nothing is staged as {token}."));
    }
    let previous = commit(&root, &staged, &id, &token)?;
    Ok(Committed {
        folder: root.join(&id).to_string_lossy().into_owned(),
        replaced: previous.is_some(),
    })
}

/// Keeps the new installation (deleting the old one) or rolls back to the old one.
#[tauri::command(async)]
pub fn extensions_finish(
    app: AppHandle,
    token: String,
    id: String,
    keep: bool,
) -> Result<(), String> {
    token_ok(&token)?;
    finish(&user_root(&app)?, &id, &token, keep)
}

/// Throws a staged package away.
#[tauri::command(async)]
pub fn extensions_discard(app: AppHandle, token: String) -> Result<(), String> {
    token_ok(&token)?;
    let _ = fs::remove_dir_all(user_root(&app)?.join(STAGING).join(&token));
    Ok(())
}

/// Deletes an installed extension's folder (Yavin's own extensions folder only).
#[tauri::command(async)]
pub fn extensions_uninstall(app: AppHandle, id: String) -> Result<String, String> {
    let root = user_root(&app)?;
    recover(&root);
    extension_package::uninstall(&root, &id).map(|folder| folder.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extension_package::tests::{package, temp, MANIFEST};
    use crate::extensions::MANIFEST_FILE;
    use std::io::BufRead;
    use std::net::TcpListener;

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
        assert_eq!(
            redirect(&r, "u", "/registry/moved.json").unwrap(),
            "https://example.com/registry/moved.json"
        );
        assert!(redirect(&r, "u", "https://example.com/elsewhere").is_ok());
        for (location, why) in [
            ("https://evil.example.net/x.yvx", "UnexpectedRedirect"),
            ("http://example.com/x", "InsecureTransport"),
            ("//evil.com/x", "UnexpectedRedirect"),
            ("relative.json", "UnexpectedRedirect"),
            ("file:///C:/Windows/x", "InsecureTransport"),
        ] {
            assert!(
                redirect(&r, "u", location).unwrap_err().starts_with(why),
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
        let mut installed = 0;
        for extension in index["extensions"].as_array().unwrap() {
            let id = extension["id"].as_str().unwrap();
            for version in extension["versions"].as_array().unwrap() {
                let staged = stage(
                    &root,
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
    fn serve(
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

    fn sha(bytes: &[u8]) -> String {
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
        let base = serve(move |path| {
            let octet = vec![("Content-Type", "application/octet-stream".to_string())];
            match path {
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
        let root = dir.join("root");
        fs::create_dir_all(&root).unwrap();
        let from = |path: &str, sha256: &str, size: u64| PackageSource::Registry {
            registry_url: base.clone(),
            path: path.into(),
            sha256: sha256.into(),
            size,
        };
        let n = good.len() as u64;
        let staged = stage(
            &root,
            from("good.yvx", &sha(&good), n),
            "acme.hello",
            "1.0.0",
        )
        .unwrap();
        assert_eq!(staged.manifest, MANIFEST);
        assert!(root
            .join(STAGING)
            .join(&staged.token)
            .join("extension.js")
            .is_file());
        // A same-host redirect is followed.
        assert!(stage(
            &root,
            from("moved.yvx", &sha(&good), n),
            "acme.hello",
            "1.0.0"
        )
        .is_ok());
        for (source, why) in [
            (from("good.yvx", &"0".repeat(64), n), "IntegrityFailed"),
            (from("good.yvx", &sha(&good), n - 1), "TooLarge"),
            (from("good.yvx", &sha(&good), n + 1), "IntegrityFailed"),
            (from("html.yvx", &sha(&good), n), "UnexpectedContent"),
            (from("away.yvx", &sha(&good), n), "UnexpectedRedirect"),
            (from("missing.yvx", &sha(&good), n), "NotFound"),
            (from("../good.yvx", &sha(&good), n), "OutsideRegistry"),
            (
                from("good.yvx", &sha(&good), LIMITS.package + 1),
                "UnsafePackage",
            ),
        ] {
            let error = stage(&root, source, "acme.hello", "1.0.0").unwrap_err();
            assert!(error.starts_with(why), "{why}: {error}");
        }
        let mismatch = stage(
            &root,
            from("good.yvx", &sha(&good), n),
            "acme.other",
            "1.0.0",
        )
        .unwrap_err();
        assert!(mismatch.starts_with("ManifestMismatch"), "{mismatch}");
        let version = stage(
            &root,
            from("good.yvx", &sha(&good), n),
            "acme.hello",
            "2.0.0",
        )
        .unwrap_err();
        assert!(version.starts_with("ManifestMismatch"), "{version}");
        // Nothing of a refused package is left in staging (only the two staged ones).
        let left: Vec<_> = fs::read_dir(root.join(STAGING)).unwrap().collect();
        assert_eq!(left.len(), 2);
        let missing = stage(
            &root,
            PackageSource::File {
                path: dir.join("nope.yvx").to_string_lossy().into(),
            },
            "acme.hello",
            "",
        )
        .unwrap_err();
        assert!(missing.starts_with("PackageMissing"), "{missing}");
        let _ = fs::remove_dir_all(&dir);
    }
}
