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
2. Implement actual terminal, language-server, debugging, AI, and extension services in TypeScript. Keep any Rust process transport small and restrict process spawning to explicit user actions and validated arguments.
3. Add desktop end-to-end coverage for folder selection, CRUD, unsaved-close prompts, window controls, and failure recovery. Exercise nested Git repositories, UNC paths, read-only files, symlinks/junctions, and non-ASCII names on supported platforms.
4. Add file-change reconciliation and conflict detection before enabling autosave. Today refresh is manual, and saving can overwrite changes made externally since opening the file.
5. Measure large-workspace traversal and memory use. Native scans currently run synchronously and stop at a bounded depth; add incremental loading or background execution when needed.
6. Complete accessibility and responsive-layout review. Disable or implement remaining decorative controls. Configure installer signing, release automation, dependency/license auditing, and platform testing before a production release.

Workspace validation protects against ordinary path traversal and resolved symlink escapes. It is not an OS-level sandbox against another process concurrently replacing filesystem entries. Recursive copy can leave a partial destination if it encounters a later error; the error is reported. Installer execution, signing, and full desktop behavior require separate validation.

## Rules and references

Follow `../GEMINI.md`: small changes, explicit errors, safe Rust, minimal permissive dependencies, and relevant tests. The user's TypeScript requirement supersedes the previous JavaScript wording.

Native replacement uses [Rust filesystem rename semantics](https://doc.rust-lang.org/std/fs/fn.rename.html). Window exposure follows [Tauri capabilities](https://v2.tauri.app/security/capabilities/); custom filesystem commands also validate their inputs in Rust.
