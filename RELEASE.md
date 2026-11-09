# Yavin IDE — Release Engineering & Packaging (WS23)

This is the runbook for turning a checkout into a validated Windows installer. It documents the
**real** build model, the dependency graph, the exact commands, and the validation procedure a
release must pass. It describes what exists; it does not grant or automate a production release
(none is triggered from here, and no signing secret lives in this repository).

Single source of truth for everything versioned: `src-tauri/tauri.conf.json` `"version"` (currently
**2.2.0**). Do not spell the version anywhere else — `release-version.mjs` fails the build if you do.

---

## 1. The real packaging model

Yavin is a **Tauri 2** desktop app. There is **no Electron** anywhere in the build — the only
runtime shell is Tauri's WebView2-hosted window. The production artifact is a **Windows x64 MSI**
(and NSIS `.exe`) produced by `cargo tauri build`.

- **Frontend** — React 19 + Vite 7 + Tailwind 4, TypeScript. `npm run build` type-checks
  (`tsc --noEmit`) then emits static assets to `dist/`. Monaco, the Shiki/TextMate grammars, and
  xterm are bundled into those assets by Vite; nothing is fetched at runtime.
- **Native backend** — the `yavin-ide` crate (`src-tauri/`), built as a release binary that embeds
  `dist/` (`frontendDist: "../dist"`) and the bundle resources. The single window is declared in
  `tauri.conf.json` (`app.windows[0]`); there is no Rust-side window builder.
- **Extension host** — a _separate_ binary, `yavin-extension-host(.exe)`, built from the
  `ide-plugin-host` crate and shipped as a bundle resource under `resources/extension-host/`. It is
  **not** a second packaged app; the main app spawns it as a child process.
- **Search** — `ripgrep` (`rg.exe`) ships as a bundle resource under `resources/search/`, with its
  upstream licenses (`COPYING`, `LICENSE-MIT`, `UNLICENSE`) and `VERSION.txt`. These license files
  are protected — never edit them.

### Entry point & packaging command

```
npx tauri build            # production MSI + NSIS, identifier com.yavin.ide
```

`tauri.conf.json` `build.beforeBuildCommand` runs first and makes the build self-contained:

```
node scripts/build-extension-host.mjs --release && npm run build
```

So a packaging run always (1) compiles the extension host in release and copies it into
`resources/extension-host/`, then (2) type-checks and builds the frontend into `dist/`, then (3)
compiles the native release binary and bundles it with WiX/NSIS. An installer can never ship
without the host or the frontend.

---

## 2. Build dependency graph

```
tauri.conf.json (version, bundle.resources, window, CSP, upgradeCode)
      │
      ├─ beforeBuildCommand
      │     ├─ scripts/build-extension-host.mjs --release
      │     │       └─ cargo build --locked -p ide-plugin-host --bin yavin-extension-host --release
      │     │               └─> src-tauri/resources/extension-host/yavin-extension-host.exe   (bundle resource)
      │     └─ npm run build
      │             ├─ tsc --noEmit                      (type gate; fails the build on any TS error)
      │             └─ vite build                        (define __YAVIN_VERSION__ from tauri.conf.json)
      │                     └─> dist/                    (frontendDist)
      │
      ├─ scripts/setup-search.ps1  (prerequisite, NOT run by the build — see §3)
      │       └─> src-tauri/resources/search/rg.exe + licenses + VERSION.txt   (bundle resource)
      │
      └─ cargo tauri build
              ├─ cargo build --release  (yavin-ide; staticlib+cdylib+rlib; workspace crates)
              ├─ embeds dist/ + bundle.resources
              └─ WiX v3 (MSI) + NSIS (.exe)   ──>  src-tauri/target/release/bundle/{msi,nsis}/
                      MSI name: "Yavin IDE_<version>_x64_en-US.msi"
```

Reproducibility properties already in place:

- **Pinned/locked** — `cargo ... --locked` (host and app) uses `Cargo.lock`; `package-lock.json`
  with `npm ci` in CI; exact npm pins for the grammar/highlighting stack via `overrides`.
- **One version** — injected into the frontend as `__YAVIN_VERSION__` from `tauri.conf.json`
  (`vite.config.ts` → `src/appVersion.ts`); `release-version.mjs` forbids hardcoding it elsewhere.
- **Dev/prod separation** — dev-only resource paths (`CARGO_MANIFEST_DIR`, sample extensions, the
  `YAVIN_EXTENSION_HOST` override) are gated on `cfg!(debug_assertions)`, so a **release build never
  depends on the dev repo path or dev `node_modules`**. Dev-only Cargo features
  (`test-registry`, `c2-test-profiles`) are off by default and `release-version.mjs` fails if
  `test-registry` is ever a default.

