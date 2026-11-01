//! An operating-system sandbox for a process that runs untrusted code (EXT-10): the extension
//! host. What it is allowed is decided here, before the process runs a single instruction of its
//! own, and it holds nothing it was not given.
//!
//! **Windows** -- the platform Yavin ships and tests on:
//!
//! - an **AppContainer** with no capabilities: the process's token carries the container's SID,
//!   so it opens only what grants that SID or "ALL APPLICATION PACKAGES" -- the operating
//!   system's own files, its program (granted here, read and execute only) -- and none of the
//!   user's files, Yavin's data, other extensions' data or credentials; with no network
//!   capability, Windows refuses its connections (loopback included); it cannot open Yavin's or
//!   another process;
//! - its own **Job Object**: one process (it can start none), committed memory capped, CPU
//!   hard-capped, no access to the clipboard, desktop, global atoms or other processes' windows,
//!   and ended when Yavin's handle closes -- however Yavin ends;
//! - **mitigations**: no child processes (`PROCESS_CREATION_CHILD_PROCESS_RESTRICTED`), no
//!   Win32k system calls, no dynamic code, strict handle checks, no legacy extension points,
//!   no remote or low-integrity images, no non-system fonts;
//! - **nothing inherited** but its three pipes (`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`), an
//!   environment of `SystemRoot` alone, the Windows folder as its working folder;
//! - created **suspended**: in its job, with all of the above, before its first instruction.
//!
//! Any step that fails fails the start (`SandboxUnavailable`): there is no unsandboxed fallback.
//!
//! **Elsewhere** nothing is implemented, so nothing starts: `spawn` refuses.

use std::fs::File;
use std::path::{Path, PathBuf};

/// What a sandboxed process is allowed, beyond nothing.
#[derive(Clone, Debug, PartialEq)]
pub struct SandboxPolicy {
    /// The AppContainer's name (its profile, and the SID files are granted to): letters,
    /// digits, `.` and `-`, at most 64.
    pub container: String,
    /// The most memory the whole process may commit, in bytes (at least 16 MiB).
    pub memory_bytes: u64,
    /// Its CPU hard cap, in hundredths of a percent of the whole machine (1..=10000; 10000: no
    /// cap).
    pub cpu_rate: u32,
}

impl SandboxPolicy {
    pub fn validate(&self) -> Result<(), String> {
        let name_ok = (1..=64).contains(&self.container.len())
            && self
                .container
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-');
        if !name_ok {
            return Err(format!(
                "SandboxUnavailable: \"{}\" is not a sandbox name.",
                self.container
            ));
        }
        if self.memory_bytes < 16 << 20 {
            return Err("SandboxUnavailable: a sandbox needs at least 16 MiB of memory.".into());
        }
        if !(1..=10_000).contains(&self.cpu_rate) {
            return Err("SandboxUnavailable: the CPU limit is not between 0.01% and 100%.".into());
        }
        Ok(())
    }
}

/// The CPU rate (`SandboxPolicy::cpu_rate`) that is `cores` logical processors' worth of a
/// machine with `processors` of them -- the whole machine at most.
pub fn cpu_rate_for(cores: u32, processors: u32) -> u32 {
    let processors = processors.max(1);
    (cores.max(1).saturating_mul(10_000) / processors).clamp(1, 10_000)
}

/// Whether this platform can sandbox a process at all.
pub const SUPPORTED: bool = cfg!(windows);

/// A started sandboxed process, its pipes taken by the caller.
pub struct Spawned {
    pub child: SandboxedChild,
    pub stdin: File,
    pub stdout: File,
    pub stderr: File,
}

/// A sandboxed process. Dropping it ends it (its job is closed).
pub struct SandboxedChild {
    inner: imp::Child,
}

impl SandboxedChild {
    pub fn id(&self) -> u32 {
        self.inner.id()
    }

    /// Ends the process (and anything in its job). Idempotent.
    pub fn kill(&self) {
        self.inner.kill()
    }

    /// Its exit code once it has ended.
    pub fn try_wait(&self) -> std::io::Result<Option<i32>> {
        self.inner.try_wait()
    }

    /// The limits its job holds, as Windows reports them (for tests and diagnostics).
    #[cfg(windows)]
    pub fn job_limits(&self) -> Result<JobLimits, String> {
        self.inner.job_limits()
    }
}

/// What a sandbox's job enforces, read back from Windows.
#[cfg(windows)]
#[derive(Debug, Clone, PartialEq)]
pub struct JobLimits {
    pub active_processes: u32,
    pub memory_bytes: u64,
    pub cpu_rate: Option<u32>,
    pub kill_on_close: bool,
    pub ui_restricted: bool,
}

/// Starts `program` with `args` in a sandbox with `policy` (see the module). The caller speaks
/// to it through the three pipes.
pub fn spawn(program: &Path, args: &[&str], policy: &SandboxPolicy) -> Result<Spawned, String> {
    policy.validate()?;
    if args.iter().any(|arg| arg.contains('"')) {
        return Err("SandboxUnavailable: an argument holds a quotation mark.".into());
    }
    imp::spawn(program, args, policy)
}

/// EXT-33 (Q5 ACL foundation): grant the AppContainer `container`'s SID **read-only** access to
/// `folder` and its descendants, merged into the folder's existing DACL (other ACEs preserved).
/// This is the one ACL primitive a C2 server would need to read a workspace; it is read-only
/// (`FILE_GENERIC_READ`, inheritable), never write/execute/delete. It does **not** make the grant
/// safe on its own: the caller must first verify the tree has no outward reparse points and no
/// pre-existing ACE (e.g. `ALL APPLICATION PACKAGES`) that already grants the container write.
/// Not exposed to the renderer or extensions.
pub fn grant_read_tree(folder: &Path, container: &str) -> Result<(), String> {
    imp::grant_read_tree(folder, container)
}

/// Removes every ACE for `container`'s SID from `folder`'s DACL (allow and deny), preserving all
/// other entries. Idempotent: removing an absent grant is success.
pub fn revoke_read_tree(folder: &Path, container: &str) -> Result<(), String> {
    imp::revoke_read_tree(folder, container)
}

