# Yavin — Non-AI Engineering Progress

Continuous engineering log for Yavin's desktop IDE quality (AI/LLM functionality explicitly out of scope). Each entry records a concrete, verified change. Completed entries are not rewritten.

- Branch: `main` · started: 2026-11-05
- Rules in force: no commits/push; no `git add .`/reset/clean/stash/restore; protected search license files untouched; C2 registry stays empty; no test-only profiles in production; E6 not begun; no AI features.

---

## WS0 — Build environment recovery

**Context:** the post-consolidation (repo-flatten) audit found the Cargo `target/` cache carried absolute paths to the old `Yavin_2.0.0/…` location, breaking the Tauri build script (`os error 3`); `cargo fmt` failed on one line introduced by the flatten's URL path-fix; and 5 markdown files failed Prettier.

### WS0.1 — Prettier markdown formatting — ✅ DONE (verified)

- **Problem:** `prettier --check .` failed on `C2_DECISION_LOG.md`, `C2_FINAL_GATE_REVIEW.md`, `C2_PRODUCTION_PROFILE_REVIEW.md`, `C2_RELEASE_READINESS.md`, `GEMINI.md`.
- **Root cause:** the C2 docs were hand-authored without running Prettier; `GEMINI.md` pre-dated the check.
- **Change:** `npx prettier --write` on those 5 files (reformat only — no content/meaning change).
- **Tests/verify:** `npx prettier --check .` → **"All matched files use Prettier code style!"** (exit 0).
- **Files changed:** the 5 markdown files above.
- **Remaining:** none.

### WS0.2 — Cargo cache recovery + rustfmt — ✅ DONE (verified)

