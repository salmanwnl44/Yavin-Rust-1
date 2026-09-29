//! The objects: trees, workspace roots and commits, each with one canonical byte form.
//!
//! Every decoder is strict: it accepts exactly the bytes its encoder would produce for the
//! value it decodes, so an object has one encoding and therefore one id. Blobs are raw bytes
//! and need no codec.

use crate::error::{LgError, Result};
use crate::id::{hash_object, ObjectId, ObjectKind};
use std::collections::BTreeMap;

// --- Names ------------------------------------------------------------------------------------

/// A tree entry's name: UTF-8, 1-255 bytes, never `.` or `..`, never containing `/` or NUL.
/// Case is kept exactly: `A.ts` and `a.ts` are different names, so a case-only rename is a
/// change. Names Windows cannot create (`CON`, `a:b`, a trailing dot) are valid here -- trees
/// may describe other systems' files -- and it is the later restore step that refuses them.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct EntryName(String);

impl EntryName {
    pub fn new(name: &str) -> Result<EntryName> {
        let bad = |why: &str| Err(LgError::InvalidName(format!("{name:?}: {why}")));
        if name.is_empty() {
            return bad("empty");
        }
        if name.len() > 255 {
            return bad("longer than 255 bytes");
        }
        if name == "." || name == ".." {
            return bad("not a name");
        }
        if name.contains('/') {
            return bad("contains /");
        }
        if name.contains('\0') {
            return bad("contains NUL");
        }
        Ok(EntryName(name.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

// --- Tree -------------------------------------------------------------------------------------

/// A file's content: stored in the store, or only hashed (a file over the storage limit, whose
/// id and size are known but whose bytes were deliberately not kept).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Stored {
    Yes,
    No { size: u64 },
}

/// What a link points at, which recreating it on Windows needs to know.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LinkKind {
    /// A symbolic link to a file (or a Unix symlink, whose target kind does not matter).
    File,
    /// A Windows directory symbolic link.
    Directory,
    /// A Windows junction (a directory mount point).
    Junction,
}

/// What a tree entry is. A link's id is the blob of its target as text: a link is recorded,
/// never followed, and its target's content is never stored in its place.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EntryKind {
    File { executable: bool, stored: Stored },
    Directory,
    Symlink(LinkKind),
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct TreeEntry {
    pub name: EntryName,
    pub kind: EntryKind,
    pub id: ObjectId,
}

const KIND_FILE: u8 = 1;
const KIND_DIR: u8 = 2;
const KIND_LINK: u8 = 3;
const FLAG_EXECUTABLE: u8 = 0x01;
const FLAG_UNSTORED: u8 = 0x02;
const FLAG_DIR_TARGET: u8 = 0x04;
const FLAG_JUNCTION: u8 = 0x08;

/// A directory: its entries, sorted by name bytes, no two with one name. An empty directory is
/// a real tree (the empty tree), so it survives history.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Tree {
    entries: Vec<TreeEntry>,
}

impl Tree {
    /// Sorts `entries` into canonical order; refuses duplicate names.
    pub fn new(mut entries: Vec<TreeEntry>) -> Result<Tree> {
        entries.sort_by(|a, b| a.name.as_str().as_bytes().cmp(b.name.as_str().as_bytes()));
        for pair in entries.windows(2) {
            if pair[0].name == pair[1].name {
                return Err(LgError::InvalidName(format!(
                    "{:?} appears twice in one tree",
                    pair[0].name.as_str()
                )));
            }
        }
        Ok(Tree { entries })
    }

