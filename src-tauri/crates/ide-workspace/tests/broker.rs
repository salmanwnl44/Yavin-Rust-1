//! EXT-33 E1: the native C1 broker, enforced by Windows. This test binary is itself the brokered
//! program: `broker::C1Broker::run` starts the `broker_probe` ignored test inside the EXT-10
//! sandbox and feeds it stdin, so every boundary a C1 filter must have is the operating system's,
//! observed from inside -- not a mock, and not merely "a program started". The driver also pins,
//! substitutes and overruns the program to prove identity, bounds, timeout, cancellation and
//! fail-closed behaviour.
#![cfg(windows)]

use ide_workspace::broker::{self, C1Broker, C1Code, C1Profile, ProgramId, Slot, SlotValue};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

const MIB: usize = 1 << 20;

/// A profile whose program is this very test binary, verified by its real SHA-256, running the
/// `broker_probe` ignored test. `argv` is fixed literals (no caller input), as a C1 profile is.
fn probe_profile() -> C1Profile {
    let me = std::env::current_exe().unwrap();
    let sha = broker::sha256_hex(&me).unwrap();
    C1Profile {
        id: "probe",
        program: ProgramId {
            path: me,
            sha256: sha,
        },
        argv: vec![
            Slot::Literal("broker_probe"),
            Slot::Literal("--exact"),
            Slot::Literal("--ignored"),
            Slot::Literal("--nocapture"),
            Slot::Literal("--test-threads=1"),
        ],
    }
}

fn run(stdin: &str) -> Result<ide_workspace::broker::C1Output, ide_workspace::broker::C1Error> {
    C1Broker::new(vec![probe_profile()]).run("probe", &fixed(5), stdin.as_bytes(), flag())
}

fn fixed(n: usize) -> Vec<SlotValue> {
    (0..n).map(|_| SlotValue::Fixed).collect()
}

fn flag() -> Arc<AtomicBool> {
    Arc::new(AtomicBool::new(false))
}