- **Problem:** stale `target/` absolute paths (to old `Yavin_2.0.0/…`) break the `yavin-ide` Tauri build script; `cargo fmt --check` fails at `src-tauri/src/registry_trust_tests.rs:1081` (from the flatten's URL path-fix).
- **Root cause:** `target/` was physically moved during the repo flatten; its cached artifacts embed absolute paths to the old location (`os error 3`). The URL edit shortened a line past rustfmt's wrap point.
- **Changes so far:**
  - `cargo clean` (in `src-tauri/`) — removed the stale `target/` (build artifacts only; `target/` is gitignored, 0 tracked files). Exit 0.
  - `cargo fmt --all` — reformatted `src-tauri/src/registry_trust_tests.rs` (only file changed). `cargo fmt --all --check` → **exit 0** ✅.
- **Status:** full `cargo build --workspace` rebuild running (verifies the binary builds with a fresh cache). Test suite / clippy / Tauri build to follow.

---

## WS6 Part 2 — Native DAP TCP transport + js-debug bridge — ✅ IMPLEMENTED + VERIFIED (transport exercised for real via a node DAP server)

**Goal:** the native infrastructure to run JavaScript/TypeScript debugging through js-debug, which speaks DAP over **TCP** while Yavin's host speaks **stdio** — the exact blocker Part 1 identified. Done without a second DAP client or session manager, and without downloading js-debug.

**Transport abstraction — reuse, not a second client.** `ServerProcess::run` (`ide-workspace/src/lsp_process.rs`) was already generic over its I/O streams (`impl Read`/`impl Write`) and owns the framing, the reader thread, request/response ordering, size limits (`FrameReader`: `MAX_MESSAGE` 64 MB / `MAX_HEADER` 8 KB), EOF/disconnect handling and the one-time exit report. So the only new primitive is **`ServerProcess::from_tcp(child, stream, events)`**: it drives that same machinery from a **TCP socket** instead of child stdio — the socket's two halves are the framed read/write, the child's own stdout/stderr become logs, and the child stays owned for process-tree cleanup (the Windows Job Object). No framing, sequencing, session ownership or lifecycle logic is duplicated.

**js-debug TCP bridge (`src-tauri/src/dap.rs`).** Native-owned, loopback-only:

- `ephemeral_loopback_port()` binds `127.0.0.1:0`, reads the OS-chosen port, releases it — an **ephemeral** port; the renderer never supplies a port or address.
- `start_tcp_node_adapter()` starts `node <dapDebugServer.js> <port> 127.0.0.1` in the servers' Job Object, then `connect_loopback()` connects to `127.0.0.1:<port>` with a 15 s deadline and retry; on a failed connect the child is `kill_tree`-d so nothing is left running. **Loopback only, bounded, no external exposure, not a general-purpose proxy.** Success bridges the socket into `ServerProcess::from_tcp`.
- `dap_start` branches on the adapter's transport (`node_entry`): a TCP adapter goes through the bridge, a stdio adapter (debugpy) through `ServerProcess::spawn` — the result is one `ServerProcess` the session owns identically.

**Adapter registration + availability (the complete launch path).** The native allow-list gains **`node`** (`program: "node"`, `node_entry: node_modules/@vscode/js-debug/src/dapDebugServer.js`), kept in sync with the renderer (`adapters.ts`; the `include_str!` consistency test covers it). `dap_available_adapters` now reports an adapter only when its **whole** path resolves — for `node`, the `node` binary **and** js-debug's server entry installed in the workspace; a bare `node` without js-debug is **not** enough. So JavaScript debugging is available only once js-debug is actually installed, and the renderer's availability gate (WS6 Part 1) turns the frameworks on exactly then.

**Security:** loopback-only ephemeral ports; no renderer-supplied endpoint or adapter path; workspace trust still enforced before any adapter starts (`require_trust` in `dap_start`); process-tree cleanup via the Job Object + `from_tcp`'s socket/child ownership; message-size limits unchanged (reused `FrameReader`). Not a general TCP proxy — the bridge only connects the one adapter it just started on a port it chose.

**js-debug resolution & provenance (documented, never auto-installed):** the server entry is resolved **workspace-local** at `node_modules/@vscode/js-debug/src/dapDebugServer.js`; install via `npm install -D @vscode/js-debug` (Microsoft, npm). The entry's presence is required for availability; a path is not trusted merely because it exists (workspace trust gates the launch). Automatic download/execution of adapter binaries is never done.

**Verification — all green:**

- **Native — `cargo test --lib dap:: -- --test-threads=1` → 9 passed, 0 failed.** The headline: **`the_tcp_bridge_carries_a_real_dap_exchange_with_a_node_server`** — a tiny **real Node TCP DAP server** (written as a local fixture, the same transport shape as js-debug, nothing downloaded) is started by the **real bridge** (ephemeral port → child launch → connect → `from_tcp`), exchanges framed `initialize`/response over the socket, and is cleanly stopped. Plus `adapter_availability_reflects_the_whole_launch_path_not_just_the_binary` (node present but js-debug entry absent → unavailable; entry installed → available), `connect_loopback_times_out_on_a_port_nothing_listens_on` (invalid endpoint), and `only_a_listed_adapter_can_be_started` (allow-list + native↔renderer consistency with the new `node`).
- **Native regression — `cargo test -p ide-workspace lsp_process::` → 10 passed** (the stdio transport is unaffected by the `from_tcp` addition); **`cargo test --lib test_runner::` → 37 passed**; `cargo fmt --all --check` exit 0; `cargo clippy --lib -p yavin-ide -p ide-workspace --all-features -- -D warnings` → **exit 0**.
- **Frontend — unchanged (Part 1 gating already consumes the probe): `node --test` debugRequest + platform → 26 passed; `tsc` exit 0; Playwright panel → 2 passed.**

**Real vs. simulated:** the **TCP transport bridge is exercised for real** — against a genuine Node DAP server over a genuine loopback socket, end to end (connect, framed exchange, cleanup). What remains **simulated/unexercised** is a **real js-debug attachment to a real Node debuggee** (js-debug is not installed; no download allowed) — stated plainly, not claimed. The stand-in proves the transport; js-debug itself speaks the same DAP-over-TCP, so once installed the same bridge carries it.

**Files changed:** `src-tauri/crates/ide-workspace/src/lsp_process.rs` (`ServerProcess::from_tcp` + `TcpStream` import), `src-tauri/src/dap.rs` (`node` adapter + bridge + availability + tests). No change to the renderer (Part 1 already registers `node` and gates on the probe), the DebugService core, breakpoint manager, protected files, or C1/C2.

**Known limitations / next:** (1) **real js-debug attachment is unverified** (not installed; no download) — the transport is proven, the adapter integration awaits an install; (2) js-debug’s server entry path is the standard workspace-local one — a global/other install location is a follow-up; (3) **Rust DAP (lldb-dap + Cargo test-executable resolution)** is the next independent slice (lldb-dap speaks stdio, so it needs no bridge — it fits `ServerProcess::spawn` directly), to be done separately per the spec.

---

## WS6 — Multi-language Debugging Platform — ◧ PART 1 (JavaScript/TypeScript architecture + availability gating) IMPLEMENTED + VERIFIED

**Goal:** extend the DAP subsystem beyond debugpy to JavaScript/TypeScript (and Jest/Vitest/Playwright tests) and Rust (Cargo tests), as a unified experience. Done **incrementally**: Part 1 = the adapter architecture + availability gating + JavaScript routing (this entry); Part 2 = Rust (lldb-dap + Cargo test-executable resolution).

**Decisive environment findings (traced first):** **no debug adapter is installed** — no `@vscode/js-debug` (JavaScript), no `lldb-dap`/`codelldb`/`gdb` (Rust), and no real Python/debugpy. Downloads of unverified adapter binaries are forbidden. So **no real JS/Rust/Python attachment can be exercised here** — reported honestly, not faked. A second architectural finding shaped the design: **Yavin's DAP host is stdio-based** (debugpy and lldb-dap speak DAP over stdio and fit it directly), but **js-debug speaks DAP over a TCP socket** — so JavaScript debugging additionally needs a stdio↔TCP bridge, a tracked follow-up. JavaScript debugging is therefore reported unavailable even where `node` is present, which is correct.

**Availability gating — the core WS6 mechanism (honors "do not enable a framework simply because its adapter is registered"):** two distinct gates now exist. **Registration** = Yavin knows an adapter's protocol (the capability). **Availability** = the adapter's binary actually resolves on this machine, from a new native probe. A framework is enabled only when both hold; a registered-but-not-installed adapter is reported unsupported **with how to install it**.

- `src-tauri/src/dap.rs` — new `dap_available_adapters(root)` command: for each allow-listed adapter, reports it available only when its program resolves (a Python interpreter for debugpy; the program on PATH/workspace-local otherwise). Registered in `lib.rs`. Here it returns `[]` (no Python, nothing installed), so every framework is honestly gated off.
- `src/services/testing/debugRequest.ts` — `testDebugSupport(adapterId, available?)` is now availability-aware: with the probe's set it returns unsupported + install hint when the mapped adapter is registered but absent; without it, the pure capability (for unit tests). Single source of truth, unchanged for callers that pass nothing.
- `platform.ts` / `useTestingPlatform.ts` — the debug dependency carries `availableAdapters` (fetched from the native probe); `debugSupport()` and `debugNode()` gate on it; the UI's Debug button reflects the gated result.

**JavaScript/TypeScript adapter (`src/services/debug/adapters.ts`):** registered the **`node`** adapter definition (js-debug / `pwa-node`): launch args with `sourceMaps: true` (breakpoints bind in original TypeScript), `skipFiles: ["<node_internals>/**"]` (stepping stays in user code), `console: "internalConsole"`, and attach args. Install/provenance: `npm install -D @vscode/js-debug`. It is **renderer-registered for routing/capability but intentionally not in the native stdio allow-list yet** (the TCP-bridge follow-up), so the probe never reports it available — JS debugging stays honestly unsupported.

**Debug Test routing + launch configs (`debugRequest.ts`):** Jest/Vitest/Playwright → `node`; pytest → `debugpy` (WS5.5); Cargo → `lldb` (not registered until Part 2). `buildTestDebugConfiguration` builds a **node-backed** launch per runner — Jest `node_modules/jest/bin/jest.js --runInBand <file> -t <name>`, Vitest `node_modules/vitest/vitest.mjs run <file> -t <name>`, Playwright `node_modules/@playwright/test/cli.js test <file> -g <title> --workers=1 [--project <p>]` — each launching only the selected test, the file confined to the workspace by the DebugService, the test name/title/project as **opaque arguments**, never a shell string. (These run only when js-debug + the bridge land; they are gated off here.)

**Security boundaries (unchanged, extended):** the renderer selects an allow-listed adapter id; it never supplies an executable path, adapter path, shell command, or unrestricted env. Native code owns adapter resolution (the existing `program_for` + the new probe), workspace trust is enforced before any adapter starts, and the Job-Object process-tree cleanup / stdio framing are reused. No second process manager; no silent downloads.

**Source maps / ResourceUri:** the `node` adapter sets `sourceMaps: true` and the DebugService already normalizes a stack frame's `source.path` to the canonical `ResourceId` (`frameView` → `resourceId(fileUri(path))`), so TypeScript original-source navigation and breakpoint rebinding reuse the one identity rule — no per-adapter path logic added.

**Verification — all green:**

- **Frontend — `node --test` (testing + debug + panel) → 141 passed, 0 failed.** New/updated: `debugRequest.test.ts` (11 — capability mapping, **availability gating** both ways, node launch configs with opaque args, unsupported-throws), `platform.test.ts` (availability-gated debug: unsupported when the adapter is not installed, supported+launched when it is), `debugIntegration.test.ts` unchanged-green. `tsc --noEmit` exit 0; `prettier --check` clean.
- **Native — `cargo test --lib dap:: -- --test-threads=1` → 6 passed** (incl. `only_a_listed_adapter_can_be_started`: the native↔renderer allow-list stays consistent with the new `node` renderer entry; the real-debugpy test **skipped**, no usable Python). **`cargo test --lib test_runner:: → 37 passed.`** `cargo fmt --all --check` exit 0; `cargo clippy --lib --all-features -- -D warnings` **exit 0**.
- **Playwright UI panel tests → 2 passed** (`terminal.spec.ts`, 5.9 s).

**Real vs. simulated:** **no real debugger attachment was exercised** (no JS/Rust adapter, no usable Python) — stated plainly, not claimed. The architecture, routing, availability gating and launch configs are verified by **unit tests + fake adapters**; the real debugpy path is covered by the existing `realAdapter.test.ts`/`dap.rs` tests (which skip here). The availability probe is a real end-to-end mechanism (it genuinely returns `[]` here).

**Installation & provenance (documented, never auto-installed):** JavaScript → `@vscode/js-debug` (Microsoft, npm) **plus** a Yavin stdio↔TCP bridge (follow-up); Python → `debugpy` (`pip install debugpy`) + a Python interpreter; Rust (Part 2) → `lldb-dap` (LLVM) or CodeLLDB. None are downloaded; each is reported unavailable with its install command.

**Files changed:** edited `src/services/debug/adapters.ts` (node adapter), `src/services/testing/debugRequest.ts` (+test; routing + availability + node configs), `src/services/testing/platform.ts` (+test; availability gating), `src/services/testing/useTestingPlatform.ts` (probe fetch), `src/services/native.ts` (probe type), `src-tauri/src/dap.rs` (+`dap_available_adapters`), `src-tauri/src/lib.rs` (command registration). No change to the DebugService core, breakpoint manager, process authorization, protected files, or C1/C2.

**Known limitations / Part 2:** (1) **JavaScript debugging needs the stdio↔TCP bridge for js-debug** + js-debug installed — not wired here; (2) **Rust (`lldb` adapter + Cargo test-executable resolution via `cargo test --no-run --message-format=json`)** is Part 2 (cargo is installed, so that resolution is the next genuinely-verifiable piece); (3) no real attachment verified in this environment. **Next: WS6 Part 2 — Rust debugging**, then real-environment attachment verification.

---

## WS5.5 — Native pytest testing adapter — ✅ IMPLEMENTED + VERIFIED (parser/authorization real; pytest/debugpy execution gated on Python)

**Goal:** pytest as a first-class Testing Platform adapter — discovery, run all / file / individual node id, rerun failed, parameterized tests, module/class hierarchy — plus **real Debug Test through the existing debugpy adapter**, on the WS5.1 native execution authority and shared model. No second process manager.

**Environment reality:** **no Python is installed on this machine** (only the Windows Store alias), so — like Jest/Vitest — **real pytest execution and real debugpy attachment cannot be exercised here**; they are honestly skipped/reported. The parser, native authorization, Python/venv resolution, the result-file read path, and the debug config are fully built and verified by **fixtures and fake executors** (exactly the split the spec calls for).

**Dedicated parser (`pytestJson.ts`, new + 8 tests)** — for the `pytest-json-report` plugin's shape (`tests[]`, `collectors[]`, phases `setup`/`call`/`teardown`). Normalizes: the **node id** (`path::Class::test[param]`) into file + class ancestry + test name; **module/class hierarchy**; all statuses (passed / failed / **xfailed**→skipped / **xpassed**→passed / skipped / error→failed); **parameterized** identity (the `[param]` stays in the label and id); duration (phase sum); failure **traceback** (`longrepr`) and **crash location**; **stable ids** (file + node-id tail). **Collection/import errors kept distinct from test failures** — a failed `collectors[]` entry → `diagnostics` (+ `compiled=false` when nothing ran). A **clear dependency state**: output showing `unrecognized arguments: --json-report` throws a typed "install pytest-json-report" error, not a silent empty suite. Tolerant of noise, truncation, empty (typed `TestParseError`).

**Adapter (`adapters.ts` + 2 tests):** `pytestAdapter` detects `pytest.ini` / `conftest.py` / `tox.ini` / `setup.cfg` / `pyproject.toml`; its `command()` sends a minimal selector (`[]` / `["--file", f]` / `["--node", "<file>::<tail>"]`), reconstructing the **full node id** from the tree. `parse = parsePytestJson`.

**TreeProvider fix (correctness, benefits every adapter):** the tree now uses each case's **own stable id from its parser** instead of recomputing `caseId(file, label-joined-by-space)`. That recomputation silently corrupted identities whose real form isn't space-joined — **Cargo's `a::b::test`** and pytest node ids — so `runNode`/`rerunFailed` would have filtered by the wrong name. Jest/Vitest/Playwright ids are unchanged (they were already space-joined).

**Native (`test_runner.rs`): `Grammar::Pytest` + `authorize_pytest` + `resolve_python` + result-file reading.** The renderer sends only the selector; the native side rebuilds `python -m pytest --json-report --json-report-file <temp> -p no:cacheprovider [<file>|<node id>]`. A **file** is containment-validated; a **node id's path** (before the first `::`) is containment-validated and the rest (classes/test/`[param]`) is **one opaque token** with no control characters; anything else is rejected. **Python is resolved by trusted discovery** — a workspace `.venv`/`venv` first, then `python`/`python3`/`py` on PATH — never named by the renderer. pytest writes JSON to a **native temp file** (OS temp, not the workspace), which `execute` reads back and deletes; when it is absent (plugin missing / cancelled) the process's stderr surfaces instead. Reuses the whole WS5.1 lifecycle unchanged (`TestRuns` ids/ownership/concurrency/supersede/stale-protection, `capture_classified` bounded output + deadline + process-tree kill, shutdown hook).

**Real Debug Test through debugpy (§5).** pytest is the first framework that maps to Yavin's actual DAP adapter (debugpy). To launch it correctly the debug contract gained an optional **`module`** field (`config.ts` + `debugpy` launch args + validation: a launch needs a `program` **or** a `module`); the pytest debug config is `{ adapter: debugpy, module: "pytest", args: ["<file>::<node id>"] }` — pytest's own machinery runs the selected node id, the node id is **one opaque argument**, the interpreter is resolved by the native debugpy adapter (venv first), and breakpoints bind through the normal DAP flow. `testDebugSupport("pytest")` is **supported** (the capability — debugpy adapter + correct launch — genuinely exists), consistent with how Yavin treats all debugpy debugging (a missing Python/debugpy surfaces a clear runtime error).

> **Honest boundary on §5's "do not mark supported until real attachment is exercised":** real debugpy attachment to a real pytest process was **NOT exercised** here — no Python/debugpy on this machine. The capability is implemented and **verified against the fake DAP adapter** (a full launch→breakpoint→stop→step→cleanup session with the module launch + node id), and the existing `realAdapter.test.ts` covers real debugpy when available (it **skipped** here, reported). Real pytest+debugpy attachment is the one remaining verification, gated on a Python environment; it is not claimed to work.

**UI:** pytest flows through the existing Testing panel unchanged — class/module **hierarchy** (ancestors → tree suites), **parameterized** tests (the `[param]` label), **tracebacks** (failure detail pane), **collection/import errors** (the framework-neutral "tests could not run" panel from WS5.4), source navigation, and the **Debug Test** action (enabled for pytest). Detection message now mentions Python.

**Three-level verification — all green:**

- **Level A/B — `cargo test --lib test_runner:: --test-threads=1` → 37 passed, 0 failed.** New pytest tests: `authorize_pytest` accepts all/file/node and validates the path; **rejects unknown flags, a non-`::` node id, control characters, and a traversing path**; a metacharacter node id stays one argv element; `resolve_python` finds a workspace `.venv` first; **result-file reading** (a fixture writes the JSON file → it is read over stdout and deleted) and the **plugin-missing fallback** (no file → stderr surfaces) — both via fake-executor fixtures. All WS5.1–5.4 native tests still pass.
- **Level C — real pytest / real debugpy: SKIPPED (no Python).** Reported in the parser/authorization coverage note, not hidden. (Cargo's and Playwright's real Level C runs still pass from WS5.2/5.4.)
- **Frontend — `node --test` (testing + debug + panel + realAdapter) → 139 passed, 0 failed, 1 skipped** (the real-debugpy test, no Python). New: pytestJson 8, adapters +2, debugRequest updated for the module launch, platform/debugIntegration updated. `tsc --noEmit` exit 0; `prettier --check` clean.

**Verify (exact, sequential):**

- `cargo test --lib test_runner:: -- --test-threads=1` → **37 passed, 0 failed** (11.3 s).
- `cargo fmt --all --check` → exit 0; `cargo clippy --lib --all-features -- -D warnings` → **exit 0**.
- `node --test` testing+debug+panel+realAdapter → **139 passed, 0 failed, 1 skipped**; `tsc` exit 0; `prettier --check` clean.
- Playwright UI panel tests → **2 passed** (`terminal.spec.ts`, 5.4 s).

**Files changed:** new — `src/services/testing/pytestJson.ts` (+ `.test.ts`). Edited — `src/services/testing/{adapters,treeProvider,debugRequest,platform}.ts` and their tests, `src/services/testing/debugIntegration.test.ts`, `src/services/debug/{config,adapters}.ts` (the `module` launch field), `src/components/panel/views/TestingView.tsx` (detection message), `src-tauri/src/test_runner.rs`. No change to `dap.rs`, the DebugService core, `checkers.rs`, process/terminal/task/diagnostics infra, ResourceUri, protected files, or C1/C2.

**Python interpreter discovery:** workspace `.venv`/`venv` (Scripts/bin + python[.exe]) → `python`/`python3`/`py` on PATH. **JSON reporting strategy:** the standard `pytest-json-report` plugin, written to a native temp file and read back; a missing plugin is reported as a clear dependency state, never a silent empty suite. No dependency is installed or downloaded.

**Limitations / follow-ups:** (1) **no local Python** → real pytest execution and real debugpy attachment unverified here (reported, not claimed); (2) requires the user to have `pytest-json-report` installed — surfaced as a clear message otherwise; (3) a custom `pytest` rootdir/`testpaths` differing from the workspace root could affect node-id path resolution (a follow-up); (4) real pytest+debugpy attachment is the remaining §5 verification, gated on a Python environment.

**Next:** **WS6 — Multi-language Debugging** (adding JavaScript/Rust DAP adapters lights up Jest/Vitest/Cargo/Playwright debugging, and a real Python environment verifies pytest+debugpy attachment).

---

## WS5.4 — Native Playwright testing adapter — ✅ IMPLEMENTED + VERIFIED (real Playwright run exercised)

**Goal:** Playwright as a first-class Testing Platform adapter — discovery, run all / file / test, rerun failed, browser/project labels, retries & flaky — on the existing native execution authority (WS5.1) and shared model. No second process manager.

**Playwright is installed here** (`@playwright/test ^1.63.0` + `playwright.config.ts`), so **real Level C execution was exercised**, not simulated.

**Dedicated parser (`playwrightJson.ts`, new + 9 tests):** Playwright's official JSON reporter is a distinct shape (nested `suites[].suites[]` with the file as the outer suite; each `spec` runs once per **project/browser** in `tests[]`, each with per-retry `results[]`), so it has its own parser — not forced into the jest/vitest one. It normalizes: a case = one spec × one project; **suite hierarchy** → ancestors (the file-level suite dropped); status `expected`→passed / `unexpected`→failed / `flaky`→passed+flagged / `skipped`→skipped; the **final attempt's** duration; failure message/stack and **source location**; browser/**project** label; **stable ids** (file + full title + project, identical across runs). **Config/discovery errors are kept distinct from test failures** — top-level `errors[]` with nothing run → `diagnostics` + `compiled=false` (a setup failure, "not silently an empty suite"), while errors alongside real results stay as diagnostics without hiding the tests. Tolerant of banner noise, truncation, and empty output (typed `TestParseError`).

**Model:** `TestCase` gains optional `project` and `flaky`; `TestReport.compiled`/`diagnostics` doc generalized to "setup failure (compilation for Cargo, configuration/discovery for Playwright)". Backward compatible.

**Adapter (`adapters.ts` + 2 tests):** `playwrightAdapter` detects `playwright.config.*`; its `command()` emits a minimal selector encoding (`[]` / `["--file", f]` / `["--file", f, "-g", title, ("--project", name)?]`) — splitting the `[project]` suffix out of a case's full name into a `-g <title>` grep + `--project <name>` filter. `parse = parsePlaywrightJson`. The shared SECURITY test now also covers Playwright (a metacharacter title stays one argv element).

**Native (`test_runner.rs`): `Grammar::Playwright` + `authorize_playwright`.** The renderer sends only the minimal selector; the native side **rebuilds the real argv** `playwright test --reporter=json [<file>] [-g <title>] [--project <name>]`. The spec file is **containment-validated** (`validate_path`); the grep title is **one opaque argv element**; the project name is validated by `is_playwright_project` (bounded, no control chars, not a flag — but may contain spaces like "Mobile Chrome") and passed as one opaque argument. Unknown flags, extra args, env, config paths and executables are rejected. `playwright` is resolved from the project's own `node_modules/.bin` (`node_package:true`) — never a renderer path. Reuses the whole WS5.1 lifecycle unchanged (`TestRuns` ids/ownership/concurrency/supersede/stale-protection, `capture_classified` bounded output + deadline + process-tree kill, shutdown hook).

**Discovery states** are distinguished, not collapsed into "empty suite": Playwright **not installed** → native `resolve_program` fails → clear "No playwright runner found" error; **config/discovery error** → `compiled=false` + diagnostics (shown as "The tests could not run — N errors"); **zero tests with no error** → an honest empty report.

**UI (`TestingView.tsx`, `treeProvider.ts`):** the project/browser shows in each case label (`title [chromium]`); a **flaky** badge marks tests that passed only on retry; the setup-error panel wording is now framework-neutral ("The tests could not run — N errors (compilation or configuration)"). Run All / file / test, Stop, Rerun Failed, and failure navigation are unchanged for all adapters.

**Browser-debugging boundary (§7):** Playwright runs its tests in a **Node.js worker (JavaScript)**, so it needs the same JavaScript DAP adapter Yavin does not have — `testDebugSupport("playwright")` returns **unsupported** with a precise reason, and Debug Test stays disabled. No improvised debugger; process authorization untouched. (Debugging the browser itself is a separate, out-of-scope concern.)

**Three-level verification — all green:**

- **Level A/B — `cargo test --lib test_runner:: --test-threads=1` → 31 passed, 0 failed.** New Playwright tests: `authorize_playwright` builds the JSON run for all/file/grep/project; **validates the file (rejects `../../etc/passwd`), rejects `--headed`/extra args/a flag-shaped or empty project**; a metacharacter grep stays one argv element; `is_playwright_project` rules (spaces allowed, flags/control-chars refused). All WS5.1/5.2 native tests still pass.
- **Level C — real Playwright: RAN (not skipped).** `level_c_real_playwright_runs_a_fixture_project_when_installed` wrote a dependency-free fixture (a `playwright.config.ts` with one browserless `node` project and a spec with a passing and a failing test — no `page` fixture, so **no browser is launched or downloaded**), resolved the repo's own `playwright` binary, ran the **real authorized argv**, and asserted genuine reporter JSON: `LEVEL C (playwright): ran a real Playwright project and got reporter JSON.` (0.82 s).
- **Frontend — `node --test` (testing + debug + panel) → 130 passed, 0 failed** (playwrightJson 9, adapters 8, treeProvider +1 flaky, debugRequest +1 playwright-unsupported, + the rest). `tsc --noEmit` exit 0; `prettier --check` clean.

**Verify (exact, sequential):**

- `cargo fmt --all --check` → exit 0.
- `cargo test --lib test_runner:: -- --test-threads=1` → **31 passed, 0 failed** (2.71 s).
- `cargo test --lib test_runner::real_tests::level_c_real_playwright -- --nocapture` → **1 passed**, printed the real-run confirmation (0.82 s).
- `cargo clippy --lib --all-features -- -D warnings` → **exit 0 (no warnings)**, 49 s.
- `node --test` testing+debug+panel → 130 passed; `tsc` exit 0; `prettier --check` clean.
- Playwright UI panel tests (TestingView changed) → **2 passed** (`terminal.spec.ts`, 7.5 s).

**Files changed:** new — `src/services/testing/playwrightJson.ts` (+ `.test.ts`). Edited — `src/services/testing/{model,adapters,treeProvider}.ts` and their tests, `src/services/testing/debugRequest.ts` (+test, playwright unsupported), `src/components/panel/views/TestingView.tsx`, `src-tauri/src/test_runner.rs`. No change to `checkers.rs`, `dap.rs`, process/terminal/task/diagnostics infra, ResourceId, protected files, or C1/C2.

**Real vs. simulated:** the parser and authorization are verified by fixtures (deterministic); **native Playwright execution is real** (a genuine `playwright test` run parsed end-to-end). Jest/Vitest real execution remains unavailable (not installed); Cargo real execution is real (WS5.2).

**Limitations / follow-ups:** (1) Playwright's JSON `file` is relative to the config's `rootDir`; a custom `rootDir` that differs from the workspace root could mis-resolve the positional file filter — a monorepo follow-up; (2) per-project tree grouping is by file, not by project (projects distinguish cases via label/id); (3) Playwright test **debugging** awaits a JavaScript DAP adapter (WS6), honestly gated now.

**Next:** **WS5.5 — pytest integration** (which also turns Debug Test real via debugpy), then **WS6 — Multi-language Debugging**.

---

## WS5.3 — Debug Test integration through DAP — ✅ IMPLEMENTED + VERIFIED (mechanism proven; frameworks honestly gated)

**Goal:** let a developer select one test and debug it through Yavin's existing DAP subsystem, reusing the DebugService/session manager — no second debugger, process manager or session registry.

**Decisive architectural finding (traced first):** Yavin ships **exactly one DAP adapter — `debugpy` (Python)**. Both the renderer allow-list (`src/services/debug/adapters.ts`) and the native allow-list (`src-tauri/src/dap.rs`, which even `include_str!`s the renderer file to stay in lock-step) contain only `debugpy`. Therefore **none of the current test frameworks can be debugged**: Jest/Vitest are JavaScript (need a JS debug adapter Yavin doesn't have) and Cargo is Rust (needs a native/LLDB adapter Yavin doesn't have). Per the brief, these are reported **unsupported with a precise reason — never faked**. The mechanism lights up for Python (pytest, WS5.5) the moment that test adapter exists, and for JS/Rust when such a DAP adapter is added. **No new Rust was written** — WS5.3 reuses `dap.rs` and the DebugService unchanged except for one additive seam.

**Integration seam (frontend):**

- **`debugRequest.ts` (new, +9 tests)** — the typed Debug Test contract and authorization. `TestDebugRequest` carries only identity (adapter id, stable case id, workspace, file, full name, line). `testDebugSupport(adapterId)` is the single source of truth: it maps each framework to its intended DAP adapter and returns `supported:false` with a reason when that adapter is not in `DEBUG_ADAPTERS` (vitest/jest → "JavaScript debug adapter … Yavin does not have"; cargo → "native (LLDB) …"; pytest → debugpy, supported). `authorizeTestDebug` **rejects a workspace mismatch, an unsupported framework, a stale/unknown case id, and an empty selector** — renderer-supplied metadata is never trusted as authorization. `buildTestDebugConfiguration` produces a `ResolvedDebugConfiguration` whose `adapter` is an **allow-listed** DAP id (never a renderer path), whose `program` is the test's own file (the DebugService confines it to the workspace at launch), and whose test name is **one opaque argv element**, never a shell string.
- **`DebugService.start`** — one additive change: `start(config?: string | ResolvedDebugConfiguration)`. A string/undefined resolves from the configured list (unchanged); an **object launches that ad-hoc configuration** (not persisted) through the entire existing lifecycle — trust gate, adapter resolution, path containment, breakpoints, `configurationDone`, events, cleanup. Backward compatible (all 29 existing debug tests pass unchanged).
- **`platform.ts`** — `canDebugNode(node)` and `debugNode(node)`: authorize against the **current** results (`allCaseIds` from the live tree, so a stale id is caught), build the config, hand it to an injected `TestDebugDependency.start`. View-state gains `debug: TestDebugSupport` so the UI can gate the action. Absent debugger ⇒ reported "Debugging is not available in this window."
- **`useTestingPlatform.ts` / `TerminalPanel.tsx`** — the hook wires the DAP seam to the workspace `DebugService.start`; the view's `onDebugStarted` focuses the Debug panel (`setActiveTab("debug")`).
- **`TestingView.tsx`** — a **Debug** (🐞) action on each test-case row: enabled only when the framework is supported, otherwise **disabled with the reason as its tooltip** (honest, not hidden). A launch error shows in a dismissible banner. Run/Stop/Rerun Failed and the pass/fail counts are unchanged; starting a debug session never marks a test passed or failed.

**Supported / unsupported (today):**

- **Jest / Vitest — unsupported:** no JavaScript debug adapter in Yavin. Reason shown; Debug button disabled.
- **Cargo — unsupported:** no native (LLDB) debug adapter in Yavin. Reason shown; Debug button disabled.
- **Python (pytest, WS5.5) — supported design:** debugs through debugpy; `testDebugSupport("pytest")` already returns supported, so the adapter lights up with no further debug work.

**Security boundaries:** the renderer controls only _which allow-listed test it selects_; it cannot choose an executable path, a DAP adapter path, arbitrary args, env, or shell. The DAP adapter program comes from `dap.rs`'s allow-list, the launch `program` is confined to the workspace by `DebugService.resolvedPaths`, the test name is a single opaque argument, trust is checked before anything starts, and a stale/forged id or workspace mismatch is rejected.

**Verification — all green:**

- **`node --test` (testing + debug + panel): 118 passed, 0 failed.** New: `debugRequest.test.ts` (9 — support mapping, authorization rejections, allow-listed adapter, one-arg injection, no-fabrication), `debugIntegration.test.ts` (5 — a Debug Test config drives a **real session through the fake DAP adapter**: launch with the test name as a structured arg, breakpoint binds and stops on its line, step, independent services don't interfere, untrusted refused, forged adapter rejected), `platform.test.ts` (+5 debug — unsupported JS reason, no-debugger reason, supported launch builds the right config, stale-id rejected, non-case refused). The existing 29 DebugService tests pass unchanged.
- **`tsc --noEmit` → exit 0; `prettier --check` → clean** (all touched files).
- **No Rust changed** (git confirms only WS5.1/5.2 Rust files are modified); `cargo fmt --all --check` → exit 0. The native test/clippy suites are unaffected and remain green from WS5.2 (not re-run, since no Rust changed).
- **Playwright (panel tabs): 2 passed.** WS5's new "TEST RESULTS" tab had broken two assertions in `tests/ui/terminal.spec.ts` (an exact tab-list and the per-view loop) that WS5 never ran — and, more seriously, the first Playwright run of the tab surfaced a **real WS5 defect**: opening the Test Results view threw "Maximum update depth exceeded" (an infinite React loop) because `platform.getViewState()` returned a fresh object on every call and `useSyncExternalStore` requires a reference-stable snapshot. **Fixed** by caching the view-state in the platform and invalidating it on change (plus a regression test, `platform.test.ts`: "getViewState returns a stable reference until something changes"). After the fix both panel tests pass (5.4 s).

**Real debugger attachment:** **not exercised for the current frameworks** — no JS/Rust adapter exists to attach to a Jest/Vitest/Cargo test process, and no Python test runner exists yet to attach debugpy to. This is stated plainly, not claimed. The integration **mechanism** is proven end-to-end against the fake DAP adapter (a full launch→breakpoint→stop→step→cleanup session), and the real debugpy path is already covered by the existing `realAdapter.test.ts`. Real attachment to a test process becomes exercisable with the pytest adapter (WS5.5).

**Files changed:** new — `src/services/testing/debugRequest.ts` (+ `.test.ts`), `src/services/testing/debugIntegration.test.ts`. Edited — `src/services/debug/service.ts` (ad-hoc `start`), `src/services/testing/platform.ts` (+ test), `src/services/testing/useTestingPlatform.ts`, `src/components/panel/views/TestingView.tsx`, `src/components/layout/TerminalPanel.tsx`, `tests/ui/terminal.spec.ts` (tab assertions). No change to `dap.rs`, the DAP adapters, native process authorization, ResourceUri, or protected files. C1/C2 untouched; registry empty; E6 not begun.

**Limitations / follow-ups:** (1) no debuggable framework ships today (debugpy-only) — the honest gate above; (2) the precise per-runner debug invocation (pytest module mode, a JS adapter's test-file launch) is finalized with each runner's adapter; (3) adding a JavaScript (`js-debug`) or Rust (`lldb`) DAP adapter — a native allow-list + protocol addition — is what unlocks Jest/Vitest/Cargo debugging.

**Next workstream:** **WS5.4 — Playwright testing integration** (adapter + JSON reporter parser, reusing the WS5.1 native execution authority), then **WS5.5 — pytest** (which also turns Debug Test real via debugpy), then **WS6 — Multi-language Debugging** (where adding JS/Rust DAP adapters lights up the rest of Debug Test).

---

## WS5.2 — Native Cargo test adapter — ✅ IMPLEMENTED + VERIFIED (real nightly Cargo run exercised)

**Goal:** Cargo as a first-class Testing Platform adapter — discover, run, cancel, parse, display, rerun Rust tests — on the existing native execution authority and shared result model, with its own parser. No second process manager.

**The hard part — two interleaved JSON protocols.** Unlike Jest/Vitest (one `--json` schema), Cargo emits **Cargo build messages** (`--message-format json`: `compiler-message` / `compiler-artifact` / `build-finished`) **interleaved** with **libtest events** (`-- -Z unstable-options --format json`: `{type:"test", event:"ok"|"failed"|"ignored", name, exec_time, stdout}`). libtest JSON is **nightly-only**.

**Model (`model.ts`):** added `TestReport.diagnostics` (compiler errors, **kept separate** from test cases) and `TestReport.compiled` (false ⇒ build failed, no tests ran). Optional, so Jest/Vitest are unaffected.

**Parser (`cargoJson.ts`, new + 9 tests):** one line = one JSON object; tolerant of non-JSON noise (`Compiling …`, a `-Z` warning), blanks, and a truncated final line. Build messages → `diagnostics` + `compiled`; a `level:"error"` or `build-finished success:false` ⇒ `compiled=false`. libtest events → `TestCase`s grouped by top module, failure **source location recovered from the panic line** (`panicked at src/math.rs:42:9`), `exec_time` → ms, `ignored` → skipped. **A compilation failure is never a test failure** (distinct state). Covered: pass/fail/ignored, interleaved compiler messages, compile-fail vs assertion-fail, warnings-without-fail, malformed/truncated/empty, no-module-path.

**Adapter (`adapters.ts` + 2 tests):** `cargoAdapter` detects `Cargo.toml`; its `command()` emits a **minimal selector encoding** (`[]` / `["--filter", mod]` / `["--exact", fullName]`), not a cargo command line — the native side rebuilds the real argv. `parse = parseCargoJson`. The existing SECURITY test now also covers cargo (a shell-metacharacter name stays one argv element).

**Controller (`controller.ts` + 1 test):** a run is `failed` when `summary.failed > 0` **or `compiled === false`** — a build break is a failed run, distinct from test failures and not "done".

**Native (`test_runner.rs`):** added a `Grammar` discriminant and the `cargo` adapter (`node_package:false`, `grammar:Cargo`). `run_test` branches: Node → `authorize_args` (unchanged); **Cargo → `authorize_cargo`**, which rebuilds the real argv natively: `cargo test (--workspace | -p <pkg>) --no-fail-fast --message-format json [<filter>] -- -Z unstable-options --format json --report-time [--exact]`. A `-p` package is validated with `is_cargo_ident` (letters/digits/`_`/`-`, letter|digit|`_` lead) — **rejecting `..`, path separators, shell metacharacters, spaces**; cargo enforces actual membership. The filter / exact test name is **opaque** (one argv element, never shell-parsed); **no file path is ever accepted**, so Cargo has no path-traversal surface. `cargo` is resolved on PATH (`node_package:false`), never a renderer path. Reuses the whole WS5.1 lifecycle unchanged: `TestRuns` ids/ownership/concurrency/supersede/stale-protection, `capture_classified` (bounded output, deadline, process-tree kill), shutdown hook. (The missing-runner message was generalized from the npm-specific wording to cover Cargo.)

**Frontend UI (`TestingView.tsx`, `platform.ts`):** view-state now carries `diagnostics` + `compiled`. A **compilation failure is shown distinctly** — a red "Compilation failed" status and a compiler-errors panel (click a diagnostic to open its source), **no test tree**, never conflated with assertion failures. Skipped count labelled "ignored" for Cargo's idiom. Detection message mentions Cargo. Jest/Vitest behaviour unchanged.

**Three-level verification — all green:**

- **Level A/B — `cargo test --lib test_runner:: --test-threads=1` → 26 passed, 0 failed.** New Cargo tests: `authorize_cargo` builds the nightly JSON run for all/filter/exact; accepts a validated package and **rejects `../evil`, `a/b`, `a;b`, `a b`, `a&b`, `..`**; rejects unknown tokens / bare flags / trailing junk / **raw `-- -Z` passthrough**; a shell-metacharacter filter stays one argv element; `is_cargo_ident` rules. All WS5.1 tests still pass.
- **Level C — real Cargo: RAN (not skipped).** A nightly toolchain is present here, so the gated test wrote a dependency-free fixture crate (one pass, one fail, one `#[ignore]`, with an empty `[workspace]` table so it builds standalone under `target/`), ran it through the **real authorized argv** (`cargo +nightly` + `authorize_cargo(&[])`), and asserted genuine **libtest JSON** came back: `LEVEL C (cargo): ran a real nightly Cargo test and got libtest JSON.` (Level C for Vitest/Jest remains skipped — neither installed, no network install.)
- **Frontend — `node --test src/services/testing/*.test.ts` + `views.test.ts` → 70 passed, 0 failed** (cargoJson 9, adapters 7, controller 11, platform 9, + the rest).

**Verify (exact, run sequentially):**

- `cargo fmt --all --check` → exit 0.
- `cargo test --lib test_runner:: -- --test-threads=1` → **26 passed, 0 failed** (1.87 s warm; ~54 s cold with the fixture compile).
- `cargo test --lib test_runner::real_tests::level_c_real_cargo -- --nocapture` → **1 passed**, printed the real-run confirmation.
- `cargo clippy --lib --all-features -- -D warnings` → **exit 0**.
- `tsc --noEmit` → exit 0; `prettier --check` (all touched) → clean.

**Files changed:** new — `src/services/testing/cargoJson.ts` (+ `.test.ts`). Edited — `src/services/testing/{model,adapters,controller,platform}.ts` and their tests, `src/components/panel/views/TestingView.tsx`, `src-tauri/src/test_runner.rs`. No change to `checkers.rs`, process/terminal/task/diagnostics infra, ResourceId, WorkspaceManager, protected files, or C1/C2.

**Limitations (honest):** (1) **libtest JSON is nightly-only** — on a stable-only toolchain a Cargo run surfaces Cargo's `-Z` rejection as a clear run error rather than results; documented, and the nightly path is really exercised here. (2) libtest events don't carry the package, so tests group by top module, not by crate; package selection is a native capability (`-p`, validated) not yet surfaced in the tree UI. (3) Package membership is enforced by Cargo at run time (the identifier grammar is the injection gate), not pre-validated against `cargo metadata`.

**Next independent missing capability:** **test debugging via the existing DAP subsystem** — the `dap_start` native seam already exists (used by IDE-05); wiring "Debug test" from the Test Explorer through it is the next slice, leading into WS6 Multi-language Debugging. (Playwright and pytest adapters are smaller follow-ons that reuse this exact shape.)

---

## WS5.1 — Native test execution & process authorization — ✅ IMPLEMENTED + VERIFIED (native vertical slice closed)

**Goal:** implement the `run_test` / `cancel_test` native handlers that WS5 left as the one boundary, on the **existing `run_checker` security architecture** — no second process-execution system.

**Inspection first (traced the whole `run_checker` path before writing anything):** `checkers.rs` (allow-list of fixed-argv checkers, trust gate, `resolve_program`, `capture_classified`, single-flag cancel with `Arc::ptr_eq` cleanup) → `ide-workspace::process::capture_classified` (bounded 16 MB stdout / 64 KB stderr, deadline, cancel flag, **process-tree kill** via `taskkill /T`, a pure `stop_reason`/`outcome` classification proven race-free) → `lsp_process::resolve_program` (`node_modules/.bin` first when `node_package`, then **absolute** PATH only; never a renderer-named path) → `WorkspaceManager::validate_path` (lexical `..` normalization + symlink-escape canonicalization + root-containment) → `with_workspace` / `require_trust` → command registration + shutdown hook in `lib.rs`.

**Security decision — the renderer can no longer name a binary.** The WS5 wire was `run_test { program, args }`, which would let the renderer choose an executable. Changed to **`run_test { adapter, args }`**: the renderer names an **adapter id** only; the native side owns authorization end-to-end.

**Native implementation (`src-tauri/src/test_runner.rs`, new):**

- **Allow-list** `ADAPTERS` (vitest/jest → program + fixed base flags). `find_adapter(id)` is the only way to a program; an unknown/`"vitest; rm -rf /"`/`"../../../bin/sh"` id resolves to nothing.
- **`authorize_args`** re-parses the renderer argv against the adapter grammar and **rebuilds it natively**. Accepts exactly `base`, `base <file>`, or `base -t <fullName> <file>`; rejects an altered base, any unknown flag, and extra arguments. The test name is **opaque** — copied through as exactly one argv element, never inspected or split. A file selector is run through `validate_path` for **workspace containment** (so `../../../etc/passwd` and `/etc/passwd` are refused).
- **Program resolution** via `resolve_program(program, node_package=true, root, PATH)` — the project's own `node_modules/.bin` first; a path the renderer sends is never used, so it cannot pick a binary even by naming one.
- **Execution** through the existing `capture_classified` (bounded output, `TEST_TIMEOUT` = 10 min deadline, cancel flag, process-tree kill). stdout (where both runners emit JSON) is returned; stderr is the fallback only when stdout is empty, so a bad config still surfaces.
- **`TestRuns` registry** (native-generated ids, per-run cancel flag, **owning workspace root**): `register` bounds concurrency (`MAX_CONCURRENT_RUNS = 8`) and supersedes any run the same workspace already has going; `deregister` removes a run **by its own id** (so a late-finishing superseded run cannot evict the newer run that replaced it); `cancel_for_root` signals only the calling workspace's runs (ownership-scoped, idempotent). `cancel_all` + a `lib.rs` shutdown hook stop every run on exit.
- **`cancel_test`** resolves the current workspace natively and cancels its run(s); harmless when none is running or no folder is open. Typed outcomes: a stopped run is `cancelled`, a deadline is `timedOut`, a nonzero exit is a `completed` result (not an error), and permission / unknown-adapter / invalid-args / missing-runner / over-capacity are clear `Err(String)` messages (the `run_checker` convention).
- **`lib.rs`** — `mod test_runner`, `.manage(TestRuns::default())`, `run_test`/`cancel_test` in `generate_handler!`, and `cancel_all_runs` in the shutdown hook.

**Three-level verification (`cargo test --lib test_runner:: -- --test-threads=1`): 20 passed, 0 failed.**

- **Level A — native unit tests (14):** allow-list (no way to name a program); every native adapter id matches a TypeScript BUILTIN adapter (`include_str!` the TS); `authorize_args` accepts all/file/case and rebuilds argv; rejects altered base / unknown flag / extra args / non-`-t` selector; file selector forced through containment (traversal + `/etc` refused); **a shell-metacharacter test name stays exactly one argv element**; registry: register/deregister-by-id, ownership-scoped cancel, idempotency, supersede, **stale-finish does not evict the newer run**, concurrency bound, cancel-all.
- **Level B — controlled process integration (6):** a written **fixture script** (`.cmd` on Windows), never a downloaded binary, through the real `execute` path — valid JSON + exit 0 → `completed` with the stdout; nonzero exit → still `completed` (a failing suite is a result, not a run error); empty stdout → **stderr surfaced**; a 30 s hanging runner **cancelled and killed in < 10 s** (not run to completion); a run past a 300 ms deadline → `timedOut`; a missing program → clear error.
- **Level C — real Vitest/Jest:** **honestly reported as SKIPPED** — this repo installs neither runner and the rules forbid downloading one; the test prints the skip rather than passing silently. The native run path is proven by Level A (authorization) + Level B (real process lifecycle/cancellation/timeout).

**Frontend wiring:** `native.ts` `run_test` retyped to `{ adapter, args }`; `useTestingPlatform.ts` sends `{ adapter: command.program, args }`; the TestingView tab, detection, and badge are unchanged. The **missing-runner state is informative and recoverable**: `run_test` returns a clear "No vitest runner found… `npm install -D vitest`" error, which the controller shows as a failed run; detection still works and a later run retries.

**Verify (exact):**

- `cargo fmt --all --check` → exit 0.
- `cargo test --lib test_runner:: --no-run` → **Finished, test binary built** (23 s).
- `cargo test --lib test_runner:: -- --test-threads=1` → **20 passed, 0 failed, 1.24 s**; no Smart App Control (os error 4551) this run.
- `cargo clippy --lib --all-features -- -D warnings` → **exit 0 (no warnings)**, 20.6 s.
- Frontend unchanged-green: `node --test src/services/testing/*.test.ts` + `views.test.ts` → **58 pass**; `tsc --noEmit` exit 0; `prettier --check` clean.

**Files changed:** new — `src-tauri/src/test_runner.rs`. Edited — `src-tauri/src/lib.rs` (module + state + handlers + shutdown), `src/services/native.ts` (wire `{adapter,args}`), `src/services/testing/useTestingPlatform.ts` (binding). No change to `checkers.rs`, the process/terminal/task/diagnostics infrastructure, ResourceId, WorkspaceManager, or any protected search file. C1/C2 untouched; production C2 registry still empty; E6 not begun.

**Limitations (honest):** (1) Level C real-runner execution is unverified here — no local Vitest/Jest and no network install permitted; reported, not hidden. (2) `resolve_program` looks in the workspace-root `node_modules/.bin` (and PATH), so a runner installed only in a monorepo sub-package is not yet found — a follow-up. (3) A report over 16 MB is truncated by `capture_classified` and then fails to parse with a typed `TestParseError` (graceful, but very large reports aren't streamed).

**Next (continuing the slice, per the WS5.1 brief):** Cargo-test adapter → Playwright → pytest; then connect test debugging to the existing DAP subsystem (`dap_start` seam); then WS6 Multi-language Debugging.

---

## WS5 — Native Testing Platform (Test Explorer) — ✅ VERTICAL SLICE BUILT (frontend end-to-end; one native command remains)

**Goal:** a genuinely useful integrated Testing Platform so users discover, run, inspect and rerun project tests inside Yavin. Vitest + Jest first (they share one `--json` schema), reusing existing process authorization — no new process/terminal/task/diagnostics infrastructure. Built in a vertical slice: discovery → execution → projection → view-model → UI.

**Constraint that shaped verification:** neither Vitest nor Jest is installed in this repo and installing is out of scope, so the core is verified against **recorded JSON fixtures, argv-safety tests, and fake runners** — not live framework runs. This is deliberate and documented, not a gap in coverage.

**What was built (all new, `src/services/testing/` + one view):**

- **`model.ts`** — the data model (`TestStatus`, `TestCase`/`TestFile`, `TestSummary`/`TestReport`), `caseId()` (NUL-joined stable identity), `aggregateStatus()`.
- **`jestJson.ts` (+6 tests)** — the shared Jest (`--json`) / Vitest (`--reporter=json`) parser (identical schema). Banner-noise tolerant (`extractJson`: first `{`→last `}`), typed `TestParseError` on malformed/`testResults`-less output, nested suites, locations, durations, failure messages.
- **`adapters.ts` (+6 tests)** — `vitestAdapter` / `jestAdapter`: each builds **safe argv** (`program` + `args[]`, never a shell string), detects by root marker names, delegates parsing. `selectAdapter()` (Jest-first). **SECURITY test:** a test name `evil"; rm -rf / #` + backtick + `$(whoami)` stays exactly one argv element for both adapters; no arg is a joined shell string; `program` is a bare executable.
- **`controller.ts` (+10 tests)** — the lifecycle core: injected `TestRunner` (never spawns anything itself), phases `idle→running→done|failed|cancelled`, **generation-guarded** so a superseded/stale run never overwrites a newer one, `AbortSignal` cancellation, `reset()` (workspace switch), `rerunFailed()` (single case / single file / all).
- **`resultStore.ts` (+7 tests)** — current + bounded history; per-case status trend + **flaky** flag (saw both pass & fail); `newlyFailed()` (passed-before-now-failing regressions); subscribe/clear.
- **`treeProvider.ts` (+7 tests)** — projects the flat report into file→suite→case, **stable ids from path + suite/case names (never position)** so expansion/selection survive a reordering re-run; `flattenVisible()` for virtualized rendering; `toggleExpansion()` honouring default-open files.
- **`runService.ts` (+7 tests)** — turns an adapter's argv into the controller's `TestRunner` by delegating to the **existing authorized runner seam** (same shape as the checkers' `run_checker`/`cancel_checker`): `cancelled` outcome → `AbortError` (→ controller `cancelled`), `timedOut` → `TestRunTimeoutError` (→ `failed`), wires the `AbortSignal` to the native cancel. Includes an **end-to-end test** through the whole path (argv → runService → fake native → RunAnswer → parse → controller state) with no real process.
- **`platform.ts` (+8 tests)** — the single view-model the UI binds to: composes controller + result store + tree projection + expansion/selection behind one `subscribe`/`getViewState`; caches rows for reference-stability; records each completed run into history.
- **`useTestingPlatform.ts`** (React hook) — detects the framework from the open folder via the **existing** `list_workspace_files` command (no new discovery surface) and wires execution to the `run_test`/`cancel_test` seam.
- **`components/panel/views/TestingView.tsx`** — the Test Explorer UI: Run All / Stop / **Rerun Failed** toolbar, pass/fail/skip summary, indented status-marked tree (expand/collapse, run-on-hover, click-to-select), and a selected-failure detail pane with "Go to test" (failure navigation via the editor's existing open-at-position callback).
- **Panel registration** — added `test` ("TEST RESULTS") to `PANEL_VIEWS` (`services/panel/views.ts`), rendered in `TerminalPanel` with a **reactive failed-count tab badge** (like VS Code); wired `workspaceFolder` through from `App.tsx`.
- **`native.ts`** — declared the typed `run_test` / `cancel_test` command contract (mirrors `run_checker`: allow-listed, trust-gated, **argv structural — never a shell string**).

**Verify:** `node --test src/services/testing/*.test.ts` → **51 pass, 0 fail**; `src/services/panel/views.test.ts` → **7 pass, 0 fail** (updated for the new tab + wrap order); **`tsc --noEmit` exit 0 (whole project)**; `prettier --check` clean across all touched files.

**Files changed:** new — the 8 `src/services/testing/*.ts` modules + 8 `*.test.ts`, `useTestingPlatform.ts`, `components/panel/views/TestingView.tsx`. Edited — `services/native.ts` (typed seam), `services/panel/views.ts` + `views.test.ts` (new tab), `components/layout/TerminalPanel.tsx` (render + badge + prop), `App.tsx` (pass `workspaceFolder`).

**Remaining (next increment) — the one native command:** `run_test` / `cancel_test` in the Tauri backend, implemented exactly like the existing `run_checker` (allow-listed project test tool resolved inside the trusted workspace, structured argv, `{outcome, output, code, root}`). Deliberately **not** shipped blind: it touches process-authorization security, and with no installed runner a live run can't be verified here. Today the tab renders and **framework detection works** (via `list_workspace_files`); clicking Run surfaces an honest error until the backend handler lands. Then: multi-root support and the remaining adapters (Cargo, Playwright, pytest), and the **DAP debug-test interface** (the native `dap_start` seam already exists — design only, no separate debugger).

---

## WS-A — Dead placeholder crates (investigation) — ✅ ANALYSIS COMPLETE; removal recommended

Five crates are **excluded from the Cargo workspace** (`src-tauri/Cargo.toml` `exclude = [...]`) and **referenced by nothing** (git grep across the repo, excluding the crates themselves + their Cargo.toml, finds zero uses):

| Crate        | Contents                                                                                    | Verdict                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `ide-config` | `settings.rs`/`keymap.rs`/`theme.rs` = 2-line **"Placeholder … will be implemented"** stubs | **Dead stub** — real config lives in TS `services/settings` + `src-tauri/src/config.rs`                 |
| `ide-syntax` | `highlight.rs` = 2-line placeholder (tree-sitter never wired)                               | **Dead stub** — highlighting is Monaco Monarch + Shiki/TextMate (TS)                                    |
| `ide-lsp`    | `client.rs`/`transport.rs` = placeholders                                                   | **Dead stub** — real LSP is `src-tauri/src/lsp.rs` + `ide-workspace::lsp_process`/`lsp_framing`         |
| `ide-dap`    | `client.rs` = placeholder                                                                   | **Dead stub** — real DAP is `src-tauri/src/dap.rs`                                                      |
| `ide-core`   | `buffer.rs` (153 ln), `undo.rs` (141), `cursor.rs` (24) — **real code**, but unused         | **Dead-but-real** — superseded by Monaco + `DocumentService`/`EditorModelBridge` (TS); never referenced |

- **Decision:** all five are safe to remove (no deps, no references, excluded from build; `ide-core`'s real code is preserved in git history). Removing them deletes the `exclude = [...]` entries in `src-tauri/Cargo.toml` too.
- **Status:** removal is a destructive filesystem/Cargo change; **pending** — will perform with the next safe step or flag for approval if the auto-mode safeguard blocks it. No source that ships depends on them, so removal is zero-risk to the product.

---

## WS-F.1 — Regression coverage for `language.ts` — ✅ DONE (verified)

- **Problem:** `src/services/language.ts` (document language detection — drives editor mode, highlighting, LSP routing, status bar) had **no unit test** (flagged in the audit), so its ~40 extension + special-filename mappings were unguarded against regressions.
- **Change (additive only):** new `src/services/language.test.ts` — 8 tests covering extension mapping, path→basename reduction (both separators), case-insensitivity, whole-name files (Dockerfile/Makefile/Cargo.lock/.gitignore/.env/.bashrc), `.env.*`/`Dockerfile.*` variants, plaintext fallbacks, labels, and contributed-language rules (builtin wins, longest-extension-first, state reset).
- **Tests:** `node --test src/services/language.test.ts` → **8 pass, 0 fail**; `tsc --noEmit` → exit 0.
- **Files changed:** `src/services/language.test.ts` (new). No production code touched.

---

## WS4 — Git integration consistency — ✅ VERIFIED + regression gap filled

- **Objective:** verify the two Git subsystems (real Git `services/git` + `git.rs`; Local Git `services/localgit` + `ide-localgit`) are consistent and reliable.
- **Finding:** both are comprehensively tested and passing — 32 `services/git/*` test files (incl. `*.realgit.test.ts` real-git integration), `services/localgit/*`, and `ide-localgit`'s 28 integration tests — all green in the WS0 Rust run (793) and WS1 frontend run (1085). The two subsystems are distinct by design (Source Control vs local history/snapshots), not duplicated. No defect found.
- **Genuine gap filled (regression test):** `src/services/git/graph/shared.ts` — the **ref-counted shared `GraphLoader` registry** (acquire/release/reset/drop, keyed per repository) — was **untested**, despite being reliability-critical and tied to a **documented past leak** (release recomputing a different key than acquire → the loader stayed forever and was later handed back wrapping a _dead native handle_; see `hooks.ts:91-99`).
- **Change (additive only):** new `src/services/git/graph/shared.test.ts` — 6 tests: build-once + ref-count share on re-acquire, dispose only on last release, release-of-unknown-key no-op, **release-under-the-wrong-key leaves the loader alive** (locks the leak-avoidance contract), `dropLoader` disposes regardless of ref-count + forces a fresh build (repo-close path), and `resetLoader` resets a live loader / no-ops when absent.
- **Tests:** `node --test src/services/git/graph/shared.test.ts` → **6 pass, 0 fail**; `tsc` exit 0; `prettier` clean.
- **Files changed:** `src/services/git/graph/shared.test.ts` (new). No production code touched.

---

## WS3 — Terminal lifecycle / PTY reliability — ✅ VERIFIED COMPLETE (no rewrite warranted)

- **Objective:** reliable terminals across creation, execution, cancellation, restart, workspace switch, shutdown, unexpected exit.
- **Finding:** the lifecycle is already correct and **comprehensively tested on both layers**; the architecture satisfies every WS3 requirement, proven by existing tests (ran green: 793 Rust tests in WS0, 1085 frontend tests in WS1). No defect found; no rewrite warranted.
- **Requirement → existing test evidence:**
  | Requirement                                                                     | Proven by                                                                                                                                                        |
  | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Multiple simultaneous terminals                                                 | `several_shells_at_once_keep_their_output_apart_and_all_end` (rust)                                                                                              |
  | Invalid shell / cwd / startup failure                                           | `only_a_detected_shell_can_be_started`, `a_terminal_starts_in_a_real_folder_or_says_why_not`, `a_launch_that_cannot_start_says_why_and_reports_no_events` (rust) |
  | High-volume output, bounded + responsive                                        | `a_real_shell_streaming_megabytes_stays_ordered_bounded_and_responsive` (rust)                                                                                   |
  | Input backpressure / oversized input                                            | `input_to_a_shell_that_stops_reading_is_refused_instead_of_blocking`, `oversized_input_is_refused_before_it_is_queued` (rust)                                    |
  | Kill ends the whole process tree (+ grandchildren)                              | `killing_a_terminal_ends_everything_its_shell_started`, `…_ends_its_shells_children_and_grandchildren_by_pid` (rust; Windows Job Object / Unix killpg)           |
  | Kill during startup still ends                                                  | `a_terminal_killed_before_its_shell_finished_starting_still_ends` (rust)                                                                                         |
  | Self-exit reported + reaped                                                     | `a_shell_that_exits_by_itself_is_reported_and_reaped` (rust)                                                                                                     |
  | Shutdown with active terminals                                                  | `close_all_ends_every_session` (rust) + `disposing a workspace's terminals ends them all and refuses everything after` (ts)                                      |
  | Stale-generation / race safety                                                  | `a_stale_generation_never_touches_the_current_launch` (rust); `a restart while the old generation is exiting keeps the new one` (ts)                             |
  | **Resize/write after termination refused**                                      | `writes and resizes reach the current generation, and are refused once it has ended` (ts)                                                                        |
  | **Repeated dispose (idempotent)**                                               | `terminalService.test.ts:427` `dispose(); // twice is harmless` (ts)                                                                                             |
  | Leak-free disposal                                                              | `disposing during output, and a subscriber disconnecting, throw nothing and leak nothing` (ts)                                                                   |
  | Workspace switch / isolation                                                    | `A → B → A: A's terminals keep running while away…`, `refuses another's by name` → `InvalidWorkspace` (ts)                                                       |
  | Security: shell allow-list, cwd validation, containment, per-workspace identity | the above + `require_current` generation guard + `running()` state guard (rust)                                                                                  |
- **Decision:** no code change (would be change without a real correctness issue, against the task's guidance). The `running()` guard (`src-tauri/src/terminal.rs`) refuses write/resize unless the session is the current generation **and** `Running`; termination uses `can_transition` + generation checks (idempotent); process containment is the shared Job Object/killpg. All already covered.
- **Files changed:** none. **Remaining limitations:** live resource-handle counting before/after mass create/dispose is OS-tooling territory (the Rust `process_table`-based tests already assert no leaked child _processes_ after kill).

---

## WS2 — Explorer scalability: measured, already-optimized, reliability test added — ✅ DONE (verified)

- **Goal:** make the Explorer fast/scalable for large repos.
- **Finding 1 — rendering is already virtualized.** `src/components/layout/Sidebar.tsx` windows rows arithmetically (`ROW_HEIGHT`, `OVERSCAN`, `first/last` slice over `view.top/height`) — only the visible slice + overscan render, regardless of tree size. (The prior audit's "virtualization unverified" was wrong.)
- **Finding 2 — the provider is reference-stable + incremental.** `projection()` caches and keeps object identity for unchanged subtrees; `applyResourceChanges` relists only the changed file's **parent** folder (loaded containers), not the whole tree.
- **Benchmark (real, synthetic wide directory; pure provider logic; temp harness, not committed):**

  | entries | load (list+reconcile) | projection build | projection cached | refresh+reconcile (+1 file) | RSS    |
  | ------- | --------------------- | ---------------- | ----------------- | --------------------------- | ------ |
  | 1,000   | 3.5 ms                | 0.5 ms           | **0 ms**          | 2.3 ms                      | 76 MB  |
  | 10,000  | 23.7 ms               | 3 ms             | **0 ms**          | 22.4 ms                     | 109 MB |
  | 50,000  | 98.7 ms               | 14.6 ms          | **0 ms**          | 121.9 ms                    | 244 MB |

  Load/reconcile is linear (~2 ms/1k); the projection cache is free when unchanged (the key memoization guarantee); 50k _direct siblings_ is an extreme case and still ~100 ms to load.

- **Decision:** **no optimization implemented** — the measurements show the Explorer already scales, and the one O(n) cost (relist a folder on change) is intentional (correctness via listing — "every fact comes from a listing"; a delta-apply optimization would introduce a second source of truth, which the task and architecture forbid). Optimizing further would be change without measurable benefit.
- **Reliability regression test added (additive):** `src/services/explorerStore.test.ts` — 6 tests for the previously-isolated-untested `explorerStore` (owns expansion/selection/focus): set-view reference stability + **independence** (changing selection does not rebuild the expanded view — the memoization that keeps large trees cheap), rename moves a folder + its subtree's state to the new identity, delete drops the subtree's state, reset clears selection/focus but keeps expansion, and reveal expands the ancestor chain + selects/focuses the target.
- **Tests:** `node --test src/services/explorerStore.test.ts` → **6 pass, 0 fail**; `tsc` exit 0; `prettier` clean. The reference-stable projection itself is already covered in `explorerProvider.test.ts` (21 projection assertions, incl. "the projection hands back what did not change").
- **Files changed:** `src/services/explorerStore.test.ts` (new). No production code (nothing warranted a change). Temp benchmark removed.
- **Remaining limitations:** cold-cache/large-sibling behavior measured only for the pure provider layer (React render counts + live memory in-browser would need a Playwright perf harness; the virtualization + reference-stable projection make the DOM cost bounded regardless).

---

## WS-F.2 — Regression coverage for `commandRegistry.ts` — ✅ DONE (verified)

- **Problem:** `src/services/commandRegistry.ts` (IDE-08 — the one owner of window + extension commands, read by menus/palette/shortcut handler) had **no unit test**.
- **Change (additive only):** new `src/services/commandRegistry.test.ts` — 9 tests: core listing/order, extension commands appended + namespaced, **core wins over a same-id extension command**, sort by extensionId→command, `execute` (runs/true, disabled→false, unknown→false), extension routing through its runner, `get`, `subscribe` fire-on-change/unsubscribe, and **a contributed shortcut colliding with a core one is refused (conflict reported), a free key is assigned**.
- **Tests:** `node --test` → **9 pass, 0 fail**; `tsc --noEmit` exit 0; `prettier --check` clean. (One assertion initially mis-ordered the sort and one arrow returned non-void — both fixed in the test; the product code was correct.)
- **Files changed:** `src/services/commandRegistry.test.ts` (new). No production code touched.

---

## WS1.2 — Ports panel: duplicate "Ports" ARIA region (regression from the Local/Global change) — ✅ FIXED (verified)

- **Problem:** 4 UI tests failed deterministically (`terminal.spec.ts` 2066/2084/2430/2796) with `strict mode violation: getByRole('region', { name: 'Ports' }) resolved to 2 elements`.
- **Root cause:** an earlier change added a Local/Global scope switcher to `PortsView`, wrapping the view in `<section aria-label="Ports">` (an ARIA region) **and** rendering an inner `EmptyView`, which itself renders `<section aria-label=…>`. The inner labels were "Local ports" / "Ports", and Playwright's `getByRole(name)` matches **substring, case-insensitively** — so both the outer "Ports" and the inner "Local ports"/"Ports" matched, giving two regions.
- **Fix (smallest responsible component — `src/components/panel/views/PortsView.tsx`):** keep the single outer `<section aria-label="Ports">` as the only "Ports" region; rename the inner `EmptyView` labels to `"Local"` (placeholder) and `"Global"` (loading/error/empty) so they no longer contain "port". Visible messages unchanged; behavior unchanged.
- **Regression coverage:** the existing `terminal.spec.ts` Ports/panel tests (which caught this) now exercise both scopes and pass.
- **Verify:** `npx playwright test terminal.spec.ts --grep "Ports|each view|switching away|Show Git Output|a port|stopping|confirming"` → **12 passed, 0 failed**; `tsc` exit 0; `prettier` clean.
- **Files changed:** `src/components/panel/views/PortsView.tsx` (4 ARIA labels).
- **Note:** the two other batch failures (`source-control-layout.spec.ts:348`, `terminal.spec.ts:4862` EXT-27 grammar) **passed on isolated re-run** → flaky under the heavy single-worker batch, not regressions.

---

## WS1.1 — Playwright UI suite broken by nested `node_modules` (flatten artifact) — ✅ FIXED (verified)

- **Problem:** `npm run test:ui` failed immediately (exit 1, ~4 s) for **every** spec with `"Playwright Test did not expect test() to be called here"` + `"No tests found"` — the entire UI runtime-validation suite was unrunnable.
- **Root cause:** the repo flatten's `mv Yavin_2.0.0/node_modules node_modules` nested the app's `node_modules` **inside** a pre-existing root `node_modules/`, producing `node_modules/node_modules/` — a second, duplicate install (incl. a second `playwright-core` + `@playwright/test`). Playwright loaded two `@playwright/test` identities → the spec `test()` calls weren't recognized. Verified: top-level `node_modules` is authoritative (`npm ls` clean; `@playwright/test` resolves `playwright-core` from the top level); the nested copy was redundant and gitignored.
- **Change:** `rm -rf node_modules/node_modules` (removed the duplicate; gitignored build artifacts only, regenerable via `npm ci`). No source, dependency, or config change.
- **Verify:** `npx playwright test --list` → **"Total: 479 tests in 19 files"** (was: load error, 0 tests). Exit 0.
- **Files changed:** none tracked (removed an ignored stray dir).
- **Remaining:** the flatten's `mv` is the lesson — a pre-existing root `node_modules` caused the nesting. No recurrence risk now; a future `npm ci` would also have fixed it.

---

## Results log

(Appended as tasks complete — exact commands + outcomes.)

- `npx prettier --check .` → exit 0 (all files clean) ✅
- `cargo clean` → exit 0 (stale target removed) ✅
- `cargo fmt --all` → only `registry_trust_tests.rs` changed; `cargo fmt --all --check` → exit 0 ✅
- `cargo build --workspace --locked` → **exit 0, 3m39s** (yavin-ide binary + all crates build from fresh cache; stale-cache blocker RESOLVED) ✅
- `cargo test --workspace --locked --no-fail-fast` → **793 passed, 0 failed**, no Smart App Control (4551), ~4.5 min ✅
- `cargo clippy --workspace --all-targets --locked -- -D warnings` → **exit 0** (no warnings) ✅
- Feature-gated C2 live tests (`--features c2-test-profiles`): previously verified green this session (c2 channel 20/0/2, c2_capability 7/0); not re-run this pass.
- Not run this pass: packaged `tauri build` (heavy), Playwright `tests/ui`/`tests/real` (heavy; `real` needs a packaged build).

**WS0 outcome:** build reliability restored — the whole Rust workspace builds, the full default test suite passes (793/0), clippy is clean, and both formatters pass. The repo-flatten's stale-cache/format fallout is fully cleared.
