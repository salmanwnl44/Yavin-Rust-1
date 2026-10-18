//! The extension host sandbox, enforced by Windows (EXT-10): this test binary starts itself in
//! the sandbox (`sandbox::spawn`, exactly as the extension host is started) as a probe that tries
//! everything the sandbox must refuse, and reports what happened. Nothing here is mocked: each
//! refusal is the operating system's.
#![cfg(windows)]

use ide_workspace::sandbox::{self, cpu_rate_for, SandboxPolicy};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const MIB: u64 = 1 << 20;

fn policy() -> SandboxPolicy {
    SandboxPolicy {
        container: "Yavin.SandboxTest".into(),
        memory_bytes: 256 * MIB,
        cpu_rate: cpu_rate_for(
            1,
            std::thread::available_parallelism().map_or(1, |n| n.get() as u32),
        ),
    }
}

/// Starts this binary's probe in the sandbox with `input` on its stdin; its `probe` lines and
/// exit code.
fn probe(input: &str, policy: &SandboxPolicy) -> (HashMap<String, String>, Option<i32>, String) {
    let me = std::env::current_exe().unwrap();
    let mut spawned = sandbox::spawn(
        &me,
        &[
            "sandbox_probe",
            "--exact",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ],
        policy,
    )
    .expect("the probe starts in the sandbox");
    spawned.stdin.write_all(input.as_bytes()).unwrap();
    drop(spawned.stdin);
    let mut stderr = spawned.stderr;
    let errors = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text);
        text
    });
    let mut out = String::new();
    spawned.stdout.read_to_string(&mut out).unwrap();
    let started = Instant::now();
    let code = loop {
        if let Some(code) = spawned.child.try_wait().unwrap() {
            break Some(code);
        }
        if started.elapsed() > Duration::from_secs(30) {
            spawned.child.kill();
            break None;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let errors = errors.join().unwrap();
    let lines = out
        .lines()
        // libtest prints its own `test sandbox_probe ... ` before the first one.
        .filter_map(|line| {
            line.strip_prefix("probe ")
                .or_else(|| line.split_once(" ... probe ").map(|(_, rest)| rest))
        })
        .filter_map(|line| line.split_once(' '))
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect();
    (lines, code, format!("{out}\n{errors}"))
}

/// A folder of this test's own, outside the sandbox: in the user's temporary folder (inside the
/// user profile) and in the Cargo target folder (beside the repository).
fn secrets() -> (PathBuf, PathBuf) {
    let profile = std::env::temp_dir().join(format!("yavin-sandbox-{}", std::process::id()));
    let repository = Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("yavin-sandbox-{}", std::process::id()));
    for folder in [&profile, &repository] {
        std::fs::create_dir_all(folder).unwrap();
        std::fs::write(folder.join("secret.txt"), "a credential").unwrap();
    }
    (profile, repository)
}

