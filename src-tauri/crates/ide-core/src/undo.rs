use serde::{Deserialize, Serialize};

/// A single edit operation that can be undone/redone.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Edit {
    /// Char index where the edit starts.
    pub start: usize,
    /// Text that was removed (empty for pure insertions).
    pub old_text: String,
    /// Text that was inserted (empty for pure deletions).
    pub new_text: String,
}

/// Tree-structured undo history. Each node can have multiple children,
/// supporting branching undo/redo.
pub struct UndoTree {
    nodes: Vec<UndoNode>,
    current: usize,
}

struct UndoNode {
    edit: Option<Edit>,
    parent: Option<usize>,
    children: Vec<usize>,
}

impl UndoTree {
    pub fn new() -> Self {
        Self {
            nodes: vec![UndoNode {
                edit: None,
                parent: None,
                children: Vec::new(),
            }],
            current: 0,
        }
    }

    /// Record a new edit, branching from the current position.
    pub fn push(&mut self, edit: Edit) {
        let new_idx = self.nodes.len();
        self.nodes.push(UndoNode {
            edit: Some(edit),
            parent: Some(self.current),
            children: Vec::new(),
        });
        self.nodes[self.current].children.push(new_idx);
        self.current = new_idx;
    }

    /// Undo: move to parent node, returning the edit to reverse.
    pub fn undo(&mut self) -> Option<&Edit> {
        let node = &self.nodes[self.current];
        if let Some(parent) = node.parent {
            let edit = node.edit.as_ref();
            self.current = parent;
            edit
        } else {
            None
        }
    }

    /// Redo: move to the most recent child, returning the edit to apply.
    pub fn redo(&mut self) -> Option<&Edit> {
        let node = &self.nodes[self.current];
        if let Some(&last_child) = node.children.last() {
            self.current = last_child;
            self.nodes[self.current].edit.as_ref()
        } else {
            None
        }
    }

    pub fn can_undo(&self) -> bool {
        self.nodes[self.current].parent.is_some()
    }

    pub fn can_redo(&self) -> bool {
        !self.nodes[self.current].children.is_empty()
    }
}

impl Default for UndoTree {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn undo_redo_basic() {
        let mut tree = UndoTree::new();

        tree.push(Edit {
            start: 0,
            old_text: String::new(),
            new_text: "hello".into(),
        });

        tree.push(Edit {
            start: 5,
            old_text: String::new(),
            new_text: " world".into(),
        });

        assert!(tree.can_undo());
        let edit = tree.undo().unwrap();
        assert_eq!(edit.new_text, " world");

        assert!(tree.can_redo());
        let edit = tree.redo().unwrap();
        assert_eq!(edit.new_text, " world");
    }

    #[test]
    fn branching_undo() {
        let mut tree = UndoTree::new();

        tree.push(Edit {
            start: 0,
            old_text: String::new(),
            new_text: "a".into(),
        });

        // Undo back to root
        tree.undo();

        // Branch: push a different edit
        tree.push(Edit {
            start: 0,
            old_text: String::new(),
            new_text: "b".into(),
        });

        let edit = tree.undo().unwrap();
        assert_eq!(edit.new_text, "b");
    }
}
