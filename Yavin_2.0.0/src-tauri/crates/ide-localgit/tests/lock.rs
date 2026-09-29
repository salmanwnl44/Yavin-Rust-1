//! One writer per store, across processes: the first to open it writes; while it holds it,
//! everyone else reads. Proven with a real second process (this test binary, re-run as a lock
//! holder), not an in-process mock.

mod common;

use common::*;
use ide_localgit::*;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const HOLD_BASE: &str = "YLG_TEST_HOLD_BASE";
const HOLD_PROJECT: &str = "YLG_TEST_HOLD_PROJECT";
const HOLD_READY: &str = "YLG_TEST_HOLD_READY";

/// Not a test on its own: re-run by the test below in a child process, where it opens the
/// store as its writer, says so, and holds it until killed.
#[test]
fn lock_holder_helper() {
    let (Ok(base), Ok(project), Ok(ready)) = (
        std::env::var(HOLD_BASE),
        std::env::var(HOLD_PROJECT),
        std::env::var(HOLD_READY),
    ) else {
        return;
    };
    let spec = WorkspaceSpec::from_paths(&[project]).unwrap();
    let repo = Repository::open(Path::new(&base), &spec, OpenOptions::default()).unwrap();
    // Said through a file: a test binary's stdout is not a dependable channel.
    std::fs::write(&ready, format!("{:?}", repo.mode())).unwrap();
    std::thread::sleep(Duration::from_secs(120));
}

#[test]
fn a_second_process_opens_read_only_and_can_change_nothing() {
    let f = Fixture::new("lock-xproc");
    let mut repo = f.open().unwrap();
    let one = write_commit(&mut repo, "one", None);
    advance(&mut repo, one);
    drop(repo);

    let ready = f.base.parent().unwrap().join("holder-ready");
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["lock_holder_helper", "--exact", "--test-threads=1"])
        .env(HOLD_BASE, &f.base)
        .env(HOLD_PROJECT, &f.project)
        .env(HOLD_READY, &ready)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let started = Instant::now();
    let mode = loop {
        if let Ok(mode) = std::fs::read_to_string(&ready) {
            if !mode.is_empty() {
                break mode;
            }
        }
        if let Some(status) = child.try_wait().unwrap() {
            panic!("the holder exited early: {status}");
        }
        assert!(
            started.elapsed() < Duration::from_secs(60),
            "the holder never started"
        );
        std::thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(mode, "Writer");

    let mut repo = f.open().unwrap();
    assert_eq!(
        repo.mode(),
        Mode::ReadOnly(ReadOnlyReason::HeldByOtherProcess)
    );
    // Reads work.
    assert_eq!(repo.refs().head_commit(), Some(one));
    assert!(repo.verify(true).is_empty());
    // Every mutation is refused, and nothing was cleaned up or appended on its behalf.
    assert_eq!(repo.begin_write().err().unwrap().code(), "ReadOnly");
    assert_eq!(
        repo.update_refs(1, &[], Some(Head::Detached(one)), "x", "")
            .unwrap_err()
            .code(),
        "ReadOnly"
    );
    let reflog_before = repo.reflog().unwrap().len();
    drop(repo);

    // The writer dies without closing anything: the OS releases its lock.
    child.kill().unwrap();
    child.wait().unwrap();
    let repo = f.open().unwrap();
    assert_eq!(repo.mode(), Mode::Writer);
    assert_eq!(repo.refs().head_commit(), Some(one));
    assert_eq!(repo.reflog().unwrap().len(), reflog_before);
}

#[test]
fn within_one_process_the_second_open_is_read_only_until_the_first_closes() {
    let f = Fixture::new("lock-inproc");
    let writer = f.open().unwrap();
    assert_eq!(writer.mode(), Mode::Writer);
    let reader = f.open().unwrap();
    assert_eq!(
        reader.mode(),
        Mode::ReadOnly(ReadOnlyReason::HeldByOtherProcess)
    );
    drop(writer);
    drop(reader);
    assert_eq!(f.open().unwrap().mode(), Mode::Writer);
}