/// How many explicit ACEs on `folder`'s own DACL name `container`'s SID -- for verifying a grant
/// applied, and that revocation left **zero** residue.
pub fn container_aces(folder: &Path, container: &str) -> Result<usize, String> {
    imp::container_aces(folder, container)
}

/// EXT-33 (Q5): whether any allow ACE on `folder`'s DACL would grant **write** (or delete /
/// change-permissions / change-owner) to a SID the sandboxed process holds -- `container`'s own
/// SID, `ALL APPLICATION PACKAGES` (S-1-15-2-1), or `ALL RESTRICTED APPLICATION PACKAGES`
/// (S-1-15-2-2). A read-only grant cannot cancel such an ACE, so a caller must **refuse** the
/// grant when this is true: the read-only guarantee cannot be made on that folder.
pub fn container_writable(folder: &Path, container: &str) -> Result<bool, String> {
    imp::container_writable(folder, container)
}

/// EXT-33 (Q5, hard links): if `file` is a hard link whose object also has a name outside
/// `canonical_root`, that outside name; else `None`. Used to refuse a workspace whose files are
/// hard-linked to data outside it (where a grant's inherited ACE, applied to the shared object,
/// would expose that data to the container).
pub fn external_hard_link_name(file: &Path, canonical_root: &Path) -> Option<PathBuf> {
    imp::external_hard_link_name(file, canonical_root)
}

/// The string form (`S-1-15-2-…`) of the AppContainer SID derived from `container`'s name. The
/// derivation is deterministic, so this is the SID the sandbox token will carry **and** the SID the
/// workspace ACL is granted to -- used to prove those three agree. Not renderer-reachable.
pub fn container_sid_string(container: &str) -> Result<String, String> {
    imp::container_sid_string(container)
}

/// The AppContainer SID (string form) actually on `child`'s process token, or an error if the
/// process cannot be opened, its token read, or it is not an AppContainer. Lets a caller verify the
/// running server is in exactly the container whose name was derived and whose workspace ACL was
/// granted -- so a mismatch (a server not in its intended container) can be caught and killed.
pub fn process_container_sid(child: &SandboxedChild) -> Result<String, String> {
    imp::process_container_sid(&child.inner)
}

#[cfg(not(windows))]
mod imp {
    use super::*;

    pub enum Child {}

    impl Child {
        pub fn id(&self) -> u32 {
            match *self {}
        }
        pub fn kill(&self) {
            match *self {}
        }
        pub fn try_wait(&self) -> std::io::Result<Option<i32>> {
            match *self {}
        }
    }

    pub fn spawn(_: &Path, _: &[&str], _: &SandboxPolicy) -> Result<Spawned, String> {
        Err("SandboxUnavailable: extension code runs only where Yavin can sandbox it, and this platform has no sandbox implemented; extensions' themes and snippets still work.".into())
    }

    pub fn grant_read_tree(_: &Path, _: &str) -> Result<(), String> {
        Err("SandboxUnavailable: workspace ACL grants are a Windows mechanism.".into())
    }
    pub fn revoke_read_tree(_: &Path, _: &str) -> Result<(), String> {
        Err("SandboxUnavailable: workspace ACL grants are a Windows mechanism.".into())
    }
    pub fn container_aces(_: &Path, _: &str) -> Result<usize, String> {
        Ok(0)
    }
    pub fn container_writable(_: &Path, _: &str) -> Result<bool, String> {
        Ok(false)
    }
    pub fn external_hard_link_name(_: &Path, _: &Path) -> Option<std::path::PathBuf> {
        None
    }
    pub fn container_sid_string(_: &str) -> Result<String, String> {
        Err("SandboxUnavailable: AppContainer SIDs are a Windows mechanism.".into())
    }
    pub fn process_container_sid(_: &Child) -> Result<String, String> {
        Err("SandboxUnavailable: AppContainer SIDs are a Windows mechanism.".into())
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::path::PathBuf;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, LocalFree, SetHandleInformation, ERROR_ACCESS_DENIED,
        ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, HANDLE, HANDLE_FLAG_INHERIT,
        INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSidToSidW, GetExplicitEntriesFromAclW, GetNamedSecurityInfoW,
        SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W, GRANT_ACCESS,
        NO_MULTIPLE_TRUSTEE, REVOKE_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID,
        TRUSTEE_IS_WELL_KNOWN_GROUP, TRUSTEE_W,
    };
    use windows_sys::Win32::Security::Isolation::{
        CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
    };
    use windows_sys::Win32::Security::{
        EqualSid, FreeSid, ACL, CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, NO_INHERITANCE,
        OBJECT_INHERIT_ACE, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, SECURITY_CAPABILITIES,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FindClose, FindFirstFileNameW, FindNextFileNameW, GetFileInformationByHandle,
        GetVolumePathNameW, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicUIRestrictions,
        JobObjectCpuRateControlInformation, JobObjectExtendedLimitInformation,
        QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
        JOBOBJECT_BASIC_UI_RESTRICTIONS, JOBOBJECT_CPU_RATE_CONTROL_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_CPU_RATE_CONTROL_ENABLE,
        JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
        JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_JOB_MEMORY,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Pipes::CreatePipe;
    use windows_sys::Win32::System::SystemServices::JOB_OBJECT_UILIMIT_ALL;
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
        InitializeProcThreadAttributeList, ResumeThread, TerminateProcess,
        UpdateProcThreadAttribute, WaitForSingleObject, BELOW_NORMAL_PRIORITY_CLASS,
        CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, DETACHED_PROCESS,
        EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION,
        PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
        STARTF_USESTDHANDLES, STARTUPINFOEXW,
    };
    use windows_sys::Win32::System::WindowsProgramming::PROCESS_CREATION_CHILD_PROCESS_RESTRICTED;

