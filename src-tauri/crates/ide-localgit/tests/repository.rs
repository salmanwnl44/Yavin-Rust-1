mod common;

use common::*;
use ide_localgit::*;
use std::fs;

#[test]
fn a_store_is_created_outside_the_project_and_reopens_with_the_same_identity() {
    let f = Fixture::new("create");
    let before = listing(&f.project);
    let repo = f.open().unwrap();
    assert_eq!(repo.mode(), Mode::Writer);
    assert_eq!(repo.refs().revision, 0);
    assert_eq!(repo.refs().head_commit(), None, "a new store is unborn");
    let meta = repo.meta().clone();
    assert_eq!(meta.workspace_id, f.spec.workspace_id);
    assert_eq!(meta.folders.len(), 1);
    assert!(meta.folders[0].folder_id.starts_with("f-"));
    assert!(f.store().join("workspace.json").exists());
    assert!(f.store().join("refs.json").exists());
    drop(repo);
    // Nothing was written into the project.
    assert_eq!(listing(&f.project), before);

    let again = f.open().unwrap();
    assert_eq!(again.meta(), &meta, "folder ids are assigned once");
    assert!(again.findings().is_empty(), "{:?}", again.findings());
}

#[test]
fn a_store_refuses_to_open_for_another_workspace() {
    let f = Fixture::new("mismatch");
    drop(f.open().unwrap());
    // Same directory name, different identity: forge it by editing workspace.json.
    let meta_path = f.store().join("workspace.json");
    let text = fs::read_to_string(&meta_path).unwrap();
    fs::write(
        &meta_path,
        text.replace(&f.spec.workspace_id, "file:///somewhere/else"),
    )
    .unwrap();
    assert_eq!(f.open().unwrap_err().code(), "WorkspaceMismatch");
    // The file is left exactly as it is: nothing is "fixed" by guessing.
    assert!(fs::read_to_string(&meta_path)
        .unwrap()
        .contains("file:///somewhere/else"));
}

#[test]
fn missing_or_newer_metadata_is_refused_never_recreated_over_existing_data() {
    let f = Fixture::new("meta");
    let mut repo = f.open().unwrap();
    let commit = write_commit(&mut repo, "one", None);
    advance(&mut repo, commit);
    drop(repo);

    let meta_path = f.store().join("workspace.json");
    let saved = fs::read(&meta_path).unwrap();
    fs::remove_file(&meta_path).unwrap();
    assert_eq!(f.open().unwrap_err().code(), "RecoveryRequired");
    assert!(!meta_path.exists(), "not recreated");

    fs::write(
        &meta_path,
        String::from_utf8(saved.clone())
            .unwrap()
            .replace("\"format\": 1", "\"format\": 9"),
    )
    .unwrap();
    assert_eq!(f.open().unwrap_err().code(), "UnsupportedVersion");

    fs::write(&meta_path, b"{ this is not json").unwrap();
    assert_eq!(f.open().unwrap_err().code(), "InvalidFormat");
    assert_eq!(
        fs::read(&meta_path).unwrap(),
        b"{ this is not json",
        "left in place"
    );
    let quarantined = listing(&f.store().join("quarantine"));
    assert!(
        quarantined.iter().any(|n| n.starts_with("workspace.json.")),
        "{quarantined:?}"
    );

    fs::write(&meta_path, saved).unwrap();
    let repo = f.open().unwrap();
    assert_eq!(repo.refs().head_commit(), Some(commit), "history intact");
}

