//! Extension packages (IDE-09): validating one, unpacking it, and putting it in place.
//!
//! A package is a zip archive: a Yavin package, with the extension's files at its root and
//! `yavin-extension.json` among them, or a VS Code package (VSIX: `extension.vsixmanifest`,
//! `extension/package.json`), whose declarative contributions `vsix.rs` adapts (EXT-04). Which
//! one it is comes from what it holds (`Format`); an archive with the marks of both is refused.
//! Installing is a security boundary -- the archive comes from the network -- so nothing in it
//! is trusted:
//!
//! - every entry name is checked before anything is written: no absolute paths, drive letters,
//!   UNC paths, `..`, backslashes, empty or dot-only components, alternate data streams,
//!   reserved device names, control characters, trailing dots or spaces; no two entries that
//!   are the same file on a case-insensitive filesystem;
//! - no links (an entry marked as a symlink is refused), no encrypted entries;
//! - bounded: the archive, the number of entries, each file, the total unpacked, and the
//!   compression ratio (a zip bomb is refused while it is being read, not after -- sizes in
//!   the headers are not believed);
//! - unpacked only into a fresh folder this code created, with `create_new`, so nothing that
//!   was already there -- a link included -- is ever written through.
//!
//! Putting a package in place, and every later change to what is installed, is the
//! inventory's (`extension_service.rs`, EXT-02): an unpacked package becomes a new, immutable
//! store copy; nothing installed is ever overwritten.
//!
//! No extension code is run here, or anywhere in installing.

use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
use std::path::Path;

use crate::extensions::MANIFEST_FILE;
use ide_workspace::extension_id::is_canonical;

/// Limits on a package: they keep a hostile archive from filling a disk or the memory, or
/// holding an install for long, and they are set from real packages (EXT-30, measured on the
/// Open VSX benchmark's packages; `OPEN_VSX_COMPATIBILITY_AUDIT.md`, Part F):
///
/// - **Entries** were 1000, which refused six legitimate packages (icon themes, a shader
///   grammar, the Lua extension: 1233 to 2732 entries) that are small in bytes (1.8 to 42.5
///   MiB unpacked). 5000 is under the installed-copy digest's `TREE_FILES` (10,000).
/// - **The archive** was 20 MiB; 32 MiB admits the largest measured within reach (23.6 MiB).
///   The downloaded archive is held in memory once to verify its signature
///   (`openvsx::verified_bytes`), so this bounds that too.
/// - **A file** was 16 MiB; 48 MiB admits the largest measured script (34.1 MiB, a language
///   server worker) and a platform package's binary (25 MiB). Unpacked is not run: code Yavin
///   loads is bounded again where it is read (`vsix::MAX_CODE`, `extensions::read_modules`).
/// - **Everything unpacked** was 64 MiB; 128 MiB is four times the archive, under the
///   installed-copy digest's `TREE_BYTES` (256 MiB).
/// - **The ratio** stays 100:1 (the highest measured over 1 MiB is 13.3:1), **a path** is at
///   most 400 bytes (the longest measured is 116), and **unpacking** at most 120 s.
pub struct Limits {
    /// The archive itself (compressed).
    pub package: u64,
    /// Entries (files and folders).
    pub entries: usize,
    /// One unpacked file.
    pub file: u64,
    /// Everything unpacked.
    pub total: u64,
    /// Unpacked/compressed size of one entry, beyond `RATIO_FLOOR` bytes.
    pub ratio: u64,
    /// An entry's whole name, in bytes.
    pub path: usize,
    /// Reading and unpacking the whole archive.
    pub time: std::time::Duration,
}

pub const LIMITS: Limits = Limits {
    package: 32 * 1024 * 1024,
    entries: 5000,
    file: 48 * 1024 * 1024,
    total: 128 * 1024 * 1024,
    ratio: 100,
    path: 400,
    time: std::time::Duration::from_secs(120),
};
/// Below this, an entry's ratio is not checked (tiny highly-compressible files are normal).
const RATIO_FLOOR: u64 = 1024 * 1024;

/// What a validated, unpacked package holds.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Unpacked {
    /// The manifest's text: `yavin-extension.json`, or a VS Code package's `extension/package.json`.
    pub manifest: String,
    pub format: Format,
    pub files: usize,
    pub bytes: u64,
    /// A VS Code package built for one platform (EXT-30): its `extension.vsixmanifest`'s
    /// `TargetPlatform` -- always this Yavin's (`HOST_PLATFORM`). `None`: built for every one.
    pub platform: Option<String>,
}

/// The platforms VS Code packages are built for: Open VSX's `targetPlatform` values (its OpenAPI
/// document, `/v3/api-docs`, checked 2026-10-22), as `extension.vsixmanifest` spells them.
pub const TARGET_PLATFORMS: [&str; 12] = [
    "win32-x64",
    "win32-ia32",
    "win32-arm64",
    "linux-x64",
    "linux-arm64",
    "linux-armhf",
    "alpine-x64",
    "alpine-arm64",
    "darwin-x64",
    "darwin-arm64",
    "web",
    "universal",
];