    /// Process mitigations (winnt.h `PROCESS_CREATION_MITIGATION_POLICY_*_ALWAYS_ON`; not in
    /// windows-sys 0.59). The sandbox tests read each back from inside the process.
    const STRICT_HANDLE_CHECKS: u64 = 1 << 24;
    const WIN32K_SYSTEM_CALL_DISABLE: u64 = 1 << 28;
    const EXTENSION_POINT_DISABLE: u64 = 1 << 32;
    const PROHIBIT_DYNAMIC_CODE: u64 = 1 << 36;
    const FONT_DISABLE: u64 = 1 << 48;
    const IMAGE_LOAD_NO_REMOTE: u64 = 1 << 52;
    const IMAGE_LOAD_NO_LOW_LABEL: u64 = 1 << 56;
    pub(super) const MITIGATIONS: u64 = STRICT_HANDLE_CHECKS
        | WIN32K_SYSTEM_CALL_DISABLE
        | EXTENSION_POINT_DISABLE
        | PROHIBIT_DYNAMIC_CODE
        | FONT_DISABLE
        | IMAGE_LOAD_NO_REMOTE
        | IMAGE_LOAD_NO_LOW_LABEL;

    /// `HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)`.
    const ALREADY_EXISTS: i32 = 0x800700B7u32 as i32;

    fn wide(text: &OsStr) -> Vec<u16> {
        text.encode_wide().chain(std::iter::once(0)).collect()
    }

    fn unavailable(what: &str) -> String {
        // SAFETY: reads this thread's last error, nothing else.
        let code = unsafe { GetLastError() };
        format!("SandboxUnavailable: {what} (Windows error {code}).")
    }

    /// An owned handle that may be null-checked; closed once.
    fn owned(handle: HANDLE) -> OwnedHandle {
        // SAFETY: `handle` was just returned to this process by Windows and is owned here.
        unsafe { OwnedHandle::from_raw_handle(handle as _) }
    }

    /// The AppContainer's SID, freed on drop.
    struct Sid(PSID);

    impl Drop for Sid {
        fn drop(&mut self) {
            // SAFETY: the SID came from Create/DeriveAppContainer..., which say to FreeSid it.
            unsafe {
                FreeSid(self.0);
            }
        }
    }