#[test]
fn refs_move_by_compare_and_swap_with_a_growing_revision() {
    let f = Fixture::new("refs");
    let mut repo = f.open().unwrap();
    let one = write_commit(&mut repo, "one", None);
    let two = write_commit(&mut repo, "two", Some(one));
    assert_eq!(advance(&mut repo, one), 1);
    assert_eq!(
        repo.refs().head_commit(),
        Some(one),
        "HEAD follows the symbolic ref"
    );

    // A stale revision is refused, and so is a wrong expected value.
    let stale = repo.update_refs(
        0,
        &[RefUpdate {
            name: main_ref(),
            expected: Some(one),
            new: Some(two),
        }],
        None,
        "test",
        "",
    );
    assert_eq!(stale.unwrap_err().code(), "StaleRevision");
    let wrong = repo.update_refs(
        1,
        &[RefUpdate {
            name: main_ref(),
            expected: Some(two),
            new: Some(two),
        }],
        None,
        "test",
        "",
    );
    assert_eq!(wrong.unwrap_err().code(), "RefConflict");
    // A ref can only point at a stored object.
    let missing = hash_object(ObjectKind::Commit, b"not stored");
    let dangling = repo.update_refs(
        1,
        &[RefUpdate {
            name: RefName::new("refs/heads/x").unwrap(),
            expected: None,
            new: Some(missing),
        }],
        None,
        "test",
        "",
    );
    assert_eq!(dangling.unwrap_err().code(), "MissingObject");
    // Several refs and HEAD move together.
    let branch = RefName::new("refs/heads/feature").unwrap();
    let rev = repo
        .update_refs(
            1,
            &[
                RefUpdate {
                    name: main_ref(),
                    expected: Some(one),
                    new: Some(two),
                },
                RefUpdate {
                    name: branch.clone(),
                    expected: None,
                    new: Some(one),
                },
            ],
            Some(Head::Symbolic(branch.clone())),
            "test",
            "two refs and HEAD",
        )
        .unwrap();
    assert_eq!(rev, 2);
    // A name differing only in case from an existing ref is refused.
    let clash = repo.update_refs(
        2,
        &[RefUpdate {
            name: RefName::new("refs/heads/Feature").unwrap(),
            expected: None,
            new: Some(one),
        }],
        None,
        "test",
        "",
    );
    assert_eq!(clash.unwrap_err().code(), "InvalidName");
    // Detached HEAD.
    repo.update_refs(2, &[], Some(Head::Detached(one)), "test", "detach")
        .unwrap();
    drop(repo);

    let repo = f.open().unwrap();
    assert_eq!(repo.refs().revision, 3);
    assert_eq!(repo.refs().refs.get(&main_ref()), Some(&two));
    assert_eq!(repo.refs().refs.get(&branch), Some(&one));
    assert_eq!(repo.refs().head, Head::Detached(one));
    // The reflog has every change, in order, with its revision.
    let log = repo.reflog().unwrap();
    let revisions: Vec<u64> = log.iter().map(ReflogRecord::revision).collect();
    assert_eq!(revisions, [1, 2, 2, 2, 3]);
    assert!(repo.findings().is_empty(), "{:?}", repo.findings());
}

#[test]
fn a_read_only_handle_reads_but_can_change_nothing() {
    let f = Fixture::new("readonly");
    let mut writer = f.open().unwrap();
    let one = write_commit(&mut writer, "one", None);
    advance(&mut writer, one);
    let mut reader = f.open_read_only().unwrap();
    assert_eq!(reader.mode(), Mode::ReadOnly(ReadOnlyReason::Requested));
    assert_eq!(reader.read_commit(&one).unwrap().message, "commit one");
    assert_eq!(reader.begin_write().err().unwrap().code(), "ReadOnly");
    assert_eq!(
        reader
            .update_refs(1, &[], Some(Head::Detached(one)), "x", "")
            .unwrap_err()
            .code(),
        "ReadOnly"
    );
    // It sees what the writer publishes after a reload.
    let two = write_commit(&mut writer, "two", Some(one));
    advance(&mut writer, two);
    assert_eq!(reader.refs().head_commit(), Some(one));
    reader.reload().unwrap();
    assert_eq!(reader.refs().head_commit(), Some(two));
}

