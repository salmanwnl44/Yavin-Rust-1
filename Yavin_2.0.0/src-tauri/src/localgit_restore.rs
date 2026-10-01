//! Carries out a Local Git restore plan (`ide_localgit::restore`) on the workspace's disk.
//!
//! Local Git never writes into a project itself: this is the file-operation layer doing it,
//! the way every other disk change in Yavin is done -- one Module 03 operation (`expecting`),
//! whose intent Module 04 records durably before anything is touched:
//!
//! ```text
//! check every path again -> record the intent (M04) -> removals -> folders -> files, links -> close
//! ```
//!
//! **Before anything changes**, every path the plan names is checked against the state the
//! plan saw (`diskChangedSinceSnapshot` if it moved on), every folder on the way must be a real
//! folder and never a link (so nothing is written through a junction out of the workspace),
//! and the links to create are tried in a scratch folder first (`linkNotRestorable` if this
//! system cannot make them). Any of these refuses the whole restore, untouched.
//!
//! **Each path is one effect** in the M04 record: what it held before the restore and what it
//! holds after (a file's exact bytes, a folder, a link, nothing). Each file is written to a
//! temporary file beside it -- recorded too, absent before and after -- then renamed into place,
//! so a file is always its old bytes or its new ones. If the process dies partway, the next
//! start settles the record as a whole: completed, not applied, or `partial` -- reported and
//! left for the user, never replayed or undone by guessing.
//!
//! **After a failure** (a disk error partway) the live process reports exactly how far it got;
//! it never claims success.

use crate::{expecting_operation, Planned, Watch};
use ide_localgit::restore::{Expected, OpKind, RestoreConflict, RestoreOp, RestorePlan};
use ide_localgit::{
    hash_blob_stream, hash_object, ObjectId, ObjectKind, Repository, SnapshotEngine,
};
use ide_workspace::file_tree::{temp_nonce, temp_path_for};
use ide_workspace::operations::{Expectation, OperationKind};
use ide_workspace::recovery::{DiskState, Role};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// What happened when a plan was carried out.
#[derive(Debug)]
pub(crate) enum Outcome {
    /// Every operation was done (the M03 operation's id).
    Done { operation: u64, applied: usize },
    /// Refused before anything was touched.
    Refused(Vec<RestoreConflict>),
    /// Started, and stopped by an error partway: `applied` of the operations were done.
    Failed {
        operation: Option<u64>,
        applied: usize,
        error: String,
    },
}

/// Test hook: the number of operations after which a restore "crashes" (panics), as a
/// process dying partway would.
#[cfg(test)]
pub(crate) mod crash {
    use std::cell::Cell;
    thread_local! {
        pub static AFTER: Cell<Option<usize>> = const { Cell::new(None) };
        pub static FAIL_AFTER: Cell<Option<usize>> = const { Cell::new(None) };
    }
    pub fn arm(after: usize) {
        AFTER.with(|a| a.set(Some(after)));
    }
    /// The operation after `after` fails with an I/O error (a full disk, a lock).
    pub fn fail(after: usize) {
        FAIL_AFTER.with(|a| a.set(Some(after)));
    }
    pub(super) fn check(done: usize) {
        if AFTER.with(|a| a.get()) == Some(done) {
            AFTER.with(|a| a.set(None));
            panic!("simulated crash after {done} restore operations");
        }
    }
    pub(super) fn injected(done: usize) -> std::io::Result<()> {
        if FAIL_AFTER.with(|a| a.get()) == Some(done) {
            FAIL_AFTER.with(|a| a.set(None));
            return Err(std::io::Error::other("simulated disk failure"));
        }
        Ok(())
    }
}

#[cfg(not(test))]
mod crash {
    #[inline(always)]
    pub(super) fn check(_done: usize) {}
    #[inline(always)]
    pub(super) fn injected(_done: usize) -> std::io::Result<()> {
        Ok(())
    }
}

fn absolute(root: &Path, path: &str) -> PathBuf {
    let mut out = root.to_path_buf();
    for name in path.split('/').filter(|n| !n.is_empty()) {
        out.push(name);
    }
    out
}

fn is_link(meta: &fs::Metadata) -> bool {
    meta.file_type().is_symlink()
}

/// Whether what is at `path` is what the plan saw there.
fn holds(path: &Path, expected: &Expected) -> bool {
    let meta = fs::symlink_metadata(path);
    match expected {
        Expected::Absent => meta.is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound),
        Expected::Directory => meta.is_ok_and(|m| m.is_dir() && !is_link(&m)),
        Expected::File { id, stored } => {
            if !meta.is_ok_and(|m| m.is_file() && !is_link(&m)) {
                return false;
            }
            if *stored {
                fs::read(path).is_ok_and(|bytes| hash_object(ObjectKind::Blob, &bytes) == id.0)
            } else {
                fs::File::open(path)
                    .ok()
                    .zip(fs::metadata(path).ok())
                    .and_then(|(mut file, meta)| hash_blob_stream(meta.len(), &mut file).ok())
                    == Some(id.0)
            }
        }
        Expected::Link { id } => {
            meta.is_ok_and(|m| is_link(&m))
                && fs::read_link(path).is_ok_and(|target| {
                    target
                        .to_str()
                        .is_some_and(|t| hash_object(ObjectKind::Blob, t.as_bytes()) == id.0)
                })
        }
    }
}

