# Yavin IDE

A **local-first, AI-native desktop IDE** built with React 19, TypeScript, Vite, Tailwind CSS 4, and Tauri 2. TypeScript owns the application logic and state; Rust provides native OS mechanics, scoped filesystem access, process isolation, and security enforcement. Monaco powers the editor; xterm.js + a custom `portable-pty`/ConPTY runtime power the terminal.

> **Status:** active development. The core IDE (editor, terminal, language intelligence, Git, tasks, settings) is implemented and tested. The extension ecosystem and the C2 contained-server capability are **deferred/disabled** (not shipped). See [`ARCHITECTURE.md`](ARCHITECTURE.md) and the `*_DESIGN.md` / audit docs for details.

---

## Highlights

- **Editor** — Monaco 0.57 with multi-cursor, folding, bracket matching, snippets, sticky scroll, minimap, find/replace, and a document model with conflict-safe saves (`DocumentService` + `EditorModelBridge`, keyed by a canonical `ResourceId`).
- **Terminal** — production-grade custom runtime: `portable-pty`/ConPTY backend, xterm.js front end, flow-controlled output streaming, shell detection (cmd/PowerShell/pwsh/Git-Bash/zsh/bash/fish), multiple sessions, split panes, OSC shell integration, and OS-level process containment (Job Object / `killpg`).
- **Language intelligence (LSP)** — real LSP client supporting **11 language servers** (TypeScript, Pyright/Pylsp, rust-analyzer, gopls, clangd, JSON/CSS/HTML/YAML/Bash): completion, hover, go-to-definition, references, rename, code actions, diagnostics, semantic tokens, inlay hints, code lens, formatting.
- **Diagnostics & Problems** — LSP diagnostics plus project checkers (tsc, eslint, cargo, ruff), aggregated in an owner-keyed Problems panel with editor decorations.
- **Source control** — full Git integration (status, hunk staging, commit/amend, branches, tags, stash, history/graph, remotes, conflict resolution) **plus** a native **Local Git** store for local history, snapshots, and checkpoints.
- **Tasks & Run/Debug** — task runner with problem matchers; DAP-based debugging (currently Python/debugpy).
- **Workbench** — command palette, global/file/symbol search (ripgrep), explorer with multi-root support, settings (user + workspace scopes), status/activity bars, session & layout persistence.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full design and milestone history (EXT-, TERMINAL-, LG-, IDE- series).

---

## Getting started

**Prerequisites:** Node.js 24 LTS + npm, Rust (stable), the platform's [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/), and Git. On Windows: MSVC C++ build tools and the WebView2 runtime.

```sh
npm ci                 # install dependencies
npm run dev            # browser UI preview (no native filesystem)
npm run tauri dev      # full desktop app with native filesystem access
npm run build          # strict TypeScript check + production frontend bundle
npm run tauri build    # desktop installer (code signing is not configured)
```

**Common shortcuts:** `Ctrl+Shift+O` open workspace · `Ctrl+O` open file · `Ctrl+P` quick-open files · `Ctrl+Shift+P` command palette · `Ctrl+S` save.

---

## Project layout

```
.
├── src/                 # React/TypeScript frontend (editor, services, components)
│   ├── editor/          # Monaco integration, theming, language wiring
│   ├── components/      # UI (layout, panels, explorer, git, terminal, settings)
│   └── services/        # app logic: documents, resource, lsp, git, localgit,
│                        #   terminal, tasks, debug, settings, search, extensions, ai
├── src-tauri/           # Rust/Tauri backend
│   ├── src/             # commands: fs, git, lsp, dap, terminal, checkers, extensions…
│   └── crates/          # ide-workspace, ide-localgit, ide-terminal-protocol, ide-plugin-host
├── scripts/             # build, registry, mutation-test, and e2e tooling
├── tests/               # Playwright: tests/ui (mocked) and tests/real (packaged host)
├── registry/            # signed extension-registry metadata
└── benchmark/           # OpenVSX compatibility benchmark data
```

---

## Testing

```sh
npm test                       # frontend unit tests (Node built-in test runner)
npm run test:ui                # Playwright UI tests (mocked dev server)
npm run test:real-host         # Playwright against the packaged app (Windows)
cargo test --manifest-path src-tauri/Cargo.toml          # Rust tests
node scripts/security-mutations.mjs                       # security mutation suite
node scripts/conformance-mutations.mjs                    # VS Code conformance mutations
npm run typecheck              # tsc --noEmit
npm run format:check           # Prettier
```

---

## Architecture principles

- **TypeScript owns logic & state; Rust owns OS mechanics & isolation.**
- **`ResourceId`** is the canonical resource identity; **`DocumentService`** is the single source of truth for document contents; **`EditorModelBridge`** is the Monaco↔document sync boundary.
- Subprocesses (LSP, DAP, terminal) share one **process-containment** mechanism (Windows Job Object / Unix process groups).
- Code execution (LSP, tasks, debugging, terminal) is gated behind **Workspace Trust**; the extension ecosystem and the C2 contained-server capability are **deferred and disabled** by default.

Deeper references live in [`ARCHITECTURE.md`](ARCHITECTURE.md), [`PROCESS_CAPABILITY_DESIGN.md`](PROCESS_CAPABILITY_DESIGN.md), [`MENUS.md`](MENUS.md), and the `C2_*` / audit documents.

---

## License

MIT — see [`LICENSE`](LICENSE). Bundled third-party tooling (e.g. ripgrep under `src-tauri/resources/search/`) retains its own license files.
