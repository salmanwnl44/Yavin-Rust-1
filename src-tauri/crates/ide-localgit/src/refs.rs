//! Refs: HEAD and every named ref, in one `refs.json` replaced atomically as a whole, with a
//! revision that only ever grows.
//!
//! One file rather than a file per ref: an update that moves several refs (and HEAD) is atomic,
//! and ref names never become file names (no case-insensitive collisions on NTFS).

use crate::error::{LgError, Result};
use crate::id::ObjectId;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

pub const REFS_VERSION: u64 = 1;

/// `refs/<segment>/...`: `/`-separated segments of `[A-Za-z0-9._-]`, none empty, none starting
/// with `.`, no `..`, not ending in `.lock`, at most 200 bytes. `refs/heads/*` and `refs/tags/*`
/// are for branches and tags; `refs/yavin/*` for Yavin's own (checkpoints, snapshots, stash).
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct RefName(String);

impl RefName {
    pub fn new(name: &str) -> Result<RefName> {
        let bad = |why: &str| Err(LgError::InvalidName(format!("ref {name:?}: {why}")));
        if name.len() > 200 {
            return bad("longer than 200 bytes");
        }
        let Some(rest) = name.strip_prefix("refs/") else {
            return bad("must start with refs/");
        };
        if rest.is_empty() {
            return bad("no name after refs/");
        }
        for segment in rest.split('/') {
            if segment.is_empty() {
                return bad("empty segment");
            }
            if segment.starts_with('.') || segment.contains("..") || segment.ends_with(".lock") {
                return bad("reserved segment");
            }
            if !segment
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
            {
                return bad("only letters, digits, . _ and - are allowed");
            }
        }
        Ok(RefName(name.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Where HEAD points: at a ref (which may not exist yet -- an unborn branch), or straight at a
/// commit (detached).
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Head {
    Symbolic(RefName),
    Detached(ObjectId),
}

impl Head {
    /// The reflog's spelling: `ref: refs/heads/main` or the id.
    pub fn describe(&self) -> String {
        match self {
            Head::Symbolic(name) => format!("ref: {}", name.as_str()),
            Head::Detached(id) => id.to_hex(),
        }
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct RefsState {
    /// Grows with every update; an update names the revision it was made against.
    pub revision: u64,
    pub head: Head,
    pub refs: BTreeMap<RefName, ObjectId>,
}

impl RefsState {
    /// A new store: HEAD on the unborn `refs/heads/main`, no refs.
    pub fn initial() -> RefsState {
        RefsState {
            revision: 0,
            head: Head::Symbolic(RefName::new("refs/heads/main").expect("valid")),
            refs: BTreeMap::new(),
        }
    }

    /// The commit HEAD resolves to, if any.
    pub fn head_commit(&self) -> Option<ObjectId> {
        match &self.head {
            Head::Symbolic(name) => self.refs.get(name).copied(),
            Head::Detached(id) => Some(*id),
        }
    }

    pub fn to_json(&self) -> String {
        let head = match &self.head {
            Head::Symbolic(name) => json!({ "symbolic": name.as_str() }),
            Head::Detached(id) => json!({ "detached": id.to_hex() }),
        };
        let refs: Map<String, Value> = self
            .refs
            .iter()
            .map(|(name, id)| (name.as_str().to_string(), Value::String(id.to_hex())))
            .collect();
        let value = json!({
            "version": REFS_VERSION,
            "revision": self.revision,
            "head": head,
            "refs": refs,
        });
        serde_json::to_string_pretty(&value).expect("refs serialise")
    }

    /// Strict: a newer version is `UnsupportedVersion` (never read as something it is not),
    /// anything malformed -- a bad id or ref name included -- is `InvalidFormat`.
    pub fn parse(text: &str) -> Result<RefsState> {
        Self::parse_inner(text).map_err(|error| match error {
            LgError::UnsupportedVersion { .. } | LgError::InvalidFormat(_) => error,
            other => LgError::InvalidFormat(format!("refs.json: {other}")),
        })
    }

    fn parse_inner(text: &str) -> Result<RefsState> {
        let bad = |why: &str| LgError::InvalidFormat(format!("refs.json: {why}"));
        let value: Value = serde_json::from_str(text).map_err(|e| bad(&e.to_string()))?;
        let object = value.as_object().ok_or_else(|| bad("not an object"))?;
        let version = object
            .get("version")
            .and_then(Value::as_u64)
            .ok_or_else(|| bad("no version"))?;
        if version > REFS_VERSION {
            return Err(LgError::UnsupportedVersion {
                what: "refs.json".into(),
                found: version,
                supported: REFS_VERSION,
            });
        }
        let revision = object
            .get("revision")
            .and_then(Value::as_u64)
            .ok_or_else(|| bad("no revision"))?;
        let head = object
            .get("head")
            .and_then(Value::as_object)
            .ok_or_else(|| bad("no head"))?;
        let head = match (
            head.get("symbolic").and_then(Value::as_str),
            head.get("detached").and_then(Value::as_str),
        ) {
            (Some(name), None) => Head::Symbolic(RefName::new(name)?),
            (None, Some(id)) => Head::Detached(ObjectId::from_hex(id)?),
            _ => return Err(bad("head must be symbolic or detached")),
        };
        let mut refs = BTreeMap::new();
        for (name, id) in object
            .get("refs")
            .and_then(Value::as_object)
            .ok_or_else(|| bad("no refs"))?
        {
            let id = id.as_str().ok_or_else(|| bad("a ref is not an id"))?;
            refs.insert(RefName::new(name)?, ObjectId::from_hex(id)?);
        }
        Ok(RefsState {
            revision,
            head,
            refs,
        })
    }
}

/// One ref's compare-and-swap: from `expected` (None: must not exist) to `new` (None: delete).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct RefUpdate {
    pub name: RefName,
    pub expected: Option<ObjectId>,
    pub new: Option<ObjectId>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::id::{hash_object, ObjectKind};

    #[test]
    fn ref_names_are_checked() {
        for good in [
            "refs/heads/main",
            "refs/heads/feature/login",
            "refs/tags/v1.0",
            "refs/yavin/checkpoints/2026-09-30_a",
        ] {
            assert_eq!(RefName::new(good).unwrap().as_str(), good);
        }
        for bad in [
            "HEAD",
            "heads/main",
            "refs/",
            "refs//x",
            "refs/heads/../x",
            "refs/heads/.hidden",
            "refs/heads/x.lock",
            "refs/heads/a b",
            "refs/heads/ünï",
            "refs/heads/a\\b",
            &format!("refs/heads/{}", "x".repeat(200)),
        ] {
            assert_eq!(
                RefName::new(bad).unwrap_err().code(),
                "InvalidName",
                "{bad:?}"
            );
        }
    }

    #[test]
    fn refs_json_round_trips_and_refuses_what_it_cannot_read() {
        let mut state = RefsState::initial();
        state.revision = 7;
        state.refs.insert(
            RefName::new("refs/heads/main").unwrap(),
            hash_object(ObjectKind::Commit, b"c"),
        );
        assert_eq!(RefsState::parse(&state.to_json()).unwrap(), state);
        let detached = RefsState {
            head: Head::Detached(hash_object(ObjectKind::Commit, b"d")),
            ..state.clone()
        };
        assert_eq!(RefsState::parse(&detached.to_json()).unwrap(), detached);

        let future = state.to_json().replace("\"version\": 1", "\"version\": 2");
        assert_eq!(
            RefsState::parse(&future).unwrap_err().code(),
            "UnsupportedVersion"
        );
        for broken in [
            "",
            "{",
            "[]",
            "{\"version\":1}",
            &state
                .to_json()
                .replace("refs/heads/main\": \"", "refs/heads/main\": \"zz"),
            &state.to_json().replace("\"symbolic\"", "\"elsewhere\""),
        ] {
            assert_eq!(
                RefsState::parse(broken).unwrap_err().code(),
                "InvalidFormat",
                "{broken:?}"
            );
        }
    }
}
