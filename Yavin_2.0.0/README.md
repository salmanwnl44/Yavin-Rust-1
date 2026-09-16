# Yavin IDE

React 19, strict TypeScript, Vite, Tailwind CSS, and Tauri 2.
TypeScript owns editor state, workspace orchestration, quick open, and Git status parsing.
Rust provides native dialogs, scoped filesystem operations, and fixed Git subprocess calls.

## Development

Use Node.js 24 LTS and npm. Desktop development also requires Rust stable, the platform's Tauri build prerequisites, and Git for status integration. On Windows, install the MSVC C++ build tools and WebView2 runtime.

From this directory:

```sh
npm ci
npm run dev          # browser UI preview; local filesystem is unavailable
npm run tauri dev    # desktop app with native filesystem access
npm run build       # strict TypeScript check and production frontend bundle
npm run tauri build # desktop installer; signing is not configured
```

Open a workspace with Ctrl+Shift+O and a file with Ctrl+O. Ctrl+P searches workspace files; Ctrl+Shift+P searches commands. Save with Ctrl+S. Unsaved changes remain marked when a save fails.

File, Edit, Selection, View, Go, Terminal, and Help have working dropdowns. Use arrow keys to navigate and Escape to return to the menu trigger. Explorer context menus also support Shift+F10. Browser preview supports temporary editing; saving and native file dialogs require the desktop application.

## Checks

```sh
npm run typecheck
npm test
npm run test:ui
npm run format:check
npm run build
cd src-tauri
cargo fmt --all --check
cargo check --workspace --locked
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
```

Use `npm run format` and `cargo fmt --all` to format changes.

Browser tests use installed Microsoft Edge on Windows. On other platforms, run `npx playwright install chromium` first. `PLAYWRIGHT_CHANNEL` can select another installed browser channel. Desktop-mode browser tests mock IPC to exercise UI success and failure paths; they do not replace testing the native dialogs on the actual desktop.

See [MENUS.md](MENUS.md) for the menu audit, reviewed plan, and command scope.

The editor currently uses a textarea. The terminal panel runs your own shell in the workspace root, one session per window. AI, language servers, debugger, plugins, and automatic filesystem watching are not connected. Their UI must not claim that work has executed.
See [ARCHITECTURE.md](ARCHITECTURE.md) for ownership boundaries and the remaining release plan.
