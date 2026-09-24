# Architecture and migration plan

## Current stack

| Layer                   | Owns                                                                          | Location                                 |
| ----------------------- | ----------------------------------------------------------------------------- | ---------------------------------------- |
| React + TypeScript      | UI, document state, dirty tracking, tab lifecycle, workspace orchestration    | `src/App.tsx`, `src/components/**/*.tsx` |
| TypeScript services     | Typed IPC contract, Git status interpretation, file search and path remapping | `src/services`                           |
| Vite                    | Development server, production assets; build requires strict type checking    | `vite.config.ts`, `tsconfig.json`        |
| Tauri Rust shell        | Window runtime, native folder authorization, command dispatch                 | `src-tauri/src`                          |
| Small native operations | Workspace path validation, filesystem I/O, native dialogs, fixed Git commands | `src-tauri/crates/ide-workspace`         |

Complex features belong in TypeScript. Add a Web Worker for expensive browser-safe computation when measured performance requires it. If a future feature needs Node APIs, introduce a packaged TypeScript/Node sidecar with a narrow, validated protocol. No sidecar or general-purpose shell execution is needed for the current feature set.

## Completed conversion

- All React source is TSX; Vite configuration and shared services are TypeScript.
- Native calls have explicit command argument and response types. Errors propagate to the visible application error banner.
- Workspace data comes from the native shell. Browser preview has no fabricated files or successful saves.
- Save completion preserves dirty state when edits occur during the write. Rename/move/delete remap or remove descendant document paths.
- Quick open uses actual workspace files and full paths. Git parsing is TypeScript and supports NUL-delimited names and rename records.
- The active Cargo workspace contains only the Tauri application and `ide-workspace`. Unused editor/service dependencies and the opener plugin were removed.
- Tauri commands enforce the native-selected workspace boundary. The native folder dialog is the only operation that changes that boundary after initialization.
- Saves use a sibling temporary file followed by replacement, without first deleting the original. Copy rejects existing destinations, self-descendants, and symbolic links encountered during recursion.
- Production CSP is enabled; remote font requests have been removed. Window permissions remain local.
- TypeScript regression tests, native regression tests, formatting checks, and Windows CI provide repeatable checks.
- The seven title menus and command search share TypeScript command definitions. Editor undo/redo, clipboard actions, find/replace, selection, and navigation run in TypeScript. See [MENUS.md](MENUS.md) for scope and verification.

## Preserved historical work

The seven excluded crates (`ide-core`, `ide-config`, `ide-syntax`, `ide-lsp`, `ide-dap`, `ide-terminal`, `ide-plugin-host`) and the inactive `search.rs`/`watcher.rs` are pre-existing, uncommitted work retained for reference. They are not compiled, linked, or maintained as part of the active application. Their old Cargo inheritance is not a supported standalone build. Do not extend them or reconnect complex Rust logic. Port useful behavior into TypeScript only when the corresponding feature is implemented.

## Remaining product and release work

1. Replace the textarea with a TypeScript editor integration when syntax, structured undo, large-file virtualization, and language tooling are implemented. Existing inactive Rust buffers were never connected to the UI.
2. Implement actual language-server, debugging, AI, and extension services in TypeScript. Keep any Rust process transport small and restrict process spawning to explicit user actions and validated arguments. The terminal follows this shape: `src-tauri/src/terminal.rs` only opens a PTY, starts the user's own shell with no arguments, and streams bytes; xterm.js does the emulation in TypeScript. One session exists per window, started by an explicit user action and ended when the panel closes.
3. Add desktop end-to-end coverage for folder selection, CRUD, unsaved-close prompts, window controls, and failure recovery. Exercise nested Git repositories, UNC paths, read-only files, symlinks/junctions, and non-ASCII names on supported platforms.
4. Add file-change reconciliation and conflict detection before enabling autosave. Today refresh is manual, and saving can overwrite changes made externally since opening the file.
5. Measure large-workspace traversal and memory use. Native scans currently run synchronously and stop at a bounded depth; add incremental loading or background execution when needed.
6. Complete accessibility and responsive-layout review. Disable or implement remaining decorative controls. Configure installer signing, release automation, dependency/license auditing, and platform testing before a production release.

Workspace validation protects against ordinary path traversal and resolved symlink escapes. It is not an OS-level sandbox against another process concurrently replacing filesystem entries. Recursive copy can leave a partial destination if it encounters a later error; the error is reported. Installer execution, signing, and full desktop behavior require separate validation.

## Resource identity

A filesystem path is an input. `src/services/resource.ts` decides which resource it names and whether two paths name the same one.

**Ownership**