    fn container_sid(name: &str) -> Result<Sid, String> {
        // One at a time: Windows fails a profile created twice at once (E_UNEXPECTED).
        static CREATING: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _one = CREATING.lock().unwrap_or_else(|p| p.into_inner());
        let name = wide(OsStr::new(name));
        let description = wide(OsStr::new("Yavin: a process that runs extensions' code"));
        let mut sid: PSID = null_mut();
        // SAFETY: the strings are NUL-terminated and live for the call; `sid` is written once.
        let mut result = unsafe {
            CreateAppContainerProfile(
                name.as_ptr(),
                name.as_ptr(),
                description.as_ptr(),
                null(),
                0,
                &mut sid,
            )
        };
        if result == ALREADY_EXISTS {
            // SAFETY: as above.
            result = unsafe { DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut sid) };
        }
        if result < 0 || sid.is_null() {
            return Err(format!(
                "SandboxUnavailable: its AppContainer could not be created (0x{:08x}).",
                result as u32
            ));
        }
        Ok(Sid(sid))
    }

    /// The string form (`S-1-15-2-…`) of a SID. The buffer Windows allocates is freed before return.
    fn sid_to_string(sid: PSID) -> Result<String, String> {
        use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
        let mut out: *mut u16 = null_mut();
        // SAFETY: `sid` is a valid SID; on success `out` is a LocalAlloc'd string we free below.
        let ok = unsafe { ConvertSidToStringSidW(sid, &mut out) };
        if ok == 0 || out.is_null() {
            return Err("SandboxUnavailable: a SID could not be formatted.".into());
        }
        // SAFETY: `out` is a NUL-terminated wide string owned here until LocalFree.
        let text = unsafe {
            let mut len = 0usize;
            while *out.add(len) != 0 {
                len += 1;
            }
            let slice = std::slice::from_raw_parts(out, len);
            let s = String::from_utf16_lossy(slice);
            LocalFree(out as _);
            s
        };
        Ok(text)
    }

    pub fn container_sid_string(container: &str) -> Result<String, String> {
        let sid = container_sid(container)?;
        sid_to_string(sid.0)
    }

    pub fn process_container_sid(child: &Child) -> Result<String, String> {
        use windows_sys::Win32::Security::{
            GetTokenInformation, TokenAppContainerSid, TOKEN_APPCONTAINER_INFORMATION, TOKEN_QUERY,
        };
        use windows_sys::Win32::System::Threading::{
            OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        let pid = child.id();
        // SAFETY: open the child for a token query, read its AppContainer SID, free every handle.
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return Err("the server process could not be opened for a token query.".into());
            }
            let mut token: HANDLE = null_mut();
            if OpenProcessToken(process, TOKEN_QUERY, &mut token) == 0 {
                CloseHandle(process);
                return Err("the server token could not be opened.".into());
            }
            // First call sizes the buffer; AppContainer SID length varies.
            let mut size = 0u32;
            GetTokenInformation(token, TokenAppContainerSid, null_mut(), 0, &mut size);
            let result = if size == 0 {
                Err("the server carries no AppContainer SID (not contained).".into())
            } else {
                let mut buf = vec![0u8; size as usize];
                if GetTokenInformation(
                    token,
                    TokenAppContainerSid,
                    buf.as_mut_ptr() as _,
                    size,
                    &mut size,
                ) != 0
                {
                    let info = &*(buf.as_ptr() as *const TOKEN_APPCONTAINER_INFORMATION);
                    if info.TokenAppContainer.is_null() {
                        Err("the server is not in an AppContainer.".into())
                    } else {
                        sid_to_string(info.TokenAppContainer)
                    }
                } else {
                    Err("the server token's AppContainer SID could not be read.".into())
                }
            };
            CloseHandle(token);
            CloseHandle(process);
            result
        }
    }

    /// Grants the container read and execute on `program` (the file alone), once per run. A
    /// file the user may not change (an installation in Program Files) already grants all
    /// application packages that; whether it can be run is the start's to find out.
    fn grant_program(program: &Path, sid: &Sid) {
        use std::sync::{Mutex, OnceLock};
        static GRANTED: OnceLock<Mutex<std::collections::HashSet<std::path::PathBuf>>> =
            OnceLock::new();
        let granted = GRANTED.get_or_init(Default::default);
        let mut granted = granted.lock().unwrap_or_else(|p| p.into_inner());
        if granted.contains(program) {
            return;
        }
        let path = wide(program.as_os_str());
        // SAFETY: Win32 security calls on a NUL-terminated path; every buffer Windows returns
        // is freed with LocalFree; the SID outlives the calls.
        unsafe {
            let mut dacl: *mut ACL = null_mut();
            let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
            if GetNamedSecurityInfoW(
                path.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut descriptor,
            ) != 0
            {
                return;
            }
            let access = EXPLICIT_ACCESS_W {
                grfAccessPermissions: FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
                grfAccessMode: GRANT_ACCESS,
                grfInheritance: NO_INHERITANCE,
                Trustee: TRUSTEE_W {
                    pMultipleTrustee: null_mut(),
                    MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                    TrusteeForm: TRUSTEE_IS_SID,
                    TrusteeType: TRUSTEE_IS_WELL_KNOWN_GROUP,
                    ptstrName: sid.0 as _,
                },
            };
            let mut merged: *mut ACL = null_mut();
            if SetEntriesInAclW(1, &access, dacl, &mut merged) == 0 {
                if SetNamedSecurityInfoW(
                    path.as_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    merged,
                    null(),
                ) == 0
                {
                    granted.insert(program.to_path_buf());
                }
                LocalFree(merged as _);
            }
            LocalFree(descriptor as _);
        }
    }

    /// EXT-33 (Q5): add one inheritable, read-only ACE for `container`'s SID to `folder`'s DACL,
    /// merged with the existing entries (nothing else is changed). Read-only = `FILE_GENERIC_READ`
    /// alone: no `FILE_WRITE_DATA`, `FILE_APPEND_DATA`, `DELETE`, `WRITE_DAC` or `WRITE_OWNER`.
    pub fn grant_read_tree(folder: &Path, container: &str) -> Result<(), String> {
        let sid = container_sid(container)?;
        let path = wide(folder.as_os_str());
        // SAFETY: Win32 security calls on a NUL-terminated path; buffers Windows returns are freed;
        // the SID outlives the calls.
        unsafe {
            let mut dacl: *mut ACL = null_mut();
            let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
            if GetNamedSecurityInfoW(
                path.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut descriptor,
            ) != 0
            {
                return Err(
                    "SandboxUnavailable: the folder's permissions could not be read.".into(),
                );
            }
            let access = EXPLICIT_ACCESS_W {
                grfAccessPermissions: FILE_GENERIC_READ,
                grfAccessMode: GRANT_ACCESS,
                grfInheritance: CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE,
                Trustee: TRUSTEE_W {
                    pMultipleTrustee: null_mut(),
                    MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                    TrusteeForm: TRUSTEE_IS_SID,
                    TrusteeType: TRUSTEE_IS_WELL_KNOWN_GROUP,
                    ptstrName: sid.0 as _,
                },
            };
            let mut merged: *mut ACL = null_mut();
            let built = SetEntriesInAclW(1, &access, dacl, &mut merged);
            let result = if built == 0 {
                let applied = SetNamedSecurityInfoW(
                    path.as_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    merged,
                    null(),
                );
                if applied == 0 {
                    Ok(())
                } else {
                    Err(format!(
                        "SandboxUnavailable: the read grant could not be applied (0x{applied:08x})."
                    ))
                }
            } else {
                Err(format!(
                    "SandboxUnavailable: the read grant could not be built (0x{built:08x})."
                ))
            };
            if !merged.is_null() {
                LocalFree(merged as _);
            }
            LocalFree(descriptor as _);
            result
        }
    }

    /// EXT-33 (Q5): remove every ACE for `container`'s SID from `folder`'s DACL, preserving all
    /// others. `REVOKE_ACCESS` removes the trustee's allow and deny ACEs alike.
    pub fn revoke_read_tree(folder: &Path, container: &str) -> Result<(), String> {
        let sid = container_sid(container)?;
        let path = wide(folder.as_os_str());
        // SAFETY: as `grant_read_tree`.
        unsafe {
            let mut dacl: *mut ACL = null_mut();
            let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
            if GetNamedSecurityInfoW(
                path.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut descriptor,
            ) != 0
            {
                return Err(
                    "SandboxUnavailable: the folder's permissions could not be read.".into(),
                );
            }
            let access = EXPLICIT_ACCESS_W {
                grfAccessPermissions: 0,
                grfAccessMode: REVOKE_ACCESS,
                grfInheritance: NO_INHERITANCE,
                Trustee: TRUSTEE_W {
                    pMultipleTrustee: null_mut(),
                    MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                    TrusteeForm: TRUSTEE_IS_SID,
                    TrusteeType: TRUSTEE_IS_WELL_KNOWN_GROUP,
                    ptstrName: sid.0 as _,
                },
            };
            let mut merged: *mut ACL = null_mut();
            let built = SetEntriesInAclW(1, &access, dacl, &mut merged);
            let result = if built == 0 {
                let applied = SetNamedSecurityInfoW(
                    path.as_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    merged,
                    null(),
                );
                if applied == 0 {
                    Ok(())
                } else {
                    Err(format!(
                        "SandboxUnavailable: the read grant could not be removed (0x{applied:08x})."
                    ))
                }
            } else {
                Err(format!(
                    "SandboxUnavailable: the removal could not be built (0x{built:08x})."
                ))
            };
            if !merged.is_null() {
                LocalFree(merged as _);
            }
            LocalFree(descriptor as _);
            result
        }
    }

    /// EXT-33 (Q5): how many explicit ACEs on `folder`'s own DACL name `container`'s SID.
    pub fn container_aces(folder: &Path, container: &str) -> Result<usize, String> {
        let sid = container_sid(container)?;
        let path = wide(folder.as_os_str());
        // SAFETY: as above; the entries array Windows allocates is freed with LocalFree.
        unsafe {
            let mut dacl: *mut ACL = null_mut();
            let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
            if GetNamedSecurityInfoW(
                path.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut descriptor,
            ) != 0
            {
                return Err(
                    "SandboxUnavailable: the folder's permissions could not be read.".into(),
                );
            }
            let mut count: u32 = 0;
            let mut entries: *mut EXPLICIT_ACCESS_W = null_mut();
            let mut found = 0usize;
            if GetExplicitEntriesFromAclW(dacl, &mut count, &mut entries) == 0 && !entries.is_null()
            {
                for i in 0..count as isize {
                    let entry = &*entries.offset(i);
                    if entry.Trustee.TrusteeForm == TRUSTEE_IS_SID {
                        let trustee = entry.Trustee.ptstrName as PSID;
                        if !trustee.is_null() && EqualSid(trustee, sid.0) != 0 {
                            found += 1;
                        }
                    }
                }
                LocalFree(entries as _);
            }
            LocalFree(descriptor as _);
            Ok(found)
        }
    }

    /// Access bits that mean "can change the folder/files": write, append, write-EA,
    /// write-attributes, delete, change-permissions, change-owner, and the generic forms.
    const WRITE_MASK: u32 = 0x0002 // FILE_WRITE_DATA / FILE_ADD_FILE
        | 0x0004 // FILE_APPEND_DATA / FILE_ADD_SUBDIRECTORY
        | 0x0010 // FILE_WRITE_EA
        | 0x0100 // FILE_WRITE_ATTRIBUTES
        | 0x0001_0000 // DELETE
        | 0x0004_0000 // WRITE_DAC
        | 0x0008_0000 // WRITE_OWNER
        | 0x4000_0000 // GENERIC_WRITE
        | 0x1000_0000; // GENERIC_ALL

    /// Resolves a string SID (freed with LocalFree); `None` if it cannot be parsed.
    unsafe fn string_sid(text: &str) -> Option<PSID> {
        let wide = wide(OsStr::new(text));
        let mut sid: PSID = null_mut();
        if ConvertStringSidToSidW(wide.as_ptr(), &mut sid) != 0 && !sid.is_null() {
            Some(sid)
        } else {
            None
        }
    }

    pub fn container_writable(folder: &Path, container: &str) -> Result<bool, String> {
        let sid = container_sid(container)?;
        let path = wide(folder.as_os_str());
        // SAFETY: Win32 security calls; allocated buffers are freed with LocalFree.
        unsafe {
            let aap = string_sid("S-1-15-2-1"); // ALL APPLICATION PACKAGES
            let arap = string_sid("S-1-15-2-2"); // ALL RESTRICTED APPLICATION PACKAGES
            let dangerous = |t: PSID| {
                EqualSid(t, sid.0) != 0
                    || aap.is_some_and(|a| EqualSid(t, a) != 0)
                    || arap.is_some_and(|a| EqualSid(t, a) != 0)
            };
            let mut dacl: *mut ACL = null_mut();
            let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
            let mut writable = false;
            if GetNamedSecurityInfoW(
                path.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut descriptor,
            ) == 0
            {
                let mut count: u32 = 0;
                let mut entries: *mut EXPLICIT_ACCESS_W = null_mut();
                if GetExplicitEntriesFromAclW(dacl, &mut count, &mut entries) == 0
                    && !entries.is_null()
                {
                    for i in 0..count as isize {
                        let entry = &*entries.offset(i);
                        let grants = entry.grfAccessMode == GRANT_ACCESS;
                        let writes = entry.grfAccessPermissions & WRITE_MASK != 0;
                        if grants && writes && entry.Trustee.TrusteeForm == TRUSTEE_IS_SID {
                            let trustee = entry.Trustee.ptstrName as PSID;
                            if !trustee.is_null() && dangerous(trustee) {
                                writable = true;
                                break;
                            }
                        }
                    }
                    LocalFree(entries as _);
                }
                LocalFree(descriptor as _);
            } else {
                // Could not read the DACL: fail closed -- treat as writable so the grant is refused.
                writable = true;
            }
            if let Some(a) = aap {
                LocalFree(a as _);
            }
            if let Some(a) = arap {
                LocalFree(a as _);
            }
            Ok(writable)
        }
    }

    /// EXT-33 (Q5, hard links): if `file` has more than one hard link and any of its names is
    /// outside `canonical_root`, that outside name; else `None`. Hard links are same-volume only,
    /// so `FindFirstFileNameW` enumerates every name. A file that cannot be opened or queried is
    /// skipped (`None`): it is not readable to the container either.
    pub fn external_hard_link_name(file: &Path, canonical_root: &Path) -> Option<PathBuf> {
        let wide_file = wide(file.as_os_str());
        // SAFETY: Win32 file calls on NUL-terminated paths; the handle is closed; buffers owned.
        unsafe {
            let handle = CreateFileW(
                wide_file.as_ptr(),
                FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                null_mut(),
            );
            if handle == INVALID_HANDLE_VALUE || handle.is_null() {
                return None;
            }
            let mut info: BY_HANDLE_FILE_INFORMATION = std::mem::zeroed();
            let got = GetFileInformationByHandle(handle, &mut info) != 0;
            CloseHandle(handle);
            if !got || info.nNumberOfLinks <= 1 {
                return None;
            }
            // The drive (e.g. `D:`) to prepend to each volume-relative link name.
            let mut volume = [0u16; 260];
            if GetVolumePathNameW(wide_file.as_ptr(), volume.as_mut_ptr(), volume.len() as u32) == 0
            {
                return None;
            }
            let drive: String = {
                let v = String::from_utf16_lossy(
                    &volume[..volume.iter().position(|&c| c == 0).unwrap_or(0)],
                );
                v.trim_end_matches('\\').to_string()
            };
            let mut buf = vec![0u16; 1024];
            let mut len = buf.len() as u32;
            let find = FindFirstFileNameW(wide_file.as_ptr(), 0, &mut len, buf.as_mut_ptr());
            if find == INVALID_HANDLE_VALUE || find.is_null() {
                return None;
            }
            let mut external = None;
            loop {
                let name = String::from_utf16_lossy(&buf[..len.saturating_sub(1) as usize]);
                let full = PathBuf::from(format!("{drive}{name}"));
                let inside = std::fs::canonicalize(&full)
                    .map(|c| {
                        let text = c.to_string_lossy();
                        let stripped = text.strip_prefix(r"\\?\").unwrap_or(&text).to_string();
                        PathBuf::from(stripped).starts_with(canonical_root)
                    })
                    .unwrap_or(false);
                if !inside {
                    external = Some(full);
                    break;
                }
                len = buf.len() as u32;
                if FindNextFileNameW(find, &mut len, buf.as_mut_ptr()) == 0 {
                    break;
                }
            }
            FindClose(find);
            external
        }
    }

    /// A job with the sandbox's limits; its processes end when it is closed.
    struct Job(OwnedHandle);

    impl Job {
        fn new(policy: &SandboxPolicy) -> Result<Job, String> {
            // SAFETY: plain Win32 calls on a handle owned here; each structure is zeroed, then
            // given its limits, and outlives its call.
            unsafe {
                let handle = CreateJobObjectW(null(), null());
                if handle.is_null() {
                    return Err(unavailable("its job object could not be created"));
                }
                let job = Job(owned(handle));
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                    | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
                    | JOB_OBJECT_LIMIT_JOB_MEMORY
                    | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
                limits.BasicLimitInformation.ActiveProcessLimit = 1;
                limits.JobMemoryLimit = policy.memory_bytes as usize;
                if SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as _,
                    std::mem::size_of_val(&limits) as u32,
                ) == 0
                {
                    return Err(unavailable("its job's limits could not be set"));
                }
                let ui = JOBOBJECT_BASIC_UI_RESTRICTIONS {
                    UIRestrictionsClass: JOB_OBJECT_UILIMIT_ALL,
                };
                if SetInformationJobObject(
                    handle,
                    JobObjectBasicUIRestrictions,
                    &ui as *const _ as _,
                    std::mem::size_of_val(&ui) as u32,
                ) == 0
                {
                    return Err(unavailable("its job's UI restrictions could not be set"));
                }
                if policy.cpu_rate < 10_000 {
                    let mut cpu: JOBOBJECT_CPU_RATE_CONTROL_INFORMATION = std::mem::zeroed();
                    cpu.ControlFlags =
                        JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP;
                    cpu.Anonymous.CpuRate = policy.cpu_rate;
                    if SetInformationJobObject(
                        handle,
                        JobObjectCpuRateControlInformation,
                        &cpu as *const _ as _,
                        std::mem::size_of_val(&cpu) as u32,
                    ) == 0
                    {
                        return Err(unavailable("its job's CPU limit could not be set"));
                    }
                }
                Ok(job)
            }
        }

        fn raw(&self) -> HANDLE {
            self.0.as_raw_handle() as HANDLE
        }
    }

    pub struct Child {
        process: OwnedHandle,
        job: Job,
        pid: u32,
    }

    // The handles may be used from any thread.
    unsafe impl Send for Child {}
    unsafe impl Sync for Child {}

    impl Child {
        pub fn id(&self) -> u32 {
            self.pid
        }

        pub fn kill(&self) {
            // SAFETY: the job's handle is owned by `self` and live.
            unsafe {
                TerminateJobObject(self.job.raw(), 1);
            }
        }

        pub fn try_wait(&self) -> std::io::Result<Option<i32>> {
            let process = self.process.as_raw_handle() as HANDLE;
            // SAFETY: the process handle is owned by `self` and live.
            unsafe {
                if WaitForSingleObject(process, 0) != WAIT_OBJECT_0 {
                    return Ok(None);
                }
                let mut code = 0u32;
                if GetExitCodeProcess(process, &mut code) == 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(Some(code as i32))
            }
        }

        pub fn job_limits(&self) -> Result<JobLimits, String> {
            // SAFETY: queries into zeroed structures of the size given, on a live handle.
            unsafe {
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                let mut ui: JOBOBJECT_BASIC_UI_RESTRICTIONS = std::mem::zeroed();
                let mut cpu: JOBOBJECT_CPU_RATE_CONTROL_INFORMATION = std::mem::zeroed();
                for (class, buffer, size) in [
                    (
                        JobObjectExtendedLimitInformation,
                        &mut limits as *mut _ as *mut core::ffi::c_void,
                        std::mem::size_of_val(&limits),
                    ),
                    (
                        JobObjectBasicUIRestrictions,
                        &mut ui as *mut _ as _,
                        std::mem::size_of_val(&ui),
                    ),
                    (
                        JobObjectCpuRateControlInformation,
                        &mut cpu as *mut _ as _,
                        std::mem::size_of_val(&cpu),
                    ),
                ] {
                    if QueryInformationJobObject(
                        self.job.raw(),
                        class,
                        buffer,
                        size as u32,
                        null_mut(),
                    ) == 0
                    {
                        return Err(unavailable("its job could not be read"));
                    }
                }
                let flags = limits.BasicLimitInformation.LimitFlags;
                Ok(JobLimits {
                    active_processes: if flags & JOB_OBJECT_LIMIT_ACTIVE_PROCESS != 0 {
                        limits.BasicLimitInformation.ActiveProcessLimit
                    } else {
                        u32::MAX
                    },
                    memory_bytes: if flags & JOB_OBJECT_LIMIT_JOB_MEMORY != 0 {
                        limits.JobMemoryLimit as u64
                    } else {
                        u64::MAX
                    },
                    cpu_rate: (cpu.ControlFlags & JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP != 0)
                        .then_some(cpu.Anonymous.CpuRate),
                    kill_on_close: flags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE != 0,
                    ui_restricted: ui.UIRestrictionsClass & JOB_OBJECT_UILIMIT_ALL
                        == JOB_OBJECT_UILIMIT_ALL,
                })
            }
        }
    }

    /// A pipe: the end kept here (never inheritable) and the child's end.
    fn pipe(child_reads: bool) -> Result<(OwnedHandle, OwnedHandle), String> {
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: null_mut(),
            bInheritHandle: 0,
        };
        let (mut read, mut write): (HANDLE, HANDLE) = (null_mut(), null_mut());
        // SAFETY: both handles are written by the call and owned here at once.
        if unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) } == 0 {
            return Err(unavailable("its pipes could not be created"));
        }
        let (read, write) = (owned(read), owned(write));
        Ok(if child_reads {
            (write, read)
        } else {
            (read, write)
        })
    }

    fn set_inheritable(handles: &[HANDLE], inheritable: bool) -> bool {
        handles.iter().all(|&handle| {
            // SAFETY: each handle is a live pipe end owned by the caller.
            unsafe {
                SetHandleInformation(
                    handle,
                    HANDLE_FLAG_INHERIT,
                    inheritable as u32 * HANDLE_FLAG_INHERIT,
                ) != 0
            }
        })
    }

    /// The attribute list the process is created with, freed on drop.
    struct Attributes {
        buffer: Vec<usize>,
    }

    impl Attributes {
        fn new(count: u32) -> Result<Attributes, String> {
            let mut size = 0usize;
            // SAFETY: the first call only reports the size needed.
            unsafe { InitializeProcThreadAttributeList(null_mut(), count, 0, &mut size) };
            let mut buffer = vec![0usize; size.div_ceil(std::mem::size_of::<usize>()) + 1];
            // SAFETY: the buffer is at least `size` bytes and aligned for a pointer.
            if unsafe {
                InitializeProcThreadAttributeList(buffer.as_mut_ptr() as _, count, 0, &mut size)
            } == 0
            {
                return Err(unavailable("its process attributes could not be prepared"));
            }
            Ok(Attributes { buffer })
        }

        fn list(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
            self.buffer.as_mut_ptr() as _
        }

        /// Sets `attribute` to the `size` bytes at `value`, which must outlive the list's use.
        fn set(
            &mut self,
            attribute: u32,
            value: *const core::ffi::c_void,
            size: usize,
            what: &str,
        ) -> Result<(), String> {
            // SAFETY: the list was initialized; the caller keeps `value` alive until the
            // process is created.
            if unsafe {
                UpdateProcThreadAttribute(
                    self.list(),
                    0,
                    attribute as usize,
                    value,
                    size,
                    null_mut(),
                    null(),
                )
            } == 0
            {
                return Err(unavailable(what));
            }
            Ok(())
        }
    }

    impl Drop for Attributes {
        fn drop(&mut self) {
            // SAFETY: the list was initialized by `new`.
            unsafe { DeleteProcThreadAttributeList(self.list()) };
        }
    }

    pub fn spawn(program: &Path, args: &[&str], policy: &SandboxPolicy) -> Result<Spawned, String> {
        if !program.is_file() {
            return Err(format!("{} was not found.", program.display()));
        }
        let program = &std::fs::canonicalize(program)
            .map(|path| {
                // Without the `\\?\` prefix: what is granted, run and reported is a plain path.
                let text = path.to_string_lossy().into_owned();
                std::path::PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(&text).to_string())
            })
            .map_err(|e| format!("{} could not be read: {e}", program.display()))?;
        let sid = container_sid(&policy.container)?;
        grant_program(program, &sid);
        let job = Job::new(policy)?;

        let (stdin, child_stdin) = pipe(true)?;
        let (stdout, child_stdout) = pipe(false)?;
        let (stderr, child_stderr) = pipe(false)?;
        let inherited = [
            child_stdin.as_raw_handle() as HANDLE,
            child_stdout.as_raw_handle() as HANDLE,
            child_stderr.as_raw_handle() as HANDLE,
        ];

        let mut attributes = Attributes::new(4)?;
        let capabilities = SECURITY_CAPABILITIES {
            AppContainerSid: sid.0,
            Capabilities: null_mut(),
            CapabilityCount: 0,
            Reserved: 0,
        };
        attributes.set(
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
            &capabilities as *const _ as _,
            std::mem::size_of_val(&capabilities),
            "its AppContainer could not be set",
        )?;
        attributes.set(
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
            inherited.as_ptr() as _,
            std::mem::size_of_val(&inherited),
            "the handles it inherits could not be limited",
        )?;
        let child_policy: u32 = PROCESS_CREATION_CHILD_PROCESS_RESTRICTED;
        attributes.set(
            PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY,
            &child_policy as *const u32 as _,
            std::mem::size_of_val(&child_policy),
            "child processes could not be refused",
        )?;
        let mitigations: u64 = MITIGATIONS;
        attributes.set(
            PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY,
            &mitigations as *const u64 as _,
            std::mem::size_of_val(&mitigations),
            "its mitigations could not be set",
        )?;

        // What it is given of Yavin's world: the Windows folder's name, and `LOCALAPPDATA` --
        // which Windows requires to create an AppContainer process (without it: error 203) and
        // replaces, as it adds `TEMP` and `TMP`, with the container's own folder. Nothing else
        // of Yavin's environment (tokens, paths, the user's folders) reaches it.
        let root = std::env::var_os("SystemRoot")
            .filter(|root| Path::new(root).is_absolute())
            .unwrap_or_else(|| "C:\\Windows".into());
        let local = std::env::var_os("LOCALAPPDATA")
            .filter(|local| Path::new(local).is_absolute())
            .ok_or("SandboxUnavailable: LOCALAPPDATA is not set, so Windows cannot create its AppContainer.")?;
        let mut environment: Vec<u16> = Vec::new();
        let variables: [(&str, &std::ffi::OsStr); 2] =
            [("LOCALAPPDATA", &local), ("SystemRoot", &root)];
        for (name, value) in variables {
            environment.extend(OsStr::new(name).encode_wide());
            environment.push(b'=' as u16);
            environment.extend(value.encode_wide());
            environment.push(0);
        }
        environment.push(0);
        let folder = wide(&root);
        let application = wide(program.as_os_str());
        let mut command_line: Vec<u16> = std::iter::once(format!("\"{}\"", program.display()))
            .chain(args.iter().map(|arg| format!("\"{arg}\"")))
            .collect::<Vec<_>>()
            .join(" ")
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();

        // SAFETY: a zeroed STARTUPINFOEXW given its size, flags, the child's pipe ends and the
        // attribute list -- all alive until CreateProcessW returns.
        let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
        startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = inherited[0];
        startup.StartupInfo.hStdOutput = inherited[1];
        startup.StartupInfo.hStdError = inherited[2];
        startup.lpAttributeList = attributes.list();
        // SAFETY: zeroed output structure.
        let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };

        // Inheritable only for this call, and only these three (the handle list): a process
        // another thread starts meanwhile could inherit them, never Yavin's other handles.
        if !set_inheritable(&inherited, true) {
            return Err(unavailable("its pipes could not be handed over"));
        }
        // SAFETY: every pointer is to a live, NUL-terminated buffer or structure above.
        let created = unsafe {
            CreateProcessW(
                application.as_ptr(),
                command_line.as_mut_ptr(),
                null(),
                null(),
                1,
                EXTENDED_STARTUPINFO_PRESENT
                    | CREATE_SUSPENDED
                    | DETACHED_PROCESS
                    | CREATE_UNICODE_ENVIRONMENT
                    | BELOW_NORMAL_PRIORITY_CLASS,
                environment.as_ptr() as _,
                folder.as_ptr(),
                &startup.StartupInfo,
                &mut info,
            )
        };
        // SAFETY: reads this thread's last error before anything else can change it.
        let error = unsafe { GetLastError() };
        set_inheritable(&inherited, false);
        drop(attributes);
        if created == 0 {
            return Err(match error {
                ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => format!(
                    "SandboxUnavailable: {} could not be started from its sandbox (Windows error {error}).",
                    program.display()
                ),
                ERROR_ACCESS_DENIED => format!(
                    "SandboxUnavailable: {} cannot be run from its sandbox: it is not readable there (Windows error 5). Reinstall Yavin.",
                    program.display()
                ),
                code => format!(
                    "SandboxUnavailable: the sandboxed process could not be created (Windows error {code})."
                ),
            });
        }
        let process = owned(info.hProcess);
        let thread = owned(info.hThread);
        // In its job before its first instruction; if it cannot be, it never runs.
        // SAFETY: the job and the (suspended) process handles are live and owned here.
        if unsafe { AssignProcessToJobObject(job.raw(), info.hProcess) } == 0 {
            let message = unavailable("it could not be put in its job");
            // SAFETY: the process is suspended and owned here.
            unsafe { TerminateProcess(info.hProcess, 1) };
            return Err(message);
        }
        // SAFETY: the thread handle is live; resuming a thread created suspended.
        if unsafe { ResumeThread(thread.as_raw_handle() as HANDLE) } == u32::MAX {
            let message = unavailable("it could not be started");
            // SAFETY: the job is owned here.
            unsafe { TerminateJobObject(job.raw(), 1) };
            return Err(message);
        }
        drop(thread);
        // The child's ends are its own now: closed here, so its exit closes the pipes.
        drop((child_stdin, child_stdout, child_stderr));
        Ok(Spawned {
            child: SandboxedChild {
                inner: Child {
                    process,
                    job,
                    pid: info.dwProcessId,
                },
            },
            stdin: File::from(stdin),
            stdout: File::from(stdout),
            stderr: File::from(stderr),
        })
    }
}

