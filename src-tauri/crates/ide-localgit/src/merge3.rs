//! Three-way merge of one text file's lines (LG-06), on LG-03's line diff.
//!
//! Each side's changes against the base are the runs of LG-03's edit script (`diff.rs`).
//! Changes of the two sides that overlap -- or touch, with no unchanged base line between them
//! -- form one region: taken as it is when only one side changed it or both made the very same
//! change, and a conflict otherwise, written with markers:
//!
//! ```text
//! <<<<<<< ours
//! ...
//! =======
//! ...
//! >>>>>>> theirs
//! ```
//!
//! Every line keeps its own line ending; the markers use the line ending ours uses. Lines are
//! bytes: nothing is decoded, so nothing can be lost in a round trip.

use crate::diff::{edit_script, lines, Edit};

/// A side's change: base lines `base.0..base.1` became side lines `side.0..side.1`.
#[derive(Clone, Copy, Debug)]
struct Change {
    base: (usize, usize),
    side: (usize, usize),
}

fn changes(base: &[&[u8]], side: &[&[u8]]) -> Vec<Change> {
    let mut out: Vec<Change> = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    let mut open: Option<Change> = None;
    for edit in edit_script(base, side) {
        match edit {
            Edit::Equal => {
                if let Some(change) = open.take() {
                    out.push(change);
                }
                i += 1;
                j += 1;
            }
            Edit::Delete => {
                let change = open.get_or_insert(Change {
                    base: (i, i),
                    side: (j, j),
                });
                change.base.1 = i + 1;
                i += 1;
            }
            Edit::Insert => {
                let change = open.get_or_insert(Change {
                    base: (i, i),
                    side: (j, j),
                });
                change.side.1 = j + 1;
                j += 1;
            }
        }
    }
    if let Some(change) = open {
        out.push(change);
    }
    out
}

/// The side lines that base lines `start..end` became, given the side's changes wholly inside
/// (or touching) that range, `inside`, and all its changes, `all`.
fn side_range(all: &[Change], inside: &[Change], start: usize, end: usize) -> (usize, usize) {
    match (inside.first(), inside.last()) {
        (Some(first), Some(last)) => (
            first.side.0 - (first.base.0 - start),
            last.side.1 + (end - last.base.1),
        ),
        _ => {
            // Unchanged by this side: shifted by what its earlier changes added or removed.
            let shift: isize = all
                .iter()
                .filter(|c| c.base.1 <= start && !(c.base.0 == start && c.base.1 == start))
                .map(|c| (c.side.1 - c.side.0) as isize - (c.base.1 - c.base.0) as isize)
                .sum();
            let at = (start as isize + shift) as usize;
            (at, at + (end - start))
        }
    }
}

/// The outcome of a text merge.
#[derive(Debug, PartialEq, Eq)]
pub struct Merged {
    pub bytes: Vec<u8>,
    /// How many regions conflicted (0: a clean merge).
    pub conflicts: usize,
}

fn line_ending(text: &[&[u8]]) -> &'static [u8] {
    match text.first() {
        Some(line) if line.ends_with(b"\r\n") => b"\r\n",
        _ => b"\n",
    }
}

/// Merges `ours` and `theirs`, both made from `base`. `labels` name the two sides in markers.
pub fn merge(base: &[u8], ours: &[u8], theirs: &[u8], labels: (&str, &str)) -> Merged {
    let (b, o, t) = (lines(base), lines(ours), lines(theirs));
    let (co, ct) = (changes(&b, &o), changes(&b, &t));
    // Every change, both sides, by where it starts in the base.
    let mut all: Vec<(usize, Change)> = co
        .iter()
        .map(|c| (0, *c))
        .chain(ct.iter().map(|c| (1, *c)))
        .collect();
    all.sort_by_key(|(side, c)| (c.base.0, c.base.1, *side));
    let eol = line_ending(&o);
    let mut out = Vec::with_capacity(ours.len().max(theirs.len()));
    let mut conflicts = 0;
    let mut at = 0usize; // next base line not yet written
    let mut next = 0usize;
    while next < all.len() {
        // One region: every change overlapping or touching the ones before it.
        let (start, mut end) = all[next].1.base;
        let mut members = vec![all[next]];
        next += 1;
        while next < all.len() && all[next].1.base.0 <= end {
            end = end.max(all[next].1.base.1);
            members.push(all[next]);
            next += 1;
        }
        for line in &b[at..start] {
            out.extend_from_slice(line);
        }
        at = end;
        let of = |side: usize| -> Vec<Change> {
            members
                .iter()
                .filter(|(s, _)| *s == side)
                .map(|(_, c)| *c)
                .collect()
        };
        let (mo, mt) = (of(0), of(1));
        let (os, oe) = side_range(&co, &mo, start, end);
        let (ts, te) = side_range(&ct, &mt, start, end);
        let (ours_text, theirs_text) = (&o[os..oe], &t[ts..te]);
        if mt.is_empty() || ours_text == theirs_text {
            ours_text.iter().for_each(|l| out.extend_from_slice(l));
        } else if mo.is_empty() {
            theirs_text.iter().for_each(|l| out.extend_from_slice(l));
        } else {
            conflicts += 1;
            let section = |out: &mut Vec<u8>, text: &[&[u8]]| {
                for line in text {
                    out.extend_from_slice(line);
                }
                if text.last().is_some_and(|l| !l.ends_with(b"\n")) {
                    out.extend_from_slice(eol);
                }
            };
            out.extend_from_slice(format!("<<<<<<< {}", labels.0).as_bytes());
            out.extend_from_slice(eol);
            section(&mut out, ours_text);
            out.extend_from_slice(b"=======");
            out.extend_from_slice(eol);
            section(&mut out, theirs_text);
            out.extend_from_slice(format!(">>>>>>> {}", labels.1).as_bytes());
            out.extend_from_slice(eol);
        }
    }
    for line in &b[at..] {
        out.extend_from_slice(line);
    }
    Merged {
        bytes: out,
        conflicts,
    }
}

