use crate::buffer::Position;
use serde::{Deserialize, Serialize};

/// A selection range in the buffer. When `anchor == head`, it's a simple cursor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Selection {
    /// The fixed end of the selection.
    pub anchor: Position,
    /// The moving end of the selection (cursor position).
    pub head: Position,
}

impl Selection {
    pub fn cursor(pos: Position) -> Self {
        Self {
            anchor: pos,
            head: pos,
        }
    }

    pub fn is_cursor(&self) -> bool {
        self.anchor == self.head
    }
}