/// Everything the sandbox must refuse, tried from inside it -- and what it must allow.
#[test]
fn the_sandbox_refuses_what_it_was_not_given() {
    let (profile, repository) = secrets();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    // A handle of this process's, made inheritable: the probe must not get it.
    let handed = std::fs::File::create(profile.join("handle.txt")).unwrap();
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE_FLAG_INHERIT};
        // SAFETY: the handle is live for the whole test.
        unsafe {
            SetHandleInformation(
                handed.as_raw_handle() as _,
                HANDLE_FLAG_INHERIT,
                HANDLE_FLAG_INHERIT,
            )
        };
    }
    let handle = {
        use std::os::windows::io::AsRawHandle;
        handed.as_raw_handle() as usize
    };
    let input = format!(
        "mode refuse\nprofile {}\nrepository {}\nport {port}\nparent {}\nhandle {handle}\n",
        profile.display(),
        repository.display(),
        std::process::id(),
    );
    let (seen, code, output) = probe(&input, &policy());
    let get = |key: &str| {
        seen.get(key)
            .unwrap_or_else(|| panic!("no {key} from the probe (exit {code:?}):\n{output}"))
            .as_str()
    };

    // It is in an AppContainer, with Yavin's world taken away.
    assert_eq!(get("appcontainer"), "yes");
    // Its environment: the Windows folder, and the container's own folders -- Windows puts
    // them there -- none of the user's (LOCALAPPDATA is replaced, not passed).
    assert_eq!(get("env"), "LOCALAPPDATA,SystemRoot,TEMP,TMP");
    let own = format!(
        "\\packages\\{}\\ac",
        policy().container.to_ascii_lowercase()
    );
    for variable in ["LOCALAPPDATA", "TEMP", "TMP"] {
        let value = get(&format!("env-{variable}")).to_ascii_lowercase();
        assert!(value.contains(&own), "{variable} is {value}");
    }
    assert_ne!(
        get("env-LOCALAPPDATA").to_ascii_lowercase(),
        std::env::var("LOCALAPPDATA").unwrap().to_ascii_lowercase()
    );
    assert_eq!(get("args"), "5");
    // Files: the user's, beside the repository, Yavin's data -- refused; writing too.
    assert_eq!(get("read-profile"), "denied");
    assert_eq!(get("write-profile"), "denied");
    assert_eq!(get("read-repository"), "denied");
    assert_eq!(get("write-repository"), "denied");
    assert_eq!(get("list-profile"), "denied");
    // What it was given: its own program (read and execute), and the system's files.
    assert_eq!(get("read-program"), "ok");
    assert_eq!(get("read-system"), "ok");
    // No process: not cmd, not itself.
    assert_eq!(get("spawn-cmd"), "denied");
    assert_eq!(get("spawn-self"), "denied");
    // No network: a listener on this machine's loopback is not reached (Windows drops the
    // connection: it times out).
    assert_eq!(get("connect-loopback"), "denied");
    assert!(
        matches!(listener.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock),
        "nothing connected"
    );
    // No other process: not Yavin (its parent).
    assert_eq!(get("open-parent"), "denied");
    // Memory: within the job's limit, yes; past it, refused.
    assert_eq!(get("allocate-small"), "ok");
    assert_eq!(get("allocate-past-limit"), "denied");
    // The mitigations it was created with, as it reads them.
    for mitigation in [
        "no-win32k",
        "no-dynamic-code",
        "no-extension-points",
        "no-fonts",
        "no-remote-images",
        "no-low-label-images",
        "strict-handles",
        "no-child-processes",
    ] {
        assert_eq!(get(mitigation), "on", "{mitigation}");
    }
    // Last: the handle value this process holds is nothing to it. With strict handle checks,
    // using it ends the process (STATUS_INVALID_HANDLE) -- or the call fails.
    assert_eq!(get("handle"), "probing");
    let invalid_handle = 0xC0000008u32 as i32;
    assert!(
        seen.get("handle-result").map(String::as_str) == Some("unusable")
            || code == Some(invalid_handle),
        "{code:?}\n{output}"
    );
    let _ = std::fs::remove_dir_all(profile);
    let _ = std::fs::remove_dir_all(repository);
}

/// The job holds the limits it was given, as Windows reports them.
#[test]
fn the_job_holds_its_limits() {
    let policy = SandboxPolicy {
        cpu_rate: 2_500,
        ..policy()
    };
    let me = std::env::current_exe().unwrap();
    let spawned = sandbox::spawn(
        &me,
        &["sandbox_probe", "--exact", "--ignored", "--nocapture"],
        &policy,
    )
    .unwrap();
    let limits = spawned.child.job_limits().unwrap();
    assert_eq!(limits.active_processes, 1);
    assert_eq!(limits.memory_bytes, 256 * MIB);
    assert_eq!(limits.cpu_rate, Some(2_500));
    assert!(limits.kill_on_close);
    assert!(limits.ui_restricted);
    spawned.child.kill();
}