/// Whether `bytes` still hold conflict markers: a line starting `<<<<<<< ` and, after it, one
/// that is `=======` and one starting `>>>>>>> `.
pub fn has_markers(bytes: &[u8]) -> bool {
    let mut stage = 0;
    for line in lines(bytes) {
        let line = line
            .strip_suffix(b"\n")
            .map(|l| l.strip_suffix(b"\r").unwrap_or(l))
            .unwrap_or(line);
        stage = match stage {
            0 if line.starts_with(b"<<<<<<< ") || line == b"<<<<<<<" => 1,
            1 if line == b"=======" => 2,
            2 if line.starts_with(b">>>>>>> ") || line == b">>>>>>>" => return true,
            s => s,
        };
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(base: &str, ours: &str, theirs: &str) -> (String, usize) {
        let merged = merge(
            base.as_bytes(),
            ours.as_bytes(),
            theirs.as_bytes(),
            ("ours", "theirs"),
        );
        (String::from_utf8(merged.bytes).unwrap(), merged.conflicts)
    }

    #[test]
    fn changes_far_apart_merge_cleanly() {
        let base = "1\n2\n3\n4\n5\n6\n7\n";
        let (out, conflicts) = m(
            base,
            "1 ours\n2\n3\n4\n5\n6\n7\n",
            "1\n2\n3\n4\n5\n6\n7 theirs\n",
        );
        assert_eq!(conflicts, 0);
        assert_eq!(out, "1 ours\n2\n3\n4\n5\n6\n7 theirs\n");
    }

    #[test]
    fn insertions_and_deletions_on_both_sides() {
        let base = "a\nb\nc\nd\ne\nf\n";
        let (out, conflicts) = m(base, "a\nnew\nb\nc\nd\ne\nf\n", "a\nb\nc\nd\nf\n");
        assert_eq!(conflicts, 0);
        assert_eq!(out, "a\nnew\nb\nc\nd\nf\n");
    }

    #[test]
    fn the_same_change_on_both_sides_is_taken_once() {
        let (out, conflicts) = m("a\nb\nc\n", "a\nB\nc\n", "a\nB\nc\n");
        assert_eq!((out.as_str(), conflicts), ("a\nB\nc\n", 0));
    }

    #[test]
    fn overlapping_changes_conflict_with_markers() {
        let (out, conflicts) = m("a\nb\nc\n", "a\nours\nc\n", "a\ntheirs\nc\n");
        assert_eq!(conflicts, 1);
        assert_eq!(
            out,
            "a\n<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs\nc\n"
        );
        assert!(has_markers(out.as_bytes()));
        assert!(!has_markers(b"a\n=======\nb\n"));
    }

    #[test]
    fn adjacent_changes_conflict() {
        let (_, conflicts) = m("a\nb\nc\nd\n", "a\nB\nc\nd\n", "a\nb\nC\nd\n");
        assert_eq!(conflicts, 1);
    }

    #[test]
    fn crlf_is_kept_and_a_missing_last_newline_does_not_glue_markers() {
        let (out, conflicts) = m("a\r\nb", "a\r\nours", "a\r\ntheirs");
        assert_eq!(conflicts, 1);
        assert_eq!(
            out,
            "a\r\n<<<<<<< ours\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> theirs\r\n"
        );
    }

    #[test]
    fn an_empty_base_with_two_different_texts_is_one_conflict() {
        let (out, conflicts) = m("", "x\n", "y\n");
        assert_eq!(conflicts, 1);
        assert!(out.starts_with("<<<<<<< ours\nx\n=======\ny\n"));
    }

    #[test]
    fn one_side_unchanged_takes_the_other_exactly() {
        let base = "a\nb\nc\n";
        assert_eq!(m(base, base, "z\n"), ("z\n".to_string(), 0));
        assert_eq!(m(base, "", base), (String::new(), 0));
    }
}