#[test]
fn blobs_are_binary_safe_deduplicated_and_streamable() {
    let f = Fixture::new("blobs");
    let mut repo = f.open().unwrap();
    let binary: Vec<u8> = (0..=255u8).cycle().take(10_000).collect();
    let large: Vec<u8> = (0..3_000_000u32).map(|i| (i * 7 % 251) as u8).collect();
    let (empty, text, bin, big, dup) = {
        let mut txn = repo.begin_write().unwrap();
        let empty = txn.put_blob(b"").unwrap();
        let text = txn.put_blob("ünïcode 😀\r\n".as_bytes()).unwrap();
        let bin = txn.put_blob(&binary).unwrap();
        let big = txn
            .put_blob_stream(large.len() as u64, &mut large.as_slice())
            .unwrap();
        let dup = txn.put_blob(&binary).unwrap();
        txn.commit().unwrap();
        (empty, text, bin, big, dup)
    };
    assert_eq!(bin, dup);
    assert_eq!(big, hash_object(ObjectKind::Blob, &large));
    assert_eq!(repo.object_count(), 4, "the duplicate was stored once");
    assert_eq!(repo.segment_count(), 1, "one transaction, one segment");
    assert_eq!(repo.read_blob(&empty, 1).unwrap(), b"");
    assert_eq!(
        repo.read_blob(&text, 100).unwrap(),
        "ünïcode 😀\r\n".as_bytes()
    );
    assert_eq!(repo.read_blob(&bin, 1 << 20).unwrap(), binary);
    assert!(
        repo.read_blob(&big, 1024).is_err(),
        "refused over the limit asked for"
    );
    let mut streamed = Vec::new();
    repo.stream_blob(&big, &mut streamed).unwrap();
    assert_eq!(streamed, large);
    assert_eq!(repo.blob_info(&bin).unwrap(), (10_000, true));
    assert!(!repo.blob_info(&text).unwrap().1);

    // Storing the same content again adds nothing: no new segment.
    let mut txn = repo.begin_write().unwrap();
    assert_eq!(txn.put_blob(&binary).unwrap(), bin);
    txn.commit().unwrap();
    assert_eq!(repo.segment_count(), 1);

    // A file hashed but not stored is "content unavailable", never missing or empty.
    let unstored_id = hash_blob_stream(large.len() as u64, &mut large.as_slice()).unwrap();
    let kind = EntryKind::File {
        executable: false,
        stored: Stored::No {
            size: large.len() as u64,
        },
    };
    assert_eq!(
        repo.read_file(&kind, &unstored_id, u64::MAX)
            .unwrap_err()
            .code(),
        "ContentUnavailable"
    );
}

#[test]
fn a_transaction_cannot_publish_anything_that_points_at_nothing() {
    let f = Fixture::new("dangling");
    let mut repo = f.open().unwrap();
    let mut txn = repo.begin_write().unwrap();
    let ghost = hash_object(ObjectKind::Blob, b"never stored");
    let tree = Tree::new(vec![TreeEntry {
        name: EntryName::new("a").unwrap(),
        kind: EntryKind::File {
            executable: false,
            stored: Stored::Yes,
        },
        id: ghost,
    }])
    .unwrap();
    assert_eq!(txn.put_tree(&tree).unwrap_err().code(), "MissingObject");
    // An unstored file is allowed to be absent.
    let unstored = Tree::new(vec![TreeEntry {
        name: EntryName::new("big.bin").unwrap(),
        kind: EntryKind::File {
            executable: false,
            stored: Stored::No { size: 99 },
        },
        id: ghost,
    }])
    .unwrap();
    let id = txn.put_tree(&unstored).unwrap();
    txn.commit().unwrap();
    assert_eq!(repo.read_tree(&id).unwrap(), unstored);
    assert!(repo.verify(true).is_empty(), "{:?}", repo.verify(true));
}

#[test]
fn corruption_is_detected_reported_and_never_silently_repaired() {
    let f = Fixture::new("corrupt");
    let mut repo = f.open().unwrap();
    let one = write_commit(&mut repo, "one", None);
    advance(&mut repo, one);
    let tree_blob = {
        let root = repo
            .read_root(&repo.read_commit(&one).unwrap().root)
            .unwrap();
        let tree = repo
            .read_tree(root.folders.values().next().unwrap())
            .unwrap();
        tree.entries()[0].id
    };
    drop(repo);
    let segment = f.store().join("objects").join("seg-00000001.ylseg");
    let pristine = fs::read(&segment).unwrap();

    // A flipped bit inside an object: the object is refused, the store still opens.
    let mut flipped = pristine.clone();
    let at = flipped
        .windows(3)
        .position(|w| w == b"one")
        .expect("the blob's bytes");
    flipped[at] ^= 0x01;
    fs::write(&segment, &flipped).unwrap();
    let repo = f.open().unwrap();
    assert_eq!(
        repo.read_blob(&tree_blob, 100).unwrap_err().code(),
        "CorruptObject"
    );
    assert!(repo
        .verify(true)
        .iter()
        .any(|finding| matches!(finding, Finding::CorruptObject { .. })));
    drop(repo);

    // A truncated segment (no trailer): quarantined, reported, the ref left as it was.
    fs::write(&segment, &pristine[..pristine.len() - 10]).unwrap();
    let repo = f.open().unwrap();
    assert!(repo.findings().iter().any(|finding| matches!(
        finding,
        Finding::UnreadableSegment {
            quarantined: Some(_),
            ..
        }
    )));
    assert!(repo
        .findings()
        .iter()
        .any(|finding| matches!(finding, Finding::DanglingRef { .. })));
    assert_eq!(
        repo.refs().head_commit(),
        Some(one),
        "the ref is not rewritten"
    );
    assert!(!segment.exists());
    drop(repo);

    // Putting the good segment back makes the history whole again.
    fs::write(&segment, &pristine).unwrap();
    let repo = f.open().unwrap();
    assert!(repo.verify(true).is_empty());
    drop(repo);

    // Garbage refs.json: refused and quarantined, never read as an empty history.
    let refs_path = f.store().join("refs.json");
    let refs = fs::read(&refs_path).unwrap();
    fs::write(&refs_path, b"not json at all").unwrap();
    assert_eq!(f.open().unwrap_err().code(), "InvalidFormat");
    assert_eq!(fs::read(&refs_path).unwrap(), b"not json at all");
    fs::write(&refs_path, &refs).unwrap();
    // A newer refs.json is refused, not overwritten.
    fs::write(
        &refs_path,
        String::from_utf8(refs.clone())
            .unwrap()
            .replace("\"version\": 1", "\"version\": 5"),
    )
    .unwrap();
    assert_eq!(f.open().unwrap_err().code(), "UnsupportedVersion");
    fs::write(&refs_path, &refs).unwrap();
    // A missing refs.json in a store with history is refused too.
    fs::remove_file(&refs_path).unwrap();
    assert_eq!(f.open().unwrap_err().code(), "RecoveryRequired");
    fs::write(&refs_path, &refs).unwrap();
    assert_eq!(f.open().unwrap().refs().head_commit(), Some(one));
}

