# Word Count

Counts the words, lines and characters of the file in the editor.

## Features

- **Word Count: Count Words in Active File** (command palette) shows the counts for the active file.
- Markdown markup (`#`, `*`, `` ` ``, `>`) is left out of the word count unless you turn off
  `yavin.word-count.ignore-markup`.

## Requirements

Yavin 2 (extension API 2.0). It reads documents only through Yavin's extension API and needs no
network, process or file access.