    pub fn entries(&self) -> &[TreeEntry] {
        &self.entries
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        for entry in &self.entries {
            let (kind, flags, size) = match entry.kind {
                EntryKind::File { executable, stored } => {
                    let mut flags = if executable { FLAG_EXECUTABLE } else { 0 };
                    let size = match stored {
                        Stored::Yes => None,
                        Stored::No { size } => {
                            flags |= FLAG_UNSTORED;
                            Some(size)
                        }
                    };
                    (KIND_FILE, flags, size)
                }
                EntryKind::Directory => (KIND_DIR, 0, None),
                EntryKind::Symlink(link) => (
                    KIND_LINK,
                    match link {
                        LinkKind::File => 0,
                        LinkKind::Directory => FLAG_DIR_TARGET,
                        LinkKind::Junction => FLAG_JUNCTION,
                    },
                    None,
                ),
            };
            out.push(kind);
            out.push(flags);
            write_varint(&mut out, entry.name.as_str().len() as u64);
            out.extend_from_slice(entry.name.as_str().as_bytes());
            out.extend_from_slice(entry.id.as_bytes());
            if let Some(size) = size {
                out.extend_from_slice(&size.to_le_bytes());
            }
        }
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Tree> {
        let mut at = 0usize;
        let mut entries = Vec::new();
        let bad = |why: String| LgError::InvalidFormat(format!("tree: {why}"));
        while at < bytes.len() {
            let kind = bytes[at];
            let flags = *bytes
                .get(at + 1)
                .ok_or_else(|| bad("truncated entry".into()))?;
            at += 2;
            let len = read_varint(bytes, &mut at).map_err(bad)? as usize;
            let name_bytes = bytes
                .get(at..at + len)
                .ok_or_else(|| bad("truncated name".into()))?;
            at += len;
            let name =
                std::str::from_utf8(name_bytes).map_err(|_| bad("a name is not UTF-8".into()))?;
            let name = EntryName::new(name)?;
            let id = ObjectId::from_bytes(
                bytes
                    .get(at..at + 32)
                    .ok_or_else(|| bad("truncated id".into()))?,
            )?;
            at += 32;
            let kind = match kind {
                KIND_FILE => {
                    if flags & !(FLAG_EXECUTABLE | FLAG_UNSTORED) != 0 {
                        return Err(bad(format!("file flags {flags:#x}")));
                    }
                    let stored = if flags & FLAG_UNSTORED != 0 {
                        let size = bytes
                            .get(at..at + 8)
                            .ok_or_else(|| bad("truncated size".into()))?;
                        at += 8;
                        Stored::No {
                            size: u64::from_le_bytes(size.try_into().expect("8 bytes")),
                        }
                    } else {
                        Stored::Yes
                    };
                    EntryKind::File {
                        executable: flags & FLAG_EXECUTABLE != 0,
                        stored,
                    }
                }
                KIND_DIR if flags == 0 => EntryKind::Directory,
                KIND_LINK => EntryKind::Symlink(match flags {
                    0 => LinkKind::File,
                    FLAG_DIR_TARGET => LinkKind::Directory,
                    FLAG_JUNCTION => LinkKind::Junction,
                    other => return Err(bad(format!("link flags {other:#x}"))),
                }),
                other => return Err(bad(format!("entry kind {other} with flags {flags:#x}"))),
            };
            if let Some(last) = entries.last() {
                let last: &TreeEntry = last;
                if last.name.as_str().as_bytes() >= name.as_str().as_bytes() {
                    return Err(bad(format!(
                        "entries out of order or repeated at {:?}",
                        name.as_str()
                    )));
                }
            }
            entries.push(TreeEntry { name, kind, id });
        }
        Ok(Tree { entries })
    }

    pub fn id(&self) -> ObjectId {
        hash_object(ObjectKind::Tree, &self.encode())
    }
}

// --- Root -------------------------------------------------------------------------------------

/// A workspace folder's stable id inside Local Git: assigned once when the store is created,
/// so absolute paths never enter object identity (a moved workspace can keep its history).
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct FolderId(String);

impl FolderId {
    /// `[a-z0-9-]`, 1-64 bytes.
    pub fn new(id: &str) -> Result<FolderId> {
        if id.is_empty()
            || id.len() > 64
            || !id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return Err(LgError::InvalidName(format!("folder id {id:?}")));
        }
        Ok(FolderId(id.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The whole workspace at one moment: each folder's tree, by folder id. A single-folder
/// workspace has a root with one entry.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Root {
    pub folders: BTreeMap<FolderId, ObjectId>,
}

impl Root {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        for (folder, tree) in &self.folders {
            out.push(folder.as_str().len() as u8);
            out.extend_from_slice(folder.as_str().as_bytes());
            out.extend_from_slice(tree.as_bytes());
        }
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Root> {
        let bad = |why: &str| LgError::InvalidFormat(format!("root: {why}"));
        let mut at = 0usize;
        let mut folders = BTreeMap::new();
        let mut last: Option<FolderId> = None;
        while at < bytes.len() {
            let len = bytes[at] as usize;
            at += 1;
            let id = bytes
                .get(at..at + len)
                .ok_or_else(|| bad("truncated folder id"))?;
            at += len;
            let folder =
                FolderId::new(std::str::from_utf8(id).map_err(|_| bad("folder id is not UTF-8"))?)?;
            let tree = ObjectId::from_bytes(
                bytes
                    .get(at..at + 32)
                    .ok_or_else(|| bad("truncated tree id"))?,
            )?;
            at += 32;
            if last.as_ref().is_some_and(|last| last >= &folder) {
                return Err(bad("folders out of order or repeated"));
            }
            last = Some(folder.clone());
            folders.insert(folder, tree);
        }
        Ok(Root { folders })
    }

    pub fn id(&self) -> ObjectId {
        hash_object(ObjectKind::Root, &self.encode())
    }
}

// --- Commit -----------------------------------------------------------------------------------

/// Who or what made a commit. The words are the stored form.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Source {
    Human,
    Ai,
    Agent,
    Automatic,
    Recovery,
    Checkpoint,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Human => "human",
            Source::Ai => "ai",
            Source::Agent => "agent",
            Source::Automatic => "automatic",
            Source::Recovery => "recovery",
            Source::Checkpoint => "checkpoint",
        }
    }