---

## 3. Environment assumptions & prerequisites

| Tool       | Version used / constraint           | Notes                                                    |
| ---------- | ----------------------------------- | -------------------------------------------------------- |
| Node       | `>=24 <25` (`package.json` engines) | Vite 7 / tsc                                             |
| Rust       | stable (CI: `rustup update stable`) | MSVC toolchain on Windows                                |
| Tauri CLI  | `@tauri-apps/cli` v2 (`npx tauri`)  | fetches WiX v3 / NSIS into its own cache on first bundle |
| WiX / NSIS | fetched by Tauri                    | **not** required on `PATH`                               |
| ripgrep    | 15.2.0                              | fetched + SHA-256-verified by `scripts/setup-search.ps1` |
| PowerShell | pwsh (CI) or Windows PowerShell 5.1 | `setup-search.ps1` runs under either                     |

**`rg.exe` is a prerequisite, not a build step.** It is `.gitignore`d (only its licenses and
`VERSION.txt` are tracked) and must be fetched once per checkout before packaging:

```
pwsh scripts/setup-search.ps1          # or: powershell -ExecutionPolicy Bypass -File scripts/setup-search.ps1
```

Packaging **fails with a clear error** if `rg.exe` is absent (Tauri refuses a missing bundle
resource); `scripts/validate-artifact.mjs` reports it before you start the long build.

---

## 4. Release validation procedure

Run top to bottom. Stop at the first failure. All commands are from the repo root unless noted.

### 4a. Build validation (fast → slow)

1. `node scripts/release-version.mjs` — version is a valid installer version, above every release
   tag, spelled only in `tauri.conf.json`; production config carries no test identifier / default
   `test-registry`.
2. `npx tsc --noEmit` — type gate (also inside `npm run build`).
3. `npm run format:check` — Prettier.
4. `npm test` — TS service tests + script tests (`scripts/*.test.mjs`, incl. `validate-artifact`).
5. `npm run build` — real frontend production build → `dist/`.
6. In `src-tauri/`: `cargo fmt --all --check`, then
   `cargo clippy --workspace --all-targets --locked -- -D warnings` (and again with
   `--features test-registry`).
7. In `src-tauri/`: `cargo test --workspace --locked` (and `--features test-registry`).
   _Windows note:_ Smart App Control can block the cargo **test** launcher with OS error 4551; if
   hit, do not disable any security control — record it and rely on CI for the test run.
8. `pwsh scripts/setup-search.ps1` — the `rg.exe` resource (once per checkout).
9. `node scripts/validate-artifact.mjs` — **pre-build gate**: production config clean, every
   required bundle resource present (incl. the built extension host, not just its placeholder),
   `dist/` and `tauri.conf.json` carry no leaked secret / test identifier.

### 4b. Packaging

10. `npx tauri build` — the real installer. Expect
    `src-tauri/target/release/bundle/msi/Yavin IDE_<version>_x64_en-US.msi` (and the NSIS `.exe`).

### 4c. Artifact & security validation

11. `node scripts/validate-artifact.mjs --installer auto` — locates the just-built installer by
    expected name (version + `x64`), checks a sane size, and prints its **SHA-256** for the release
    notes. Fails on a wrong name/arch/version or an implausible size.
12. Record the SHA-256 in `RELEASE_NOTES.md` for the shipped version.
13. Security review (what `validate-artifact.mjs` + `release-version.mjs` enforce): no test-only C2
    profiles (the production registry ships empty), no default `test-registry`, no
    `com.yavin.ide.e2e` identifier, no private-key / token markers in `dist/` or config, and the
    protected search license files unchanged.

### 4d. Runtime / packaged-app validation

14. `npm run test:real-host` — builds the **MSI with a test identifier**, extracts it as an
    administrative image (`msiexec /a`), and drives the installed application end to end with
    Playwright (`tests/real`). This is the authoritative packaged-app smoke test; it proves the
    bundled extension host, marketplace, resources, and window all work outside the dev tree.
    _(Heavy; CI runs it in the `packaged` job on `v*` tags and `workflow_dispatch`.)_

A "release-ready" claim requires step 14's evidence, not just a green `cargo build`.

---

## 5. Upgrade / migration

- **Installer upgrade** — the MSI carries a fixed `upgradeCode` and `allowDowngrades: false`, so a
  newer version upgrades in place and the installer **refuses to replace a newer Yavin with an
  older one**. `release-version.mjs` enforces that each release's version is strictly above every
  prior release tag, so the installer's own downgrade refusal is never tripped by a legitimate
  release.
