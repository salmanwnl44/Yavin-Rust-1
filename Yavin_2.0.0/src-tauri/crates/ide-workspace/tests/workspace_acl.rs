//! EXT-33 Q5 feasibility proof: can a read-only ACL grant to an AppContainer SID give a
//! sandboxed process read access to a folder while **provably** denying write — and does a
//! pre-existing broad ACE defeat that? Every check here is the operating system's, observed from
//! inside the sandbox. Nothing touches the real user profile: a disposable temp tree and a
//! dedicated test container are used, and the grant is always revoked.
#![cfg(windows)]

use ide_workspace::sandbox::{self, cpu_rate_for, SandboxPolicy};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

const CONTAINER: &str = "Yavin.AclFeasibilityTest";
const MIB: u64 = 1 << 20;

fn policy() -> SandboxPolicy {
    SandboxPolicy {
        container: CONTAINER.into(),
        memory_bytes: 256 * MIB,
        cpu_rate: cpu_rate_for(1, 4),
    }
}

fn temp(label: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "yavin-acl-{label}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Runs the probe in the sandbox with `dir` on stdin; returns its `probe key value` lines.
fn probe(dir: &Path) -> HashMap<String, String> {
    let me = std::env::current_exe().unwrap();
    let mut spawned = sandbox::spawn(
        &me,
        &[
            "workspace_acl_probe",
            "--exact",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ],
        &policy(),
    )
    .expect("the probe starts in the sandbox");
    spawned
        .stdin
        .write_all(format!("dir {}\n", dir.display()).as_bytes())
        .unwrap();
    drop(spawned.stdin);
    let mut out = String::new();
    spawned.stdout.read_to_string(&mut out).unwrap();
    let started = Instant::now();
    loop {
        if spawned.child.try_wait().unwrap().is_some() {
            break;
        }
        if started.elapsed() > Duration::from_secs(30) {
            spawned.child.kill();
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    out.lines()
        .filter_map(|l| {
            l.strip_prefix("probe ")
                .or_else(|| l.split_once(" ... probe ").map(|(_, r)| r))
        })
        .filter_map(|l| l.split_once(' '))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

/// The decisive invariant: a read-only grant lets the sandbox **read** the folder and **denies
/// every write** (create, modify, delete). Proven live, from inside the AppContainer.
#[test]
fn a_read_only_grant_allows_reads_and_denies_every_write() {
    let dir = temp("readonly");
    std::fs::write(dir.join("readable.txt"), "workspace contents").unwrap();
    std::fs::create_dir(dir.join("sub")).unwrap();
    std::fs::write(dir.join("sub").join("nested.txt"), "nested").unwrap();

    sandbox::grant_read_tree(&dir, CONTAINER).expect("grant applies");
    assert!(
        sandbox::container_aces(&dir, CONTAINER).unwrap() >= 1,
        "the ACE is present"
    );

    let p = probe(&dir);
    assert_eq!(
        p.get("appcontainer").map(String::as_str),
        Some("yes"),
        "{p:?}"
    );
    assert_eq!(
        p.get("read").map(String::as_str),
        Some("ok"),
        "a read-only grant must allow reads: {p:?}"
    );
    assert_eq!(
        p.get("read-nested").map(String::as_str),
        Some("ok"),
        "reads reach descendants: {p:?}"
    );
    assert_eq!(
        p.get("create").map(String::as_str),
        Some("denied"),
        "creating a file must be denied: {p:?}"
    );
    assert_eq!(
        p.get("modify").map(String::as_str),
        Some("denied"),
        "modifying must be denied: {p:?}"
    );
    assert_eq!(
        p.get("delete").map(String::as_str),
        Some("denied"),
        "deleting must be denied: {p:?}"
    );

    sandbox::revoke_read_tree(&dir, CONTAINER).expect("revoke");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A pre-existing broad allow ACE (`ALL APPLICATION PACKAGES`, write) **defeats** the read-only
/// guarantee: the sandbox can then write. This is why the C2 foundation must detect such ACEs and
/// refuse the grant -- a read-only ACE does not cancel another ACE's write.
#[test]
fn a_pre_existing_broad_write_ace_defeats_read_only() {
    let dir = temp("broad");
    std::fs::write(dir.join("readable.txt"), "contents").unwrap();
    // Grant ALL APPLICATION PACKAGES Modify, inheritable -- as some installers leave behind.
    let granted = Command::new("icacls")
        .arg(&dir)
        .args(["/grant", "*S-1-15-2-1:(OI)(CI)(M)"])
        .output()
        .expect("icacls runs");
    assert!(
        granted.status.success(),
        "icacls: {}",
        String::from_utf8_lossy(&granted.stderr)
    );

    sandbox::grant_read_tree(&dir, CONTAINER).expect("grant applies");
    let p = probe(&dir);
    assert_eq!(
        p.get("create").map(String::as_str),
        Some("allowed"),
        "with a broad write ACE present, the sandbox CAN write -- the danger the foundation must refuse: {p:?}"
    );

    sandbox::revoke_read_tree(&dir, CONTAINER).expect("revoke");
    let _ = std::fs::remove_dir_all(&dir);
}

/// Revocation leaves **zero** container-SID ACEs, and unrelated ACEs are preserved.
#[test]
fn revocation_removes_the_grant_and_preserves_other_aces() {
    let dir = temp("revoke");
    std::fs::write(dir.join("f.txt"), "x").unwrap();
    // A sentinel unrelated ACE (Guests read), to prove the removal is surgical.
    let before = Command::new("icacls")
        .arg(&dir)
        .args(["/grant", "*S-1-5-32-546:(R)"])
        .output()
        .unwrap();
    assert!(before.status.success());

    assert_eq!(
        sandbox::container_aces(&dir, CONTAINER).unwrap(),
        0,
        "none before"
    );
    sandbox::grant_read_tree(&dir, CONTAINER).unwrap();
    assert!(
        sandbox::container_aces(&dir, CONTAINER).unwrap() >= 1,
        "present after grant"
    );
    // Idempotent re-grant does not accumulate duplicates beyond what SetEntriesInAclW merges.
    sandbox::grant_read_tree(&dir, CONTAINER).unwrap();
    sandbox::revoke_read_tree(&dir, CONTAINER).unwrap();
    assert_eq!(
        sandbox::container_aces(&dir, CONTAINER).unwrap(),
        0,
        "zero residue after revoke"
    );
    // Revoking again is harmless.
    sandbox::revoke_read_tree(&dir, CONTAINER).unwrap();

    // The unrelated Guests ACE survives.
    let after = Command::new("icacls").arg(&dir).output().unwrap();
    let text = String::from_utf8_lossy(&after.stdout);
    assert!(
        text.contains("S-1-5-32-546") || text.to_lowercase().contains("guests"),
        "the unrelated ACE must survive: {text}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// Two containers are isolated: a grant to one SID gives the other nothing.
#[test]
fn a_grant_to_one_container_is_not_shared_with_another() {
    let dir = temp("isolation");
    sandbox::grant_read_tree(&dir, CONTAINER).unwrap();
    assert!(sandbox::container_aces(&dir, CONTAINER).unwrap() >= 1);
    assert_eq!(
        sandbox::container_aces(&dir, "Yavin.AclFeasibilityOther").unwrap(),
        0,
        "another container has no ACE here"
    );
    sandbox::revoke_read_tree(&dir, CONTAINER).unwrap();
    let _ = std::fs::remove_dir_all(&dir);
}

/// An outward junction inside the tree is detectable, so the foundation can refuse such a tree
/// (a one-time scan does not stop later substitution -- that residual is separate).
#[test]
fn an_outward_junction_is_detectable() {
    let root = temp("reparse-root");
    let outside = temp("reparse-outside");
    std::fs::write(outside.join("secret.txt"), "not in the workspace").unwrap();
    let link = root.join("escape");
    let made = Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(&link)
        .arg(&outside)
        .output()
        .expect("mklink runs");
    if !made.status.success() {
        eprintln!("skipped: could not create a junction here");
        return;
    }
    assert!(
        outward_reparse_exists(&root),
        "an outward junction must be detected"
    );
    // A tree with no links is clean.
    let clean = temp("reparse-clean");
    std::fs::write(clean.join("a.txt"), "a").unwrap();
    assert!(
        !outward_reparse_exists(&clean),
        "a plain tree has no outward link"
    );
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&outside);
    let _ = std::fs::remove_dir_all(&clean);
}

/// INVESTIGATION (EXT-33 Q5), the decisive reparse question: can the sandbox read **outside** the
/// granted root through a junction — whether the junction was present at grant time or planted
/// afterwards? Observed: **no**. Windows checks a read against the *target* object's DACL; the
/// outside target carries no container ACE, so the read is denied, and granting the inheritable
/// ACE does not propagate it through the junction to the target (zero ACEs there). This means the
/// feared session-time substitution residual does **not** grant out-of-workspace reads: a junction
/// only ever reaches data the target's own ACL already allows the container, which is nothing
/// outside the grant.
#[test]
fn reads_cannot_escape_the_root_through_a_junction() {
    let outside = temp("escape-outside");
    std::fs::create_dir(outside.join("sub")).unwrap();
    std::fs::write(
        outside.join("sub").join("nested.txt"),
        "OUTSIDE the workspace",
    )
    .unwrap();

    // Case 1: junction present BEFORE the grant.
    let root1 = temp("escape-root-before");
    std::fs::write(root1.join("readable.txt"), "in").unwrap();
    assert!(Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(root1.join("sub"))
        .arg(&outside)
        .output()
        .unwrap()
        .status
        .success());
    sandbox::grant_read_tree(&root1, CONTAINER).expect("grant with a pre-existing junction");
    assert_eq!(
        sandbox::container_aces(&outside, CONTAINER).unwrap(),
        0,
        "granting must NOT propagate the ACE through the junction to the outside target"
    );
    let p1 = probe(&root1);
    assert_eq!(p1.get("read").map(String::as_str), Some("ok"), "{p1:?}");
    assert_eq!(
        p1.get("read-nested").map(String::as_str),
        Some("denied"),
        "a read through a pre-existing junction to outside the root is denied by the target's DACL: {p1:?}"
    );
    sandbox::revoke_read_tree(&root1, CONTAINER).ok();

    // Case 2: junction planted AFTER the grant (same-user substitution).
    let root2 = temp("escape-root-after");
    std::fs::write(root2.join("readable.txt"), "in").unwrap();
    sandbox::grant_read_tree(&root2, CONTAINER).expect("grant");
    assert!(Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(root2.join("sub"))
        .arg(&outside)
        .output()
        .unwrap()
        .status
        .success());
    let p2 = probe(&root2);
    assert_eq!(
        p2.get("read-nested").map(String::as_str),
        Some("denied"),
        "a read through a post-grant junction to outside the root is also denied by the target's DACL: {p2:?}"
    );
    sandbox::revoke_read_tree(&root2, CONTAINER).ok();

    let _ = std::fs::remove_dir_all(&root1);
    let _ = std::fs::remove_dir_all(&root2);
    let _ = std::fs::remove_dir_all(&outside);
}

/// INVESTIGATION (EXT-33 Q5, hard links): a hard link under the root to an OUTSIDE file, present
/// at grant time, has the read ACE propagated onto the shared object, so the sandbox can read it
/// (the outside file's content) — unlike a junction. This is why the foundation must detect and
/// refuse such trees at grant time. A hard link created AFTER the grant is denied (the object was
/// never in the tree, so it carries no ACE). Hard links are same-volume only, so `FindFirstFileNameW`
/// can enumerate every name of an in-tree object.
#[test]
fn hard_links_present_at_grant_expose_the_object_but_later_ones_do_not() {
    let outside = temp("hl-outside");
    std::fs::write(outside.join("secret.txt"), "OUTSIDE SECRET").unwrap();
    std::fs::write(outside.join("secret2.txt"), "OUTSIDE SECRET 2").unwrap();

    let root = temp("hl-root");
    std::fs::write(root.join("readable.txt"), "in").unwrap();
    // A hard link present BEFORE the grant.
    let made = Command::new("cmd")
        .args(["/c", "mklink", "/H"])
        .arg(root.join("hardlink.txt"))
        .arg(outside.join("secret.txt"))
        .output()
        .expect("mklink /H");
    if !made.status.success() {
        eprintln!("skipped: hard links unavailable here");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
        return;
    }

    sandbox::grant_read_tree(&root, CONTAINER).expect("grant");
    // A hard link created AFTER the grant.
    assert!(Command::new("cmd")
        .args(["/c", "mklink", "/H"])
        .arg(root.join("late.txt"))
        .arg(outside.join("secret2.txt"))
        .output()
        .unwrap()
        .status
        .success());

    let p = probe(&root);
    eprintln!(
        "hardlink: present-at-grant={:?} created-after={:?}",
        p.get("read-hardlink"),
        p.get("read-late")
    );
    // The decisive findings this phase's design relies on:
    assert_eq!(
        p.get("read-hardlink").map(String::as_str),
        Some("ok"),
        "a hard link present at grant exposes the object (propagation ACLs it) -- must be refused: {p:?}"
    );
    assert_eq!(
        p.get("read-late").map(String::as_str),
        Some("denied"),
        "a hard link created after the grant is denied (object has no ACE): {p:?}"
    );

    // Detection: the external name of the pre-grant link is discoverable.
    let external = workspace_acl::external_hard_link(&root);
    assert!(
        external.is_some(),
        "the pre-grant external hard link must be detected"
    );

    sandbox::revoke_read_tree(&root, CONTAINER).ok();
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&outside);
}

/// A scan a foundation would run before granting: is there any reparse point under `root` whose
/// target resolves outside `root`? (Detection only -- see the residual on substitution.)
fn outward_reparse_exists(root: &Path) -> bool {
    let canonical_root = std::fs::canonicalize(root).unwrap();
    fn walk(dir: &Path, root: &Path, found: &mut bool) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            if meta.file_type().is_symlink() || meta.file_attributes() & 0x400 != 0
            /* FILE_ATTRIBUTE_REPARSE_POINT */
            {
                match std::fs::canonicalize(&path) {
                    Ok(target) if target.starts_with(root) => {}
                    _ => {
                        *found = true;
                        return;
                    }
                }
            } else if meta.is_dir() {
                walk(&path, root, found);
                if *found {
                    return;
                }
            }
        }
    }
    use std::os::windows::fs::MetadataExt;
    let mut found = false;
    walk(&canonical_root, &canonical_root, &mut found);
    found
}

/// Measurement (run with `--ignored`, size from `YAVIN_ACL_FILES`): builds a tree and times the
/// grant and the revoke, to inform the latency budget. Not a CI test.
#[test]
#[ignore]
fn measure_acl_latency() {
    let files: usize = std::env::var("YAVIN_ACL_FILES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(10_000);
    let dir = temp("measure");
    let per_dir = 200;
    let build = Instant::now();
    for i in 0..files {
        if i % per_dir == 0 {
            std::fs::create_dir_all(dir.join(format!("d{}", i / per_dir))).unwrap();
        }
        std::fs::write(dir.join(format!("d{}/f{i}.txt", i / per_dir)), b"x").unwrap();
    }
    let dirs = files.div_ceil(per_dir);
    println!(
        "acl-measure: files={files} dirs={dirs} built_in={:?}",
        build.elapsed()
    );

    let g = Instant::now();
    sandbox::grant_read_tree(&dir, CONTAINER).unwrap();
    let grant = g.elapsed();
    let r = Instant::now();
    sandbox::revoke_read_tree(&dir, CONTAINER).unwrap();
    let revoke = r.elapsed();
    assert_eq!(sandbox::container_aces(&dir, CONTAINER).unwrap(), 0);
    println!("acl-measure: files={files} grant={grant:?} revoke={revoke:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

// --- EXT-33 Q5: the safe-grant manager (broad-ACE/reparse refusal, journaling, recovery) -------

use ide_workspace::workspace_acl::{
    self, GrantError, GrantJournal, GrantPhase, GrantState, WorkspaceGrantManager,
};

/// Polls `f` until it is true or ~10 s elapse.
fn wait_until(mut f: impl FnMut() -> bool) -> bool {
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(10) {
        if f() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    false
}

fn journal(dir: &Path) -> GrantJournal {
    GrantJournal::new(dir.join("acl-journal.json"))
}

/// The happy path: a clean workspace is granted (verified read-only), then revoked to zero.
#[test]
fn safe_grant_establishes_and_revokes_a_verified_read_only_grant() {
    let dir = temp("safe-ok");
    std::fs::write(dir.join("a.txt"), "x").unwrap();
    let j = journal(&dir);
    let grant = workspace_acl::safe_grant(&dir, CONTAINER, &j).expect("clean tree grants");
    assert!(sandbox::container_aces(&grant.root, CONTAINER).unwrap() >= 1);
    assert!(
        !sandbox::container_writable(&grant.root, CONTAINER).unwrap(),
        "read-only verified"
    );
    workspace_acl::revoke(&grant, &j).expect("revoke");
    assert_eq!(
        sandbox::container_aces(&dir, CONTAINER).unwrap(),
        0,
        "zero residue"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// A pre-existing broad write ACE makes the read-only guarantee impossible, so the grant is
/// refused -- no ACE is applied.
#[test]
fn safe_grant_refuses_a_tree_the_container_can_already_write() {
    let dir = temp("safe-broad");
    assert!(Command::new("icacls")
        .arg(&dir)
        .args(["/grant", "*S-1-15-2-1:(OI)(CI)(M)"])
        .output()
        .unwrap()
        .status
        .success());
    let j = journal(&dir);
    assert_eq!(
        workspace_acl::safe_grant(&dir, CONTAINER, &j),
        Err(GrantError::AlreadyWritable)
    );
    assert_eq!(
        sandbox::container_aces(&dir, CONTAINER).unwrap(),
        0,
        "nothing was granted"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// A tree with a junction escaping the root is refused.
#[test]
fn safe_grant_refuses_an_outward_junction() {
    let root = temp("safe-reparse");
    let outside = temp("safe-reparse-out");
    assert!(Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(root.join("escape"))
        .arg(&outside)
        .output()
        .unwrap()
        .status
        .success());
    let j = journal(&root);
    match workspace_acl::safe_grant(&root, CONTAINER, &j) {
        Err(GrantError::OutwardReparse(_)) => {}
        other => panic!("expected OutwardReparse, got {other:?}"),
    }
    assert_eq!(sandbox::container_aces(&root, CONTAINER).unwrap(), 0);
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&outside);
}

/// `safe_grant` refuses a workspace that contains a hard link to data outside it (its object is
/// shared, so the inherited ACE would expose it) — nothing is granted.
#[test]
fn safe_grant_refuses_an_external_hard_link() {
    let outside = temp("safe-hl-out");
    std::fs::write(outside.join("secret.txt"), "OUTSIDE").unwrap();
    let root = temp("safe-hl-root");
    std::fs::write(root.join("a.txt"), "x").unwrap();
    let made = Command::new("cmd")
        .args(["/c", "mklink", "/H"])
        .arg(root.join("hardlink.txt"))
        .arg(outside.join("secret.txt"))
        .output()
        .unwrap();
    if !made.status.success() {
        eprintln!("skipped: hard links unavailable");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
        return;
    }
    let j = journal(&root);
    match workspace_acl::safe_grant(&root, CONTAINER, &j) {
        Err(GrantError::ExternalHardLink(_)) => {}
        other => panic!("expected ExternalHardLink, got {other:?}"),
    }
    assert_eq!(
        sandbox::container_aces(&root, CONTAINER).unwrap(),
        0,
        "nothing granted"
    );
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&outside);
}

/// Crash recovery: after a grant, a crash (no revoke) leaves a journal entry; a fresh journal over
/// the same file reconciles it to **zero** residual ACEs and empties the journal.
#[test]
fn startup_reconciliation_removes_a_grant_a_crash_left_behind() {
    let dir = temp("safe-crash");
    std::fs::write(dir.join("a.txt"), "x").unwrap();
    let journal_file = dir.join("acl-journal.json");
    {
        let j = GrantJournal::new(journal_file.clone());
        let grant = workspace_acl::safe_grant(&dir, CONTAINER, &j).expect("grant");
        assert!(sandbox::container_aces(&grant.root, CONTAINER).unwrap() >= 1);
        // "Crash": drop everything WITHOUT revoking. The ACE and the journal entry persist.
        std::mem::forget(grant); // ensure no Drop-based cleanup masks the test
    }
    assert!(
        sandbox::container_aces(&dir, CONTAINER).unwrap() >= 1,
        "the ACE survived the crash"
    );
    // Next startup reconciles.
    let j2 = GrantJournal::new(journal_file);
    let cleaned = workspace_acl::reconcile(&j2).expect("reconcile succeeds");
    assert_eq!(cleaned, 1, "one grant reconciled");
    assert_eq!(
        sandbox::container_aces(&dir, CONTAINER).unwrap(),
        0,
        "zero residue after recovery"
    );
    // Idempotent: a second reconcile finds nothing.
    assert_eq!(workspace_acl::reconcile(&j2).unwrap(), 0);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A corrupt journal fails closed: reconciliation returns an error (the caller must block, not
/// proceed as if clean).
#[test]
fn a_corrupt_journal_fails_closed() {
    let dir = temp("safe-corrupt");
    let file = dir.join("acl-journal.json");
    std::fs::write(&file, b"{ not valid json ][").unwrap();
    let j = GrantJournal::new(file);
    match workspace_acl::reconcile(&j) {
        Err(GrantError::JournalUnavailable(_)) => {}
        other => panic!("a corrupt journal must fail closed, got {other:?}"),
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// A child with a protected (non-inheriting) DACL does not accumulate the container ACE, so
/// revocation still reaches zero everywhere.
#[test]
fn a_protected_dacl_child_leaves_no_residue() {
    let dir = temp("safe-protected");
    std::fs::create_dir(dir.join("locked")).unwrap();
    std::fs::write(dir.join("locked").join("f.txt"), "x").unwrap();
    // Disable inheritance on the child (protected DACL).
    assert!(Command::new("icacls")
        .arg(dir.join("locked"))
        .arg("/inheritance:r")
        .args(["/grant", "*S-1-5-32-544:(OI)(CI)(F)"])
        .output()
        .unwrap()
        .status
        .success());
    let j = journal(&dir);
    let grant = workspace_acl::safe_grant(&dir, CONTAINER, &j).expect("grant");
    assert_eq!(
        sandbox::container_aces(dir.join("locked").as_path(), CONTAINER).unwrap(),
        0,
        "the protected child did not inherit the ACE"
    );
    workspace_acl::revoke(&grant, &j).unwrap();
    assert_eq!(sandbox::container_aces(&dir, CONTAINER).unwrap(), 0);
    let _ = std::fs::remove_dir_all(&dir);
}

/// The async manager: a grant goes Pending → Granted (ready only then), and a revoke removes it.
#[test]
fn the_manager_grants_and_revokes_asynchronously() {
    let dir = temp("mgr-ok");
    std::fs::write(dir.join("a.txt"), "x").unwrap();
    let mgr = WorkspaceGrantManager::new(journal(&dir));
    let k = mgr.begin_grant(&dir, CONTAINER);
    // Not ready immediately (still Pending) in the common case; definitely ready soon.
    assert!(
        wait_until(|| mgr.is_ready(&k)),
        "grant did not become ready: {:?}",
        mgr.state(&k)
    );
    assert_eq!(mgr.state(&k), Some(GrantState::Granted));
    assert!(sandbox::container_aces(&dir, CONTAINER).unwrap() >= 1);
    mgr.begin_revoke(&k);
    assert!(
        wait_until(|| mgr.state(&k).is_none()),
        "revoke did not complete: {:?}",
        mgr.state(&k)
    );
    assert_eq!(sandbox::container_aces(&dir, CONTAINER).unwrap(), 0);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A refused tree ends in `Failed` and is never ready; nothing is granted.
#[test]
fn the_manager_reports_failure_and_never_readies_a_refused_tree() {
    let dir = temp("mgr-fail");
    assert!(Command::new("icacls")
        .arg(&dir)
        .args(["/grant", "*S-1-15-2-1:(OI)(CI)(M)"])
        .output()
        .unwrap()
        .status
        .success());
    let mgr = WorkspaceGrantManager::new(journal(&dir));
    let k = mgr.begin_grant(&dir, CONTAINER);
    assert!(
        wait_until(|| matches!(mgr.state(&k), Some(GrantState::Failed(_)))),
        "{:?}",
        mgr.state(&k)
    );
    assert!(!mgr.is_ready(&k), "a refused grant is never ready");
    assert_eq!(sandbox::container_aces(&dir, CONTAINER).unwrap(), 0);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Two workspaces granted concurrently both become ready and stay isolated.
#[test]
fn concurrent_grants_on_two_workspaces_are_isolated() {
    let a = temp("mgr-a");
    let b = temp("mgr-b");
    std::fs::write(a.join("f.txt"), "a").unwrap();
    std::fs::write(b.join("f.txt"), "b").unwrap();
    let mgr = WorkspaceGrantManager::new(journal(&a));
    let ka = mgr.begin_grant(&a, CONTAINER);
    let kb = mgr.begin_grant(&b, "Yavin.AclMgrOther");
    assert!(
        wait_until(|| mgr.is_ready(&ka) && mgr.is_ready(&kb)),
        "both ready"
    );
    // Each container only on its own workspace.
    assert!(sandbox::container_aces(&a, CONTAINER).unwrap() >= 1);
    assert_eq!(sandbox::container_aces(&a, "Yavin.AclMgrOther").unwrap(), 0);
    assert!(sandbox::container_aces(&b, "Yavin.AclMgrOther").unwrap() >= 1);
    assert_eq!(sandbox::container_aces(&b, CONTAINER).unwrap(), 0);
    mgr.begin_revoke(&ka);
    mgr.begin_revoke(&kb);
    assert!(
        wait_until(|| mgr.state(&ka).is_none() && mgr.state(&kb).is_none()),
        "both revoked"
    );
    assert_eq!(sandbox::container_aces(&a, CONTAINER).unwrap(), 0);
    assert_eq!(sandbox::container_aces(&b, "Yavin.AclMgrOther").unwrap(), 0);
    let _ = std::fs::remove_dir_all(&a);
    let _ = std::fs::remove_dir_all(&b);
}

/// The grant reports its phases in the fixed order Scanning -> Applying -> Verifying before it
/// returns the verified grant. (Deterministic: the callback runs synchronously inside the grant.)
#[test]
fn safe_grant_observed_reports_phases_in_order() {
    let dir = temp("phase-order");
    std::fs::write(dir.join("a.txt"), "x").unwrap();
    let j = journal(&dir);
    let mut phases = Vec::new();
    let grant = workspace_acl::safe_grant_observed(&dir, CONTAINER, &j, &mut |p| phases.push(p))
        .expect("clean tree grants");
    assert_eq!(
        phases,
        vec![
            GrantPhase::Scanning,
            GrantPhase::Applying,
            GrantPhase::Verifying
        ],
        "phases observed in order"
    );
    workspace_acl::revoke(&grant, &j).expect("revoke");
    let _ = std::fs::remove_dir_all(&dir);
}

/// The stale-operation safety invariant: a revoke that supersedes an in-flight grant must win, no
/// matter the interleaving. After `begin_grant` immediately followed by `begin_revoke`, the key is
/// never left `Granted`/ready and the tree is left with zero container ACEs -- a stale grant worker
/// can never re-apply permissions behind a newer revoke.
#[test]
fn a_newer_revoke_prevents_a_stale_grant_from_reapplying() {
    let dir = temp("mgr-stale");
    std::fs::write(dir.join("f.txt"), "x").unwrap();
    let mgr = WorkspaceGrantManager::new(journal(&dir));
    for i in 0..12 {
        let k = mgr.begin_grant(&dir, CONTAINER);
        // Interleave the revoke at varying points of the grant's progress.
        if i % 3 == 1 {
            std::thread::sleep(Duration::from_millis(5));
        }
        mgr.begin_revoke(&k);
        // Wait for true quiescence (no worker still running), not a momentary ACE count: a stale
        // grant worker may apply then undo, so only once idle is the outcome settled.
        assert!(
            wait_until(|| mgr.quiescent()),
            "iteration {i}: operations settle"
        );
        assert!(
            !mgr.is_ready(&k),
            "iteration {i}: never ready after a revoke"
        );
        assert!(
            !matches!(mgr.state(&k), Some(GrantState::Granted)),
            "iteration {i}: never left Granted after a revoke"
        );
        assert_eq!(
            sandbox::container_aces(&dir, CONTAINER).unwrap(),
            0,
            "iteration {i}: a revoke must win over the in-flight grant, leaving zero ACEs"
        );
    }
    assert_eq!(sandbox::container_aces(&dir, CONTAINER).unwrap(), 0);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Cancellation rolls a grant back whether the cancel beats the worker or loses the race: once the
/// manager is quiescent the key is never ready and the tree has zero container ACEs.
#[test]
fn cancelling_a_grant_leaves_no_applied_permission() {
    let dir = temp("mgr-cancel");
    std::fs::write(dir.join("f.txt"), "x").unwrap();
    let mgr = WorkspaceGrantManager::new(journal(&dir));
    let k = mgr.begin_grant(&dir, CONTAINER);
    mgr.cancel(&k);
    assert!(wait_until(|| mgr.quiescent()), "operations settle");
    assert!(!mgr.is_ready(&k), "a cancelled grant is never ready");
    assert_eq!(
        sandbox::container_aces(&dir, CONTAINER).unwrap(),
        0,
        "cancel leaves zero container ACEs"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// Server-start gating: `may_start` allows a launch only for a verified, journalled, still-effective
/// grant of exactly that workspace+identity, and refuses everything else.
#[test]
fn may_start_gates_a_server_launch_on_a_verified_grant() {
    let dir = temp("mgr-may-start");
    std::fs::write(dir.join("f.txt"), "x").unwrap();
    let mgr = WorkspaceGrantManager::new(journal(&dir));

    // No grant yet -> refused.
    assert!(
        matches!(mgr.may_start(&dir, CONTAINER), Err(GrantError::NotReady(_))),
        "no grant must refuse a launch"
    );

    let k = mgr.begin_grant(&dir, CONTAINER);
    assert!(wait_until(|| mgr.is_ready(&k)), "granted within timeout");
    // Granted and verified -> allowed.
    assert!(
        mgr.may_start(&dir, CONTAINER).is_ok(),
        "a verified grant may start"
    );
    // A different identity on the same workspace is not covered by this grant.
    assert!(
        matches!(
            mgr.may_start(&dir, "Yavin.AclMgrOther"),
            Err(GrantError::NotReady(_))
        ),
        "a different identity must refuse"
    );

    mgr.begin_revoke(&k);
    assert!(wait_until(|| mgr.state(&k).is_none()), "revoked");
    // Revoked -> refused.
    assert!(
        matches!(mgr.may_start(&dir, CONTAINER), Err(GrantError::NotReady(_))),
        "a revoked grant must refuse a launch"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// A grant that was refused (broad pre-existing write ACE) never gates a launch.
#[test]
fn may_start_refuses_a_failed_grant() {
    let dir = temp("mgr-may-fail");
    assert!(Command::new("icacls")
        .arg(&dir)
        .args(["/grant", "*S-1-15-2-1:(OI)(CI)(M)"])
        .output()
        .unwrap()
        .status
        .success());
    let mgr = WorkspaceGrantManager::new(journal(&dir));
    let k = mgr.begin_grant(&dir, CONTAINER);
    assert!(
        wait_until(|| matches!(mgr.state(&k), Some(GrantState::Failed(_)))),
        "the refused grant reports failure"
    );
    assert!(
        matches!(mgr.may_start(&dir, CONTAINER), Err(GrantError::NotReady(_))),
        "a failed grant must refuse a launch"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

// --- The probe: runs inside the sandbox, reports what the OS allowed --------------------------

fn say(key: &str, value: impl std::fmt::Display) {
    println!("probe {key} {value}");
    let _ = std::io::stdout().flush();
}

#[test]
#[ignore]
fn workspace_acl_probe() {
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    let dir = input
        .lines()
        .find_map(|l| l.strip_prefix("dir "))
        .map(PathBuf::from);
    let Some(dir) = dir else { return };

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{GetTokenInformation, TokenIsAppContainer, TOKEN_QUERY};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    // SAFETY: a query about this process into a 4-byte buffer.
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

    let readable = |r: std::io::Result<Vec<u8>>| if r.is_ok() { "ok" } else { "denied" };
    say("read", readable(std::fs::read(dir.join("readable.txt"))));
    say(
        "read-nested",
        readable(std::fs::read(dir.join("sub").join("nested.txt"))),
    );
    // Hard-link reads (the files may be absent in a given test; an absent read is "denied").
    say(
        "read-hardlink",
        readable(std::fs::read(dir.join("hardlink.txt"))),
    );
    say("read-late", readable(std::fs::read(dir.join("late.txt"))));

    let did = |r: std::io::Result<()>| if r.is_ok() { "allowed" } else { "denied" };
    say(
        "create",
        did(std::fs::write(dir.join("created-by-sandbox.txt"), b"x")),
    );
    say(
        "modify",
        did(std::fs::OpenOptions::new()
            .append(true)
            .open(dir.join("readable.txt"))
            .and_then(|mut f| f.write_all(b"more"))),
    );
    say(
        "delete",
        did(std::fs::remove_file(dir.join("readable.txt"))),
    );
}