- The native side owns _physical_ identity, established once when a path enters the workspace: `WorkspaceManager::new`/`validate_path` canonicalise it, which follows symlinks and junctions, expands 8.3 short names and takes the on-disk case. The result crosses IPC through `clean_path_str`: `/` separators, no extended-length prefix.
- TypeScript owns _lexical_ identity: every comparison after that. This is pure string work with no filesystem access and no IPC, because the tree, the Git decorations and rename remapping compare paths synchronously many times per update.
- Whichever way a folder is opened -- the dialog, the recent list, the startup session -- the UI gets back the same cleaned canonical root (`workspace_for` in `src-tauri/src/lib.rs`). That root is exactly the tree's root node, never the spelling the folder arrived in.
- A path handed to a _process_ is a third form, separate from identity. A terminal's working directory goes through `process_cwd` (`src-tauri/src/terminal.rs`), which removes the extended-length prefix that `cmd.exe` refuses. The prefix is kept only where removing it would name a different folder (paths over MAX_PATH, trailing dots or spaces, device names).
- The filesystem owns facts about a resource (existence, `FileNode.is_dir`, size). The Git registry owns repository identity (`repoId`, `repositoryId`). Explorer rows, tabs and search results are views that refer to a resource; their ids are not resource ids.

**Canonical form** (`fileUri`, `fsPath`)

- `/` separators, and extended-length prefixes removed: `\\?\C:\a` is `C:/a`, `\\?\UNC\s\sh\a` is `//s/sh/a`. Device paths (`\\.\`) are refused.
- An uppercase drive letter. Other segments keep the case they were given.
- `.` and repeated separators removed. `..` resolved lexically; a `..` above the root is an error.
- No trailing separator except at a root: `C:/`, `/`, `//server/share`.
- A UNC path's server is the `authority` and its share is the root. `..` cannot climb above the share.
- A relative path needs an explicit base (`fileUri(path, base)`). Without one it throws `missing-base`. `C:foo` (drive-relative) is refused.
- `fsPath(uri)` is the string form used over IPC and in persisted state, the same form native already sends. `formatUri`/`parseUri` give RFC 8089 `file:` URIs with percent-encoding. Only the `file` scheme exists; `parseUri` refuses others with `unsupported-scheme`.

**Case.** A path shaped like Windows (a drive letter or a UNC share) compares case-insensitively; any other path compares exactly. This is decided from the path alone, so it needs no I/O and never changes between calls. macOS paths are therefore compared case-sensitively. That can only keep two spellings of one file apart; it never merges two real files. Folding uses JavaScript's default `toLowerCase`, not Windows' own case table, so exotic Unicode case pairs may compare differently from NTFS.

**Symlinks and junctions** are lexical identity: `ws/link/a.ts` and `ws/real/a.ts` are different resources even when the link points at `real`. The Explorer shows them as different entries, and Git tracks them as different paths. Physical resolution happens only in native `validate_path`, never during a comparison.

**Comparison.** `isEqual` compares `resourceId`s. `isAncestor` is strict and compares per segment, so `src` does not contain `src2`. `resolveWithin(folder, path)` refuses anything outside `folder` with `outside-folder`. Being outside is not an error in general, only when a folder's child was asked for. `containsPath`, `relativePath` and `samePathString` apply the same rules to paths that are already clean strings, for hot paths. `isWithin` and `remapPath` (`services/workspace.ts`), `getRelativePath` (explorer), the Git registry's path lookups, `relativeToRoot`, `resolveInRoot`, and the Source Control and Search relative paths all go through these.

**Folder keys are a separate rule.** `folderKey` (`services/paths.ts`) and native `normalise` (`src-tauri/src/paths.rs`) key the session and trust files. They lowercase on every platform, because that is how existing files were written. Both are tested against `src/services/folderKeys.fixtures.json`, so they cannot drift apart.

**Workspace folders.** `WorkspaceFolder`, `folderFor` and `relativeToFolders` take a list of folders; the innermost folder wins when folders nest. The window still opens one folder (`workspacePath` in `App.tsx`).

**Not yet on this model:** path-keyed maps and sets in `App.tsx`/`Sidebar.tsx`, inline joins and splits, the Git `repositoryId` (`normalizeCommonDir`; persisted as `commonDirHint`), and the `workspace-changed` watcher event, which carries no paths. These are safe today only because each gets every path from native in one spelling.

**Invariants**

1. The Explorer never owns filesystem truth.
2. A resource id identifies a resource independently of any view's row, tab or node id, and those are never used as resource identity.
3. Repository identity stays owned by the Git registry.
4. Relative paths are resolved only against an explicit base.
5. Workspace-relative paths are derived for display, never used as identity.
6. Containment is decided per segment, never by string prefix.
7. Comparing resources performs no filesystem I/O. Physical resolution is a separate, explicit native step.
8. Serialization is deterministic: one resource, one `fsPath`, one `formatUri`.
9. Nothing assumes a single workspace root in the identity layer.

## Rules and references

Follow `../GEMINI.md`: small changes, explicit errors, safe Rust, minimal permissive dependencies, and relevant tests. The user's TypeScript requirement supersedes the previous JavaScript wording.

Native replacement uses [Rust filesystem rename semantics](https://doc.rust-lang.org/std/fs/fn.rename.html). Window exposure follows [Tauri capabilities](https://v2.tauri.app/security/capabilities/); custom filesystem commands also validate their inputs in Rust.