/// The platform this Yavin runs on, as VS Code packages name it. A package built for another
/// one (or for `web`, VS Code in a browser) is not this Yavin's to install.
pub const HOST_PLATFORM: &str = if cfg!(all(windows, target_arch = "aarch64")) {
    "win32-arm64"
} else if cfg!(all(windows, target_arch = "x86")) {
    "win32-ia32"
} else if cfg!(windows) {
    "win32-x64"
} else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
    "darwin-arm64"
} else if cfg!(target_os = "macos") {
    "darwin-x64"
} else if cfg!(target_arch = "aarch64") {
    "linux-arm64"
} else {
    "linux-x64"
};

/// The largest `extension.vsixmanifest` read (Open VSX's are 1 to 3 KiB).
const MAX_VSIXMANIFEST: u64 = 64 * 1024;

/// The `TargetPlatform` of an `extension.vsixmanifest`'s `<Identity>` element: `None` when it
/// names none, or there is no `<Identity>` (no claim: a package for every platform). Refused:
/// two `<Identity>` elements, a `TargetPlatform` named twice, malformed, or one VS Code does
/// not know.
pub fn target_platform(vsixmanifest: &str) -> Result<Option<String>, String> {
    let mut identities = vsixmanifest.match_indices("<Identity").filter(|(at, _)| {
        // `<Identity ` or `<Identity/`, not `<IdentityFoo`.
        vsixmanifest[at + 9..]
            .chars()
            .next()
            .is_some_and(|c| c.is_whitespace() || c == '/' || c == '>')
    });
    let Some((start, _)) = identities.next() else {
        return Ok(None);
    };
    if identities.next().is_some() {
        return Err(
            "InvalidPackage: its extension.vsixmanifest has two <Identity> elements".into(),
        );
    }
    let end = vsixmanifest[start..]
        .find('>')
        .ok_or_else(|| "InvalidPackage: its extension.vsixmanifest is malformed".to_string())?;
    let element = &vsixmanifest[start..start + end];
    let mut found = None;
    let mut rest = element;
    while let Some(at) = rest.find("TargetPlatform") {
        let before = rest[..at].chars().next_back();
        let after = &rest[at + "TargetPlatform".len()..];
        rest = after;
        if !before.is_some_and(char::is_whitespace) {
            continue;
        }
        let value = after.trim_start().strip_prefix('=').map(str::trim_start);
        let Some(value) = value else { continue };
        let quote = value.chars().next().filter(|c| *c == '"' || *c == '\'');
        let Some(quote) = quote else {
            return Err("InvalidPackage: its TargetPlatform is not a quoted value".into());
        };
        let body = &value[1..];
        let close = body
            .find(quote)
            .ok_or_else(|| "InvalidPackage: its TargetPlatform is not closed".to_string())?;
        if found.is_some() {
            return Err("InvalidPackage: its TargetPlatform is named twice".into());
        }
        found = Some(body[..close].to_string());
    }
    match found {
        None => Ok(None),
        Some(platform) if TARGET_PLATFORMS.contains(&platform.as_str()) => Ok(Some(platform)),
        Some(platform) => Err(format!(
            "InvalidPackage: \"{}\" is not a platform VS Code packages are built for",
            platform.chars().take(40).collect::<String>()
        )),
    }
}

/// Whether a package built for `platform` (`None`: every one) is this Yavin's to install.
pub fn platform_check(platform: Option<&str>) -> Result<(), String> {
    match platform {
        None | Some("universal") => Ok(()),
        Some(p) if p == HOST_PLATFORM => Ok(()),
        Some(p) => Err(format!(
            "UnsupportedPlatform: the package is built for {p}; this Yavin runs on {HOST_PLATFORM}"
        )),
    }
}

/// Which kind of package an archive is, from what it holds -- never from where it came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Format {
    /// `yavin-extension.json` at its root.
    Yavin,
    /// A VS Code extension (VSIX): `extension.vsixmanifest`, `extension/package.json` (EXT-04).
    Vsix,
}

/// A VS Code package's manifest, inside the archive.
pub const VSIX_MANIFEST: &str = "extension/package.json";
/// The largest `extension/package.json` read (its `contributes` can be long). EXT-30: was 1 MiB,
/// which refused GitLens (1066 KiB); its JSON is parsed once, at install.
const MAX_VSIX_MANIFEST: u64 = 2 * 1024 * 1024;

fn refuse(message: impl Into<String>) -> String {
    format!("UnsafePackage: {}", message.into())
}

/// Windows' reserved device names: a file called `con.js` cannot be created, or worse, is not
/// a file.
fn reserved(component: &str) -> bool {
    let stem = component
        .split('.')
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ((stem.starts_with("COM") || stem.starts_with("LPT"))
        && stem.len() == 4
        && stem.as_bytes()[3].is_ascii_digit())
}

