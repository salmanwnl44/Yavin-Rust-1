//! EXT-33 E1: the native **C1 broker** -- the narrowest brokered process capability.
//!
//! A C1 run is a one-shot **filter**: text in on stdin, text out on stdout, nothing else. The
//! program is one Yavin names in a reviewed **profile**, started in the EXT-10 sandbox
//! ([`crate::sandbox`]) -- an AppContainer with no capabilities, its own job with one process and
//! a memory cap, every mitigation, and kill-on-close -- so Windows itself refuses the program any
//! file, the network, a child process, or a handle to Yavin. The broker adds, above that OS
//! boundary:
//!
//! - **no arbitrary program.** A run names a profile `id`; the program is the profile's, with a
//!   pinned path and SHA-256. Nothing a caller passes becomes a program path or a raw argument.
//! - **typed arguments only.** A profile's argv is a template of typed [`Slot`]s (a fixed flag, an
//!   enumerated value, a bounded integer, a bare file name). A caller fills slots; it cannot inject
//!   a path, free text, a separator, a NUL or a newline.
//! - **identity, and no swap.** The program is canonicalised, required to be a PE image (not a
//!   `.cmd`/`.bat`/`.ps1`/… script and not a reparse point), hashed, and checked against the
//!   profile's digest at every launch; the file is held open with no write- or delete-sharing
//!   across the launch, so it cannot be replaced between the check and the start.
//! - **bounds.** stdin ≤ [`MAX_STDIN`], stdout ≤ [`MAX_STDOUT`] (over it: the job is ended), a
//!   total deadline of [`TOTAL_DEADLINE`], [`MEMORY_BYTES`] of committed memory, one process, and
//!   at most [`MAX_CONCURRENT`] C1 processes at once.
//! - **fail closed.** If the sandbox cannot be established the run fails ([`C1Code::SandboxUnavailable`]);
//!   there is no unsandboxed fallback. Off Windows every run is [`C1Code::UnsupportedPlatform`].
//!
//! This module is private to the native side. E1 does **not** expose it to extension JavaScript:
//! there is no Tauri command and no `native(...)` binding for it, and Yavin ships no C1 profiles
//! yet (consent, grants and the extension API are E2 and E4). Its tests drive it directly with a
//! real operating-system filter, proving the boundary rather than that a program merely starts.

use crate::sandbox::SandboxedChild;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// Watches a launch so an owner (the EXT-33 E2 grant authority) can end it when a grant is
/// revoked. The broker calls `started` the instant the process exists, handing it an `Arc` to
/// the child so the owner can end it later, and `ended` when the run finishes. `started` returns
/// a flag the broker watches: while it is `true` the run proceeds; set to `false` (revocation)
/// the broker ends the process and the run fails with [`C1Code::PermissionDenied`].
pub trait LaunchObserver: Send + Sync {
    fn started(&self, child: Arc<SandboxedChild>) -> Arc<AtomicBool>;
    fn ended(&self, child: &Arc<SandboxedChild>);
}

/// The most stdin a C1 filter is given (a `document` slot's text, §9.2).
pub const MAX_STDIN: usize = 8 << 20;
/// The most stdout a C1 filter may produce before its job is ended ([`C1Code::OutputTooLarge`]).
pub const MAX_STDOUT: usize = 16 << 20;
/// The most stderr kept (the rest is dropped; stderr is diagnostic, not the result).
pub const MAX_STDERR: usize = 64 << 10;
/// A C1 run's wall-clock deadline; past it the job is ended ([`C1Code::Timeout`]).
pub const TOTAL_DEADLINE: Duration = Duration::from_secs(30);
/// The committed memory its job allows (§11).
pub const MEMORY_BYTES: u64 = 512 << 20;
/// The most C1 processes across the host at once (§11; the per-extension cap is E4).
pub const MAX_CONCURRENT: u32 = 8;

