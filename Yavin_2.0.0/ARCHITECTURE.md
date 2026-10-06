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
- The eight title menus and command search share TypeScript command definitions. Editor undo/redo, clipboard actions, find/replace, selection, and navigation run in TypeScript. See [MENUS.md](MENUS.md) for scope and verification.

## Preserved historical work

The six excluded crates (`ide-core`, `ide-config`, `ide-syntax`, `ide-lsp`, `ide-dap`, `ide-plugin-host`) and the inactive `search.rs`/`watcher.rs` are pre-existing, uncommitted work retained for reference. They are not compiled, linked, or maintained as part of the active application. Their old Cargo inheritance is not a supported standalone build. Do not extend them or reconnect complex Rust logic. Port useful behavior into TypeScript only when the corresponding feature is implemented. A seventh, `ide-terminal`, was an empty PTY placeholder and was removed in TERMINAL-00; the terminal's contract crate is `ide-terminal-protocol` (see [Terminal](#terminal)).

## Remaining product and release work

1. Add language tooling (language servers, completion, diagnostics) to the Monaco editor; see [Editor](#editor). Existing inactive Rust buffers were never connected to the UI.
2. Implement debugging, AI, and extension services in TypeScript (language servers: see [Language servers](#language-servers-lsp-platform)). Keep any Rust process transport small and restrict process spawning to explicit user actions and validated arguments. The terminal follows this shape: `src-tauri/src/terminal.rs` opens a PTY per terminal, starts a detected shell (with a launch profile's arguments, environment and folder when one is given) and streams its output; xterm.js does the emulation in TypeScript. See [Terminal](#terminal) for what runs today and the contract it is moving to.
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

**Settings and themes.** `editor/editorSettings.ts` is the one place editor options are made (`editorOptions(settings, view)`), from the editor's settings (IDE-03, see "Settings": font, size, tabs, line numbers, word wrap, theme, zoom, as they resolve for the workspace) over `DEFAULT_EDITOR_SETTINGS`, plus read-only state and the minimap's look. That one is changed from the minimap's right-click menu or View › Minimap and remembered on this computer (`services/minimapPreferences.ts`: browser storage, validated field by field, failures ignored). The editor's own right-click menu is Monaco's editing menu with Command Palette added last. The themes `yavin-dark` and `yavin-light` are defined in `editor/monaco.ts`.

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

## Search

```text
SearchPanel (UI: query, options, results, replace)      src/components/layout/SearchPanel.tsx
   └─ searchWorkspace / replaceHits / describeSearchResult  src/services/search.ts
        └─ search_project / cancel_search (IPC)         src-tauri/src/workbench.rs
             └─ the bundled ripgrep (resources/search/rg.exe), via ide-workspace::process
```

**Ownership.**

| Owner              | Owns                                                                 |
| ------------------ | -------------------------------------------------------------------- |
| UI (`SearchPanel`) | the query, its options, the results shown, replacement               |
| `search.ts`        | one search's lifecycle: overlay, limits, cancellation                |
| `workbench.rs`     | validating the request and running ripgrep                           |
| DocumentService    | open documents' text; Search reads `buffers()` and never copies them |
| Resource rules     | identity                                                             |
| WorkspaceManager   | a search's lifetime: it is aborted with its workspace's signal       |

**Native.** `search_scope` refuses:

- a search for a workspace that is not the open one ("Workspace changed");
- a scope outside the workspace or that is not a folder;
- input over 16 KiB (query) or 10 MiB (buffer).

Searches are registered by id, at most 16 at once, so `cancel_search` can reach them. ripgrep's arguments come from `search_args`, where the query and each glob are single arguments. `.git` is always excluded, after the user's globs, so no glob can bring it back. ripgrep's own rules apply: `.gitignore` inside a repository, binary files skipped, files over 10 MiB skipped.

**Unsaved edits** (IDE-02). Documents that differ from their file are searched as the editor holds them. Their text goes to ripgrep on stdin, and their disk results are dropped.

- A saved open document's file says the same, so its disk results stand and it is not searched again. "Open files only" still searches every open document.
- Which documents are in scope (folder, globs, ignore rules) comes from one listing of the scope, run alongside the main search. The buffer searches run four at a time.
- Files are matched by resource identity, so a document keyed by another spelling of its path is still the same file.
- Measured on this machine, each ripgrep process costs about 0.3 s, mostly start-up. Before IDE-02, every open document cost one more process in sequence.

**Status.** `describeSearchResult` says exactly why results are missing:

- the first 10,000 shown (the match cap);
- ripgrep's 16 MiB output limit reached;
- some files could not be searched (locked or unreadable).

A cancelled search says "Search cancelled", a failed one "Search failed: …".

**Navigation.** A result opens its file and selects the exact match. The pending jump waits for the tab its document is actually keyed by (`documents.get` resolves any spelling). It reports a result whose line has changed since, and leaves nothing waiting if the file cannot be opened.

**Replacement.** A result's line must still read as it did, its line ending aside, or the replacement is refused as stale.

- ripgrep reports a CRLF file's lines with `\r\n`, the editor holds them with `\n`, and a closed CRLF file is rewritten in its own `\r\n`.
- An open document is changed by one undoable edit; a closed file by a guarded write.
- Replacement text is literal (no `$1`).

**Tests.**

- `workbench.rs` (`search_tests`) checks the arguments, scope refusal, job limits and cancellation, and runs searches through the real ripgrep: literal, regex, case, word, globs, hidden, ignored, `.git`, binary, stdin and listing.
- `search.test.ts` runs `searchWorkspace` against `search.fake.ts`, an in-memory stand-in that answers in ripgrep's own formats: scopes, the overlay and its identity, limits, cancellation and replacement.
- `tests/ui/search.spec.ts` covers navigation (across spellings, closed CRLF files, stale results), Replace and Undo, Replace All in an open CRLF document, cancellation, "Open files only", the status line, and a workspace switch.

**Not done.**

- ripgrep for macOS or Linux;
- fuzzy Quick Open;
- search history;
- `$1` replacement;
- an index.

## Settings

IDE-03 is the general settings foundation: user and workspace preferences, kept, validated, resolved and announced by one registry. What a setting _does_ stays with the subsystem it belongs to.

```text
SettingDefinition<T>   defined by its subsystem: id, title, description, default, scopes, parse (validation), control
      │                (editor/editorSettings.ts: EDITOR_SETTINGS)
SettingsRegistry       services/settings/settings.ts, one per window (`settings` in workspaces.ts)
      ├─ user values        yavin.settings.user                        {version: 1, values: {id: value}}
      └─ workspace values   yavin.settings.workspace:<WorkspaceId>     same shape
      resolve(definition, workspace) = workspace value ?? user value ?? default
      subscribe(workspace, listener) -> SettingChange {id, workspace, previous, value, source}
      ▼
owning subsystem applies it: the editor (useEditorSettings -> CodeEditor.updateOptions, in place)
SettingsView           components/settings/SettingsView.tsx: a view of the registry (and the terminal's store)
```

**Ownership.**

| Owner          | Owns                                                                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The registry   | the framework: storage, validation by the definitions, resolution, change events, reset. It knows no setting and no component.                                                                                            |
| Each subsystem | its own definitions and their effect. The editor defines `EDITOR_SETTINGS` and applies them (`resolveEditorSettings`, `useEditorSettings`).                                                                               |
| The terminal   | its own settings, still (`terminalSettings.ts`, TERMINAL-07). The Settings view shows its shell-integration setting and default profile and changes them through that store and the profile registry, never copying them. |

Git's repository lists, the session file and Workspace Trust remain their owners' too.

**Scopes.** Each definition says where it may be set:

- `user`: everywhere;
- `workspace`: one workspace, by `WorkspaceId`, never its name. A workspace value overrides the user's.

Zoom is the window's, so it is user-only. With no folder open there is no workspace scope.

**Resolution and reset.** A setting resolves to the workspace value, else the user value, else the default. Resetting a scope removes its value, so the next one applies again: with default 14, user 18 and workspace 20, resetting the workspace gives 18, and then resetting the user gives 14.

**Validation.** Every value is validated at runtime by its definition, never by its TypeScript type alone: boolean, bounded or integer number, enum, or a one-line string of bounded length.

- A runtime value that is invalid throws `SettingsError` and changes nothing.
- An invalid stored value is ignored, reported once, and **kept** in the record, never silently deleted. The next scope or the default applies, and its valid siblings stand.
- A stored value for a setting this version does not know is kept as well.

**Persistence** follows T07's rules, implemented once in the registry:

- an unreadable record (not JSON, truncated, no version) is copied to `<key>.corrupt` before anything is written over it, and the defaults apply;
- a record from a newer version is not read and never written over;
- storage that is blocked or full still lets settings apply for the window.

Problems are reported once through the window's error banner (`takeProblems`, `onProblems`). Writes are immediate: settings change rarely. Version 1 is the first; a later version migrates on read, and an older Yavin leaves it alone.

**Change events.** There is no bus. A listener subscribes for one workspace, or for the user level, and hears only changes that move what _that_ workspace resolves to, with the previous and new values and their source.

- A user change reaches every workspace without an override. A workspace's change reaches only that workspace.
- Unsubscribing with nothing left drops the workspace's listener set.
- `useEditorSettings` subscribes for the workspace in the window, re-renders only for the editor's own settings, and hands `CodeEditor` a stable object, which applies it with `updateOptions`. Nothing is reloaded, no editor is recreated, and the terminal, Git and LSP are untouched.

**Editor settings.**

| Setting               | Values                                                     | Default                                       |
| --------------------- | ---------------------------------------------------------- | --------------------------------------------- |
| `editor.fontFamily`   | one line, at most 300 characters                           |                                               |
| `editor.fontSize`     | 6–48, integer                                              | 13. Lines are 22/13 times as tall, as before. |
| `editor.tabSize`      | 1–16                                                       |                                               |
| `editor.insertSpaces` | boolean                                                    |                                               |
| `editor.lineNumbers`  | on, relative, off                                          |                                               |
| `editor.wordWrap`     | boolean                                                    |                                               |
| `editor.theme`        | `yavin-dark`, `yavin-light` (the two themes Yavin defines) |                                               |
| `editor.zoom`         | 0.7–2, user only                                           |                                               |

- With nothing set, the editor is exactly as before.
- View › Word Wrap and Zoom In/Out/Reset write these settings, to the workspace if it holds a value, else to the user's. They were window state lost on restart, and there is still one store for each.
- Monaco's theme is the window's, so a diff follows it (`createDiffView` no longer forces the dark theme).

**Settings view.** The gear and Ctrl+, (File › Settings) open it in the editor's place, and opening a file closes it.

- It has User and Workspace tabs. The Workspace tab needs an open folder and overrides the User tab.
- A search box filters settings by title, description and id.
- Sections are Editor, then Tasks and Debug (JSON lists, applied with Apply), then Terminal.
- Each row shows its description, its value, where the value comes from (default, user settings, this workspace), and a Reset for the shown scope.
- An invalid entry is refused with its reason.

The Accounts button keeps its old action (the command palette); there are no accounts.

**Not settings.** Open tabs and the active tab (session), terminal sessions and their output, Git state, diagnostics, LSP runtime state and Explorer expansion are session or runtime state with their own owners. Nothing in Settings is written into a project: there is no `.yavin/`.

**Existing islands.**

| Island                                                                    | Decision                                                                              |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Terminal settings, profiles and layout                                    | keep: owned by `terminalSettings`                                                     |
| Session file, Workspace Trust                                             | keep: native, and not preferences                                                     |
| Git repository lists                                                      | keep: Git's                                                                           |
| Local Git `maxBlobBytes`                                                  | keep: the store's own format                                                          |
| Commit drafts                                                             | keep: data, not preferences                                                           |
| Minimap look; panel view; SCM sort, tree, grouped, sections; Outline open | migrate later: view preferences with their own menus and tests, low value to move now |

**Deferred:** custom keybindings (Keyboard Shortcuts stays a read-only list), File › Preferences submenus, project `.yavin/` settings, and syncing.

**Tests.**

- `services/settings/settings.test.ts` covers:
  - resolution, override and reset;
  - workspace isolation;
  - runtime validation;
  - persistence across a restart;
  - an invalid stored value kept, with its siblings surviving;
  - malformed and truncated records, the `.corrupt` copy, a newer version, failing storage;
  - events (previous, value, source), isolation and unsubscribing.
- `services/settings/editorSettings.test.ts` covers the defaults matching the old editor, each setting reaching Monaco's options, validation, workspace isolation and a restart.
- `tests/ui/settings.spec.ts` covers:
  - the gear and Ctrl+,;
  - live application, restart and reset;
  - invalid input;
  - the theme;
  - Word Wrap and Zoom remembered;
  - a workspace override across a switch and back, and its reset to the user value;
  - a corrupt record reported once;
  - the terminal's settings through its own store.

## Run and tasks

IDE-04 is the task runner: named commands that run in the workspace's terminals, in dependency order, with Workspace Trust enforced and their errors reported in Problems. It adds no way of starting a process: a task is a terminal session whose shell runs one line and ends.

```text
Run command / Run view (App.tsx, components/layout/RunPanel.tsx)
      ▼
TaskService            services/tasks/service.ts, one per workspace (WorkspaceServices.tasks)
      ├─ tasks          configuredTasks(settings)                  IDE-03: tasks.definitions, user + workspace
      ├─ plan           planTask(tasks, id)                        dependencies first, cycles refused (plan.ts)
      ├─ trust          readTrust() before every execution        Workspace Trust, the native decision
      ├─ prepare        profiles.resolve + taskShellArgs + cwd     every task of the plan, before any starts
      ▼
TerminalService.open / restart (TERMINAL-03): a dedicated session per task, its profile the task's shell line
      ▼
native terminal (portable-pty, ConPTY, Job Object) -> output -> Terminal UI
                                                          └─> TaskOutputMatcher -> existing MATCHERS
                                                                  ▼
                                      publishProblems("task:<id>") -> Problems store -> Monaco markers
```

**Definition and execution.** A `TaskDefinition` (`tasks/model.ts`) is configuration: `id`, `label`, one-line `command`, `args`, `cwd`, `env`, `profile`, `dependsOn`, `group` (build or test), `isDefault`, `problemMatcher` and `presentation` (`reveal` always/silent/never, `clear`). A `TaskRun` is one execution of one task: its `executionId`, `state`, the execution it runs before (`parent`), its terminal session, exit code, times and error. Runs are kept in memory only, the active ones and the last 20 finished.

**Ownership.**

| Owner            | Owns                                                                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TaskService      | which tasks there are (read from settings), dependency planning, the trust check, run lifecycle, cancellation requests, and which diagnostics a run's output produced. |
| SettingsRegistry | the task definitions and their persistence (`tasks.definitions`, user and workspace scope).                                                                            |
| TerminalService  | the sessions, the native processes (through the Rust terminal), and output.                                                                                            |
| TerminalUi       | which terminal is shown, and clearing a reused one.                                                                                                                    |
| Problems store   | the diagnostics, by owner; the editor's markers follow it.                                                                                                             |
| Workspace Trust  | the trust decision (`readTrust`, native).                                                                                                                              |

**TaskService does not own:** PTYs, native processes or their ids, terminal output buffers, diagnostics after publishing them, editor markers, workspace identity, settings persistence or trust. It never calls a native command itself and never kills a process: Stop writes Ctrl+C to the task's terminal and, if the task is still running after 3 s, asks `TerminalService.kill` (the Job Object) to end it.

**Configuration.** `tasks.definitions` is a structured setting (a JSON list), edited in Settings › Tasks (Run › Configure Tasks opens it there).

- Every entry is validated by `readTask`: ids `[A-Za-z0-9._-]{1,64}` and unique, a one-line label (≤ 100) and command (≤ 4000), known dependency ids with no self-dependency or duplicates, known problem matchers (`tsc`, `eslint`, `cargo`, `ruff`), `isDefault` only with a group. An invalid list is refused with the reason and nothing changes; an invalid stored list is kept and ignored, like any setting.
- User and workspace lists are merged by id, the workspace's task replacing the user's of the same id. Nothing is written into the project.

**Shell lines.** A task runs in its profile's shell (the workspace's default when none is named), started to run the line and end (`tasks/shell.ts`):

| Shell                    | Started as                | Extra arguments            |
| ------------------------ | ------------------------- | -------------------------- |
| bash, zsh, sh            | `-c <line>`               | `'…'`, `'` written `'\''`  |
| fish                     | `-c <line>`               | `'…'`, `\` and `'` escaped |
| pwsh, Windows PowerShell | `-NoLogo -Command <line>` | `'…'`, `'` written `''`    |
| cmd                      | `/d /s /c <line>`         | plain tokens only          |

The line reaches the shell as one argument (portable-pty quotes it by the Windows argv rules). cmd reads its command line raw, so a `"` in the line, or an argument that is not a plain token, is refused (`UnsupportedShell`) rather than guessed at. `terminal_tests.rs` (`a_task_line_reaches_bash_cmd_and_powershell_intact_with_its_exit_code`) proves these shapes against real shells, exit codes included. Shell startup files are not changed.

**Dependencies.** `dependsOn` tasks run first, sequentially, in the order listed, each once per execution, the task itself last. A cycle (`a → b → a`), an unknown task or a bad dependency is reported before anything starts. When a dependency fails or is stopped, the tasks after it are marked failed (`Not run: "X" before it did not succeed.`) or cancelled and never start. Parallel dependencies are not supported.

**Lifecycle.** `pending → starting → running → succeeded | failed | cancelled`, and no other move (`canMove`). A run's result is its shell's exit code: 0 succeeds, anything else fails. A stopped run is cancelled whatever its code. A terminal that fails, is closed or restarted under it fails the run. One execution of a task at a time (`AlreadyRunning`).

**Terminals.** Each task has a dedicated terminal, "Task: <label>". A later run reuses it (restarted, and cleared unless `clear` is false) when its shell and folder are unchanged and it has ended; otherwise the old one is closed and a new one opened. `reveal: "always"` shows it as it starts; `silent` shows it only on failure; `never` never does.

**Problems.** A task's output is read line by line (ANSI and OSC sequences removed, lines capped at 8 KiB) by its `problemMatcher`s, the same `MATCHERS` the checkers use. When it ends, its diagnostics are published under the owner `task:<id>`, replacing that task's last ones; paths resolve against the task's folder to canonical resources and only files inside the workspace's folders are kept (`resolveTaskDiagnostics`). A stopped run publishes nothing. Checker diagnostics are separate owners and are untouched.

**Trust and no workspace.** Every execution asks Workspace Trust first; an untrusted folder runs nothing and the window opens the trust dialog (`TrustDenied`). There is no task store of its own and no second trust store. With no folder open, the Run view says so and the Run commands are disabled (`NoWorkspace`).

**Workspace isolation.** Each workspace has its own TaskService, reading that workspace's settings and launching in that workspace's terminals. Closing or switching the workspace disposes it: what its tasks are running is killed and marked cancelled.

**Errors** (`TaskError.code`): `NoWorkspace`, `UnknownTask`, `NoDefaultTask`, `AmbiguousDefault`, `InvalidConfiguration`, `InvalidDependency`, `DependencyCycle`, `DependencyFailed`, `AlreadyRunning`, `TrustDenied`, `ShellUnavailable`, `UnsupportedShell`, `InvalidCwd`, `TerminalFailed`, `Cancelled`. Each is shown with its message in the window's error banner.

**UI and commands.** The Activity Bar's Run icon opens the Run view: Run Build Task, Run Test Task, the tasks with Run, and executions with their state, exit code, Show terminal and Stop. The Run menu holds:

| Command            | Id                | Does                                                                         |
| ------------------ | ----------------- | ---------------------------------------------------------------------------- |
| Run Task…          | `run.task`        | a list of the tasks to choose from                                           |
| Run Build Task     | `run.build`       | Ctrl+Shift+B: the default build task; a choice when several could be default |
| Run Test Task      | `run.test`        | the same for test                                                            |
| Show Running Tasks | `run.showRunning` | opens the Run view                                                           |
| Stop Task          | `run.stop`        | stops the running task, or offers a choice; disabled when nothing runs       |
| Configure Tasks    | `run.configure`   | opens Settings filtered to Tasks                                             |

**Not in IDE-04.** Debugging, launch configurations, background or watch tasks (a task that never ends is shown running until stopped), parallel dependencies, variable substitution (`${file}`…), task auto-detection from `package.json` or `Cargo.toml`, and a `tasks.json` in the project.

## Debug / DAP

IDE-05 is the debugger foundation: real debugging over the Debug Adapter Protocol. Yavin speaks DAP to a debug adapter, and the adapter debugs the program. There is no language-specific debugging logic in Yavin and no scraping of terminal output.

```text
Run › Start Debugging / Debug view / gutter / Debug Console     (App.tsx, DebugPanel, CodeEditor, DebugConsoleView)
      ▼
DebugService           services/debug/service.ts, one per workspace (WorkspaceServices.debug)
      ├─ configurations   debug.configurations, debug.python       IDE-03 settings (config.ts)
      ├─ breakpoints      the workspace's set, by ResourceId        breakpoints.ts (window-level registry)
      ├─ trust            readTrust() before anything starts        Workspace Trust
      ├─ preLaunchTask    TaskService.run (IDE-04)                  optional, per configuration
      ▼
DapConnection          services/debug/connection.ts: seq, request_seq correlation, events, reverse requests, cancel, timeouts
      ▼
AdapterTransport       services/debug/nativeTransport.ts: dap_start / dap_send / dap_stop, dap-message / dap-exit events by session number
      ▼
native dap.rs          allow-listed adapters, trust-gated, on ide_workspace::lsp_process::ServerProcess
      ▼                (Content-Length framing in lsp_framing.rs; Job Object; kill_tree; exit report)
debug adapter (debugpy) ─► debuggee
```

**Ownership.**

| Owner                             | Owns                                                                                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| DebugService                      | debugger orchestration: the session and its lifecycle, threads, the selected stack, scopes, variables fetched one level at a time, the Debug Console, breakpoint sync, and where the editor should be. |
| DapConnection                     | the protocol over whole messages: numbering, matching, events, the adapter's own requests, cancellation, malformed messages.                                                                           |
| native `dap.rs` + `ServerProcess` | the adapter's process: start (allow-list, trust), stdin/stdout framing, its end, and ending it and everything it started.                                                                              |
| The debug adapter                 | debugging itself: launching or attaching to the program, breakpoints, stepping, evaluation.                                                                                                            |
| Breakpoints (`breakpoints.ts`)    | the workspace's breakpoints by canonical resource, enabled or not, and the adapter's verdict as the session reports it.                                                                                |
| `editor/debugMonaco.ts`           | the gutter: breakpoint glyphs and the paused line as Monaco decorations, by the model's document's ResourceId.                                                                                         |

**DebugService does not own:** processes or their handles (the native host does, and the renderer never sees one), terminals (TerminalService), tasks (TaskService: it asks it to run a preLaunchTask), diagnostics (Problems: no stack frame, variable or breakpoint is ever published there), language intelligence (LSP), editor models or decorations, workspace identity or lifecycle (WorkspaceManager), settings persistence (SettingsRegistry) or trust. There is no global event bus: views subscribe to the service and to the breakpoint set.

**No second process system.** A debug adapter runs on the same process host as the language servers (`ServerProcess`): DAP's base protocol is LSP's (`Content-Length` header, JSON body), so the framing is shared and already handles a message split across reads, several messages in one read, a malformed header (the session ends: the stream cannot be resynchronized) and an end in the middle of a message. The adapter and everything it starts, the debuggee included, is in the servers' Job Object, so nothing outlives Yavin. The `ide-dap` crate predates this module and stays an unused, excluded placeholder; the transport did not need a crate of its own.

**Adapters (allow-list).** `dap.rs` knows each adapter by id with a fixed command line, as `lsp.rs` knows its servers: the renderer never names a program. The one adapter today is **debugpy** (`python -m debugpy.adapter`), the standard stdio DAP adapter for Python, a language Yavin already supports (pyright, pylsp, ruff). It was chosen after an audit of this machine and the repository: no other stdio adapter (gdb, lldb-dap, codelldb, dlv, netcoredbg, a standalone js-debug) was present, and debugpy was (bundled with the VS Code Python debugger extension, and installable with `pip install debugpy`). The one thing the user may choose is which Python runs it (`debug.python`), and only an existing interpreter named `python…` or `py` is accepted. `adapters.ts` turns the adapter-neutral configuration into the adapter's `launch` / `attach` arguments; nothing else is adapter-specific.

**Configurations** are the structured setting `debug.configurations` (user and workspace, a workspace entry replacing the user's of the same id; Settings › Debug, Run › Configure Debugging): `id`, `name`, `adapter`, `request` (`launch` / `attach`), `program`, `cwd` (relative to the workspace root or absolute inside it), `env`, `args`, `stopOnEntry`, `port` (attach to a debuggee on this machine) and `preLaunchTask`. Every field is validated, with the reason for an invalid entry. There is no `launch.json` and no `.yavin/` file.

**Lifecycle.** `created → starting → initializing → running ⇄ stopped → terminating → terminated`, with `failed` from any live state; no other move (`canMove`). Starting is the protocol's own sequence: `initialize` (capabilities), `launch` / `attach` sent, the `initialized` event awaited (before or after the launch is answered: debugpy answers `launch` only after configuration), then `setBreakpoints` per file, `setExceptionBreakpoints` (no filter chosen), `configurationDone`, and the `launch` answer. Each session has a generation: an event, answer or close of a session that is no longer the current one changes nothing.

**Stopped state.** On `stopped` the service records the reason, asks for `threads`, selects the stopped thread, asks for its `stackTrace`, selects the first frame with a file (not one the adapter de-emphasized), shows it in the editor through the window's `openLocation` (by path, resolved to the document by resource identity), asks for that frame's `scopes`, and fetches the first inexpensive scope's variables, one level. Children are fetched only when expanded, once per stop, and a request already on its way is shared. Each stop and resume bumps an epoch: a stack, scope or variable answer for a stop that is over is dropped, so a slow answer can never show a frame as current after the program continued. On `continued`, or once `continue` / a step is answered, the frames, scopes, variables and the paused line are cleared.

**Commands.** Continue, Step Over (`next`), Step Into (`stepIn`), Step Out (`stepOut`) and Pause are DAP base requests every adapter has; they are enabled by state (paused, or running for Pause). Restart is offered only when the adapter has `supportsRestartRequest`. Stop sends `terminate` when the adapter supports it and the session launched its program, then `disconnect` (`terminateDebuggee` for a launch), then ends the adapter's process, whatever it answered. Run menu: Start Debugging (F5; Continue when paused), Stop Debugging (Shift+F5), Restart Debugging (Ctrl+Shift+F5), Continue, Pause (F6), Step Over (F10), Step Into (F11), Step Out (Shift+F11), Toggle Breakpoint (F9), Remove All Breakpoints, Configure Debugging.

**Breakpoints.** Identified by `ResourceId` (never a path string) and line, with an optional column, enabled or not, and `verified` as the adapter last said (`null` with no session). The set is per workspace and lives as long as the window: switching file or workspace and back keeps it. A click in the editor's glyph margin (or F9) toggles one; the Debug view lists them with enable, remove and Remove All. During a session each change sends `setBreakpoints` for that file only, its enabled breakpoints in order; a newer request for the file makes an older answer void. The adapter's verdict, and its later `breakpoint` events, mark each one verified or not. The gutter shows a set breakpoint as a red dot, one the adapter refused as a hollow ring (its reason on hover), and a disabled one dimmed. Breakpoints are not kept across restarts of Yavin yet.

**Debug Console.** The session's output (DAP `output` events: stdout, stderr, the adapter's console; telemetry is ignored), joined into lines as the stream arrives, and expressions evaluated with `evaluate` (`context: "repl"`) in the selected frame, only while paused. It is not a terminal: nothing reaches a shell.

**Trust boundary.** Debugging runs the project's code, so it is gated twice: the service asks Workspace Trust before anything starts (no task, no adapter, no program), and the window opens the trust dialog when it is refused; `dap_start` refuses an untrusted folder natively as well. There is no trust store of its own.

**Workspace lifecycle.** Each workspace has its own DebugService; disposing the workspace (closing it or switching away) ends its session: `disconnect`, then the adapter's process, which takes the debuggee with it. `enter_workspace` also ends every native adapter, and a reloaded page ends its predecessor's (`dap_stop_all`). Yavin exiting ends them all.

**Terminal and task boundary.** The debugger does not use terminals: the program's output arrives through the adapter (`console: "internalConsole"`), and the adapter's `runInTerminal` request is answered as unsupported. A configuration's `preLaunchTask` is run by TaskService, in its terminal, to its end; only a task that succeeded lets the session start. The two services stay separate: DebugService only asks TaskService to run a task.

**Problems / LSP boundary.** Debugger state is execution state and stays in the Debug view and the gutter: nothing is published to Problems, and language servers are not involved.

**Errors** (`DebugError.code`): `NoWorkspace`, `AdapterUnavailable`, `AdapterFailedToStart`, `MalformedMessage`, `InitializeFailed`, `LaunchFailed`, `AttachFailed`, `UnsupportedCapability`, `InvalidConfiguration`, `TrustDenied`, `SessionTerminated`, `EvaluateFailed`, `StaleSession`, `AlreadyRunning`, `NotStopped`, `PreLaunchTaskFailed`, `RequestFailed`, `Cancelled`, `Timeout`. Native errors arrive as `Code: message` and keep their code. Each is shown as a sentence; raw protocol is never put in front of the user.

**Not in IDE-05.** Remote debugging (attach is to this machine only), conditional breakpoints, logpoints, function and data breakpoints, an exception-breakpoint UI, watch expressions, setting variables, multiple simultaneous sessions, `runInTerminal`, breakpoints kept across restarts, and adapters other than debugpy.

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

**Problems and checkers (IDE-01).**

- **One file, one identity.** The store holds each diagnostic's file as its canonical path.
  - Language servers' come from their `file:` URIs.
  - A checker's are resolved before they are published (`problemLocations.ts`), against the folder the checker actually ran in, which `run_checker` reports as `root`. Resolution uses the resource rules (`resolveWithin`), never string concatenation.
  - Relative, absolute, `\?\`, either separator and `file:` URIs all reach the same path.
  - A path outside that folder is not one of the workspace's files: it is not published, and the view says how many were left out.
- **Compared by `ResourceId`.** Markers, grouping in the view, and the "Current file" filter all compare `ResourceId` (`problemResourceId`). A language server's and a checker's diagnostics for one file are one group.
- **Owners are never merged.** The same error from `tsc` and from the TypeScript server is listed twice, each with its source, as VS Code lists them.
- **Hints** are kept as `info` with `hint: true`, so the counts are unchanged. They are their own kind in the view: a "hints" toggle and a fainter mark. Monaco draws them as hints.
- **The checker service.** Running a checker is `CheckerService`'s (`panel/checkers.ts`), one per workspace (`WorkspaceServices.checkers`). The Problems view shows its state and asks it to run or stop.
  - A newer run replaces an older one, whose late answer changes nothing.
  - Disposing the workspace stops a run in progress and publishes nothing it returns.
- **Run outcomes.** `run_checker` answers `{outcome, output, code, root}`.
  - A stopped run (`cancelled`) or one past its 10-minute deadline (`timedOut`) is an outcome, said plainly ("TypeScript was stopped.", "TypeScript timed out and was stopped."), not a failure.
  - Only a checker that cannot start, or exits non-zero with nothing to show, is a failure.
  - The native side tells these apart through `process::capture_classified`; the string API the Git commands use is unchanged.
  - A finished run clears the cancel slot only if the slot is still its own, so a newer run always stays stoppable.
- **Launching.** A checker's program is found the way a language server's is (`lsp_process::resolve_program`). On Windows `npx` is the npm `npx.cmd` shim, which `Command::new("npx")` never found. Its arguments stay fixed, and it stays trust-gated and allow-listed.
- **Navigation.** Clicking a problem goes through the editor's own `openLocation`, which waits for the file to be in front and then selects the exact line and column. The editor clamps a stale location to the nearest real position (`model.validateRange`). A file that cannot be opened is reported once, and no pending jump is left behind.
- **Not done (deliberately).** There is no virtualisation of the list and no cap on diagnostics: markers are rebuilt from the whole store on each publish. That is unchanged and unmeasured, and belongs to a performance module if it is ever needed.

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
  terminals detached  the window then resets its own UI state for B
  Problems cleared    (documents, editor views, tabs, Explorer; terminal panel remounted)
  owned cleanups
```

**Identity.** `WorkspaceId` is the folders' `ResourceId`s, sorted -- never a path string: every spelling of a folder is one workspace, and a multi-root workspace is one identity. The window with no folder is the empty workspace.

**Lifecycle.** A context is `opening` while its services are made, `active` once they are, `closing` while they are disposed and `closed` after. Every activation has a **generation**, increasing for the life of the window: A, then B, then A again are three generations, and the second A is a new context with the same identity. There is no way back from `closing`; suspending a workspace to resume it later is a later module.

**Switching.** `open(folders)` with the same folders keeps the workspace. Other folders close the current context completely before the next exists: its services first, then everything it owns (`own`), newest first; one failure is logged and never stops the rest. Opening quickly A → B → C closes A once, never makes B, and answers every caller with C. Every way into a folder (startup, the default workspace, Open Folder, the recent list) goes through `loadWorkspace`, which opens the workspace before the Explorer lists anything. The native side replaces its workspace only once the new folder has opened; a folder that cannot be opened leaves the old workspace exactly as it was.

**Failure.** If a workspace's services cannot be made, the window is left in the empty workspace (and if even that fails, in the closed old one, which is inactive) -- never with one workspace's UI over another's services.

**Stale work.** A context's `signal` is aborted and `isActive()` becomes false when it starts closing. Work that awaits captures the context (or its request's own identity) and checks before applying:

| Boundary                    | Protection                                                                                                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Git open, refresh, events   | the disposed registry is inert (no repositories, no persistence, no notifications); a late open is closed                                                                                                        |
| Git watcher events          | routed to the workspace in front's registry by repository identity; the old one's watchers are stopped                                                                                                           |
| Checker (Problems)          | the run captures its workspace and drops a late answer; disposal cancels it and clears Problems                                                                                                                  |
| Language servers            | a request's answer for a closed or changed document is a `StaleResultError`; diagnostics from a server no longer the manager's are ignored                                                                       |
| Explorer listings           | each answer must match the entry and generation it was asked for; the old roots' entries are forgotten                                                                                                           |
| Search                      | aborted by a newer query and by the workspace's signal; the native search is cancelled                                                                                                                           |
| Terminals                   | each launch has a generation; messages of another launch are dropped; a launch that finishes after its session was closed is killed; a switch detaches views, the workspace's TerminalService keeps its sessions |
| Filesystem watcher (native) | the old watcher ends before the new one starts; batches carry their root and generation                                                                                                                          |

**Ownership.**

| Owner                        | Owns                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| Workspace manager            | which workspace is open; creating and closing contexts; the order of a switch; generations       |
| Workspace context            | identity, folders, generation, lifecycle state, services, cleanups given to it                   |
| Git registry (per workspace) | repositories, `.git` watchers, polling, the active repository, the list remembered for it        |
| Workspace disposal           | stopping the checker, clearing Problems (terminals are detached, not closed: see Terminal)       |
| The window (`App.tsx`)       | its UI state, reset on the same switch: documents, editor views, tabs, Explorer, panels          |
| LSP manager                  | servers per workspace folder; follows the Explorer's roots (folders removed: their servers stop) |
| DocumentService              | document content -- unchanged; nothing here holds content                                        |

**Git.** One registry per workspace. It restores what was remembered for that workspace (`yavin.git.repos:<WorkspaceId>`) and opens each of its folders' own repositories; the active repository is the one remembered for that workspace, else a folder's. Leaving closes every repository, stops its watcher and drops its shared commit graph; what was remembered is kept for next time, so A → B → A brings back A's repositories and the one chosen. The list every folder shared before (`yavin.git.repos`) is adopted by the first workspace opened after the upgrade and then removed. Watcher events, guarded operations, cloning and the commit graph resolve the workspace in front (`currentGit()`); the AI Git tools take the registry of the workspace they were made for, with no global default. The commit hover card caches per repository.

**Terminals.** The shells belong to the workspace, but outlive a switch (TERMINAL-03). The terminal panel is remounted per workspace, so its views detach from A's sessions and the next folder gets its own. A's TerminalService keeps A's sessions running, and A → B → A finds them again, replayed. They end when the window does (reload or exit) or when closed. See [Terminal](#terminal).

**Documents and editors.** Leaving a folder with unsaved changes asks first; the documents, editor views and tabs are reset, and A's tabs and Explorer state are restored from the session when A is opened again. Unsaved content is not kept across a switch yet.

**Performance** (development machine, UI fixture): closing a workspace takes 16-83 ms (Git registry, checker, terminals, Problems), making the next under 1 ms; Git discovery, listings and language servers then continue without blocking the window.

**Persistence boundary.** Where each kind of state belongs -- today and for the modules that build on this one:

| Kind      | Examples                                                                                | Where                                                               |
| --------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Global    | theme, keybindings, editor and panel preferences                                        | user settings / browser storage, application-wide                   |
| Machine   | recent folders, trusted folders, shell detection                                        | Yavin's user-data directory (`session.json`, trust file)            |
| Workspace | Git repositories and selection; later workspace configuration                           | keyed by `WorkspaceId` in user data (`yavin.git.repos:<id>`)        |
| Folder    | shareable project configuration (later)                                                 | `.yavin/` in the folder, when a module needs it                     |
| Session   | open tabs, active tab, editor positions, Explorer snapshot, side bar and panel (IDE-06) | user data, per workspace (`session.json`)                           |
| Runtime   | shells, language servers, watchers, running checkers, pending requests                  | never persisted; ended with the workspace (shells: with the window) |
| Document  | editor content                                                                          | DocumentService; recovery (M04) for interrupted saves               |
| Secret    | API keys, tokens, passwords                                                             | the OS credential store; never in `.yavin/` or session files        |

**`.yavin/`.** Not created by W1. When it is, it holds only what is meant to be shared with the project and is safe to commit (workspace configuration, working-set and changeset metadata). Private session state -- unsaved content, terminal output, AI conversations, Git selection -- stays in Yavin's user-data directory by default, so it cannot end up in a repository. Secrets are never written to either.

**Multi-root.** The manager, identity and Git registry take several folders (each folder's repository is opened; all belong to one `WorkspaceId`), and language servers already run per folder. The window itself opens one folder today; there is no UI to add a second.

**Not yet** (later modules): suspending a workspace so A → B → A keeps A's runtime alive; unsaved content kept across a switch (layout and editor positions: see Session / Window); `.yavin/` project metadata; an `ActiveResourceContext` resolving the targets of commands (today commands resolve the workspace in front through `workspaces.current()`); AI conversations, agent runs and changesets (none exist yet; the AI Git tools are already bound to one workspace). The Output channels are application-wide logs.

**Invariants**

1. No project-specific service is application-global: each belongs to one workspace context.
2. A workspace is fully closed before the next one is created.
3. Work that finishes after its workspace closed changes nothing.
4. What a workspace remembers is stored under its own identity, never shared with another.
5. The window is never left with one workspace's UI over another's services.

## Session / Window

IDE-06 makes the session's boundary and lifecycle explicit. **Session remembers UI/workspace arrangement; it does not own subsystem runtime state.** A workspace is what is open (folders, filesystem, Git, Problems, LSP, tasks, debugging); a session is how the user left it.

```text
Application
 └─ Window ("main" -- the only one)
     ├─ Session (services/workspaceSession.ts; the window's coordinator in session.ts)
     │    files (references), the active one, where the editor was in each,
     │    the Explorer's snapshot, side bar and panel visibility
     │        ▼ persisted by
     │    native session.rs → session.json (atomic, versioned, set aside when unreadable)
     └─ Workspace (WorkspaceManager, see Workspace lifecycle)
          DocumentService · Explorer · TerminalService · TaskService · DebugService
          Git · Problems · LSP · Settings · Trust
```

**Ownership.**

| State                                            | Owner                                                | Session holds                                              |
| ------------------------------------------------ | ---------------------------------------------------- | ---------------------------------------------------------- |
| Open editors, order, the one in front            | the window's tabs                                    | the files (paths, matched by `ResourceId`), the active one |
| Where the editor was in a file                   | `EditorViews` (the engine's view state per document) | a plain cursor/selection/scroll record per file            |
| Editor groups                                    | none: there is one editor group                      | nothing                                                    |
| Explorer expansion, selection, focus, scroll     | the Explorer store (`explorerStore.ts`)              | a snapshot it is seeded from                               |
| Side bar view and visibility, panel visibility   | the window                                           | `layout` (visibility and which view only)                  |
| The panel's view (Problems, Terminal...)         | the panel (`yavin.panel.view`)                       | nothing                                                    |
| Terminal layout, profiles                        | the terminal (`terminalSettings`, by `WorkspaceId`)  | nothing                                                    |
| Terminal sessions, PTYs, output                  | TerminalService and the native side                  | nothing: never persisted                                   |
| Document content, dirty and untitled text        | DocumentService                                      | nothing                                                    |
| Tasks, debug sessions, breakpoints               | TaskService, DebugService, the breakpoint registry   | nothing                                                    |
| Problems, Git, language servers, settings, trust | their owners                                         | nothing                                                    |

**Lifecycle.** `created → restoring → active ⇄ saving → disposing → disposed`, and no other move (`canMoveSession`); one explicit state replaces the window's former `restoring` flag. The window has one current session at a time (`windowSessions`); beginning another first takes the current one's snapshot -- before the window is cleared for the next workspace -- and disposes it. Identity is the session's generation and its `WorkspaceId` (never a path).

**Restore pipeline** (startup, Open Folder, the recent list):

1. read the session file (`read_session`); the native side has already set aside an unreadable or newer file;
2. resolve the workspace (`open_workspace`), and its `WorkspaceId`;
3. `windowSessions.begin(...)`: the saved record, only if it is this workspace's (`savedFor`: folder however spelled, and the `workspaceId` it was written with, when it has one);
4. `restore(work)`: the workspace is created (`loadWorkspace` → WorkspaceManager), the Explorer store is seeded with the snapshot, the files are opened through DocumentService (missing ones skipped, as before), where the editor was in each is handed to `EditorViews` (the editor restores it when it shows the file), and the side bar and panel are shown as they were;
5. `active`: from here changes are saved.

`work` receives `live()`: false once another session began or this one was disposed. Every asynchronous step checks it (and the workspace revision) before applying, so a slow restore of A never puts A's tabs, views or layout into B. Nothing is saved while a session restores, so the empty window it passes through is never written over its record -- including when a second switch overtakes the first, which the shared flag did not prevent (the first switch's end could unlock saving while the second still restored).

**Snapshot** (`snapshotSession`): serializable data only -- `folder`, `workspaceId`, `files` (disk files, one per `ResourceId`, at most 50), `active`, the Explorer snapshot, `views` (`file`, `line`, `column`, optional `anchorLine`/`anchorColumn`, `topLine`, `topDelta`, `scrollLeft`) and `layout` (`sidebarView`, `sidebarOpen`, `panelOpen`). Never a handle, process id, PTY, terminal output, React or Monaco object, listener, promise, DAP connection or task execution; the engine's view state is reduced to those numbers.

**Persistence** is the existing native session file, unchanged in mechanism: written whole and atomically (an interrupted write leaves the last complete file), versioned (`version: 1`; the new fields are optional, so files from before IDE-06 read as they are and an older Yavin ignores them), an unreadable or truncated file moved aside to `session.json.corrupt-<ms>.bak`, one from a newer Yavin moved aside and never overwritten, unknown fields ignored, every list capped, and a view of a file that is not open dropped. A corrupt session never stops startup: the window opens as on a first run. The renderer validates what it reads once more (`asSession`).

**Saving.** A change the session remembers (tabs, the active tab, the Explorer, the side bar, the panel) marks it dirty; it is written after 400 ms of quiet, the last state winning, and the native side skips a write that changes nothing. The cursor and scroll mark nothing: they are taken whenever a snapshot is made, and when the window goes (`pagehide`: marked and flushed). No write blocks the window.

**Documents.** The session references files; DocumentService opens them, as any file. Untitled and proposed documents are not in the session. A dirty document's text is not kept across a restart or a switch (there is no hot exit yet): leaving a folder and closing the window both ask before discarding unsaved changes, and a restored file is the file on disk -- the session never claims otherwise. Local Git's snapshots can record unsaved text (LG-02), but nothing restores it into an editor yet.

**Terminals.** Terminal attachments are the terminal's own: TerminalService keeps a workspace's sessions for the life of the window (A → B → A finds them), and `terminalSettings` keeps the layout per `WorkspaceId` (TERMINAL-07). The session stores nothing of them. After a restart there are no old shells to attach to; opening the panel starts terminals by the terminal's rules, never a pretend old one.

**Tasks and debugging.** Not session state. A task or debug session running when Yavin exits is ended with it, and nothing restores it as running: the services start empty. Breakpoints are kept per workspace for the life of the window (IDE-05), not in the session.

**Windows.** Yavin has one window (`main`) and one session at a time. There is no window id because there is no second window to isolate from; a multi-window model is a later module.

**Not yet.** Hot exit (unsaved and untitled content across restarts), editor groups, persisted breakpoints, several windows.

## Extensions

IDE-07 is the extension foundation: the contracts and the isolation layer that extensions (and later Yavin's AI features) build on. It is not a marketplace and not a second application architecture: extensions contribute to the IDE's own registries and act only through a small API, and the IDE's services stay their owners.

```text
installed: <app local data>/extensions/<folder>/yavin-extension.json   (native extensions.rs: manifests only)
bundled:   code shipped in Yavin's own bundle (dev/test builds: the sample)
      ▼
ExtensionRegistry (window)    manifest validation, identity, enabled state, contribution indexes
      │  settings ──────────► SettingsRegistry.register (owner: Settings)
      │  commands, keybindings ► the window's command list and shortcut handling (commands.ts)
      │  views, menus ───────► the Extensions view (side bar), view/title actions
      ▼
ExtensionHost (workspace)     lifecycle, lazy activation, trust gate, contexts, the API
      ▼
extension.activate(context, yavin)  ── yavin.commands / window / workspace / views ──► IDE services
```

**Ownership.**

| Owner                                                                   | Owns                                                                                                                    |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| ExtensionRegistry (`registry.ts`)                                       | known extensions by identity, manifest validation, enabled/disabled (remembered), compatibility, what each contributes  |
| ExtensionHost (`host.ts`)                                               | per workspace: activation state and events, ordering, failure, disposal, contexts, the API, handlers and view providers |
| Extension storage (`storage.ts`)                                        | each extension's own global and workspace state                                                                         |
| SettingsRegistry                                                        | extension settings (registered into it, persisted by it)                                                                |
| The window (`App.tsx`, `commands.ts`)                                   | the command list, palette, shortcuts: extension commands are appended, never replacing Yavin's                          |
| WorkspaceManager, Trust, Terminal, Tasks, Debug, Problems, LSP, Session | unchanged; extensions cannot reach them                                                                                 |

**Manifest** (`manifest.ts`, `manifestVersion: 1`): `publisher`, `name`, `version` (semver), `displayName`, `description`, `engines.yavin` (a range against the extension API version, `EXTENSION_API` = 1.0.0), `activationEvents`, `main`, `contributes`, `capabilities.untrustedWorkspaces`. Validation is strict and every reason is reported: ids, semver, the engine range, `main` inside the extension's folder, each contribution. `extensionDependencies` is rejected as unsupported. Unknown fields, contribution points, menu locations and activation events are warnings, never a crash; an invalid manifest is rejected whole with its reasons and contributes nothing; a second extension with an id already registered is rejected.

**Identity** is `publisher.name` (lower case), never the display name, and every contribution is namespaced by it: commands `<id>.<name>`, settings `<id>.<name>`, views `<id>.<name>`. The same id keys its activation, storage, output channel (`Extension: <displayName>`) and errors (`ExtensionError.extensionId`).

**Contributions.**

| Point                                      | Where it goes                                                                                                                                                                                   |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commands`                                 | the command palette, under the command's category; run through the host (activating its extension)                                                                                              |
| `keybindings`                              | the command's shortcut -- only if no Yavin command has it, and the first extension keeps a shared one; conflicts are shown in the Extensions view                                               |
| `configuration`                            | SettingsRegistry definitions (boolean, number with bounds, string, enum; user or both scopes), in a Settings section named after the extension; values stored before the extension loaded apply |
| `views` (`sidebar`)                        | sections of the Extensions side bar, filled by the extension's provider                                                                                                                         |
| `views` (`panel`)                          | registered; not rendered yet (the panel's views are fixed)                                                                                                                                      |
| `menus.commandPalette`                     | `when: false` hides a command from the palette                                                                                                                                                  |
| `menus.view/title`                         | actions on the extension's own view                                                                                                                                                             |
| `menus.editor/context`, `explorer/context` | validated and indexed; not rendered yet                                                                                                                                                         |

**Lifecycle.** Registry: discovered → validated → registered (or rejected). Host, per extension: registered → activating → active, or → failed; active → deactivating → disposed (`canMoveExtension`). An extension is activated at most once per host (concurrent requests share one activation), never eagerly: by `onStartupFinished`/`*`, `onWorkspace`, `onCommand:<id>`, `onView:<id>`, `onLanguage:<id>` -- and always by one of its own commands or views being used. A failed activation is logged, its status says why, it is not retried behind the user's back, and other extensions are unaffected. Deactivation calls `deactivate`, then disposes its subscriptions newest first; each failure is logged and the rest still run.

**API** (`api.ts`): `commands.registerCommand` (its own contributed commands only) and `executeCommand` (extension commands); `window.showInformationMessage`/`Warning`/`Error` (shown in the window, at most 20 per extension per workspace, then only logged); `workspace.getWorkspaceFolder`, `getConfiguration(<its id>)` and `onDidChangeConfiguration` (its own settings only); `views.registerView` (its own views). Registrations return disposables. `ExtensionContext`: `extensionId`, `extensionPath`, `workspaceFolder`, `globalState`, `workspaceState`, `subscriptions`, `log` (its output channel, at most 500 lines per workspace). Nothing else is reachable through it: no native IPC, processes, PTYs, files, Git, documents, terminals, tasks, debugging, Problems, React, Monaco, the DOM or secrets.

**Storage.** `globalState` (`yavin.extensions.global:<id>`) and `workspaceState` (`yavin.extensions.workspace:<WorkspaceId>:<id>`): one record per extension and scope, `{version: 1, values}`, JSON values only, at most 64 KiB, an unreadable record copied to `.corrupt` and started empty, one from a newer Yavin read but never written. An extension can open only its own. It is extension state, not a settings system.

**Trust.** No extension code runs in a folder that is not trusted (Workspace Trust, asked before each activation) unless its manifest declares `capabilities.untrustedWorkspaces: true`. A blocked extension stays registered, its declarative contributions apply, its status explains why, the window offers the trust decision, and trusting the folder lets it activate.

**Execution boundary -- and its limits.** The host runs only code bundled in Yavin's own build, in the window's JavaScript context. That code is not sandboxed; the boundary is the API it is handed. The code of installed extensions is never read or run: discovery reads manifests only, and the window's content security policy (`script-src 'self'`) admits no code from outside the bundle. Installed extensions are therefore declarative today -- settings, and contributions referring to commands that exist. Running third-party code needs a real boundary -- a WASM runtime (`ide-plugin-host`, still a placeholder) or a separate worker/process host under an explicit policy -- which is future work.

**Workspace and window.** The registry is the window's; the host is the workspace's (`WorkspaceServices.extensions`), like tasks and debugging. Closing or switching the workspace deactivates its extensions; an extension of A that acts afterwards -- a message, a registration, a view refresh -- reaches nothing (its API is inert, and only the workspace in front may show messages), and B's host starts with nothing active. Extension state is not session state: nothing of a host is remembered across a restart.

**Discovery and installation.** Only `<app local data>/extensions/<folder>/yavin-extension.json`, read natively (at most 200 folders and 64 KiB per manifest, links not followed), once per window and again on Reload. There is no marketplace, download, update, dependency installation, publishing or signing; installing is putting a folder there.

**Performance** (development machine): discovering and registering 200 manifests 44 ms; the startup event over 201 extensions 0.2 ms (nothing activates eagerly); a first command with lazy activation 2.6 ms, later ones 0.2 ms.

**Not yet.** Running installed extensions' code (a real host), panel views, editor and Explorer context menus, language-feature providers through the API, dependencies, a marketplace.

## Terminal

The terminal was rebuilt module by module, TERMINAL-00 to TERMINAL-08 (the module plan below); all of them are done. This section says what runs and the **contract** it is built on. Future work is named as such where it comes up (Unix validation, a Problems parser, AI's controlled access).

### Current (what runs today)

| Layer   | Where                                                           | Responsibility                                                                                                                                                      |
| ------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Panel   | `src/components/layout/TerminalPanel.tsx`                       | renders the workspace's terminals: tabs, panes, toolbar, find bar, context menu, status line; panel-only state (height, the find text, the open menu)               |
| View    | `src/components/terminal/TerminalView.tsx`                      | one xterm.js attached to one existing session: replay then live output, ACK after parsing, input (paste through xterm), measurement, search, links, exit footer     |
| Helpers | `src/services/terminal.ts`, `terminalUi.ts`, `terminalHooks.ts` | open requests, generations, key bindings; the per-workspace view state and commands (`TerminalUi`); React hooks over both                                           |
| Native  | `src-tauri/src/terminal.rs`                                     | the session runtime (TERMINAL-01): `terminal_shells`, `terminal_open`, `terminal_write`, `terminal_resize`, `terminal_close`, `terminal_kill`, `terminal_close_all` |

The native side and the renderer speak only the contract below: there is no other terminal protocol.

**Native session runtime (TERMINAL-01).** One session is one PTY (portable-pty: ConPTY / Unix PTY) and the shell in it, run by four pieces:

- **The commands.** None waits on a shell.
  - Starting a shell, ending one and detecting shells run off the main thread.
  - `terminal_write` only queues input and `terminal_resize` only sets a size. Both stay on the main thread, which runs them in the order they were sent, so keystrokes reach the shell in the order they were typed. Async commands run concurrently and could reorder them.
- **A writer thread** per session, fed by a bounded queue of 64 requests.
  - A shell that stops reading its input gets that much queued.
  - After that `terminal_write` is refused with `WriteFailed`; nothing blocks, and no other terminal is affected.
- **A reader thread.** Every PTY read is handed, untouched, to the session's output stream (see "Output pipeline (TERMINAL-02)" below). Nothing is decoded natively.
- **A reaper thread.** It waits for the shell, then:
  1. ends whatever the shell started;
  2. hangs up the PTY;
  3. lets the output drain, for at most 3 s;
  4. closes the output, so no chunk can follow;
  5. reports `TerminalExit`, or `TerminalErrorEvent` if the process could not be waited on;
  6. removes the session.

  The 3 s limit exists because ConPTY keeps its output open until its console host finishes, and a host still waiting for an answer to its first cursor-position query (a terminal killed the instant it was created) may never finish.

- **Process trees.** The shell and everything it starts are contained together.
  - On Windows: a kill-on-close Job Object, which `ide-workspace`'s LSP job now shares. The shell is put in the job right after it starts; portable-pty cannot start it suspended, so a process it started in that instant would escape. The job's handle closes when Yavin ends, however it ends, which ends the tree.
  - On Unix: the shell's own process group (portable-pty makes the shell a session leader).
    - A kill is `killpg(SIGKILL)`.
    - If Yavin dies, the kernel closing the PTY hangs up the session; there is no Unix equivalent of kill-on-close.
- **Ending a generation.**
  - `terminal_close` hangs up and kills after a 2 s grace.
  - `terminal_kill` ends the tree now.
  - When the shell exits by itself, what it started ends with it.
- **The session map** is locked only to find, add or remove a session. Each session has its own locks, so one terminal never waits on another.
- **Generations are enforced natively.**
  - An open must name a generation newer than any its id had, and opening a newer one replaces (ends) the older.
  - Write and resize must name the current generation (`StaleGeneration` otherwise), and the session must still run (`SessionEnded`).
  - Close and kill naming any other generation do nothing.
- **Workspaces are enforced natively.**
  - An open must name the window's workspace (`WorkspaceSpec`'s `workspace_id`, the renderer's `WorkspaceId`; `empty:` with none), or it fails with `InvalidWorkspace`.
  - Entering another workspace does **not** end the sessions of the one left (TERMINAL-03): their views detach and the workspace's TerminalService keeps them.
- **Lifecycle.**
  - A session that ends by itself keeps its stream's bounded replay until it is closed, so a view can still attach and see how it ended; a session closed or killed lets go of it at its end.
  - A page reload closes leftover shells before the first new one opens.
  - App exit closes every shell.
- **Failures are typed** (`"Cause: message"`). OS failures are described by kind (`TerminalError::from_io`), never by the OS's own text.

**Still to come.**

- More than one window following one session (the subscription model allows it; nothing opens a second window yet).

### Workspace Terminal Service (TERMINAL-03)

```text
WorkspaceManager ── WorkspaceId ──> TerminalService (src/services/terminalService.ts)
  (terminalServices: one per        ├─ Map<TerminalId, session record>   state, metadata, generation
   WorkspaceId, for the window)     │    └─ lifecycle subscription        Running, Exiting, the end
                                    └─ attachments (views)               replay, live output, ACKs
                                         └─ native session (T01) + output stream (T02)
TerminalUi: how they are shown (panes, split, focus, zoom, find, bells, notices) -- view state.
TerminalPanel: renders them. TerminalView: one xterm.js attached to one session.
```

**Ownership.** The TerminalService of a workspace owns its sessions.

- **Records and identity.** A session's record is keyed by `TerminalId` in a `Map`. Its identity is the session id together with the workspace: a service holds only its own sessions, and refuses an id that belongs to another workspace (`InvalidWorkspace`). It never looks a session up by id alone.
- **What a record holds:** generation, state, title, shell and launch settings, folder, pid, dimensions, exit code or error, and how many views are attached.
- **What it never holds:** a native handle, a process, an xterm instance or React state.
- **Reading it.** `getSnapshot()` returns immutable views of the sessions, enough to render the tabs; `subscribe(listener)` reports state changes and never per-byte output. React reads the service through `useSyncExternalStore`; the service itself knows nothing of React or Tauri (the native side is injected).
- **View state is not session state.** Active terminal, split, focus, bells, find and zoom are the renderer's (TerminalUi, TERMINAL-04), never a session's.

**Lifecycle.** One path, owned by the service:

1. create the record (`Spawning`);
2. allocate a generation;
3. `terminal_open`, with the service's own lifecycle-only subscription;
4. apply the lifecycle messages (`Running` with its pid, `Exiting`, then exactly one end) through `applyEvent`.

`applyEvent` validates every message before it changes anything: the session must be this service's, the generation current, the step one the state machine allows. Anything else is dropped. `restart` is a new generation of the same session. `close` and `kill` end it and forget it.

**Attach and detach.** A view attaches to a session (`terminal_subscribe` on its own channel).

- It is first sent the session's bounded replay, then live output. Each chunk is validated against the view's own stream (generation, sequence, starting where the replay starts), then acknowledged once xterm has parsed it.
- Detaching (unmounting) only unsubscribes: the session goes on.
- Attaching to a session that has ended replays its output and its end, and revives nothing.
- Several views may attach to one session; each has its own window and acknowledgements, and detaching one leaves the others.

**Replay boundary.** Replay is "enough recent output to redraw a remounted view", never a history:

- the last 256 KiB of output (`LIMITS.replay_bytes`), plus the generation's `Running` and its end;
- kept natively in the generation's output stream, in memory only;
- dropped when the session is closed, or when the generation is replaced.

Replay is never written to disk, and sessions are never restored across a reload or restart. TERMINAL-07 keeps only configuration and layout.

**Workspace switch.** The workspace's context is disposed, but its TerminalService is not:

- the panel is remounted, so A's views detach;
- A's shells keep running;
- B's service is its own;
- opening A again finds A's service with its sessions; views attach, are replayed, and continue live.

No process is started again because a view remounted.

**Workspace disposal.** `terminalServices.dispose(id)` disposes a workspace's terminals:

- it refuses everything from then on (`InvalidWorkspace`);
- detaches every view;
- kills every session natively and forgets it;
- ignores any late message.

Today the window's end does this implicitly: a reload closes every leftover shell, and exit closes every shell. There is no "close this workspace" action yet that calls it.

**Reload.** The page's services go with the page; the next page closes the shells the last one left (`terminal_close_all`, once, before its first open). Terminals are never restored across a reload or restart: TERMINAL-07 keeps their configuration and layout, never their sessions.

### Renderer (TERMINAL-04)

```text
TerminalService (per WorkspaceId)  sessions: identity, state, lifecycle, output stream, replay
TerminalUi      (per WorkspaceId)  view state + commands: panes (primary, secondary), focus,
                                   split ratio, zoom, find, bells, per-terminal notices and
                                   matches, the registry of mounted views
TerminalPanel                      renders both; owns only height, find text, the open menu
TerminalView                       one xterm.js on one existing session
```

- **The renderer is a view.** Mounting a TerminalView renders an existing session and never starts a shell; unmounting detaches it and never ends one.
  - React reads the service and the UI through `useSyncExternalStore` (`terminalHooks.ts`).
  - Neither the service nor the UI is ever made by a component: both are the workspace's (`workspaces.ts`), made once per WorkspaceId for the window.
- **Output bypasses React.** A session's replay and live output go from its view's channel straight to `term.write`, and each chunk is acknowledged in xterm's write callback. Output changes no React state and re-renders nothing; only state changes (a session starting, exiting, renamed; a pane or zoom change) do.
- **Panes always name real sessions.** TerminalUi reconciles its panes with the service's sessions on every change:
  - a pane never names a session that is gone;
  - the two halves of a split are never the same session;
  - closing the left pane's terminal moves the right one over.

  Choosing a tab focuses that terminal's pane if it is on screen, and stepping skips the other pane's terminal.

- **Every action names its terminal.** The menus, the toolbar and the context menu act on an explicit TerminalId: the context menu on the terminal it was opened on, the toolbar on the focused pane's. They act through TerminalUi or the service; the window-wide `requestTerminal` channel is gone. The Terminal menu and the Explorer's "Open in Integrated Terminal" call the workspace's TerminalUi directly.
- **Per terminal, never shared:**
  - The status line is the focused terminal's own: its notice, otherwise its state.
  - Bells, notices and search results are kept per terminal.
- **Input goes through xterm.** A paste is `term.paste` (bracketed when the program asked for it, newlines normalised), then `onData`, then `TerminalService.write`, which splits it to the contract's limits.
- **Resize:** the view measures and the service resizes. A size taken while the shell is spawning is sent once it runs; an unchanged size is never sent.
- **Shortcuts.** `matchesShortcut` also matches a punctuation key by its physical key (`event.code`), so `Mod+Shift+\`` works although Shift makes the key `~`.
- **Workspace switch.** The panel is remounted, so views detach and xterm instances are disposed; sessions, panes, split, zoom and titles stay with the workspace. Coming back reattaches each session (replay, then live). Nothing is closed, killed or started again.

**T04 → T05.** TERMINAL-05 owns shells and profiles (below). The find text is not kept across a remount. Panel height is kept since TERMINAL-07 (it is the TerminalUi's).

### Shells and profiles (TERMINAL-05)

T05 is shell **launch configuration**: which shell, with which arguments, folder and environment, as a login shell or not. It knows nothing of what happens inside the shell -- command boundaries, the shell's own idea of its folder (OSC 7/133) are TERMINAL-05A.

```text
discovery (native terminal_shells)     what shells are there: found or not (and why), the default
ProfileRegistry (window, terminalProfiles.ts)
  built-in profiles                    one per discovered shell; read-only; unavailable ones marked
  user profiles, user default          kept by the terminal settings (TERMINAL-07)
WorkspaceProfiles (per WorkspaceId)    + workspace profiles, workspace default; resolve()
TerminalUi.newTerminal(profileId?)  -> TerminalService.open({ profile }) -> native open (T01)
```

- **Discovery is not profiles.** Native `discover_shells()` reports each candidate:
  - name, path, kind (cmd, powershell, pwsh, bash, zsh, fish, sh), platform;
  - whether it is available, and if not, why;
  - whether it is the platform default.

  The candidates per platform are:

  | Platform | Candidates                                                                                                                                                       | Default                       |
  | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
  | Windows  | `%COMSPEC%` cmd; PowerShell 7 (on PATH or under Program Files); Windows PowerShell; Git Bash (both Program Files and the per-user `%LOCALAPPDATA%\Programs\Git`) | the Command Prompt, as before |
  | Unix     | `$SHELL`, `/bin/zsh`, `/bin/bash`, `/usr/bin/fish`, `/bin/sh`                                                                                                    | `$SHELL`                      |

  The available ones are the native allowlist.

- **Profiles describe how a shell starts**, and own no session, process, output or view state. A profile is the contract's `TerminalProfile {id, name, executable, args, cwd, env, login?}`, with one type end to end. The registry adds its scope (built-in, user, workspace) and whether it can start here. Sessions keep an immutable copy of their profile (a restart launches it again) and show its id and name.
- **Built-in profiles** are one per discovered shell, with stable ids (`builtin.<kind>`). They are read-only, and offered even when unavailable, marked with the reason. An unavailable one is never launched or silently replaced by another shell under its id.
- **Validation.** A profile is configuration, not permission:
  - its executable must be one of the shells discovery found;
  - its arguments stay a structured list, never joined into a command line;
  - names are 1-64 characters; environment names are non-empty, without `=`, CR, LF or NUL.

  Ids are unique across scopes, and built-in profiles cannot be changed or removed. The native side still checks the shell, folder, arguments and environment at launch, and the process model (Job Object or process group, cleanup, generations, workspace ownership) is untouched.

- **Default precedence:**
  1. the profile asked for (an unavailable one fails, `ShellUnavailable`);
  2. the workspace default;
  3. the user default;
  4. the platform default;
  5. the first available.

  Unavailable defaults are skipped. With none available, the result is a typed `ShellUnavailable`.

- **Folder precedence:**
  1. the folder asked for (Explorer's "Open in Integrated Terminal");
  2. the profile's folder;
  3. the workspace root (home, with no folder open).

  A relative folder is relative to the workspace root. It must exist (`InvalidCwd`), and a terminal never starts somewhere else instead.

- **Environment:** ordered `NAME=value` overrides on top of the inherited environment. An entry adds a variable or replaces it; removing an inherited variable is not supported. Values are never logged.
- **Login shells:** `login: true` is translated natively into the shell's own flag (`-l` for bash, zsh, fish and sh, Git Bash included), placed before the profile's arguments. It is refused, as a typed `ProtocolError`, for cmd and PowerShell: Windows has no login-shell concept to translate to.
- **UI.** The panel's shell menu lists every profile (unavailable ones disabled, with the reason as a tooltip) and opens a small "Terminal profiles" dialog. The dialog lists, opens, makes, edits and deletes user and workspace profiles, and sets the user or workspace default. A terminal's tab says which profile it runs.
- **Tested on Windows only.** The Unix discovery candidates, `$SHELL` default and `-l` login flag are written and unit-checked by kind, but have not run on Unix; a Unix CI job should run `terminal::tests` there.

**T05 → T05A.** TERMINAL-05A owns shell integration: OSC 7 (the shell reporting its folder) and OSC 133 (command boundaries). T05 knows neither.

### Shell integration (TERMINAL-05A)

The three layers are separate:

- T05 is shell **launch configuration**: which shell starts, and how.
- T05A is **runtime shell integration**: what the running shell says about itself.
- T06 is **IDE integration**: what the rest of Yavin does with that.

T05A reads what the shell reports. It acts on none of it.

```text
PTY reader -> OutputStream::push (T02)
               └─ OscScanner (terminal_shell.rs): one per generation, sees every byte once, in order
                    output bytes unchanged ─────────> views (xterm ignores OSC 7/133)
                    TerminalMessage::Shell ─────────> every subscriber, in order with the output,
                                                      never replayed
TerminalService.applyEvent (per workspace)
   └─ reduceShell (terminalShell.ts) -> session view .shell   (the one interpretation)
TerminalUi / TerminalPanel: status line reads view.shell        (views never parse OSC)
```

**Where it is read.** The scanner runs natively in the output pump, once per generation. It never changes, removes or holds back a byte; a sequence split across reads anywhere is found once, at its end. Payloads over 4 KiB are abandoned rather than buffered. Each finding becomes a `shell` message:

- shape: `{sessionId, generation, signal, uri?, local?, exitCode?}`;
- `signal` is one of `cwd`, `prompt`, `input`, `executing`, `finished` or `invalid`;
- it goes into the T02 stream right after the bytes that carried it, so it is ordered with the output;
- it goes to every subscriber, lifecycle-only ones included;
- it is not kept in the replay ring;
- it carries no `seq`, and the contract accepts it only while the session is `Running` or `Exiting`.

The TerminalService interprets these messages, and nothing else does. A view's own channel receives them too, but it ignores them.

**Untrusted metadata.** A signal changes only the session's `shell` state. It never:

- runs a command, or opens or writes a file;
- changes a profile, the workspace or its ownership;
- calls Git or another application.

Yavin never edits a shell's startup files (`.bashrc`, `.zshrc`, PowerShell profiles, `config.fish`, Git Bash's). A shell reports only if the user has configured it to.

**OSC 7, the shell's folder** (`ESC ] 7 ; file://host/path BEL|ST`).

- The native side checks the URL: it must start `file://`, be at most 2,048 characters, and contain no control characters.
- The native side decides `local`: the host is empty, `localhost`, or this machine's name.
- The renderer reads it with `resource.ts` (`parseUri`/`fsPath`); there is no second normalization. `cwdFromOsc7` answers one of:
  - `local` (a path);
  - `remote` (another host, which **never** becomes a local path);
  - `unmapped` (Git Bash's MSYS paths with no drive, such as `/tmp`, or a bare POSIX path from a Windows shell);
  - nothing, when the URL is unreadable. The previous folder is then kept, and the miss is counted.
- MSYS drive paths (`/c/x`, `/cygdrive/c/x`) map to `C:/x` for Git Bash. Whether a shell writes MSYS paths comes from its profile: a bash, zsh or sh at a Windows path.
- Percent-encoding is decoded. A literal space, as Git Bash writes it, is read as is. A stray `%` that is not an escape makes the URL unreadable.

**Folder precedence** (`terminalFolder`):

1. the shell's last local report;
2. otherwise, where the session was started (`view.cwd`, which is also where a restart starts again).

A remote or unmapped report gives no local folder (`null`): the shell is no longer where it started, and Yavin does not guess.

**OSC 133, command boundaries** (`ESC ] 133 ; A|B|C|D[;status]`). The command state machine is `idle → prompt (A) → input (B) → executing (C) → completed (D)`. It is tolerant:

- a `D` with no command running is ignored (bash's first `PROMPT_COMMAND` sends one);
- a repeated `C` is the same command;
- a new `A` or `B` while a command runs ends it with no status;
- a `C` without `A` or `B` still starts a command;
- a `D` whose status is not a number finishes the command without one.

Each command record holds an id (counting across generations), `startedAt`, `finishedAt` and `exitCode`. Only the current command and the last finished one are kept; there is no history and no persistence. A command's text is never reconstructed from the screen. Its exit status is separate from the session's: a `Running` session can have a last command that exited 1.

**Integration states** (`view.shell.integration`):

| State         | Meaning                                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `available`   | The profile's shell can report (bash, zsh, fish, pwsh, Windows PowerShell), and has not yet this generation.                                 |
| `active`      | A valid signal has arrived this generation.                                                                                                  |
| `unsupported` | A shell with no integration (cmd, sh, an unknown or default shell). It is still a full terminal. If one reports anyway, it becomes `active`. |
| `error`       | Only unreadable sequences so far. A valid signal makes it `active`.                                                                          |
| `disabled`    | Turned off by the setting (TERMINAL-07) when the terminal started. Every signal is ignored.                                                  |

A terminal works the same in every state; integration only adds information.

**Generations, restarts, views.**

- Signals are validated like every lifecycle message: this workspace's session, the current generation, and a contract-valid message. A stale generation, another workspace's session or a malformed signal changes nothing.
- A restart (`launch`) starts the shell state again (folder, command, integration), keeping only the command-id counter.
- A detached view leaves the state with the service. A view attaching later reads the current state; old signals are never replayed to it.

**UI.** The status line shows the focused terminal's own state:

- `Running · Running a command`;
- `Running · Last command exited with N`;
- `Running · Shell integration: unreadable sequences`;
- the shell's reported folder (a local path, `host (remote)`, or a note that it has no Windows path).

Nothing is shown for a shell that has not reported.

**Tests.**

- `terminal_shell.rs`: OSC 7 and 133 parsing, splits at every offset, malformed and oversized input.
- `terminal_stream_tests.rs`: ordering with the output, and no replay.
- `terminal_tests.rs`: a real Git Bash configured through environment variables only (`PROMPT_COMMAND`, `PS0`, `PS1`, with `--norc --noprofile`). It reports its folder and the boundaries of a failing command. A shell without integration sends nothing.
- `terminalShell.test.ts`: OSC 7 mapping, the state machine, integration states, and the service's generations, restarts, detach and reattach.
- `terminal.spec.ts`: the status line, per terminal, reset on restart.

**T05A → T06.** T06 is IDE integration: it uses the folder and the command boundaries (revealing the terminal's folder in the Explorer, file links, Git's refresh). T05A only provides them. It persists nothing: no command history, and no integration setting (that is TERMINAL-07).

### IDE integration (TERMINAL-06)

The layers:

- T05A: runtime shell integration.
- **T06: ordinary IDE integration.**
- T07: persistence and settings.
- T08: production hardening.

The terminal becomes a part of the IDE without owning any other part. It reads facts from the other subsystems and asks their owners to act; no other subsystem's state moves into the terminal.

```text
Explorer menu (a resource) ─┐                                  ┌─> TerminalUi.openIn(cwd)   reuse or new
Editor (document)  ─────────┼─ terminalIde.ts (pure, resource.ts) ┤
Terminal menu / palette ────┘                                  └─> TerminalUi / TerminalService
focused terminal ── view.shell (T05A) ── revealableFolder ──> ExplorerStore.reveal (owner of selection)
output line (hover) ── findPathLinks ── resolvePathLink ──(click)──> openLocation (DocumentService, editor)
TerminalService ── a command finished (OSC 133) ── watchFinishedCommands ──> bumpGitRevision (Git's refresh)
```

**Ownership is unchanged.**

| Owner                            | Owns                                                               |
| -------------------------------- | ------------------------------------------------------------------ |
| Filesystem                       | disk facts                                                         |
| `resource.ts`                    | path identity                                                      |
| DocumentService                  | content and dirty state                                            |
| Git                              | Git state                                                          |
| ExplorerProvider / ExplorerStore | projection / expansion, selection, focus                           |
| Problems                         | diagnostics                                                        |
| TerminalService                  | sessions and their runtime metadata                                |
| TerminalUi                       | terminal view state, now including which terminal has the keyboard |

`terminalIde.ts` holds no state. Its functions take facts and answer what they mean.

**Explorer → terminal.** "Open in Integrated Terminal" on:

- a folder starts in the folder;
- a file starts in the folder holding it;
- the tree's root, or its background, starts in the workspace root.

The Explorer passes the resource (`{path, isDir}`) and nothing else. The window works out the folder with `terminalCwdFor` (`fileUri`/`dirname`), never by trimming a string, and nothing is quoted for a shell (the folder is a structured `cwd`, T05). The profile is never changed.

**Editor → terminal.** "Open Integrated Terminal Here" (`terminal.openHere`) uses the folder of the document in front:

- a document on disk: its own folder (`editorTerminalCwd`);
- an untitled or proposed document: the workspace root, since it has no folder of its own (a proposed file's folder may not exist yet).

It reads the document's resource, never a tab label.

**Reuse.** IDE actions go through `TerminalUi.openIn(cwd)`. A terminal is shown again, rather than a new one started, when all three hold:

- it is `Running`;
- its shell has reported (OSC 7) that it is in that very folder (`samePathString`);
- it is not running a command.

A shell that never reported its folder is never assumed to still be where it started, so asking again starts another. "New Terminal" always starts one. There is no separate pool: reuse is a lookup over the service's sessions.

**Terminal → Explorer.** "Reveal Current Folder in Explorer" (Terminal menu, palette, and the terminal's context menu) reveals the folder of the terminal in front, but only one its shell reported (`revealableFolder`) that is local and inside a workspace folder. It then calls `ExplorerStore.reveal`, which owns expansion and selection. Every other case shows nothing and says why:

- never reported, which includes shells without integration: the folder it was started in is not used, because the shell may have left it;
- reported remote (`host`);
- unmapped MSYS;
- unreadable;
- outside the workspace.

The shell's folder is session metadata. It never overwrites a profile's folder, the workspace root or any setting.

**Terminal → editor (file links).** A link provider registered on xterm (`registerLinkProvider`) sits next to the existing web-link addon, which still handles URLs and is unchanged. When the pointer is over a line, `findPathLinks` reads it. It offers only:

- absolute paths (`C:\x\a.ts`, `/home/a.ts`) or relative ones with a separator (`src/a.ts`, `./a.ts`, `../a.rs`);
- whose last segment has an extension starting with a letter;
- optionally followed by `:line` or `:line:column`.

It leaves alone:

- bare names (`a.ts`) and folders;
- numbers (`100/200.5`);
- URLs;
- UNC paths, which could reach another host;
- other compilers' position forms: `a.ts(3,4)` links the path without a position.

`resolvePathLink` then resolves the candidate:

- through `resource.ts`, relative to the terminal's folder (the shell's report, else where it started, if that was the workspace root);
- mapping Git Bash's MSYS spellings;
- only to a file inside a workspace folder. Anything else is not underlined.

Only a click opens it, through the editor's own `openLocation`: DocumentService opens the file, and the editor selects the line. A file that is missing fails the way any open does. Output can never run, write, change the workspace or Git, or open anything outside the workspace.

**Git boundary.** The terminal never runs, parses or imitates Git. Files a command changes reach Git the way any external change does: the resource watcher's batch refreshes the Explorer, DocumentService and Git (`bumpGitRevision`). Git's own files are not watched, though, so a `git commit` typed in a terminal would show only on the next refresh. So when a command finishes (OSC 133 `D`, T05A), `watchFinishedCommands` asks Git for its usual refresh:

- once per finished command;
- never per output chunk;
- never for a shell without integration, where the watcher and window focus still cover it.

**External file changes and dirty documents.** Nothing is faked or forced. The watcher reports what a command changed. DocumentService reconciles open documents as it always does: it flags an external change on a dirty document rather than overwriting it. The terminal does nothing to documents.

**Problems boundary.** T06 does not turn output into diagnostics. A future, structured parser (command → parser → Problems) belongs to Problems. File links are navigation only and add nothing to Problems.

**Commands.** These are the canonical `terminal.*` commands in the Terminal menu and the palette. They act through the workspace's TerminalUi and TerminalService, never the native side directly.

| Command                 | Label                             | Enabled when                                                                      |
| ----------------------- | --------------------------------- | --------------------------------------------------------------------------------- |
| `terminal.new`          | New Terminal                      | always                                                                            |
| `terminal.openHere`     | Open Integrated Terminal Here     | a document is in the editor                                                       |
| `terminal.focus`        | Focus Terminal                    | always; starts a terminal if there is none                                        |
| `terminal.toggle`       | Show / Hide Panel                 | always                                                                            |
| `terminal.split`        | Split Terminal                    | always                                                                            |
| `terminal.revealFolder` | Reveal Current Folder in Explorer | a terminal is in front                                                            |
| `terminal.clear`        | Clear Terminal                    | the panel shows a terminal                                                        |
| `terminal.find`         | Find in Terminal                  | the panel shows a terminal                                                        |
| `terminal.copy`         | Copy Selection                    | a terminal has the keyboard                                                       |
| `terminal.paste`        | Paste into Terminal               | a terminal has the keyboard                                                       |
| `terminal.selectAll`    | Select All in Terminal            | a terminal has the keyboard                                                       |
| `terminal.rename`       | Rename Terminal…                  | a terminal is in front                                                            |
| `terminal.restart`      | Restart Terminal                  | a terminal is in front                                                            |
| `terminal.close`        | Close Terminal                    | a terminal is in front; ends the shell gently (`terminal_close`)                  |
| `terminal.kill`         | Kill Terminal                     | a terminal is in front; ends the shell and its process tree now (`terminal_kill`) |

The id once named "Close Terminal" was `terminal.kill` but closed gently. The ids, the labels and the context menu now say what each one does.

**Keyboard shortcuts** use the existing `AppCommand.shortcut` and the window's one handler. Two flags were added:

- `scope: "terminal"`: the focused terminal handles the key itself (Find Ctrl+Shift+F, Copy Ctrl+Shift+C, Paste Ctrl+Shift+V). The window's handler never runs these, so outside a terminal the same keys keep their editor meaning (Search in Files, and so on). The menus and the Help list still show the key.
- `skipShell`: the key is the IDE's even inside a terminal (the Command Palette, Ctrl+Shift+P, and the panel toggle, Ctrl+`). xterm does not handle it or send it to the shell, so it reaches the window's handler. Before this, xterm consumed both: Ctrl+` typed a NUL into the shell.

Terminal keys never fire when the terminal does not have the keyboard: they live in xterm's own key handler.

**Focus.** These are distinct facts:

| Fact                        | Where it lives                           |
| --------------------------- | ---------------------------------------- |
| the panel is visible        | the window's `isTerminalOpen`            |
| a view is mounted           | `TerminalUi.registerView`                |
| a terminal is in front      | `TerminalUi.focusedId`, the focused pane |
| a terminal has the keyboard | `TerminalUi.keyboard`                    |
| a session exists            | `TerminalService`                        |

`keyboard` is reported by the view that owns xterm's DOM (its textarea's focus and blur), never by another component inspecting the DOM. Opening the palette records which terminal had the keyboard, so a command chosen there (Copy, Paste) applies to it, as in any editor. "Focus Terminal" is a request (`TerminalUi.requestFocus`), on the same pattern as Find: the panel focuses the terminal in front once it is shown. A request made while the panel was mounted for another visit is not replayed.

**Workspace isolation and lifecycle.**

- Every command reads the workspace in the window (`useWorkspace`) and its TerminalUi. An id from another workspace is refused by its service (`InvalidWorkspace`). Signals and late answers are checked per session and generation (T03, T05A).
- Switching workspace detaches views; the shells go on (T03), and the panel's comment now says so. The other workspace's panel starts its own terminal, and commands there reach only its terminals.
- Unmounting the panel only detaches. `TerminalServices.dispose(id)` ends a workspace's terminals. The window's end ends them all natively: this is the application-shutdown path, unchanged.
- A stale comment by the panel said unmounting closed the shells; the code has only detached since T03, and the comment now says so.

**Notifications.** Failures of an explicit action (reveal, open, an unusable cwd) go to the window's existing error banner (`reportError`). Ordinary output never notifies. A non-zero exit is a command's result, not a failure: the status line shows it and nothing else does. `TerminalError` stays reserved for infrastructure failures.

**Multi-root.** The window opens one folder today. "Inside the workspace" means inside one of `WorkspaceContext.folders`, and a relative link with no known folder is not offered. Nothing guesses which root a path belongs to.

**Performance.** There is no polling and no scanning:

- Links are computed only for a hovered line.
- Git is refreshed only on a finished command.
- React updates only on state changes (focus, sessions), never on output.
- There is one key handler per xterm, as before, and one OSC parser, native (T05A).

**Tests.**

- `terminalIde.test.ts` covers:
  - Explorer and editor folders;
  - reveal for local, remote, unmapped, invalid, unknown and outside folders;
  - link finding (supported and ambiguous) and resolution;
  - Git refresh per finished command, not per output;
  - reuse;
  - keyboard focus;
  - kill vs close;
  - workspace isolation and disposal.
- `terminal.spec.ts` covers:
  - Explorer root and file;
  - the editor action, with a file and with untitled;
  - reveal (unknown, remote, local);
  - palette enablement and keyboard context;
  - Ctrl+` in a terminal;
  - Focus Terminal;
  - clicking a printed path to open it at its line, while an outside path is not a link;
  - the Git refresh;
  - commands after a workspace switch.

**Deliberately not done.** Terminal path parsing stays at: a candidate, then an explicit click, then resource resolution, then `openLocation`. Links on wrapped lines, column offsets from wide characters, and richer diagnostic syntax are left out on purpose, so that T06 does not grow into a terminal parser.

**Validation limitation (pre-existing).** On a cold dev server, the first UI test of a run can exceed its wait: the first page load compiles the editor and the terminal panel. This was seen on the multi-repo "switch 15 times" test, which fails the same way on the commit before T06, and once on a T06 test that then passed three times. It is environmental, not terminal behaviour. The final integration gate should warm the server before timing anything.

**T06 → T07.** T07 persists what T06 keeps in memory: profiles and defaults, an integration on/off setting (`disabled`), and panel layout. T06 stores nothing.

### Persistence and settings (TERMINAL-07)

T07 makes the existing terminal behavior durable; it adds no terminal behavior. The only new switch is the integration setting, whose `disabled` state T05A already defined.

| Kept across restarts                                      | Never kept                                                      |
| --------------------------------------------------------- | --------------------------------------------------------------- |
| user profiles, workspace profiles                         | sessions, PTYs, processes, pids, generations                    |
| user default, workspace default                           | output, scrollback, the replay buffer                           |
| font size, split ratio, panel height                      | the shell's reported folder, the current command, exit statuses |
| shell integration on/off (user), and a workspace override | xterm instances, focus, find, bells, notices                    |
| the format's version                                      | built-in profiles (discovery makes them each time)              |

**Where.** These are this installation's preferences, not part of a project, so they live in the webview's storage, as the minimap's preferences and Git's repository lists already do. Nothing is written into a workspace.

```text
yavin.terminal.user                      {version, profiles, defaultProfile, shellIntegration, layout}
yavin.terminal.workspace:<WorkspaceId>   {version, profiles, defaultProfile, shellIntegration|null, layout}
```

```text
terminalSettings.ts  (one store per window: `terminalSettings` in workspaces.ts)
   ├─ ProfileRegistry (T05)  reads user profiles and default once; workspace ones when a workspace is first used
   │                         writes them back on every change
   ├─ TerminalUi (per workspace)  starts from its layout (else the last one used, else defaults)
   │                              saves it when it changes; asks whether integration is on at each launch
   └─ the window                  shows what went wrong reading or writing, once (`takeProblems`)
```

**Scope.**

- Profiles and defaults are user or workspace, as T05 defined them. A workspace's own profiles and default exist only in that workspace.
- Integration: the workspace's override (`null` means "as the user setting"), else the user setting, else on.
- Layout: each workspace keeps its own, and the user record keeps the last one used, which a workspace with no layout of its own starts from.

**Running terminals are never changed by settings.**

- A session keeps the copy of the profile it started with (T05). Editing or deleting the profile, or changing the default, affects only later launches. A restart launches the same copy again.
- The integration setting is read when a terminal starts. Turning it off does not touch terminals already running, and a restart keeps how its terminal started.

**Restoring profiles.** A kept profile is restored as it was saved. It was validated as configuration when it was read: the same rules a launch uses, plus a valid id that is not `builtin.*`, and ids unique within the record and across scopes. It is not checked against discovery. Like any user profile, it can launch only while discovery finds its shell. Before discovery answers, or once its shell is uninstalled, it is listed but unavailable, with the reason. The default chain then skips it (T05). It is never launched under its name with another shell, and never deleted.

**Format and versions.** Every record carries `version` (1). Reading validates everything, field by field and profile by profile:

| Found                                                   | What happens                                                                                                                                        |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| nothing                                                 | the defaults                                                                                                                                        |
| unreadable: not JSON, not an object, no version         | the defaults. The stored text is copied to `<key>.corrupt` before anything is written back.                                                         |
| partly unreadable: a bad profile, field or layout value | that part is dropped and the rest is used. The original is copied to `<key>.corrupt` first, so a repair never loses data.                           |
| a newer `version`                                       | nothing is read, and the record is **never written over**. Changes apply until the window closes, so a newer Yavin's settings survive an older one. |
| storage blocked or full                                 | everything still applies for this window                                                                                                            |

In every case the problem is reported once, through the window's error banner, and the terminal works on.

**Writes.** Configuration (profiles, defaults, the integration setting) is written at once. Layout changes are written once they settle (300 ms), because a drag changes the height many times a second. Anything still waiting is written when the page goes (`pagehide`).

**UI.** The profiles dialog has a "Shell integration" section: the user setting, and the workspace's override (as above, on, or off). The panel's height now lives in the workspace's TerminalUi (`panelHeight`) instead of the panel's local state, so it survives remounts and restarts. A smaller window shows less of it without changing what is kept.

**Limits.**

- One window's storage: two windows writing at once keep the last write. Yavin opens one window.
- Settings are not synced between machines.
- A whole-split layout is not restored, because there are no sessions to put in it; the split ratio is.

**Tests.**

- `terminalSettings.test.ts` covers:
  - the format's round trip and defaults;
  - unreadable, partly unreadable and newer records;
  - storage that fails;
  - write timing;
  - integration precedence;
  - profiles and defaults across a restart, including a shell that is gone and deletions;
  - running terminals unchanged by edits;
  - layout limits and saving;
  - integration off for new terminals only;
  - no session data ever stored.
- `terminal.spec.ts` covers:
  - a reload keeps the profile, default, font and panel height but no terminal;
  - integration off survives a reload;
  - corrupt settings are reported and kept aside;
  - a newer version is left untouched.

**T07 → T08.** T08 is production hardening: the full suites, CI, the 50 MB stress test, the final integration gate, and documentation. It adds no behavior.

### Production gate (TERMINAL-08)

T08 audited the whole terminal subsystem and ran the final gate. It added tests, one CI step and documentation, and changed no terminal behavior.

**Audit.** None of the following were found:

- remnants of the pre-T03 architecture (no window-wide terminal channel, old native commands or global session arrays);
- TODOs left in terminal code;
- UI components calling native terminal APIs (the one `TerminalNative` adapter in `workspaces.ts` is the only caller);
- logging of output or environment.

There is one process launch: a structured executable, argument list, folder and environment, never a command line. OSC 7 and OSC 133 are metadata only. Output and file links never act without a click. A kept profile is configuration until it is launched. `terminal_stats` is a deliberate development diagnostic (T02) and stays. Five stale statements in this section were corrected:

- the module status;
- that persistence was a later module;
- ACKs and replay in the future tense;
- the side-band messages (`detached`, `shell`), now listed in the contract.

**Tests added.**

| Test                                                                   | What it checks                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `killing_a_terminal_ends_its_shells_children_and_grandchildren_by_pid` | A shell, child, grandchild and great-grandchild are recorded by pid from the process table, by ancestry from the test's own shell. After a kill, every one of them is gone.                                                                       |
| `several_shells_at_once_keep_their_output_apart_and_all_end`           | 2, 4 and 8 real shells started together: each shows only its own output, and every shell is gone after `close_all`.                                                                                                                               |
| `every_byte_survives_shell_integration_long_lines_and_line_endings`    | With the real limits: 4-byte UTF-8, CR/LF combinations, a 200 KiB line, NUL and invalid bytes, OSC 7/133 and other OSCs, and a trailing partial escape, cut at a prime size. The bytes are identical, and the signals are side-band and in order. |
| `terminalIntegration.test.ts`                                          | eight terminals with independent output, folder, commands, generation, resize and kill; several views of one session; open then immediate restart; late events after a workspace's disposal; reloaded settings followed by an open                |

The T07 "newer version" UI test now flushes through `pagehide`, with a positive control, instead of waiting out the write delay.

**Measured (Windows 11, debug build).**

| Stress (T02 stream, real limits) | Time   | Peak queued | Peak process working set |
| -------------------------------- | ------ | ----------- | ------------------------ |
| 1 MB, slow consumer              | 0.15 s | 960 KiB     | 8.9 MB                   |
| 10 MB                            | 1.7 s  | 1 MiB       | 9.4 MB                   |
| 10 MB, slow consumer             | 1.5 s  | 1 MiB       | 9.5 MB                   |
| 50 MB                            | 7.7 s  | 1 MiB       | 9.7 MB                   |

Memory is flat from 1 MB to 50 MB, and the queue never passes its bound. The UI's first test on a fresh dev server took 23.9 s; the same test on a warm server took 4.9 s.

**Gate results.**

| Check                                                 | Result                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------- |
| `npm test`                                            | 746 passed                                                          |
| `cargo test --workspace`                              | 565 passed, 19 ignored (the scale and stress tests, run separately) |
| terminal stress, including 50 MB                      | 4 passed                                                            |
| full UI suite, warm server                            | 394 passed, none flaky                                              |
| isolation and race tests ×3                           | TS 108 per run; UI 21 of 21                                         |
| Rust terminal tests ×3 (real shells)                  | 58 per run                                                          |
| fmt, clippy `-D warnings`, prettier, typecheck, build | clean                                                               |
| process leaks                                         | none                                                                |

The process leak audit lists shell-type processes created since the run began, with their ancestry, and stops nothing. Every survivor belonged to the tools running the gate, never to a test.

**CI.** The existing Windows job already ran every suite, real shells included. It now also runs the terminal stress tests, 50 MB included (`terminal_stream::tests::stress -- --include-ignored`).

**Platform coverage.** Windows (ConPTY, Job Objects, Git Bash, cmd, PowerShell) is executed. The Unix paths are written, and unit-checked where possible, but **not executed**:

- the PTY and process group (`killpg`);
- discovery of `$SHELL`;
- `-l` login shells;
- the `ps`-based branch of the containment test.

A Linux CI job would need the Tauri Linux system libraries and a Linux build of the bundled search tool (`resources/search/rg.exe` is Windows-only today). That is a cross-platform build task, not a terminal one, and it is left for when Yavin targets Unix.

**Known limitations.**

- The first UI test on a cold dev server can approach its timeout. This is environmental: the same tests pass on a warm server.
- Settings are per installation (webview storage), last write wins across windows, and are not synced.
- File links do not span wrapped lines or account for wide characters.
- Problems parsing, AI access, a Unix CI job and session restoration are not part of the terminal, by design or for later.

**T06 → AI.** There is none in T06: no tool calls, agent runs, approvals, ChangeSets or AI command history. When the AI architecture arrives, the terminal becomes a _controlled tool_ through it, with its own permissions and approvals. It is never reached directly through TerminalService.

### The contract (TERMINAL-00)

The contract is held in two places:

- `src/services/terminalProtocol.ts`
- the pure crate `src-tauri/crates/ide-terminal-protocol`

Both read and write the wire forms in `src/services/terminalProtocol.fixtures.json` identically, and each side's tests check that. The native runtime and the renderer's event router use it (TERMINAL-01).

**Identities.**

- `TerminalId` (a session; the events call it `sessionId`) and `SubscriptionId`: 1-128 characters of `[A-Za-z0-9._-]`.
- `Generation`: an integer from 1.
- `Sequence`: an integer from 0.
- Both numbers stay within 2^53 - 1, so JavaScript holds them exactly.
- `WorkspaceId` is the canonical one from `workspaceManager.ts`, carried natively as its string.

**Session state machine.** There is one state per generation:

```text
Spawning ──> Running ──> Exiting ──> Exited
    │           │           │
    └───────────┴───────────┴──────> Failed
```

| State      | Meaning                                                       |
| ---------- | ------------------------------------------------------------- |
| `Spawning` | The open was accepted.                                        |
| `Running`  | The process runs.                                             |
| `Exiting`  | The end was seen or asked for, and output still drains.       |
| `Exited`   | Final: the process ended and all of its output was delivered. |
| `Failed`   | Final: the generation ended through an error.                 |

No other step exists. In particular there is no going back, no `Running → Exited` without `Exiting`, and nothing after a final state.

**Generation semantics.** A generation is one incarnation of a session.

- **The requester chooses it.** The workspace's TerminalService picks it when it opens the session, so it recognises the generation's first event even if that event arrives before the open's answer.
- **It only ever increases for an id.** The native side refuses an open whose generation is not newer than every earlier one for that id.
- **It changes exactly when a new process may start under an id:**
  - the first open;
  - every restart;
  - every reopen of a closed id.
- **It does not change** on a resize, a subscribe or unsubscribe, or a view detaching from a session.
- **Disposing a workspace retires its sessions' generations for good.**
- **Stale requests.** A write or resize naming any generation but the current one fails with `InvalidSession`. A close naming one succeeds and does nothing.
- **Stale events.** Any event naming another generation, such as late output or a late exit of a replaced launch, is discarded by consumers and can never change the current session.

**Sequence semantics.** `seq` orders output within one generation.

- **Numbering.** The first chunk is 0, each next chunk is one more, and none is ever skipped or repeated.
- **A new generation starts again at 0.**
- **Only output chunks carry `seq`.** A lifecycle event never takes one.
- **The two end events, `TerminalExit` and `TerminalErrorEvent`, carry `lastSeq`.** It is the `seq` of the generation's final chunk, or `null` if the generation wrote nothing, so a consumer knows it has every byte.
- **Consumers reject out-of-order output.**
  - A `seq` below the next expected one is a duplicate, and is dropped.
  - A `seq` above it is a gap, which the protocol never allows; dropping output requires a protocol revision.
- **ACKs (TERMINAL-02) are cumulative.** An ACK acknowledges "every chunk up to and including `seq` N of generation G".

**Output protocol.** `TerminalOutputChunk { sessionId, generation, seq, bytes }`.

- **`bytes` are raw**, standard base64 inside JSON on the wire.
- **The raw-byte rule.** A chunk may end anywhere: inside a UTF-8 character, inside a CSI/ANSI escape, inside an OSC sequence. It may also hold several of them.
  - Nothing in the protocol decodes output.
  - The consumer feeds chunks in `seq` order to a streaming decoder (xterm's `write(Uint8Array)`), which keeps the partial tail.
- **The shape never changes.** TERMINAL-01 may send one PTY read per chunk; TERMINAL-02 may batch many reads into one chunk. The shape and the meaning of every field are the same either way.

**Events and their order.** For each generation:

- **Order.**
  - `TerminalStateChanged` to `Running` (with `pid`, or `null`) precedes any output.
  - Output chunks arrive in `seq` order.
  - `TerminalStateChanged` to `Exiting` may come before the last chunks, because output drains.
  - Exactly one end event comes last: `TerminalExit` (`Exited`, with `exitCode`) or `TerminalErrorEvent` (`Failed`, with `{code, message}`), each carrying `lastSeq`.
- **Nothing follows the end.**
- **A failed open has no events.** An open that fails returns its error and emits nothing for that generation.
- **Every event carries `sessionId` and `generation`.**
- **Two side-band messages carry no `seq` and never change the state.**
  - `detached` (TERMINAL-02) tells one subscriber it was let go (overflow), with how far it got. The session and its other subscribers go on.
  - `shell` (TERMINAL-05A) is a shell-integration signal, in order with the output. It is accepted only while the generation is `Running` or `Exiting`, and never replayed.

`applyEvent` in `terminalProtocol.ts` is the consumer's rule for all of this. It accepts or rejects one event with a reason (`other-session`, `stale-generation`, `duplicate`, `gap`, `after-end`, `illegal-transition`). A rejected event changes nothing.

**Requests.** Open, write, resize, close and kill are implemented natively (TERMINAL-01). A restart is an open of a newer generation of the same id, which replaces the older one. There is no separate restart command: TerminalService's `restart` is that open.

| Request   | Contract                                                                                                                                                                                                                                                                     |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open`    | `{sessionId, workspaceId, generation, profile, cwd, dimensions}`. Answers the `TerminalSession` (`Spawning` or `Running`).                                                                                                                                                   |
| `write`   | `{sessionId, generation, data}`. Answering means the input was **queued** for the session's writer, never that the PTY took it, so no request waits on a blocked process. At most 64 KiB of UTF-8 per request; larger input is split at character boundaries (`chunkInput`). |
| `resize`  | The latest size wins. Only a `Running` generation is resized.                                                                                                                                                                                                                |
| `close`   | Gentle and idempotent.                                                                                                                                                                                                                                                       |
| `kill`    | Forced: the shell and everything it started.                                                                                                                                                                                                                                 |
| `restart` | `{sessionId, previousGeneration, generation, dimensions}`, keeping the profile and folder.                                                                                                                                                                                   |

**Dimensions.** `{cols, rows}`, whole cells.

- Valid sizes are 1-1000 each way.
- Zero, fractional or larger sizes are refused, not clamped. The renderer turns an unlaid-out panel into a real size first.
- Pixel sizes are layout, not contract.

**Subscriptions.**

- `subscribe {subscriptionId, sessionId, generation}`: the subscriber chooses its id (like a generation), and that generation's messages are delivered on its own channel alone. This is targeted delivery: there is no global broadcast.
- `ack {subscriptionId, sessionId, generation, seq}` is cumulative (see the output pipeline below).
- Several subscribers may follow one session.
- `unsubscribe` is idempotent and leaves the session and its other subscribers alone.
- A subscription that joins a running generation is first replayed what the generation retains (its `Running`, the last 256 KiB of output, and its end if it has ended), then continues live, with nothing twice (TERMINAL-02/03).

**Profiles.** `TerminalProfile {id, name, executable, args, cwd, env, login?}` (`login` since TERMINAL-05; see "Shells and profiles").

- These are only what the launch already carries.
- `env` is ordered pairs.
- A login shell is requested with `login`, which the native side translates into the shell's flag.
- The validation rules are the launch's own: no line breaks or NUL, and environment names without `=`.

**Errors.** A `TerminalError` is `{code: TerminalErrorCause, message}`.

- **Causes:** `InvalidSession`, `InvalidWorkspace`, `ShellUnavailable`, `SpawnFailed`, `InvalidCwd`, `PermissionDenied`, `WriteFailed`, `ResizeFailed`, `ProcessFailed`, `TerminationFailed`, `ProtocolError`, `StaleGeneration`, `OutputOverflow`, `SubscriberFailed`, `TransportFailed`, `Unknown` (internal, or not in this list). The four before `Unknown` came with TERMINAL-02: a stale request or acknowledgement is `StaleGeneration` (it was `InvalidSession`).
- **Wire forms.** Commands reject with `"Cause: message"`, the Local Git convention; events carry the object.
- **Messages are one line and fit to show.**
  - The native side describes an OS failure by what it was doing and the kind of failure (`TerminalError::from_io`), never the OS's own text.
  - The renderer turns any failure it does not recognise into `Unknown`, with a generic message; the raw text is kept in `detail` for logs only.

### Output pipeline (TERMINAL-02)

`src-tauri/src/terminal_stream.rs`: one `OutputStream` per generation, between the reader and that generation's subscribers.

```text
PTY ─> reader ─push─> pending (bounded) ─pump─> sealed entries (shared, bounded)
                                                  ├─ subscriber A: cursor, window ─> its Channel ─> xterm.write
                                                  └─ subscriber B: cursor, window ─> its Channel ─> xterm.write
                        reader pauses <── queued ≥ ingress high, resumes ≤ ingress low
                        a window refills <── ack(generation, seq), cumulative, after xterm parsed it
```

- **The reader only appends.** It never serializes, never delivers, never waits on a subscriber -- only on the bound. While it waits, the PTY fills and the program writing to it blocks: that is the backpressure, and no byte is dropped to keep up.
- **One pump thread per generation** seals what is pending into numbered chunks, serializes each message once (shared by every subscriber), and sends to each subscriber whose window has room, outside the lock. It is the only sender, so each subscriber sees one ordered stream: `Running`, the output in `seq` order, `Exiting`, then exactly one end, after all the output. (Output read after the end was seen comes after `Exiting`, as the contract allows.)
- **Each subscriber is isolated.** It has its own channel (a Tauri `Channel`, created by the renderer and passed with `terminal_open`/`terminal_subscribe`), its own cursor into the shared entries, and its own in-flight window. Entries are kept only until every subscriber has been sent them.
- **Acknowledgements** come from the renderer once xterm has parsed a chunk (`term.write(bytes, callback)`). They are cumulative: a duplicate or an older one changes nothing, a late one after the stream ended is harmless, one for another generation is `StaleGeneration`, one beyond what was sent is `ProtocolError`. A transport has no backpressure of its own (`Channel::send` queues on the webview), so acknowledgements are the only signal of a consumer keeping up.
- **Generations** each have their own stream: a restart's new stream starts at `seq` 0, and an old stream's buffered output only ever goes to the old stream's subscribers.
- **Replay (TERMINAL-03)** is kept apart from this flow-control buffering: a bounded ring of recent output (see "Workspace Terminal Service" above). A subscriber attaching with replay is sent the ring, then continues live from exactly where it stops. A _lifecycle_ subscriber -- the TerminalService -- is sent no output and never holds the reader back.

**Limits** (`terminal_stream::LIMITS`):

| Limit                        | Value             | Why                                                                                                                                                                                                                               |
| ---------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Largest chunk (and batch)    | 64 KiB            | Matches the largest input request; xterm parses it well within a frame, and its message (~88 KiB base64) still crosses the transport in one piece.                                                                                |
| Reads per batch              | 32                | Many tiny writes (a progress bar) become one message.                                                                                                                                                                             |
| Batch latency                | 5 ms              | Typing echoes with no visible delay; a burst becomes a few messages. Windows timer resolution can stretch it to ~16 ms.                                                                                                           |
| Ingress high / low           | 1 MiB / 256 KiB   | The output one terminal may hold for its subscribers; the reader resumes with room for a burst.                                                                                                                                   |
| Subscriber window high / low | 512 KiB / 128 KiB | Output in one subscriber's transport and parser at once.                                                                                                                                                                          |
| Laggard timeout              | 5 s               | How long a subscriber behind another may keep the reader paused.                                                                                                                                                                  |
| Unresponsive timeout         | 30 s              | How long a subscriber with a full window may go without any acknowledgement. Long, so a slow or hidden view that is still acknowledging is never mistaken for a dead one.                                                         |
| Replay                       | 256 KiB           | Recent output kept per generation for a view that attaches later (TERMINAL-03): enough to redraw a screen and its recent scrollback, never a history. At most one subscriber window, so a replay never waits on acknowledgements. |

The PTY read itself is 8 KiB.

**Three regimes:**

- **Normal:** every byte reaches every subscriber.
- **Backpressured:** the reader is paused until subscribers acknowledge. Nothing is lost.
- **Overflow:** never a silent hole. Instead, a subscriber is detached with a `detached` message that says how far it got (`lastSeq`), and the session and the other subscribers go on. This happens in two cases:
  - A subscriber behind another keeps the reader paused past the laggard timeout (`OutputOverflow`).
  - A subscriber sends no acknowledgement at all past the unresponsive timeout (`SubscriberFailed`). This applies even to a sole subscriber, so a broken view cannot hold its terminal, and its end, for ever.

  A sole subscriber that is merely slow is never detached; it is simply backpressured. A channel whose window has gone is removed silently, as a normal end.

**Observability.** `terminal_stats(sessionId)` reports what the session's stream is doing, never its content:

- queued and peak queued bytes;
- the highest `seq`;
- whether it is backpressured;
- for each subscriber: its sent and acknowledged `seq`, its in-flight bytes, and whether it is throttled.

**Measured** (development machine, debug build):

| Run                            | Time  | Peak queued | Note                                                                 |
| ------------------------------ | ----- | ----------- | -------------------------------------------------------------------- |
| Pipeline, 50 MB                | 8.5 s | 1 MiB       | 848 chunks; every byte and `seq` checked                             |
| Pipeline, 10 MB, slow consumer | 1.6 s | 1 MiB       |                                                                      |
| Real shell, ~4.2 MB            | ~9 s  | ~6 KiB      | ConPTY is the bottleneck; commands answered in under 1 ms throughout |

`stress_50_mb` is `#[ignore]`d and runs with `cargo test -p yavin-ide --lib terminal_stream -- --ignored`.

### Module plan

| Module       | Scope                                                                                |
| ------------ | ------------------------------------------------------------------------------------ |
| TERMINAL-01  | Done: the native runtime on this contract (see "Native session runtime" above).      |
| TERMINAL-02  | Done: the output pipeline (see "Output pipeline (TERMINAL-02)" above).               |
| TERMINAL-03  | Done: the Workspace Terminal Service (see above).                                    |
| TERMINAL-04  | Done: the renderer as a view of the service (see "Renderer (TERMINAL-04)").          |
| TERMINAL-05  | Done: shells and profiles (see "Shells and profiles (TERMINAL-05)").                 |
| TERMINAL-05A | Done: shell integration, OSC 7 and OSC 133 (see "Shell integration (TERMINAL-05A)"). |
| TERMINAL-06  | Done: IDE integration (see "IDE integration (TERMINAL-06)").                         |
| TERMINAL-07  | Done: persistence and settings (see "Persistence and settings (TERMINAL-07)").       |
| TERMINAL-08  | Done: production gate (see "Production gate (TERMINAL-08)").                         |

Later modules are listed in the Terminal roadmap.

## Source Control panel

The panel (`components/layout/SourceControlPanel.tsx`) is a view of the workspace's Git registry; it holds no Git state of its own beyond view preferences. From the top:

```text
SOURCE CONTROL                                   ⋯   view options: which sections show
⎇ main ↓1 ↑2                            ›  [Sync]    BranchBar
  (open: filter · branch list · create · Fetch/Pull/Push · diverged Rebase/Merge · publish)
▾ CHANGES 6                        [▤][🌲][⟳][⋯]    group · list/tree · refresh · Changes actions
  Message (Ctrl+Enter to commit on "main")           CommitComposer
  [ ✓ Commit 3 staged            ][▾]  ☐ Amend ☐ Sign off
  ⚠ Merge in progress …  Abort · Skip · Continue     (only while one is)
  Filter changes                                     (more than 20 files)
  ▾ Conflicts / ▾ Staged / ▾ Unstaged                grouped (default), or one list
▸ GRAPH · ▸ STASHES (+ New Stash) · ▸ REPOSITORIES
```

| Piece                               | Owns                                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `components/git/BranchBar.tsx`      | the branch in view, incoming/outgoing, one Sync, the branch card (switch, create, delete, publish)       |
| `components/git/CommitComposer.tsx` | the message (per-repository draft), what the button says it will commit, Amend and Sign off              |
| `services/git/changeGroups.ts`      | which files are staged, unstaged, conflicted or discardable; grouping, filtering, which diff a row opens |
| `services/git/changeMenu.ts`        | a file's right-click menu, by the group it was clicked in; the `.gitignore` line it adds                 |
| `components/git/SectionHeader.tsx`  | the header every section shares (fold, count, actions shown on hover or focus)                           |

**Changes.** Grouped by default: **Conflicts** (resolved one at a time, Ours/Theirs), **Staged** and **Unstaged**. A partly staged file is in both, each row showing its own half: its letter (the index's or the working tree's), the diff it opens (`--cached` or not), and the direction of its checkbox (`Unstage …` in Staged, `Stage …` in Unstaged). "Show as One List" gives every file once, the checkbox saying how much of it is staged (mixed when partly). Either view can be a tree, sorted by name, path or status; the filter matches every word typed against the repo-relative path. Counts, Stage All, Discard All and the commit always cover every file, filtered or not, drawn or not (rows are drawn 500 at a time).

**Rows.** Click or Enter opens the diff; Space stages or unstages; Delete discards (with the same confirmation and recovery copy as the button); arrow keys move between rows; right-click, Shift+F10 or the context-menu key opens the file's menu -- Open Changes / Open File, Stage / Unstage, Discard, Accept Current or Incoming for a conflict, Add to .gitignore for an untracked file (appended through the guarded write, so it is undoable), Reveal in File Explorer, Copy Path, Copy Relative Path.

**Commit.** The button says what it will do: "Commit 3 staged", "Commit all 5" (nothing staged: every tracked change, `-a`), or "Amend last commit" (what is staged, possibly nothing: a new message; never `-a`). Sign off adds `-s`. The dropdown keeps every commit variant.

**Dialogs.** A dialog may open the next from its answer (pick a remote, then name the branch). Each request gets its own dialog element and clears only itself, so the first closing never takes the second with it.

## Local Git

Local Git is Yavin's own history for a workspace -- checkpoints, local commits, branches and restore, eventually "Undo AI Run" -- that works with or without real Git. It is **not Git**: it never reads or writes `.git`, never runs `git`, never reads `.gitignore`, and nothing it stores ends up in the project. Real Git stays what the Source Control panel shows. Local Git never owns live document content either: DocumentService does, and Local Git only records snapshots of it.

LG-01 is the storage layer: the object store, the repository lifecycle and crash-safe persistence. LG-02 adds snapshots of the workspace -- on disk, and with unsaved documents applied -- and status against Local HEAD ("Snapshots and status" below). LG-03 adds checkpoints, commits, history, diffs and restore ("History, diff and restore" below). LG-04 adds the Local Index (staging), branches, tags and detached HEAD ("Staging, branches and tags" below). LG-05 adds reset, revert and stash ("Reset, revert and stash" below). Merge and everything that builds on it arrive in later phases (see "Not yet").

```text
renderer                                    native (src-tauri)
WorkspaceContext ──owns── LocalGitService ─── localgit_* ──> LocalGit (src/localgit.rs)
  (services/workspaces.ts)  (services/localgit)  handle        handles → stores (one per workspace key)
                                                                │
                                                        crates/ide-localgit (pure Rust, no Tauri)
                                                                │
                              <app_local_data_dir>/local-git/<key>/
                                workspace.json   identity, folders, settings (versioned)
                                repo.lock        single writer (OS file lock)
                                refs.json        HEAD + refs + revision (atomic replace)
                                logs/refs.log    reflog, append-only JSON lines
                                objects/seg-*.ylseg   immutable segments
                                tmp/             segments being written; swept by the writer
                                quarantine/      damaged files set aside; never deleted automatically
```

**Ownership.**

| Owner                                | Owns                                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `crates/ide-localgit`                | the format: ids, objects, segments, refs, reflog, locking, recovery, verification. No Tauri, no processes   |
| `src-tauri/src/localgit.rs`          | the storage location, one open store per workspace key, handles, checking the workspace the window has open |
| `services/localgit/service.ts`       | one workspace's calls; refuses and drops everything once its context is no longer active                    |
| `WorkspaceContext` (`workspaces.ts`) | the service's lifetime: made with the context (folders, app only), closed by its disposal                   |
| DocumentService                      | document content -- unchanged; LG-01 does not read it                                                       |

**Storage and identity.** Stores live in Yavin's private data (`app_local_data_dir()/local-git/`), never in the project. A store's directory is `<slug>-<20 hex>`: the first folder's name, then `sha256("ylg-workspace\0" + WorkspaceId)`. The native side computes the `WorkspaceId` itself with the same rules as `resource.ts` (`resource_id_of`; a shared fixture, `services/localgit/workspaceIds.fixtures.json`, is run by both languages), so every spelling of a folder (`\\?\`, case, separators) is one store. `workspace.json` records the WorkspaceId, a `folderId` per folder, and settings (`maxBlobBytes`, 20 MiB). Opening a store whose WorkspaceId differs is refused (`WorkspaceMismatch`); missing metadata over existing data is `RecoveryRequired`; unreadable metadata is quarantined and refused; a newer format is `UnsupportedVersion`. None of these is ever repaired by rewriting.

**Objects.** An id is `sha256("ylg1 " + kind + " " + length + "\0" + payload)`, 64 lowercase hex characters. SHA-256 because AI writes arbitrary content and ids must not collide; stored bytes are re-hashed on every read.

- **Blob**: raw bytes, binary-safe, streamed in 64 KiB reads. A file over `maxBlobBytes` is hashed but not stored: its tree entry is marked unstored with its size, so a change is still detected, and reading it is `ContentUnavailable`.
- **Tree**: entries strictly sorted by name bytes; kind (file, directory, symlink), flags (executable, unstored, directory target, junction), name, id, and the size of an unstored file. Names are UTF-8, 1-255 bytes, never `.` or `..`, never containing `/` or NUL; anything else is refused, never converted. Case is preserved (a case-only rename is a change); empty directories are kept (the empty tree). Links are recorded, never followed. Unknown flags or kinds are corruption.
- **Root**: `folderId → tree`, sorted. Absolute paths never enter a hash.
- **Commit**: canonical text (decoding re-encodes and requires the same bytes): root, an optional disk root (when unsaved documents were applied), ordered parents, workspace, author, time (display only; order comes from parents), source (`human`, `ai`, `agent`, `automatic`, `recovery`, `checkpoint`), sorted `meta` and `metaobj` (object ids for later ChangeSets and AI provenance), then the message.

**Segments.** Objects are written into segment files, not one file per object (on NTFS with Defender a file per object makes a 100k-file first snapshot take minutes). A write transaction streams its new objects (already known ones are skipped) into one temp file in `tmp/`, then appends a sorted index and a trailer carrying the index's SHA-256, syncs, checks its own index, renames it into `objects/`, and only then makes the objects visible. Segments are never modified. On open each segment's index is read from its trailer; one that does not verify is moved (by the writer) to `quarantine/` and reported, and its objects are missing (reported where refs need them). Each entry has a codec byte; v1 stores raw bytes (compression is reserved for later).

**Refs and reflog.** `refs.json` holds HEAD (on a ref, possibly unborn, or detached), every ref and a monotonic `revision`, replaced atomically, so several refs and HEAD change together. `update_refs` is compare-and-swap: the caller's revision and every ref's expected old value must match (`StaleRevision`, `RefConflict`), and every new id must exist. The reflog line is appended and synced first, `refs.json` written second. Ref names start with `refs/`, are `/`-separated `[A-Za-z0-9._-]` segments, and cannot collide ignoring case (namespaces reserved for later: `refs/heads/`, `refs/tags/`, `refs/yavin/…`).

**Crash safety.** Every write step is either invisible until it completes or detected on the next open, and nothing is guessed:

| Interrupted after                     | On the next open                                                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| a temp segment was started or written | the writer removes it (`staleTempsRemoved`)                                                                                                   |
| a segment was renamed into place      | kept; its objects are unreachable until a later ref points at them (GC is later)                                                              |
| part of a reflog line                 | the torn tail is copied to `quarantine/`, cut off and reported (`tornReflog`)                                                                 |
| the reflog line, before `refs.json`   | refs stay as they were; the update is marked aborted in the reflog and reported (`interruptedRefUpdate`) -- **never completed automatically** |
| `refs.json`                           | the new state, complete                                                                                                                       |

A revision is never reused: the next one is past both `refs.json` and the reflog. A ref whose object is missing is reported (`danglingRef`), never rewritten. `verify(full)` re-reads and re-hashes every object and walks every ref's history. Fault injection (the `fault-injection` feature, tests only) crashes at each step; the tests reopen and require old-or-new refs and a clean verify.

**Locking.** `repo.lock` is an OS file lock. The first process to open a store is its writer; a second process (another Yavin instance on the same workspace) opens it **read-only**, sees the same history (reloaded on `info`), and every write it attempts is `ReadOnly`. Only the writer sweeps temps or repairs a torn reflog. The lock dies with its process, so a crashed writer never blocks the next one. Within one process, every handle for a workspace shares one open store.

**Workspace lifecycle.** The renderer's `LocalGitService` belongs to its `WorkspaceContext`: `localgit_open` must be asked with the folders the native side has open (`NotInWorkspace` otherwise) and gets a random handle. Every call checks the context before it goes and when it answers: a late answer from workspace A is dropped (`LocalGitClosedError`), never delivered to B; a store that finishes opening after its workspace went is handed straight back; A → B → A makes a new service with a new handle. The context's disposal closes its handle, and `enter_workspace` revokes every other workspace's handles natively; a store closes (releasing its lock) with its last handle. Commands take handles and ids, never paths; failures are `Code: message`.

**Performance** (release build, idle development machine, `cargo test -p ide-localgit --release --test scale -- --ignored`): 10k objects write in 0.16 s (one 16.6 MB segment; writing them again, all duplicates, 31 ms), reopen in 5 ms, read in 0.12 ms each, and a commit plus ref update (synced reflog line and `refs.json`) takes 51 ms; 100k objects write in 1.2 s (166 MB, one segment; duplicates 189 ms), reopen in 35 ms, read in 0.11 ms each, commit plus ref update 50 ms.

### Snapshots and status (LG-02)

```text
DocumentService ──(read only)── OverlayTracker ── LocalGitService ── localgit_put_overlays / _snapshot / _status
 (App.tsx attaches it to the     services/localgit/overlays.ts                    │
  workspace context: ctx.own)                                        SnapshotEngine (one per open store)
workspace watcher ── observe() (native, no renderer round trip) ──────────▶ dirty set, watcher health
                                                                             │
                                          scan.rs: walk + hash ──▶ disk root ──┬── status.rs ◀── Local HEAD
                                          overlays applied      ──▶ effective root┘   (index = HEAD)
```

**Local Git snapshot semantics are not Git ignore semantics.** A snapshot never reads `.gitignore`, `.git/info/exclude`, `core.excludesFile` or any Git configuration; a file Git ignores is in Local Git's snapshot like any other, and a source scan test forbids the code that could read them.

**Disk root and effective root.** A snapshot has two roots. The **disk root** is exactly what is on disk. The **effective root** is the disk root with every unsaved named document applied: a dirty document's bytes replace its file, and a dirty document whose file was deleted puts it back. With no unsaved document they are the same object. Nothing is written to the project to take either; DocumentService is read, never changed, and nothing saves.

| Disk                  | Editor            | Disk root  | Effective root   |
| --------------------- | ----------------- | ---------- | ---------------- |
| `foo.ts` = version 10 | clean             | version 10 | version 10       |
| `foo.ts` = version 10 | dirty, version 11 | version 10 | version 11       |
| `foo.ts` deleted      | open, dirty       | absent     | the unsaved text |

**What is recorded.** Regular files (as blobs), directories -- empty ones included -- and links. A **link** (a symbolic link or a Windows junction, told apart by its reparse tag) is recorded as its target text and **never followed**: nothing behind it is read, so a loop, a broken link or a link out of the workspace is harmless. Names are kept exactly (case, Unicode). Anything a tree cannot hold exactly -- a name that is not UTF-8 or is longer than 255 bytes, a FIFO, socket or device -- is left out and reported as a problem, never converted. Only the workspace's folders are walked, and nothing is written inside them.

**Exclusions** (`crates/ide-localgit/src/exclude.rs`), in order, the first that decides wins:

1. `.git` -- a directory or a worktree's gitfile, at any depth, in any case -- always. Nothing re-includes it.
2. `.yavinignore` files, the deepest directory's first; within one file the last matching line decides. Gitignore _syntax_ (`*`, `**`, a trailing `/` for directories, a leading `/` to anchor, `!` to re-include), compiled only from `.yavinignore` text. A directory left out is not entered, so nothing below it can be re-included. An invalid line is reported with its line number and skipped.
3. The built-in list, lowest precedence (a `.yavinignore` `!node_modules/` brings it back): `node_modules/`, `target/`, `__pycache__/`, `.venv/`, `.gradle/`, `.next/`, `.nuxt/`, `.turbo/` (installed packages, build output and caches), `.env`, `.env.*` (secrets are never copied into history by default), `.DS_Store`, `Thumbs.db` (operating-system clutter). `dist/`, `build/`, `out/` and `obj/` are not in it: without `.gitignore` they may be source.

Patterns match case-sensitively on every platform, so one set of files gives one snapshot anywhere. An unsaved document inside a left-out place (or `.git`) is refused as an overlay, and reported.

**Large files.** A file over `maxBlobBytes` (20 MiB; exactly 20 MiB is still stored) is streamed through SHA-256 -- never held in memory -- and recorded as an _unstored_ entry with its id and size. Its id is its content's own, so status still sees it unchanged, modified, deleted, added or renamed; its content is not in the store (reading it is `ContentUnavailable`, and restoring it, from LG-03, will say so). "Unstored" is never "missing": the file is in the tree.

**Reading a file safely.** Metadata, then the bytes, then metadata again: the file is accepted only if size, modification time and (Windows) creation time or (Unix) inode and change time are unchanged and exactly `size` bytes were read. Otherwise it is read once more, and if it changed again it is `unstable`. A file that disappears meanwhile is absent. A file that is unstable or cannot be read (locked, no permission) is **carried forward** -- its entry from the previous scan (or HEAD) kept, never recorded as deleted -- and reported; with nothing to carry forward it is left out and reported. An unreadable directory is carried forward the same way. Executable bits come from the file on Unix; Windows has none, so the previous entry's is kept (as Git's `core.fileMode=false`).

**The scan cache** (`cache/scan-<folderId>.bin` in the store, checksummed) remembers each file's metadata and id so a scan need not hash it again. It is used only when the metadata is exactly what was recorded **and** the file was last modified more than 3 s before the scan that recorded it (a "racy" file, modified around a scan, could change again without its time changing -- it is always hashed). A damaged cache is ignored; an empty one only costs time. A `verify` scan ignores it entirely.

**Full and incremental.** A Full scan lists every directory and stats every file (hashing only what the cache cannot vouch for); it is always authoritative. An incremental scan lists only the directories the watcher reported changes in, scans a rescan scope (dropped or overflowing events) as if new, and takes every other directory's tree from the previous scan without opening it. The watcher is an optimisation, never the source of truth. A scan is **Full** when:

| Rule                                                                                                                                                                 | Why                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| first scan since the store opened, or after a scan failed or was cancelled                                                                                           | nothing to build on (the changes that scan took from the watcher are gone) |
| the watcher is failed, has not reported, or reported another generation than the one watching when the previous scan started; or events came from another generation | events may have been missed                                                |
| every 20th snapshot, or 10 minutes since the last Full                                                                                                               | the periodic safety rescan (a change the watcher never reported is found)  |
| a `.yavinignore` changed                                                                                                                                             | the rules for everything below it may have                                 |
| the snapshot is persisted                                                                                                                                            | a persisted snapshot never builds on an ephemeral one                      |
| the caller asked for `full` or `verify`                                                                                                                              |                                                                            |

The watcher's batches reach Local Git natively (`LocalGit::observe`, from `watch_workspace`), never through the renderer; they never wait for a scan, and events arriving during one are kept for the next. The watcher reports a change up to about a second after it happens, so an incremental snapshot can miss a change made in that last second -- one reason persisted snapshots are Full.

**Ephemeral and persisted.** A snapshot for status is ephemeral: hashed, its trees computed in memory, nothing written. A persisted snapshot writes every blob, tree, both roots and the overlay set in one transaction -- published atomically, or not at all. LG-02 creates no commit, checkpoint or ref: a persisted snapshot is what LG-03's checkpoints and commits will refer to.

**Overlays.** The renderer's `OverlayTracker` (`services/localgit/overlays.ts`), attached to the workspace's `LocalGitService` by the window through the workspace context, takes part documents that are named files (`source: disk`), inside the workspace's folders, with unsaved changes -- including one whose file was deleted. Never proposed (AI) documents, never documents outside the workspace; untitled documents only in recovery snapshots that ask for them (they have no path, so they are in the overlay set but in no tree). An overlay's bytes are what saving would write: DocumentService's own `encode` (its UTF-8 or UTF-8 with BOM, its LF or CRLF), computed once per document version. The service sends each version to the handle's native pool once (`localgit_put_overlays`); a snapshot names the versions it uses and the pool forgets the rest (a version the pool no longer has is `OverlayMissing`, and the service sends everything again, once). The native side places each overlay in its folder by `ResourceId` and refuses one outside the workspace or in a left-out place.

The **overlay set** is a canonical text blob, referenced by the snapshot:

```text
ylg-overlays 1
doc <folderId> <path> <blob> <encoding> <lineEnding> <version>
untitled <id> <blob> <encoding> <lineEnding> <version>
```

sorted, with fields `%XX`-escaped as commit headers are, so the same overlays always give the same id.

**Status** (`status.rs`) compares, per path, Local HEAD with the disk root (**disk**: what is saved) and with the effective root (**effective**: what the user has), and says for each unsaved document how it relates to the disk (`differsFromDisk`, `equalsDisk`, `openDeletedOnDisk`) and whether it equals HEAD. The index is HEAD until staging exists (LG-04), and says so (`index: "head"`). Changes are `added`, `modified` (content, executable bit or link kind), `deleted`, `typeChanged` (file, directory and link turned into one another; a directory's own files are then listed as added or deleted beneath it) and `renamed` (exactly the same content gone from one path and present at another, paired deterministically in path order; unstored files take part by their hash; a case-only rename is a rename). There is no similarity-based rename detection. With no commit yet, everything is added. It is Yavin's own typed model, not `git status` output, and is cut at a limit (5000 by default) with the total and `truncated`.

**Jobs, cancellation and progress.** A snapshot or status is a job of a handle with its own id. A newer status cancels the status in flight; `localgit_cancel` cancels any job; closing or revoking a handle (leaving the workspace) cancels all of its jobs, and a job's result is delivered only if its handle is still open and it was not cancelled -- otherwise `HandleClosed` or `Cancelled`, and the renderer drops a late answer anyway (`LocalGitClosedError`). One snapshot runs at a time per store; persisted ones cannot corrupt each other. Progress (`localgit-progress`: phase, files, directories, bytes hashed, the previous scan's file count as an estimate) is throttled to 10 a second and plays no part in correctness.

**Multi-root.** Every structure is per folder: a root maps folder ids to trees, paths are folder-relative, and two folders' `foo.ts` never meet. The window opens one folder today.

**Performance** (release, idle development machine, `cargo test -p ide-localgit --release --test snapshot_scale -- --ignored --nocapture --test-threads=1`; small source files in 10,000 directories):

|                                         | 10k files              | 100k files               | Plan budget     |
| --------------------------------------- | ---------------------- | ------------------------ | --------------- |
| first persisted snapshot                | 1.64 s                 | 10.7 s                   | 3 s / 30 s      |
| Full walk, nothing changed (warm cache) | 0.59 s                 | 1.14 s                   | 100k < 2.5 s    |
| incremental, 10 files changed           | 44 ms                  | 38 ms                    | 100k < 150 ms   |
| status (incremental / Full)             | 16 ms / 0.55 s         | 9 ms / 1.03 s            | warm 100k < 3 s |
| store after the first snapshot          | 20,113 objects, 4.4 MB | 110,113 objects, 35.2 MB |                 |
| peak memory (process)                   |                        | 85 MB                    | < 250 MB        |

### History, diff and restore (LG-03)

**Local Git never owns live document content, and never writes into a project.** Checkpoints and commits record what LG-02 snapshots saw; diffs read the store (and, for the workspace side, the snapshot's own bytes); a restore is _planned_ by Local Git and _carried out_ by the file-operation layer (Module 03, recorded by Module 04), and the window's documents are reconciled through DocumentService's public API.

```text
checkpoint:  LG-02 snapshot (persisted, incremental when warm) ──▶ commit object (source checkpoint, parent HEAD) ──▶ refs/yavin/checkpoint
commit:      LG-02 snapshot (persisted, Full) ─┐
             or a checkpoint's roots as they are ┴▶ commit object (source human, parent HEAD) ──▶ HEAD (refs/heads/main) moves
restore:     snapshot (Full, persisted) ─▶ plan (crate: ops + conflicts) ─▶ recovery checkpoint ─▶ execute (app: one M03 operation, M04 intent) ─▶ verify (Full snapshot) ─▶ window reconciles documents
```

**Checkpoint and commit.** A _checkpoint_ captures the workspace -- its effective root, so unsaved documents are in it, with the disk root and the overlay set beside it -- as a commit object of source `checkpoint` whose parent is HEAD. It moves only `refs/yavin/checkpoint`: durable, listed (that ref's reflog is the list of every checkpoint), but not history. A _commit_ is history: a commit object of source `human` on top of HEAD, after which HEAD moves to it. A commit is made from a fresh persisted snapshot, or from a checkpoint -- taking its roots as they are, with no scan and no hashing, so the same tree is never stored twice (objects are content-addressed; the same metadata gives the same commit id). A restore takes a checkpoint of source `recovery` first, so what it replaced can be restored in turn. A checkpoint from a warm engine is an incremental persisted snapshot: a directory the watcher did not report is reused only if its tree is already in the store (and, like any incremental snapshot, it can miss a change made within the watcher's latency); a commit's snapshot is always Full.

**The commit object** is LG-01's canonical commit: root (the effective root), `disk-root` when unsaved documents made it differ, parents, workspace, author (name and id), time (milliseconds and minutes east of UTC, for display), source, `meta snapshot 1`, `metaobj overlays <id>` when there was an overlay set, and the message (not empty, no NUL, at most 64 KiB).

**HEAD.** Until branches exist (LG-04) history is one line. HEAD names `refs/heads/main`, unborn until the first commit; each commit's first parent is the HEAD it was made on. HEAD moves by LG-01's compare-and-swap with the reflog written first, after the commit object is published (synced, renamed into place): after a crash HEAD is the old commit or the new one, both complete, and an interrupted move is reported and never finished on its own (crash-tested at every durable boundary).

**History** is a walk along first parents from HEAD (or a cursor), newest first, deterministic (order comes from parents, never from times), in pages (`limit`, `next`). A commit that cannot be read ends the page with the reason (`MissingObject`, `CorruptObject`), never skipped. Each item has the id, a 12-character short id, message and summary, time, author, parents, source and roots. A commit's tree can be listed directory by directory, with sizes (from the segment index, nothing read), link kinds, empty directories and unstored large files as such.

**Diff** (`diff.rs`) compares commit to commit, or a commit (HEAD by default) to the workspace as the user has it -- an ephemeral LG-02 snapshot with the unsaved documents, never a second scanner, and nothing saved. Which paths changed comes from status's tree comparison (equal subtrees skipped, so identical commits cost nothing; added, deleted, modified, type-changed, and exact-content renames paired deterministically). Each file gets a line diff in structured hunks (`oldStart`, `oldLines`, `newStart`, `newLines`, lines of `context`/`addition`/`deletion` with their line numbers; a Myers diff, three lines of context), suited to Monaco's diff editor later. There is none for a binary side (a NUL in the first 8 KiB, or not UTF-8), for content that is unavailable -- `notStored` (over the limit when recorded: **its historical content is never read from disk in its place**), `missing`, `changedOnDisk` (a workspace file that changed after the snapshot) -- or beyond the size (2 MiB a file) and total (32 MiB) budgets.

**Restore** makes the workspace match a commit: all of it, or one path. It never goes _scan, change, discover more_:

1. **Snapshot** (Full, persisted) with the unsaved documents.
2. **Plan** (`restore.rs`, in the crate, writing nothing): the ordered operations -- removals deepest first, then folders shallowest first, then files and links -- each naming the state the plan saw at its path; and every conflict.
3. **Refuse** if there is any conflict, before anything is touched:

| Conflict                                                          | Meaning                                                                                                        |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `dirtyDocumentWouldBeOverwritten` / `dirtyDocumentWouldBeDeleted` | a document with unsaved changes would lose them (default policy `refuseIfDirty`)                               |
| `historicalContentUnavailable`                                    | the commit's content was never stored (over 20 MiB) or is missing -- the whole restore fails before any change |
| `currentContentNotStored`                                         | a file over 20 MiB would be replaced or removed, and no checkpoint can keep it                                 |
| `currentStateUnknown`                                             | the snapshot could not read a path in scope                                                                    |
| `caseOnlyRename`                                                  | the disk and the commit spell a name differently only in case (Windows)                                        |
| `pathBlocked`, `targetUnavailable`                                | a single-path restore needs a folder where a file is; the path or folder is not in the commit                  |
| `diskChangedSinceSnapshot`                                        | found at the last moment: a path no longer holds what the plan saw                                             |
| `wouldRemoveUntracked`                                            | a folder to remove holds something snapshots leave out (a nested `.git`, `node_modules`): never deleted        |
| `linkNotRestorable`                                               | this system cannot create the link (Windows symbolic links need Developer Mode)                                |

With policy `replaceDocument` -- the user's explicit choice, never the default -- the two document conflicts become document actions instead. 4. **Checkpoint** the workspace (source `recovery`), so the restore can be undone. 5. **Execute** (`src-tauri/src/localgit_restore.rs`): every path is checked again against what the plan saw, every folder on the way must be a real folder (never a link: nothing is written through a junction out of the workspace), and link creation is tried in a scratch folder -- any failure refuses, untouched. Then **one Module 03 operation** of kind `restore`, whose Module 04 intent records one effect per path (its state before and after: a file's exact bytes, a folder, a link, nothing) plus each file's temporary file. Each file is written beside itself and renamed into place (old bytes or new, never half); junctions are created with their reparse point, never by a process; links are removed as links. The last point of cancellation is before the intent is recorded; the command also checks there that its workspace is still the window's. 6. **Verify** with a Full snapshot: the disk tree (or the restored path) must equal the commit's. Otherwise the result is `verificationFailed`, never success. 7. **Reconcile documents** (the window, `OverlayTracker.reconcileRestore`): documents the user chose to replace are reloaded or closed with their edits discarded (`reload`/`close` with `discard`); every change is given to `applyResourceChanges`, so clean documents follow the disk; then each restored file's open document is confirmed to show the disk. A failure is reported (`succeeded: false`), never passed over.

A restore that fails partway (a disk error) reports how many operations were done and never claims success. A crash partway leaves the Module 04 record; the next start settles it as a whole -- `completed`, `notApplied`, or `partial` (reported in Recovery, nothing replayed or undone) -- as for any file operation. After a restore, status against the restored commit is clean for what was restored.

**Isolation and concurrency.** Every command goes through the workspace's handle; leaving the workspace revokes it, cancels its jobs and refuses their results (`HandleClosed`), and the window drops a late answer (`LocalGitClosedError`) before touching any document. A restore planned for workspace A only ever touches A's folders, and checks right before changing anything that A is still the window's workspace. Checkpoints, commits and restores of a store are serialized: a second while one runs is refused (`Busy`), never queued. Reads (history, diffs, trees) go on. A second Yavin process is read-only: it can read history and diff, and cannot checkpoint, commit or restore.

**Real Git** is untouched: no `git` is run, `.git` is never snapshotted, planned, written or removed (a folder holding one is never removed), and tests prove `.git` (every file's bytes and time), Git's HEAD, index and `git status` are unchanged by checkpoints, commits, diffs and restores -- restore changes the working tree, and Git sees exactly that.

**Performance** (release, idle development machine, `cargo test -p ide-localgit --release --test history_scale -- --ignored --nocapture --test-threads=1`):

|                                                            | 10k files | 100k files | Target                                     |
| ---------------------------------------------------------- | --------- | ---------- | ------------------------------------------ |
| first checkpoint (everything stored)                       | 1.73 s    | 10.6 s     |                                            |
| checkpoint after 3 changed files (incremental, warm)       | 130 ms    | 118 ms     | < 150 ms                                   |
| commit from that checkpoint (object + HEAD move)           | 56 ms     | 47 ms      | < 100 ms                                   |
| diff of identical commits                                  | 1.3 ms    | 1.3 ms     | near zero                                  |
| diff of commits 3 files apart, with line diffs             | 6.4 ms    | 8.4 ms     |                                            |
| restore plan for 10 changed files (Full snapshot included) | 0.58 s    | 1.14 s     | proportional to changes, plus the snapshot |

History over 10,000 commits: the first page of 100 in 24.5 ms; all 10,000, in pages of 500, in 1.26 s (0.13 ms a commit, each read and re-hashed). The commit and HEAD move are dominated by the reflog's and `refs.json`'s syncs to disk.

### Staging, branches and tags (LG-04)

**Local Git staging is not the real Git index, and Local Git branch and tag operations never modify real Git.** Nothing here reads or writes `.git/index`, `.git/HEAD`, `.git/refs` or any Git configuration; tests fingerprint every file under `.git` across staging, commits, branches, tags and switches.

```text
HEAD ─(staged: HEAD↔index)─▶ Local Index ─(unstaged: index↔working)─▶ working tree ─▶ unsaved documents
 refs/heads/<branch> (or detached)   refs/yavin/index                   LG-02 snapshot     DocumentService (read only)
```

**The Local Index** is the exact tree the next commit will have. It is a ref, `refs/yavin/index`, naming a commit whose root is the staged tree: HEAD's own commit when nothing is staged (no extra object), otherwise a small deterministic _index commit_ (source `automatic`, fixed author, time and message, parent HEAD), so the same staged tree always has the same id. No index ref means the index is HEAD's tree, empty before the first commit -- which is what every LG-01..03 store already has. Being a ref, every index change is LG-01's compare-and-swap with the reflog written first: the index is the old tree or the new one, never partly written, and a commit (branch + index) or a switch (HEAD + index) moves both in one step. Its trees point at the same immutable objects as everything else; nothing is copied.

**Staging** (`index.rs`):

| Operation     | Source                                                                                                       | What changes                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stage paths   | an LG-02 snapshot (persisted, incremental when warm), unsaved documents included, LG-02's exclusions applied | the index entries at those paths: new content, a deletion (the entry removed -- never a zero-byte file), a whole directory                                    |
| stage all     | the same snapshot                                                                                            | the index becomes the workspace's tree                                                                                                                        |
| unstage paths | HEAD (nothing when unborn)                                                                                   | the index entries at those paths become HEAD's; no scan                                                                                                       |
| unstage all   | HEAD                                                                                                         | the index becomes HEAD's tree (empty when unborn)                                                                                                             |
| stage hunks   | the index-to-workspace line diff (LG-03's `line_diff`)                                                       | the file's index text with the chosen hunks applied (`diff::apply_hunks`, which numbers hunks exactly as the diff does, and keeps every byte and line ending) |

Nothing is ever written to the working tree and no document is saved: a dirty document is staged from its bytes. Paths are grafted into the index's tree; folders on the way are made, and a folder a removal empties is pruned unless the source has it as an (empty) folder. A file over the storage limit is staged as it is recorded in snapshots and commits -- hashed, its size kept, content not stored -- and reported (`unstored`); it cannot be staged in parts (`contentUnavailableForStaging`). Partial staging is refused for binary files and deletions (`partialStagingUnsupported`), and when the file's diff is no longer the one the caller saw (`staleSelection`: the caller passes the index and working blob ids of its diff). Renames need nothing special: exact-content renames are paired by the status comparison, and staging both paths stages the rename.

**Files over the storage limit (20 MiB) are staged and committed as metadata-only entries.** LG-02 snapshots and LG-03 commits already record such a file as its content hash and size, with its content not stored; staging does the same, and does not store it just to stage it. So a large file can be staged, unstaged and committed like any other -- status sees it added, modified, deleted or renamed by its hash -- but its historical content is unavailable: a diff reports it `notStored` and shows no text, and a restore or switch that would need it refuses (`historicalContentUnavailable`) rather than invent it. Staging part of such a file is refused (`contentUnavailableForStaging`). The large-file storage policy itself is unchanged.

**Status** keeps LG-02's model and adds, per path, `staged` (HEAD against the index) and `unstaged` (the index against the workspace, unsaved documents included), their counts, the index root, and `index: "head" | "staged"`. HEAD=A, index=B, working=C gives `staged A→B` and `unstaged B→C`.

**Commits come from the index** (`history::commit_index`): the commit's tree is exactly what is staged, never the working tree, and HEAD (the branch, or HEAD itself when detached) and the index move to it together. After a commit HEAD equals the index and the working tree may still differ. With nothing staged (the index is HEAD's tree, or empty before the first commit) it is refused: `NothingToCommit` -- there are no empty commits. Checkpoints still capture the workspace and never touch the index; a commit made from a checkpoint (LG-03) moves the index only if nothing was staged, so staged work is never dropped.

**HEAD** is read in exactly one place, `branches::resolve_head`: `branch` (a name and its commit), `detached` (a commit), or `unborn` (a branch with no commit yet). History, commits, status, staging, branches, tags and switching all use it.

**Branches** are `refs/heads/<name>` and **tags** `refs/tags/<name>` (lightweight: a ref to a commit). Names: 1-100 bytes of `/`-separated segments of ASCII letters, digits, `.`, `_`, `-`; a segment does not start with `.` or `-`, end with `.` or `.lock`, or hold `..`; not `HEAD`. So no spaces, control characters, backslashes or traversal, and nothing that could be read as a path -- refs live in `refs.json`, never as files. A name cannot be both a branch and a folder of branches (`a` and `a/b`), and names differing only in case are refused.

- Creating one never moves HEAD (default start: HEAD's commit; `Unborn` before the first commit); an existing name is `AlreadyExists`, never replaced -- there is no forced tag or branch.
- Deleting a branch is refused for the current one (`CurrentBranch`) and for one whose commits no other branch, tag or HEAD reaches (`NotMerged`); unreachable objects are GC's (LG-09). A missing tag is `NotFound`.
- Listing gives each branch's commit, whether it is current, `merged` (in HEAD's history; null when the walk's bound was reached), and no upstream -- Local Git has no remotes.
- A tag never moves when branches do.

**Switching** (`switch.rs`) -- to a branch, or detached at a commit -- changes only what differs between HEAD and the target; local changes, untracked files and unsaved documents elsewhere are carried over. It is refused before anything changes, listing every reason: something is staged (`stagedChangeConflict` -- the index becomes the target's tree, and staged work is never dropped), a changing path holds neither HEAD's content nor the target's (`unstagedChangeWouldBeOverwritten`, which includes an untracked file in the way), a dirty document is on a changing path (`dirtyDocumentWouldBeOverwritten`/`Deleted`), or anything the restore planner refuses. Otherwise the disk goes to _desired_ = the current disk with the changed paths set to the target's, through LG-03's restore plan and executor -- one Module 03 operation recorded by Module 04, links never followed, nothing written through a link, verified by a Full snapshot -- and only then do HEAD and the index move, together, and only if the refs are still as the plan saw them (`StaleRevision` otherwise). A crash while the disk changes leaves HEAD where it was and the operation for recovery to settle; a switch run again finds already-switched paths holding the target's content and carries on. There is no forced switch. A detached HEAD's commits advance HEAD alone; the reflog records every move.

**Known limitation: refs scale with `refs.json`.** Every ref update -- a stage, a commit, a branch or tag created or deleted, a switch -- rewrites the whole `refs.json` (LG-01's atomic replace), so its cost grows with the number of refs: about 15-20 ms with a handful, 54 ms with 10,000 branches. Reading and listing stay fast (10,000 branches listed in 8 ms). The format is unchanged in LG-04; a structure whose updates do not rewrite every ref is deferred to LG-09.

**Isolation and concurrency.** Every operation goes through the workspace's handle; the switch checks, right before changing the disk, that its workspace is still the window's. Staging, unstaging, commits, branch and tag changes, switches, checkpoints and restores of a store are serialized: a second while one runs is `Busy`. A second Yavin process is read-only. A late answer is dropped by the window before any document is touched.

**Performance** (release, idle development machine, `cargo test -p ide-localgit --release --test staging_scale -- --ignored --nocapture --test-threads=1`):

|                                                | 10k files  | 100k files | Target                          |
| ---------------------------------------------- | ---------- | ---------- | ------------------------------- |
| stage one changed file (warm, incremental)     | 141 ms     | 133 ms     | < 150 ms                        |
| stage 100 changed files                        | 284 ms     | 680 ms*    | proportional                    |
| unstage one file                               | 82 ms      | 92 ms      | < 100 ms                        |
| create a branch / a tag                        | 14 / 12 ms | 18 / 18 ms | < 50 ms                         |
| switch plan, 10 paths (Full snapshot included) | 0.86 s     | 1.46 s     | proportional, plus the snapshot |
| HEAD + index move after a switch               | 12 ms      | 16 ms      |                                 |
| first stage all (every file stored)            | 3.3 s      | 20.7 s*    |                                 |

Listing 10,001 branches: 8.1 ms; creating one more among them: 54 ms (`refs.json` is rewritten whole, so ref updates grow with the number of refs). The 10k column is after staging learned to read the engine's in-memory trees instead of the store; the 100k column (*) was measured before that change, which only affects staging whole folders or many paths, so those two figures are pessimistic. A later run while other programs saturated the machine (a disk scanner, a game client) was several times slower and is not used.

**Load-sensitive tests (existing, unchanged).** Four tests from earlier modules bound real process timings, and failed during LG-04 validation only while other programs held the CPU at 100% (the whole `ide-workspace` suite then took 90.8 s instead of 6.9 s). On the otherwise idle machine they passed 10 of 10 alone and in three full-suite runs, far inside their bounds, which are correctness bounds and are kept:

| Test                                                                                | Bound                                           | Idle        |
| ----------------------------------------------------------------------------------- | ----------------------------------------------- | ----------- |
| `lsp_process::a_real_server_process_exchanges_framed_messages_and_reports_its_exit` | a language server answers within 10 s           | 0.19-0.28 s |
| `lsp_process::stopping_a_server_ends_it_and_a_broken_stream_ends_the_session`       | its exit is reported within 10 s                | 0.71-0.84 s |
| `process::a_genuinely_running_process_is_actually_killed_on_cancellation`           | a cancelled process is stopped within 5 s       | 0.36-0.41 s |
| `git::a_git_operation_cancelled_through_the_real_job_registry_is_actually_stopped`  | a cancelled Git operation is stopped within 5 s | 1.04-1.44 s |

### Reset, revert and stash (LG-05)

**Reset never silently destroys user changes. Stash is not a real Git stash and never touches `.git`. Revert creates new Local Git history; it never rewrites existing commits.** Nothing here runs `git` or reads its index, configuration, stash or refs; a real-Git test fingerprints `.git` across every operation below.

Every operation that changes the disk -- a hard reset, cleaning after a stash, applying a stash -- goes through one path (`transition.rs`): the current disk with a set of paths changed, planned by LG-03's restore planner, carried out by its executor as one Module 03 operation recorded by Module 04 (links never followed, nothing written through one), verified by a Full snapshot, and only then the refs moved. There is no second restore engine. Documents are reconciled afterwards through DocumentService's public API (the same `reconcileRestore` as restore and switch). Every mutation holds the store's mutation lock (`Busy` for a second one); a second Yavin process is read-only; a late answer from a workspace left is refused and dropped before any document is touched.

**Reset** (`reset.rs`) moves HEAD -- its branch, or HEAD itself when detached -- to a target (a commit, a branch's commit, or a tag's; no revision syntax).

| Mode  | HEAD   | Index                                                                      | Working tree                                | Disk changes  |
| ----- | ------ | -------------------------------------------------------------------------- | ------------------------------------------- | ------------- |
| soft  | target | unchanged (made explicit, since an index without its own ref follows HEAD) | unchanged                                   | none          |
| mixed | target | target's tree                                                              | unchanged (its differences become unstaged) | none          |
| hard  | target | target's tree                                                              | target's tree                               | yes, verified |

Soft and mixed are one atomic ref update each. A hard reset is planned from a Full snapshot and refused, with every conflict before anything changes, when it would destroy staged changes (`stagedChangeConflict`), local changes to tracked files or an untracked file where the target has one (`unstagedChangeWouldBeOverwritten`), or unsaved documents (`dirtyDocumentWouldBeOverwritten`/`Deleted`) -- unless the caller passes `allowDestructive`, the explicit, typed choice to lose exactly those. Untracked files the target does not have are never touched. A reset never stashes or checkpoints anything on its own. Every move is in the reflog (op `reset`, old and new values, time; the store is the workspace's); a crash leaves the old refs or the new ones, and a crash while a hard reset changes the disk leaves HEAD where it was and the operation for recovery to settle.

**Revert** (`revert.rs`) undoes commit T (against its first parent P; the empty state for a root commit) with a new commit on top of HEAD whose tree is HEAD's with every path T changed set back to P's entry. It works on the Local Index: nothing may be staged, the new commit is made from the result, and HEAD and the index move together in one step. The working tree is not touched -- its files keep what they had, so the undone difference shows as unstaged until restored. There is no merging (LG-06): a path is reverted only when HEAD still has exactly what T left there. Refused, with every reason, before anything changes: `stagedChangesPresent`, `changedSince` (a later commit changed the path; `binary` says whether it is a binary file), `workingTreeChanged`, `dirtyDocument`, and `historicalContentUnavailable` (P's content was never stored -- never reconstructed from disk or real Git). Its message defaults to `Revert "<summary>"` and a line naming T; a custom one is validated like any commit message.

**Stash** (`stash.rs`) is one commit object (source `automatic`) under its own ref, `refs/yavin/stash/<id>` (ids sort by time) -- never on a branch's history. Its root is the working tree as it was, unsaved documents included; `metaobj index` is the index's root; its parent is the base (HEAD when made); `meta` records the branch, whether untracked files are in it, and how many staged, unstaged and untracked paths it holds. Staged (base -> index) and unstaged (index -> working tree) changes are kept apart and come back apart: HEAD=A, index=B, working=C stashes and returns to exactly index B and working C. Untracked files are included only with `includeUntracked` (default off: they stay where they are); excluded paths, `.git` and proposed documents never are. Nothing is copied: the stash is made of the same objects as everything else.

- **Push**: plan from a Full snapshot (`NothingToStash` when there is nothing), then the stash's commit and ref, durably -- and only then is the workspace cleaned: the stashed paths back to HEAD's content (documents on them lose their unsaved text, which is in the stash), verified, and the index set to HEAD. If the stash cannot be made durable, nothing in the workspace changes; if the executor's last checks refuse the cleaning (nothing was touched), the stash is removed again; if cleaning fails partway, the stash stays -- it holds everything that was there.
- **Apply** puts the staged changes back into the index and the working tree's on disk. Refused, with every conflict before anything changes, when something is staged, when HEAD no longer has at a stashed path what the stash was made on (`stashBaseChanged` -- that would need a merge), when a stashed path holds local changes or an unsaved document, or when an untracked file it brings back is in the way (`untrackedFileCollision`). The stash is never modified.
- **Pop** is apply, and the stash's ref is removed in the same atomic step that sets the index -- after the disk was verified. A pop that fails, or crashes, leaves the stash.
- **List** is newest first, from the refs and the listed stashes' commits only (never the workspace), with the total. **Drop** removes the ref; objects stay for LG-09's GC.

Branch switching never stashes on its own: the workflow is explicit -- stash, switch, work, switch back, pop.

**Large files**: files over the storage limit are in a stash, a reset or a revert as they are everywhere -- hash and size only. A hard reset, a stash cleaning or an apply that would need their content refuses (`historicalContentUnavailable`, or `currentContentNotStored` when a large file would be replaced); a revert that would need it refuses the same way.

**Performance** (release, 10,000 files, `cargo test -p ide-localgit --release --test lg05_scale -- --ignored --nocapture --test-threads=1`): soft reset 12.7 ms, mixed reset 12.3 ms (targets 50 and 100 ms); revert of a 10-path commit 596 ms and a 10-path stash plan 671 ms, both including the Full snapshot they need; recording a stash 38.5 ms; listing 100 of 10,000 stashes 40.5 ms (target 50 ms); dropping one of 10,000 60.6 ms -- over the 50 ms target because every ref update rewrites the whole `refs.json` (the known limitation above, deferred to LG-09).

**Not yet** (later phases): merge and cherry-pick (LG-06, below; rebase is not planned); AI checkpoints and Undo AI Run (LG-07); any UI (LG-08); comparison with real Git, GC, compaction, compression, a recovery UI, and ref storage whose updates do not rewrite every ref (LG-09).

### Merge and cherry-pick (LG-06)

**A merge never overwrites what it cannot account for, and never completes by itself. Conflicts are explicit, durable records -- never inferred from a file's content -- and are resolved only by an explicit choice.** Nothing here runs `git` or reads `.git`; a real-Git test fingerprints `.git`, the real index, HEAD, branches and `git status` across a conflicted merge, its resolution and continue, a cherry-pick and an abort. Rebase is not part of Local Git.

**Merge** (`merge.rs`) of a target T (a commit, a branch's commit or a tag's) into HEAD H:

| Case                                             | Result                                                                                                                                                     |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T is H or an ancestor of it                      | _up to date_: no disk, index, ref or reflog change at all                                                                                                  |
| H is an ancestor of T, or there is no commit yet | _fast-forward_: the disk goes to T on the paths that differ, then HEAD (its branch, or HEAD itself when detached) and the index move to T; no merge commit |
| otherwise                                        | a _three-way merge_ of BASE, OURS (H) and THEIRS (T): conflict-free, a merge commit with parents H then T; with conflicts, stopped for resolution          |
| no common ancestor                               | refused (`UnrelatedHistories`)                                                                                                                             |

The **merge base** is the best common ancestor: the common ancestors nearest to T that no other common ancestor reaches. With several (criss-cross histories) the one nearest to T is used and the plan says how many others there were (`otherBases`); there is no recursive merge of bases.

**The tree merge** goes folder by folder, and down a tree only where both sides changed something -- equal subtrees are taken whole, so a merge costs what differs, not what exists. For each path: equal sides are taken; a side equal to BASE takes the other; otherwise both changed it:

| Both sides                                                                          | Result                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| text files                                                                          | line-merged on LG-03's Myers diff (`merge3.rs`): changes that overlap or touch (no unchanged base line between) conflict, others combine; the same change on both sides is taken once. Conflicting: `modifyModify`, or `addAdd` with no base; the working file gets `<<<<<<< HEAD (<branch>)` / `=======` / `>>>>>>> <target>` markers in ours' line ending |
| binary (a NUL in the first 8 KiB, or not UTF-8), not stored, missing, or over 8 MiB | a conflict with no markers (`binary`, or `unavailable`: `notStored`, `missing`, `tooLarge`); the working file keeps ours                                                                                                                                                                                                                                    |
| ours deleted, theirs changed                                                        | `deleteModify`: the working tree gets theirs, to look at                                                                                                                                                                                                                                                                                                    |
| ours changed, theirs deleted                                                        | `modifyDelete`: ours is kept                                                                                                                                                                                                                                                                                                                                |
| a folder against a file or link                                                     | `directoryFile`: ours kept                                                                                                                                                                                                                                                                                                                                  |
| a file against a link                                                               | `typeChange`: ours kept                                                                                                                                                                                                                                                                                                                                     |
| both folders (or one deleted)                                                       | merged inside, path by path                                                                                                                                                                                                                                                                                                                                 |

Executable bits merge three-way. An **exact rename** on one side (LG-02's rename pairing: the same content at a new path) with a change on the other side carries the change to the new path; other rename combinations are merged path by path (a file renamed to two different names on the two sides ends up under both -- nothing is lost, and it is not reported as a conflict).

**Cherry-pick** of commit C is the same merge with BASE = C's parent (the empty state for a root commit), OURS = HEAD and THEIRS = C: C's change, applied to HEAD. Conflict-free, it makes a _new_ commit on HEAD -- never C itself -- with C's message plus `(cherry picked from Local Git commit <id>)`, C's author, the picker's time, and `meta cherry-pick <C>` and `committer`. C is never changed. A merge commit is refused (`CherryPickMerge`); a change already in HEAD is `NothingToCommit`. One commit at a time: there is no sequence of picks (`OperationRequest` is where one would be added).

**Safety** is LG-04's switch's and LG-05's, checked from a Full, persisted snapshot with the unsaved documents, before anything changes -- every reason at once, as `RestoreConflict`s:

- anything staged (`stagedChangeConflict`);
- a path the merge changes on disk holding neither HEAD's entry nor the result: a local change (`unstagedChangeWouldBeOverwritten`) or an untracked file in the way (`untrackedFileCollision`);
- a document with unsaved changes on such a path (`dirtyDocumentWouldBeOverwritten`/`Deleted`) -- never saved, never replaced;
- two names in one folder of the result that differ only in letter case, on a case-insensitive disk (`caseOnlyRename`);
- everything the restore planner refuses: content that was never stored (`historicalContentUnavailable`), unreadable paths, a large file that would be replaced, and, at the last moment, the executor's own checks (links on the way, a disk changed since the plan).

Unrelated local work -- other changed files, untracked files, unsaved documents elsewhere -- is carried over untouched.

**The operation's state** (`operation.rs`) is durable: an object (a commit with source `automatic`, on no branch) whose `metaobj state` blob is the `OperationState` as JSON (versioned; a newer version is refused, never guessed at), and whose other `metaobj`s name every commit and root it refers to, so they stay reachable. The ref `refs/yavin/operation` names it. It records the kind (merge or cherry-pick), the phase, the branch and commit HEAD was at, THEIRS and BASE, the index ref and disk root before, the index and working-tree roots of the result, the commit to finish with (when conflict-free), the message, every **touched** path (what it held before, and everything the operation wrote there since), and every **conflict**: path, kind, base/ours/theirs entries, markers/binary/unavailable, and its **resolution** -- `unresolved`, `takeOurs`, `takeTheirs`, `deleted`, `manual` or `resolved` -- with the entry it resolved to. Every change of the state moves that ref in the same compare-and-swap as what changes with it.

```text
plan (Full snapshot) --refused--> nothing changed
  | begin: state recorded, phase applying            (ref step)
  v
disk changed: one Module 03 operation, Module 04 intent, verified
  |-- executor refused before touching anything --> state withdrawn
  |-- stopped partway / not verified --> state stays: applying (continue or abort)
  v
finish_apply (one ref step)
  |-- conflict-free: HEAD (branch, or detached HEAD) + index + state removed  -> done
  '-- conflicts: index = clean results + ours at conflicted paths, state phase conflicts
        |
   resolve (each: state records what it will write -> disk -> index + resolution, one step)
        |
   continue: all resolved, index holds every resolution, content present and free of
             markers -> commit from the index; HEAD + index + state removed, one step
   abort:    touched paths back to what they held -> verified -> index back + state
             removed, one step; HEAD never moved
```

**The index** during conflicts is LG-04's one index: every clean result staged, and ours at each conflicted path until it is resolved. The state -- not the index, not the file -- says what is unresolved; writing or saving a file resolves nothing. While an operation is in progress, HEAD and the index change only through it: commits, staging and unstaging, switching, resets, reverts, stash push and apply, and another merge or cherry-pick are refused (`OperationInProgress`); checkpoints and file restores, which move neither, are not.

**Resolving** (one conflict at a time; re-resolving is allowed until continue):

- `takeOurs`, `takeTheirs`, `delete` set the index **and the file on disk** (through the restore machinery, recorded first). Refused, untouched, when the file holds something the operation did not write there -- the user's edits -- or a document on it has unsaved changes, unless `policy` is `allowDestructive` (the explicit choice; unsaved documents are then replaced through DocumentService).
- `manual` stages the document's current text -- unsaved changes included, the disk untouched -- and `markResolved` the file as it is on disk (refused with `UnsavedDocument` while a document on it has unsaved changes, which would be left out). Both are refused while the content still holds conflict markers (`ConflictMarkers`) or is not stored.

**Continue** requires the state, every conflict resolved (`UnresolvedConflicts`), HEAD still where the operation began, the index holding every resolution, and every resolution's content present. It makes the merge commit (parents HEAD then THEIRS; the default message `Merge branch '<name>'`, or the caller's) or the cherry-pick's commit from the index, and moves HEAD, clears the index ref and removes the state in one step: until that step, the state stays, and continue can be retried. Continue after a stop while the disk was changing (phase `applying`) first takes the disk the rest of the way -- each touched path must hold what it held before or what the operation wrote, never anything else -- and then finishes as it would have.

**Abort** takes every touched path back to what it held before (each must hold that, or something the operation wrote; otherwise it is refused unless `allowDestructive`), verifies the disk, then sets the index back to what it was and removes the state in one step. It never creates a commit or moves HEAD, and never touches anything the operation did not.

**Crashes.** A crash before the state is recorded changes nothing. After it -- before the disk changes, partway through (Module 04 settles the file operation as completed, not applied, or partial -- never replayed), or after the disk changed but before the refs moved -- the store reopens with the operation in phase `applying` and HEAD where it was: nothing completes by itself, and continue or abort settles it, each accepting any mix of before and after on the touched paths. The ref steps themselves are LG-01's: old or new, never half. A crash during an abort's disk change leaves the state; aborting again finishes it. Tested at every boundary for merge and cherry-pick, both continued and aborted.

**Documents.** Merges read unsaved documents (they refuse over them) and never write them; the disk changes are reconciled afterwards through DocumentService's public API (`reconcileRestore`), as for restore, switch and reset -- conflict files written into open, clean documents reload them. A document is replaced only on the explicit `allowDestructive` of a resolve or an abort.

**Workspaces and processes.** Each step holds the store's mutation lock (`Busy` for a second); a second Yavin process has the store read-only and cannot record, resolve, continue or abort (`ReadOnly`, before anything changes). A step checks, right before the disk changes, that its handle is still open and its workspace still the window's (`NotInWorkspace`, `HandleClosed`): a merge planned in workspace A is refused once B is open, never touches B, and A's old handle stays refused when A is opened again as a new generation.

**API** (native commands, typed in `services/localgit/types.ts`, on the service for LG-08's UI): `localgit_merge` (target, message, dry run), `localgit_cherry_pick` (commit, dry run), `localgit_operation` (the state, with every conflict), `localgit_resolve` (path, resolution, policy), `localgit_continue` (message), `localgit_abort` (policy). Each answers an `OperationResult`: status (`planned`, `refused`, `completed`, `failed`, `verificationFailed`), outcome (`upToDate`, `fastForward`, `merged`, `conflicted`, `resolved`, `continued`, `aborted`), the plan (clean paths, conflicts, safety refusals), the disk change for the documents, the commit made, the state still in progress, and HEAD.

**Performance**: (release, `cargo test -p ide-localgit --release --test lg06_scale -- --ignored --nocapture --test-threads=1`; every plan includes the Full snapshot it needs, and 10 paths change on each side) 10,000 files: fast-forward plan 541 ms; clean merge plan 495 ms, record and finish 69 ms; a 10-conflict merge plan 492 ms, record and finish 98 ms; abort plan 433 ms, finish 21 ms; one resolve (snapshot included) 590 ms; continue 65 ms; cherry-pick plan 484 ms, record and finish 64 ms; peak working set 28.5 MB. 100,000 files: fast-forward plan 1.14 s; clean merge plan 1.04 s, record and finish 50 ms; conflicted merge plan 1.08 s, record and finish 77 ms; abort plan 1.04 s, finish 12 ms; one resolve 1.18 s; continue 58 ms; cherry-pick plan 949 ms, record and finish 57 ms; peak working set 89.9 MB. The tree merge itself costs what differs; the snapshot dominates. Each resolve takes a Full snapshot of its own.

**Known limitations**: one merge base when there are several (no recursive merge); rename detection is exact-content only, and rename/rename to two names is not reported as a conflict; no line merge for binary or non-UTF-8 text or files over 8 MiB (a conflict instead); no `ours`/`theirs` strategies or whitespace options; cherry-pick is one commit at a time and refuses merge commits; no rebase. `refs.json` is rewritten on every ref step (LG-01's layout; LG-09).

**Not yet** (later phases): AI checkpoints and Undo AI Run (LG-07, below); any UI (LG-08); comparison with real Git, GC, compaction, compression, a recovery UI, and ref storage whose updates do not rewrite every ref (LG-09).

### AI runs: checkpoints, provenance and Undo AI Run (LG-07)

**An AI never commits a human's work, and undoing an AI run never takes a human's work with it. Ownership is recorded, never guessed: whenever it cannot be shown, Local Git refuses.**

**Who owns what.** There is no AI Run Manager or ChangeSet module in Yavin yet (ChangeSets are Module 13). LG-07 is the Local Git side only, behind a contract those modules will use:

| Owner                  | Owns                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI run layer (to come) | running the AI, its tools and cancellation; the run's id; telling Local Git what happened (started, the AI changed these paths, validated, failed, cancelled) |
| ChangeSet (Module 13)  | the proposed changes and their review; its id and revision                                                                                                    |
| DocumentService        | document content, dirty state, open and proposed documents                                                                                                    |
| Local Git (`ai.rs`)    | the checkpoint, the run's provenance record, the attribution of changes, the AI commit, Undo AI Run                                                           |
| Module 03 / Module 04  | the undo's file operation, and its recovery                                                                                                                   |

Local Git stores **references**: the run's, task's and ChangeSet's ids (opaque strings, never interpreted), a ChangeSet revision, a model id only when the caller gives one -- never a copy of a ChangeSet, never an inferred provider.

**The record.** One per run, under `refs/yavin/ai/r<hash of the run id>`: a commit (source `automatic`, on no branch) whose `metaobj run` blob is the `AiRunRecord` as versioned JSON, and whose `metaobj checkpoint` and `metaobj commit` keep those reachable. It holds the run, task and ChangeSet ids, the workspace, the checkpoint, HEAD and its branch and the index's root at the checkpoint, the reason, start and end times, the status, the validation (passed, and the caller's reference), a note, the **AI changes** (each path with its entry at the checkpoint and after the AI), the **unattributed** paths (changed since the checkpoint, not by the AI), the AI commit, and an undo under way. Every change is one compare-and-swap of the refs -- together with HEAD and the index, for an AI commit or the undo of one.

**Lifecycle**, as the AI layer reports it -- Local Git never decides one:

```text
checkpoint -> checkpointed -> started -> running -> (changes recorded) -> changesDetected
   -> validated -> committed            failed / cancelled (from any of the active states)
   any state with changes -> undone
```

More changes after validation return the run to `changesDetected` and clear the validation. A run that was checkpointed or running and that no process in this Yavin started -- after a restart, or a crash -- is reported `interrupted`: never "succeeded", never rolled back, its changes left for the user.

**AI checkpoint.** Before the AI's first change, from a Full, persisted snapshot with the window's unsaved documents: a commit with source `ai` whose root is the workspace as the user has it, disk root the disk, `metaobj overlays` the unsaved documents, `metaobj index` the index's root, HEAD its parent, and `meta` the run, task, ChangeSet, reason and (if given) model -- and the run's record, in one ref step. HEAD, branches, the index and `refs/yavin/checkpoint` never move. It is LG-03's checkpoint object with the AI's provenance, from LG-02's snapshot engine; there is no other snapshot mechanism. If it cannot be made durable -- a read-only store, a workspace left, a full disk -- the call fails and the AI must not begin. A run id is checkpointed once.

**Attribution.** The AI owns exactly the paths the AI layer reports it changed (files or links; a folder is reported as its files). Each is recorded with its entry at the checkpoint (`before`; a path reported again keeps it) and as a fresh Full snapshot sees it (`after`). The caller may say what the AI wrote (a blob, or "deleted"): a workspace holding anything else is `AttributionAmbiguous`, and nothing is recorded. Everything else changed since the checkpoint is listed as unattributed. So a human's change before the run (in the checkpoint), during it on another path (unattributed), or after it on an AI path (`after` no longer matches) is never taken for the AI's.

**AI commit.** A commit on HEAD (source `ai`; `meta` the run, task, ChangeSet and its revision, checkpoint, validation and its reference, model only when given; `metaobj checkpoint`; message `AI: <reason>` or the caller's) whose tree is **HEAD's tree with only the AI's paths set to `after`** -- never the working tree, never the index. Refused with every reason (`AiRefusal`), nothing changed, when:

| Refusal                  | When                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `headMoved`              | HEAD is not where it was at the checkpoint (no silent rebase)                                                        |
| `staleChangeSet`         | the ChangeSet revision given is not the one recorded                                                                 |
| `humanChangedAiPath`     | the workspace no longer holds the AI's content at an AI path                                                         |
| `preexistingHumanChange` | at the checkpoint an AI path already held a human's change: committing the AI's content would commit the human's too |
| `stagedOnAiPath`         | something is staged at an AI path                                                                                    |
| `operationInProgress`    | a merge or cherry-pick is in progress                                                                                |
| `nothingToCommit`        | the AI changed nothing HEAD does not have                                                                            |

**The index** is preserved: it keeps every other entry -- a human's staged work stays staged -- and takes the commit's entries at the AI's paths; HEAD, the index and the record move in one step. Unstaged and untracked work and unsaved documents are untouched: the AI commit changes no file. A run is committed once; a crash leaves the commit made and recorded, or neither.

**Undo AI Run** takes out exactly the AI's changes -- never a reset to the checkpoint. Per AI path, from a Full snapshot with the unsaved documents:

| The path now holds                                                                             | Undo                                                                                                                                       |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| its checkpoint content (or what an interrupted undo wrote)                                     | nothing                                                                                                                                    |
| the AI's content                                                                               | back to the checkpoint content (an AI-created file removed, an AI-deleted one restored)                                                    |
| a human's later edit, all three text                                                           | the three-way inverse (`merge3`, base = the AI's content): the human's edit kept, the AI's taken out -- or `undoConflict` where they touch |
| anything else (a human edited a file the AI created, recreated one it deleted, binary content) | `humanChangedAiPath`: refused                                                                                                              |
| an unsaved document whose text is not the AI's                                                 | `dirtyDocument`: refused -- never overwritten or saved                                                                                     |
| an unsaved document holding exactly the AI's text                                              | replaced through DocumentService (it is the AI's, not the user's)                                                                          |

The disk changes through LG-03's restore machinery: planned (`transition.rs`; content never stored refuses as `historicalContentUnavailable`), the targets recorded in the run's record, carried out as one Module 03 operation recorded by Module 04, verified, and only then the run marked undone. Documents are reconciled through DocumentService's public API afterwards. Paths the AI did not change -- every human change elsewhere, staged or not -- are never touched, and the index is not changed for an uncommitted run. Undoing a **committed** run also moves HEAD back to the commit's parent (the AI's paths in the index with it, everything else staged kept), only while HEAD is still that commit (`historyMovedOn` otherwise: history moved on, and a revert is the way); the commit stays in the record. Cancelled, failed, partial and interrupted runs undo the same way -- after a restart too.

**Crashes.** A checkpoint is there, durably with its record, or not at all. A crash during the AI's changes leaves the checkpoint, the record (running), and the partial changes, visible -- none rolled back. An AI commit is made with its record, or neither: committing again after a crash makes exactly one. An undo interrupted partway (Module 04 settles the file operation) leaves the run not undone, with its targets recorded; undoing again accepts any mix of before, AI and target on each path and finishes it. Ref steps are LG-01's: old or new, never completed by themselves.

**Workspaces and processes.** Every step that changes Local Git state for a run checks its handle is open and its workspace still the window's (`NotInWorkspace`, `HandleClosed`): a run's late steps after a switch never reach the next workspace, a run belongs to the workspace (and store) it was checkpointed in, and another workspace does not know it. Each step holds the store's mutation lock (`Busy`); a second Yavin process has the store read-only and cannot checkpoint (so its AI must not begin), record or undo.

**API** (native commands, typed in `services/localgit/types.ts`, on the service as `localGit.ai`): `localgit_ai_checkpoint`, `localgit_ai_run`, `localgit_ai_runs` (the AI history: newest first, each run with its task, checkpoint, ChangeSet, commit, status, validation, `interrupted` and `undoAvailable`), `localgit_ai_report` (`started`, `validated`, `failed`, `cancelled`), `localgit_ai_associate`, `localgit_ai_record_changes`, `localgit_ai_commit`, `localgit_ai_undo` (with a dry run). Paths are folder-relative and named by folder id, never absolute.

**Performance**: (release, `cargo test -p ide-localgit --release --test lg07_scale -- --ignored --nocapture --test-threads=1`; 10 AI-changed paths) 10,000 files: AI checkpoint 484 ms (its Full snapshot; +1.7 KiB stored when the workspace's content is already in the store -- objects are shared, a checkpoint adds its commit and record); ChangeSet association 38 ms; recording the AI's paths 627 ms (Full snapshot); AI commit 493 ms; undo plan 458 ms, finish 35 ms; the AI history of 1,000 runs (50 listed) 259 ms, one run 0.3 ms; peak working set 24.8 MB. 100,000 files: checkpoint 1.09 s, association 36 ms, recording 1.08 s, AI commit 1.12 s, undo plan 1.12 s, finish 45 ms, history 270 ms; peak working set 85.1 MB. Metadata steps (lifecycle, association, history) never scan the workspace.

**Known limitations**: attribution is only as good as what the AI layer reports (a path the AI changed and did not report is unattributed, and neither committed nor undone); recording changes, committing and undoing each take a Full snapshot; the three-way inverse is for text up to 8 MiB; an AI commit is refused, never rebased, when HEAD moved; undo of a committed run requires HEAD to still be its commit; the AI history reads every run record (fine for thousands; LG-09 may index it).

**Not yet** (later phases): any UI (LG-08); comparison with real Git, GC and retention (including of AI checkpoints and records), compaction, compression, a recovery UI, and ref storage whose updates do not rewrite every ref (LG-09).

### Local History UI (LG-08)

**Local History presents Local Git; it owns nothing.** Every fact on screen comes from the workspace's Local Git service (`services/localgit/service.ts`, over the `localgit_*` commands) as the service gives it, and every change goes through it -- which plans it, refuses it with its reasons, carries it out, verifies it and reconciles the documents. The panel orders no history, computes no diff, judges no safety and attributes no AI change.

```text
LocalHistoryPanel (components/localgit)          presentation.ts (pure labels, no decisions)
   │  head · history(cursor) · readCommit · diffCommits · diffWorkspace · restore(dryRun)
   │  branches · tags · operation · ai.history · ai.undo(dryRun) · stashList · continue/abort
   v
LocalGit service (one per workspace, its generation's handle) ──> localgit_* ──> ide-localgit
                                                         restore/undo ──> M03/M04 executor
   after a disk change: DocumentService reconcile (service) · Explorer/Source Control refresh (window)
```

**Where it lives.** An activity-bar entry, _Local History_, beside Source Control (which shows real Git and is unchanged). The window mounts the panel with the workspace's service, keyed by the workspace (the only `App.tsx` change), so a workspace switch unmounts it with everything it held.

**History.** The current HEAD (branch, detached, or no commit yet) and the history as Local Git orders it (newest first along first parents), a page of 100 at a time through the service's cursor -- the next page loads when the list is scrolled to its end, or on _Load older entries_; a history that ends early at an unreadable commit says so. The list is windowed: only the rows in view (and a few around) are in the DOM, however many are loaded. Each row shows the entry's kind, short id, summary, author, time, and the branches and tags at it. The kind comes from what is recorded -- `source` (`ai`, `checkpoint`, `recovery`, `automatic`) and the number of parents (a merge) -- never from a message or an id's shape. The filter narrows the loaded entries by message, id prefix, author or kind; it never scans the repository.

**Entry details** (`localgit_read_commit`): message, full id, refs, author and source, date, parents (each opens), and the provenance its metadata records -- cherry-picked from, merged, and for AI work the agent run, task, ChangeSet and revision, AI checkpoint, validation and model -- each only if present, and ids shown as the opaque strings they are. Changed files come from the backend's diff (added, modified, deleted, renamed with both paths, type changed; unavailable and binary marked), against the entry's parent or against the workspace.

**Diffs** open in the existing diff view in the editor area, read-only (no staging: it is not real Git): Local Git's own hunks, written as the unified text that view reads. Content Local Git does not have is never replaced by the file on disk: _"Historical content unavailable: the file was over Local Git's storage limit"_, a missing object, binary content, a file changed on disk since the snapshot, too large or over the diff budget -- each says so above the diff.

**Restore** (a whole entry, or one file) always shows the backend's dry-run plan first: files changed, added and deleted, documents whose unsaved changes would be discarded, and every refusal as the backend gives it (unsaved documents, local changes, untracked files in the way, blocked paths, content not stored, case-only renames, …) -- a refused plan cannot be confirmed. Only _Restore_ in the confirmation runs it (`refuseIfDirty`; Local Git takes a checkpoint first); the outcome is shown as reported, and the window refreshes the Explorer and Source Control.

**AI runs** (LG-07's records): status as recorded -- a run left checkpointed or running by a process that ended is _Interrupted_, never shown as done -- agent run, task, ChangeSet and revision, model (only if given), validation, note, the checkpoint and the AI commit (each opens in History), the AI's changes and the changes that were not the AI's. **Undo AI Run** is offered only when the backend says it is available; it shows the backend's dry run (what is taken out, whose later edits are kept, whether HEAD moves back for a committed run, and every refusal -- a person's edit on an AI file, overlapping edits, unsaved text, history moved on, a merge in progress, content not stored) and runs only on confirmation.

**Stashes** (LG-05): message, branch, base, time and the staged, unstaged and untracked counts. **A merge or cherry-pick in progress** (LG-06) is shown above the views with its conflicts and their resolutions; _Continue_ waits for every conflict, _Abort_ asks the backend.

**Errors** are shown by meaning, with the native message under _Details_: `Busy`, `ReadOnly` (the panel is marked read-only and offers no change), the workspace changed, an operation in progress, recovery required, damaged or missing objects, `NotFound`, and any other code by name. Empty states: no history yet, no AI runs, no stashes, no changes, no folder open.

**Workspaces.** The panel holds the service of the workspace it was mounted for; switching workspaces unmounts it, and every answer of an earlier one is dropped -- by the service (a closed workspace's results are refused) and by the panel's own generation check. Nothing of workspace A is ever shown in B.

**Keyboard and accessibility**: the history is a listbox (arrow keys move the selection, which opens its details); views are tabs; confirmations are modal dialogs that keep focus inside and close on Escape, returning focus; every control has a label, and kinds and states are written out, never shown by colour alone.

**A fix found by integration.** The Local Git service checked that its workspace was active before opening -- but `WorkspaceManager` makes a workspace's services _before_ marking it active, so in the window the service never opened. It now opens at once and checks the workspace when the answer arrives (a store opened for a workspace already gone is handed straight back, as before); a test makes the service in the manager's own order.

**Performance** (UI test with a scripted backend of 10,000 entries): first rows 30 ms after a refresh; nine more pages (1,000 entries loaded) 832 ms; 29 rows in the DOM; entry details 136 ms; a diff 140 ms.

**Known limitations**: the filter covers loaded entries only (the backend has no search); conflicts are shown but resolved through the API, not yet in this panel; stashes, branches and tags are shown, not managed here (Source Control and the API do that); a diff of one file asks the backend for the entry's whole diff; the panel's own test covers a workspace's results being dropped through the service, not a full A → B → A switch in the window.

**Not yet**: a UI for comparison, promotion and GC (LG-09 provides the backend, below).

### Real Git comparison, promotion, garbage collection and integrity (LG-09)

**Local Git and real Git stay separate systems, joined only by an explicit, read-mostly bridge.** Real Git owns `.git`, its index, branches, commits and remotes; Local Git owns its store. Nothing in `ide-localgit` runs a process or touches `.git` -- its source-scan test still holds. Real Git is read by the app, through its one hardened Git runner (`git::run_read_only`, with `GIT_OPTIONAL_LOCKS=0` so even `status` never refreshes the index), with five read-only commands: `rev-parse`, `symbolic-ref`, `ls-tree`, `ls-files`, `status`. Local Git never stages, commits, pushes, resets, checks out or changes a branch in real Git.

**Comparison** (`compare.rs`, `localgit_compare_git`) is by content. The two histories are separate object spaces (Local Git: SHA-256 over its own format; real Git: SHA-1 over its own), so ids are never matched: a Local commit's tree is compared with real Git's HEAD path by path. Exactly: Local content that the working tree holds unchanged, where real Git reports the path clean, is HEAD's without reading anything; otherwise the Local content's real Git blob id is computed (`gitblob.rs`, a SHA-1 checked against the standard vectors and `git hash-object`) and compared with the id real Git reports, mode included. Never timestamps.

| State                   | Meaning                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `same`                  | the same content and mode                                                                                   |
| `different`             | in both, with different content or mode                                                                     |
| `localOnly` / `gitOnly` | in one of them only                                                                                         |
| `unavailable`           | Local Git never stored the content (over the storage limit), so it cannot be decided -- never assumed equal |
| `notInLocalGit`         | real Git tracks it, Local Git's rules leave it out (`node_modules`, `.env`, `.yavinignore`)                 |

Each path also carries real Git's status there (clean, staged, modified, untracked, not tracked) and whether the working tree holds the Local content. The result names both HEADs and branches, says whether the trees are identical, and lists each side's staged paths. A workspace folder inside a repository compares only its own paths; a folder in no repository says so; no Local history makes everything `gitOnly`.

**Promotion** (`promote.rs`, `localgit_promote`) brings a Local commit's content into the working tree real Git works in -- the bridge in one direction, explicitly. It writes the working tree only, and only what differs from real Git's HEAD (create, modify, delete; paths Local Git leaves out are never touched), through LG-03's restore machinery: planned completely, refused with every reason before anything changes, carried out as one Module 03 operation recorded by Module 04 after a Local Git recovery checkpoint of the workspace, and verified. The result is ordinary working-tree changes for the user to review, stage and commit in Source Control: Local Git never stages, commits or pushes. Refused:

- where real Git reports the path staged or modified (`realGitChanged`, saying which) -- the user's work there is never overwritten;
- where an untracked or ignored file is in the way (`untrackedFileCollision`);
- where a document with unsaved changes would be overwritten; where Local Git never stored the content (`historicalContentUnavailable`); and everything else the restore planner refuses;
- when real Git changed since the plan: the plan records a fingerprint of real Git's state (HEAD, branch, the index's entries, status) and the app reads it again right before writing -- any difference refuses (`StaleRevision`), compare-and-apply.

A promotion interrupted partway is Module 04's to settle on the next start (never replayed or undone by guessing); the recovery checkpoint holds the working tree as it was, restorable from Local History; real Git's HEAD and index are untouched throughout.

**Garbage collection** (`gc.rs`, `localgit_gc_*`). _Roots_: every ref -- branches, tags, the index, the checkpoint ref, the merge or cherry-pick in progress, stashes, AI run records, and any ref kind added later, since all of `refs.json` is read -- a detached HEAD, and the objects the reflog names unless retention expires them. _Reachability_ follows commits to their roots, disk roots, parents and every `metaobj` (index roots, overlay sets, AI checkpoints and commits, operation states), roots to trees, trees to trees and blobs (files never stored are not looked for), over hash sets, once per object. An object reachable from a ref and absent is corruption: GC refuses to run. One reachable only from the reflog may be gone (expired history), which is not.

_Collection never deletes_:

```text
plan (reads only)  ->  run: refs revision and reflog unchanged, no unresolved GC, nothing missing
  journal "copying"   ->  every live object of each segment with garbage copied into one new segment
  journal "retiring"  ->  those old segments moved to quarantine/gc-<id>/, the store re-indexed
  every reachable object present?  no -> segments moved back, RecoveryRequired
  journal "done"      ->  purge (explicit, separate): quarantine/gc-* deleted
```

The journal (`gc/journal.json`) is written durably before each step. A GC interrupted anywhere leaves a consistent store -- every live object is in an old segment, the new one, or both, and duplicates are read as one -- reported on the next open (`interruptedGc`) and never finished by itself: GC and purge are refused until it is rolled back (its segments moved back; nothing lost). Damaged files set aside on open (`*.corrupt`, `*.torn`) are evidence and are never purged. GC holds the writer lock and the store's mutation lock; a second Yavin process is read-only and cannot collect or purge. A reader in another process whose segment was retired gets a read error and sees the store after a reload. GC of one workspace's store never reads or writes another's.

**Retention** (`RetentionPolicy`; by default nothing expires): reflog entries older than `reflogMaxAgeDays` stop keeping their objects, except each ref's newest `reflogKeepRecent` -- how old automatic and recovery checkpoints, abandoned states and deleted branches' history go; and with `aiFinishedMaxAgeDays`, records of AI runs that are finished with nothing left to undo (undone, or cancelled or failed with no changes) are removed first. Branches, tags, stashes, the index, an operation in progress and every AI run that may still be undone -- checkpointed, running, interrupted, with changes, committed -- are refs: never expired by age. The checkpoint list shows only checkpoints still in the store.

**Storage statistics** (`localgit_storage`): objects by kind, segments, bytes, refs, reflog records, AI runs, stashes, what waits in quarantine (GC's, and damaged files apart), the last GC's journal -- from the in-memory index, the refs and the reflog, without reading objects. The GC plan adds reachable and unreachable counts and bytes, segments to rewrite, roots by kind, expired entries.

**Integrity** (`localgit_integrity`): the store's own checks (dangling refs; with `full`, every object re-hashed and everything reachable walked), plus every record it keeps -- the reflog, the operation state, the AI run records, the GC journal -- and an interrupted GC, as structured findings, each with a suggested step for the user (`repair`). Nothing is repaired: no ref rewritten, no object recreated, no history deleted, no branch moved.

**Compression** stays deferred (the object format is unchanged): GC's copy-and-retire reclaims space without a new format; compression would need a versioned codec, migration and crash tests for little gain on source text.

**API** (native commands, typed in `services/localgit/types.ts`, on the service): `compareWithGit`, `promote` (with a dry run), `gcPlan`, `gcRun`, `gcRollBack`, `gcPurge`, `storage`, `integrity`. No UI is added: Local History (LG-08) stays as it is; these are the backend for it.

**Performance**: (release, `cargo test -p ide-localgit --release --test lg09_scale -- --ignored --nocapture --test-threads=1`) 10,000 files (22,174 objects): GC plan 1.3 s, run 62 ms, full integrity scan (every object re-hashed) 3.1 s, stats 4 ms, purge 11 ms, comparison with real Git 1.9 s, promotion plan 548 ms; peak working set 33 MB. 100,000 files (111,274 objects): GC plan 1.65 s, run 129 ms, full integrity 16.7 s, stats 5 ms, comparison 3.2 s, promotion plan 1.7 s; peak 186 MB. 1,000,000 objects (500,000 unreachable): reopen 0.7 s, GC plan (reachability over hash sets) 6.5 s, GC run (500,000 objects copied, one open file per segment, every object re-hashed) 12.3 s, quick integrity 16 ms, stats 146 ms; peak about 300 MB. (The 10k and 100k GC plans were measured before reads were batched per segment, which took the 1M plan from 43.5 s to 6.5 s and the run from 50 s to 12 s; they are upper bounds.) The full integrity scan re-hashes every object and is the expensive check; the quick one checks refs only.

**Known limitations**: rename detection across the bridge is by path (a rename is a delete and a create); comparison reads Local content to compute real Git ids where the working tree cannot vouch for it (bounded by what differs); a multi-folder workspace compares each folder with the repository it is in; promotion writes the working tree only -- staging and committing are the user's, in Source Control; a reader in another process sees a retired segment as a read error until it reloads; there is no UI yet for comparison, promotion or GC.

**Invariants**

1. Local Git never reads or writes the project's `.git`, never runs `git`, and never writes inside the project.
2. An object's id is the hash of its canonical bytes, checked on every read.
3. Refs are old or new after any crash, never a mixture; an interrupted update is reported, never completed.
4. Corrupt data is set aside and reported, never deleted or silently repaired.
5. One writer per store; everyone else reads.
6. A workspace's Local Git work never reaches another workspace.
7. A snapshot never writes to the project and never changes a document; the disk root is what is on disk, and the effective root differs from it only by unsaved documents.
8. What a snapshot records never depends on Git's ignore rules or configuration.
9. An incremental snapshot is an optimisation: it gives the Full answer, and anything uncertain makes the scan Full.
10. A file that could not be read reliably is carried forward or left out, and always reported -- never recorded as deleted, never recorded inconsistent.
11. HEAD only ever names a complete commit; a checkpoint never moves it.
12. A restore is planned completely, and refused on any conflict, before anything changes; unsaved documents are never overwritten or deleted unless the user chose to replace them.
13. A restore changes the disk only as one recorded file operation, never through a link, never removing what snapshots leave out; it is verified, never assumed.
14. Historical content that was never stored is never invented, read from disk in its place, or skipped silently.
15. Local Git staging is not the real Git index; branch, tag and HEAD operations never modify real Git.
16. The index is always a complete tree: HEAD's, or a published index commit's -- never partly written.
17. A commit is exactly the index. Staging never changes the working tree or a document; unstaging never changes either.
18. Creating a branch or a tag never moves HEAD; a tag never moves; nothing is replaced or deleted by force.
19. A switch never overwrites or deletes staged work, local changes or unsaved documents; HEAD moves only after the disk is verified.
20. Reset never silently destroys user changes: a hard reset refuses unless explicitly `allowDestructive`, and never touches untracked files the target does not have.
21. Revert creates new Local Git history; it never rewrites or moves existing commits.
22. Stash is not a real Git stash and never touches `.git`. A stash is durable before the workspace is cleaned, and a pop removes it only with its successful application.
23. A merge or cherry-pick never overwrites staged work, local changes, untracked files or unsaved documents, and never writes content Local Git does not have; it is refused before anything changes.
24. A merge's or cherry-pick's state is durable and explicit: conflicts are resolved only by an explicit choice, and an interrupted operation is continued or aborted by the user -- never completed by itself. HEAD moves only when it completes.
25. A cherry-pick makes a new commit and never changes the picked one; a merge never rewrites either parent.
26. An AI checkpoint is durable before the AI changes anything, and never moves HEAD, a branch or the index; if it cannot be made, the AI does not begin.
27. An AI commit holds exactly the AI's recorded changes, never a human's; staged human work stays staged. Ownership is never guessed: when it cannot be shown, the commit is refused.
28. Undo AI Run takes out only the AI's changes, never a human's work or unsaved text -- never a reset to the checkpoint -- and is refused rather than guess.
29. Local History presents Local Git and owns nothing: every fact comes from the Local Git service, every change goes through it after its dry run is shown, and every refusal is shown as the backend gave it.
30. Local Git never changes real Git: comparison reads it with read-only commands; promotion writes the working tree only, refuses over the user's real Git work or a real Git that changed since the plan, and never stages, commits or pushes.
31. GC deletes nothing reachable from any ref, and deletes nothing at all until an explicit purge; an interrupted GC leaves a consistent store and is rolled back, never finished by itself; corruption is reported, never repaired.

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
