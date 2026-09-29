//! Segment files: immutable containers of many objects.
//!
//! One file per object would mean hundreds of thousands of files (slow on NTFS, slower under
//! antivirus scanning, and a flush per file); a segment holds everything one write transaction
//! adds, written sequentially, synced once and renamed into place once.
//!
//! ```text
//! Header  "YLSEG\0\0\0" version:u32 hash:u32 created_ms:u64 reserved:u64       (32 bytes)
//! Entry*  kind:u8 codec:u8 len:u64 stored_len:u64 bytes[stored_len]            (18 + n)
//! Index   (id[32] offset:u64 kind:u8)*  sorted by id, no repeats               (41 each)
//! Trailer index_offset:u64 count:u64 index_sha256[32] "YLSEGEND"              (56 bytes)
//! ```
//!
//! All integers little-endian. `codec` 0 is raw (the only one in format 1; compression can
//! come later without changing ids, which are over the uncompressed bytes). Readers trust
//! nothing: the index is checked against its hash, and every object read is re-hashed.

use crate::error::{LgError, Result};
use crate::fault::{self, FaultPoint};
use crate::id::{hash_object, ObjectHasher, ObjectId, ObjectKind};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

pub const SEGMENT_VERSION: u32 = 1;
const MAGIC: &[u8; 8] = b"YLSEG\0\0\0";
const END_MAGIC: &[u8; 8] = b"YLSEGEND";
const HASH_SHA256: u32 = 1;
const HEADER_LEN: u64 = 32;
const TRAILER_LEN: u64 = 56;
const ENTRY_HEADER_LEN: u64 = 18;
const RECORD_LEN: u64 = 41;
const CODEC_RAW: u8 = 0;
/// The suffix of every temporary file this crate writes (the one `durable.rs` sweeps).
pub const TEMP_SUFFIX: &str = ".yavin-tmp";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct IndexRecord {
    pub id: ObjectId,
    pub offset: u64,
    pub kind: ObjectKind,
}

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Writes a new segment into `tmp/`, then publishes it into `objects/`. Dropping it without
/// `finish` or `abandon` leaves the temporary file behind -- which is what a crash does, and
/// what the writer's next open sweeps.
pub struct SegmentWriter {
    temp: PathBuf,
    file: BufWriter<File>,
    offset: u64,
    records: Vec<IndexRecord>,
    ids: HashSet<ObjectId>,
}

