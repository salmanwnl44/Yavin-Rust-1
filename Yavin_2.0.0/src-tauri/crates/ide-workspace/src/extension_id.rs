//! The one extension id rule (EXT-02), shared by the installer, the inventory, the host and
//! the renderer (`src/services/extensions/identity.ts`, the same rule; both are tested against
//! `identity.cases.json`).
//!
//! An id is `publisher.name`; each part is 1 to 50 of `a-z`, `0-9` and `-`, not starting with
//! `-`. Ids compare case-insensitively: `canonical_id` folds ASCII upper case (only ASCII, so
//! no Unicode folding can turn another character into a letter). A manifest's own id must
//! already be canonical; ids Yavin is asked about are folded first.

/// The longest part of an id.
pub const MAX_ID_PART: usize = 50;

fn part_ok(part: &str) -> bool {
    !part.is_empty()
        && part.len() <= MAX_ID_PART
        && !part.starts_with('-')
        && part
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Whether `id` is an id in its canonical (lower-case) form.
pub fn is_canonical(id: &str) -> bool {
    matches!(id.split_once('.'), Some((publisher, name)) if part_ok(publisher) && part_ok(name))
}

/// `raw` as a canonical id, or `None` when it is not an id.
pub fn canonical_id(raw: &str) -> Option<String> {
    let folded = raw.to_ascii_lowercase();
    is_canonical(&folded).then_some(folded)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The renderer's rule gives the same answers (identity.test.ts reads the same file).
    #[test]
    fn the_shared_cases_agree() {
        let text = include_str!("../../../../src/services/extensions/identity.cases.json");
        let cases: serde_json::Value = serde_json::from_str(text).unwrap();
        let cases = cases["cases"].as_array().unwrap();
        assert!(cases.len() > 20);
        for case in cases {
            let input = case["input"].as_str().unwrap();
            let expected = case["canonical"].as_str();
            assert_eq!(canonical_id(input).as_deref(), expected, "{input:?}");
            assert_eq!(is_canonical(input), expected == Some(input), "{input:?}");
        }
    }
}
