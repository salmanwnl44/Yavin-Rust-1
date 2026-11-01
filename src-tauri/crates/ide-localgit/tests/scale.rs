//! Measurements at realistic scale (run on purpose, in release):
//! `cargo test -p ide-localgit --release --test scale -- --ignored --nocapture`
//!
//! Loose budgets only catch gross regressions (a file per object, reading every object at open);
//! the numbers printed are what the report records.

mod common;

use common::*;

use std::time::Instant;

fn content(i: usize) -> Vec<u8> {
    // Median ~1.5 KiB, some larger, all distinct.
    let len = 200 + (i * 7919) % 2800;
    let mut bytes = format!("object {i}\n").into_bytes();
    bytes.resize(len, b'a' + (i % 26) as u8);
    bytes
}

fn measure(count: usize) {
    let f = Fixture::new(&format!("scale-{count}"));
    let mut repo = f.open().unwrap();

    let started = Instant::now();
    let mut txn = repo.begin_write().unwrap();
    let mut ids = Vec::with_capacity(count);
    for i in 0..count {
        ids.push(txn.put_blob(&content(i)).unwrap());
    }
    txn.commit().unwrap();
    let write = started.elapsed();

    let started = Instant::now();
    let mut txn = repo.begin_write().unwrap();
    for i in 0..count {
        txn.put_blob(&content(i)).unwrap();
    }
    txn.commit().unwrap();
    let duplicates = started.elapsed();
    assert_eq!(repo.segment_count(), 1, "duplicates add no segment");

    let files = listing(&f.store().join("objects")).len();
    let bytes = repo.storage_bytes();
    drop(repo);

    let started = Instant::now();
    let repo = f.open().unwrap();
    let reopen = started.elapsed();
    assert_eq!(repo.object_count(), count);

    let started = Instant::now();
    for id in ids.iter().step_by((count / 1000).max(1)) {
        repo.read_blob(id, 1 << 20).unwrap();
    }
    let reads = started.elapsed() / (count / (count / 1000).max(1)) as u32;
    drop(repo);

    let mut repo = f.open().unwrap();
    let commit = write_commit(&mut repo, "scale", None);
    let started = Instant::now();
    let updates = 100;
    let mut parent = commit;
    advance(&mut repo, commit);
    for i in 0..updates {
        let next = write_commit(&mut repo, &format!("u{i}"), Some(parent));
        advance(&mut repo, next);
        parent = next;
    }
    let per_update = started.elapsed() / updates;

    println!(
        "{count} objects: write {write:?} ({:.0}/s), duplicates {duplicates:?}, {files} file(s) \
         in objects/, {:.1} MB, reopen {reopen:?}, read {reads:?}/object, \
         commit+ref update {per_update:?} each",
        count as f64 / write.as_secs_f64(),
        bytes as f64 / 1e6
    );
    assert_eq!(files, 1, "one segment, not a file per object");
    assert!(reopen.as_secs_f64() < 5.0, "reopen {reopen:?}");
}

#[test]
#[ignore]
fn scale_10k_objects() {
    measure(10_000);
}

#[test]
#[ignore]
fn scale_100k_objects() {
    measure(100_000);
}
