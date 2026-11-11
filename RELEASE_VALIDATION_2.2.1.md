# Yavin IDE 2.2.1 — Windows MSI Build & Release Validation

**Date:** 2026-11-11 · **Branch:** `main` · **Version (source of truth — `tauri.conf.json`):** 2.2.1

> **Scope note.** Sections 1–7 below record the validation pass performed on the **2.2.0** build at
> `b6f2d9a`. 2.2.0 was never published; 2.2.1 ships the same product code (everything added since is
> test and CI only), so that evidence carries over. The **2.2.1 build and its own artifact
> validation** are recorded in the final section.

This is the evidence record for the Windows release-validation pass requested after WS0–WS30: the
actual MSI build, artifact inspection, and the packaged-application smoke test. It records what was
executed and what it produced. It does **not** stage, commit, tag, or publish a release — that waits
for explicit authorization. It closes the "MSI not yet built / clean-VM install not yet run"
limitation to the extent this (single developer) environment allows, and states precisely what
remains for a release-signoff host.

---

## 1. Build

### Environment & toolchain (recorded)

| Component               | Value                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------- |
| OS                      | Windows 11 Home Single Language 10.0.26300.9711, x64                                  |
| Rust / Cargo            | `rustc 1.99.1 (58cf8f9c3 2026-10-13)` / `cargo 1.99.1`, host `x86_64-pc-windows-msvc` |
| Node / npm              | v24.20.0 / 11.19.0                                                                    |
| Tauri CLI               | `tauri-cli 2.11.4` (via `npx tauri`; cargo-tauri not installed — not required)        |
| MSVC                    | Visual Studio 2022 Build Tools (`…\2022\BuildTools`, VC.Tools.x86.x64)                |
| WebView2 runtime        | 157.0.4341.42 (present, machine-wide)                                                 |
| WiX / NSIS              | fetched by Tauri into its own cache (not required on PATH)                            |
| ripgrep resource        | `src-tauri/resources/search/rg.exe` present (4.2 MB)                                  |
| Extension host resource | `yavin-extension-host.exe` present (built `--release`)                                |

> **Note — `link.exe` on PATH.** `where link.exe` resolves to Git's `C:\Program Files\Git\usr\bin\link.exe`
> first. This did **not** break the build: for the `*-msvc` target Cargo locates the MSVC linker via
> the VS installation (vswhere), not via PATH. The release binary linked cleanly.

### Pre-build gates (all passed)

- `node scripts/release-version.mjs` → _version 2.2.0 is valid (release tags: v2.1.0)._
- `node scripts/validate-artifact.mjs` → _artifact validation passed for version 2.2.0._ (production
  config clean, every required bundle resource on disk, no leaked secret in `dist/` or config).

### Exact build command & result

```
npx tauri build          # (beforeBuildCommand: build-extension-host.mjs --release && npm run build)
```

- **Result:** success, **exit 0**. Native release compile: _Finished `release` profile in 2m 10s_;
  **0 errors, 0 warnings** in the captured log. Two bundles produced.
- **Built binary:** `src-tauri/target/release/yavin-ide.exe` (24.4 MB).

### MSI metadata & location

| Field                 | Value                                                                       |
| --------------------- | --------------------------------------------------------------------------- |
| MSI                   | `src-tauri/target/release/bundle/msi/Yavin IDE_2.2.0_x64_en-US.msi`         |
| MSI size              | 11.6 MB (11,599,872 bytes)                                                  |
| **MSI SHA-256**       | **`BEDA7292B341F3BAD94547181DAE6FAB1C8B7BF134F7B3358ADABB252EE7145A`**      |
| NSIS                  | `…/bundle/nsis/Yavin IDE_2.2.0_x64-setup.exe` (8.4 MB)                      |
| ProductName / Version | Yavin IDE / 2.2.0                                                           |
| Manufacturer          | yavin                                                                       |
| ProductCode           | `{A611C4B7-F307-491E-9C5A-6233A7CC5630}` (per-build)                        |
| UpgradeCode           | `{7150E972-3ADC-597C-95E0-96663D30EDBA}` (matches `tauri.conf.json`)        |
| Platform / Language   | x64 / 1033 (en-US)                                                          |
| Downgrade protection  | `WIX_DOWNGRADE_DETECTED` in SecureCustomProperties; `allowDowngrades:false` |
| ARP entries           | `ARPNOMODIFY=1`, `ARPNOREPAIR=yes`, product icon set                        |