impl SegmentWriter {
    pub fn create(tmp_dir: &Path) -> Result<SegmentWriter> {
        fs::create_dir_all(tmp_dir)?;
        let temp = tmp_dir.join(format!(
            ".seg-{}-{}-{}.ylseg{TEMP_SUFFIX}",
            ide_workspace::durable::now_millis(),
            std::process::id(),
            TEMP_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let mut file = BufWriter::new(File::create_new(&temp)?);
        let mut header = Vec::with_capacity(HEADER_LEN as usize);
        header.extend_from_slice(MAGIC);
        header.extend_from_slice(&SEGMENT_VERSION.to_le_bytes());
        header.extend_from_slice(&HASH_SHA256.to_le_bytes());
        header.extend_from_slice(&(ide_workspace::durable::now_millis() as u64).to_le_bytes());
        header.extend_from_slice(&0u64.to_le_bytes());
        file.write_all(&header)?;
        fault::hit(FaultPoint::SegmentTempCreated);
        Ok(SegmentWriter {
            temp,
            file,
            offset: HEADER_LEN,
            records: Vec::new(),
            ids: HashSet::new(),
        })
    }

    pub fn contains(&self, id: &ObjectId) -> bool {
        self.ids.contains(id)
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    fn entry_header(&mut self, kind: ObjectKind, len: u64) -> Result<u64> {
        let offset = self.offset;
        let mut header = [0u8; ENTRY_HEADER_LEN as usize];
        header[0] = kind as u8;
        header[1] = CODEC_RAW;
        header[2..10].copy_from_slice(&len.to_le_bytes());
        header[10..18].copy_from_slice(&len.to_le_bytes());
        self.file.write_all(&header)?;
        self.offset += ENTRY_HEADER_LEN;
        Ok(offset)
    }

    /// Adds an object held in memory. Returns its id; one already in this segment is not
    /// written twice.
    pub fn put(&mut self, kind: ObjectKind, payload: &[u8]) -> Result<ObjectId> {
        let id = hash_object(kind, payload);
        if self.ids.contains(&id) {
            return Ok(id);
        }
        let offset = self.entry_header(kind, payload.len() as u64)?;
        self.file.write_all(payload)?;
        self.offset += payload.len() as u64;
        self.records.push(IndexRecord { id, offset, kind });
        self.ids.insert(id);
        if self.records.len() == 2 {
            fault::hit(FaultPoint::SegmentPartlyWritten);
        }
        Ok(id)
    }

    /// Adds a blob of `len` bytes read from `reader`, hashing while it copies (64 KiB at a
    /// time, never the whole content in memory). The id is only known at the end, so a blob
    /// already in this segment still costs its bytes here; they are then left out of the index
    /// (a blob already in an earlier segment is indexed again here: the same bytes, harmless).
    /// Returns its id.
    pub fn put_stream(&mut self, len: u64, reader: &mut impl Read) -> Result<ObjectId> {
        let offset = self.entry_header(ObjectKind::Blob, len)?;
        let mut hasher = ObjectHasher::new(ObjectKind::Blob, len);
        let mut buffer = vec![0u8; 64 * 1024];
        let mut left = len;
        while left > 0 {
            let want = left.min(buffer.len() as u64) as usize;
            let got = reader.read(&mut buffer[..want])?;
            if got == 0 {
                return Err(LgError::InvalidFormat(format!(
                    "the content ended {left} bytes early"
                )));
            }
            hasher.update(&buffer[..got])?;
            self.file.write_all(&buffer[..got])?;
            left -= got as u64;
        }
        let mut probe = [0u8; 1];
        if reader.read(&mut probe)? != 0 {
            return Err(LgError::InvalidFormat(
                "the content is longer than its declared length".into(),
            ));
        }
        self.offset += len;
        let id = hasher.finish()?;
        if self.ids.insert(id) {
            self.records.push(IndexRecord {
                id,
                offset,
                kind: ObjectKind::Blob,
            });
        }
        Ok(id)
    }

    /// Writes the index and trailer, syncs, checks the result reads back, and renames it into
    /// `objects/<name>`. Only after this returns are its objects durable and may anything
    /// refer to them. On an error the temporary file is removed and nothing is published.
    pub fn finish(mut self, objects_dir: &Path, name: &str) -> Result<Vec<IndexRecord>> {
        let result = self.write_tail().and_then(|()| {
            let records = read_index(&self.temp)?;
            fs::create_dir_all(objects_dir)?;
            let target = objects_dir.join(name);
            if target.exists() {
                return Err(LgError::Io(format!("{} already exists", target.display())));
            }
            fs::rename(&self.temp, &target)?;
            sync_folder(objects_dir);
            fault::hit(FaultPoint::SegmentRenamed);
            Ok(records)
        });
        if result.is_err() {
            let _ = fs::remove_file(&self.temp);
        }
        result
    }

    fn write_tail(&mut self) -> Result<()> {
        self.records.sort_by_key(|record| record.id);
        let mut index = Vec::with_capacity(self.records.len() * RECORD_LEN as usize);
        for record in &self.records {
            index.extend_from_slice(record.id.as_bytes());
            index.extend_from_slice(&record.offset.to_le_bytes());
            index.push(record.kind as u8);
        }
        let digest = Sha256::digest(&index);
        let mut trailer = Vec::with_capacity(TRAILER_LEN as usize);
        trailer.extend_from_slice(&self.offset.to_le_bytes());
        trailer.extend_from_slice(&(self.records.len() as u64).to_le_bytes());
        trailer.extend_from_slice(&digest);
        trailer.extend_from_slice(END_MAGIC);
        self.file.write_all(&index)?;
        self.file.write_all(&trailer)?;
        self.file.flush()?;
        fault::hit(FaultPoint::SegmentWritten);
        self.file.get_ref().sync_all()?;
        fault::hit(FaultPoint::SegmentSynced);
        Ok(())
    }

    /// Discards the segment: nothing was published.
    pub fn abandon(self) {
        let temp = self.temp.clone();
        drop(self);
        let _ = fs::remove_file(temp);
    }
}

#[cfg(unix)]
fn sync_folder(folder: &Path) {
    if let Ok(dir) = File::open(folder) {
        let _ = dir.sync_all();
    }
}

/// Windows cannot flush a directory through std; the rename itself is atomic on one volume.
#[cfg(not(unix))]
fn sync_folder(_folder: &Path) {}

fn corrupt(path: &Path, detail: impl Into<String>) -> LgError {
    LgError::CorruptSegment {
        segment: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        detail: detail.into(),
    }
}

/// Reads and checks a segment's index: header, trailer, index hash, record order and offsets.
/// Reads 32 + 56 bytes plus the index -- never the objects -- so opening a store is cheap.
pub fn read_index(path: &Path) -> Result<Vec<IndexRecord>> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    if len < HEADER_LEN + TRAILER_LEN {
        return Err(corrupt(path, "too short to be a segment"));
    }
    let mut header = [0u8; HEADER_LEN as usize];
    file.read_exact(&mut header)?;
    if &header[..8] != MAGIC {
        return Err(corrupt(path, "not a segment"));
    }
    let version = u32::from_le_bytes(header[8..12].try_into().expect("4 bytes"));
    if version != SEGMENT_VERSION {
        return Err(LgError::UnsupportedVersion {
            what: format!("segment {}", path.display()),
            found: version.into(),
            supported: SEGMENT_VERSION.into(),
        });
    }
    if u32::from_le_bytes(header[12..16].try_into().expect("4 bytes")) != HASH_SHA256 {
        return Err(corrupt(path, "unknown hash algorithm"));
    }
    file.seek(SeekFrom::Start(len - TRAILER_LEN))?;
    let mut trailer = [0u8; TRAILER_LEN as usize];
    file.read_exact(&mut trailer)?;
    if &trailer[48..56] != END_MAGIC {
        return Err(corrupt(path, "no trailer (an incomplete write?)"));
    }
    let index_offset = u64::from_le_bytes(trailer[0..8].try_into().expect("8 bytes"));
    let count = u64::from_le_bytes(trailer[8..16].try_into().expect("8 bytes"));
    let index_len = count
        .checked_mul(RECORD_LEN)
        .ok_or_else(|| corrupt(path, "impossible object count"))?;
    if index_offset < HEADER_LEN || index_offset.checked_add(index_len) != Some(len - TRAILER_LEN) {
        return Err(corrupt(path, "the index does not fit the file"));
    }
    let mut index = vec![0u8; index_len as usize];
    file.seek(SeekFrom::Start(index_offset))?;
    file.read_exact(&mut index)?;
    if Sha256::digest(&index).as_slice() != &trailer[16..48] {
        return Err(corrupt(path, "the index does not match its checksum"));
    }
    let mut records = Vec::with_capacity(count as usize);
    for raw in index.chunks(RECORD_LEN as usize) {
        let record = IndexRecord {
            id: ObjectId::from_bytes(&raw[..32])?,
            offset: u64::from_le_bytes(raw[32..40].try_into().expect("8 bytes")),
            kind: ObjectKind::from_u8(raw[40]).map_err(|e| corrupt(path, e.to_string()))?,
        };
        if record.offset < HEADER_LEN || record.offset + ENTRY_HEADER_LEN > index_offset {
            return Err(corrupt(path, "an object lies outside the segment"));
        }
        if records
            .last()
            .is_some_and(|last: &IndexRecord| last.id >= record.id)
        {
            return Err(corrupt(path, "index out of order"));
        }
        records.push(record);
    }
    Ok(records)
}

/// The size and kind stored for the object at `offset`, from its entry header only.
pub fn entry_info(path: &Path, offset: u64) -> Result<(ObjectKind, u64)> {
    let mut file = File::open(path)?;
    let (kind, len) = read_entry_header(path, &mut file, offset)?;
    Ok((kind, len))
}

fn read_entry_header(path: &Path, file: &mut File, offset: u64) -> Result<(ObjectKind, u64)> {
    file.seek(SeekFrom::Start(offset))?;
    let mut header = [0u8; ENTRY_HEADER_LEN as usize];
    file.read_exact(&mut header)
        .map_err(|_| corrupt(path, format!("truncated object at {offset}")))?;
    let kind = ObjectKind::from_u8(header[0]).map_err(|e| corrupt(path, e.to_string()))?;
    if header[1] != CODEC_RAW {
        return Err(corrupt(path, format!("unknown codec {}", header[1])));
    }
    let len = u64::from_le_bytes(header[2..10].try_into().expect("8 bytes"));
    let stored = u64::from_le_bytes(header[10..18].try_into().expect("8 bytes"));
    if stored != len {
        return Err(corrupt(
            path,
            "stored length differs from length (raw codec)",
        ));
    }
    Ok((kind, len))
}

/// Reads one object and checks it hashes to `expected`: stored bytes are never trusted.
/// `max_len` refuses to load anything bigger (use `stream_object` for large blobs).
pub fn read_object(
    path: &Path,
    offset: u64,
    expected: &ObjectId,
    max_len: u64,
) -> Result<(ObjectKind, Vec<u8>)> {
    let mut file = File::open(path)?;
    let (kind, len) = read_entry_header(path, &mut file, offset)?;
    if len > max_len {
        return Err(LgError::InvalidFormat(format!(
            "{expected} is {len} bytes, more than the {max_len} asked for"
        )));
    }
    let mut payload = vec![0u8; len as usize];
    file.read_exact(&mut payload)
        .map_err(|_| LgError::CorruptObject {
            id: *expected,
            detail: "truncated".into(),
        })?;
    if hash_object(kind, &payload) != *expected {
        return Err(LgError::CorruptObject {
            id: *expected,
            detail: "its bytes do not hash to its id".into(),
        });
    }
    Ok((kind, payload))
}

/// Copies one object into `out` 64 KiB at a time, checking its hash at the end. On a mismatch
/// the caller must discard what was written (the error says so).
pub fn stream_object(
    path: &Path,
    offset: u64,
    expected: &ObjectId,
    out: &mut impl Write,
) -> Result<u64> {
    let mut file = File::open(path)?;
    let (kind, len) = read_entry_header(path, &mut file, offset)?;
    let mut hasher = ObjectHasher::new(kind, len);
    let mut buffer = vec![0u8; 64 * 1024];
    let mut left = len;
    while left > 0 {
        let want = left.min(buffer.len() as u64) as usize;
        file.read_exact(&mut buffer[..want])
            .map_err(|_| LgError::CorruptObject {
                id: *expected,
                detail: "truncated".into(),
            })?;
        hasher.update(&buffer[..want])?;
        out.write_all(&buffer[..want])?;
        left -= want as u64;
    }
    if hasher.finish()? != *expected {
        return Err(LgError::CorruptObject {
            id: *expected,
            detail: "its bytes do not hash to its id (discard what was read)".into(),
        });
    }
    Ok(len)
}
