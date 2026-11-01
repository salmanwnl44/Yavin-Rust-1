//! Object identity: SHA-256 over a domain-separated header and the canonical payload.
//!
//! `id = sha256("ylg1 " + kind + " " + decimal(len) + "\0" + payload)`
//!
//! The domain (`ylg1`) and the kind are part of what is hashed, so a blob whose bytes happen
//! to be a valid tree encoding never shares an id with that tree, and a later format (`ylg2`)
//! can coexist with this one. xxh3 (used elsewhere for checksums) is not collision resistant
//! and is never used for identity: in a content-addressed store a collision silently swaps one
//! file's content for another's.

use crate::error::{LgError, Result};
use sha2::{Digest, Sha256};
use std::fmt;
use std::io::Read;

/// The hash domain and version of every object id this crate produces.
pub const HASH_DOMAIN: &str = "ylg1";
/// The hash algorithm, as recorded in `workspace.json`.
pub const HASH_ALGORITHM: &str = "sha256";

#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ObjectId([u8; 32]);

impl ObjectId {
    pub fn from_bytes(bytes: &[u8]) -> Result<ObjectId> {
        let array: [u8; 32] = bytes
            .try_into()
            .map_err(|_| LgError::InvalidObjectId(format!("{} bytes, expected 32", bytes.len())))?;
        Ok(ObjectId(array))
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// 64 lowercase hexadecimal digits: the only spelling this crate writes or accepts.
    pub fn to_hex(&self) -> String {
        const DIGITS: &[u8; 16] = b"0123456789abcdef";
        let mut out = String::with_capacity(64);
        for byte in self.0 {
            out.push(DIGITS[(byte >> 4) as usize] as char);
            out.push(DIGITS[(byte & 15) as usize] as char);
        }
        out
    }

    /// Parses the canonical form only: exactly 64 lowercase hex digits. Uppercase is refused
    /// rather than folded, so one object never has two accepted spellings.
    pub fn from_hex(text: &str) -> Result<ObjectId> {
        let bytes = text.as_bytes();
        if bytes.len() != 64 {
            return Err(LgError::InvalidObjectId(format!(
                "{} characters, expected 64",
                bytes.len()
            )));
        }
        let digit = |c: u8| match c {
            b'0'..=b'9' => Ok(c - b'0'),
            b'a'..=b'f' => Ok(c - b'a' + 10),
            _ => Err(LgError::InvalidObjectId(format!(
                "not a lowercase hex digit: {:?}",
                c as char
            ))),
        };
        let mut out = [0u8; 32];
        for (i, pair) in bytes.chunks(2).enumerate() {
            out[i] = (digit(pair[0])? << 4) | digit(pair[1])?;
        }
        Ok(ObjectId(out))
    }
}

impl fmt::Display for ObjectId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_hex())
    }
}

impl fmt::Debug for ObjectId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ObjectId({})", self.to_hex())
    }
}

/// What an object is. The numbers are part of the stored format and never change meaning.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[repr(u8)]
pub enum ObjectKind {
    Blob = 1,
    Tree = 2,
    /// The workspace root: one tree per workspace folder, keyed by folder id.
    Root = 3,
    Commit = 4,
}

impl ObjectKind {
    pub fn name(self) -> &'static str {
        match self {
            ObjectKind::Blob => "blob",
            ObjectKind::Tree => "tree",
            ObjectKind::Root => "root",
            ObjectKind::Commit => "commit",
        }
    }

    pub fn from_u8(value: u8) -> Result<ObjectKind> {
        Ok(match value {
            1 => ObjectKind::Blob,
            2 => ObjectKind::Tree,
            3 => ObjectKind::Root,
            4 => ObjectKind::Commit,
            other => {
                return Err(LgError::InvalidFormat(format!(
                    "unknown object kind {other}"
                )))
            }
        })
    }
}

/// Hashes an object whose length is known up front, fed in pieces (a streamed blob).
pub struct ObjectHasher {
    inner: Sha256,
    remaining: u64,
    kind: ObjectKind,
}

impl ObjectHasher {
    pub fn new(kind: ObjectKind, len: u64) -> ObjectHasher {
        let mut inner = Sha256::new();
        inner.update(format!("{HASH_DOMAIN} {} {len}\0", kind.name()).as_bytes());
        ObjectHasher {
            inner,
            remaining: len,
            kind,
        }
    }