`node scripts/validate-artifact.mjs --installer auto` → **passed** (expected name + x64 + version,
plausible size, SHA-256 recorded above).

---

## 2. Artifact validation (MSI structure)

Administrative extraction (`msiexec /a … /qn TARGETDIR=…`, exit 0) — the installed layout, nothing
registered on the machine — contains exactly the documented payload and nothing else:

```
PFiles/Yavin IDE/yavin-ide.exe
PFiles/Yavin IDE/resources/extension-host/yavin-extension-host.exe
PFiles/Yavin IDE/resources/extension-host/README.md
PFiles/Yavin IDE/resources/search/rg.exe
PFiles/Yavin IDE/resources/search/COPYING
PFiles/Yavin IDE/resources/search/LICENSE-MIT
PFiles/Yavin IDE/resources/search/UNLICENSE
PFiles/Yavin IDE/resources/search/VERSION.txt
```

- Main app, extension host, and ripgrep all present. No `node_modules`, no dev paths, no stray files.
- The frontend (`dist/`) is embedded **inside** `yavin-ide.exe` by Tauri (`frontendDist`), so it is
  correctly not a separate file.
- Protected search license files shipped unmodified.

**Signing status (accurately reported):** MSI, NSIS, `yavin-ide.exe`, and `yavin-extension-host.exe`
are all **NotSigned** (`Get-AuthenticodeSignature` → `NotSigned`, no signer). This matches the
documented, accepted boundary (RELEASE.md §7/§8: installers are unsigned; SmartScreen may warn). No
certificate, signature, or checksum was invented.

---

## 3. Packaged-application smoke test

No clean Windows VM was available in this environment. The **authoritative packaged-app validation**
documented in RELEASE.md §4d and run by CI's `packaged` job — `npm run test:real-host` — was executed
instead. It builds the MSI under a test identifier (`com.yavin.ide.e2e`), extracts it as an
administrative image, and drives the **installed application** end to end with Playwright (`tests/real`,
no dev server, no mocks). The production MSI from §1 was preserved and restored; its SHA-256 is
unchanged after the test run.

**Full packaged suite (`tests/real`): 17 passed, 2 failed, 2 skipped.** The one consistent failure
was then isolated (see §4) and traced to an environment limitation, not a product defect.

PASS — validated against the real installed binary:

1. Application launches — PASS (window + menubar render; banner "Y YAVIN v2.2.0").
2. Native backend ↔ UI — PASS (webview↔Rust IPC; `extension-host.spec` "runs Hello World end to end").
3. Workspace opens, Workspace Trust prompt — PASS.
4. Extension host spawns / crash-restart / per-workspace / host-absent degradation — PASS (5/5).
5. Marketplace install, update, uninstall, checksum refusal, offline, **permissions**, older-inventory
   upgrade+recovery, forged-trust refusal, signed-index verify, downgrade recovery, EXT-22 provenance
   — PASS (12/12 `marketplace.spec`).
6. Profile settings used by a running extension, kept per profile across restarts — PASS.
7. Open VSX (loopback mirror) VS Code-compat extension: install → sandboxed activation → status-bar
   contribution → **webview** loads its files, messages pass, and IPC/navigation/remote/popups/storage
   are all refused — PASS (`webview.spec`, in isolation 17.3 s).
8. VS Code package functional path (`vscode.spec`): install from Open VSX, sandboxed activation,
   status bar, runtime globals (URL/Intl/crypto), TextMate grammar, upper-case **edit command**, save
   — PASS (every assertion through line 326 passed in the trace). See §4 for the single OS-focus step.

SKIPPED — missing external fixtures (correctly `test.skip`-guarded, not failures):

- `webview-svg.spec` (SVG Preview from Open VSX) — needs `YAVIN_E2E_SVG_VSIX` (real `jock.svg 1.5.3`
  download), absent.
- `yaml.spec` (redhat.vscode-yaml from Open VSX) — needs `YAVIN_E2E_YAML_VSIX`, absent.

> The broader non-packaged UI behavior (file create/edit/save/rename/delete, Explorer, editor tabs,
> terminal, Git) is covered by the Playwright `tests/ui` suite and the 1435-test service suite. That
> `tests/ui` suite had a WS28 selector regression (20 deterministic failures) at `b6f2d9a`, found and
> fixed in `504e252`/`fc4c2d9` and now green on CI (see the Addendum). Those run against the dev
> build; the packaged suite above adds the packaged-specific proof (embedded frontend, bundled host
> spawn, resources, real webview, CSP).

