use crate::id::ObjectId;
use std::fmt;

/// Every way a Local Git operation can fail, each with a stable `code()` the renderer and
/// later recovery tooling can act on. Nothing here is ever turned into "an empty repository".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LgError {
    /// A stored file or object is not in the expected shape.
    InvalidFormat(String),
    /// Written by a newer Yavin: never read as something it is not, never overwritten.
    UnsupportedVersion {
        what: String,
        found: u64,
        supported: u64,
    },
    /// A tree entry, folder id or ref name that is not allowed.
    InvalidName(String),
    InvalidObjectId(String),
    /// An object whose bytes no longer hash to its id.
    CorruptObject {
        id: ObjectId,
        detail: String,
    },
    /// A segment file that cannot be trusted (bad header, index or trailer).
    CorruptSegment {
        segment: String,
        detail: String,
    },
    MissingObject(ObjectId),
    /// A ref names an object the store does not have.
    DanglingRef {
        name: String,
        id: ObjectId,
    },
    /// A compare-and-swap ref update found another value than the one expected.
    RefConflict {
        name: String,
        expected: Option<ObjectId>,
        found: Option<ObjectId>,
    },
    /// The refs moved on since the caller read them.
    StaleRevision {
        expected: u64,
        found: u64,
    },
    /// The store belongs to another workspace than the one opening it.
    WorkspaceMismatch {
        stored: String,
        expected: String,
    },
    /// Another process holds the store's writer lock; this one may only read.
    ReadOnly,
    /// The store needs a decision before it can be used as it is (see the findings).
    RecoveryRequired(String),
    /// A blob that was hashed but deliberately not stored (over the size limit).
    ContentUnavailable(ObjectId),
    /// An object of another kind than the caller asked for.
    WrongKind {
        id: ObjectId,
        expected: &'static str,
        found: &'static str,
    },
    /// The caller cancelled the operation (a newer status superseded it, or its handle closed).
    Cancelled,
    /// A branch or tag of that name exists already (never replaced).
    AlreadyExists(String),
    /// No branch, tag or path of that name.
    NotFound(String),
    /// A commit was asked for, and the index holds nothing HEAD does not.
    NothingToCommit,
    /// A stash was asked for, and there is nothing to put aside.
    NothingToStash,
    /// The branch HEAD is on cannot be deleted.
    CurrentBranch(String),
    /// Deleting the branch would leave commits no other ref reaches.
    NotMerged(String),
    /// There is no commit yet (HEAD is unborn) to start from.
    Unborn,
    /// A file whose content was not stored cannot be staged piece by piece.
    ContentUnavailableForStaging(String),
    /// Partial staging was asked for a diff that is no longer the one the caller saw.
    StaleSelection(String),
    /// Partial staging cannot be represented safely for this file (binary, not text).
    PartialStagingUnsupported(String),
    /// A merge or cherry-pick is in progress (LG-06): HEAD and the index change only through
    /// its resolve, continue and abort until it ends.
    OperationInProgress(String),
    /// Continue, abort or resolve was asked for, and no merge or cherry-pick is in progress.
    NoOperation,
    /// Continue was asked for while conflicts are unresolved (how many).
    UnresolvedConflicts(usize),
    /// The two histories have no commit in common.
    UnrelatedHistories,
    /// Cherry-picking a commit with several parents (which parent's change is meant?).
    CherryPickMerge(String),
    /// A resolution's content still holds conflict markers.
    ConflictMarkers(String),
    /// Marking a path resolved as it is on disk, while a document on it has unsaved changes
    /// (which would be left out).
    UnsavedDocument(String),
    /// An AI run is not in a state that allows what was asked (LG-07).
    AiRunState(String),
    /// An AI run already belongs to another ChangeSet.
    ChangeSetMismatch(String),
    /// What the AI changed cannot be told apart from what others changed.
    AttributionAmbiguous(String),
    Io(String),
}

impl LgError {
    pub fn code(&self) -> &'static str {
        match self {
            LgError::InvalidFormat(_) => "InvalidFormat",
            LgError::UnsupportedVersion { .. } => "UnsupportedVersion",
            LgError::InvalidName(_) => "InvalidName",
            LgError::InvalidObjectId(_) => "InvalidObjectId",
            LgError::CorruptObject { .. } => "CorruptObject",
            LgError::CorruptSegment { .. } => "CorruptSegment",
            LgError::MissingObject(_) => "MissingObject",
            LgError::DanglingRef { .. } => "DanglingRef",
            LgError::RefConflict { .. } => "RefConflict",
            LgError::StaleRevision { .. } => "StaleRevision",
            LgError::WorkspaceMismatch { .. } => "WorkspaceMismatch",
            LgError::ReadOnly => "ReadOnly",
            LgError::RecoveryRequired(_) => "RecoveryRequired",
            LgError::ContentUnavailable(_) => "ContentUnavailable",
            LgError::WrongKind { .. } => "WrongKind",
            LgError::Cancelled => "Cancelled",
            LgError::AlreadyExists(_) => "AlreadyExists",
            LgError::NotFound(_) => "NotFound",
            LgError::NothingToCommit => "NothingToCommit",
            LgError::NothingToStash => "NothingToStash",
            LgError::CurrentBranch(_) => "CurrentBranch",
            LgError::NotMerged(_) => "NotMerged",
            LgError::Unborn => "Unborn",
            LgError::ContentUnavailableForStaging(_) => "ContentUnavailableForStaging",
            LgError::StaleSelection(_) => "StaleSelection",
            LgError::PartialStagingUnsupported(_) => "PartialStagingUnsupported",
            LgError::OperationInProgress(_) => "OperationInProgress",
            LgError::NoOperation => "NoOperation",
            LgError::UnresolvedConflicts(_) => "UnresolvedConflicts",
            LgError::UnrelatedHistories => "UnrelatedHistories",
            LgError::CherryPickMerge(_) => "CherryPickMerge",
            LgError::ConflictMarkers(_) => "ConflictMarkers",
            LgError::UnsavedDocument(_) => "UnsavedDocument",
            LgError::AiRunState(_) => "AiRunState",
            LgError::ChangeSetMismatch(_) => "ChangeSetMismatch",
            LgError::AttributionAmbiguous(_) => "AttributionAmbiguous",
            LgError::Io(_) => "Io",
        }
    }
}

