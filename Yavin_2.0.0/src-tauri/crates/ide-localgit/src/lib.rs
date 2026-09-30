//! Yavin Local Git: a workspace-scoped, content-addressed local history store.
//!
//! It is not real Git and never touches it: nothing here runs `git`, reads or writes `.git`, or
//! knows about the real index, branches or remotes. A store lives in Yavin's private data
//! directory, one per workspace, and holds immutable objects (blobs, trees, workspace roots,
//! commits) in segment files, plus a small atomically replaced `refs.json` and an append-only
//! reflog. See ARCHITECTURE.md, "Local Git".
//!
//! LG-01 is the storage foundation; LG-02 adds snapshots of the workspace -- the disk, and the
//! disk with unsaved documents applied -- and status against Local HEAD (`snapshot`, `scan`,
//! `exclude`, `status`). Commits made by people, branches and everything that builds on them
//! come in later phases on top of these APIs.

pub mod branches;
pub mod diff;
pub mod error;
pub mod exclude;
pub mod fault;
pub mod finding;
pub mod history;
pub mod id;
pub mod index;
pub mod object;
pub mod odb;
pub mod reflog;
pub mod refs;
pub mod repository;
pub mod restore;
pub mod scan;
pub mod segment;
pub mod snapshot;
pub mod status;
pub mod switch;
pub mod workspace;

pub use error::{LgError, Result};
pub use finding::{Finding, InterruptedUpdate};
pub use id::{hash_blob_stream, hash_object, ObjectHasher, ObjectId, ObjectKind};
pub use object::{
    Author, Commit, EntryKind, EntryName, FolderId, LinkKind, Root, Source, Stored, Tree, TreeEntry,
};
pub use reflog::ReflogRecord;
pub use refs::{Head, RefName, RefUpdate, RefsState};
pub use repository::{
    FolderRecord, Mode, Object, OpenOptions, ReadOnlyReason, Repository, WorkspaceMeta, WriteTxn,
    DEFAULT_MAX_BLOB_BYTES, FORMAT_VERSION,
};
pub use scan::{Problem, RACY_WINDOW_NS};
pub use snapshot::{
    Control, FolderRoot, FullReason, ObjectIdText, OverlayInput, OverlayRecord, Progress,
    RequestedMode, ScanMode, Snapshot, SnapshotEngine, SnapshotRequest, UntitledInput,
    UntitledRecord, WatchedChange, FULL_EVERY, FULL_EVERY_SNAPSHOTS,
};
pub use status::{ChangeKind, EntryClass, MemoryState, Status, StatusEntry};
pub use workspace::{resource_id_of, FolderSpec, WorkspaceSpec};
