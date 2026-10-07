//! Extension packages (IDE-09): validating one, unpacking it, and putting it in place.
//!
//! A package is a zip archive with the extension's files at its root, `yavin-extension.json`
//! among them. Installing is a security boundary -- the archive comes from the network -- so
//! nothing in it is trusted:
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
//! Putting a package in place never overwrites a working installation before the new one is
//! complete: the current folder is moved aside, the new one moved in, and the old one either
//! deleted once Yavin has registered the new one or moved back (`finish`). A crash in between
//! is repaired on the next discovery (`recover`).
//!
//! No extension code is run here, or anywhere in installing.

use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use crate::extensions::{discover, MANIFEST_FILE};

/// Limits on a package. Yavin's own constraints set them: an entry point is at most 2 MiB
/// (`read_main`) and a manifest 64 KiB, so a package is code plus assets (icon, readme,
/// changelog, grammars). The Hello World package is 3 KiB; these leave three to four orders of
/// magnitude of room while keeping a hostile archive from filling a disk or the memory.
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
}

pub const LIMITS: Limits = Limits {
    package: 20 * 1024 * 1024,
    entries: 1000,
    file: 16 * 1024 * 1024,
    total: 64 * 1024 * 1024,
    ratio: 100,
};
/// Below this, an entry's ratio is not checked (tiny highly-compressible files are normal).
const RATIO_FLOOR: u64 = 1024 * 1024;

/// Folders in the extensions root that are Yavin's, not extensions (discovery skips them).
pub const STAGING: &str = ".staging";
pub const PREVIOUS: &str = ".previous";

/// What a validated, unpacked package holds.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Unpacked {
    pub manifest: String,
    pub files: usize,
    pub bytes: u64,
}

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
    if !files.contains(&MANIFEST_FILE.to_lowercase()) {
        return Err(format!(
            "InvalidPackage: it has no {MANIFEST_FILE} at its root"
        ));
    }

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
        }
        count += 1;
    }
    let manifest_path = destination.join(MANIFEST_FILE);
    let manifest = fs::read_to_string(&manifest_path)
        .map_err(|_| format!("InvalidPackage: its {MANIFEST_FILE} is not UTF-8 text"))?;
    if manifest.len() > 64 * 1024 {
        return Err(format!(
            "InvalidPackage: its {MANIFEST_FILE} is larger than 64 KiB"
        ));
    }
    Ok(Unpacked {
        manifest,
        files: count,
        bytes: total,
    })
}

/// `publisher.name` and `version` of a manifest's text.
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
    Ok((
        format!("{}.{}", field("publisher")?, field("name")?).to_lowercase(),
        field("version")?,
    ))
}

/// An extension id that is safe as a folder name (`publisher.name`, lower case).
pub fn valid_id(id: &str) -> bool {
    let parts: Vec<_> = id.split('.').collect();
    parts.len() == 2
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.len() <= 64
                && part
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
                && !part.starts_with('-')
        })
}

/// The installed folder of `id` in `root` (the user's extensions), found by its manifest.
pub fn installed_folder(root: &Path, id: &str) -> Option<PathBuf> {
    discover(root).extensions.into_iter().find_map(|found| {
        let manifest = found.manifest?;
        (identity(&manifest).ok()?.0 == id).then(|| PathBuf::from(found.folder))
    })
}

/// Puts an unpacked package (`staged`) in place as `<root>/<id>`. An installation already
/// there is moved aside into `<root>/.previous/`, not deleted: `finish` deletes it once the
/// new one is registered, or moves it back. Returns where the previous one went, if any.
pub fn commit(
    root: &Path,
    staged: &Path,
    id: &str,
    token: &str,
) -> Result<Option<PathBuf>, String> {
    if !valid_id(id) {
        return Err(format!("InvalidPackage: \"{id}\" is not an extension id"));
    }
    let target = root.join(id);
    let current = installed_folder(root, id);
    let mut previous = None;
    if let Some(current) = current {
        let aside_root = root.join(PREVIOUS);
        fs::create_dir_all(&aside_root).map_err(|e| format!("InstallFailed: {e}"))?;
        let aside = aside_root.join(format!("{id}-{token}"));
        fs::rename(&current, &aside).map_err(|e| {
            format!("InstallFailed: the installed version could not be moved aside ({e}); is it in use?")
        })?;
        previous = Some(aside);
    }
    if let Err(error) = fs::rename(staged, &target) {
        // Put the working installation back before reporting.
        if let Some(aside) = &previous {
            let _ = fs::rename(aside, &target);
        }
        return Err(format!("InstallFailed: {error}"));
    }
    Ok(previous)
}

/// After `commit`: `keep` the new installation (the previous one is deleted) or roll back to
/// the previous one (the new one is deleted; with no previous, the extension is uninstalled).
pub fn finish(root: &Path, id: &str, token: &str, keep: bool) -> Result<(), String> {
    if !valid_id(id) {
        return Err(format!("InvalidPackage: \"{id}\" is not an extension id"));
    }
    let aside = root.join(PREVIOUS).join(format!("{id}-{token}"));
    if keep {
        if aside.exists() {
            fs::remove_dir_all(&aside).map_err(|e| format!("CleanupFailed: {e}"))?;
        }
        return Ok(());
    }
    let target = root.join(id);
    if target.exists() {
        fs::remove_dir_all(&target).map_err(|e| format!("RollbackFailed: {e}"))?;
    }
    if aside.exists() {
        fs::rename(&aside, &target).map_err(|e| format!("RollbackFailed: {e}"))?;
    }
    Ok(())
}