/// A typed argument slot in a profile's argv template. None carries free text or a path: that is
/// how an extension-chosen value cannot become an injection (§9.2, T6).
#[derive(Clone, Debug)]
pub enum Slot {
    /// A fixed token the caller does not influence (e.g. `--stdin`).
    Literal(&'static str),
    /// `prefix` followed by one of `allowed` (e.g. `--style=` + `LLVM|Google`).
    Enum {
        prefix: &'static str,
        allowed: &'static [&'static str],
    },
    /// `prefix` followed by a base-10 integer in `min..=max` (e.g. `--tab-width=` + `1..=16`).
    Int {
        prefix: &'static str,
        min: i64,
        max: i64,
    },
    /// `prefix` followed by a bare file name: no separators, drive, `..`, NUL or newline (§9.2
    /// `file-name-only`). A C1 filter never opens it; it is only a name a formatter echoes.
    FileName { prefix: &'static str },
}

/// A caller's value for a [`Slot`], by position. The kind must match the slot or the run is
/// [`C1Code::BadRequest`].
#[derive(Clone, Debug)]
pub enum SlotValue {
    /// For [`Slot::Literal`]: the caller supplies nothing.
    Fixed,
    Enum(String),
    Int(i64),
    FileName(String),
}

/// A program's identity: its path and the lowercase-hex SHA-256 it must still have at launch.
/// In production this comes from the extension's verified copy (EXT-19); the broker never
/// discovers or searches for a program.
#[derive(Clone, Debug)]
pub struct ProgramId {
    pub path: PathBuf,
    pub sha256: String,
}

/// A Yavin-authored C1 profile (§9.2). Extensions cannot add one.
#[derive(Clone, Debug)]
pub struct C1Profile {
    pub id: &'static str,
    pub program: ProgramId,
    pub argv: Vec<Slot>,
}

/// How a run ended.
#[derive(Debug, Clone, PartialEq)]
pub enum End {
    /// The process exited on its own.
    Exited,
    /// The job was ended by the broker, for this reason.
    Killed(&'static str),
}

/// A finished C1 run.
#[derive(Debug)]
pub struct C1Output {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub end: End,
}

/// A structured broker error (§9.8). The message never names Yavin's internals.
#[derive(Debug, Clone, PartialEq)]
pub struct C1Error {
    pub code: C1Code,
    pub message: String,
    pub profile: Option<String>,
}

/// The error codes a C1 run can fail with (§9.8, C1-relevant subset).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum C1Code {
    /// No grant covers this launch, or its grant was revoked (EXT-33 E2).
    PermissionDenied,
    UnknownProfile,
    BadRequest,
    InputTooLarge,
    UnsupportedPlatform,
    SandboxUnavailable,
    ExecutableNotFound,
    ExecutableChanged,
    OutputTooLarge,
    Timeout,
    TooManyProcesses,
    Cancelled,
}

impl C1Error {
    fn new(code: C1Code, message: impl Into<String>) -> C1Error {
        C1Error {
            code,
            message: message.into(),
            profile: None,
        }
    }
    fn for_profile(mut self, id: &str) -> C1Error {
        self.profile = Some(id.to_string());
        self
    }
}

/// The native C1 broker: a fixed set of profiles and a live-process counter. Private to the
/// native side; not a Tauri command (E1 exposes nothing to extensions).
pub struct C1Broker {
    profiles: Vec<C1Profile>,
    running: Arc<AtomicU32>,
    deadline: Duration,
}

impl C1Broker {
    /// A broker over `profiles` (Yavin-authored; empty in E1's production build).
    pub fn new(profiles: Vec<C1Profile>) -> C1Broker {
        C1Broker {
            profiles,
            running: Arc::new(AtomicU32::new(0)),
            deadline: TOTAL_DEADLINE,
        }
    }

    /// The total deadline for a run (default [`TOTAL_DEADLINE`]). A seam for tests and, later, a
    /// per-profile timeout; not exposed to extensions.
    pub fn with_deadline(mut self, deadline: Duration) -> C1Broker {
        self.deadline = deadline;
        self
    }

    /// How many C1 processes this broker counts as running now. For tests and diagnostics: it
    /// shows the concurrency slot was released when a run ended, however it ended.
    pub fn running_now(&self) -> u32 {
        self.running.load(Ordering::SeqCst)
    }

    /// The pinned program identity of the profile `id`, if the broker holds it. The program is the
    /// profile's, never a caller's: this is how an authorizer learns what a profile would run.
    pub fn profile_program(&self, id: &str) -> Option<ProgramId> {
        self.profiles
            .iter()
            .find(|p| p.id == id)
            .map(|p| p.program.clone())
    }

    /// Runs the C1 profile `profile_id` as a filter: `stdin` in, its stdout out. `slots` fills the
    /// profile's argv template by position. `cancel` ends the run when set.
    pub fn run(
        &self,
        profile_id: &str,
        slots: &[SlotValue],
        stdin: &[u8],
        cancel: Arc<AtomicBool>,
    ) -> Result<C1Output, C1Error> {
        self.run_observed(profile_id, slots, stdin, cancel, None)
    }

