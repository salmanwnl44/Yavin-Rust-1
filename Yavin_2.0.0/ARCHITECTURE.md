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
4. Add conflict detection for open documents before enabling autosave. The watcher reports external changes (see [Filesystem events](#filesystem-events)) and the explorer follows them, but an open, dirty document is not yet told that its file changed on disk; the guarded save still refuses to overwrite it.
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

**Not yet on this model:** path-keyed maps and sets in `App.tsx`/`Sidebar.tsx`, inline joins and splits, and the Git `repositoryId` (`normalizeCommonDir`; persisted as `commonDirHint`). These are safe today only because each gets every path from native in one spelling.

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

## Filesystem events

The watcher reports what happened to the filesystem under the open folder. It owns nothing else: the explorer, Git and (later) documents each decide what a change means to them.

**Where it lives.** `src-tauri/crates/ide-workspace/src/resource_events.rs`, an exception to TypeScript owning behavior. It has to sit next to the event source, for three reasons:

- A burst of thousands of raw events cannot be sent over IPC just to be merged on the other side.
- The two halves of a rename are recognisable only as adjacent notifications.
- Yavin's writes happen in native commands, which must register what they expect before touching the disk.

TypeScript receives typed, bounded batches (`src/services/resourceEvents.ts`).

**Pipeline**

```text
notify 9 (ReadDirectoryChangesW / inotify / FSEvents), recursive on the canonical root
  -> normalize   each OS event -> operations on paths cleaned by clean_path_str; .git internals dropped
  -> pair        a rename's old-name and new-name notifications -> one rename
  -> coalesce    the burst -> at most one change per resource, in order; bounded
  -> attribute   a change whose resulting disk state matches a Yavin operation's expectation
  -> emit        "resource-changes" { generation, root, changes, rescan }, only while the watch is live
```

**Contract.** Each change is one of the following. `operation` is present only when a Yavin operation accounts for the change.

| `kind`     | Fields                                  |
| ---------- | --------------------------------------- |
| `created`  | `path`, `operation?`                    |
| `modified` | `path`, `operation?`                    |
| `deleted`  | `path`, `operation?`                    |
| `renamed`  | `path` (new name), `from`, `operation?` |

`rescan` lists folders whose changes were not all observed. `watcher-status` { generation, root, state: `watching` or `failed`, message? } reports the watch's health; generation 0 means it never started. No file contents are ever sent.

**Filtering.** Only paths inside a `.git` directory are dropped. Git's machinery churns on every Git command, and `watcher::start_git_watcher` follows the parts of it that matter. `build`, `dist`, `target`, `node_modules` and `.cache` are ordinary folders to the watcher, since a folder with one of those names can hold hand-written source. Deciding what matters is each consumer's job:

- **The explorer** re-lists only loaded parents of changed paths (`directoriesToRefresh`). A build writing into a collapsed `target/` therefore re-lists nothing.
- **Git** is asked for status after any external change and applies its own ignore rules. During a long build that is at most one status per batch, alongside the panel's existing 5-second poll.

**Batching.** A burst ends after `SETTLE` (300 ms, the value the workspace watcher already used) without events, or after `MAX_BATCH_LATENCY` (1 s), whichever comes first. The cap means a build that never pauses is still reported.

**Coalescing.** Changes keep the order in which their paths first changed, never a map's order.

- A creation followed by writes is `created`.
- Repeated writes are one `modified`.
- A creation then a deletion cancels out.
- A deletion then a re-creation is `modified`.
- A rename of a file created in the same burst is a creation at the new name. This is an atomic save: the temporary file never surfaces.
- A rename followed by writes is the rename, then `modified`.
- Chained renames collapse into one. A rename back to the original name is `modified`.
- A rename onto a path replaces whatever was held for that path.
- A folder rename is one change, with nothing for its contents; consumers re-list if they need to.

**Rename pairing.**

- A pending old name pairs only with the next notification, and only if that is a new name. On Windows the two are consecutive records of one completion; on Linux they share an inotify cookie, and both cookies must match.
- Anything else arriving first means the pair is not trusted: the old name becomes `deleted` and the new name `created`. Unrelated files are never guessed to be a rename.
- At most one old name is pending at a time, and none outlives its batch.
- On Windows, a move between folders is reported as a removal plus a creation, and stays that way.

**Bounds and rescans.**

- Past `MAX_PENDING_CHANGES` (4096), a batch stops itemising. It reports `rescan` of the deepest folder containing everything it saw: a build flooding `target/debug` becomes a rescan of `target/debug`.
- A batch keeps at most 16 rescan scopes before collapsing them into the root.
- notify 9 reports lost notifications (`ReadDirectoryChangesW` discarding its buffer) as a rescan. notify 8 dropped them silently, which is why the version is pinned to `=9.0.0-rc.5`.
- An error from the watch, or the root being removed, produces a rescan of the root and a `failed` status.
- A consumer re-reads each `rescan` scope. For the explorer, that means every loaded folder inside the scope, plus the scope's parent.

**Generations.** Every watch gets a process-wide increasing generation.

- Starting a watch first stops the previous one.
- Dropping a watch clears its live flag under the same lock every emission takes. Nothing from it is delivered afterwards, and a burst it was still collecting is discarded.
- The UI's `createWatchTracker` also applies a batch only if it is for the open folder (compared as a resource) and from the newest generation seen.
- The window opens one folder, so there is one watch. The contract names its root so that several can coexist.

**Yavin's own writes** are credited to the operation that made them (see [File operations](#file-operations)). The explorer skips credited changes, since each operation re-lists what it changed.

**Invariants**

1. The watcher reports filesystem changes; it does not own explorer, Git, document or index state.
2. Every watcher path is cleaned exactly as every other native path (`clean_path_str`). Identity beyond that is `resource.ts`.
3. Consumers decide visibility. The watcher hides nothing but `.git` internals.
4. A stale generation never updates current state.
5. Rename pairing is bounded, and nothing pending outlives its batch.
6. An unpaired rename degrades to a deletion and a creation.
7. Lost notifications, overflow and failure produce an explicit rescan, and `failed` where the watch is down.
8. Rescans are scoped to the smallest folder known to cover what was missed.
9. Yavin's writes are attributed to their operation by the state they leave, never by timing.
10. A failed or expired operation cannot account for any change.
11. Watcher state is bounded: one pending rename, 4096 changes and 16 rescan scopes per batch, and 256 operations of at most 64 expectations each.
12. Replacing or closing a watch invalidates it and discards its pending burst.
13. Events carry resource paths, never contents, and ordinary events cost no file reads.
14. Changes reach the UI only through the typed `resource-changes` and `watcher-status` contract.

## File operations

One logical action -- a save, a create, a copy, a Git switch -- is one **operation** (`src-tauri/crates/ide-workspace/src/operations.rs`), however many filesystem effects it has. The command begins it, registers every effect it will have as an `Expectation` **before** touching the disk, runs, and completes it or fails it with its result. Dropping the guard without either (an early return, a panic) fails it. When the watcher reports a batch, `ExpectedWrites::attribute` credits each change to the newest operation whose expectation the disk, read at that moment, satisfies. Consumers only ever see the resulting `operation` id on a change; expectations never cross the event boundary.

| Operation     | Command                                                               | Registers before acting                                                                                                                   |
| ------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Save          | `write_file_guarded`                                                  | the temporary file (`Transient`: gone, or holding exactly the bytes), the target (`Content`: exactly the bytes), any folders it must make |
| Create file   | `create_file`                                                         | every missing ancestor folder (`Directory`), the file (empty `Content`)                                                                   |
| Create folder | `create_directory`                                                    | every missing ancestor folder, and the folder itself (`Directory`)                                                                        |
| Rename        | `rename_path`                                                         | old name `Absent` (`Present` for a case-only rename), new name `Present`                                                                  |
| Delete        | `delete_path`                                                         | `Absent`                                                                                                                                  |
| Copy          | `copy_path`, `duplicate_path`                                         | the destination `CopyOf` its source, plus missing ancestors for `copy_path`                                                               |
| Git           | `git_exec` for commands that write the working tree; `git_clone_repo` | the working tree `GitClean`                                                                                                               |

**What each expectation accepts.** Every check reads the disk when the change is reported, and a file is read only when a size already matches:

- **`Content`, `Transient`, `Directory`, `Present`:** the exact path, in that state.
- **`Absent`:** the path, and deletions below it (a folder's contents go with it).
- **`CopyOf(source)`:** the destination, and anything created or written below it, only if it holds exactly what the matching path under `source` holds. Also accepted: a `modified` report for a folder at or under `source`, because reading a folder to copy it updates its access time. Deletions are never accepted.
- **`GitClean`:** paths in the working tree that `git status` reports as exactly what the index holds. The check runs once per batch per tree, in chunks of 100 literal pathspecs, without optional locks and with the repository's `core.fsmonitor` hook disabled. Anything modified, untracked, ignored or conflicted is not accepted, and neither is anything inside a folder Git lists as a whole.
- **Folder reports.** Adding, removing or renaming an entry changes its folder's modification time, which Windows reports as a change to the folder. A `modified` folder is credited to an operation that changed an entry directly inside it, while that entry is as the operation left it.

**Git.** Only commands that write the working tree become operations:

- `switch`, `pull`, `merge`, `rebase`, `cherry-pick`, `revert`
- `stash` (bare, `push`, `pop` or `apply`)
- `restore --worktree`
- `rm` and `apply` without `--cached`
- `reset --hard`, `--merge` or `--keep`

Of these, `restore --worktree` and `reset --hard`/`--merge`/`--keep` are defensive: the argv allow-list currently permits only `restore --staged` and `reset --soft`, so they never run today. Discarding a file and accepting one side of a conflict do not run Git at all -- they write the file through the editor's save path, and are credited as a Save.

`add` and `commit` are deliberately excluded. `add` makes the index match the working tree, so an external edit that `add` then staged would look exactly like a checkout Git wrote. A Git command that exits non-zero, including a merge stopped by conflicts, fails its operation.

**Lifecycle and bounds.**

- A failed operation is removed at once.
- A completed one is removed 10 s after it finished.
- A started one that never finishes is removed after 30 min, long enough for a slow clone or pull.
- At most 256 operations are held; the oldest completed ones are evicted first. Evicting a still-running one is logged, because its changes will then look external.
- An operation registers at most 64 expectations. A tree (a copy, a checkout) is one expectation, not one per file.
- Timing only frees memory. It never decides attribution.

**Invariants**

1. Every filesystem effect of one logical action is registered to one operation before the effect happens.
2. A change is credited only when the observed disk state is what the operation said it would leave. There is no path- or time-based suppression.
3. An external change is reported as external even while an operation on the same path is running.
4. A failed or abandoned operation accounts for nothing from the moment it fails.
5. Of two operations that could account for a change, the newer is credited.
6. Operations and expectations are bounded, and completed operations expire deterministically.
7. Attribution grants nothing: every operation is still validated by its command, and the event contract is unchanged.

## Rules and references

Follow `../GEMINI.md`: small changes, explicit errors, safe Rust, minimal permissive dependencies, and relevant tests. The user's TypeScript requirement supersedes the previous JavaScript wording.

Native replacement uses [Rust filesystem rename semantics](https://doc.rust-lang.org/std/fs/fn.rename.html). Window exposure follows [Tauri capabilities](https://v2.tauri.app/security/capabilities/); custom filesystem commands also validate their inputs in Rust.