/// Deletes the user's installation of `id` (never anything outside `root`).
pub fn uninstall(root: &Path, id: &str) -> Result<PathBuf, String> {
    let folder = installed_folder(root, id).ok_or_else(|| {
        format!("UnknownExtension: {id} is not installed in Yavin's extensions folder.")
    })?;
    let base = root
        .canonicalize()
        .map_err(|e| format!("UninstallFailed: {e}"))?;
    let real = folder
        .canonicalize()
        .map_err(|e| format!("UninstallFailed: {e}"))?;
    if real.parent() != Some(base.as_path()) {
        return Err(format!(
            "UninstallFailed: {} is not inside Yavin's extensions folder.",
            folder.display()
        ));
    }
    // `remove_dir_all` does not follow links inside the folder: only the folder's own files go.
    fs::remove_dir_all(&folder).map_err(|e| format!("UninstallFailed: {e}"))?;
    Ok(folder)
}

/// Repairs what an interrupted install left: staging folders are deleted; an installation
/// moved aside whose replacement never arrived is moved back, and one whose replacement did
/// is deleted.
pub fn recover(root: &Path) {
    let _ = fs::remove_dir_all(root.join(STAGING));
    let Ok(entries) = fs::read_dir(root.join(PREVIOUS)) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().into_owned();
        // `<id>-<token>`: the id is everything before the last `-`.
        let Some((id, _)) = name.rsplit_once('-') else {
            continue;
        };
        if !valid_id(id) {
            continue;
        }
        if installed_folder(root, id).is_some() {
            let _ = fs::remove_dir_all(entry.path());
        } else {
            let _ = fs::rename(entry.path(), root.join(id));
        }
    }
    let _ = fs::remove_dir(root.join(PREVIOUS));
}

#[cfg(test)]
pub mod tests {
    use super::*;
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

    fn installed(root: &Path, folder: &str, version: &str) {
        let dir = root.join(folder);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(MANIFEST_FILE), MANIFEST.replace("1.0.0", version)).unwrap();
    }

    fn version_of(root: &Path) -> String {
        identity(&fs::read_to_string(root.join("acme.hello").join(MANIFEST_FILE)).unwrap())
            .unwrap()
            .1
    }

    #[test]
    fn an_update_keeps_the_working_version_until_finished_and_rolls_back() {
        let root = temp("update");
        installed(&root, "acme.hello", "1.0.0");
        let staged = root.join(STAGING).join("t1");
        fs::create_dir_all(&staged).unwrap();
        fs::write(
            staged.join(MANIFEST_FILE),
            MANIFEST.replace("1.0.0", "2.0.0"),
        )
        .unwrap();
        let previous = commit(&root, &staged, "acme.hello", "t1").unwrap().unwrap();
        assert!(
            previous.join(MANIFEST_FILE).is_file(),
            "the old version is kept aside"
        );
        assert_eq!(version_of(&root), "2.0.0");
        // Discovery sees one acme.hello: the folders Yavin keeps aside are not extensions.
        let found: Vec<_> = discover(&root)
            .extensions
            .into_iter()
            .filter_map(|f| f.manifest)
            .collect();
        assert_eq!(found.len(), 1);
        finish(&root, "acme.hello", "t1", false).unwrap();
        assert_eq!(version_of(&root), "1.0.0", "rolled back");

        let staged = root.join(STAGING).join("t2");
        fs::create_dir_all(&staged).unwrap();
        fs::write(
            staged.join(MANIFEST_FILE),
            MANIFEST.replace("1.0.0", "2.0.0"),
        )
        .unwrap();
        commit(&root, &staged, "acme.hello", "t2").unwrap();
        finish(&root, "acme.hello", "t2", true).unwrap();
        assert_eq!(version_of(&root), "2.0.0");
        assert!(
            !root.join(PREVIOUS).join("acme.hello-t2").exists(),
            "cleaned up"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_interrupted_update_is_repaired_on_recovery() {
        let root = temp("recover");
        // Moved aside, replacement never arrived: moved back.
        fs::create_dir_all(root.join(PREVIOUS)).unwrap();
        installed(&root.join(PREVIOUS), "acme.hello-t9", "1.0.0");
        fs::create_dir_all(root.join(STAGING).join("junk")).unwrap();
        recover(&root);
        assert_eq!(version_of(&root), "1.0.0");
        assert!(!root.join(STAGING).exists());
        // Replacement arrived: the old one is deleted.
        installed(&root.join(PREVIOUS), "acme.hello-t10", "0.9.0");
        recover(&root);
        assert_eq!(version_of(&root), "1.0.0");
        assert!(!root.join(PREVIOUS).exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn uninstall_removes_only_the_extension_folder_inside_the_root() {
        let root = temp("uninstall");
        installed(&root, "hello-any-name", "1.0.0");
        fs::write(root.join("keep.txt"), "x").unwrap();
        let removed = uninstall(&root, "acme.hello").unwrap();
        assert!(!removed.exists());
        assert!(root.join("keep.txt").exists());
        assert!(uninstall(&root, "acme.hello")
            .unwrap_err()
            .starts_with("UnknownExtension"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn ids_are_checked_before_they_become_folder_names() {
        for good in ["acme.hello", "yavin-samples.hello-world", "a1.b2"] {
            assert!(valid_id(good), "{good}");
        }
        for bad in [
            "acme",
            "../x.y",
            "acme.hello.x",
            "Acme.hello",
            "acme.",
            ".hello",
            "a\\b.c",
            "con.x/y",
        ] {
            assert!(!valid_id(bad), "{bad}");
        }
    }
}