/// Killing ends it; so does dropping it (its job is closed), with nobody asking.
#[test]
fn a_sandboxed_process_ends_when_killed_or_dropped() {
    let me = std::env::current_exe().unwrap();
    let start = || {
        sandbox::spawn(
            &me,
            &["sandbox_probe", "--exact", "--ignored", "--nocapture"],
            &policy(),
        )
        .unwrap()
    };
    let waits = |child: &sandbox::SandboxedChild| {
        let started = Instant::now();
        while child.try_wait().unwrap().is_none() {
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "it did not end"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    };
    // Waiting on its stdin: it runs until it is ended.
    let spawned = start();
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(spawned.child.try_wait().unwrap(), None);
    spawned.child.kill();
    waits(&spawned.child);

    let spawned = start();
    let pid = spawned.child.id();
    let process = {
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};
        // SAFETY: opened to wait on, closed below.
        unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) }
    };
    assert!(!process.is_null());
    let keep = (spawned.stdin, spawned.stdout, spawned.stderr);
    drop(spawned.child);
    {
        use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
        use windows_sys::Win32::System::Threading::WaitForSingleObject;
        // SAFETY: the handle was opened above and is closed once.
        unsafe {
            assert_eq!(
                WaitForSingleObject(process, 10_000),
                WAIT_OBJECT_0,
                "dropping its job ended it"
            );
            CloseHandle(process);
        }
    }
    drop(keep);
}

/// Nothing starts without its program; nothing starts with a policy that is not valid.
#[test]
fn a_sandbox_that_cannot_be_set_up_starts_nothing() {
    let missing = sandbox::spawn(Path::new("C:/no/such/host.exe"), &[], &policy())
        .err()
        .unwrap();
    assert!(missing.contains("was not found"), "{missing}");
    let invalid = sandbox::spawn(
        &std::env::current_exe().unwrap(),
        &[],
        &SandboxPolicy {
            memory_bytes: 0,
            ..policy()
        },
    )
    .err()
    .unwrap();
    assert!(invalid.starts_with("SandboxUnavailable"), "{invalid}");
}

// --- The probe: what runs inside the sandbox ---------------------------------------------------

fn say(key: &str, value: impl std::fmt::Display) {
    println!("probe {key} {value}");
    let _ = std::io::stdout().flush();
}

fn verdict<T>(result: std::io::Result<T>) -> String {
    match result {
        Ok(_) => "ok".into(),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => "denied".into(),
        Err(e) => format!("error:{:?}:{}", e.kind(), e.raw_os_error().unwrap_or(0)),
    }
}