/// What M04 records a path as holding before the restore.
fn recorded(path: &Path, expected: &Expected) -> DiskState {
    match expected {
        Expected::Absent => DiskState::Absent,
        Expected::Directory => DiskState::observe_tree(path),
        Expected::File { stored: true, .. } => fs::read(path)
            .map(|bytes| DiskState::file(&bytes))
            .unwrap_or(DiskState::Present),
        _ => DiskState::Present,
    }
}

/// Every folder between `root` and `path` must be a real folder -- or one the plan makes
/// (after removing what is there). Never a link: nothing is written through one.
fn ancestors_safe(root: &Path, op: &RestoreOp, made: &BTreeMap<String, ()>) -> bool {
    let names: Vec<&str> = op.path.split('/').filter(|n| !n.is_empty()).collect();
    let mut prefix = String::new();
    for name in &names[..names.len().saturating_sub(1)] {
        prefix = if prefix.is_empty() {
            name.to_string()
        } else {
            format!("{prefix}/{name}")
        };
        if made.contains_key(&format!("{}\0{prefix}", op.folder_id)) {
            continue;
        }
        match fs::symlink_metadata(absolute(root, &prefix)) {
            Ok(meta) if meta.is_dir() && !is_link(&meta) => {}
            _ => return false,
        }
    }
    true
}

/// Creates a link as recorded. Windows junctions are made with the reparse point itself;
/// symbolic links need the system to allow them (Developer Mode, or elevation).
fn make_link(path: &Path, target: &str, kind: Option<&str>) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        match kind {
            Some("junction") => junction::create(path, target),
            Some("directory") => std::os::windows::fs::symlink_dir(target, path),
            _ => std::os::windows::fs::symlink_file(target, path),
        }
    }
    #[cfg(unix)]
    {
        let _ = kind;
        std::os::unix::fs::symlink(target, path)
    }
}

fn remove_link(path: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTypeExt;
        let meta = fs::symlink_metadata(path)?;
        if meta.file_type().is_symlink_dir() {
            // A junction or directory link: the link goes, never what it points at.
            return fs::remove_dir(path);
        }
    }
    fs::remove_file(path)
}

/// Whether this system can create the link kinds a plan needs: tried in a scratch folder.
fn link_problems(plan: &RestorePlan, scratch: &Path) -> Vec<(String, String, String)> {
    let mut problems = Vec::new();
    let mut tried: BTreeMap<&str, Result<(), String>> = BTreeMap::new();
    for op in plan
        .operations
        .iter()
        .filter(|op| op.kind == OpKind::CreateLink)
    {
        let kind = op.link.unwrap_or("file");
        let verdict = tried.entry(kind).or_insert_with(|| {
            let _ = fs::create_dir_all(scratch);
            let probe = scratch.join(format!("probe-{kind}-{}", temp_nonce()));
            let target = scratch.join("probe-target");
            let _ = fs::create_dir_all(&target);
            let made = make_link(&probe, &target.to_string_lossy(), Some(kind));
            let _ = remove_link(&probe);
            made.map_err(|e| e.to_string())
        });
        if let Err(reason) = verdict {
            problems.push((op.folder_id.clone(), op.path.clone(), reason.clone()));
        }
    }
    problems
}