    pub fn parse(text: &str) -> Result<Source> {
        Ok(match text {
            "human" => Source::Human,
            "ai" => Source::Ai,
            "agent" => Source::Agent,
            "automatic" => Source::Automatic,
            "recovery" => Source::Recovery,
            "checkpoint" => Source::Checkpoint,
            other => return Err(LgError::InvalidFormat(format!("commit source {other:?}"))),
        })
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Author {
    pub name: String,
    /// An email address, account id or agent id: whatever identifies the author.
    pub id: String,
}

/// A point in the workspace's history.
///
/// Stored as strict text (`ylg-commit 1` then one header per line, a blank line and the
/// message) rather than JSON, whose key order and number formats are not canonical. `time` is
/// for display only; order comes from `parents` (clocks go backwards).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Commit {
    /// The workspace as recorded, unsaved editor contents included when there were any.
    pub root: ObjectId,
    /// The workspace as it was on disk, when that differs from `root`.
    pub disk_root: Option<ObjectId>,
    /// In order: the first is the mainline.
    pub parents: Vec<ObjectId>,
    /// The workspace this history belongs to (the store's workspace hash, never a path).
    pub workspace: String,
    pub author: Author,
    pub time_ms: i64,
    /// Minutes east of UTC, for showing the time as the author saw it.
    pub tz_offset_min: i16,
    pub source: Source,
    /// Small facts about the commit, sorted by key.
    pub meta: BTreeMap<String, String>,
    /// Larger structured records (a ChangeSet, AI provenance) stored as objects, by key.
    pub meta_objects: BTreeMap<String, ObjectId>,
    pub message: String,
}

const COMMIT_MAGIC: &str = "ylg-commit 1";

impl Commit {
    pub fn encode(&self) -> Result<Vec<u8>> {
        for key in self.meta.keys().chain(self.meta_objects.keys()) {
            check_meta_key(key)?;
        }
        check_token("workspace", &self.workspace)?;
        let mut text = String::new();
        text.push_str(COMMIT_MAGIC);
        text.push('\n');
        text.push_str(&format!("root {}\n", self.root));
        if let Some(disk) = self.disk_root {
            text.push_str(&format!("disk-root {disk}\n"));
        }
        for parent in &self.parents {
            text.push_str(&format!("parent {parent}\n"));
        }
        text.push_str(&format!("workspace {}\n", self.workspace));
        text.push_str(&format!(
            "author {} {}\n",
            escape(&self.author.name),
            escape(&self.author.id)
        ));
        text.push_str(&format!("time {} {}\n", self.time_ms, self.tz_offset_min));
        text.push_str(&format!("source {}\n", self.source.as_str()));
        for (key, value) in &self.meta {
            text.push_str(&format!("meta {key} {}\n", escape(value)));
        }
        for (key, id) in &self.meta_objects {
            text.push_str(&format!("metaobj {key} {id}\n"));
        }
        text.push('\n');
        text.push_str(&self.message);
        Ok(text.into_bytes())
    }