- **Settings & workspace state** — persisted under the OS `app_config_dir()` (`session.json`,
  `trusted-folders.txt`) and `app_local_data_dir()` (recovery log, Local Git), with a shared
  versioned store (`ide-workspace/durable.rs` `read_versioned`). A **corrupt or future-versioned**
  file is **set aside intact** to a timestamped `.bak`, the app **falls back to defaults and still
  starts** (never blocks startup), and an unreadable file is **never overwritten**. Older files load
  with missing fields defaulted (every field is `#[serde(default)]`). So upgrades never silently
  erase user data, and a bad old settings file cannot brick startup.
- **Extensions** — installed under `app_local_data_dir()/extensions`; compatibility is resolved by
  `semver` (EXT-12), and an incompatible extension fails safely (the EXT-19/EXT-22 safe
  upgrade/recovery paths). User data is preserved across app upgrades because it lives outside the
  install directory.

There is **no automatic rollback guarantee** — downgrade is simply refused by the installer, and the
`.bak` set-aside is the recovery path for unreadable state.

---

## 6. Startup / shutdown

- **Startup** (`src-tauri/src/lib.rs` `run()` → `.setup`): crash/intent-log recovery settles any
  half-finished file operation a previous run left (roll-forward of an interrupted save), the
  extension inventory and Local Git base are located under the OS data dirs, and the native C1
  (process) and C2 (contained-server) capabilities are constructed with **no profiles** (nothing
  runs until a profile is approved; C2 reconciliation fails closed).
- **Shutdown** (`RunEvent::ExitRequested | Exit`): every child subsystem is explicitly ended so
  nothing is orphaned — terminals (whole process group), LSP servers, DAP adapters + debuggees,
  extension hosts, C2 contained servers (+ ACL cleanup), checkers, test runs — then this process's
  temp records are swept. Windows sandboxed children are torn down via job objects
  (`TerminateJobObject`), with `Drop` kills as a backstop.
- **Single instance** — **not enforced.** Yavin intentionally allows multiple windows/processes,
  each with its own per-instance recovery log; there is no guard that focuses an existing window on
  a second launch. This is a design choice, documented here as a known boundary (see §8).

---

## 7. Update mechanism — gap & integration boundary

Yavin has **no in-app updater**: no `tauri-plugin-updater`, no update check, no self-download, no
runtime version comparison for self-update. The `tauri = { ... features = [] }` backend loads no
plugins at all.

Updates today are delivered **by installing a newer MSI** (manual or managed deployment). The MSI
`upgradeCode` + `allowDowngrades: false` is the entire upgrade/downgrade mechanism, and it is
installer-level, not runtime. This is an accepted boundary for the current release, not a defect to
paper over here.

**Integration boundary for a future updater** (documented, not implemented — WS23 does not invent
update infrastructure or URLs): an updater would need (1) a signed release feed, (2) MSI/NSIS
code-signing (installers are currently unsigned — SmartScreen may warn), (3) a version-comparison +
integrity-check + failure-handling path, and (4) to reuse the existing installer upgradeCode so an
in-app update and a manual MSI install converge on the same upgrade identity. None of that exists
yet; building it is out of WS23's scope.

---

## 8. Known release blockers / open items

- **`RELEASE_NOTES.md` is stale** — it documents 2.1.0 while the version is 2.2.0. A release of
  2.2.0 must add a 2.2.0 section with its MSI SHA-256 (from step 11). _(Not fabricated here — the
  release owner writes real notes.)_
- **Runtime version string mismatch** — the HTTP User-Agent (`marketplace.rs`) and the
  extension-diagnostics report header (`extension_service.rs`) use `env!("CARGO_PKG_VERSION")`,
  which is the crate's `0.1.0`, not the product `2.2.0`. Cosmetic/telemetry only (the UI version is
  correct via `__YAVIN_VERSION__`), but it should be reconciled by the owning workstream — it is a
  **runtime** change, out of WS23's build scope. Flagged as a cross-workstream item.
- **Installers are unsigned** — SmartScreen may warn on first run (already noted in
  `RELEASE_NOTES.md`). Code-signing is the prerequisite for any future updater (§7).
- The EXT-23 open items (registry key custody, index renewal before 2027-10-19, first-install
  replay) remain as recorded in `RELEASE_NOTES.md`.

---

## 9. CI

`.github/workflows/ci.yml` already runs per-suite jobs (`version`, `typescript`, `ui`, `rust`,
`registry`) on every push/PR, and the expensive `mutations` + `packaged` jobs only on `v*` tags and
`workflow_dispatch`, gated by `release-gate`. No job holds a signing secret; no job triggers a
production release. WS23 adds `validate-artifact.mjs` to the fast path (via `npm test`) and makes it
available as an explicit artifact/security gate in the `packaged` job.
