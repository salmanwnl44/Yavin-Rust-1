//! Open VSX (EXT-03): browsing an Open VSX registry, and fetching one version's package for the
//! installer -- natively, under the marketplace's network policy (`marketplace.rs`).
//!
//! The renderer never names a URL. It asks for a search, an extension, its versions or one of
//! a version's files by kind; the URL is built here from the registry's base (any Open VSX
//! server: `https://open-vsx.org/` or a private mirror), every path segment and query value
//! percent-encoded. URLs that Open VSX's own answers name (a package, its checksum, a readme)
//! are used only when they are inside the registry -- or on a file origin it is known to redirect
//! to: `https://openvsx.eclipsecontent.org` for `https://open-vsx.org`, verified 2026-10-18 (`302` from
//! `/api/{ns}/{name}/{version}/file/…`). A mirror's files must stay on the mirror.
//!
//! Endpoints used, from Open VSX's OpenAPI document (`/v3/api-docs`, checked 2026-10-18), all
//! GET without authentication: `/api/-/search` (`query`, `category`, `offset`, `size` <= 1000),
//! `/api/{namespace}/{extension}[/{version}]`, `/api/{namespace}/{extension}/versions`
//! (`offset`, `size` <= 100). Answers are returned to the renderer as text, which validates them
//! before anything is shown.
//!
//! **A package's checksum** is `files.sha256`: 64 hex digits computed by the registry, served
//! from the same place as the package. It proves the package arrived as the registry holds it,
//! not who made it.
//!
//! **A package's signature** (EXT-09, `package_trust.rs`) is `files.signature`: a `.sigzip`
//! holding Open VSX's Ed25519 signature over the whole `.vsix`. It must verify under a key Yavin
//! pins for this registry -- `files.publicKey` only names which -- or the package is refused
//! before anything is staged. It proves the package is the one the registry published; Open VSX
//! has no publisher keys, so it does not prove who made it either.
//!
//! **A version built per platform** (EXT-30): Open VSX answers `/api/{ns}/{name}/{version}`
//! with one of its variants, not necessarily this machine's (measured 2026-10-22: `sumneko.lua`
//! answered with darwin-arm64, `charliermarsh.ruff` with alpine-arm64). Its `downloads` names
//! every variant published. Yavin takes this platform's (`extension_package::HOST_PLATFORM`)
//! from `/api/{ns}/{name}/{targetPlatform}/{version}`, else the universal one, else refuses
//! (`choose_variant`). Choosing a variant decides nothing about trust: the variant's own
//! checksum and signature are checked exactly as any package's, and the package's own
//! `TargetPlatform` must agree (`extension_package::unpack`).

use crate::extension_package;
use crate::marketplace::{fetch_url, registry as registry_at, url_on, Kind, Registry};
use crate::package_trust::{self, SignatureRecord, SignatureStatus};
use ide_workspace::extension_id::canonical_id;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::Duration;

/// Open VSX's own origin, and its file origin (its CDN): the only one besides open-vsx.org it
/// redirects to. Whole origins: another port or scheme of either is not them (EXT-06).
const OPEN_VSX: (&str, &str) = ("https://open-vsx.org", "https://openvsx.eclipsecontent.org");
/// The largest metadata answer read (an extension lists every version it has).
const MAX_JSON: u64 = 4 * 1024 * 1024;
const MAX_DOCUMENT: u64 = 512 * 1024;
const MAX_ICON: u64 = 256 * 1024;
/// A metadata request's limit (a package download keeps the marketplace's 120 s).
const METADATA_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_PAGE: u32 = 50;
const MAX_OFFSET: u32 = 100_000;

/// An Open VSX registry from its base URL (`https://host/path/`).
pub fn registry(base: &str) -> Result<Registry, String> {
    let mut registry = registry_at(base)?;
    if registry.origin == OPEN_VSX.0 {
        registry.file_origins.push(OPEN_VSX.1.to_string());
    }
    Ok(registry)
}

