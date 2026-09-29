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
