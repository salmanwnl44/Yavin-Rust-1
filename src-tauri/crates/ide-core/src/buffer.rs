use ropey::Rope;
use serde::{Deserialize, Serialize};

/// A text buffer backed by a Rope data structure for O(log n) edits.
pub struct Buffer {
    rope: Rope,
    /// Filesystem path, if the buffer is associated with a file.
    path: Option<std::path::PathBuf>,
    /// Whether the buffer has unsaved modifications.
    dirty: bool,
}

/// A position in the buffer (0-indexed line and column).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Position {
    pub line: usize,
    pub col: usize,
}

impl Buffer {
    pub fn new() -> Self {
        Self {
            rope: Rope::new(),
            path: None,
            dirty: false,
        }
    }

    pub fn from_str(text: &str) -> Self {
        Self {
            rope: Rope::from_str(text),
            path: None,
            dirty: false,
        }
    }

    pub fn from_file(path: &std::path::Path) -> Result<Self, std::io::Error> {
        let text = std::fs::read_to_string(path)?;
        Ok(Self {
            rope: Rope::from_str(&text),
            path: Some(path.to_path_buf()),
            dirty: false,
        })
    }

    pub fn text(&self) -> String {
        self.rope.to_string()
    }

    pub fn line_count(&self) -> usize {
        self.rope.len_lines()
    }

    pub fn line(&self, idx: usize) -> Option<&str> {
        if idx < self.rope.len_lines() {
            Some(self.rope.line(idx).as_str().unwrap_or(""))
        } else {
            None
        }
    }

    pub fn insert(&mut self, char_idx: usize, text: &str) {
        self.rope.insert(char_idx, text);
        self.dirty = true;
    }

    pub fn remove(&mut self, range: std::ops::Range<usize>) {
        self.rope.remove(range);
        self.dirty = true;
    }

    pub fn path(&self) -> Option<&std::path::Path> {
        self.path.as_deref()
    }

    pub fn set_path(&mut self, path: std::path::PathBuf) {
        self.path = Some(path);
    }

    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    pub fn mark_clean(&mut self) {
        self.dirty = false;
    }

    pub fn len_chars(&self) -> usize {
        self.rope.len_chars()
    }

    pub fn is_empty(&self) -> bool {
        self.rope.len_chars() == 0
    }

    /// Convert a (line, col) position to a char index.
    pub fn pos_to_char_idx(&self, pos: Position) -> Option<usize> {
        if pos.line >= self.rope.len_lines() {
            return None;
        }
        let line_start = self.rope.line_to_char(pos.line);
        let line_len = self.rope.line(pos.line).len_chars();
        if pos.col > line_len {
            return None;
        }
        Some(line_start + pos.col)
    }

    /// Convert a char index to a (line, col) position.
    pub fn char_idx_to_pos(&self, char_idx: usize) -> Position {
        let line = self.rope.char_to_line(char_idx);
        let line_start = self.rope.line_to_char(line);
        Position {
            line,
            col: char_idx - line_start,
        }
    }
}

impl Default for Buffer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_and_read() {
        let mut buf = Buffer::from_str("hello");
        buf.insert(5, " world");
        assert_eq!(buf.text(), "hello world");
        assert!(buf.is_dirty());
    }

    #[test]
    fn remove_text() {
        let mut buf = Buffer::from_str("hello world");
        buf.remove(5..11);
        assert_eq!(buf.text(), "hello");
    }

    #[test]
    fn position_conversion() {
        let buf = Buffer::from_str("line one\nline two\nline three");
        let pos = Position { line: 1, col: 5 };
        let idx = buf.pos_to_char_idx(pos).unwrap();
        let back = buf.char_idx_to_pos(idx);
        assert_eq!(back, pos);
    }
}
