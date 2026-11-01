//! The reflog: an append-only record of every ref change, written before `refs.json` is.
//!
//! One JSON object per line, `{"v":1,"rev":…,"ref":…,"old":…,"new":…,"ms":…,"op":…,"reason":…}`,
//! plus `{"v":1,"rev":…,"aborted":true,"ms":…}` markers for an update that reached the reflog but
//! not `refs.json` (a crash in between) and was therefore not applied. It is the evidence later
//! recovery tooling works from: nothing in it is rewritten or removed, except a half-written
//! last line, which is first copied to `quarantine/`.

use crate::error::{LgError, Result};
use crate::fault::{self, FaultPoint};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

pub const REFLOG_VERSION: u64 = 1;

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ReflogRecord {
    Update {
        revision: u64,
        /// A ref name, or `HEAD`.
        name: String,
        /// An id, `ref: <name>` for a symbolic HEAD, or None for "did not exist".
        old: Option<String>,
        new: Option<String>,
        ms: u64,
        /// What made the change (`commit`, `checkpoint`, `reset`, ...), for later tooling.
        op: String,
        reason: String,
    },
    /// The update at `revision` was never applied to `refs.json`.
    Aborted { revision: u64, ms: u64 },
}

impl ReflogRecord {
    pub fn revision(&self) -> u64 {
        match self {
            ReflogRecord::Update { revision, .. } | ReflogRecord::Aborted { revision, .. } => {
                *revision
            }
        }
    }

    pub fn to_line(&self) -> String {
        let value = match self {
            ReflogRecord::Update {
                revision,
                name,
                old,
                new,
                ms,
                op,
                reason,
            } => json!({
                "v": REFLOG_VERSION, "rev": revision, "ref": name, "old": old, "new": new,
                "ms": ms, "op": op, "reason": reason,
            }),
            ReflogRecord::Aborted { revision, ms } => {
                json!({ "v": REFLOG_VERSION, "rev": revision, "aborted": true, "ms": ms })
            }
        };
        let mut line = value.to_string();
        line.push('\n');
        line
    }

    fn parse(line: &str) -> Result<ReflogRecord> {
        let bad = |why: &str| LgError::InvalidFormat(format!("reflog: {why}: {line:?}"));
        let value: Value = serde_json::from_str(line).map_err(|_| bad("not JSON"))?;
        let version = value
            .get("v")
            .and_then(Value::as_u64)
            .ok_or_else(|| bad("no v"))?;
        if version > REFLOG_VERSION {
            return Err(LgError::UnsupportedVersion {
                what: "reflog".into(),
                found: version,
                supported: REFLOG_VERSION,
            });
        }
        let revision = value
            .get("rev")
            .and_then(Value::as_u64)
            .ok_or_else(|| bad("no rev"))?;
        let ms = value.get("ms").and_then(Value::as_u64).unwrap_or(0);
        if value.get("aborted").and_then(Value::as_bool) == Some(true) {
            return Ok(ReflogRecord::Aborted { revision, ms });
        }
        let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
        Ok(ReflogRecord::Update {
            revision,
            name: text("ref").ok_or_else(|| bad("no ref"))?,
            old: text("old"),
            new: text("new"),
            ms,
            op: text("op").unwrap_or_default(),
            reason: text("reason").unwrap_or_default(),
        })
    }
}

/// Appends records durably: one write, then `sync_data`.
pub fn append(path: &Path, records: &[ReflogRecord]) -> Result<()> {
    if records.is_empty() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let bytes: String = records.iter().map(ReflogRecord::to_line).collect();
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    let half = bytes.len() / 2;
    file.write_all(&bytes.as_bytes()[..half])?;
    fault::hit(FaultPoint::ReflogPartlyAppended);
    file.write_all(&bytes.as_bytes()[half..])?;
    file.sync_data()?;
    fault::hit(FaultPoint::ReflogAppended);
    Ok(())
}

pub struct ReflogRead {
    pub records: Vec<ReflogRecord>,
    /// The file ends in part of a line (a crash while appending).
    pub torn: bool,
    /// The length of the file up to the end of its last complete line.
    pub complete_len: u64,
}

/// Reads every complete record. A half-written last line is reported as `torn`; an unreadable
/// line anywhere else means the log was damaged, and is an error rather than something to skip.
pub fn read(path: &Path) -> Result<ReflogRead> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ReflogRead {
                records: Vec::new(),
                torn: false,
                complete_len: 0,
            })
        }
        Err(error) => return Err(error.into()),
    };
    let complete_len = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
    let torn = complete_len < bytes.len();
    let text = std::str::from_utf8(&bytes[..complete_len])
        .map_err(|_| LgError::InvalidFormat("reflog: not UTF-8".into()))?;
    let mut records = Vec::new();
    for line in text.lines() {
        records.push(ReflogRecord::parse(line)?);
    }
    Ok(ReflogRead {
        records,
        torn,
        complete_len: complete_len as u64,
    })
}
