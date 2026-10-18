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
use std::path::Path;

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
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{
        GetLastError, LocalFree, SetHandleInformation, ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND,
        ERROR_PATH_NOT_FOUND, HANDLE, HANDLE_FLAG_INHERIT, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::Security::Authorization::{
        GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W,
        GRANT_ACCESS, NO_MULTIPLE_TRUSTEE, SE_FILE_OBJECT, TRUSTEE_IS_SID,
        TRUSTEE_IS_WELL_KNOWN_GROUP, TRUSTEE_W,
    };
    use windows_sys::Win32::Security::Isolation::{
        CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
    };
    use windows_sys::Win32::Security::{
        FreeSid, ACL, DACL_SECURITY_INFORMATION, NO_INHERITANCE, PSECURITY_DESCRIPTOR, PSID,
        SECURITY_ATTRIBUTES, SECURITY_CAPABILITIES,
    };
    use windows_sys::Win32::Storage::FileSystem::{FILE_GENERIC_EXECUTE, FILE_GENERIC_READ};
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
