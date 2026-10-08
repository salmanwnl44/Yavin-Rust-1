# Real terminal output of task tools (Run/Tasks Module 01)

The `.pty` files are the exact bytes real tools printed when run the way a task runs: `cmd.exe /d /s /c <line>` (Windows' default profile, `tasks/shell.ts`) in a session of Yavin's own native terminal (portable-pty over ConPTY), with a lifecycle subscriber and an acknowledging output subscriber, like `TaskService`'s problem matcher. Nothing was cleaned up or normalised.

- Captured by `capture_real_task_tool_output` in `src-tauri/src/terminal_tests.rs`, which is `#[ignore]`d because it rewrites these files:
  `cargo test -p yavin-ide --lib capture_real_task_tool_output -- --ignored --nocapture`
- `capture.json` records the tool versions, the commands, the terminal size and the exit codes.
- The sources had one error each, on a line wider than 80 columns (`capture.json` → `longName`).
- The bytes differ slightly from one capture to the next (cargo's progress repaints and tsc --watch's timestamps). The structure does not.
- `.gitattributes` marks the files binary, so `core.autocrlf` can never rewrite their line endings.

| File                       | Command                                                     | Columns |
| -------------------------- | ----------------------------------------------------------- | ------- |
| `tsc-{80,200}.pty`         | `tsc --noEmit -p .` (TypeScript 5.9.3)                      | 80, 200 |
| `tsc-watch-{80,200}.pty`   | `tsc --watch --noEmit -p .`, one cycle, then killed         | 80, 200 |
| `cargo-{80,200}.pty`       | `cargo check` (cargo 1.97.1), default human format          | 80, 200 |
| `cargo-short-{80,200}.pty` | `cargo check --message-format short` (the checker's format) | 80, 200 |

Not captured: eslint and ruff are not installed on the capturing machine. `tasks.regression.test.ts` marks its eslint test as using an AUTHORED fixture, and keeps ruff as an explicit TODO.

## What the bytes show

1. **In a terminal, tsc prints its pretty format:**
   `ESC[96msrc/bad.ts ESC[m: ESC[93m2 ESC[m: ESC[93m30 ESC[m - ESC[91merror ESC[90mTS2304: ESC[mCannot find name '…'.`
   This is `file:line:col - error TSnnnn: message`, coloured. It is not the `file(line,col): error TSnnnn: message` that `--pretty false` prints.
2. **ConPTY puts lines in place with cursor moves, not line breaks.** After tsc's diagnostic line, the next output is `ESC[7m ESC[4;1H 2 ESC[27m export const value…` at 80 columns, and `ESC[3;1H` at 200 columns.
   - It is a cursor position (CUP), and there is no `\r\n`.
   - tsc --watch is the same after `Starting compilation in watch mode...` (`ESC[3;1H`) and before `Found 1 error. Watching for file changes.`
   - Removing escape sequences without turning these into line breaks joins separate lines into one.
3. **ConPTY replaces runs of spaces with erase/forward sequences**: `ESC[30X` (ECH) and `ESC[30C` (CUF) at 200 columns. Leading indentation (tsc's `~~~` underline, rustc's `|   ^^^`) vanishes when escapes are simply removed.
4. **No line breaks are inserted where a long line wraps.**
   - At 80 columns, tsc's 140-character diagnostic arrives as one run of text; the wrap is the terminal's autowrap, with no `\r\n` in the stream.
   - The row numbers in the cursor moves that follow do account for it (`4;1H` at 80 columns and `3;1H` at 200).
5. **rustc measures the terminal.** At 80 columns it shortens the source snippet itself (`2 | ... + adeliberately…`). The ` --> src\main.rs:2:26` location line is the same at both widths.
6. **cargo's progress is drawn with lone carriage returns** and OSC 9;4 progress sequences (`ESC]9;4;1;0 ESC\`).
   - The progress bar `    Building [   ] 0/1: …` is repainted with `\r` and `ESC[79X ESC[79C` (80 columns) or `ESC[199X ESC[199C` (200 columns), around the diagnostic lines.
   - It sometimes lands at the end of a diagnostic line (`…not found in this scope ESC[12;1H    Building [`).
7. **Every capture begins with ConPTY's own sequences**: `ESC[6n` (the cursor query, answered by the terminal), `ESC[?9001h`, `ESC[?1004h`, and the window title (`ESC]0;C:\WINDOWS\system32\cmd.exe BEL`). tsc --watch also clears the screen: `ESC[2J ESC[3J` followed by 30 × `ESC[K\r\n`.
8. **Paths are printed as the tool prints them:** tsc `src/bad.ts` (forward slashes, relative), and rustc `src\main.rs` (backslashes, relative).