---

## 4. Defect investigation — the one consistent failure

**Test:** `tests/real/vscode.spec.ts:218` — "a signed VS Code package … its status bar, edit, grammar
and the window's focus."

**Observed:** fails consistently (180 s default run, and again at a 420 s timeout, 5.9 min).

**Root cause (from the Playwright trace):** every assertion up to and including line 326
(`expect(item).toHaveText("Probe focused")`) **passes** — install, sandboxed activation, status bar,
runtime globals, grammar, the edit command, and save all work in the packaged app. The test then stalls
at **line 327**, `await expect.poll(nativeFocus).toBe(true)`, which polls the OS via the
`window_focused` IPC and requires the **Yavin application window to hold the real Windows foreground**.
It returns `false` for the full timeout. The surrounding steps (`foreground(other.pid)`,
`otherApplication()`, minimize/restore) drive and read the **OS-level foreground**, which only behaves
in an **interactive desktop session**. In this automated/background session the launched app is not
granted the OS foreground (the webview reports focused while the OS says the window is not foreground —
the expected divergence for a non-interactive launch).

**Classification:** **environment limitation (no interactive-desktop foreground control)**, not a
packaged-app defect, and not a regression from WS18–30 (no Rust changed since the release baseline;
EXT-27's `window_focused` is Rust-side and untouched). The non-focus functionality this test covers is
independently proven by `webview.spec` passing (same Open VSX install + sandboxed VS Code-compat
activation + status item + webview).

**Fix made:** none. There is no product defect to fix, and the failing assertion is a legitimate OS
check; weakening or skipping it would mask a real check that passes on an interactive host / CI runner.
No security control was disabled; no sandbox weakened.

---

## 5. Upgrade / uninstall

- **Mechanism verified at MSI level:** fixed `UpgradeCode`, `allowDowngrades:false`, and
  `WIX_DOWNGRADE_DETECTED` present → in-place upgrade and downgrade-refusal are configured as
  documented. `release-version.mjs` enforces 2.2.0 > every release tag (v2.1.0), so the installer's
  downgrade refusal is never tripped by a legitimate release.
- **Live install → upgrade → uninstall cycle:** **NOT TESTED.** No clean VM was available; a real
  `msiexec /i` would modify this developer machine (Program Files, registry, ARP), and no prior 2.1.0
  MSI exists in this environment to upgrade from. Settings/workspace-state preservation across upgrade
  is designed via the versioned store with `.bak` set-aside (RELEASE.md §5) but was not exercised by a
  real install here.

---

## 6. Remaining limitations

**Passed**

- Production MSI built (exit 0, 0 warnings) and structurally valid (name, metadata, payload, UpgradeCode).
- Pre-build + post-build artifact/security gates.
- Packaged-application smoke test: 17/21 `tests/real`, covering launch, native IPC, extension host
  lifecycle, full marketplace/trust/permissions/recovery, profiles, and Open VSX VS Code-compat
  install + activation + **webview** isolation.
- VS Code package functional path (status bar, runtime globals, grammar, edit, save) — all assertions
  except the OS-foreground step.

**Failed**

- None attributable to the product. The single consistent test failure (`vscode.spec`) is the
  OS-foreground assertion, classified as an environment limitation (§4).

**Not tested (environment / fixtures)**

- Live clean-VM install, upgrade-from-2.1.0, and uninstall cleanup (no clean VM; avoided mutating the
  real machine; no prior MSI).
- `webview-svg.spec`, `yaml.spec` — require real Open VSX VSIX downloads not present here.
- Real OS-foreground handoff (`vscode.spec` lines 327–330) — requires an interactive desktop session.

**Blocked by unavailable infrastructure**

- Code-signing (no signing cert/secret in this repo — by design) → installers unsigned; SmartScreen
  may warn. Prerequisite for any future in-app updater.
- A clean Windows VM / interactive CI runner for the OS-foreground and live-install validation. CI's
  `packaged` job (`windows-latest`) is the intended host for these; it is triggered on `v*` tags /
  `workflow_dispatch`, not from here.

**Release notes:** a 2.2.0 section has been added to `RELEASE_NOTES.md` (above the 2.1.0 entry) with
the MSI SHA-256 above, the unsigned status, and these limitations. The release owner finalises the
wording before publishing.

---

## 7. Final assessment

**VALIDATED WITH LIMITATIONS.**

The Windows x64 MSI for 2.2.0 **builds cleanly and is structurally valid**, and the packaged
application passes the authoritative end-to-end smoke test for launch, native backend, extension
host, marketplace/trust/permissions, profiles, and Open VSX VS Code-compat install with webview
isolation — **17 of 21 `tests/real`, 2 skipped**. The only consistent failure is an **OS-foreground
assertion that requires an interactive desktop** (it fails on `windows-latest` too), not a product
defect — the assertion was left unchanged, not weakened. CI is **not fully green**: `packaged` and
`release-gate` remain red on that one test.

**Exact remaining action required before release approval:**

1. Run the validation on a host with a **controllable interactive desktop** — the standard CI
   `packaged` job on `windows-latest` is **not** one (it fails the OS-foreground `vscode.spec` step
   the same way, confirmed) — so the OS-foreground path and a **live install → upgrade-from-2.1.0 →
   uninstall** cycle can execute.
2. **Code-sign** the MSI/NSIS with the release certificate (out of this repo).
3. **Release-owner approval** of the 2.2.0 `RELEASE_NOTES.md` wording and these limitations before
   publishing (the 2.2.0 section and MSI SHA-256
   `BEDA7292B341F3BAD94547181DAE6FAB1C8B7BF134F7B3358ADABB252EE7145A` are already in place).

The engineering fixes were committed and pushed to `main` (`504e252`, `fc4c2d9`, `fdce69b`); this
validation report and the 2.2.0 release notes are committed as a docs-only change. No tag was created
and no release was published.

---

## Addendum — CI validation (2026-11-10, workflow_dispatch runs)

The `Checks` workflow was run on `main` via `workflow_dispatch` (no tag). The first run surfaced
failures the local checks had missed, which were investigated and fixed:

- **A real UI regression (20 tests), now fixed.** WS28 made the Activity Bar a `role="tab"`
  tablist, so `getByRole("tab", { selected: true })` and one unscoped tab count matched it too (a
  strict-mode violation) across `lsp/monaco/search/settings`. An earlier `navigation.spec` fix was
  incomplete. Scoped all 16 occurrences to the editor tablist (`[aria-controls="editor-panel"]`)
  and refreshed the stale `monaco:746` menu expectation (it now correctly leads with Yavin's
  Call/Type Hierarchy actions, Command Palette still last). Verified green on CI (505 `ui` pass).
  **Correction:** the prior "487 Playwright pass" claim was inaccurate — the suite was red at
  `b6f2d9a`; CI caught it. Commits `504e252`, `fc4c2d9`.
- **rust job had no `npm ci`.** The `checkers` real_tests shell out to the project's TypeScript
  (`npx tsc`); without node deps, npx fetched the wrong `tsc` package and cancelled (1 of 602
  tests). Added `npm ci` to the `rust` job (commit `fdce69b`).
- **UI flakiness.** Two terminal tests (`terminal:4940` grammar render, `terminal:2663` menu open)
  intermittently exceed their 10s/30s timeout on the single-worker Windows runner. Added
  `retries: process.env.CI ? 2 : 0` to `playwright.config.ts` (commit `fdce69b`) — rescues flakes
  only; a deterministic failure still fails all attempts.

### Remaining CI blocker — `packaged` / `vscode.spec` (left unchanged by decision)

`tests/real/vscode.spec.ts:218` fails on the **`windows-latest`** runner with the same
`Fixture "trace recording" timeout … during setup` as locally. The trace shows every assertion
passing through the status bar, runtime globals, TextMate grammar, the edit command and save; it
stalls only at the **OS-foreground** poll (`expect.poll(nativeFocus).toBe(true)`, line 327) — the
packaged Yavin window cannot hold the real Windows foreground in a non-interactive CI session any
more than locally. One subsequent inventory test then cascades after the 180 s hard timeout.

This is an **environment limitation of the test, not a product defect**, and it was failing before
any of the above changes. It is **intentionally left unchanged** (not weakened or skipped). The
consequence: `packaged` → `release-gate` stays red on `workflow_dispatch`/CI until this test is made
foreground-environment-aware or run on a host with a controllable interactive desktop. The MSI build
and every other `tests/real` check (extension host, marketplace, trust, permissions, profiles,
recovery, Open VSX install, webview isolation) pass.

### Final CI state (run 42816236190, after the fixes)

On the latest `workflow_dispatch` run of `main` (`fdce69b`):

| Job                                 | Result                                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `version`, `registry`, `typescript` | success                                                                                                                       |
| `rust`                              | success — `npm ci` resolved the real_tests tsc failure; `cargo fmt` + Clippy (default + `test-registry`) + `cargo test` green |
| `ui`                                | success — the WS28 selector regression is fixed and the CI retries cleared the two terminal flakes                            |
| `packaged`                          | **failure** — `vscode.spec` OS-foreground only (documented above)                                                             |
| `mutations`                         | **success** (concluded after the first draft of this report; it also passed on run `42799063019`).                            |
| `release-gate`                      | fails, solely because `packaged` is red                                                                                       |

CI is therefore **not fully green**: `packaged` (and so `release-gate`) remains red on the one
OS-foreground `vscode.spec` assertion, by the documented decision to leave that test unchanged. Every
other required job is green.

---

## 2.2.1 — build, artifact validation and release (2026-11-11)

### Why 2.2.1

2.2.0 was prepared but never published (no release tag). Everything added to `main` after the 2.2.0
installer was built (`b6f2d9a`) is **test and CI only** — editor-tablist test selectors, Prettier and
Clippy cleanups, `npm ci` in the Rust CI job, CI-only Playwright retries, and the C1 CPU-cap test
margin. There is **no product behaviour change**, so the version was bumped as a patch (`13eb767`).

### Build

| Item            | Value                                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Command         | `npx tauri build` (exit 0)                                                                                                               |
| MSI             | `src-tauri/target/release/bundle/msi/Yavin IDE_2.2.1_x64_en-US.msi`, 11.6 MB                                                             |
| **MSI SHA-256** | **`0CA32B0461ED2CAF986F37DCBFCC5D4A669D80F5ADF8B5E94D3317E6A4F4ABD3`**                                                                   |
| NSIS            | `Yavin IDE_2.2.1_x64-setup.exe`, 8.4 MB                                                                                                  |
| Signing         | **NotSigned** (MSI and NSIS) — no certificate configured                                                                                 |
| Gates           | `release-version.mjs` (2.2.1 valid, above `v2.1.0`), `validate-artifact.mjs --installer auto` passed, Prettier clean, script tests 16/16 |

### Additional defect fixed since 2.2.0 — C1 CPU-cap test margin (`c2bbecf`)

`the_cpu_hard_cap_holds_under_sustained_load` asserted both that CPU may drift to `3 × wall`
(scheduling granularity over a short window) **and** that `cpu * 3 < wall * cores`. On a 4-core
runner the second demands under `1.33 × wall` — below the drift the first allows, and below what a
real one-core cap achieves (measured `cores=4 wall=1507ms cpu=2234ms`, i.e. `1.48 ×`). The two were
mutually unsatisfiable, so the test could fail while the cap held. Evidence it was the threshold and
not the cap: the same test passed in `cargo test --workspace` and failed minutes later in the
`--features test-registry` run of the same job, and that test does not use the feature. The margin is
now "at most half the uncapped budget", which stays compatible with the drift allowance and still
proves a 4-core spin was throttled to about one core. CI `rust` is green on that change.

### CI state at release

The last push-event run of `main` was **fully green** (`version`, `typescript`, `rust`, `ui`,
`registry`, `release-gate`). That run does **not** include `mutations` or `packaged`: GitHub skips
both on push events (they are gated to `v*` tags and `workflow_dispatch`). On the last
`workflow_dispatch` run, `mutations` passed and **`packaged` failed** on the `vscode.spec`
OS-foreground assertion. A tag run will therefore show a **red `release-gate`** for that reason.

### Released with known gaps

2.2.1 is published as the first 2.2.x build **with the following still unclosed** — this is not a
fully validated release:

- **No clean-machine install.** No clean-VM install, no upgrade-from-2.1.0 run, no uninstall test.
- **`packaged` CI gate red** on the `vscode.spec` OS-foreground assertion (environment limitation of
  the test; left unchanged, not weakened).
- **Installers unsigned** — SmartScreen will likely warn.
- The packaged smoke-test evidence is from the 2.2.0 build of the same product code; the 2.2.1
  installer was validated structurally and its payload inspected, but its packaged smoke test was
  not re-run.

Closing these requires a host with a controllable interactive desktop, a code-signing certificate,
and a live install/upgrade/uninstall cycle.