/// `text`, percent-encoded as a URL path segment or query value (RFC 3986 unreserved kept).
pub fn encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// A namespace, extension name or version as Open VSX names them, as one path segment
/// (EXT-08): never empty, `.` or `..`, at most 128 bytes; no `/` or `\\` (a segment that would
/// be two), no `%` (already-encoded or double-encoded text is ambiguous), no `?` or `#` (a
/// query or fragment), no whitespace or control characters. Refused, never encoded into
/// something else; what is left (Unicode included) is encoded by `api_url`.
pub(crate) fn segment(what: &str, text: &str) -> Result<String, String> {
    let ambiguous =
        |c: char| c.is_control() || c.is_whitespace() || matches!(c, '/' | '\\' | '%' | '?' | '#');
    if text.is_empty()
        || text == "."
        || text == ".."
        || text.len() > 128
        || text.chars().any(ambiguous)
    {
        return Err(format!(
            "InvalidRequest: \"{text}\" is not an Open VSX {what}."
        ));
    }
    Ok(text.to_string())
}

/// The URL of `api/<segments>?<query>` in `registry`, built with a URL parser: each segment
/// (checked by `segment`) percent-encoded as one path segment, each query value encoded.
pub fn api_url(registry: &Registry, segments: &[String], query: &[(&str, String)]) -> String {
    let mut url = url::Url::parse(&registry.base).expect("a registry's base is a checked URL");
    url.path_segments_mut()
        .expect("an https URL has a path")
        .pop_if_empty()
        .push("api")
        .extend(segments);
    let pairs: Vec<_> = query
        .iter()
        .map(|(key, value)| format!("{key}={}", encode(value)))
        .collect();
    if !pairs.is_empty() {
        url.set_query(Some(&pairs.join("&")));
    }
    url.to_string()
}

fn metadata(registry: &Registry) -> Registry {
    let mut shorter = registry.clone();
    shorter.timeout = registry.timeout.min(METADATA_TIMEOUT);
    shorter
}

fn get(
    registry: &Registry,
    url: &str,
    label: &str,
    kind: Kind,
    max: u64,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    fetch_url(registry, url, label, kind, max, &mut |chunk| {
        bytes.extend_from_slice(chunk);
        Ok(())
    })?;
    Ok(bytes)
}

fn get_text(registry: &Registry, url: &str, label: &str, max: u64) -> Result<String, String> {
    String::from_utf8(get(&metadata(registry), url, label, Kind::Text, max)?)
        .map_err(|_| format!("UnexpectedContent: {label} is not UTF-8 text."))
}

/// One version's metadata (`/api/{ns}/{name}/{version}`), parsed.
fn version_metadata(
    registry: &Registry,
    namespace: &str,
    name: &str,
    platform: Option<&str>,
    version: &str,
) -> Result<Value, String> {
    let mut segments = vec![
        segment("namespace", namespace)?,
        segment("extension name", name)?,
    ];
    if let Some(platform) = platform {
        segments.push(segment("platform", platform)?);
    }
    segments.push(segment("version", version)?);
    let url = api_url(registry, &segments, &[]);
    let label = match platform {
        Some(platform) => format!("{namespace}.{name} {version} ({platform})"),
        None => format!("{namespace}.{name} {version}"),
    };
    serde_json::from_str(&get_text(registry, &url, &label, MAX_JSON)?)
        .map_err(|_| format!("UnexpectedContent: {label}'s metadata is not JSON."))
}

/// A file a version's metadata names (`files.<key>`), checked to be the registry's.
fn file_url(meta: &Value, key: &str, registry: &Registry) -> Result<String, String> {
    let url = meta["files"][key]
        .as_str()
        .ok_or_else(|| format!("NotFound: the registry lists no {key} for this version."))?;
    url_on(registry, url)
}

#[derive(Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Request {
    #[serde(rename_all = "camelCase")]
    Search {
        query: String,
        category: Option<String>,
        offset: u32,
        size: u32,
    },
    #[serde(rename_all = "camelCase")]
    Extension {
        namespace: String,
        name: String,
        version: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Versions {
        namespace: String,
        name: String,
        offset: u32,
        size: u32,
    },
    /// A version's readme or changelog (Markdown).
    #[serde(rename_all = "camelCase")]
    Document {
        namespace: String,
        name: String,
        version: String,
        document: Document,
    },
}