#[test]
fn a_torn_reflog_tail_is_kept_aside_and_the_log_stays_appendable() {
    let f = Fixture::new("torn");
    let mut repo = f.open().unwrap();
    let one = write_commit(&mut repo, "one", None);
    advance(&mut repo, one);
    drop(repo);
    let log = f.store().join("logs").join("refs.log");
    let mut bytes = fs::read(&log).unwrap();
    bytes.extend_from_slice(b"{\"v\":1,\"rev\":2,\"ref\":\"refs/he");
    fs::write(&log, &bytes).unwrap();

    let mut repo = f.open().unwrap();
    assert!(repo.findings().iter().any(|finding| matches!(
        finding,
        Finding::TornReflog {
            quarantined: Some(_)
        }
    )));
    assert!(listing(&f.store().join("quarantine"))
        .iter()
        .any(|name| name.starts_with("refs.log.")));
    let two = write_commit(&mut repo, "two", Some(one));
    advance(&mut repo, two);
    drop(repo);
    let repo = f.open().unwrap();
    assert!(repo.findings().is_empty(), "{:?}", repo.findings());
    assert_eq!(repo.reflog().unwrap().len(), 2);
}

#[test]
fn stores_live_under_unicode_and_long_paths() {
    let root = temp("paths");
    let project = root.join("Ünïcode 😀 Project");
    fs::create_dir_all(&project).unwrap();
    // A base over 260 characters: Windows' old path limit.
    let mut base = root.join("appdata");
    while base.as_os_str().len() < 300 {
        base = base.join("very-long-directory-name-segment");
    }
    let spec = WorkspaceSpec::from_paths(&[&project]).unwrap();
    let mut repo = Repository::open(&base, &spec, OpenOptions::default()).unwrap();
    let one = write_commit(&mut repo, "long", None);
    advance(&mut repo, one);
    drop(repo);
    let repo = Repository::open(&base, &spec, OpenOptions::default()).unwrap();
    assert_eq!(repo.refs().head_commit(), Some(one));
    assert!(repo.verify(true).is_empty());
}

#[cfg(windows)]
#[test]
fn an_extended_length_spelling_of_the_folder_is_the_same_workspace() {
    let f = Fixture::new("verbatim");
    drop(f.open().unwrap());
    // The fixture's path is canonical (already `\\?\C:\...`): build both spellings from the
    // plain form.
    let plain = ide_workspace::file_tree::clean_path_str(&f.project).replace('/', "\\");
    let verbatim = format!("\\\\?\\{plain}");
    let lower = plain.to_lowercase();
    for spelling in [verbatim, lower] {
        let spec = WorkspaceSpec::from_paths(&[spelling.as_str()]).unwrap();
        assert_eq!(spec.key(), f.spec.key(), "{spelling}");
        assert_eq!(
            Repository::open(&f.base, &spec, OpenOptions::default())
                .unwrap()
                .meta()
                .workspace_id,
            f.spec.workspace_id
        );
    }
}