    pub fn update(&mut self, bytes: &[u8]) -> Result<()> {
        let len = bytes.len() as u64;
        if len > self.remaining {
            return Err(LgError::InvalidFormat(format!(
                "{} is longer than its declared length",
                self.kind.name()
            )));
        }
        self.remaining -= len;
        self.inner.update(bytes);
        Ok(())
    }

    pub fn finish(self) -> Result<ObjectId> {
        if self.remaining != 0 {
            return Err(LgError::InvalidFormat(format!(
                "{} is {} bytes shorter than its declared length",
                self.kind.name(),
                self.remaining
            )));
        }
        ObjectId::from_bytes(&self.inner.finalize())
    }
}

/// The id of an object whose whole payload is in memory.
pub fn hash_object(kind: ObjectKind, payload: &[u8]) -> ObjectId {
    let mut hasher = ObjectHasher::new(kind, payload.len() as u64);
    hasher
        .update(payload)
        .expect("the declared length is the payload's");
    hasher.finish().expect("the whole payload was hashed")
}

/// The id a blob of `len` bytes read from `reader` would have, without storing it: how a file
/// over the storage limit is still identified ("hashed, content not stored"). Reads exactly
/// `len` bytes in 64 KiB pieces and refuses a reader that ends early or runs long.
pub fn hash_blob_stream(len: u64, reader: &mut impl Read) -> Result<ObjectId> {
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
        left -= got as u64;
    }
    let mut probe = [0u8; 1];
    if reader.read(&mut probe)? != 0 {
        return Err(LgError::InvalidFormat(
            "the content is longer than its declared length".into(),
        ));
    }
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_the_sha256_of_the_domain_header_and_payload() {
        // Golden values: these must never change, or every stored object changes identity.
        assert_eq!(hash_object(ObjectKind::Blob, b"").to_hex(), {
            let mut h = Sha256::new();
            h.update(b"ylg1 blob 0\0");
            ObjectId::from_bytes(&h.finalize()).unwrap().to_hex()
        });
        let hello = hash_object(ObjectKind::Blob, b"hello\n");
        let mut h = Sha256::new();
        h.update(b"ylg1 blob 6\0hello\n");
        assert_eq!(hello.as_bytes().as_slice(), h.finalize().as_slice());
        // The kind is part of the identity.
        assert_ne!(
            hash_object(ObjectKind::Blob, b"x"),
            hash_object(ObjectKind::Tree, b"x")
        );
        // Deterministic.
        assert_eq!(hello, hash_object(ObjectKind::Blob, b"hello\n"));
    }

    #[test]
    fn hex_round_trips_and_only_the_canonical_spelling_is_accepted() {
        let id = hash_object(ObjectKind::Blob, b"round trip");
        let hex = id.to_hex();
        assert_eq!(hex.len(), 64);
        assert_eq!(ObjectId::from_hex(&hex).unwrap(), id);
        assert_eq!(ObjectId::from_bytes(id.as_bytes()).unwrap(), id);
        assert_eq!(
            ObjectId::from_hex(&hex.to_uppercase()).unwrap_err().code(),
            "InvalidObjectId"
        );
        assert!(ObjectId::from_hex(&hex[..63]).is_err());
        assert!(ObjectId::from_hex(&format!("{hex}0")).is_err());
        assert!(ObjectId::from_hex(&format!("{}g", &hex[..63])).is_err());
        assert!(ObjectId::from_bytes(&[0u8; 31]).is_err());
        assert!(ObjectId::from_bytes(&[0u8; 33]).is_err());
    }

    #[test]
    fn a_streamed_blob_has_the_same_id_as_the_whole_one_and_its_length_is_enforced() {
        let data: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        let whole = hash_object(ObjectKind::Blob, &data);
        let streamed = hash_blob_stream(data.len() as u64, &mut data.as_slice()).unwrap();
        assert_eq!(whole, streamed);
        assert!(hash_blob_stream(data.len() as u64 + 1, &mut data.as_slice()).is_err());
        assert!(hash_blob_stream(data.len() as u64 - 1, &mut data.as_slice()).is_err());
    }
}