#[derive(Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum Document {
    Readme,
    Changelog,
}

fn bounded(offset: u32, size: u32, max: u32) -> Result<(), String> {
    if size == 0 || size > max || offset > MAX_OFFSET {
        return Err(format!(
            "InvalidRequest: a page is 1 to {max} entries from at most {MAX_OFFSET}."
        ));
    }
    Ok(())
}

/// The answer to `request` from `registry`, as text (JSON or Markdown).
pub fn answer(registry: &Registry, request: Request) -> Result<String, String> {
    match request {
        Request::Search {
            query,
            category,
            offset,
            size,
        } => {
            bounded(offset, size, MAX_PAGE)?;
            if query.len() > 200 || query.chars().any(char::is_control) {
                return Err("InvalidRequest: the search is too long.".into());
            }
            let mut params = vec![
                ("query", query),
                ("offset", offset.to_string()),
                ("size", size.to_string()),
            ];
            if let Some(category) = category.filter(|c| !c.is_empty()) {
                params.push(("category", category));
            }
            let url = api_url(registry, &["-".into(), "search".into()], &params);
            get_text(registry, &url, "The search", MAX_JSON)
        }
        Request::Extension {
            namespace,
            name,
            version,
        } => {
            let mut segments = vec![
                segment("namespace", &namespace)?,
                segment("extension name", &name)?,
            ];
            if let Some(version) = version {
                segments.push(segment("version", &version)?);
            }
            let url = api_url(registry, &segments, &[]);
            get_text(registry, &url, &format!("{namespace}.{name}"), MAX_JSON)
        }
        Request::Versions {
            namespace,
            name,
            offset,
            size,
        } => {
            bounded(offset, size, 100)?;
            let url = api_url(
                registry,
                &[
                    segment("namespace", &namespace)?,
                    segment("extension name", &name)?,
                    "versions".into(),
                ],
                &[("offset", offset.to_string()), ("size", size.to_string())],
            );
            get_text(
                registry,
                &url,
                &format!("{namespace}.{name}'s versions"),
                MAX_JSON,
            )
        }
        Request::Document {
            namespace,
            name,
            version,
            document,
        } => {
            let meta = version_metadata(registry, &namespace, &name, None, &version)?;
            let key = match document {
                Document::Readme => "readme",
                Document::Changelog => "changelog",
            };
            let url = file_url(&meta, key, registry)?;
            get_text(
                registry,
                &url,
                &format!("{namespace}.{name}'s {key}"),
                MAX_DOCUMENT,
            )
        }
    }
}

/// A version's icon as PNG bytes, if it has one that is a PNG.
pub fn icon(
    registry: &Registry,
    namespace: &str,
    name: &str,
    version: &str,
) -> Result<Vec<u8>, String> {
    let meta = version_metadata(registry, namespace, name, None, version)?;
    let url = file_url(&meta, "icon", registry)?;
    let bytes = get(&metadata(registry), &url, "The icon", Kind::Icon, MAX_ICON)?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("UnexpectedContent: the icon is not a PNG image.".into());
    }
    Ok(bytes)
}