    /// As [`run`](Self::run), but with a [`LaunchObserver`] so an owner can end the launch on
    /// revocation (EXT-33 E2). E1's own path passes `None`.
    pub fn run_observed(
        &self,
        profile_id: &str,
        slots: &[SlotValue],
        stdin: &[u8],
        cancel: Arc<AtomicBool>,
        observer: Option<&dyn LaunchObserver>,
    ) -> Result<C1Output, C1Error> {
        if stdin.len() > MAX_STDIN {
            return Err(C1Error::new(
                C1Code::InputTooLarge,
                format!(
                    "the input is larger than the {} MiB a filter accepts.",
                    MAX_STDIN >> 20
                ),
            )
            .for_profile(profile_id));
        }
        let profile = self
            .profiles
            .iter()
            .find(|p| p.id == profile_id)
            .ok_or_else(|| {
                C1Error::new(C1Code::UnknownProfile, "no such filter.").for_profile(profile_id)
            })?;
        let argv = build_argv(&profile.argv, slots).map_err(|e| e.for_profile(profile_id))?;
        imp::run(
            profile,
            argv,
            stdin,
            &self.running,
            self.deadline,
            cancel,
            observer,
        )
        .map_err(|e| e.for_profile(profile_id))
    }
}

/// The lowercase-hex SHA-256 of `path`, for pinning a profile's program identity ([`ProgramId`])
/// from the verified copy. A plain read; the no-swap verification at launch is separate (§7.3).
pub fn sha256_hex(path: &Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 << 10];
    loop {
        match file.read(&mut buf)? {
            0 => break,
            n => hasher.update(&buf[..n]),
        }
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// Builds the argument vector from a profile's typed template and the caller's slot values. Any
/// mismatch, out-of-range integer, value outside an enum, or unsafe file name is a `BadRequest`;
/// no value can become a flag, a path, or a second argument.
fn build_argv(template: &[Slot], values: &[SlotValue]) -> Result<Vec<String>, C1Error> {
    if template.len() != values.len() {
        return Err(C1Error::new(
            C1Code::BadRequest,
            "the wrong number of arguments for this filter.",
        ));
    }
    let bad = |m: &str| C1Error::new(C1Code::BadRequest, m.to_string());
    let mut argv = Vec::with_capacity(template.len());
    for (slot, value) in template.iter().zip(values) {
        let token = match (slot, value) {
            (Slot::Literal(text), SlotValue::Fixed) => text.to_string(),
            (Slot::Enum { prefix, allowed }, SlotValue::Enum(chosen)) => {
                if !allowed.contains(&chosen.as_str()) {
                    return Err(bad("an argument is not one of its allowed values."));
                }
                format!("{prefix}{chosen}")
            }
            (Slot::Int { prefix, min, max }, SlotValue::Int(n)) => {
                if n < min || n > max {
                    return Err(bad("a numeric argument is out of range."));
                }
                format!("{prefix}{n}")
            }
            (Slot::FileName { prefix }, SlotValue::FileName(name)) => {
                let ok = !name.is_empty()
                    && name.len() <= 255
                    && !name.contains(['/', '\\', ':', '\0', '\r', '\n', '"'])
                    && name != ".."
                    && name != ".";
                if !ok {
                    return Err(bad("a file-name argument is not a bare name."));
                }
                format!("{prefix}{name}")
            }
            _ => return Err(bad("an argument has the wrong kind for its slot.")),
        };
        argv.push(token);
    }
    Ok(argv)
}

/// Reserves one of at most `max` concurrent slots in `counter`, backing out atomically if the
/// reservation would exceed the cap. `true` if a slot was taken (the caller must release it with
/// one `fetch_sub`). Pulled out, and cross-platform, so the cap is tested without processes.
fn try_acquire(counter: &AtomicU32, max: u32) -> bool {
    if counter.fetch_add(1, Ordering::AcqRel) >= max {
        counter.fetch_sub(1, Ordering::AcqRel);
        return false;
    }
    true
}

/// The container name for C1 (one per class; per-extension containers are E4, Q11).
const CONTAINER: &str = "Yavin.BrokerC1";

/// A program whose extension marks it as a script Windows runs through an interpreter rather than
/// a PE image Yavin controls (§9.3). Refused as a C1 program.
const REFUSED_EXTENSIONS: &[&str] = &["cmd", "bat", "ps1", "vbs", "js", "lnk", "url", "msi"];

#[cfg(not(windows))]
mod imp {
    use super::*;

    pub fn run(
        _profile: &C1Profile,
        _argv: Vec<String>,
        _stdin: &[u8],
        _running: &Arc<AtomicU32>,
        _deadline: Duration,
        _cancel: Arc<AtomicBool>,
        _observer: Option<&dyn super::LaunchObserver>,
    ) -> Result<C1Output, C1Error> {
        Err(C1Error::new(
            C1Code::UnsupportedPlatform,
            "the filter sandbox is only available on Windows.",
        ))
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use crate::sandbox::{self, cpu_rate_for, SandboxPolicy};
    use sha2::{Digest, Sha256};
    use std::fs::File;
    use std::io::{Read, Write};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;
    use std::time::Instant;
    use windows_sys::Win32::Foundation::{GENERIC_READ, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetFileAttributesW, FILE_ATTRIBUTE_REPARSE_POINT, FILE_SHARE_READ,
        OPEN_EXISTING,
    };

    /// A counter guard: one more running C1 process while alive, one fewer when dropped.
    struct Running(Arc<AtomicU32>);
    impl Running {
        fn acquire(counter: &Arc<AtomicU32>) -> Result<Running, C1Error> {
            if !super::try_acquire(counter, MAX_CONCURRENT) {
                return Err(C1Error::new(
                    C1Code::TooManyProcesses,
                    "too many filters are already running; try again.",
                ));
            }
            Ok(Running(counter.clone()))
        }
    }
    impl Drop for Running {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::AcqRel);
        }
    }

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    /// Verifies the profile's program and returns its canonical path plus a handle held open with
    /// no write- or delete-sharing, so the file cannot be replaced between here and the launch.
    fn verify_program(program: &ProgramId) -> Result<(PathBuf, File), C1Error> {
        let canonical = std::fs::canonicalize(&program.path).map_err(|_| {
            C1Error::new(
                C1Code::ExecutableNotFound,
                "the filter program is not there.",
            )
        })?;
        let canonical = PathBuf::from(
            canonical
                .to_string_lossy()
                .strip_prefix(r"\\?\")
                .map(str::to_string)
                .unwrap_or_else(|| canonical.to_string_lossy().into_owned()),
        );
        if let Some(ext) = canonical.extension().and_then(|e| e.to_str()) {
            if REFUSED_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()) {
                return Err(C1Error::new(
                    C1Code::BadRequest,
                    "the filter program is a script, not a program Yavin can run directly.",
                ));
            }
        }
        // A reparse point (symlink/junction) is refused: the program must be the real file.
        // SAFETY: a wide, NUL-terminated path; the call only reads attributes.
        let attributes = unsafe { GetFileAttributesW(wide(&canonical).as_ptr()) };
        if attributes != u32::MAX && attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(C1Error::new(
                C1Code::BadRequest,
                "the filter program is a link, not a real program file.",
            ));
        }
        // Open with FILE_SHARE_READ only: others may read it, none may write, rename or delete it
        // while this handle lives. Held across CreateProcess, this is the no-swap guarantee (§7.3).
        // SAFETY: a wide, NUL-terminated path; a plain read-open; the returned handle is checked
        // and wrapped in an owning File before use.
        let handle = unsafe {
            CreateFileW(
                wide(&canonical).as_ptr(),
                GENERIC_READ,
                FILE_SHARE_READ,
                std::ptr::null(),
                OPEN_EXISTING,
                0,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE || handle.is_null() {
            return Err(C1Error::new(
                C1Code::ExecutableChanged,
                "the filter program could not be opened for verification.",
            ));
        }
        // SAFETY: a valid handle from CreateFileW, handed to an owning File.
        let mut file = unsafe { File::from_raw_handle(handle as _) };
        let mut head = [0u8; 0x40];
        let read = file.read(&mut head).unwrap_or(0);
        if !is_pe(&file, &head[..read]) {
            return Err(C1Error::new(
                C1Code::BadRequest,
                "the filter program is not a Windows program.",
            ));
        }
        // Hash from the very handle held open, from the start.
        use std::io::Seek;
        if file.rewind().is_err() {
            return Err(C1Error::new(
                C1Code::ExecutableChanged,
                "the filter program could not be read for verification.",
            ));
        }
        let mut hasher = Sha256::new();
        let mut buf = [0u8; 64 << 10];
        loop {
            match file.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => hasher.update(&buf[..n]),
                Err(_) => {
                    return Err(C1Error::new(
                        C1Code::ExecutableChanged,
                        "the filter program could not be read for verification.",
                    ))
                }
            }
        }
        let digest = hasher.finalize();
        let actual = digest
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        if !actual.eq_ignore_ascii_case(&program.sha256) {
            return Err(C1Error::new(
                C1Code::ExecutableChanged,
                "the filter program is not the one Yavin verified; it will not be run.",
            ));
        }
        Ok((canonical, file))
    }

    /// Whether `head` (the file's first bytes) begins a PE image: `MZ`, then `PE\0\0` at the
    /// offset `e_lfanew` holds.
    fn is_pe(file: &File, head: &[u8]) -> bool {
        if head.len() < 0x40 || &head[0..2] != b"MZ" {
            return false;
        }
        let e_lfanew = u32::from_le_bytes([head[0x3c], head[0x3d], head[0x3e], head[0x3f]]) as u64;
        use std::os::windows::fs::FileExt;
        let mut sig = [0u8; 4];
        file.seek_read(&mut sig, e_lfanew)
            .map(|n| n == 4)
            .unwrap_or(false)
            && &sig == b"PE\0\0"
    }

    pub fn run(
        profile: &C1Profile,
        argv: Vec<String>,
        stdin: &[u8],
        running: &Arc<AtomicU32>,
        deadline: Duration,
        cancel: Arc<AtomicBool>,
        observer: Option<&dyn super::LaunchObserver>,
    ) -> Result<C1Output, C1Error> {
        // Identity first, and keep the handle so the verified bytes cannot be swapped out.
        let (program, _held) = verify_program(&profile.program)?;
        // Then reserve a process slot; released when this run ends.
        let _slot = Running::acquire(running)?;

        let policy = SandboxPolicy {
            container: CONTAINER.into(),
            memory_bytes: MEMORY_BYTES,
            cpu_rate: cpu_rate_for(
                1,
                std::thread::available_parallelism().map_or(1, |n| n.get() as u32),
            ),
        };
        let argv_ref: Vec<&str> = argv.iter().map(String::as_str).collect();
        let spawned = match sandbox::spawn(&program, &argv_ref, &policy) {
            Ok(spawned) => spawned,
            Err(message) => {
                // The sandbox could not be established (or the program could not be started in
                // it): fail closed, never run it unsandboxed.
                let code = if message.starts_with("SandboxUnavailable") {
                    C1Code::SandboxUnavailable
                } else {
                    C1Code::ExecutableNotFound
                };
                return Err(C1Error::new(code, message));
            }
        };
        // The image is mapped now; the held handle has done its job.
        drop(_held);

        // Hand the process to the observer (the grant authority) so a revocation can end it. It
        // returns a flag the wait loop watches: cleared means "revoked", and the run fails closed.
        let child = Arc::new(spawned.child);
        let live = match observer {
            Some(obs) => obs.started(child.clone()),
            None => Arc::new(AtomicBool::new(true)),
        };

        // Feed stdin on its own thread, then close it so the filter sees end-of-input.
        let input = stdin.to_vec();
        let mut child_stdin = spawned.stdin;
        let writer = std::thread::spawn(move || {
            let _ = child_stdin.write_all(&input);
            // Dropping closes the pipe.
        });

        // Read stdout into a bounded buffer; signal if it overflows so the run is ended.
        let overflow = Arc::new(AtomicBool::new(false));
        let mut child_stdout = spawned.stdout;
        let out_overflow = overflow.clone();
        let reader = std::thread::spawn(move || {
            let mut out = Vec::new();
            let mut buf = [0u8; 64 << 10];
            loop {
                match child_stdout.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if out.len() + n > MAX_STDOUT {
                            out.extend_from_slice(&buf[..MAX_STDOUT - out.len()]);
                            out_overflow.store(true, Ordering::SeqCst);
                            break;
                        }
                        out.extend_from_slice(&buf[..n]);
                    }
                }
            }
            out
        });