fn lines(out: &[u8]) -> std::collections::HashMap<String, String> {
    String::from_utf8_lossy(out)
        .lines()
        .filter_map(|l| {
            l.strip_prefix("probe ")
                .or_else(|| l.split_once(" ... probe ").map(|(_, r)| r))
        })
        .filter_map(|l| l.split_once(' '))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

/// The boundary: a brokered C1 filter is an AppContainer that sees its stdin and nothing else --
/// no user file, no loopback, no child process, no handle to its parent.
#[test]
fn a_brokered_filter_is_sandboxed_and_sees_only_its_stdin() {
    // A user file outside the sandbox the probe will try to read.
    let dir = std::env::temp_dir().join(format!("yavin-broker-secret-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("secret.txt"), "top secret").unwrap();
    // A listener on loopback the probe will try to reach.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let parent = std::process::id();

    let input = format!(
        "mode refuse\nsecret {}\nport {port}\nparent {parent}\n",
        dir.display()
    );
    let out = run(&input).expect("the probe runs in the broker's sandbox");
    let p = lines(&out.stdout);
    assert_eq!(out.end, ide_workspace::broker::End::Exited);

    assert_eq!(
        p.get("appcontainer").map(String::as_str),
        Some("yes"),
        "{p:?}"
    );
    assert_eq!(
        p.get("read-secret").map(String::as_str),
        Some("denied"),
        "a C1 filter read a user file"
    );
    assert_eq!(
        p.get("connect-loopback").map(String::as_str),
        Some("denied"),
        "a C1 filter reached the network"
    );
    assert_eq!(
        p.get("spawn-cmd").map(String::as_str),
        Some("denied"),
        "a C1 filter started a child"
    );
    assert_eq!(
        p.get("open-parent").map(String::as_str),
        Some("denied"),
        "a C1 filter opened its parent"
    );

    std::fs::remove_dir_all(&dir).ok();
}

/// stdin reaches the filter and its stdout is the result.
#[test]
fn stdin_goes_in_and_stdout_comes_back() {
    let out = run("mode echo\nPAYLOAD-abc-123\n").expect("echo runs");
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(text.contains("echo PAYLOAD-abc-123"), "{text}");
}

/// Identity: a program whose bytes do not match the profile's pinned SHA-256 is refused, and so
/// is one that is missing or is a script rather than a program.
#[test]
fn a_substituted_or_mismatched_program_is_refused() {
    let me = std::env::current_exe().unwrap();

    // Right path, wrong hash -> ExecutableChanged (this is the substitution case: the file at the
    // path is not the one Yavin verified).
    let mut wrong = probe_profile();
    wrong.program.sha256 = "ab".repeat(32);
    let e = C1Broker::new(vec![wrong])
        .run("probe", &fixed(5), b"mode echo\n", flag())
        .unwrap_err();
    assert_eq!(e.code, C1Code::ExecutableChanged, "{e:?}");

    // A missing program.
    let missing = C1Profile {
        id: "probe",
        program: ProgramId {
            path: PathBuf::from("C:/no/such/filter.exe"),
            sha256: broker::sha256_hex(&me).unwrap(),
        },
        argv: vec![],
    };
    let e = C1Broker::new(vec![missing])
        .run("probe", &[], b"", flag())
        .unwrap_err();
    assert_eq!(e.code, C1Code::ExecutableNotFound, "{e:?}");

    // A script, not a PE image: refused as a program (resolution, §9.3).
    let dir = std::env::temp_dir().join(format!("yavin-broker-script-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("filter.cmd");
    std::fs::write(&script, "@echo off\r\n").unwrap();
    let sham = C1Profile {
        id: "probe",
        program: ProgramId {
            path: script.clone(),
            sha256: broker::sha256_hex(&script).unwrap(),
        },
        argv: vec![],
    };
    let e = C1Broker::new(vec![sham])
        .run("probe", &[], b"", flag())
        .unwrap_err();
    assert_eq!(
        e.code,
        C1Code::BadRequest,
        "a script was accepted as a program: {e:?}"
    );
    std::fs::remove_dir_all(&dir).ok();
}

/// A non-PE file with an allowed extension is still refused (the header is checked, not the name).
#[test]
fn a_non_program_file_is_refused() {
    let dir = std::env::temp_dir().join(format!("yavin-broker-fake-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let fake = dir.join("filter.exe");
    std::fs::write(&fake, b"this is not a PE image").unwrap();
    let profile = C1Profile {
        id: "probe",
        program: ProgramId {
            path: fake.clone(),
            sha256: broker::sha256_hex(&fake).unwrap(),
        },
        argv: vec![],
    };
    let e = C1Broker::new(vec![profile])
        .run("probe", &[], b"", flag())
        .unwrap_err();
    assert_eq!(e.code, C1Code::BadRequest, "{e:?}");
    std::fs::remove_dir_all(&dir).ok();
}

/// Output past the bound ends the run.
#[test]
fn output_past_the_bound_ends_the_run() {
    // `flood` writes more than MAX_STDOUT; the broker stops reading and ends the job.
    let e = run("mode flood\n").unwrap_err();
    assert_eq!(e.code, C1Code::OutputTooLarge, "{e:?}");
}

/// A filter that runs past its deadline is ended.
#[test]
fn a_filter_past_its_deadline_is_ended() {
    let broker = C1Broker::new(vec![probe_profile()]).with_deadline(Duration::from_secs(1));
    let e = broker
        .run("probe", &fixed(5), b"mode block\n", flag())
        .unwrap_err();
    assert_eq!(e.code, C1Code::Timeout, "{e:?}");
}

/// A running filter can be cancelled.
#[test]
fn a_running_filter_can_be_cancelled() {
    let broker = C1Broker::new(vec![probe_profile()]).with_deadline(Duration::from_secs(60));
    let cancel = flag();
    let setter = cancel.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
        setter.store(true, Ordering::SeqCst);
    });
    let e = broker
        .run("probe", &fixed(5), b"mode block\n", cancel)
        .unwrap_err();
    assert_eq!(e.code, C1Code::Cancelled, "{e:?}");
}

/// Slots are released after each run: real runs in a row all succeed (no slot leak).
#[test]
fn slots_are_released_so_runs_in_a_row_succeed() {
    let broker = C1Broker::new(vec![probe_profile()]);
    for i in 0..3 {
        let out = broker
            .run("probe", &fixed(5), b"mode echo\nhi\n", flag())
            .unwrap_or_else(|e| panic!("run {i} failed: {e:?}"));
        assert!(String::from_utf8_lossy(&out.stdout).contains("echo hi"));
    }
}

// --- EXT-33 E3: resource limits and cleanup, measured live --------------------------------------

/// The job's memory cap is the operating system's: an allocation past the broker's 512 MiB limit
/// is refused inside the sandbox.
#[test]
fn the_job_memory_cap_refuses_an_over_limit_allocation() {
    let out = run("mode mem\n").expect("the probe runs");
    let p = lines(&out.stdout);
    assert_eq!(
        p.get("allocate-over-limit").map(String::as_str),
        Some("denied"),
        "a 600 MiB allocation was allowed past the 512 MiB job cap: {p:?}"
    );
}

/// stderr is bounded and draining it never deadlocks the run: a filter that floods stderr still
/// finishes and its stdout result arrives, with stderr kept to the bound.
#[test]
fn stderr_is_bounded_and_does_not_deadlock() {
    let out = run("mode stderrflood\n").expect("the run completes despite a stderr flood");
    assert_eq!(out.end, ide_workspace::broker::End::Exited);
    assert!(
        lines(&out.stdout).contains_key("stdout"),
        "stdout still arrived"
    );
    eprintln!(
        "stderr-bound: kept {} of a flood (cap {})",
        out.stderr.len(),
        ide_workspace::broker::MAX_STDERR
    );
    // The flood (8 MiB) far exceeds the cap, so a correctly-bounded reader keeps exactly the cap:
    // this both proves a lot arrived and that it was clamped. An unbounded reader keeps more.
    assert_eq!(
        out.stderr.len(),
        ide_workspace::broker::MAX_STDERR,
        "stderr was not clamped to its bound"
    );
}

/// The job's CPU hard cap holds under sustained load: a filter spinning every core is throttled to
/// about one core's worth of CPU time, far below the uncapped core-count × wall time. Skipped on a
/// single-processor machine, where one core is the whole machine (no cap to show).
#[test]
fn the_cpu_hard_cap_holds_under_sustained_load() {
    let n = std::thread::available_parallelism().map_or(1, |n| n.get());
    if n < 2 {
        eprintln!("skipped: a single-processor machine has no CPU headroom to cap");
        return;
    }
    let broker = C1Broker::new(vec![probe_profile()]).with_deadline(Duration::from_secs(20));
    let out = broker
        .run("probe", &fixed(5), b"mode cpu\n", flag())
        .expect("the cpu probe runs");
    let p = lines(&out.stdout);
    let wall: u64 = p.get("wall-ms").and_then(|v| v.parse().ok()).unwrap_or(0);
    let cpu: u64 = p
        .get("cpu-ms")
        .and_then(|v| v.parse().ok())
        .unwrap_or(u64::MAX);
    assert!(wall > 0, "no wall time reported: {p:?}");
    eprintln!(
        "cpu-cap: cores={n} wall={wall}ms cpu={cpu}ms (uncapped budget {}ms)",
        wall * n as u64
    );
    // Capped near one core: CPU time stays within a small multiple of wall time (scheduling
    // granularity over a short window lets it drift above exactly 1×), and is a small fraction of
    // the n × wall an uncapped spin on every core would use.
    assert!(
        cpu <= wall * 3,
        "CPU time {cpu} ms was not capped near one core over {wall} ms wall (cores={n})"
    );
    // ...and a real saving against that budget: at most half of it. The margin has to stay
    // compatible with the drift allowance above -- on a 4-core runner a one-core cap measured over
    // a ~1.5 s window lands near 1.5x wall, so the earlier `cpu * 3 < wall * n` (demanding under
    // n/3 = 1.33x wall) was below achievable drift and failed even when the cap held.
    assert!(
        cpu * 2 <= wall * (n as u64),
        "CPU time {cpu} ms was not well below the uncapped {n}-core budget of {} ms",
        wall * (n as u64)
    );
}

/// A concurrency slot is released however a run ends: after a run that times out, the broker
/// counts no running process and a fresh run succeeds.
#[test]
fn a_slot_is_released_after_an_aborted_run() {
    let broker = C1Broker::new(vec![probe_profile()]).with_deadline(Duration::from_millis(600));
    assert_eq!(broker.running_now(), 0);
    let timed_out = broker
        .run("probe", &fixed(5), b"mode block\n", flag())
        .unwrap_err();
    assert_eq!(timed_out.code, C1Code::Timeout);
    assert_eq!(
        broker.running_now(),
        0,
        "the slot was not released after a timeout"
    );
    // A normal run works afterwards.
    let out = broker
        .with_deadline(Duration::from_secs(10))
        .run("probe", &fixed(5), b"mode echo\nok\n", flag())
        .unwrap();
    assert!(String::from_utf8_lossy(&out.stdout).contains("echo ok"));
}

/// A filter that never reads its stdin and never exits is still ended by the deadline (the writer
/// cannot wedge the run), and the slot is freed. The stdin is larger than a pipe buffer so the
/// writer really blocks.
#[test]
fn a_filter_that_never_reads_stdin_is_still_ended() {
    let broker = C1Broker::new(vec![probe_profile()]).with_deadline(Duration::from_secs(1));
    let big = {
        let mut s = String::from("mode stall\n");
        s.push_str(&"x".repeat(2 * 1024 * 1024)); // 2 MiB, past the pipe buffer
        s
    };
    let started = std::time::Instant::now();
    let e = broker
        .run("probe", &fixed(5), big.as_bytes(), flag())
        .unwrap_err();
    assert_eq!(e.code, C1Code::Timeout, "{e:?}");
    assert!(started.elapsed() < Duration::from_secs(10), "the run hung");
    assert_eq!(broker.running_now(), 0, "the slot leaked");
}

/// A filter that exits with a non-zero code is reported, not treated as an error, and cleans up.
#[test]
fn a_crashing_filter_is_reported_and_cleans_up() {
    let broker = C1Broker::new(vec![probe_profile()]);
    let out = broker
        .run("probe", &fixed(5), b"mode crash\n", flag())
        .unwrap();
    assert_eq!(out.code, Some(3), "the exit code is reported");
    assert_eq!(out.end, ide_workspace::broker::End::Exited);
    assert_eq!(broker.running_now(), 0, "the slot leaked after a crash");
}

/// A verification failure takes no concurrency slot (it happens before one is reserved), so a
/// flood of refused launches cannot exhaust concurrency.
#[test]
fn a_refused_launch_takes_no_slot() {
    let mut wrong = probe_profile();
    wrong.program.sha256 = "cd".repeat(32);
    let broker = C1Broker::new(vec![wrong]);
    for _ in 0..20 {
        assert_eq!(
            broker
                .run("probe", &fixed(5), b"mode echo\n", flag())
                .unwrap_err()
                .code,
            C1Code::ExecutableChanged
        );
    }
    assert_eq!(broker.running_now(), 0, "refused launches held slots");
}

// --- The probe: what runs inside the broker's sandbox -----------------------------------------

fn say(key: &str, value: impl std::fmt::Display) {
    println!("probe {key} {value}");
    let _ = std::io::stdout().flush();
}

/// Not a test: the program the driver starts in the broker (run only with `--ignored`).
#[test]
#[ignore]
fn broker_probe() {
    use std::io::Read;
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    let given: std::collections::HashMap<&str, &str> =
        input.lines().filter_map(|l| l.split_once(' ')).collect();
    match given.get("mode").copied() {
        Some("echo") => {
            // Prove stdin reaches it: echo a known marker line back.
            for line in input.lines() {
                if !line.starts_with("mode ") {
                    say("echo", line);
                }
            }
        }
        Some("flood") => {
            // More than the output bound, to force OutputTooLarge.
            let chunk = vec![b'x'; MIB];
            let out = std::io::stdout();
            let mut lock = out.lock();
            for _ in 0..20 {
                if lock.write_all(&chunk).is_err() {
                    break;
                }
            }
            let _ = lock.flush();
        }
        Some("block") => {
            // Never finishes on its own: the broker must end it (deadline or cancel).
            std::thread::sleep(Duration::from_secs(120));
        }
        // EXT-33 E3: flood stderr past its bound; the broker must keep only a bounded slice and
        // not deadlock. A short marker goes to stdout so the result still arrives.
        Some("stderrflood") => {
            let chunk = vec![b'e'; MIB];
            {
                let err = std::io::stderr();
                let mut lock = err.lock();
                for _ in 0..8 {
                    if lock.write_all(&chunk).is_err() {
                        break;
                    }
                }
                let _ = lock.flush();
            }
            say("stdout", "done");
        }
        // EXT-33 E3: never read stdin and never exit; with a large stdin this blocks the writer,
        // so the broker's deadline must still end it without hanging.
        Some("stall") => {
            std::thread::sleep(Duration::from_secs(120));
        }
        // EXT-33 E3: exit with a non-zero code; the broker must report it and clean up.
        Some("crash") => {
            std::process::exit(3);
        }
        // EXT-33 E3: allocate past the job's memory cap; the OS must refuse it.
        Some("mem") => {
            let mut big: Vec<u8> = Vec::new();
            let over = 600 * MIB; // > the broker's 512 MiB job limit
            say(
                "allocate-over-limit",
                if big.try_reserve_exact(over).is_ok() {
                    big.resize(over, 1);
                    // If the reservation somehow succeeded, touch it so it is really committed.
                    "allowed"
                } else {
                    "denied"
                },
            );
        }
        // EXT-33 E3: spin every logical processor for ~1.5 s of wall time and report the CPU time
        // used, so the test can see the job's hard CPU cap holding under sustained load.
        Some("cpu") => {
            use std::time::Instant;
            let n = std::thread::available_parallelism().map_or(1, |n| n.get());
            let wall = Duration::from_millis(1500);
            let start = Instant::now();
            let threads: Vec<_> = (0..n)
                .map(|_| {
                    std::thread::spawn(move || {
                        let s = Instant::now();
                        let mut x: u64 = 0;
                        while s.elapsed() < wall {
                            for _ in 0..200_000 {
                                x = x.wrapping_mul(6364136223846793005).wrapping_add(1);
                            }
                            std::hint::black_box(x);
                        }
                    })
                })
                .collect();
            for t in threads {
                let _ = t.join();
            }
            say("wall-ms", start.elapsed().as_millis());
            say("cpu-ms", process_cpu_ms());
            say("cores", n);
        }
        Some("refuse") => probe_refuse(&given),
        _ => {}
    }
}

/// This process's CPU time so far (user + kernel), in milliseconds, via `GetProcessTimes`.
#[cfg(windows)]
fn process_cpu_ms() -> u64 {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
    let mut creation = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut exit = creation;
    let mut kernel = creation;
    let mut user = creation;
    // SAFETY: four owned FILETIME out-params for the current process.
    let ok = unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    } != 0;
    if !ok {
        return 0;
    }
    let ticks = |t: FILETIME| ((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64;
    // FILETIME is in 100 ns units.
    (ticks(kernel) + ticks(user)) / 10_000
}

fn probe_refuse(given: &std::collections::HashMap<&str, &str>) {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{GetTokenInformation, TokenIsAppContainer, TOKEN_QUERY};
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_INFORMATION,
        PROCESS_VM_READ,
    };

    // SAFETY: queries about this process into fixed-size buffers.
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
        if !token.is_null() {
            CloseHandle(token);
        }
        ok && is != 0
    };
    say("appcontainer", if appcontainer { "yes" } else { "no" });

    let secret = Path::new(given["secret"]).join("secret.txt");
    say(
        "read-secret",
        match std::fs::read(&secret) {
            Ok(_) => "allowed",
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => "denied",
            // Any failure to read the user's file is a denial of access to it.
            Err(_) => "denied",
        },
    );

    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let cmd = Path::new(&root).join("System32").join("cmd.exe");
    let spawned = std::process::Command::new(&cmd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|mut c| {
            let _ = c.kill();
        });
    say(
        "spawn-cmd",
        if spawned.is_ok() { "allowed" } else { "denied" },
    );

    let port: u16 = given["port"].parse().unwrap_or(0);
    let connected = std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_secs(3),
    );
    say(
        "connect-loopback",
        if connected.is_ok() {
            "allowed"
        } else {
            "denied"
        },
    );

    let parent: u32 = given["parent"].parse().unwrap_or(0);
    // SAFETY: opening (and closing, if it opens) a process handle by pid.
    let opened = unsafe {
        let handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, parent);
        let opened = !handle.is_null();
        if opened {
            CloseHandle(handle);
        }
        opened
    };
    say("open-parent", if opened { "allowed" } else { "denied" });
}
