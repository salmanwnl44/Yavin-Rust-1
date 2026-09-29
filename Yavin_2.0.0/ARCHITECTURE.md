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

1. Add language tooling (language servers, completion, diagnostics) to the Monaco editor; see [Editor](#editor). Existing inactive Rust buffers were never connected to the UI.
2. Implement debugging, AI, and extension services in TypeScript (language servers: see [Language servers](#language-servers-lsp-platform)). Keep any Rust process transport small and restrict process spawning to explicit user actions and validated arguments. The terminal follows this shape: `src-tauri/src/terminal.rs` only opens a PTY, starts the user's own shell with no arguments, and streams bytes; xterm.js does the emulation in TypeScript. One session exists per window, started by an explicit user action and ended when the panel closes.
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
| Create file   | `create_file_with_content` (Save As, recreating a deleted file)       | every missing ancestor folder, the file (`Content`: exactly the bytes); refused if anything is there                                      |
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

## Recovery and persistence safety

A crash in the middle of one of Yavin's file operations must never cost the user data, and recovery must never overwrite a change it cannot prove is its own. Yavin records what each operation is about to do before it does it, and the next start settles what a crash interrupted, acting only where the disk proves an action safe.

**Ownership**

| Owner                                         | Owns                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------- |
| Operation system (`operations.rs`, Module 03) | logical operation identity; attribution of watcher changes            |
| Intent log (`recovery.rs`, `IntentLog`)       | the durable record of what an operation in flight will change         |
| Recovery manager (`recovery.rs`, `recover`)   | startup decisions about interrupted operations                        |
| Durable persistence (`durable.rs`)            | crash-safe writes, versioned reads, backups, sweeping temporary files |
| Session manager (`session.rs`)                | the session file                                                      |
| The filesystem                                | the actual state, which every decision is checked against             |

**Lifecycle.** `lib.rs::expecting` runs every file command, and `git_exec` and `git_clone_repo` follow the same order:

```text
begin (Module 03) -> expect every effect -> record the intent durably -> mutate the disk -> finish -> close the intent
```

- If the intent cannot be recorded, the operation is **refused** before anything touches the disk. This covers an unusable recovery folder, a failed write, and more than 256 operations in flight.
- A normal ending, successful or failed, **closes** the intent: its record is removed. The live process knows the outcome and has already reported it.
- An intent dropped without being closed, which is what a panic does, **keeps** its record. The next start inspects it like a crash.

**Where records live.**

```text
<app local data>/recovery/instances/<pid>-<start ms>/owner.lock     locked by its live process (std File::try_lock)
<app local data>/recovery/instances/<pid>-<start ms>/op-<id>.json   one record per operation in flight
<app local data>/recovery/unresolved/<instance>-<op>.json          what recovery could not settle, until dismissed
```

**Record format.** Each record (`version: 1`) contains `instance`, `operation`, `kind`, `startedAt`, `hash: "xxh3-128"`, and `effects[]`. Every effect is a `{path, pre, post, role}`, where `pre` and `post` are one of:

- `absent`
- `file {size, hash}`
- `directory`
- `present`
- `tree {entries}`
- `copyOf {source}`
- `unknown`

Records never contain file contents: only paths, kinds, sizes and hashes. The hash is xxh3-128 because it is stable across builds, which std's `DefaultHasher` (used by Module 03's in-memory matching) is not.

What each operation records:

| Operation             | Records                                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Save                  | the target's exact bytes before (read from disk) and after; its temporary file absent before and holding the new bytes after; new folders |
| Create file or folder | missing ancestors and the target, absent before                                                                                           |
| Rename                | the old name before and after (absent, or still present for a case-only rename); the new name absent before and present after             |
| Delete                | the target's kind before, with the entry count for a folder, and absent after                                                             |
| Copy                  | the destination absent before, and after a copy of its source                                                                             |
| Git                   | the working tree root, whose state is unknown                                                                                             |
| Clone                 | the destination absent before and present after                                                                                           |

**Crash points.**

| The process dies…                                   | What is left                       | Next start                                 |
| --------------------------------------------------- | ---------------------------------- | ------------------------------------------ |
| before or while writing the record                  | nothing, or a stale `.yavin-tmp`   | nothing to do; the temporary file is swept |
| after the record, before the disk changes           | the record; disk in its pre state  | not applied: finalized                     |
| while changing the disk                             | the record; disk partly changed    | settled by the table below                 |
| after the disk change, before the record is removed | the record; disk in its post state | completed: finalized                       |
| after the record is removed                         | nothing                            | clean                                      |

**Recovery state machine.** A record's owner process ended without closing it, and at the next start the record is settled into exactly one outcome:

- **Finalized** (the record is removed): `completed`, `notApplied`, `rolledForward`, `rolledBack`.
- **Unresolved** (moved to `unresolved/` until dismissed): `conflict`, `partial`, `interrupted`, `corrupt`.

**Decision matrix.** Recovery compares every effect with the disk as it is now and judges the whole operation, never one path at a time:

| Found                                               | Outcome      | Action                               |
| --------------------------------------------------- | ------------ | ------------------------------------ |
| every path in its post state                        | `completed`  | none                                 |
| every path in its pre state                         | `notApplied` | none                                 |
| some paths pre, some post                           | `partial`    | reported; nothing touched            |
| a delete or copy in neither state (half done)       | `partial`    | reported; nothing touched            |
| any other path in neither state                     | `conflict`   | reported; nothing touched            |
| a record that cannot be read, or from a newer Yavin | `corrupt`    | backed up, reported; nothing touched |

**Saves** are the one operation recovery can finish or undo. Here P is the target (h0 its bytes before, h1 after) and T is its temporary file:

| P       | T                          | Outcome and action                                                     |
| ------- | -------------------------- | ---------------------------------------------------------------------- |
| h1      | anything                   | `completed`; T removed                                                 |
| h0      | exactly h1                 | `rolledForward`: P re-checked, then T renamed onto P                   |
| h0      | absent                     | `notApplied`                                                           |
| h0      | other bytes (half written) | `rolledBack`: T removed                                                |
| neither | exactly h1                 | `conflict`: P untouched, and **T kept**, since it holds the saved text |
| neither | absent or other bytes      | `conflict`: P untouched                                                |

**Git** is judged by its lock file. If `.git/index.lock` remains, the result is `interrupted`, reported with the lock's path; otherwise `completed`. A clone's destination is `notApplied` if it is absent, and a `partial` that is never deleted if it exists.

**Startup.** The `setup` hook in `lib.rs` runs before any window can start an operation:

1. It opens this process's intent log.
2. It runs `recover(root, own instance)`. For every other instance folder whose `owner.lock` can be locked (its process is gone), each record is read and settled. Folders still locked belong to another running Yavin and are skipped.
3. It sweeps stale temporary files, and prunes backups of the session and trust files.

The cost follows the number of interrupted operations, never the size of a project: recovery hashes only files that records name. `recovery_report` gives the UI what was done and what is unresolved. The UI logs each item to Output › Recovery and raises one banner if anything is unresolved. The command "Dismiss Recovery Items" calls `recovery_dismiss`, which is the only way anything leaves `unresolved/`.

**Durable writes** (`durable::write_durably`, also behind `config::write_atomically` for the session and trust files):

1. Write a unique sibling temporary file (`.<name>.<pid>-<seq>.yavin-tmp`).
2. Flush it to disk with `sync_all`.
3. Rename it over the target. On Windows this is `MoveFileEx` with replace, which is atomic on one volume.
4. On Unix, also flush the folder. The standard library cannot flush a folder on Windows.

On failure the temporary file is removed and the old file is left untouched. The project save (`atomic_write_file_via`) now closes its temporary file before removing it on failure; Windows refuses to delete an open file, so failed writes used to leave it behind.

**Formats and versions.** A file is read with `durable::read_versioned`: the version is read, then validated, then migrated.

- **A missing version** means the legacy format (version 0), which is read as it stands.
- **A file that does not parse, or has an unreadable version,** is moved aside to `<file>.corrupt-<ms>.bak`. A torn line in the trust file counts: the whole file is set aside, never rewritten without the line.
- **A newer version** is moved aside to `<file>.v<N>-<ms>.bak`, untouched, and never reinterpreted.
- In both cases the run starts fresh: an empty session, or nothing trusted.

| File                                  | Version marker                 | Current |
| ------------------------------------- | ------------------------------ | ------- |
| `session.json`                        | top-level `"version"`          | 1       |
| `trusted-folders.txt`                 | first line `# yavin-trust <N>` | 1       |
| recovery records and unresolved items | top-level `"version"`          | 1       |

**Storage limits.** All cleanup is bounded to one pass over Yavin's own folders, tolerates failure, and never touches project folders. Temporary files in projects are handled only through records.

| Category                             | Limit                                                                  | Cleanup                                    |
| ------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------ |
| Live records                         | 256 per process; a new operation is refused past that                  | removed when their operation ends          |
| Unresolved items                     | no cap, and never deleted automatically; a warning is logged past 1000 | explicit dismiss only                      |
| Dead instance folders                | —                                                                      | removed at startup once settled            |
| Backups (`.corrupt-*`, `.v*`)        | the newest 5 per file, plus any younger than 30 days                   | startup, and on each new backup            |
| Stale `*.yavin-tmp` in Yavin folders | older than 1 hour                                                      | startup; this process's own at normal exit |

**Invariants**

1. Recovery never overwrites a resource whose current state cannot be proven compatible with the recorded recovery state.
2. Every operation that changes the disk is durably recorded before it does, or it does not happen.
3. The existence of a record is never taken as proof that anything should be replayed. Only a save whose target is still exactly its pre-save bytes, and whose temporary file holds exactly the new bytes, is finished.
4. An operation is settled as a whole, never one path at a time.
5. Unresolved items and the evidence they name, such as a kept temporary file, are never deleted automatically.
6. Another running Yavin's records are never recovered: its instance lock is held.
7. Persisted formats are versioned. Unreadable and newer files are moved aside, never overwritten or reinterpreted.
8. A failed save of the session or trust file leaves the previous complete file.
9. Recovery reads only what records name. Its cost follows interrupted operations, not project size.

## Document model

The Document Model (`src/services/documents.ts`) owns what is open in memory; the filesystem owns what is on disk. It is not a second filesystem: it never lists, watches or writes anything itself, and every write it asks for is a Module 03 operation with a Module 04 intent.

```text
Filesystem ──read──> ResourceUri (Module 01) ──> Document Service ──> Document
     ^                                                 │                 │
     │                    resource-changes (Module 02) │                 v
     └──── write_file_guarded / create_file_with_content (Modules 03, 04) ── Editor, future LSP, index, AI
```

| Owner            | Owns                                                                                |
| ---------------- | ----------------------------------------------------------------------------------- |
| Filesystem       | disk truth                                                                          |
| Resource service | resource identity (`resource.ts`)                                                   |
| Document service | in-memory document truth: content, version, dirty, encoding, line endings, language |
| Editor           | presentation and edit interaction, including its undo stack (Monaco)                |
| Git              | repository status                                                                   |
| LSP, index, AI   | language state, the searchable project, runs and ChangeSets -- none yet             |

**A document** has an id, a `uri` and `path` (none for an untitled one), a `key` the editor uses (the path for a file, the id otherwise), a `source`, its `text` (always `\n`, no byte order mark), a `version`, derived `dirty`, `encoding` (`utf8` or `utf8bom`), `lineEnding` (`lf` or `crlf`), `languageId` (`language.ts`, from the name, VS Code's ids), its `base` (the exact disk text it was loaded from or last saved as, with a fingerprint), what happened to the file underneath it (`external`), its save activity, and whether the file is marked read-only on disk (`readOnly`, read on open and reload through the optional `DocumentIO.readOnly`, the native `is_read_only`; a failure to find out counts as writable, never as a reason not to open).

**Sources.** A union, so contradictory flags cannot exist:

- **Disk:** a workspace file. Its id is the Module 01 `ResourceId`, so every spelling of the path -- slashes, case on Windows, `\\?\`, a `file:` URI, a path relative to the workspace -- is one document, and concurrent opens share one read.
- **Untitled:** `untitled:N`, no path. Edited in memory; Save As writes it (`create_file_with_content`, or a guarded replace of a file the dialog confirmed replacing) and it becomes a Disk document (`sourceChanged`). Not kept across restarts: there is no hot exit.
- **Proposed:** `proposed:N`, content Yavin proposes for a file, beside that file's own document. It records the file it was made against (`baseHash`, or none for a new file) and reports its own `proposedHash`. It is never saved: `save` refuses it, and accepting it belongs to ChangeSets (Module 13). It goes **stale** when a check (`isStale`, or a watcher change to its file) finds the file is no longer its base.

**Versions.** Every content change, including a reload, makes a new version; versions are never reused and are never times or hashes. `dirty` is derived: a document is clean when its version is the persisted one or its text is the persisted text.

**Encoding and line endings.** Files are read as UTF-8 (`read_file_content`); a binary file (a NUL in the first 8 KB), a file over 10 MB or invalid UTF-8 fails to open and is not touched. A byte order mark is removed from the text and written back on save. Line endings become `\n` in memory -- what the editor's models use -- and the file's own style is written back, so opening and saving a CRLF file never rewrites it. A file mixing both gets the style most of its lines use.

**States.** `documentStatus` derives exactly one from the parts, so "saving" is never "clean" and a conflict is exactly "the disk changed under unsaved edits":

| Status              | When                                                                                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `neverSaved`        | untitled                                                                                                                                                          |
| `clean`             | a file, in step with the disk, no unsaved edits                                                                                                                   |
| `dirty`             | unsaved edits                                                                                                                                                     |
| `saving`            | a save is on its way                                                                                                                                              |
| `saveFailed`        | the last save failed and the edits are still unsaved                                                                                                              |
| `externallyChanged` | the file was deleted or cannot be read, or its conflict's edits were undone (Revert File takes the disk version); a changed file with no edits is simply reloaded |
| `conflicted`        | the file changed on disk while the document had unsaved edits                                                                                                     |
| `proposed`, `stale` | a proposal; stale once its file is not its base                                                                                                                   |

```text
open ──> clean ──edit──> dirty ──save──> saving ──ok──> clean (if nothing was typed meanwhile, else dirty)
                           ^                 └──fail──> saveFailed (disk unchanged) | conflicted (disk changed)
disk change: clean ──> reloaded (new version)      dirty ──> conflicted ──Revert File──> clean (disk version)
                                                                         └─Keep My Version──> dirty (next save replaces)
file deleted ──> externallyChanged, dirty ──save──> recreated (exclusive create)
                                           └─a different file appears──> conflicted (never reloaded)
```

**Save pipeline.**

```text
Document.save()
  -> capture version v, text, and the base (exact disk text)
  -> write_file_guarded(path, expected = base, content = encode(text))
       -> refused unless the file still holds exactly the base
       -> Module 03 operation: begin, expect temporary file and target
       -> Module 04 intent recorded durably (refused if it cannot be)
       -> temporary file, flush, rename
       -> finish; returns the operation id
  -> base = what was written; persisted = (v, text); clean only if nothing was typed since v
```

A failed write leaves the document dirty and the disk untouched. The failure is followed by one check of the disk: if the file is no longer the base, the document is in conflict.

**Save race.** A save captures the version it writes. On completion, only that version is marked persisted, so an edit typed while it was in flight keeps the document dirty. The next save is guarded on what the first one wrote. A second save while one is in flight starts no second write.

**External changes.** Every `resource-changes` batch is handed to `applyResourceChanges`:

- A change credited to one of the document's own saves (by the operation id the save returned) needs nothing. Because the watcher can report a write before the save's reply arrives, a change reported while a save is in flight is held until the save ends, then compared with the operations the save turned out to be.
- Anything else -- another program, Git, another Yavin operation, a rescan after lost notifications -- is checked by reading the file and comparing it with the base, exactly:
  - the same text, such as a touch, is nothing;
  - a document without unsaved edits is reloaded, which is a new version and a `reloaded` event;
  - a document with unsaved edits enters conflict, keeping both texts and writing nothing.
- A deleted file keeps its document, marked deleted. Its text is now held nowhere but memory, so it is dirty: closing asks, and a different file appearing there -- reported, or found when the exclusive create of a save fails -- is a conflict, never a reload. Saving recreates it exclusively; the same text coming back puts it in step again. An external rename away is a deletion.
- Checks are ordered by a counter, so a slow earlier read never overwrites a later one, and one still reading when its document closes changes nothing. Nothing uses timers.

After a Git command, `revalidate` checks every open file the same way.

**Reload.** `reload` reads the file, then replaces the text, the encoding and line-ending metadata and the base; it advances the version and clears both the external change and dirty. It refuses a dirty document unless the user chose to discard its edits (Revert File asks first). If an edit is typed while it reads, and the edits were not given up, the edit is kept.

**Events.** Typed and scoped to the service (`subscribe`): `opened`, `changed`, `saving`, `saved`, `saveFailed`, `externallyChanged`, `conflict`, `reloaded`, `sourceChanged` (Save As, or a rename by Yavin), and `closed`. There is no global bus. The window uses `sourceChanged` to move a tab and its undo history, and `conflict` to say so once.

**Lifecycle.**

- `close` refuses a document that is being saved, and a dirty one unless the user chose to discard it (the existing confirmation).
- `reset` (changing workspace, Close All) drops everything; opens still loading stay dropped.
- A rename by Yavin moves the documents under it (`moved`), and a delete by Yavin closes them (`removed`).
- Reopening reads the file again as a new document.

**Session.** Unchanged: `session.json` keeps the open files' paths. A reopened file's source is Disk and its language comes from its name, so nothing more is stored. Untitled documents are not written to the session.

**The editor.** The editor is a view of documents; see [Editor](#editor).

**Performance.** An edit is one string comparison with the persisted text and a version increment; nothing is hashed per keystroke. A disk document holds its base text (which the guarded save needs anyway), so an external change is one read and one comparison. Fingerprints are computed only on load, save and reload.

**Invariants**

1. One canonical `ResourceUri` corresponds to at most one live disk-backed document.
2. The Document Model owns in-memory content; the filesystem owns disk state.
3. A document is clean only when its current in-memory version is known to be persisted.
4. Completion of an older save never marks a newer document version clean.
5. Yavin never silently overwrites an externally modified disk resource when local edits could be lost.
6. Proposed content never silently overwrites its base resource.
7. A document's version increases monotonically with content changes.
8. All disk mutations continue to use the Module 03/04 operation and recovery infrastructure.
9. A file's encoding and line endings survive opening, editing and saving it.

## Editor

The editor is Monaco (`monaco-editor` 0.57.0, pinned), a view and controller over the Document Model, never a second document store. **Monaco is an editor implementation, not the source of truth for Yavin documents.**

```text
DocumentService ── Document (text, version, persistence state)
      │  changed / reloaded / saving / sourceChanged / closed
      v                                            ^
EditorModelBridge (services/editorModelBridge.ts)  │ documents.edit(key, model.getValue())
      │  one EditorModel per open document         │
      v                                            │
Monaco TextModel (editor/monacoHost.ts) ── content change listener
      │  setModel / saveViewState / restoreViewState
      v
Monaco editor (components/layout/CodeEditor.tsx) ── EditorViews (view state, focus)
```

| Owner            | Owns                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| Document         | content, version, dirty, save state, disk identity, external change, encoding, line endings, language |
| Monaco TextModel | the editing buffer, undo/redo stack, tokenization, decorations                                        |
| Monaco editor    | cursor, selections, scroll, folding, find widget, IME, layout, focus                                  |
| EditorViews      | each document's saved Monaco view state while it is not shown, and whether its editor had focus       |
| Tab              | which document (its key), its place in the strip; title and markers are read from the document        |

**Loading.** `EditorArea` loads `CodeEditor` lazily, so Monaco is a separate chunk fetched when the first document is shown. `editor/monaco.ts` imports Monaco's editor API with an explicit list of contributions and Monarch tokenizers rather than `editor.main`, which would also bring the TypeScript, CSS, HTML and JSON language services and an LSP client. There is one Monaco editor instance for the editor area; switching tabs swaps its model.

**Model identity.** `createEditorModelBridge(documents, host, naming)` keeps one `EditorModel` per open document, keyed by the `Document` object, not by path: a rename or Save As changes the key and the path but keeps the same model, so its undo stack and decorations survive. **Every open document has at most one canonical Monaco TextModel.** Its URI is built from the document's `ResourceUri` (`monacoUri`: the scheme, authority and path of the canonical URI); an untitled or proposed document gets `untitled:` or `proposed:` from its id. The URI is chosen when the model is created and kept after a rename. If a later document asks for a URI a live model still holds (a renamed model and a newly opened file with its old name), the new model gets the same URI with `?instance=n`. Models use LF line endings: the Document Model keeps text in `\n`, and the file's own style is restored on save.

**Synchronization.** Two paths, neither using a timer:

- **User input:** Monaco's content listener calls `documents.edit(key, model.getValue())` and records the returned version as `synced`. The bridge sets `pushing` while it does, so the document's `changed` event for that version writes nothing back.
- **Anything else** (a reload, Revert File, Keep My Version, replace in files): the bridge sees a version that is not `synced` and calls `applyExternal(doc.text)`. That replaces only the changed span (`changedSpan`: the common prefix and suffix are kept) with `pushEditOperations`, as one undoable step, under the `applying` flag so the content listener does not send it back. Cursors outside the span stay where they are.

External changes therefore follow the Document Model's rules unchanged: a clean document is reloaded and its model updated; a dirty one enters conflict and its model keeps the user's text until **Revert File** or **Keep My Version**. Watcher events never reach the editor directly:

```text
Filesystem -> resource-changes (Module 02) -> DocumentService.applyResourceChanges -> Document -> bridge -> TextModel
```

**Undo and redo** are Monaco's own, per model. Dirty state is never decided by the undo stack: it is `DocumentService`'s comparison of the current text with the persisted text, so undoing back to the saved text makes the document clean again. On the `saving` event the bridge pushes an undo stop, so one undo never merges what was typed before a save with what was typed after it. An external change is one undo step.

**View state.** When the editor leaves a document, `CodeEditor` stores `saveViewState()` (cursor, selections, scroll, folding) in `EditorViews` under the document's key; showing it again restores it. `EditorViews.rename` moves the entry with a rename or Save As, and `forget` drops it when the document closes.

**Saving** goes through the window's commands. Ctrl+S calls `DocumentService.save`, which is one Module 03 operation with its Module 04 intent. Save As goes through `save_file_dialog` and then `DocumentService.saveAs`, and keeps the model. Monaco never writes a file.

**Languages** are mapped from the Document Model's language id (`monacoLanguage` in `editor/monacoHost.ts`): TypeScript and TSX to `typescript`, JavaScript and JSX to `javascript`, TOML, ignore files and properties to `ini`, shell scripts to `shell`, C and C++ to `cpp`, the rest by name, otherwise `plaintext`. A rename that changes the extension changes the model's language. JSON is registered as its own id and coloured with the JavaScript tokenizer: Monaco's JSON language feature starts a language service and needs contributions this build leaves out. Completion, hover, signature help and the rest come from language servers ([Language servers](#language-servers-lsp-platform)); with none for a document, nothing pretends to be one.

**Settings and themes.** `editor/editorSettings.ts` is the one place editor options are made (`editorOptions(settings, view)`), from `DEFAULT_EDITOR_SETTINGS` plus the window's word wrap, zoom and read-only state, and the minimap's look. That one is changed from the minimap's right-click menu or View › Minimap and remembered on this computer (`services/minimapPreferences.ts`: browser storage, validated field by field, failures ignored). The editor's own right-click menu is Monaco's editing menu with Command Palette added last. The themes `yavin-dark` and `yavin-light` are defined in `editor/monaco.ts`.

**Decorations.** `bridge.setDecorations(key, owner, decorations)` replaces one owner's decorations on one document (offset ranges, a class name, whole-line, a plain-text hover); other owners' are untouched. They live on the model, so they follow renames. Hover text is never treated as HTML or as a trusted link.

**Read-only and proposals.** `readOnly` is an editor option. A file read-only on disk opens read-only, with a notice saying so and **Edit Anyway**, which lasts while the document is open (the window's choice, not the document's: the disk fact stays `readOnly`). Saving is still what decides whether a write is refused. A proposed document is a model like any other; saving it is refused by the Document Model, not by the editor.

**Failure.** `EditorBoundary` contains a failure of the editor to its area: the tabs, menus and Save keep working, and unsaved documents stay open. Monaco failing to start is retried by starting it again (a fresh lazy component per attempt). Code that failed to load cannot be retried in the same page -- the browser keeps the failed module -- so it offers to reload the window, after saving.

**Status bar.** The cursor position, the selection and the document's indentation reach the status bar through `services/cursorStatus.ts`, a store of their own: only the few items that show them redraw on a keystroke, never the window. Clicking the position opens Go to Line.

**Tabs.** A tab's context menu closes it, the others, those to its right, the saved ones or all, copies its path and reveals it. Closing several asks once, naming the file when there is one. Closing the tab in front brings its neighbour forward. Reopen Closed Editor (Ctrl+Shift+T) brings back the files closed in this folder, latest first.

**Diff editor.** `createDiffView(container, {original, modified})` shows an original text (an in-memory `yavin-original:` model, not editable) beside a document's model. Disposing the view disposes only the original; the document's model stays. It is the foundation for Git and ChangeSet diffs; nothing in the UI opens one yet.

**Workers.** Only `editor.worker` is used (link and diff computation). It is imported with Vite's `?worker`, so it is emitted as a same-origin script under `assets/` and allowed by the CSP (`script-src 'self'`) in the development server, the production build and the packaged app. No worker is loaded from a CDN, a blob or a data URL.

**Security.** Document text is only ever given to Monaco as model text, so it is rendered as text: markup in a file is never run. Decoration hovers are plain text.

**Markdown preview.** A Markdown document can be shown as its editor, its preview (`MarkdownPreview.tsx`) or both side by side: **Edit | Preview | Split** in the tab bar, View › Toggle Markdown Preview (Ctrl+Shift+V) and Open Markdown Preview to the Side. The mode is the window's, per document; in preview the editor stays mounted, hidden, so its view state and undo are kept.

```text
DocumentService -> Document -> marked (GFM + footnotes) -> DOMPurify -> preview
                                                                          | links, images, "Open in Editor"
                                                                          v
                                                          the window -> the same services as the editor
```

The preview reads the Document Model like the editor and subscribes to its one document, so it follows typing, reloads and Save As; a document over 200 KB is re-rendered after a pause in typing. It never reads or writes a file itself. It is the one place a file's markup is parsed, and it is parsed as data:

- `marked` (GitHub-flavoured, with footnotes from `services/markdownFootnotes.ts`) makes HTML, which DOMPurify sanitizes -- no scripts, event handlers, frames, forms, style elements or attributes, or `javascript:` links -- and the CSP refuses inline and remote scripts besides.
- **Images.** A path resolves against the document's own folder (`resolveMarkdownLink`) and is read through `read_image_file`: workspace files only, image extensions only, at most 20 MB, returned as raw bytes and shown as a `data:` URL (which is all the CSP allows; SVG in an `<img>` runs no script). An image that cannot be read says why; one from the web is not loaded (privacy, and the CSP), with a button that opens it in the browser. A shown image enlarges on click.
- **Links.** The preview never navigates. `#heading` scrolls it (headings get GitHub's ids, and a hover anchor), a relative or absolute path opens that file in an editor (the workspace boundary applies as always), `https` opens the system browser through `open_external_url`, and any other scheme is ignored.
- **Code blocks** have a language label, Copy (with "Copied"), Open in Editor (a new untitled document in that language) and numbered lines, and are coloured by Monaco's own tokenizers and theme (`monaco.editor.colorize`, which escapes what it is given).
- **Outline**: every heading, the one being read marked, a click scrolls to it, a level collapses. **Find** (Ctrl+F in the preview, or Edit › Find while the preview replaces the editor): matches highlighted with the CSS Custom Highlight API, a count, next/previous, match case.
- Not yet (later milestones): Mermaid, math, scroll sync, clickable task boxes, Git views, AI actions.

**Keyboard.** Monaco handles its own keys first, clipboard keys included (so copying with nothing selected copies the line). The window's editing shortcuts act on the editor only while it has the keyboard; elsewhere the key is the focused control's, so Ctrl+A in the Explorer never selects the editor's text. A dialog dismissed with Escape returns focus to what had it.

**Focus.** Showing a document (a tab opened or switched to) focuses its editor. A document that only changed key (renamed in the Explorer, or saved under a new name) keeps focus where it was: its editor takes focus back only if it had it (`EditorViews.takeFocus`). The decision is made once per key, because React StrictMode runs effects twice in development.

**Cleanup.** The bridge counts holders (`retain`/`release`). A model is disposed when its document closes and nothing holds it, or when the last holder releases a closed document; `reset` (changing workspace, Close All) disposes all of them. Unmounting the editor releases its model and disposes the Monaco instance. The bridge itself is disposed on `pagehide`.

**Test hooks.** `window.__yavinEditor` and `window.__yavinMonaco` exist only when `TEST_HOOKS` is on (`import.meta.env.DEV`, or a build with `VITE_TEST_HOOKS=1`); a release build contains neither.

**Large files.** The limit is the native 10 MB (`MAX_EDITOR_FILE_SIZE`). Monaco renders only the viewport, so a keystroke no longer costs more in a larger file. Measured by the UI tests on the development machine:

| File   | Open and paint | Keystroke to paint | Same keystroke, plain textarea |
| ------ | -------------- | ------------------ | ------------------------------ |
| 1 MB   | 484 ms         | 16 ms              | 34 ms                          |
| 5 MB   | 601 ms         | 17 ms              | 217 ms                         |
| 9.5 MB | 686 ms         | 17 ms              | 387 ms                         |

A tab switch measured inside the page takes about 90-160 ms until painted, the same for a 9.5 MB file as for a tiny one. Monaco's model swap is about 17 ms of that; the rest is React changing the active tab and the browser painting.

**Invariants**

1. Monaco is an editor implementation, not the source of truth for Yavin documents.
2. Every open document has at most one canonical Monaco TextModel.
3. Editor operations never bypass DocumentService or Module 03 for persistence.
4. React renders the editor shell; Monaco owns the high-frequency editing state.
5. A change the document makes is applied to the model only when the model does not already hold that version, so edits and displays cannot loop.
6. Cursor, selection, scroll and undo history are editor state; the Document Model never holds them.

## Language servers (LSP platform)

Language intelligence comes from language servers, through a platform under the Monaco editor. None of it owns a document: the Document Model does.

```text
                  Monaco (editing surface)
                     ^            | provider calls
    markers          |            v
Problems store <- src/editor/lspMonaco.ts (LSP <-> Monaco, conversions only)
       ^                          | request(document, method)       edits
       |                          v                                   v
       +-- diagnostics -- src/services/lsp/manager.ts --------> workspaceEdit.ts -> DocumentService
                               |  ^ documents' events                          -> Module 03 file ops
                  one client per server & folder (client.ts: lifecycle, initialize)
                               |
                         jsonrpc.ts (requests, notifications, cancellation, timeouts)
                               |
            nativeTransport.ts -> lsp_start / lsp_send / lsp_stop  (src-tauri/src/lsp.rs)
                               |
            ide-workspace: lsp_process.rs (process, pipes)  lsp_framing.rs (Content-Length)
                               |
                         the server process, in the workspace folder
```

| Owner              | Owns                                                                               |
| ------------------ | ---------------------------------------------------------------------------------- |
| Document Model     | document content, versions, dirty state -- what a server is told, and nothing else |
| Monaco             | the editing surface; widgets (suggest, hover, peek, rename box)                    |
| Language servers   | language intelligence: answers about a document at a version                       |
| Problems store     | diagnostics, per owner (`lsp:<server>                                              | <folder>:<uri>`), feeding markers and the view |
| Filesystem (03/04) | disk; nothing in this platform writes to it                                        |

**Native side.** `src-tauri/src/lsp.rs` is an allow-list, like the checkers: each server id has a fixed program and fixed arguments (`typescript-language-server --stdio`, `rust-analyzer`...). The renderer picks an id and a folder; nothing it sends becomes part of a command. Starting one requires the folder to be trusted (Restricted Mode starts none). The program is looked for in the project's `node_modules/.bin` (for npm-installed servers) and on `PATH`; the working directory is validated to be inside the workspace; the environment is Yavin's own. `lsp_process.rs` spawns it without a console window, turns its stdout into whole messages (`lsp_framing.rs`: `Content-Length` framing, bodies reassembled across reads and multi-byte characters, a malformed header ends the session because the stream cannot be resynchronized), forwards stderr lines to the Language Servers output channel, and reports its exit. Stopping kills the process tree (`taskkill /T` on Windows), and every server is stopped when the window exits. On Windows every server is also put, as it starts, in one Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, whose handle Yavin holds until it ends: however Yavin ends -- closed, killed from Task Manager, crashed -- Windows ends the servers and everything they started (a TypeScript server's `tsserver`, say), with no orderly exit needed.

**Lifecycle.** A client (`client.ts`) is `starting -> initializing -> ready`, then `stopping -> stopped`; a process that goes away is `crashed`; one that never comes up (spawn refused, `initialize` failed or timed out) is `failed`; a server that is not installed is `unavailable`; Restricted Mode is `disabled`. `initialize` sends the client's capabilities (only what is implemented), the root and workspace folders, the server's initialization options; the answer's capabilities, server info and position encoding are kept. Shutdown is `shutdown`, then `exit`, then the process is ended if it has not gone within a timeout. Server-to-client requests are answered: `workspace/configuration` (from the registry's settings), `workspace/workspaceFolders`, `workspace/applyEdit` (through the engine), capability registration, progress; logs go to the output channel.

**Which server.** `registry.ts` maps a language id to servers in order of preference, with their settings and timeouts; the first installed one is used. A server is identified by its id and the workspace folder (`ResourceId`) a document belongs to (`folderFor`): one server per language and folder, two folders get two. Documents outside every folder are not sent.

**Document synchronization.** The manager listens to the Document Model, never to Monaco:

- `opened` -> `didOpen` (text and version); `changed` / `reloaded` -> `didChange`; `saved` -> `didSave`; `closed` -> `didClose`; `sourceChanged` (Save As, a rename) -> `didClose` of the old URI and `didOpen` of the new one (possibly with another server).
- LSP versions are the document's own versions. A change is sent only for a newer version than the server has, so an older state can never follow a newer one.
- Incremental sync sends the one changed span (`changedSpan`, found with native string comparison), converted to a range in the server's position encoding; full sync sends the text; servers with neither are not told about changes.
- Positions (`positions.ts`) convert between UTF-16 offsets and LSP positions in UTF-16, UTF-8 or UTF-32, never splitting a surrogate pair, with line breaks of any kind. Document text is always `\n`; the file's own line endings are the Document Model's to restore on save.
- Untitled documents are sent only to servers that handle them (`untitled:` URIs); proposed documents never (they share their file's URI).

**URIs.** `uris.ts` is the one conversion: a `ResourceUri` goes out as RFC 8089 (`file:///C:/My%20Project/a.ts`); anything a server sends -- including VS Code's `file:///c%3A/...` -- is parsed back to a `ResourceUri` and compared by `ResourceId`, never as a string. Monaco's URIs stay `monacoHost.ts`'s; the adapter maps between models and documents through the bridge.

**Stale results and cancellation.** Every request is made at the document's current version; when the answer comes, a document that changed (or closed) meanwhile makes it a `StaleResultError`, and nothing is shown or applied from it. Monaco's cancellation tokens become `$/cancelRequest` (typing again, closing, a newer request); every request has a timeout; a closed connection rejects everything pending. The one exception is completion: typing on while the list is being fetched moves the document on, and Monaco filters the answer against what was typed since (cancelling the request itself when it no longer applies), so a completion answer for the same document is used even a few keystrokes late -- dropping it left the list closed while typing quickly.

**Diagnostics.** `publishDiagnostics` goes to the Problems store, per server and document (empty clears it). A publication for an older version than the server has is dropped. A document's diagnostics are cleared when it closes, is renamed or saved as another file, when its server crashes or is restarted, and when the workspace closes. The adapter draws the store as Monaco markers (squiggles, the hover, `F8`), also in read-only files; the Problems view lists them with their source.

**Language features.** Providers are registered per server when it first becomes ready, for the Monaco languages of its languages, and only for what its capabilities advertise -- a feature a server lacks has no provider and no command (menu items are disabled with the reason). Implemented: completion (with resolve, snippets, text edits, additional edits, commit characters, deprecated tags), hover (Markdown shown as untrusted text), definition, declaration, type definition, implementation (navigation through the window: another file opens as any file does), references (Shift+F12: a list to pick from, because Monaco's peek view cannot show files that are not open), rename (prepare, then the edit through the engine), formatting, range and on-type formatting, code actions (quick fixes, refactorings, source actions, command-backed actions), document symbols (the Outline view, the symbol breadcrumbs, `@` in the palette), workspace symbols (`#` / Ctrl+T), signature help, document links, semantic tokens (full and delta; colours in the theme; a server that counts in UTF-8 or UTF-32 has its deltas applied to the previous result and the whole result re-encoded to UTF-16 for Monaco, `semanticTokens.ts`), inlay hints, CodeLens (with resolve). Server commands run only if the server advertised them (`executeCommand`); VS Code's `editor.action.showReferences` from a lens opens the references list.

**WorkspaceEdit.** `workspaceEdit.ts` is the one way an edit from a server (rename, code action, `workspace/applyEdit`) -- and later AI changes and refactorings -- is applied:

```text
WorkspaceEdit -> check everything -> DocumentService.edit (text, undoable, unsaved)
                                   -> create / rename / delete file (Module 03 operations)
```

Everything is checked before anything changes: every target resolves, every versioned document is still at its version (else stale), no target is read-only (unless the user chose Edit Anyway), no proposal is edited, no edits overlap. One failure refuses the whole edit, and documents opened only to check it are closed again. Files not open are opened for the edit and left open, unsaved, with tabs. A file operation failing part-way stops there and says what was done. Nothing is written: saving is the user's.

**Workspace folders and watched files.** Servers are told about the workspace's folders in `initialize`. When a folder is added or removed (the Explorer's roots reset), servers that advertise `workspace.workspaceFolders.changeNotifications` get `workspace/didChangeWorkspaceFolders` instead of a restart; the servers of a removed folder stop, with their diagnostics cleared, and documents of an added folder get their servers. Only a change of trust restarts everything. Servers register the files they want to hear about (`client/registerCapability` for `workspace/didChangeWatchedFiles`; the client advertises dynamic registration and relative patterns); every Module 02 watcher batch -- Yavin's own operations included -- is matched against their glob patterns (`glob.ts`: `**`, `*`, `?`, `{a,b}`, `[a-z]`, `[!a]`, case-insensitive on Windows) and watch kinds, and forwarded as `didChangeWatchedFiles` (a rename is the old file deleted and the new one created). A restarted server registers afresh.

**Outline and breadcrumbs.** `outline.ts` asks the server of the document in front for its symbols when it comes to the front, again 300 ms after the last edit, and when its server becomes ready; an answer for an older text or another document is dropped (the last good outline stays rather than flickering). A symbol tree is kept as the server sends it; a flat `SymbolInformation` list is nested by containment; positions become the editor's (UTF-16). The Outline is a section under the Explorer's tree (collapsed until opened, as VS Code's is, so the tree keeps its height; its open state remembered): the symbols in document order, foldable, the one the cursor is in marked, a click putting the cursor on its name. The breadcrumbs above the editor add, after the file's path, the chain of symbols containing the cursor, each clickable.

**Crash recovery.** A crash clears the server's diagnostics and restarts it after a backoff (0.5 s, 2 s, 5 s); a ready server is told every open document again from the Document Model. More than three crashes within three minutes leaves it `failed`, with the reason; clicking the status or View › Restart Language Servers starts it again with the count reset.

**Status.** The status bar shows the server of the file in front: its name when ready, "starting…" / "restarting…" while it is, "not installed", "Restricted Mode", "crashed" or "not running" (with the reason) otherwise. The Language Servers output channel has the servers' own log.

**Tests.** A deterministic fake server (`fakeServer.ts`, no imports) implements everything above and keeps its own copy of each document from the changes it is sent, so a synchronization bug is a wrong answer. The unit tests run it in memory (`testing.ts`); the UI tests bundle it into the page in place of the native commands (`tests/ui/lsp-harness.ts`), so the manager, client, JSON-RPC and Monaco adapter under test are the real ones. The native framing and process layer is tested with a real Node process, including the Job Object ending a server and its own child when the job's handle closes. A real server is tested too, where the project's dependencies are installed (`typescript-language-server`, pinned as a dev dependency): natively, found in `node_modules/.bin` (the npm `.cmd` shim on Windows), initialized over framed stdio and shut down with exit code 0; and in TypeScript (`realServer.test.ts`), the real client and manager driving it through initialize, document sync (an incremental edit), diagnostics, hover, definition, completion and a cross-file rename.

**Performance** (development machine, fake server): a keystroke in a 1.1 MB file costs the sync about 1.7 ms (the changed span and its position; incremental changes of ~170 bytes); twenty keystrokes send 3.5 KB. A server starts and initializes in under 0.6 s (fake; a real server is its own). Completion and diagnostics appear in 0.1-0.25 s. Requests are asynchronous; React never waits on a server.

**Invariants**

1. LSP never owns document contents.
2. LSP never writes files directly.
3. WorkspaceEdits always pass through the WorkspaceEdit engine and DocumentService.
4. Filesystem writes always pass through Module 03/04.
5. Monaco never communicates directly with the filesystem.
6. Stale LSP results cannot overwrite newer document state.
7. Language servers cannot bypass Yavin's trust and security controls: fixed command lines, trusted folders only, advertised commands only.

## Workspace lifecycle

A workspace is the folder (or folders) a window has open, and it is an isolation boundary: nothing that belongs to one workspace -- state, services, watchers, processes, caches, asynchronous work -- may affect another. The bug that motivated this was Source Control still showing folder A's repository after folder B was opened, because the Git registry was one object for the whole application, remembered one list for every folder, and deliberately left the active repository alone when a folder was opened.

```text
Application
     │
WorkspaceManager (services/workspaceManager.ts; the window's instance: services/workspaces.ts)
     │ open(folders)                                   one live context at a time
┌────┴──────────────┐
│                   │
W-A (generation 7)  W-B (generation 8)
closing → closed    opening → active
 │                   │
 dispose, in order:  services made:
  Git registry        Git registry (restores, opens each folder's repository)
  checker cancelled
  terminals closed    the window then resets its own UI state for B
  Problems cleared    (documents, editor views, tabs, Explorer; terminal panel remounted)
  owned cleanups
```

**Identity.** `WorkspaceId` is the folders' `ResourceId`s, sorted -- never a path string: every spelling of a folder is one workspace, and a multi-root workspace is one identity. The window with no folder is the empty workspace.

**Lifecycle.** A context is `opening` while its services are made, `active` once they are, `closing` while they are disposed and `closed` after. Every activation has a **generation**, increasing for the life of the window: A, then B, then A again are three generations, and the second A is a new context with the same identity. There is no way back from `closing`; suspending a workspace to resume it later is a later module.

**Switching.** `open(folders)` with the same folders keeps the workspace. Other folders close the current context completely before the next exists: its services first, then everything it owns (`own`), newest first; one failure is logged and never stops the rest. Opening quickly A → B → C closes A once, never makes B, and answers every caller with C. Every way into a folder (startup, the default workspace, Open Folder, the recent list) goes through `loadWorkspace`, which opens the workspace before the Explorer lists anything. The native side replaces its workspace only once the new folder has opened; a folder that cannot be opened leaves the old workspace exactly as it was.

**Failure.** If a workspace's services cannot be made, the window is left in the empty workspace (and if even that fails, in the closed old one, which is inactive) -- never with one workspace's UI over another's services.

**Stale work.** A context's `signal` is aborted and `isActive()` becomes false when it starts closing. Work that awaits captures the context (or its request's own identity) and checks before applying:

| Boundary                    | Protection                                                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Git open, refresh, events   | the disposed registry is inert (no repositories, no persistence, no notifications); a late open is closed                                             |
| Git watcher events          | routed to the workspace in front's registry by repository identity; the old one's watchers are stopped                                                |
| Checker (Problems)          | the run captures its workspace and drops a late answer; disposal cancels it and clears Problems                                                       |
| Language servers            | a request's answer for a closed or changed document is a `StaleResultError`; diagnostics from a server no longer the manager's are ignored            |
| Explorer listings           | each answer must match the entry and generation it was asked for; the old roots' entries are forgotten                                                |
| Search                      | aborted by a newer query and by the workspace's signal; the native search is cancelled                                                                |
| Terminals                   | each launch has a generation; events of another launch are ignored; a launch that finishes after its view went is closed; disposal closes every shell |
| Filesystem watcher (native) | the old watcher ends before the new one starts; batches carry their root and generation                                                               |

**Ownership.**

| Owner                        | Owns                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| Workspace manager            | which workspace is open; creating and closing contexts; the order of a switch; generations       |
| Workspace context            | identity, folders, generation, lifecycle state, services, cleanups given to it                   |
| Git registry (per workspace) | repositories, `.git` watchers, polling, the active repository, the list remembered for it        |
| Workspace disposal           | stopping the checker, closing the terminals' shells, clearing Problems                           |
| The window (`App.tsx`)       | its UI state, reset on the same switch: documents, editor views, tabs, Explorer, panels          |
| LSP manager                  | servers per workspace folder; follows the Explorer's roots (folders removed: their servers stop) |
| DocumentService              | document content -- unchanged; nothing here holds content                                        |

**Git.** One registry per workspace. It restores what was remembered for that workspace (`yavin.git.repos:<WorkspaceId>`) and opens each of its folders' own repositories; the active repository is the one remembered for that workspace, else a folder's. Leaving closes every repository, stops its watcher and drops its shared commit graph; what was remembered is kept for next time, so A → B → A brings back A's repositories and the one chosen. The list every folder shared before (`yavin.git.repos`) is adopted by the first workspace opened after the upgrade and then removed. Watcher events, guarded operations, cloning and the commit graph resolve the workspace in front (`currentGit()`); the AI Git tools take the registry of the workspace they were made for, with no global default. The commit hover card caches per repository.

**Terminals.** The shells belong to the workspace: its disposal closes all of them natively, whatever the views are doing, and the terminal panel is remounted per workspace, so the next folder's first terminal starts in it (the native side starts a shell in the workspace root at launch). Terminal metadata is not yet restored on A → B → A.

**Documents and editors.** Leaving a folder with unsaved changes asks first; the documents, editor views and tabs are reset, and A's tabs and Explorer state are restored from the session when A is opened again. Unsaved content is not kept across a switch yet.

**Performance** (development machine, UI fixture): closing a workspace takes 16-83 ms (Git registry, checker, terminals, Problems), making the next under 1 ms; Git discovery, listings and language servers then continue without blocking the window.

**Persistence boundary.** Where each kind of state belongs -- today and for the modules that build on this one:

| Kind      | Examples                                                                 | Where                                                        |
| --------- | ------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Global    | theme, keybindings, editor and panel preferences                         | user settings / browser storage, application-wide            |
| Machine   | recent folders, trusted folders, shell detection                         | Yavin's user-data directory (`session.json`, trust file)     |
| Workspace | Git repositories and selection; later workspace configuration            | keyed by `WorkspaceId` in user data (`yavin.git.repos:<id>`) |
| Folder    | shareable project configuration (later)                                  | `.yavin/` in the folder, when a module needs it              |
| Session   | open tabs, active tab, Explorer expansion/selection/scroll; later layout | user data, per workspace (`session.json`)                    |
| Runtime   | shells, language servers, watchers, running checkers, pending requests   | never persisted; ended with the workspace                    |
| Document  | editor content                                                           | DocumentService; recovery (M04) for interrupted saves        |
| Secret    | API keys, tokens, passwords                                              | the OS credential store; never in `.yavin/` or session files |

**`.yavin/`.** Not created by W1. When it is, it holds only what is meant to be shared with the project and is safe to commit (workspace configuration, working-set and changeset metadata). Private session state -- unsaved content, terminal output, AI conversations, Git selection -- stays in Yavin's user-data directory by default, so it cannot end up in a repository. Secrets are never written to either.

**Multi-root.** The manager, identity and Git registry take several folders (each folder's repository is opened; all belong to one `WorkspaceId`), and language servers already run per folder. The window itself opens one folder today; there is no UI to add a second.

**Not yet** (later modules): suspending a workspace so A → B → A keeps A's runtime alive; unsaved content, terminal metadata and layout kept across a switch; `.yavin/` project metadata; an `ActiveResourceContext` resolving the targets of commands (today commands resolve the workspace in front through `workspaces.current()`); AI conversations, agent runs and changesets (none exist yet; the AI Git tools are already bound to one workspace). The Output channels are application-wide logs.

**Invariants**

1. No project-specific service is application-global: each belongs to one workspace context.
2. A workspace is fully closed before the next one is created.
3. Work that finishes after its workspace closed changes nothing.
4. What a workspace remembers is stored under its own identity, never shared with another.
5. The window is never left with one workspace's UI over another's services.

## Explorer provider platform

The Explorer is a projection of the filesystem, never a store of filesystem truth. `src/services/explorerProvider.ts` holds what has been listed; `src/services/explorerStore.ts` holds what the user did to the view; the existing tree view (`Sidebar`, `TreeRow`) renders the one and reads and writes the other.

```text
Filesystem ── list_workspace_files ──┐          ┌── resource-changes (Module 02)
                                     v          v
                        ExplorerProvider  (resource projection)
          typed nodes · ResourceId identity · per-folder state and generations
                     │ provider events                  │ projection()
                     v                                  v
      ExplorerStore (UI state)  ──── Set/setter ───>  Explorer view (virtualized rows)
```

| Owner                    | Owns                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------- |
| Filesystem (native side) | what is on disk                                                                         |
| Resource service         | identity (`ResourceUri`, `ResourceId`)                                                  |
| Explorer provider        | the hierarchy as listed: nodes, which folders are loaded, failures, capabilities, roots |
| Explorer store           | expansion, selection, anchor, focus                                                     |
| Explorer view            | rendering, virtualization, keyboard, menus, drag and drop, inline editing               |
| Documents, Git           | their own state; the Explorer only reads Git decorations                                |

**Nodes.** A typed union: `workspace` (a root), `directory`, `file`, and `error` (a failed listing, in place of the folder's children). A resource node's id is its Module 01 `ResourceId`, so it survives refreshes, re-renders, expansion and unrelated changes, and every spelling of a path is one node. Nodes carry their `ResourceUri`, the native spelling of the path, their parent's id and their metadata. No path normalization exists here beyond `resource.ts`.

**Provider API.** Snapshots are synchronous: `getRootNodes`, `getNode`, `getChildren`, `childrenState` (`unloaded`, `loading`, `loaded` or `failed`), `capabilities` and `projection`. Only listing is asynchronous: `loadChildren(id, signal)`, `refresh(ids?)` and `refreshAround(paths)`. `ExplorerProvider` is the contract; the filesystem provider is the one implementation. Capabilities (`canOpen`, `canCreateFile`, `canCreateDirectory`, `canRename`, `canDelete`, `canMove`, `canCopy`, `canRefresh`) come per node from the provider, so future virtual, remote or archive providers need no UI guessing.

**Events.** Provider-local and typed, with no global bus: `created`, `changed` (metadata), `deleted` (with its subtree), `renamed` (from and to, with the subtree), `childrenChanged`, `reset` (the roots changed) and `error`. The store and the window subscribe to their own provider.

**Watcher integration.** The window passes every accepted `resource-changes` batch, minus changes credited to Yavin's own operations (which re-list what they changed as they finish), to `applyResourceChanges`:

- A change shows only as an entry of its folder, so only the parent is re-listed, and only if loaded. It is found by id in constant time, with no tree walk.
- A change inside a folder that is not loaded costs nothing.
- A burst re-lists each touched folder once.
- A rename moves the known node, and its loaded subtree, to the new identity at once. Then both folders are re-listed to confirm.
- A `rescan` re-lists every loaded folder inside the scope, and the scope's parent.

**Reconciliation.** A listing is reconciled into its folder only:

- A child that is still there keeps its node object and its own loaded children.
- A changed child gets new metadata under the same id.
- A new child is added.
- A missing child is removed with its subtree.

Nothing outside the folder is touched. The projection is cached per node by a version that changes only for the node and its ancestors (O(depth)). A change in one folder therefore rebuilds that folder and the path to the root, and every other `FileNode` is the same object, so the view's memoized rows do not re-render. A refresh that finds nothing new returns the identical tree.

**Async loading, cancellation and generations.** Every listing request takes a new generation for its folder. An answer applies only if it is for the newest request, and only if the folder is still the same entry: not forgotten, not moved, not replaced by another workspace's folder of the same id. Otherwise it is dropped, so an older answer never overwrites a newer one. Concurrent loads of a folder share one listing. A caller's `AbortSignal` withdraws only that caller: an answer is dropped as abandoned only if every caller waiting on it aborted. The view aborts a folder's load when the folder is collapsed.

**Errors.** A failed first listing is the folder's typed state (`failed`, an `error` node, `loadError` in the projection); it is never turned into an empty folder. The view shows it with Retry. A failed refresh of a loaded folder keeps what was known and reports the error. The provider stays usable.

**Refresh.** `refresh()` re-lists every loaded folder at once. `refresh(ids)` re-lists those folders and every loaded folder inside them, which covers a workspace, a root or a directory. `refreshAround(paths)` re-lists the nearest loaded folders after one of Yavin's own operations. Each goes through the same reconciliation, so identities and UI state survive. Overlapping refreshes need no queue, because the newest listing of each folder wins.

**Multi-root.** `setRoots(paths)` keeps roots that stay, with everything known under them; forgets roots that go; adds new ones unloaded; and emits `reset`. Roots are separate nodes, never flattened into one hierarchy. With one root, the view shows it as the header above the tree; with several, each is a row of its own (see [Explorer view](#explorer-view)). The native side still opens one folder per window, so nothing in the product adds a second root yet; the view and store are ready for it.

**The store.** It keys state by node id and records the path each entry was recorded under. It follows the provider:

- `renamed` moves the state of the node and its subtree to the new ids, so a renamed folder stays expanded and a moved file stays selected.
- `deleted` drops the state.
- `reset` clears selection and focus.

Its API is by node id: `ids(set)`, `setExpanded`, `setSelection`, `anchor`/`focused` and their setters, `reveal(path)`. `paths(set)` gives the recorded paths for the session. Each set's `ids` is the same object until that set changes, so moving the selection never re-flattens the tree.

**Performance.** Measured in the provider tests, in folders of 1,000 files:

| Files   | Loading every folder | One change applied and projected |
| ------- | -------------------- | -------------------------------- |
| 10,000  | 90 ms                | about 10 ms                      |
| 100,000 | 0.7 s                | about 7 ms                       |
| 500,000 | 3 s                  | about 6 ms                       |

That is one listing and one path rebuilt, not a tree rebuild. In the UI, a folder of 20,000 files expands in about 0.7 s and renders about 34 rows, because virtualization is unchanged.

What is still proportional to the loaded tree:

- `refresh()`, `rescan` and `refresh(ids)` scan the loaded folders to find those in scope. This happens on explicit refreshes and lost-notification rescans, never per change.
- The view's row flattening walks the expanded part of the tree on each change, as before.

**Invariants**

1. The Explorer is a projection of resource and workspace state and is never the source of filesystem truth.
2. Filesystem changes enter the Explorer through the provider boundary, never by the view mutating a tree.
3. Explorer node identity is resource-based (`ResourceId`) and stable across refreshes.
4. An older listing never overwrites a newer one; an abandoned one changes nothing.
5. A failed listing is an error state, never an empty folder.
6. One change re-lists at most the folders it shows in; it never rebuilds the tree.
7. The Explorer store holds UI state only, and it follows renames and deletions.

### Explorer view

The Explorer view (`Sidebar`, `TreeRow`, `explorer/menu.tsx`, `explorer/actions.ts`) renders the provider's projection with the store's state. It keeps no filesystem facts and makes no filesystem decisions of its own.

```text
WorkspaceManager (native: one folder per window)
      ↓ list_workspace_files, resource-changes
ExplorerProvider      nodes · ids · view keys · per-folder state · capabilities · roots
      ↓ projections()             ↓ events
ExplorerStore         expansion · selection · anchor · focus · reveal   (one per workspace, in App)
      ↓
flattening            projection + expanded ids → visible rows, lookup tables, folders to list
      ↓
virtualized Sidebar   rows keyed by view key; state by node id; Git decorations by path
```

**Identity.** A row's state is keyed by the node id (the resource's `ResourceId`). Its React key is the provider's view key, which is given when the provider first learns of the node and kept through renames and moves. A renamed row is therefore the same element: its selection, its expansion and its keyboard focus survive. Rows carry `data-id`; the keyboard handler and focus management read it, never a path.

**Roots.**

- **One root:** the header above the tree is the root and its entries start at depth 0, as before.
- **Several roots:** each root is a top-level tree row (`aria-level` 1) with its entries below it. Each root expands and collapses on its own. Selection, Shift/Ctrl ranges, arrow keys, Home/End and type-to-find all run across roots.
- **Header buttons** (New File, New Folder) act on the root holding the focused row.
- **Drops across roots** are moves like any other.
- **New roots** are shown expanded the first time they appear.

**Capabilities.** `explorer/actions.ts` maps each action to the provider capability it needs: open, new file, new folder, rename, delete, cut and move, copy and duplicate, paste, refresh. It is the one place those checks live.

- **Context menus** hide what is not supported. For example, a root has no Rename, Delete or Cut.
- **Keyboard shortcuts** (F2, Delete, Ctrl+X/C/V/D/N), **header buttons** and **drag and drop** check the same mapping: a node that cannot be moved cannot be dragged, and a folder that cannot take entries is no drop target.
- **Create and paste** check the folder they would put things in.

**Loading and errors.** Under an expanded folder, the view shows the provider's state:

- **Loading…** while its listing is on its way.
- **⚠ and the error, with Retry**, if it failed. A folder whose first listing failed shows no children. A loaded folder whose refresh failed shows the error above what is still known of it.
- Retry is `provider.retry(id)`: the folder is listed if it was never listed, and re-listed otherwise.
- The view starts listings for expanded, unloaded folders and aborts them when the folder is collapsed; the provider's per-caller cancellation and generations decide what is applied. There is no second loading mechanism.

**Reveal.** `explorerStore.reveal(path)`:

1. finds the path's root and the folders above it (`provider.ancestorsOf`, from the path alone)
2. expands them
3. has the provider list them, outermost first
4. selects the target and makes it the focused row, which the view scrolls into view without taking keyboard focus

A newer reveal supersedes one still listing. Revealing the active editor, a search result opened, a Git change opened, a Quick Open pick and View › Reveal Active File in Explorer all go through this one implementation. The view does no traversal.

**Selection and expansion.** Both are store state.

- **Rename or move:** state follows the node's new identity.
- **Refresh:** nothing collapses, because reconciliation keeps identities.
- **Deletion:** the deleted entries leave the selection, and nothing else is selected in their place, as before.
- **Collapse All:** collapses every folder; with one root the root itself stays open, with several every root collapses.

**Mutations.** Every create, rename, move, copy, paste, duplicate and delete goes from the view to App's handlers, then through the native command, which is a Module 03 operation with its Module 04 intent. The tree is updated by the provider:

- `refreshAround` re-lists the affected folders as each of Yavin's own operations finishes.
- A successful rename or delete is announced to the provider (`moved`, `removed`), so identities and UI state follow at once.
- The watcher's report of the same change is then reconciled like any other.

The view never inserts a result into a tree itself. A collision (a copy or a move onto an existing name) is refused by the native side and reported.

**No folder.** With no folder open, the Explorer shows a collapsible **No Folder Opened** section ("You have not yet opened a folder." and an Open Folder button), outside the tree, which only ever holds the tree's rows. The recent folders are on the Welcome page.

**Git decorations** stay the Git store's. Rows look them up by the resource's path when they render; the provider and store know nothing of Git.

**Session.** `session.json` keeps, per folder: the expanded folders, the selection (up to 100 entries) and the focused entry, all as paths, plus the scroll offset. The two new fields are optional, so older files still load. The store for a workspace is made when the window has taken the folder, which is also when the provider knows its root, so the saved paths resolve to nodes. The tree is only handed to the view once the workspace path is set, which avoids the Module 07 startup race.

**Accessibility.**

- Rows are `treeitem`s with `aria-level`, `aria-selected`, and `aria-expanded` on folders and roots.
- There is exactly one tab stop (roving tabindex), and the tree is `aria-multiselectable`.
- Error rows are `alert`s.
- After a rename, keyboard focus returns to the renamed row, which is the same element.

**Performance.**

- Flattening runs when the projection, the expanded set or an inline edit changes, never for selection or focus.
- Rows are memoized on their node object, so a change in one folder re-renders the rows whose nodes changed. In the UI test, adding one file to a folder of 20,000 re-renders fewer than 60 rows.
- A folder of 100,000 files expands in about 2.3 s (mostly the listing itself) and renders fewer than 200 rows. An arrow key in it takes about 90 ms, which was 255 ms before the set-identity fix.
- Cut and dragged states are sets, looked up in O(1) per row.
- Only the rows in view are drawn, from the tree's measured height. The tree stays mounted, hidden, while another view (Search, Source Control, ...) is showing: remounting it left the measurement watching a detached element, so a tree came back with only a handful of rows drawn and its scroll position lost. A measurement taken while hidden is ignored.

**Invariants**

1. Explorer UI state never becomes the source of filesystem truth.
2. Filesystem mutations go through the existing operation pipeline; the view never edits the tree.
3. Explorer identity is based on stable resource and node identity, not display paths: state by node id, React identity by view key.
4. Every Explorer action is checked against provider capabilities, whichever way it is invoked.
5. A folder's loading and failure are shown as such, never as an empty folder.

## Rules and references

Follow `../GEMINI.md`: small changes, explicit errors, safe Rust, minimal permissive dependencies, and relevant tests. The user's TypeScript requirement supersedes the previous JavaScript wording.

Native replacement uses [Rust filesystem rename semantics](https://doc.rust-lang.org/std/fs/fn.rename.html). Window exposure follows [Tauri capabilities](https://v2.tauri.app/security/capabilities/); custom filesystem commands also validate their inputs in Rust.