/// Downloads `namespace.name` at `version` into `archive`, for the installer: the version's
/// metadata must be that extension (`expected_id`, case-insensitively) and version; its
/// package and checksum come from the files it names, checked to be the registry's; the
/// package is bounded while it arrives and must match the checksum. Returns the SHA-256, the
/// size, the signature, and the platform the package was chosen for (EXT-30; `None`: universal).
pub fn download(
    registry: &Registry,
    namespace: &str,
    name: &str,
    expected_id: &str,
    expected_version: &str,
    archive: &Path,
) -> Result<(String, u64, SignatureRecord, Option<String>), String> {
    let first = version_metadata(registry, namespace, name, None, expected_version)?;
    let label = format!("{expected_id} {expected_version}");
    let (meta, platform) = match choose_variant(&first, extension_package::HOST_PLATFORM, &label)? {
        None => {
            let platform = platform_of(&first, &label)?;
            (first, platform)
        }
        Some(wanted) => {
            let meta = version_metadata(registry, namespace, name, Some(wanted), expected_version)?;
            let platform = platform_of(&meta, &label)?;
            if platform != wanted {
                return Err(format!(
                    "ManifestMismatch: the registry was asked for {label}'s {wanted} package and described its {platform} one."
                ));
            }
            (meta, platform)
        }
    };
    let id = match (meta["namespace"].as_str(), meta["name"].as_str()) {
        (Some(ns), Some(n)) => canonical_id(&format!("{ns}.{n}")),
        _ => None,
    };
    if id.as_deref() != Some(expected_id) || meta["version"].as_str() != Some(expected_version) {
        return Err(format!(
            "ManifestMismatch: the registry describes {} {}, not {expected_id} {expected_version}.",
            id.unwrap_or_else(|| "an unknown extension".into()),
            meta["version"].as_str().unwrap_or("an unknown version")
        ));
    }
    let checksum_url = file_url(&meta, "sha256", registry)?;
    let package_url = file_url(&meta, "download", registry)?;
    let published = String::from_utf8(get(
        &metadata(registry),
        &checksum_url,
        "The package's checksum",
        Kind::Checksum,
        256,
    )?)
    .map_err(|_| "IntegrityFailed: the registry's checksum is not text.".to_string())?;
    let published = published
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if published.len() != 64 || !published.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("IntegrityFailed: the registry's checksum is not a SHA-256.".into());
    }
    let limit = extension_package::LIMITS.package;
    let mut file = fs::File::create(archive).map_err(|e| format!("InstallFailed: {e}"))?;
    let mut hasher = Sha256::new();
    let size = fetch_url(
        registry,
        &package_url,
        &label,
        Kind::Package,
        limit,
        &mut |chunk| {
            hasher.update(chunk);
            file.write_all(chunk)
                .map_err(|e| format!("InstallFailed: {e}"))
        },
    )?;
    drop(file);
    let actual = extension_package::hex(&hasher.finalize());
    if actual != published {
        return Err(format!(
            "IntegrityFailed: the package's SHA-256 is {actual}, but the registry says {published}."
        ));
    }
    // Its signature (EXT-09): over these very bytes, under a key Yavin pins for this registry --
    // or it is not installed. The metadata's key id only chooses among the pinned keys.
    let publisher = expected_id.split('.').next().unwrap_or_default();
    // The bytes checked are the bytes hashed, and the bytes unpacked (EXT-15): read once, their
    // SHA-256 the one just verified -- a file that changed in between is refused.
    let package = verified_bytes(archive, &actual)?;
    let status = signature_status(registry, &meta, publisher, &package, &label);
    if !status.trusted() {
        return Err(package_trust::refusal(status, &label, &registry.origin));
    }
    let key_id = key_id(&meta, registry);
    Ok((
        actual.clone(),
        size,
        SignatureRecord {
            status,
            registry: registry.origin.clone(),
            key_id,
            namespace: publisher.to_string(),
            sha256: actual,
            store_revision: package_trust::store().map(|s| s.revision).unwrap_or(0),
        },
        (platform != "universal").then(|| platform.to_string()),
    ))
}

/// A version's `targetPlatform`: one VS Code knows; absent (a registry without platforms) is
/// `universal`.
fn platform_of(meta: &Value, label: &str) -> Result<&'static str, String> {
    match meta.get("targetPlatform") {
        None | Some(Value::Null) => Ok("universal"),
        Some(Value::String(p)) => extension_package::TARGET_PLATFORMS
            .iter()
            .copied()
            .find(|known| known == p)
            .ok_or_else(|| {
                format!(
                    "UnexpectedContent: {label}'s targetPlatform \"{}\" is not a platform VS Code packages are built for.",
                    p.chars().take(40).collect::<String>()
                )
            }),
        Some(_) => Err(format!(
            "UnexpectedContent: {label}'s targetPlatform is not text."
        )),
    }
}

