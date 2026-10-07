# TODO Highlighter

Highlights `TODO` and `FIXME` in every open file, as you type.

## Features

- Occurrences are highlighted in the editor, with a hover naming the keyword.
- **TODO Highlighter: Count TODOs in Active File** counts them in the active file.
- Choose the words with `yavin.todo-highlighter.keywords` (comma-separated).

## Requirements

Yavin 2 (extension API 2.0). It reads open documents and sets decorations through Yavin's
extension API only.