/// The mitigations a sandboxed process is created with (Windows), for its tests to compare
/// with what the process reads back.
#[cfg(windows)]
pub const MITIGATIONS: u64 = imp::MITIGATIONS;

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> SandboxPolicy {
        SandboxPolicy {
            container: "Yavin.Test".into(),
            memory_bytes: 256 << 20,
            cpu_rate: 5_000,
        }
    }

    #[test]
    fn a_policy_is_validated_before_anything_is_created() {
        assert!(policy().validate().is_ok());
        for bad in [
            SandboxPolicy {
                container: String::new(),
                ..policy()
            },
            SandboxPolicy {
                container: "has space".into(),
                ..policy()
            },
            SandboxPolicy {
                container: "x".repeat(65),
                ..policy()
            },
            SandboxPolicy {
                memory_bytes: 1 << 20,
                ..policy()
            },
            SandboxPolicy {
                cpu_rate: 0,
                ..policy()
            },
            SandboxPolicy {
                cpu_rate: 10_001,
                ..policy()
            },
        ] {
            let error = bad.validate().unwrap_err();
            assert!(error.starts_with("SandboxUnavailable"), "{error}");
            let spawned = spawn(Path::new("C:/Windows/System32/whoami.exe"), &[], &bad);
            assert!(spawned.is_err());
        }
    }

    #[test]
    fn a_cpu_cap_is_whole_processors_of_the_machine() {
        assert_eq!(cpu_rate_for(1, 4), 2_500);
        assert_eq!(cpu_rate_for(1, 1), 10_000);
        assert_eq!(cpu_rate_for(8, 4), 10_000);
        assert_eq!(cpu_rate_for(0, 0), 10_000);
        assert_eq!(cpu_rate_for(1, 64), 156);
    }

    #[test]
    fn a_quoted_argument_is_refused() {
        let error = spawn(Path::new("C:/x.exe"), &["a\"b"], &policy())
            .err()
            .unwrap();
        assert!(error.starts_with("SandboxUnavailable"), "{error}");
    }

    #[cfg(not(windows))]
    #[test]
    fn without_a_sandbox_nothing_starts() {
        let error = spawn(Path::new("/bin/true"), &[], &policy()).err().unwrap();
        assert!(error.starts_with("SandboxUnavailable"), "{error}");
    }
}
