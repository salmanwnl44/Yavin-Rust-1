# Yavin IDE 2.2.1 — first published 2.2.x build

**Released:** 2026-11-11. **Platform:** Windows x64 (MSI + NSIS). Upgrades in place from 2.1.0.

2.2.0 was prepared but **never published** (it carried no release tag); 2.2.1 is the build that ships
the 2.2.x work. Its product code is the 2.2.0 code — everything added since is test and CI only, so
there is **no product behaviour change between 2.2.0 and 2.2.1**.

## What's new since 2.1.0

The engineering-hardening work described in the 2.2.0 section below (editor Back/Forward navigation,
customizable keyboard shortcuts, LSP rename safety and runtime reconfiguration, an actionable Git
missing-identity error, workspace-identity de-duplication, the typed extension author SDK, Activity
Bar accessibility, and the release-artifact validation gate), plus in 2.2.1:

- **Test and CI reliability** — editor-tab Playwright selectors scoped to the editor tablist (an
  Activity Bar `role="tab"` regression that made 20 UI tests fail), `npm ci` added to the Rust CI job
  so its real TypeScript-checker tests have their toolchain, CI-only Playwright retries, and a
  recalibrated C1 CPU hard-cap test margin that was unsatisfiable on 4-core runners.

## Artifacts

- **MSI** — `Yavin IDE_2.2.1_x64_en-US.msi` (11.6 MB).
  SHA-256 `0CA32B0461ED2CAF986F37DCBFCC5D4A669D80F5ADF8B5E94D3317E6A4F4ABD3`.
- **NSIS** — `Yavin IDE_2.2.1_x64-setup.exe` (8.4 MB).

Both installers are **not code-signed**, so Windows SmartScreen will likely warn on first run. Fixed
`UpgradeCode` with `allowDowngrades:false`: 2.2.1 upgrades 2.1.0 in place and the installer refuses to
replace a newer Yavin with an older one.

## Validation status — read before deploying

This build is published with **known, unclosed validation gaps**. It is not a fully validated release:

- **Not installed or tested on a clean machine.** No clean-VM install, no upgrade-from-2.1.0 run, and
  no uninstall test was performed. The upgrade/downgrade mechanism is verified only from installer
  metadata.
- **The packaged CI gate is red.** `tests/real/vscode.spec.ts` fails its OS-foreground assertion on
  any non-interactive session, including GitHub's `windows-latest` runner, so the `packaged` job and
  `release-gate` do not pass on a tag run. Every other assertion in that test, and every other
  packaged check (extension host, marketplace, trust, permissions, profiles, recovery, Open VSX
  install, webview isolation), passes. The assertion was left unchanged, not weakened.
- **Unsigned.** No code-signing certificate is configured.
- The packaged smoke-test evidence was gathered on the 2.2.0 build of the same product code; the
  2.2.1 installer itself was validated structurally (expected name, architecture, size, SHA-256) and
  its payload inspected, but its packaged smoke test was not re-run.

Full detail in [RELEASE_VALIDATION_2.2.1.md](RELEASE_VALIDATION_2.2.1.md). The 2.1.0 known
limitations (registry key custody, index renewal before 2027-10-19, first-install replay,
Windows-only executable extensions, unverified publisher identity, same-user malware) remain open.

---

# Yavin IDE 2.2.0 — engineering hardening

**Status:** release candidate (built and validated with documented limitations — see
[RELEASE_VALIDATION_2.2.1.md](RELEASE_VALIDATION_2.2.1.md)). **Platform:** Windows x64 (MSI + NSIS).
Upgrades in place from 2.1.0.

## What's new

This release is an engineering-quality pass over the existing IDE (no new AI/LLM functionality); each
item below is a verified change recorded in `NON_AI_ENGINEERING_PROGRESS.md` (WS18–WS30):

- **Editor navigation** — Back/Forward navigation history (Alt+Left / Alt+Right, through the single
  LSP navigation choke point) and Close Editors to the Left.
- **Customizable keyboard shortcuts** — user keybinding overrides, surfaced consistently to the
  command palette, menus, and the shortcut handler from one command list.
- **LSP safety** — rename name-validation and workspace-scope containment on applied edits; runtime
  handling of language-server configuration changes without a restart.
- **Git** — an actionable missing-identity commit error (was raw git text), plus expanded real-git
  integration coverage (commit identity, hunk staging, status parsing, branch lifecycle) against
  throwaway temp repositories.
- **Workspace reliability** — workspace-identity de-duplication so the same folder opened with a
  repeated, differently-cased, or differently-separated path is one workspace (correct session and
  Git key, no double repo/watcher).
- **Extension author SDK** — a typed `extensions/yavin.d.ts` generated from the real API (exposes no
  undeclared capability, drift-guarded) and an authoring guide. No runtime, permission, manifest, or
  sandbox code changed.
- **Accessibility** — the Activity Bar is a keyboard-navigable `role="tablist"` with `aria-selected`
  (no longer colour-only), labelled Status Bar problem counts, a named `<main>` editor landmark, and
  a focus ring.
- **Release engineering** — a `scripts/validate-artifact.mjs` metadata/security gate over the built
  installer and a `RELEASE.md` runbook; CI runs the gate after the packaged end-to-end test.