/// An entry's name as path components, or why it is refused.
pub fn entry_components(name: &str) -> Result<Vec<String>, String> {
    if name.is_empty() {
        return Err(refuse("an entry has no name"));
    }
    if name.contains('\\') {
        return Err(refuse(format!("\"{name}\" uses a backslash")));
    }
    if name.starts_with('/') {
        return Err(refuse(format!("\"{name}\" is an absolute path")));
    }
    if name.len() >= 2 && name.as_bytes()[1] == b':' {
        return Err(refuse(format!("\"{name}\" names a drive")));
    }
    let trimmed = name.strip_suffix('/').unwrap_or(name);
    let mut components = Vec::new();
    for component in trimmed.split('/') {
        if component.is_empty() || component == "." {
            return Err(refuse(format!("\"{name}\" has an empty path component")));
        }
        if component == ".." {
            return Err(refuse(format!("\"{name}\" leaves the extension (\"..\")")));
        }
        if component.contains(':') {
            return Err(refuse(format!("\"{name}\" contains \":\"")));
        }
        if component
            .chars()
            .any(|c| c.is_control() || "<>\"|?*".contains(c))
        {
            return Err(refuse(format!(
                "\"{name}\" contains a character not allowed in a file name"
            )));
        }
        if component.ends_with('.') || component.ends_with(' ') {
            return Err(refuse(format!(
                "\"{name}\" has a component ending in a dot or space"
            )));
        }
        if reserved(component) {
            return Err(refuse(format!("\"{name}\" uses a reserved device name")));
        }
        if component.len() > 255 {
            return Err(refuse(format!("\"{name}\" has a component over 255 bytes")));
        }
        components.push(component.to_string());
    }
    if components.len() > 32 {
        return Err(refuse(format!("\"{name}\" is nested too deeply")));
    }
    Ok(components)
}

/// The lowercase hex SHA-256 of a file.
pub fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| format!("PackageUnreadable: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|e| format!("PackageUnreadable: {e}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hex(&hasher.finalize()))
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The most files and bytes a copy's files digest reads (an installed copy is within the
/// package limits; a folder grown past these is not the copy that was installed).
const TREE_FILES: usize = 10_000;
const TREE_BYTES: u64 = 256 * 1024 * 1024;

/// Every plain file under `folder`, by its `/`-separated path, sorted -- or why the folder is
/// not a plain tree of files (a link, a reparse point, too much).
fn tree_files(folder: &Path) -> Result<Vec<(String, std::path::PathBuf, fs::Metadata)>, String> {
    let mut found = Vec::new();
    let mut pending = vec![(String::new(), folder.to_path_buf())];
    let mut total = 0u64;
    while let Some((prefix, dir)) = pending.pop() {
        let entries = fs::read_dir(&dir).map_err(|e| format!("its files cannot be read ({e})"))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("its files cannot be read ({e})"))?;
            let meta = fs::symlink_metadata(entry.path())
                .map_err(|e| format!("its files cannot be read ({e})"))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            #[cfg(windows)]
            let reparse = {
                use std::os::windows::fs::MetadataExt;
                meta.file_attributes() & 0x400 != 0
            };
            #[cfg(not(windows))]
            let reparse = false;
            if meta.file_type().is_symlink() || reparse {
                return Err(format!("it holds a link ({path})"));
            }
            if meta.is_dir() {
                pending.push((path, entry.path()));
            } else if meta.is_file() {
                total += meta.len();
                found.push((path, entry.path(), meta));
                if found.len() > TREE_FILES || total > TREE_BYTES {
                    return Err("it holds more than an installed copy can".into());
                }
            } else {
                return Err(format!("it holds something that is not a file ({path})"));
            }
        }
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(found)
}

/// A digest of an installed copy's files (EXT-15): every file's path, size and SHA-256, in path
/// order. The package's signature and checksum authenticate the archive; this is what binds the
/// files unpacked from it -- recorded when the copy is put in place, checked whenever it is used.
pub fn tree_digest(folder: &Path) -> Result<String, String> {
    let mut hasher = Sha256::new();
    for (path, file, meta) in tree_files(folder)? {
        hasher.update(path.as_bytes());
        hasher.update([0]);
        hasher.update(meta.len().to_le_bytes());
        hasher.update(sha256_file(&file)?.as_bytes());
        hasher.update(b"\n");
    }
    Ok(hex(&hasher.finalize()))
}

/// What changes when any file under `folder` changes, cheaply: paths, sizes and modification
/// times (not contents) -- to know when `tree_digest` must be computed again.
pub fn tree_fingerprint(folder: &Path) -> Result<String, String> {
    let mut hasher = Sha256::new();
    for (path, _, meta) in tree_files(folder)? {
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_nanos());
        hasher.update(path.as_bytes());
        hasher.update([0]);
        hasher.update(meta.len().to_le_bytes());
        hasher.update(modified.to_le_bytes());
    }
    Ok(hex(&hasher.finalize()))
}

/// Validates `package` and unpacks it into `destination`, which must not exist yet. On any
/// refusal, whatever was unpacked is removed.
pub fn unpack(package: &Path, destination: &Path, limits: &Limits) -> Result<Unpacked, String> {
    let result = unpack_inner(package, destination, limits);
    if result.is_err() {
        let _ = fs::remove_dir_all(destination);
    }
    result
}

