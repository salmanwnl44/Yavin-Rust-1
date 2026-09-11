# Search and source control plan

Research date: 7 September 2026. This is a proposed implementation plan, based on official IDE documentation and inspection of Yavin's active code. No IDE runtime comparison or performance benchmark was conducted.

## Direction

Build a familiar search sidebar and a Git staging workflow, with full-width result previews and diffs in editor tabs. Prioritize accurate results, responsive navigation, and predictable writes. Keep orchestration and interpretation in TypeScript; use small, validated native operations for filesystem access and fixed tool execution, following `ARCHITECTURE.md` and `../GEMINI.md`.

## What other IDEs teach us

| Reference                                                                                                 | Observed behavior                                                                                      | Decision for Yavin                                                                                                                 |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| [VS Code search](https://code.visualstudio.com/docs/editing/codebasics)                                   | Cross-file search, include/exclude filters, changed-file scope, replacement, and search editor results | Use a compact sidebar with grouped results and optional editor preview. Keep filename quick open separate from content search.     |
| [VS Code staging](https://code.visualstudio.com/docs/sourcecontrol/staging-commits)                       | File and partial staging support focused commits                                                       | Show Staged Changes and Changes separately; implement file staging before hunk staging.                                            |
| [JetBrains Find in Files](https://www.jetbrains.com/help/idea/finding-and-replacing-text-in-project.html) | Directory/open-file scopes, file masks, preview, and persistent result tabs                            | Make scope visible and preserve query/filter state. Add pinned result tabs after the core workflow.                                |
| [JetBrains changelists](https://www.jetbrains.com/help/idea/managing-changelists.html)                    | Local changes can be grouped by task                                                                   | Defer changelists; Git's index is enough for the first release.                                                                    |
| [Zed search](https://zed.dev/features) and [Git](https://zed.dev/docs/git)                                | Project search uses multibuffers; project diffs support unified/split views and hunk staging           | Adopt broad contextual review and keyboard navigation. Defer editable multibuffers because Yavin currently uses a textarea editor. |
| [VS Code merge resolution](https://code.visualstudio.com/docs/sourcecontrol/merge-conflicts)              | Inline resolution and a three-way merge editor                                                         | Start with conflict visibility and manual resolution; deliver a dedicated merge editor in a later phase.                           |

These are workflow references, not a proposal to copy another IDE's source or reproduce every feature.

## Current Yavin gaps

- `src/components/layout/Sidebar.tsx` renders a placeholder for both panels.
- `src/components/layout/TextEditor.tsx` supports in-file find/replace and line navigation, but lacks a public exact-range reveal method.
- `src/services/workspace.ts` flattens Explorer files for quick open. Explorer loads only six levels and omits traversal into `.git`, `node_modules`, and `target`; it cannot define complete content-search coverage.
- The same service collapses Git's two status columns into a single decoration and discards rename source paths. That is insufficient for staged/unstaged lists and diffs.
- `src-tauri/crates/ide-workspace/src/git.rs` exposes status only, using NUL-delimited porcelain v1 scoped to the opened directory. Repository root and opened workspace can differ.
- `src/App.tsx` obtains status while loading the workspace. There is no dedicated Git refresh lifecycle; missing Git and non-repositories currently surface through generic errors.
- Files are limited to 10 MB and guarded against binary content. Saves replace via a temporary file, but external-change detection is still missing.
- Historical Rust `search.rs` and `watcher.rs` are inactive. Do not reconnect them.

## Search experience

Use `Ctrl+Shift+F` for workspace search and `Ctrl+Shift+H` for workspace replacement, with platform equivalents through the existing command registry. Preserve `Ctrl+P` for files and `Ctrl+F` for the current document.

Sidebar order: query; case/whole-word/regex controls; expandable replacement field; include/exclude filters; scope; progress/count summary; grouped file results. Start with Workspace, Folder, and Open Files scopes. Add Changed Files once structured Git status exists. Explorer's context menu supplies Find in Folder.

Results show relative path, line number, highlighted match, and enough context to distinguish hits. Single activation previews the exact range; double-click pins the file. Keyboard navigation, visible focus, accessible toggle names, and announced result counts are required. Keep state when switching activity tabs.

Distinguish empty query, searching, no matches, invalid regex, cancelled, incomplete results, and failure. Display skipped-file counts and reasons. Do not label a capped or failed search complete.

### Search implementation decisions

1. Run an independent workspace scan. Use a pinned, packaged ripgrep executable through a narrow native transport; do not require users to install it. Ripgrep provides ignore-aware traversal and regex search, and uses MIT/Unlicense licensing. Verify the exact release, licenses, package integrity, and target binaries before adding it. See the [upstream project](https://github.com/BurntSushi/ripgrep).
2. TypeScript owns query state, typed options, result interpretation, ordering, buffer overlays, and replacement plans. Rust only validates scope, constructs allowlisted arguments, starts/stops the fixed executable, and streams bounded output. No general shell command API or new Node sidecar is needed.
3. Debounce input initially by 200 ms. Tag each request and batch with workspace revision and request ID; cancel the previous process and reject stale batches. Bound queued output and virtualize long result lists.
4. Honor ignore files by default. Expose independent ignored-file and hidden-file controls; always exclude Git metadata. Do not follow directory links initially. Scope filters cannot bypass workspace authorization.
5. Keep initial search and replacement within the existing 10 MB UTF-8 text envelope. Report binary, unsupported-encoding, inaccessible, and oversized files explicitly. Start with a 10,000-match display cap and label truncation; tune after measurements.
6. Define regex syntax as ripgrep's default engine, with no PCRE2 in the initial release. Use that same engine on dirty buffer snapshots through stdin. This avoids inconsistent JavaScript and native regex behavior. Test Unicode whole-word behavior and zero-width matches.
7. Open dirty buffers are authoritative: suppress their disk hits and merge results from their current content/version. Share filter semantics across buffers and disk. Convert UTF-8 byte offsets into the editor's UTF-16 offsets with tested Unicode handling.

### Replacement contract

Preview changes before applying, with selection by match, file, or complete result set. Capture document versions or disk content fingerprints; revalidate before every write and skip stale files with an actionable report. A replacement over truncated results must explicitly target the shown selection or perform a complete fresh scan before offering Replace All.

Apply open-document changes through existing undo history and leave them dirty. Closed-file changes use guarded native writes, preserving BOM and line endings. Keep bounded recovery snapshots with a documented storage limit and reject a batch exceeding that limit before writing. Undo validates post-write versions before restoration. Cross-file replacement is not atomic: report applied, skipped, and failed files, and offer recovery for applied files. A separate process can still race a filesystem operation; do not promise transaction-level guarantees.

Start with literal replacement. Add regex capture replacement only after the template syntax, captures, empty matches, and Unicode offsets have shared conformance tests.

## Source control experience

Sidebar order: repository/branch selector and refresh; commit message; Commit Staged button and staged count; Conflicts, Staged Changes, Changes, and Untracked groups. Show a file in both staged and unstaged groups when appropriate. Keep status letters/icons alongside colors. Preserve commit drafts per repository.

Clicking a staged file compares HEAD with index; clicking an unstaged file compares index with disk. Label these baselines clearly. Unsaved editor content receives a visible indicator and a Save and Refresh action; staging uses saved content. Diffs support additions, deletions, rename paths, binary summaries, next/previous hunk, and unified view first. Deleted files open a diff without attempting a normal disk read.

### Git implementation decisions

- Continue using the installed Git CLI through fixed native commands. Distinguish Git unavailable, non-repository, clean, loading, stale, and failure states. Do not silently convert command failures to a clean repository.
- Extend porcelain v1 parsing to preserve both status columns and rename source/destination. Keep explorer badges as a derived projection. Add branch/upstream metadata separately. Git documents the machine-readable format and rename rules in [git-status](https://git-scm.com/docs/git-status).
- Use repository identity plus a generation for requests; serialize mutations per repository. Refresh after save, filesystem operations, Git operations, and window focus. Begin with debounced visible-panel polling; add a small native notification adapter only if measurement warrants it.
- Native code resolves and validates repository identity and paths independently of the frontend. Use literal pathspec handling, argument arrays, bounded output, and no shell interpolation. Retain explicit unsupported-filename errors until byte-safe transport exists.
- A nested workspace is especially important: its status is scoped, while commits operate on the repository index. Initially allow scoped review/staging but require opening the repository root through the native folder flow before enabling commit or branch operations. Do not silently include unseen staged files or widen filesystem authorization.
- Commit only staged content. Do not auto-stage on commit. Preserve the draft on failure, expose hook/signing/identity errors, and never bypass hooks. Refresh and verify actual repository state after interrupted operations before offering a retry.
- Discard shows the exact affected paths and uses recoverable snapshots; deleting untracked files is a separate explicit action. Bulk discard must not include untracked files implicitly.
- Unborn HEAD, detached HEAD, conflicts, renames, and partially staged files need explicit behavior. Block ordinary commit while conflicts remain; manual resolution can be staged intentionally.

## Delivery sequence and acceptance gates

| Phase                     | Deliverable                                                                                                                                    | Required evidence before proceeding                                                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0: Foundations            | Structured Git model, repository states, request cancellation/versioning, exact-range editor navigation, guarded writes, packaged-search spike | Old workspace results never reach a new workspace; Unicode ranges select correctly; external edits are detected; packaged executable works on Windows.                                                 |
| 1: Search                 | Sidebar, full-depth scan, scopes, filters, literal/regex search, buffer overlays, keyboard navigation                                          | Finds a fixture deeper than six folders; honors ignore settings; unsaved content wins; invalid/slow/cancelled searches remain responsive.                                                              |
| 2: Git review             | Repository/branch display, independent groups, file diffs, refresh lifecycle                                                                   | All status combinations and diff baselines match a disposable Git repository, including staged plus unstaged changes in one file.                                                                      |
| 3: Local editing workflow | Replacement preview/recovery; stage/unstage files; staged-only commits; explicit discard                                                       | Stale replacement never overwrites known external edits; partial failures are reported; commit contains exactly the reviewed index; failures preserve drafts and work.                                 |
| 4: Collaboration          | Branch create/switch, fetch, pull, push, upstream selection, conflict workflow                                                                 | Protect dirty buffers; default pull is fast-forward only; divergence gives choices; use existing credential helpers; authentication failures are actionable. No default force push or automatic stash. |
| 5: Advanced review        | Hunk staging, split/word diffs, history/blame, three-way merge, stash, multiple repositories, pinned searches                                  | Each feature has focused integration fixtures; stale hunk actions are rejected; repositories remain isolated.                                                                                          |

Release the core after phases 0–3 meet their gates. Phase 4 completes the everyday remote workflow. Prioritize phase 5 from actual usage; editable multibuffers, changelists, a commit graph, worktree management, and AI features are separate follow-on scope.

## File boundaries and verification

Add focused `SearchPanel.tsx`, `SourceControlPanel.tsx`, and `DiffEditor.tsx` components as their phases land. Add `src/services/search.ts` and `git.ts` for feature logic and focused tests. Extend `native.ts`, the editor handle, shared tab types, commands, and status bar as needed. Keep `App.tsx` responsible for connecting workspace/document state, and `Sidebar.tsx` for panel selection. Extend the active native Git/filesystem modules and command registration only for narrow operations.

Use TypeScript tests for parsing, search merging, offset conversion, stale responses, and replacement planning. Use disposable Git repositories for first commit, index/worktree combinations, renames/deletes, conflicts, hooks, nested folders, and index locking. Cover Windows paths, spaces, Unicode, CRLF, BOM, junction boundaries, permission errors, and oversized/binary files. Browser UI tests validate interaction and accessibility; desktop smoke tests validate actual IPC and packaged tools.

Run `npm test`, `npm run build`, relevant `npm run test:ui` cases, and formatting checks for each implementation slice. Native changes also require `cargo fmt --check`, `cargo check`, relevant tests, and practical Clippy checks. Do not substitute mocked UI success for native integration evidence.

Benchmark on a documented Windows machine with 1,000- and 50,000-file fixtures. Initial targets, not current claims: first results within 500 ms warm/1.5 s cold for a selective query on the larger fixture; cancellation within 250 ms; no repeated main-thread tasks over 50 ms during typing; updated Git status within 1 s after local actions on the smaller fixture. Record total completion, peak memory, and Git timings separately. Adjust budgets based on measured evidence before release.