Verification: **1435 service/unit tests pass**, and the Playwright UI suite passes on CI after a
WS28 selector regression (20 deterministic failures, masked by an earlier inaccurate local pass
count) was found and fixed; `tsc`, Prettier, the production `vite build`, `cargo fmt`, Clippy, and
the Rust `cargo test` suite are green on CI. No product or native behaviour changed — the only Rust
edits are a `rustfmt` rewrap and a Clippy cleanup in test code — so native authorization, the
sandbox, path containment, and the C1/C2 architecture are untouched and the production C2 registry
stays empty.

## Artifacts

- **MSI** — `Yavin IDE_2.2.0_x64_en-US.msi` (11.6 MB).
  SHA-256 `BEDA7292B341F3BAD94547181DAE6FAB1C8B7BF134F7B3358ADABB252EE7145A`.
- **NSIS** — `Yavin IDE_2.2.0_x64-setup.exe` (8.4 MB).

Both installers are **not code-signed**, so Windows SmartScreen may warn on first run. Fixed
`UpgradeCode` with `allowDowngrades:false`: 2.2.0 upgrades 2.1.0 in place and the installer refuses to
replace a newer Yavin with an older one.

## Validation status & limitations

The MSI **builds cleanly and is structurally valid**, and the packaged application passes the
end-to-end real-host smoke test for launch, native backend, extension-host lifecycle, full
marketplace/trust/permissions/recovery, profiles, and Open VSX VS Code-compat install with webview
isolation (**17 of 21 `tests/real` pass; 2 skip** for missing Open VSX fixtures). The one exception
is the OS-foreground `vscode.spec` step (below). Not yet validated, and required before a final
release claim (full detail in `RELEASE_VALIDATION_2.2.1.md`):

- **Clean-VM install and the live upgrade-from-2.1.0 / uninstall cycle** were not run (no clean VM;
  the dev machine was not mutated). The MSI-level upgrade/downgrade mechanism is verified from the
  installer metadata.
- **One real-host test** (`vscode.spec`, the OS-foreground step) requires a controllable interactive
  desktop and fails in a non-interactive session — **including GitHub's `windows-latest` runner**, so
  the CI `packaged` job and `release-gate` stay red on this one test. Every other assertion in it
  (install, activation, status bar, grammar, the edit command, save) passes; only the OS-foreground
  handoff cannot be observed. The assertion was left unchanged, not weakened.
- **Code-signing** is not configured (no signing certificate/secret in this repo).

The 2.1.0 known limitations below (registry key custody, index renewal before 2027-10-19, first-install
replay, Windows-only executable extensions, unverified publisher identity, same-user malware) remain
open for 2.2.0.

---

# Yavin IDE 2.1.0 — first build

**Released:** 2026-10-19. **Platform:** Windows x64 (MSI). The first published build of Yavin; there is no earlier release to upgrade from.

## What it includes

The editor, terminal, Git and Local History, and the extension system (EXT-01 … EXT-22): Yavin's signed extension registry and Open VSX, packages verified before install, per-extension permissions enforced natively, extension code in a sandboxed host (an AppContainer with job limits), profiles and settings, diagnostics, and safe upgrade and recovery of installed extensions. The final audit is in [EXTENSION_RELEASE_AUDIT.md](EXTENSION_RELEASE_AUDIT.md).

## Known limitations — accepted for this release

The EXT-23 audit recommended **NO-GO** until the items below are resolved. The release owner accepted them for this first build; they remain open.

- **Registry signing key custody.** The key that signs Yavin's extension registry is kept as an unencrypted file on one machine, with no backup or rehearsed rotation. Until it is moved into secure custody and backed up, losing it would stop new registry indexes until a Yavin release with a new key, and its compromise would let whoever holds it publish registry indexes.
- **Registry index renewal.** The signed index expires on **2027-10-19** and nothing yet renews it automatically. A renewal must be published before then, or extensions with code can no longer be installed or updated from Yavin's registry.
- **CI.** The continuous-integration run of the release commit's predecessor failed in the UI test step; the cause is not yet identified. All suites pass locally (see the audit for exact results).
- **First-install replay.** A brand-new installation accepts any validly signed, unexpired registry index, including an older one. Only one index has been published so far, so there is nothing older to replay yet.
- **Executable extensions run only on Windows.** Elsewhere, themes and snippets apply, but no extension code runs.
- **Publisher identity is not verified.** A registry signature proves which registry published a package, not who wrote it.
- **Same-user malware** is outside the threat model: a program running as you can change Yavin's files and records.

## Upgrading and downgrading

Each later release will carry a higher version. The installer refuses to install an older Yavin over a newer one. Do not install builds of Yavin made from source before this release: they allow downgrades and can damage a newer extension inventory. Never install a test build (made with the `test-registry` feature): it shares this installer's upgrade identity and accepts a registry key from its environment.

## Checksum

`Yavin IDE_2.1.0_x64_en-US.msi` — SHA-256 `AA71EAA74E530539008B7097AFF107290580DFD5F9EDFCCF2BD3CDE7A2857235`. The installer is not code-signed, so Windows SmartScreen may warn on first run.