fn unpack_inner(package: &Path, destination: &Path, limits: &Limits) -> Result<Unpacked, String> {
    let size = fs::metadata(package)
        .map_err(|e| format!("PackageUnreadable: {e}"))?
        .len();
    if size > limits.package {
        return Err(refuse(format!(
            "the package is {size} bytes (the limit is {})",
            limits.package
        )));
    }
    let started = std::time::Instant::now();
    let in_time = || {
        if started.elapsed() > limits.time {
            Err(refuse(format!(
                "unpacking it took longer than {} s",
                limits.time.as_secs()
            )))
        } else {
            Ok(())
        }
    };
    let file = fs::File::open(package).map_err(|e| format!("PackageUnreadable: {e}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("MalformedPackage: not a valid zip archive ({e})"))?;
    if archive.len() > limits.entries {
        return Err(refuse(format!(
            "it has {} entries (the limit is {})",
            archive.len(),
            limits.entries
        )));
    }
    // Every name first: nothing is written for a package that is refused for its names.
    let mut seen = HashSet::new();
    let mut plan = Vec::with_capacity(archive.len());
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|e| format!("MalformedPackage: entry {index} cannot be read ({e})"))?;
        let name = std::str::from_utf8(entry.name_raw())
            .map_err(|_| refuse(format!("entry {index} has a name that is not UTF-8")))?
            .to_string();
        if name.len() > limits.path {
            return Err(refuse(format!(
                "entry {index}'s name is {} bytes (the limit is {})",
                name.len(),
                limits.path
            )));
        }
        let components = entry_components(&name)?;
        if entry.is_symlink()
            || entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(refuse(format!("\"{name}\" is a link")));
        }
        if entry.encrypted() {
            return Err(refuse(format!("\"{name}\" is encrypted")));
        }
        let key = components.join("/").to_lowercase();
        let is_dir = entry.is_dir();
        if !seen.insert((key, is_dir)) {
            return Err(refuse(format!(
                "\"{name}\" appears twice (names differing only in case are the same file)"
            )));
        }
        plan.push((index, components, is_dir));
        in_time()?;
    }
    // A file and a folder of the same name cannot both be.
    let files: HashSet<_> = plan
        .iter()
        .filter(|(_, _, dir)| !dir)
        .map(|(_, c, _)| c.join("/").to_lowercase())
        .collect();
    for (_, components, _) in &plan {
        for depth in 1..components.len() {
            let parent = components[..depth].join("/").to_lowercase();
            if files.contains(&parent) {
                return Err(refuse(format!("\"{parent}\" is both a file and a folder")));
            }
        }
    }
    // A VS Code package is never taken for a Yavin one, nor the other way round: an archive
    // with the marks of both is refused.
    let yavin = files.contains(&MANIFEST_FILE.to_lowercase());
    let vsix = files.contains("extension.vsixmanifest") || files.contains(VSIX_MANIFEST);
    let format = match (yavin, vsix) {
        (true, true) => {
            return Err(format!(
                "InvalidPackage: it is both a Yavin package ({MANIFEST_FILE}) and a VS Code package (extension/)"
            ))
        }
        (true, false) => Format::Yavin,
        (false, true) if files.contains(VSIX_MANIFEST) => Format::Vsix,
        (false, true) => {
            return Err(format!(
                "InvalidPackage: it is a VS Code package without {VSIX_MANIFEST}"
            ))
        }
        (false, false) => {
            return Err(format!(
                "InvalidPackage: it has no {MANIFEST_FILE} at its root"
            ))
        }
    };
    // A VS Code package built for one platform (EXT-30): this Yavin's, or refused -- before
    // anything is written.
    let platform = match format {
        Format::Vsix if files.contains("extension.vsixmanifest") => {
            let index = plan
                .iter()
                .find(|(_, c, dir)| !dir && c.join("/").to_lowercase() == "extension.vsixmanifest")
                .map(|(i, _, _)| *i)
                .ok_or_else(|| {
                    "InvalidPackage: its extension.vsixmanifest cannot be read".to_string()
                })?;
            let entry = archive
                .by_index(index)
                .map_err(|e| format!("MalformedPackage: {e}"))?;
            let mut text = String::new();
            entry
                .take(MAX_VSIXMANIFEST + 1)
                .read_to_string(&mut text)
                .map_err(|_| {
                    "InvalidPackage: its extension.vsixmanifest is not UTF-8 text".to_string()
                })?;
            if text.len() as u64 > MAX_VSIXMANIFEST {
                return Err(format!(
                    "InvalidPackage: its extension.vsixmanifest is larger than {} KiB",
                    MAX_VSIXMANIFEST / 1024
                ));
            }
            let platform = target_platform(&text)?;
            platform_check(platform.as_deref())?;
            platform.filter(|p| p != "universal")
        }
        _ => None,
    };

    fs::create_dir(destination).map_err(|e| format!("InstallFailed: {e}"))?;
    let mut total = 0u64;
    let mut count = 0usize;
    for (index, components, is_dir) in plan {
        let target = components
            .iter()
            .fold(destination.to_path_buf(), |path, part| path.join(part));
        if is_dir {
            fs::create_dir_all(&target).map_err(|e| format!("InstallFailed: {e}"))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("InstallFailed: {e}"))?;
        }
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("MalformedPackage: {e}"))?;
        let compressed = entry.compressed_size().max(1);
        let mut out = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|e| format!("InstallFailed: {}: {e}", components.join("/")))?;
        // Counted as it is read: the header's sizes are the archive's claim, not a fact.
        let mut written = 0u64;
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            let read = entry
                .read(&mut buffer)
                .map_err(|e| format!("MalformedPackage: {}: {e}", components.join("/")))?;
            if read == 0 {
                break;
            }
            written += read as u64;
            total += read as u64;
            if written > limits.file {
                return Err(refuse(format!(
                    "\"{}\" unpacks to more than {} bytes",
                    components.join("/"),
                    limits.file
                )));
            }
            if total > limits.total {
                return Err(refuse(format!(
                    "it unpacks to more than {} bytes",
                    limits.total
                )));
            }
            if written > RATIO_FLOOR && written / compressed > limits.ratio {
                return Err(refuse(format!(
                    "\"{}\" is compressed more than {}:1",
                    components.join("/"),
                    limits.ratio
                )));
            }
            out.write_all(&buffer[..read])
                .map_err(|e| format!("InstallFailed: {e}"))?;
            in_time()?;
        }
        count += 1;
    }
    let (name, max) = match format {
        Format::Yavin => (MANIFEST_FILE, 64 * 1024),
        Format::Vsix => (VSIX_MANIFEST, MAX_VSIX_MANIFEST),
    };
    let manifest_path = name
        .split('/')
        .fold(destination.to_path_buf(), |p, part| p.join(part));
    let manifest = fs::read_to_string(&manifest_path)
        .map_err(|_| format!("InvalidPackage: its {name} is not UTF-8 text"))?;
    if manifest.len() as u64 > max {
        return Err(format!(
            "InvalidPackage: its {name} is larger than {} KiB",
            max / 1024
        ));
    }
    Ok(Unpacked {
        manifest,
        format,
        files: count,
        bytes: total,
        platform,
    })
}