    /// Parses, then re-encodes and requires the same bytes: anything but the canonical form of
    /// what it parsed is refused, so every field is canonical without a check per field.
    pub fn decode(bytes: &[u8]) -> Result<Commit> {
        let bad = |why: String| LgError::InvalidFormat(format!("commit: {why}"));
        let text = std::str::from_utf8(bytes).map_err(|_| bad("not UTF-8".into()))?;
        let (head, message) = text
            .split_once("\n\n")
            .ok_or_else(|| bad("no blank line before the message".into()))?;
        let mut lines = head.split('\n');
        if lines.next() != Some(COMMIT_MAGIC) {
            return Err(bad("not a version 1 commit".into()));
        }
        let mut root = None;
        let mut disk_root = None;
        let mut parents = Vec::new();
        let mut workspace = None;
        let mut author = None;
        let mut time = None;
        let mut source = None;
        let mut meta = BTreeMap::new();
        let mut meta_objects = BTreeMap::new();
        for line in lines {
            let (field, value) = line
                .split_once(' ')
                .ok_or_else(|| bad(format!("line {line:?}")))?;
            match field {
                "root" => root = Some(ObjectId::from_hex(value)?),
                "disk-root" => disk_root = Some(ObjectId::from_hex(value)?),
                "parent" => parents.push(ObjectId::from_hex(value)?),
                "workspace" => workspace = Some(value.to_string()),
                "author" => {
                    let (name, id) = value
                        .split_once(' ')
                        .ok_or_else(|| bad("author needs a name and an id".into()))?;
                    author = Some(Author {
                        name: unescape(name)?,
                        id: unescape(id)?,
                    });
                }
                "time" => {
                    let (ms, tz) = value
                        .split_once(' ')
                        .ok_or_else(|| bad("time needs a zone".into()))?;
                    time = Some((
                        ms.parse::<i64>().map_err(|_| bad(format!("time {ms:?}")))?,
                        tz.parse::<i16>().map_err(|_| bad(format!("zone {tz:?}")))?,
                    ));
                }
                "source" => source = Some(Source::parse(value)?),
                "meta" => {
                    let (key, value) = value
                        .split_once(' ')
                        .ok_or_else(|| bad("meta needs a key and a value".into()))?;
                    meta.insert(key.to_string(), unescape(value)?);
                }
                "metaobj" => {
                    let (key, id) = value
                        .split_once(' ')
                        .ok_or_else(|| bad("metaobj needs a key and an id".into()))?;
                    meta_objects.insert(key.to_string(), ObjectId::from_hex(id)?);
                }
                other => return Err(bad(format!("unknown field {other:?}"))),
            }
        }
        let (time_ms, tz_offset_min) = time.ok_or_else(|| bad("no time".into()))?;
        let commit = Commit {
            root: root.ok_or_else(|| bad("no root".into()))?,
            disk_root,
            parents,
            workspace: workspace.ok_or_else(|| bad("no workspace".into()))?,
            author: author.ok_or_else(|| bad("no author".into()))?,
            time_ms,
            tz_offset_min,
            source: source.ok_or_else(|| bad("no source".into()))?,
            meta,
            meta_objects,
            message: message.to_string(),
        };
        if commit.encode()? != bytes {
            return Err(bad("not in canonical form".into()));
        }
        Ok(commit)
    }

    pub fn id(&self) -> Result<ObjectId> {
        Ok(hash_object(ObjectKind::Commit, &self.encode()?))
    }
}

fn check_meta_key(key: &str) -> Result<()> {
    let bytes = key.as_bytes();
    let ok = !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
        });
    if ok {
        Ok(())
    } else {
        Err(LgError::InvalidName(format!("metadata key {key:?}")))
    }
}