/// Which variant of a version to install on `host`, from its metadata (`meta`, the one Open
/// VSX answered with): `None` for that one, or the platform whose own metadata to fetch.
/// This platform's first, then the universal one; anything else is refused, naming what is
/// published. `downloads` must be a map; platforms in it Yavin does not know are not offered.
pub fn choose_variant(
    meta: &Value,
    host: &str,
    label: &str,
) -> Result<Option<&'static str>, String> {
    let answered = platform_of(meta, label)?;
    let published: Vec<&'static str> = match meta.get("downloads") {
        None | Some(Value::Null) => vec![answered],
        Some(Value::Object(map)) => extension_package::TARGET_PLATFORMS
            .iter()
            .copied()
            .filter(|p| map.get(*p).is_some_and(Value::is_string))
            .collect(),
        Some(_) => {
            return Err(format!(
                "UnexpectedContent: {label}'s downloads is not a map of platforms."
            ))
        }
    };
    if answered == host {
        return Ok(None);
    }
    if let Some(p) = published.iter().find(|p| **p == host) {
        return Ok(Some(p));
    }
    if answered == "universal" {
        return Ok(None);
    }
    if published.contains(&"universal") {
        return Ok(Some("universal"));
    }
    let list = if published.is_empty() {
        answered.to_string()
    } else {
        published.join(", ")
    };
    Err(format!(
        "UnsupportedPlatform: {label} is published for {list}, not for {host} (this Yavin's platform)."
    ))
}

/// The key id `files.publicKey` names: `.../api/-/public-key/<id>` on this registry.
fn key_id(meta: &Value, registry: &Registry) -> Option<String> {
    let url = file_url(meta, "publicKey", registry).ok()?;
    let id = url.rsplit_once("/api/-/public-key/")?.1;
    let ok =
        (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    ok.then(|| id.to_string())
}

/// The contents of `archive`, if they are the bytes whose SHA-256 is `sha256`.
fn verified_bytes(archive: &Path, sha256: &str) -> Result<Vec<u8>, String> {
    let package = fs::read(archive).map_err(|e| format!("InstallFailed: {e}"))?;
    let hash = extension_package::hex(&Sha256::digest(&package));
    if !hash.eq_ignore_ascii_case(sha256) {
        return Err(format!(
            "IntegrityFailed: the downloaded package changed before it was checked (its SHA-256 is now {hash}, not {sha256})."
        ));
    }
    Ok(package)
}

/// What the signature of the downloaded `package` (its bytes) is found to be.
fn signature_status(
    registry: &Registry,
    meta: &Value,
    publisher: &str,
    package: &[u8],
    label: &str,
) -> SignatureStatus {
    if meta["files"]["signature"].is_null() {
        return SignatureStatus::Missing;
    }
    let Ok(url) = file_url(meta, "signature", registry) else {
        return SignatureStatus::Malformed;
    };
    let mut sigzip = Vec::new();
    let fetched = fetch_url(
        registry,
        &url,
        &format!("{label}'s signature"),
        Kind::Package,
        package_trust::MAX_SIGZIP,
        &mut |chunk| {
            sigzip.extend_from_slice(chunk);
            Ok(())
        },
    );
    if fetched.is_err() {
        return SignatureStatus::Unavailable;
    }
    package_trust::verify(
        &package_trust::store(),
        &registry.origin,
        publisher,
        key_id(meta, registry).as_deref(),
        package,
        Some(&sigzip),
        package_trust::today(),
    )
}

// --- Commands --------------------------------------------------------------------------------

/// An Open VSX answer (JSON, or a document's Markdown) for the renderer to validate.
#[tauri::command(async)]
pub fn marketplace_openvsx(registry_url: String, request: Request) -> Result<String, String> {
    answer(&registry(&registry_url)?, request)
}

/// A version's PNG icon as a `data:` URL (the window loads no images from the network).
#[tauri::command(async)]
pub fn marketplace_openvsx_icon(
    registry_url: String,
    namespace: String,
    name: String,
    version: String,
) -> Result<String, String> {
    let bytes = icon(&registry(&registry_url)?, &namespace, &name, &version)?;
    Ok(format!(
        "data:image/png;base64,{}",
        crate::marketplace::base64(&bytes)
    ))
}

#[cfg(test)]
#[path = "openvsx_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "openvsx_benchmark_tests.rs"]
mod benchmark;