/// Carries out `plan` (from `engine`'s last restore plan) as one recorded operation.
pub(crate) fn execute(
    watch: &Watch,
    repo: &Mutex<Repository>,
    engine: &SnapshotEngine,
    plan: &RestorePlan,
    scratch: &Path,
) -> Outcome {
    let root_of = |folder: &str| engine.folder_root(folder).map(Path::to_path_buf);
    // 1. Check everything again, before anything is touched.
    let mut conflicts = Vec::new();
    let mut first_seen: BTreeMap<String, &RestoreOp> = BTreeMap::new();
    let mut made: BTreeMap<String, ()> = BTreeMap::new();
    for op in &plan.operations {
        let Some(root) = root_of(&op.folder_id) else {
            conflicts.push(RestoreConflict::TargetUnavailable {
                folder_id: op.folder_id.clone(),
                path: op.path.clone(),
            });
            continue;
        };
        let key = format!("{}\0{}", op.folder_id, op.path);
        if !first_seen.contains_key(&key) {
            first_seen.insert(key.clone(), op);
            if !holds(&absolute(&root, &op.path), &op.expected) {
                conflicts.push(RestoreConflict::DiskChangedSinceSnapshot {
                    folder_id: op.folder_id.clone(),
                    path: op.path.clone(),
                });
            }
        }
        if !ancestors_safe(&root, op, &made) {
            conflicts.push(RestoreConflict::PathBlocked {
                folder_id: op.folder_id.clone(),
                path: op.path.clone(),
            });
        }
        if op.kind == OpKind::CreateDirectory {
            made.insert(key, ());
        }
    }
    // A folder is removed only if everything in it is: what a snapshot leaves out (a nested
    // `.git`, `node_modules`) is never deleted along with it.
    let removed: std::collections::HashSet<String> = plan
        .operations
        .iter()
        .filter(|op| {
            matches!(
                op.kind,
                OpKind::RemoveFile | OpKind::RemoveLink | OpKind::RemoveDirectory
            )
        })
        .map(|op| format!("{}\0{}", op.folder_id, op.path))
        .collect();
    for op in plan
        .operations
        .iter()
        .filter(|op| op.kind == OpKind::RemoveDirectory)
    {
        let Some(root) = root_of(&op.folder_id) else {
            continue;
        };
        if let Ok(entries) = fs::read_dir(absolute(&root, &op.path)) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if !removed.contains(&format!("{}\0{}/{name}", op.folder_id, op.path)) {
                    conflicts.push(RestoreConflict::WouldRemoveUntracked {
                        folder_id: op.folder_id.clone(),
                        path: op.path.clone(),
                        entry: name,
                    });
                }
            }
        }
    }
    for (folder_id, path, reason) in link_problems(plan, scratch) {
        conflicts.push(RestoreConflict::LinkNotRestorable {
            folder_id,
            path,
            reason,
        });
    }
    if !conflicts.is_empty() {
        conflicts.dedup();
        return Outcome::Refused(conflicts);
    }

    // 2. The record: one effect per path (before -> after), and each file's temporary file.
    let mut final_op: BTreeMap<String, &RestoreOp> = BTreeMap::new();
    for op in &plan.operations {
        final_op.insert(format!("{}\0{}", op.folder_id, op.path), op);
    }
    let mut effects = Vec::new();
    let mut temps: BTreeMap<String, PathBuf> = BTreeMap::new();
    for (key, first) in &first_seen {
        let last = final_op[key];
        let root = root_of(&last.folder_id).expect("checked above");
        let path = absolute(&root, &last.path);
        let pre = recorded(&path, &first.expected);
        let (expectation, post) = match last.kind {
            OpKind::RemoveFile | OpKind::RemoveLink | OpKind::RemoveDirectory => {
                (Expectation::Absent, DiskState::Absent)
            }
            OpKind::CreateDirectory => (Expectation::Directory, DiskState::Directory),
            OpKind::CreateLink => (Expectation::Present, DiskState::Present),
            OpKind::WriteFile => {
                let id = last.blob.expect("a file written has a blob").0;
                let bytes = match repo.lock().unwrap().read_blob(&id, u64::MAX) {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        return Outcome::Refused(vec![
                            RestoreConflict::HistoricalContentUnavailable {
                                folder_id: last.folder_id.clone(),
                                path: format!("{} ({error})", last.path),
                                reason: "missing",
                            },
                        ])
                    }
                };
                let temp = temp_path_for(&path, temp_nonce());
                effects.push(
                    Planned::new(
                        temp.clone(),
                        Expectation::transient(&bytes),
                        DiskState::Absent,
                    )
                    .pre(DiskState::Absent)
                    .role(Role::Temporary),
                );
                temps.insert(key.clone(), temp);
                (Expectation::content(&bytes), DiskState::file(&bytes))
            }
        };
        effects.push(Planned::new(path, expectation, post).pre(pre));
    }

    // 3. The disk changes, in the plan's order.
    let applied = std::cell::Cell::new(0usize);
    let result = expecting_operation(watch, OperationKind::Restore, effects, || {
        for op in &plan.operations {
            let root = root_of(&op.folder_id).expect("checked above");
            let path = absolute(&root, &op.path);
            let key = format!("{}\0{}", op.folder_id, op.path);
            let done = crash::injected(applied.get()).and_then(|()| match op.kind {
                OpKind::RemoveFile => fs::remove_file(&path),
                OpKind::RemoveLink => remove_link(&path),
                OpKind::RemoveDirectory => fs::remove_dir(&path),
                OpKind::CreateDirectory => fs::create_dir(&path),
                OpKind::WriteFile => write_file(repo, op, &path, &temps[&key]),
                OpKind::CreateLink => {
                    let id = op.blob.expect("a link has its target").0;
                    read_blob(repo, &id).and_then(|bytes| {
                        let target = String::from_utf8(bytes).map_err(|_| {
                            std::io::Error::new(
                                std::io::ErrorKind::InvalidData,
                                "the link's target is not text",
                            )
                        })?;
                        make_link(&path, &target, op.link)
                    })
                }
            });
            if let Err(error) = done {
                return Err(format!(
                    "{:?} {}: {error} ({} of {} operations were done)",
                    op.kind,
                    op.path,
                    applied.get(),
                    plan.operations.len()
                ));
            }
            applied.set(applied.get() + 1);
            crash::check(applied.get());
        }
        Ok(())
    });
    match result {
        Ok((operation, ())) => Outcome::Done {
            operation,
            applied: applied.get(),
        },
        Err(error) => Outcome::Failed {
            operation: None,
            applied: applied.get(),
            error,
        },
    }
}