/// Not a test: the probe the tests above start in the sandbox (run only with `--ignored`).
#[test]
#[ignore]
fn sandbox_probe() {
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    let given: HashMap<&str, &str> = input.lines().filter_map(|l| l.split_once(' ')).collect();
    if given.get("mode") != Some(&"refuse") {
        return;
    }
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{GetTokenInformation, TokenIsAppContainer, TOKEN_QUERY};
    use windows_sys::Win32::System::Threading::*;

    // SAFETY: queries about this process, into buffers of the size given.
    let appcontainer = unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        let mut is = 0u32;
        let mut size = 0u32;
        let ok = OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) != 0
            && GetTokenInformation(
                token,
                TokenIsAppContainer,
                &mut is as *mut _ as _,
                4,
                &mut size,
            ) != 0;
        CloseHandle(token);
        ok && is != 0
    };
    say("appcontainer", if appcontainer { "yes" } else { "no" });
    let mut names: Vec<String> = std::env::vars_os()
        .map(|(k, _)| k.to_string_lossy().into_owned())
        .collect();
    names.sort();
    say("env", names.join(","));
    for variable in ["LOCALAPPDATA", "TEMP", "TMP"] {
        say(
            &format!("env-{variable}"),
            std::env::var(variable).unwrap_or_default(),
        );
    }
    say("args", std::env::args().count() - 1);

    let profile = Path::new(given["profile"]);
    let repository = Path::new(given["repository"]);
    say(
        "read-profile",
        verdict(std::fs::read(profile.join("secret.txt"))),
    );
    say(
        "write-profile",
        verdict(std::fs::write(profile.join("new.txt"), "x")),
    );
    say("list-profile", verdict(std::fs::read_dir(profile)));
    say(
        "read-repository",
        verdict(std::fs::read(repository.join("secret.txt"))),
    );
    say(
        "write-repository",
        verdict(std::fs::write(repository.join("new.txt"), "x")),
    );
    say(
        "read-program",
        verdict(std::fs::read(std::env::current_exe().unwrap())),
    );
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    say(
        "read-system",
        verdict(std::fs::read(
            Path::new(&root).join("System32").join("kernel32.dll"),
        )),
    );

    let spawned = |program: &Path| {
        std::process::Command::new(program)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map(|mut child| {
                let _ = child.kill();
            })
    };
    let cmd = Path::new(&root).join("System32").join("cmd.exe");
    // Any refusal counts: the job's (access denied) or the child-process policy's.
    let refused = |result: std::io::Result<()>| if result.is_ok() { "allowed" } else { "denied" };
    say("spawn-cmd", refused(spawned(&cmd)));
    say(
        "spawn-self",
        refused(spawned(&std::env::current_exe().unwrap())),
    );

    let port: u16 = given["port"].parse().unwrap();
    let connected = std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_secs(3),
    );
    say(
        "connect-loopback",
        if connected.is_ok() {
            "allowed".to_string()
        } else {
            "denied".to_string()
        },
    );
    if let Err(e) = connected {
        say(
            "connect-loopback-error",
            format!("{:?}:{}", e.kind(), e.raw_os_error().unwrap_or(0)),
        );
    }

    let parent: u32 = given["parent"].parse().unwrap();
    // SAFETY: opening (and closing, if it opens) a process handle.
    let opened = unsafe {
        let handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, parent);
        let opened = !handle.is_null();
        if opened {
            CloseHandle(handle);
        }
        opened
    };
    say("open-parent", if opened { "allowed" } else { "denied" });

    let mut small: Vec<u8> = Vec::new();
    say(
        "allocate-small",
        if small.try_reserve_exact(32 * MIB as usize).is_ok() {
            "ok"
        } else {
            "denied"
        },
    );
    small.resize(32 * MIB as usize, 1);
    let mut large: Vec<u8> = Vec::new();
    say(
        "allocate-past-limit",
        if large.try_reserve_exact(512 * MIB as usize).is_ok() {
            "allowed"
        } else {
            "denied"
        },
    );
    drop(small);

    let flags = |policy| {
        // Each of these policies is one DWORD of flags, and the size must be exactly that.
        let mut value = 0u32;
        // SAFETY: a query about this process into a buffer of the size given.
        let ok = unsafe {
            GetProcessMitigationPolicy(GetCurrentProcess(), policy, &mut value as *mut u32 as _, 4)
        } != 0;
        if ok {
            value
        } else {
            0
        }
    };
    let bit = |value: u32, n: u32| if value & (1 << n) != 0 { "on" } else { "off" };
    say("no-win32k", bit(flags(ProcessSystemCallDisablePolicy), 0));
    say("no-dynamic-code", bit(flags(ProcessDynamicCodePolicy), 0));
    say(
        "no-extension-points",
        bit(flags(ProcessExtensionPointDisablePolicy), 0),
    );
    say("no-fonts", bit(flags(ProcessFontDisablePolicy), 0));
    say("no-remote-images", bit(flags(ProcessImageLoadPolicy), 0));
    say("no-low-label-images", bit(flags(ProcessImageLoadPolicy), 1));
    say(
        "strict-handles",
        bit(flags(ProcessStrictHandleCheckPolicy), 0),
    );
    say(
        "no-child-processes",
        bit(flags(ProcessChildProcessPolicy), 0),
    );

    // Last: a handle value of the parent's. It was never inherited, so it is nothing here.
    say("handle", "probing");
    let value: usize = given["handle"].parse().unwrap();
    // SAFETY: deliberately a value that is not a handle of this process: Windows refuses it
    // (or, with strict handle checks, ends the process).
    let kind = unsafe { windows_sys::Win32::Storage::FileSystem::GetFileType(value as HANDLE) };
    say(
        "handle-result",
        if kind == 0 { "unusable" } else { "usable" },
    );
}