        // Read stderr (bounded, diagnostic only). The pipe is always drained so the filter never
        // blocks writing to it, but only up to `MAX_STDERR` is kept; the rest is read and dropped.
        let mut child_stderr = spawned.stderr;
        let errors = std::thread::spawn(move || {
            let mut text = Vec::new();
            let mut buf = [0u8; 8 << 10];
            loop {
                match child_stderr.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let take = MAX_STDERR.saturating_sub(text.len()).min(n);
                        text.extend_from_slice(&buf[..take]);
                    }
                }
            }
            String::from_utf8_lossy(&text).into_owned()
        });

        // Wait for the process, bounded by the deadline, the cancel flag and the output bound.
        let started = Instant::now();
        let mut end = End::Exited;
        let code = loop {
            if let Some(code) = child
                .try_wait()
                .map_err(|e| C1Error::new(C1Code::SandboxUnavailable, e.to_string()))?
            {
                break Some(code);
            }
            // Revocation: the owner cleared the live flag (and may already have ended the job).
            if !live.load(Ordering::SeqCst) {
                child.kill();
                end = End::Killed("revoked");
                break None;
            }
            if overflow.load(Ordering::SeqCst) {
                child.kill();
                end = End::Killed("output");
                break None;
            }
            if cancel.load(Ordering::SeqCst) {
                child.kill();
                end = End::Killed("cancel");
                break None;
            }
            if started.elapsed() > deadline {
                child.kill();
                end = End::Killed("deadline");
                break None;
            }
            std::thread::sleep(Duration::from_millis(10));
        };

        if let Some(obs) = observer {
            obs.ended(&child);
        }
        let _ = writer.join();
        let stdout = reader.join().unwrap_or_default();
        let stderr = errors.join().unwrap_or_default();

        // The broker's verdicts take precedence over the exit. Revocation wins however the loop
        // ended: the owner may have ended the job just as the filter exited, so a cleared live
        // flag is `PermissionDenied` even if `try_wait` reported an exit first.
        if !live.load(Ordering::SeqCst) {
            return Err(C1Error::new(
                C1Code::PermissionDenied,
                "the filter's permission was revoked while it ran.",
            ));
        }
        // Output overflow is judged by the reader's own flag, not by how the wait loop ended: a
        // filter that floods and then exits before the loop notices must still be `OutputTooLarge`.
        if overflow.load(Ordering::SeqCst) {
            return Err(C1Error::new(
                C1Code::OutputTooLarge,
                format!(
                    "the filter produced more than the {} MiB allowed.",
                    MAX_STDOUT >> 20
                ),
            ));
        }
        match end {
            End::Killed("revoked") => Err(C1Error::new(
                C1Code::PermissionDenied,
                "the filter's permission was revoked while it ran.",
            )),
            End::Killed("deadline") => Err(C1Error::new(
                C1Code::Timeout,
                "the filter did not finish within its time limit.",
            )),
            End::Killed("cancel") => {
                Err(C1Error::new(C1Code::Cancelled, "the filter was cancelled."))
            }
            _ => Ok(C1Output {
                code,
                stdout,
                stderr,
                end,
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn profile(argv: Vec<Slot>) -> C1Profile {
        C1Profile {
            id: "probe",
            program: ProgramId {
                // Never reached by these tests: each is refused before the program is touched.
                path: PathBuf::from("C:/does/not/matter"),
                sha256: "00".repeat(32),
            },
            argv,
        }
    }

    fn broker(argv: Vec<Slot>) -> C1Broker {
        C1Broker::new(vec![profile(argv)])
    }

    fn cancel() -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(false))
    }

    // --- Argument injection (T6): no slot value can become a flag, path, or second argument -----

    #[test]
    fn an_enum_slot_takes_only_its_allowed_values() {
        let allowed: &[&str] = &["LLVM", "Google"];
        assert_eq!(
            build_argv(
                &[Slot::Enum {
                    prefix: "--style=",
                    allowed
                }],
                &[SlotValue::Enum("LLVM".into())],
            )
            .unwrap(),
            vec!["--style=LLVM"]
        );
        for evil in ["Mozilla", "LLVM --evil", "LLVM\0x", "", "LLVM\n--x"] {
            let e = build_argv(
                &[Slot::Enum {
                    prefix: "--style=",
                    allowed,
                }],
                &[SlotValue::Enum(evil.into())],
            )
            .unwrap_err();
            assert_eq!(e.code, C1Code::BadRequest, "{evil:?}");
        }
    }

    #[test]
    fn an_int_slot_stays_in_range() {
        let slot = Slot::Int {
            prefix: "--tab-width=",
            min: 1,
            max: 16,
        };
        assert_eq!(
            build_argv(std::slice::from_ref(&slot), &[SlotValue::Int(4)]).unwrap(),
            vec!["--tab-width=4"]
        );
        for n in [0, 17, -1, i64::MAX, i64::MIN] {
            let e = build_argv(std::slice::from_ref(&slot), &[SlotValue::Int(n)]).unwrap_err();
            assert_eq!(e.code, C1Code::BadRequest, "{n}");
        }
    }

    #[test]
    fn a_file_name_slot_is_a_bare_name_only() {
        let slot = Slot::FileName {
            prefix: "--assume-filename=",
        };
        assert_eq!(
            build_argv(
                std::slice::from_ref(&slot),
                &[SlotValue::FileName("main.c".into())]
            )
            .unwrap(),
            vec!["--assume-filename=main.c"]
        );
        for evil in [
            "../secret",
            "..",
            ".",
            "a/b",
            "a\\b",
            "C:\\x",
            "a:stream",
            "with space\"quote",
            "line\nbreak",
            "nul\0",
            "",
        ] {
            let e = build_argv(
                std::slice::from_ref(&slot),
                &[SlotValue::FileName(evil.into())],
            )
            .unwrap_err();
            assert_eq!(e.code, C1Code::BadRequest, "{evil:?}");
        }
    }

    #[test]
    fn the_slot_kind_and_count_must_match_the_profile() {
        // Wrong kind for the slot.
        let e = build_argv(&[Slot::Literal("--stdin")], &[SlotValue::Int(1)]).unwrap_err();
        assert_eq!(e.code, C1Code::BadRequest);
        // Wrong count.
        let e = build_argv(&[Slot::Literal("--stdin")], &[]).unwrap_err();
        assert_eq!(e.code, C1Code::BadRequest);
        let e = build_argv(&[], &[SlotValue::Fixed]).unwrap_err();
        assert_eq!(e.code, C1Code::BadRequest);
        // A literal is fixed: the caller contributes nothing.
        assert_eq!(
            build_argv(&[Slot::Literal("--stdin")], &[SlotValue::Fixed]).unwrap(),
            vec!["--stdin"]
        );
    }

    // --- Pre-flight refusals, before any process or program touch (cross-platform) --------------

    #[test]
    fn an_unknown_profile_is_refused() {
        let e = broker(vec![]).run("nope", &[], b"", cancel()).unwrap_err();
        assert_eq!(e.code, C1Code::UnknownProfile);
        assert_eq!(e.profile.as_deref(), Some("nope"));
    }

    #[test]
    fn input_past_the_bound_is_refused_before_launch() {
        let big = vec![b'x'; MAX_STDIN + 1];
        let e = broker(vec![])
            .run("probe", &[], &big, cancel())
            .unwrap_err();
        assert_eq!(e.code, C1Code::InputTooLarge);
    }

    #[test]
    fn a_bad_argument_is_refused_before_launch() {
        let b = broker(vec![Slot::Enum {
            prefix: "--style=",
            allowed: &["LLVM"],
        }]);
        let e = b
            .run("probe", &[SlotValue::Enum("evil".into())], b"", cancel())
            .unwrap_err();
        assert_eq!(e.code, C1Code::BadRequest);
        assert_eq!(e.profile.as_deref(), Some("probe"));
    }

    // --- Concurrency cap (T: resource exhaustion), deterministic, no processes ------------------

    #[test]
    fn the_concurrency_cap_holds_and_slots_are_returned() {
        let counter = AtomicU32::new(0);
        // Up to the cap succeeds.
        for _ in 0..MAX_CONCURRENT {
            assert!(try_acquire(&counter, MAX_CONCURRENT));
        }
        // One more is refused, and the counter did not grow past the cap.
        assert!(!try_acquire(&counter, MAX_CONCURRENT));
        assert_eq!(counter.load(Ordering::SeqCst), MAX_CONCURRENT);
        // Releasing one lets exactly one more in.
        counter.fetch_sub(1, Ordering::AcqRel);
        assert!(try_acquire(&counter, MAX_CONCURRENT));
        assert!(!try_acquire(&counter, MAX_CONCURRENT));
    }

    #[cfg(not(windows))]
    #[test]
    fn off_windows_every_run_fails_closed() {
        let e = broker(vec![]).run("probe", &[], b"", cancel()).unwrap_err();
        assert_eq!(e.code, C1Code::UnsupportedPlatform);
    }
}