fn read_blob(repo: &Mutex<Repository>, id: &ObjectId) -> std::io::Result<Vec<u8>> {
    repo.lock()
        .unwrap()
        .read_blob(id, u64::MAX)
        .map_err(|e| std::io::Error::other(e.to_string()))
}

/// The file's bytes, written beside it and renamed into place: it is always the old bytes or
/// the new ones.
fn write_file(
    repo: &Mutex<Repository>,
    op: &RestoreOp,
    path: &Path,
    temp: &Path,
) -> std::io::Result<()> {
    let bytes = read_blob(repo, &op.blob.expect("a file written has a blob").0)?;
    let written = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = if op.executable { 0o755 } else { 0o644 };
            fs::set_permissions(temp, fs::Permissions::from_mode(mode))?;
        }
        fs::rename(temp, path)
    })();
    if written.is_err() {
        let _ = fs::remove_file(temp);
    }
    written
}

#[cfg(windows)]
mod junction {
    //! A junction (directory mount point) made with its reparse point, as `mklink /J` does.
    use std::fs;
    use std::io;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use std::path::Path;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    };
    use windows_sys::Win32::System::Ioctl::FSCTL_SET_REPARSE_POINT;
    use windows_sys::Win32::System::IO::DeviceIoControl;

    const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003;

    pub fn create(link: &Path, target: &str) -> io::Result<()> {
        fs::create_dir(link)?;
        let made = set(link, target);
        if made.is_err() {
            let _ = fs::remove_dir(link);
        }
        made
    }

    fn set(link: &Path, target: &str) -> io::Result<()> {
        let plain = target
            .strip_prefix(r"\\?\")
            .or_else(|| target.strip_prefix(r"\??\"))
            .unwrap_or(target);
        let substitute: Vec<u16> = format!(r"\??\{plain}").encode_utf16().collect();
        let print: Vec<u16> = plain.encode_utf16().collect();
        let (sub_len, print_len) = (substitute.len() * 2, print.len() * 2);
        // MountPointReparseBuffer: four u16 offsets/lengths, then both names NUL-terminated.
        let data_len = 8 + sub_len + 2 + print_len + 2;
        let too_long = || {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "the junction's target is too long",
            )
        };
        let mut buffer = Vec::with_capacity(8 + data_len);
        buffer.extend(IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
        buffer.extend(
            u16::try_from(data_len)
                .map_err(|_| too_long())?
                .to_le_bytes(),
        );
        buffer.extend(0u16.to_le_bytes());
        buffer.extend(0u16.to_le_bytes());
        buffer.extend((sub_len as u16).to_le_bytes());
        buffer.extend(((sub_len + 2) as u16).to_le_bytes());
        buffer.extend((print_len as u16).to_le_bytes());
        for unit in substitute
            .iter()
            .chain([&0u16])
            .chain(print.iter())
            .chain([&0u16])
        {
            buffer.extend(unit.to_le_bytes());
        }
        let handle = fs::OpenOptions::new()
            .write(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .open(link)?;
        let mut returned = 0u32;
        // SAFETY: `buffer` is a complete REPARSE_DATA_BUFFER of the length passed, and the
        // handle is open for the duration of the call.
        let ok = unsafe {
            DeviceIoControl(
                handle.as_raw_handle() as _,
                FSCTL_SET_REPARSE_POINT,
                buffer.as_ptr() as _,
                buffer.len() as u32,
                std::ptr::null_mut(),
                0,
                &mut returned,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
#[path = "localgit_restore_tests.rs"]
pub(crate) mod tests;

#[cfg(test)]
#[path = "localgit_restore_git_tests.rs"]
mod git_tests;

#[cfg(test)]
#[path = "localgit_switch_tests.rs"]
mod switch_tests;

#[cfg(test)]
#[path = "localgit_lg05_tests.rs"]
mod lg05_tests;

#[cfg(test)]
#[path = "localgit_lg06_tests.rs"]
mod lg06_tests;