/// `publisher.name` and `version` of a manifest's text. The id must already be canonical
/// (Yavin's one id rule, `ide_workspace::extension_id`) and the version usable in a folder name.
pub fn identity(manifest: &str) -> Result<(String, String), String> {
    let value: serde_json::Value = serde_json::from_str(manifest)
        .map_err(|e| format!("InvalidPackage: its {MANIFEST_FILE} is not JSON ({e})"))?;
    let field = |name: &str| {
        value
            .get(name)
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| format!("InvalidPackage: its {MANIFEST_FILE} has no \"{name}\""))
    };
    let id = format!("{}.{}", field("publisher")?, field("name")?);
    if !is_canonical(&id) {
        return Err(format!(
            "InvalidPackage: \"{id}\" is not an extension id (publisher.name: lower-case letters, digits and \"-\", each part at most 50)"
        ));
    }
    let version = field("version")?;
    version_ok(&version)?;
    Ok((id, version))
}

/// A version Yavin can name a store folder after: 1 to 64 of `0-9 A-Z a-z . + -`, starting
/// with a digit (a semantic version always does; the renderer checks the rest).
pub fn version_ok(version: &str) -> Result<(), String> {
    let ok = (1..=64).contains(&version.len())
        && version.starts_with(|c: char| c.is_ascii_digit())
        && !version.ends_with('.')
        && version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"+.-".contains(&b));
    if ok {
        Ok(())
    } else {
        Err(format!(
            "InvalidPackage: \"{version}\" is not a version Yavin can install"
        ))
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::path::PathBuf;
    use zip::write::SimpleFileOptions;

    pub fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("yavin-pkg-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    pub const MANIFEST: &str = r#"{"publisher":"acme","name":"hello","version":"1.0.0","engines":{"yavin":"^2.0.0"},"main":"extension.js"}"#;

    /// A package of `(name, bytes)` entries (deflated).
    pub fn package(at: &Path, entries: &[(&str, &[u8])]) -> PathBuf {
        let path = at.join("package.yvx");
        let mut writer = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        for (name, bytes) in entries {
            if name.ends_with('/') {
                writer
                    .add_directory(*name, SimpleFileOptions::default())
                    .unwrap();
            } else {
                writer
                    .start_file(*name, SimpleFileOptions::default())
                    .unwrap();
                writer.write_all(bytes).unwrap();
            }
        }
        writer.finish().unwrap();
        path
    }

    fn refused(entries: &[(&str, &[u8])], limits: &Limits) -> String {
        // A folder of its own: tests run in parallel.
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = temp(&format!("refused-{n}"));
        let path = package(&dir, entries);
        let out = dir.join("out");
        let error = unpack(&path, &out, limits).unwrap_err();
        assert!(!out.exists(), "nothing is left of a refused package");
        let _ = fs::remove_dir_all(&dir);
        error
    }

    #[test]
    fn a_good_package_is_unpacked_with_its_folders() {
        let dir = temp("good");
        let path = package(
            &dir,
            &[
                (MANIFEST_FILE, MANIFEST.as_bytes()),
                ("extension.js", b"module.exports = {};"),
                ("media/", b""),
                ("media/icon.png", b"\x89PNG"),
            ],
        );
        let out = dir.join("out");
        let unpacked = unpack(&path, &out, &LIMITS).unwrap();
        assert_eq!(unpacked.files, 3);
        assert_eq!(unpacked.manifest, MANIFEST);
        assert!(out.join("media").join("icon.png").is_file());
        assert_eq!(
            identity(&unpacked.manifest).unwrap(),
            ("acme.hello".into(), "1.0.0".into())
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unsafe_entry_names_are_refused_before_anything_is_written() {
        let m = (MANIFEST_FILE, MANIFEST.as_bytes());
        for (name, why) in [
            ("../escape.txt", "leaves"),
            ("a/../../escape.txt", "leaves"),
            ("/etc/passwd", "absolute"),
            ("C:/Windows/evil.dll", "drive"),
            ("C:evil.txt", "drive"),
            ("\\\\server\\share\\x", "backslash"),
            ("dir\\..\\escape.txt", "backslash"),
            ("a//b.txt", "empty"),
            ("./a.txt", "empty"),
            ("file.txt:stream", ":"),
            ("CON.js", "reserved"),
            ("lpt1", "reserved"),
            ("trailing.", "dot or space"),
            ("bad\u{1}name", "not allowed"),
            ("what?.js", "not allowed"),
        ] {
            let error = refused(&[m, (name, b"x")], &LIMITS);
            assert!(error.starts_with("UnsafePackage"), "{name}: {error}");
            assert!(error.contains(why), "{name}: {error}");
        }
    }

    #[test]
    fn duplicates_and_case_collisions_are_refused() {
        let m = (MANIFEST_FILE, MANIFEST.as_bytes());
        let error = refused(&[m, ("a.js", b"1"), ("A.JS", b"2")], &LIMITS);
        assert!(error.contains("twice"), "{error}");
        let error = refused(&[m, ("lib", b"file"), ("lib/x.js", b"2")], &LIMITS);
        assert!(error.contains("both a file and a folder"), "{error}");
    }

    #[test]
    fn links_are_refused() {
        let dir = temp("link");
        let path = dir.join("package.yvx");
        let mut writer = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        writer
            .start_file(MANIFEST_FILE, SimpleFileOptions::default())
            .unwrap();
        writer.write_all(MANIFEST.as_bytes()).unwrap();
        writer
            .add_symlink("escape", "../../../Windows", SimpleFileOptions::default())
            .unwrap();
        writer.finish().unwrap();
        let error = unpack(&path, &dir.join("out"), &LIMITS).unwrap_err();
        assert!(error.contains("is a link"), "{error}");
        assert!(!dir.join("out").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn size_count_and_ratio_limits_are_enforced_while_reading() {
        let m = (MANIFEST_FILE, MANIFEST.as_bytes());
        let small = Limits {
            package: 1024 * 1024,
            entries: 4,
            file: 1000,
            total: 1500,
            ratio: 100,
            ..LIMITS
        };
        let many: Vec<(String, Vec<u8>)> =
            (0..5).map(|i| (format!("f{i}.txt"), vec![b'x'])).collect();
        let mut entries = vec![m];
        entries.extend(many.iter().map(|(n, b)| (n.as_str(), b.as_slice())));
        assert!(refused(&entries, &small).contains("entries"));
        assert!(refused(&[m, ("big.bin", &[7u8; 1001])], &small).contains("more than 1000 bytes"));
        assert!(
            refused(&[m, ("a.bin", &[1u8; 900]), ("b.bin", &[2u8; 900])], &small)
                .contains("unpacks to more than 1500")
        );
        // A bomb: 3 MiB of zeros deflate to a few KiB.
        let zeros = vec![0u8; 3 * 1024 * 1024];
        let error = refused(&[m, ("bomb.bin", &zeros)], &LIMITS);
        assert!(error.contains("compressed more than 100:1"), "{error}");
        // The archive's own size.
        let tiny = Limits {
            package: 10,
            ..LIMITS
        };
        assert!(refused(&[m], &tiny).contains("the package is"));
    }

    #[test]
    fn a_package_without_a_manifest_or_not_a_zip_is_refused() {
        assert!(refused(&[("extension.js", b"x")], &LIMITS).starts_with("InvalidPackage"));
        let dir = temp("notzip");
        let path = dir.join("p.yvx");
        fs::write(&path, b"<html>not found</html>").unwrap();
        assert!(unpack(&path, &dir.join("out"), &LIMITS)
            .unwrap_err()
            .starts_with("MalformedPackage"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_manifests_id_must_be_canonical_and_its_version_a_folder_name() {
        assert_eq!(
            identity(MANIFEST).unwrap(),
            ("acme.hello".into(), "1.0.0".into())
        );
        for bad in [
            MANIFEST.replace("acme", "Acme"),
            MANIFEST.replace("hello", "../x"),
            MANIFEST.replace("hello", &"h".repeat(51)),
            MANIFEST.replace("1.0.0", "1.0.0/../../x"),
            MANIFEST.replace("1.0.0", "v1"),
        ] {
            assert!(
                identity(&bad).unwrap_err().starts_with("InvalidPackage"),
                "{bad}"
            );
        }
        assert!(identity(&MANIFEST.replace("hello", &"h".repeat(50))).is_ok());
    }
    // --- EXT-30: limits from real packages, the platform a package is built for ----------------

    /// `n` small files under nested folders, as an icon theme's or a language server's package.
    fn many(n: usize) -> Vec<(String, Vec<u8>)> {
        (0..n)
            .map(|i| {
                (
                    format!("icons/{}/i{i}.svg", i % 40),
                    format!("<svg>{i}</svg>").into_bytes(),
                )
            })
            .collect()
    }

    #[test]
    fn a_package_over_the_former_1000_entries_is_unpacked_whole() {
        // pkief.material-icon-theme has 1278 entries, sumneko.lua 2732: legitimate, small.
        let dir = temp("many");
        let files = many(2800);
        let mut entries = vec![(MANIFEST_FILE, MANIFEST.as_bytes())];
        entries.extend(files.iter().map(|(n, b)| (n.as_str(), b.as_slice())));
        let path = package(&dir, &entries);
        let out = dir.join("out");
        let unpacked = unpack(&path, &out, &LIMITS).unwrap();
        assert_eq!(unpacked.files, 2801);
        assert!(out.join("icons/39/i2799.svg").is_file());
        // Its installed copy's digest covers every file (EXT-15): within its bounds.
        assert!(tree_digest(&out).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_entry_count_is_still_bounded() {
        let files = many(LIMITS.entries);
        let mut entries = vec![(MANIFEST_FILE, MANIFEST.as_bytes())];
        entries.extend(files.iter().map(|(n, b)| (n.as_str(), b.as_slice())));
        let error = refused(&entries, &LIMITS);
        assert!(
            error.contains(&format!(
                "{} entries (the limit is 5000)",
                LIMITS.entries + 1
            )),
            "{error}"
        );
    }

    #[test]
    fn long_names_and_deep_nesting_are_refused() {
        let m = (MANIFEST_FILE, MANIFEST.as_bytes());
        let long = format!("{}/x.js", "a".repeat(LIMITS.path));
        let error = refused(&[m, (long.as_str(), b"x")], &LIMITS);
        assert!(error.contains("the limit is 400"), "{error}");
        let deep = format!("{}x.js", "d/".repeat(33));
        let error = refused(&[m, (deep.as_str(), b"x")], &LIMITS);
        assert!(error.contains("nested too deeply"), "{error}");
        // The longest measured (116 bytes, nine deep) is fine.
        let ok = format!("{}/{}.js", ["n"; 8].join("/"), "f".repeat(100));
        let dir = temp("longok");
        let path = package(&dir, &[m, (ok.as_str(), b"x")]);
        assert!(unpack(&path, &dir.join("out"), &LIMITS).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unpacking_is_bounded_in_time_and_leaves_nothing_when_it_stops() {
        let files = many(50);
        let mut entries = vec![(MANIFEST_FILE, MANIFEST.as_bytes())];
        entries.extend(files.iter().map(|(n, b)| (n.as_str(), b.as_slice())));
        let none = Limits {
            time: std::time::Duration::ZERO,
            ..LIMITS
        };
        let error = refused(&entries, &none);
        assert!(error.contains("took longer than 0 s"), "{error}");
    }

    #[test]
    fn a_refusal_after_files_were_written_removes_them_all() {
        // 200 files are written, then the last entry is a bomb: nothing of the package is left
        // to be taken for an installed copy (`refused` checks the folder is gone).
        let files = many(200);
        let zeros = vec![0u8; 3 * 1024 * 1024];
        let mut entries = vec![(MANIFEST_FILE, MANIFEST.as_bytes())];
        entries.extend(files.iter().map(|(n, b)| (n.as_str(), b.as_slice())));
        entries.push(("zz/bomb.bin", &zeros));
        let error = refused(&entries, &LIMITS);
        assert!(error.contains("compressed more than 100:1"), "{error}");
    }

    const VSIX_JSON: &str =
        r#"{"publisher":"acme","name":"hello","version":"1.0.0","engines":{"vscode":"^1.80.0"}}"#;

    pub fn vsixmanifest(platform: Option<&str>) -> String {
        let attribute = platform.map_or(String::new(), |p| format!(r#" TargetPlatform="{p}""#));
        format!(
            r#"<?xml version="1.0" encoding="utf-8"?><PackageManifest Version="2.0.0"><Metadata><Identity Language="en-US" Id="hello" Version="1.0.0" Publisher="acme"{attribute}/></Metadata></PackageManifest>"#
        )
    }

    /// A platform other than this Yavin's.
    pub fn elsewhere() -> &'static str {
        if HOST_PLATFORM == "darwin-arm64" {
            "linux-x64"
        } else {
            "darwin-arm64"
        }
    }

    #[test]
    fn a_vsixmanifests_target_platform_is_read_strictly() {
        assert_eq!(target_platform(&vsixmanifest(None)).unwrap(), None);
        // No <Identity> at all: no claim (the EXT-04 fixtures' bare manifest).
        assert_eq!(target_platform("<PackageManifest/>").unwrap(), None);
        for p in TARGET_PLATFORMS {
            assert_eq!(
                target_platform(&vsixmanifest(Some(p))).unwrap().as_deref(),
                Some(p)
            );
        }
        // Single quotes and spacing are XML.
        assert_eq!(
            target_platform("<Identity Id='x' TargetPlatform = 'win32-x64' />")
                .unwrap()
                .as_deref(),
            Some("win32-x64")
        );
        // Another attribute ending in the name is not it.
        assert_eq!(
            target_platform(r#"<Identity XTargetPlatform="linux-x64"/>"#).unwrap(),
            None
        );
        for (text, why) in [
            (vsixmanifest(Some("win32-x65")), "not a platform"),
            (vsixmanifest(Some("")), "not a platform"),
            (
                format!("{}{}", vsixmanifest(None), vsixmanifest(None)),
                "two <Identity>",
            ),
            (
                r#"<Identity TargetPlatform="win32-x64" TargetPlatform="linux-x64"/>"#.into(),
                "named twice",
            ),
            (
                r#"<Identity TargetPlatform=win32-x64/>"#.into(),
                "not a quoted",
            ),
            (
                r#"<Identity TargetPlatform="win32-x64/>"#.into(),
                "not closed",
            ),
            (r#"<Identity Id="x""#.into(), "malformed"),
        ] {
            let error = target_platform(&text).unwrap_err();
            assert!(
                error.starts_with("InvalidPackage") && error.contains(why),
                "{text}: {error}"
            );
        }
    }

    #[test]
    fn only_a_vs_code_package_for_this_platform_or_every_one_is_unpacked() {
        let unpack_with = |platform: Option<&str>| {
            static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let dir = temp(&format!("platform-{n}"));
            let manifest = vsixmanifest(platform);
            let path = package(
                &dir,
                &[
                    ("extension.vsixmanifest", manifest.as_bytes()),
                    (VSIX_MANIFEST, VSIX_JSON.as_bytes()),
                    ("extension/bin/tool.exe", b"MZ"),
                ],
            );
            let out = dir.join("out");
            let result = unpack(&path, &out, &LIMITS);
            let left = out.exists();
            let _ = fs::remove_dir_all(&dir);
            (result, left)
        };
        let (ok, _) = unpack_with(None);
        assert_eq!(ok.unwrap().platform, None, "built for every platform");
        let (ok, _) = unpack_with(Some("universal"));
        assert_eq!(ok.unwrap().platform, None);
        let (ok, _) = unpack_with(Some(HOST_PLATFORM));
        assert_eq!(ok.unwrap().platform.as_deref(), Some(HOST_PLATFORM));
        for other in [elsewhere(), "web"] {
            let (error, left) = unpack_with(Some(other));
            let error = error.unwrap_err();
            assert!(
                error.starts_with("UnsupportedPlatform") && error.contains(other),
                "{other}: {error}"
            );
            assert!(!left, "{other}: refused before anything was written");
        }
        let (error, left) = unpack_with(Some("amiga-68k"));
        assert!(error.unwrap_err().contains("not a platform"));
        assert!(!left);
    }

    /// `n` hex digits that deflate about 2:1.
    fn noise(n: usize) -> String {
        let mut out = String::with_capacity(n + 64);
        let mut block = Sha256::digest(b"noise");
        while out.len() < n {
            out.push_str(&hex(&block));
            block = Sha256::digest(block);
        }
        out.truncate(n);
        out
    }

    #[test]
    fn a_vs_code_manifest_up_to_2_mib_is_read() {
        // GitLens's package.json is 1066 KiB.
        let padded = |n: usize| {
            VSIX_JSON.replace(
                r#""engines""#,
                // Hex of a running hash: text that does not compress past the 100:1 ratio.
                &format!(r#""pad":"{}","engines""#, noise(n)),
            )
        };
        let read = |json: &str, name: &str| {
            let dir = temp(name);
            let manifest = vsixmanifest(None);
            let path = package(
                &dir,
                &[
                    ("extension.vsixmanifest", manifest.as_bytes()),
                    (VSIX_MANIFEST, json.as_bytes()),
                ],
            );
            let out = dir.join("out");
            let result = unpack(&path, &out, &LIMITS);
            let left = out.exists();
            let _ = fs::remove_dir_all(&dir);
            (result, left)
        };
        let json = padded(1100 * 1024);
        assert_eq!(read(&json, "bigjson").0.unwrap().manifest, json);
        let (error, left) = read(&padded(2100 * 1024), "hugejson");
        assert!(error.unwrap_err().contains("larger than 2048 KiB"));
        assert!(!left);
    }
}
