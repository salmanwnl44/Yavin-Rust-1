//! The object database: every object in every published segment, found through an in-memory
//! index built from the segments' own indexes (never by reading objects) when the store opens.

use crate::error::{LgError, Result};
use crate::finding::Finding;
use crate::id::{ObjectId, ObjectKind};
use crate::segment::{self, IndexRecord};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug)]
struct Loc {
    segment: u32,
    offset: u64,
    kind: ObjectKind,
}

pub struct ObjectDb {
    objects_dir: PathBuf,
    segments: Vec<PathBuf>,
    index: HashMap<ObjectId, Loc>,
    next_seq: u64,
}

/// `seg-00000001.ylseg`: numbered so they list in the order they were written.
fn segment_seq(name: &str) -> Option<u64> {
    name.strip_prefix("seg-")?
        .strip_suffix(".ylseg")?
        .parse()
        .ok()
}

impl ObjectDb {
    /// Indexes every segment. One that cannot be read is moved to `quarantine` when given
    /// (the writer), or left where it is (a read-only reader); either way it is reported and the
    /// rest of the store stays usable.
    pub fn load(objects_dir: &Path, quarantine: Option<&Path>) -> Result<(ObjectDb, Vec<Finding>)> {
        let mut findings = Vec::new();
        let mut names: Vec<(u64, String)> = Vec::new();
        if objects_dir.exists() {
            for entry in fs::read_dir(objects_dir)? {
                let name = entry?.file_name().to_string_lossy().into_owned();
                if let Some(seq) = segment_seq(&name) {
                    names.push((seq, name));
                }
            }
        }
        names.sort();
        let mut db = ObjectDb {
            objects_dir: objects_dir.to_path_buf(),
            segments: Vec::new(),
            index: HashMap::new(),
            next_seq: names.last().map(|(seq, _)| seq + 1).unwrap_or(1),
        };
        for (_, name) in names {
            let path = objects_dir.join(&name);
            match segment::read_index(&path) {
                Ok(records) => db.add(path, &records),
                Err(error) => {
                    let quarantined = quarantine.and_then(|dir| {
                        let target = dir.join(format!(
                            "{name}.{}.corrupt",
                            ide_workspace::durable::now_millis()
                        ));
                        fs::create_dir_all(dir).ok()?;
                        fs::rename(&path, &target).ok()?;
                        Some(target.file_name()?.to_string_lossy().into_owned())
                    });
                    findings.push(Finding::UnreadableSegment {
                        segment: name,
                        reason: error.to_string(),
                        quarantined,
                    });
                }
            }
        }
        Ok((db, findings))
    }

    fn add(&mut self, path: PathBuf, records: &[IndexRecord]) {
        let segment = self.segments.len() as u32;
        self.segments.push(path);
        for record in records {
            // The first copy wins; a duplicate in a later segment (left by an interrupted
            // compaction or a re-written object) is the same bytes by definition.
            self.index.entry(record.id).or_insert(Loc {
                segment,
                offset: record.offset,
                kind: record.kind,
            });
        }
    }

    /// Makes a finished segment's objects visible. Called only once it is durably in place.
    pub(crate) fn publish(&mut self, path: PathBuf, records: &[IndexRecord]) {
        self.add(path, records);
        self.next_seq += 1;
    }

    pub(crate) fn next_segment_name(&self) -> String {
        format!("seg-{:08}.ylseg", self.next_seq)
    }

    pub(crate) fn objects_dir(&self) -> &Path {
        &self.objects_dir
    }

    pub fn contains(&self, id: &ObjectId) -> bool {
        self.index.contains_key(id)
    }

    pub fn kind_of(&self, id: &ObjectId) -> Option<ObjectKind> {
        self.index.get(id).map(|loc| loc.kind)
    }

    pub fn object_count(&self) -> usize {
        self.index.len()
    }

    pub fn segment_count(&self) -> usize {
        self.segments.len()
    }

    /// The bytes the segments take on disk.
    pub fn storage_bytes(&self) -> u64 {
        self.segments
            .iter()
            .filter_map(|path| fs::metadata(path).ok())
            .map(|meta| meta.len())
            .sum()
    }

    fn loc(&self, id: &ObjectId) -> Result<(Loc, &Path)> {
        let loc = *self.index.get(id).ok_or(LgError::MissingObject(*id))?;
        Ok((loc, &self.segments[loc.segment as usize]))
    }

    /// An object's kind and payload, re-hashed. Refuses objects over `max_len` bytes.
    pub fn read(&self, id: &ObjectId, max_len: u64) -> Result<(ObjectKind, Vec<u8>)> {
        let (loc, path) = self.loc(id)?;
        segment::read_object(path, loc.offset, id, max_len)
    }

    /// An object's kind and size, from its entry header only.
    pub fn info(&self, id: &ObjectId) -> Result<(ObjectKind, u64)> {
        let (loc, path) = self.loc(id)?;
        segment::entry_info(path, loc.offset)
    }

    /// Copies a (possibly large) object into `out`, checking its hash as it goes.
    pub fn stream(&self, id: &ObjectId, out: &mut impl Write) -> Result<u64> {
        let (loc, path) = self.loc(id)?;
        segment::stream_object(path, loc.offset, id, out)
    }

    /// Every object id, for a full verify.
    pub fn ids(&self) -> impl Iterator<Item = &ObjectId> {
        self.index.keys()
    }
}