impl fmt::Display for LgError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LgError::InvalidFormat(detail) => write!(f, "Invalid Local Git data: {detail}"),
            LgError::UnsupportedVersion {
                what,
                found,
                supported,
            } => write!(
                f,
                "{what} is version {found}, newer than this Yavin supports ({supported})"
            ),
            LgError::InvalidName(detail) => write!(f, "Invalid name: {detail}"),
            LgError::InvalidObjectId(detail) => write!(f, "Invalid object id: {detail}"),
            LgError::CorruptObject { id, detail } => write!(f, "Object {id} is corrupt: {detail}"),
            LgError::CorruptSegment { segment, detail } => {
                write!(f, "Segment {segment} is corrupt: {detail}")
            }
            LgError::MissingObject(id) => write!(f, "Object {id} is missing"),
            LgError::DanglingRef { name, id } => {
                write!(f, "{name} points to {id}, which is missing")
            }
            LgError::RefConflict {
                name,
                expected,
                found,
            } => write!(
                f,
                "{name} changed: expected {}, found {}",
                show(expected),
                show(found)
            ),
            LgError::StaleRevision { expected, found } => write!(
                f,
                "The refs changed (revision {found}, expected {expected}); read them again"
            ),
            LgError::WorkspaceMismatch { stored, expected } => write!(
                f,
                "This Local Git store belongs to {stored}, not {expected}"
            ),
            LgError::ReadOnly => write!(
                f,
                "Another Yavin window is writing this Local Git history; it is read-only here"
            ),
            LgError::RecoveryRequired(detail) => write!(f, "Local Git needs recovery: {detail}"),
            LgError::ContentUnavailable(id) => write!(
                f,
                "The content of {id} was not stored (it was over the size limit)"
            ),
            LgError::WrongKind {
                id,
                expected,
                found,
            } => write!(f, "{id} is a {found}, not a {expected}"),
            LgError::Cancelled => write!(f, "The operation was cancelled"),
            LgError::AlreadyExists(name) => write!(f, "{name} already exists"),
            LgError::NotFound(name) => write!(f, "{name} does not exist"),
            LgError::NothingToCommit => write!(f, "Nothing is staged: there is nothing to commit"),
            LgError::NothingToStash => write!(f, "There are no changes to stash"),
            LgError::CurrentBranch(name) => {
                write!(f, "{name} is the current branch and cannot be deleted")
            }
            LgError::NotMerged(name) => write!(
                f,
                "{name} has commits no other branch or tag reaches; it was not deleted"
            ),
            LgError::Unborn => write!(f, "There is no commit yet"),
            LgError::ContentUnavailableForStaging(path) => write!(
                f,
                "{path} is over the storage limit: its content was not stored, so it cannot be staged in parts"
            ),
            LgError::StaleSelection(path) => write!(
                f,
                "{path} changed since its diff was shown; show it again before staging part of it"
            ),
            LgError::PartialStagingUnsupported(path) => {
                write!(f, "{path} cannot be staged in parts (it is not text)")
            }
            LgError::OperationInProgress(kind) => write!(
                f,
                "A {kind} is in progress: resolve its conflicts and continue it, or abort it, first"
            ),
            LgError::NoOperation => write!(f, "No merge or cherry-pick is in progress"),
            LgError::UnresolvedConflicts(n) => {
                write!(f, "{n} conflict(s) are not resolved yet")
            }
            LgError::UnrelatedHistories => {
                write!(f, "The two histories have no commit in common; they were not merged")
            }
            LgError::CherryPickMerge(id) => write!(
                f,
                "{id} is a merge commit (several parents); it cannot be cherry-picked"
            ),
            LgError::ConflictMarkers(path) => write!(
                f,
                "{path} still holds conflict markers; edit them out before resolving it"
            ),
            LgError::UnsavedDocument(path) => write!(
                f,
                "{path} has unsaved changes: save it, or resolve it with the document's text"
            ),
            LgError::AiRunState(detail) => write!(f, "{detail}"),
            LgError::ChangeSetMismatch(detail) => write!(f, "{detail}"),
            LgError::AttributionAmbiguous(detail) => write!(
                f,
                "{detail}: the AI's change cannot be told apart from others, so it was not recorded"
            ),
            LgError::Io(detail) => write!(f, "{detail}"),
        }
    }
}

fn show(id: &Option<ObjectId>) -> String {
    id.map(|id| id.to_hex()).unwrap_or_else(|| "nothing".into())
}

impl std::error::Error for LgError {}

impl From<std::io::Error> for LgError {
    fn from(error: std::io::Error) -> Self {
        LgError::Io(error.to_string())
    }
}

pub type Result<T> = std::result::Result<T, LgError>;
