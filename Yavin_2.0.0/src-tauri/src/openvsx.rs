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
    version: &str,
) -> Result<Value, String> {
    let url = api_url(
        registry,
        &[
            segment("namespace", namespace)?,
            segment("extension name", name)?,
            segment("version", version)?,
        ],
        &[],
    );
    let label = format!("{namespace}.{name} {version}");
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
            let meta = version_metadata(registry, &namespace, &name, &version)?;
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
    let meta = version_metadata(registry, namespace, name, version)?;
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
/// package is bounded while it arrives and must match the checksum. Returns the SHA-256 and
/// the size.
pub fn download(
    registry: &Registry,
    namespace: &str,
    name: &str,
    expected_id: &str,
    expected_version: &str,
    archive: &Path,
) -> Result<(String, u64, SignatureRecord), String> {
    let meta = version_metadata(registry, namespace, name, expected_version)?;
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
    let published = get_text(registry, &checksum_url, "The package's checksum", 256)?;
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
    let label = format!("{expected_id} {expected_version}");
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
    let status = signature_status(registry, &meta, publisher, archive, &label);
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

/// What the signature of the downloaded `archive` is found to be.
fn signature_status(
    registry: &Registry,
    meta: &Value,
    publisher: &str,
    archive: &Path,
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
    let Ok(package) = fs::read(archive) else {
        return SignatureStatus::Unavailable;
    };
    package_trust::verify(
        &package_trust::store(),
        &registry.origin,
        publisher,
        key_id(meta, registry).as_deref(),
        &package,
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
