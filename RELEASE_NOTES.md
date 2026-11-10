# Yavin IDE 2.2.0 — engineering hardening

**Status:** release candidate (built and validated with documented limitations — see
[RELEASE_VALIDATION_2.2.0.md](RELEASE_VALIDATION_2.2.0.md)). **Platform:** Windows x64 (MSI + NSIS).
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
release claim (full detail in `RELEASE_VALIDATION_2.2.0.md`):

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