fn check_token(what: &str, value: &str) -> Result<()> {
    if value.is_empty() || value.bytes().any(|b| b <= b' ' || b == b'%') {
        return Err(LgError::InvalidName(format!("{what} {value:?}")));
    }
    Ok(())
}

/// `%XX` for `%`, space and every control character; everything else as it is. An empty value
/// is `%` alone, so every header keeps its field count.
fn escape(value: &str) -> String {
    if value.is_empty() {
        return "%".into();
    }
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        if c == '%' || c == ' ' || (c as u32) < 0x20 || c == '\u{7f}' {
            out.push_str(&format!("%{:02X}", c as u32));
        } else {
            out.push(c);
        }
    }
    out
}

fn unescape(value: &str) -> Result<String> {
    if value == "%" {
        return Ok(String::new());
    }
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = value
                .get(i + 1..i + 3)
                .ok_or_else(|| LgError::InvalidFormat(format!("bad escape in {value:?}")))?;
            out.push(
                u8::from_str_radix(hex, 16)
                    .map_err(|_| LgError::InvalidFormat(format!("bad escape in {value:?}")))?,
            );
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| LgError::InvalidFormat(format!("bad escape in {value:?}")))
}

fn write_varint(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

/// LEB128, minimal only: a varint with a redundant zero byte is a second encoding of the same
/// number, which would give one tree two ids.
fn read_varint(bytes: &[u8], at: &mut usize) -> std::result::Result<u64, String> {
    let mut value = 0u64;
    for shift in (0..64).step_by(7) {
        let byte = *bytes.get(*at).ok_or("truncated length")?;
        *at += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            if byte == 0 && shift > 0 {
                return Err("non-minimal length".into());
            }
            return Ok(value);
        }
    }
    Err("length too long".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blob(text: &str) -> ObjectId {
        hash_object(ObjectKind::Blob, text.as_bytes())
    }

    fn file(name: &str, content: &str) -> TreeEntry {
        TreeEntry {
            name: EntryName::new(name).unwrap(),
            kind: EntryKind::File {
                executable: false,
                stored: Stored::Yes,
            },
            id: blob(content),
        }
    }

    #[test]
    fn names_are_checked_and_keep_their_case() {
        for bad in ["", ".", "..", "a/b", "a\0b", &"x".repeat(256)] {
            assert_eq!(
                EntryName::new(bad).unwrap_err().code(),
                "InvalidName",
                "{bad:?}"
            );
        }
        for good in [
            "a",
            "A.ts",
            "a.ts",
            "ünïcode.txt",
            "😀 emoji.md",
            "CON",
            "a:b",
            "trail.",
        ] {
            assert_eq!(EntryName::new(good).unwrap().as_str(), good);
        }
        assert!(EntryName::new(&"é".repeat(127)).is_ok()); // 254 bytes
        assert!(EntryName::new(&"é".repeat(128)).is_err()); // 256 bytes
    }

    #[test]
    fn a_tree_is_canonical_whatever_order_its_entries_come_in() {
        let a = Tree::new(vec![
            file("b.ts", "b"),
            file("A.ts", "a"),
            file("a.ts", "a"),
        ])
        .unwrap();
        let b = Tree::new(vec![
            file("a.ts", "a"),
            file("b.ts", "b"),
            file("A.ts", "a"),
        ])
        .unwrap();
        assert_eq!(a.encode(), b.encode());
        assert_eq!(a.id(), b.id());
        // Byte order: uppercase sorts before lowercase, and both are kept.
        let names: Vec<_> = a.entries().iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["A.ts", "a.ts", "b.ts"]);
        assert_eq!(Tree::decode(&a.encode()).unwrap(), a);
        // A case-only rename is a different tree.
        let renamed = Tree::new(vec![file("A.ts", "a"), file("b.ts", "b")]).unwrap();
        let original = Tree::new(vec![file("a.ts", "a"), file("b.ts", "b")]).unwrap();
        assert_ne!(renamed.id(), original.id());
        assert!(Tree::new(vec![file("x", "1"), file("x", "2")]).is_err());
    }

    #[test]
    fn every_entry_kind_round_trips_including_empty_directories_and_unstored_files() {
        let empty = Tree::default();
        assert!(empty.encode().is_empty());
        let entries = vec![
            TreeEntry {
                name: EntryName::new("empty-dir").unwrap(),
                kind: EntryKind::Directory,
                id: empty.id(),
            },
            TreeEntry {
                name: EntryName::new("run.sh").unwrap(),
                kind: EntryKind::File {
                    executable: true,
                    stored: Stored::Yes,
                },
                id: blob("#!/bin/sh"),
            },
            TreeEntry {
                name: EntryName::new("big.bin").unwrap(),
                kind: EntryKind::File {
                    executable: false,
                    stored: Stored::No {
                        size: 25 * 1024 * 1024,
                    },
                },
                id: blob("pretend"),
            },
            TreeEntry {
                name: EntryName::new("link").unwrap(),
                kind: EntryKind::Symlink(LinkKind::File),
                id: blob("../target.txt"),
            },
            TreeEntry {
                name: EntryName::new("dirlink").unwrap(),
                kind: EntryKind::Symlink(LinkKind::Directory),
                id: blob("C:\\elsewhere"),
            },
            TreeEntry {
                name: EntryName::new("junction").unwrap(),
                kind: EntryKind::Symlink(LinkKind::Junction),
                id: blob("D:\\mount"),
            },
            TreeEntry {
                name: EntryName::new("😀 ünïcode").unwrap(),
                kind: EntryKind::File {
                    executable: false,
                    stored: Stored::Yes,
                },
                id: blob("u"),
            },
        ];
        let tree = Tree::new(entries).unwrap();
        let decoded = Tree::decode(&tree.encode()).unwrap();
        assert_eq!(decoded, tree);
        assert_eq!(decoded.id(), tree.id());
    }

    #[test]
    fn a_tree_decoder_refuses_anything_non_canonical() {
        let tree = Tree::new(vec![file("a", "1"), file("b", "2")]).unwrap();
        let bytes = tree.encode();
        // Truncated.
        assert!(Tree::decode(&bytes[..bytes.len() - 1]).is_err());
        // Out of order: swap the two entries.
        let one = Tree::new(vec![file("a", "1")]).unwrap().encode();
        let two = Tree::new(vec![file("b", "2")]).unwrap().encode();
        assert!(Tree::decode(&[two.clone(), one.clone()].concat()).is_err());
        // Repeated.
        assert!(Tree::decode(&[one.clone(), one.clone()].concat()).is_err());
        // Flags that do not belong to the kind.
        let mut bad = one.clone();
        bad[1] = FLAG_JUNCTION;
        assert!(Tree::decode(&bad).is_err());
        let mut bad = one.clone();
        bad[0] = 9;
        assert!(Tree::decode(&bad).is_err());
        // A non-minimal length: 0x81 0x00 means 1, spelled with a redundant byte.
        let mut bad = vec![KIND_FILE, 0, 0x81, 0x00, b'a'];
        bad.extend_from_slice(blob("1").as_bytes());
        assert!(Tree::decode(&bad).is_err());
        // Names that are not allowed, even when well-formed otherwise.
        for name in [b"..".as_slice(), b"a/b", b"\xff"] {
            let mut bad = vec![KIND_FILE, 0, name.len() as u8];
            bad.extend_from_slice(name);
            bad.extend_from_slice(blob("1").as_bytes());
            assert!(Tree::decode(&bad).is_err(), "{name:?}");
        }
    }

    #[test]
    fn a_root_maps_folder_ids_to_trees_and_never_holds_a_path() {
        let tree = Tree::new(vec![file("a", "1")]).unwrap().id();
        let mut root = Root::default();
        root.folders.insert(FolderId::new("f-2").unwrap(), tree);
        root.folders.insert(FolderId::new("f-1").unwrap(), tree);
        let decoded = Root::decode(&root.encode()).unwrap();
        assert_eq!(decoded, root);
        assert!(!String::from_utf8_lossy(&root.encode()).contains(":/"));
        // The same trees under other folder ids is another root.
        let mut other = Root::default();
        other.folders.insert(FolderId::new("f-9").unwrap(), tree);
        assert_ne!(other.id(), root.id());
        for bad in ["", "F-1", "a/b", "a b", &"x".repeat(65)] {
            assert!(FolderId::new(bad).is_err(), "{bad:?}");
        }
    }

    fn commit() -> Commit {
        let mut meta = BTreeMap::new();
        meta.insert("task".to_string(), "fix the parser % 100".to_string());
        meta.insert("agent.run".to_string(), "run 42".to_string());
        let mut meta_objects = BTreeMap::new();
        meta_objects.insert("changeset".to_string(), blob("cs"));
        Commit {
            root: blob("root"),
            disk_root: Some(blob("disk")),
            parents: vec![blob("p2"), blob("p1")],
            workspace: "ws-0123456789abcdef0123".into(),
            author: Author {
                name: "Ada Lovelace".into(),
                id: "ada@example.com".into(),
            },
            time_ms: 1_790_000_000_000,
            tz_offset_min: 330,
            source: Source::Ai,
            meta,
            meta_objects,
            message: "Fix the parser\n\nLine two with ünïcode and 😀\n".into(),
        }
    }

    #[test]
    fn a_commit_round_trips_keeping_parent_order_and_sorting_its_metadata() {
        let c = commit();
        let bytes = c.encode().unwrap();
        let decoded = Commit::decode(&bytes).unwrap();
        assert_eq!(decoded, c);
        assert_eq!(decoded.id().unwrap(), c.id().unwrap());
        // Parents keep their order: swapping them is another commit.
        let mut swapped = c.clone();
        swapped.parents.reverse();
        assert_ne!(swapped.id().unwrap(), c.id().unwrap());
        // Metadata is written sorted whatever order it was inserted in.
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.find("meta agent.run").unwrap() < text.find("meta task").unwrap());
        // Every source word round-trips.
        for source in [
            Source::Human,
            Source::Ai,
            Source::Agent,
            Source::Automatic,
            Source::Recovery,
            Source::Checkpoint,
        ] {
            let mut c = commit();
            c.source = source;
            assert_eq!(Commit::decode(&c.encode().unwrap()).unwrap().source, source);
        }
        // Empty author fields and an empty message survive.
        let mut c = commit();
        c.author = Author {
            name: String::new(),
            id: String::new(),
        };
        c.message.clear();
        c.disk_root = None;
        c.parents.clear();
        assert_eq!(Commit::decode(&c.encode().unwrap()).unwrap(), c);
    }

    #[test]
    fn a_commit_decoder_refuses_anything_non_canonical() {
        let good = String::from_utf8(commit().encode().unwrap()).unwrap();
        let variants = [
            good.replacen("ylg-commit 1", "ylg-commit 2", 1),
            good.replacen("source ai", "source robot", 1),
            good.replacen("root ", "root  ", 1),
            good.replacen("meta agent.run run%2042", "meta agent.run run 42", 1),
            // Metadata out of order: move the first meta line after the second.
            {
                let a = "meta agent.run run%2042\n";
                let b = "meta task fix%20the%20parser%20%25%20100\n";
                good.replacen(&format!("{a}{b}"), &format!("{b}{a}"), 1)
            },
            good.replacen("time 1790000000000 330", "time 1790000000000", 1),
            good.replacen("\n\n", "\n", 1),
            good.replacen("workspace ", "unknown x\nworkspace ", 1),
        ];
        for (i, variant) in variants.iter().enumerate() {
            assert_ne!(variant, &good, "variant {i} did not change anything");
            assert!(Commit::decode(variant.as_bytes()).is_err(), "variant {i}");
        }
        assert!(Commit::decode(&[0xff, 0xfe]).is_err());
        // Keys and the workspace token are checked on the way in too.
        let mut c = commit();
        c.meta.insert("Bad Key".into(), "x".into());
        assert!(c.encode().is_err());
        let mut c = commit();
        c.workspace = "has space".into();
        assert!(c.encode().is_err());
    }
}
