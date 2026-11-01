# Brokered process capability: threat model and design (EXT-33)

**Status: a design under implementation, phase by phase.** E0, E0.1 and E0.3 (§17, §18, §19) hardened Yavin's own lookups and launches; none added a process capability. **E1 (§20) implements the native C1 broker** -- a one-shot stdin→stdout filter in the EXT-10 sandbox -- **E2 (§21) adds the native consent and grant authority that gates it** (deny by default; revocation ends running processes), **E3 (§22) measures and verifies every resource limit live**, and **E4 (§23) exposes the C1 filter to extensions through the native grant authority and broker** (`yavin.process.runFilter`), with identity, consent and every decision kept native. Yavin still ships **no C1 profiles**, so every `process.runFilter` is `UnknownProfile` in the shipped build; C2 (E5) and C3 (E6) are not begun, and there is no general process-execution API. Extensions cannot start their own processes in Yavin. This document changes no runtime code, permission, sandbox setting or launch path, and it does not grant any capability. Each decision marked **Approval** in §15 needs an explicit yes before EXT-34 or any later module builds on it.

**Base:** `ext-32-workers` at `6947a3f` (EXT-25 to EXT-32). The unresolved packaged foreground-focus test stays unresolved (audit §E6, §F7, §G6, §H6).

**Evidence:** `benchmark/openvsx/ext33/process-survey.json`, which lists what each of the 22 process-dependent benchmark extensions ships and calls. It was produced from the packages' ZIP directories and a text scan of their JavaScript (nothing was run), joined with EXT-32's benchmark records (`benchmark/openvsx/ext32/`).

---

## 1. Scope and non-goals

**In scope.** A native broker through which an extension may, with the user's informed consent, start a **specific, identified program** for a **specific purpose**, with arguments and resources it cannot use to reach beyond that purpose, and whose processes end when the extension or workspace does.

**Non-goals.**

- A generic shell, `child_process` emulation, or "run any command" API. Node.js's `child_process` stays unsupported; a broker API is a new, narrower contract, and extensions would have to be adapted or shimmed to it (§9.1).
- Making unsafe programs safe. Consent is not evidence that a program is benign (§8.6).
- Debug adapters started by extensions. Yavin's DAP platform launches its own; extension debuggers need the debug API too (`platform` cause), and that is a separate design.
- Network access for extensions or their processes.
- Platforms other than Windows. Yavin sandboxes only on Windows (`sandbox::SUPPORTED`), so elsewhere the broker refuses everything (§10).
- Protecting against malicious code that already runs as the user outside Yavin, or against an administrator (§4.2).

## 2. The evidence: what the 22 extensions actually need

The audit's Part H lists 22 benchmark extensions whose main feature needs a process or binary. They do not need one capability:

| Extension                                  | Main feature           | What it would start                                                           | Where the program comes from                                                   | Runs project code?                    | Blocked earlier, before any process             |
| ------------------------------------------ | ---------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------- | ----------------------------------------------- |
| Ruff                                       | Python lint and format | `ruff.exe server` (LSP); locates it with Python scripts                       | **Bundled** (`bundled/libs/bin/ruff.exe`, 25 MiB)                              | No (reads files and config)           | `fs.readFileSync` (Node.js)                     |
| rust-analyzer                              | Rust language server   | `rust-analyzer.exe`; it runs `cargo`, build scripts and proc macros           | **Bundled** server (37 MiB); toolchain installed by the user                   | **Yes** (build scripts, proc macros)  | `languages.setLanguageConfiguration`            |
| Lua                                        | Lua language server    | `lua-language-server.exe` and its DLLs                                        | **Bundled** (`server/bin`, 10 files)                                           | No (Lua plugins are opt-in)           | Runtime out of memory at load                   |
| Shellcheck                                 | Shell linting          | `shellcheck.exe` per file                                                     | **Bundled** (33 MiB), **and a WebAssembly build** (`shellcheck.wasm`, 9.4 MiB) | No                                    | Activates; its first process is the first block |
| clang-format                               | C/C++ formatting       | `clang-format` with the document on stdin                                     | User-installed (PATH or setting)                                               | No                                    | Activates; process                              |
| shell-format                               | Shell formatting       | `shfmt` on stdin                                                              | User-installed, or downloaded by the extension                                 | No                                    | `fs.readFileSync`                               |
| Black                                      | Python formatting      | `python -m black`, with Black from the package's `bundled/libs`               | Interpreter user-installed; Black's code **bundled**                           | Python interpreter: arbitrary code    | `fs.readFileSync`                               |
| ESLint                                     | JS linting             | `node` running its server, which loads the **project's** `eslint` and plugins | Node.js user-installed; ESLint from the project                                | **Yes** (configs and plugins are JS)  | Activates; process                              |
| Code Spell Checker                         | Spell checking         | `node` running its server (IPC)                                               | Node.js user-installed; server bundled                                         | No                                    | `os.release` (Node.js)                          |
| clangd                                     | C/C++ language server  | `clangd`                                                                      | User-installed or **downloaded by the extension**                              | Partly (compile commands)             | Load fails                                      |
| Go                                         | Go language support    | `gopls`, `go`, `dlv`; installs tools with `go install`                        | User-installed; **installs over the network**                                  | **Yes** (`go test`, `go generate`)    | `environmentVariableCollection`                 |
| Todo Tree                                  | TODO search            | `rg` (ripgrep)                                                                | VS Code's bundled ripgrep (Yavin has its own, `resources/search`)              | No                                    | `fs.existsSync`                                 |
| GitLens, Git Graph, Git History, Git Blame | Git views              | `git` (with `askpass` scripts)                                                | User-installed Git                                                             | Git hooks and config can run programs | Package limits, globals, an ES module, storage  |
| Test Explorer, Vitest, Jest                | Test running           | `node`, `npm`, `jest`, `vitest`; `shell: true` seen                           | The project's                                                                  | **Yes** (the tests)                   | Selectors, the testing API, `process.cwd`       |
| CodeLLDB, debugpy, Firefox debugger        | Debugging              | Debug adapters, `lldb`, `python`, Firefox                                     | Bundled or installed                                                           | **Yes** (the debuggee)                | The debug API                                   |

**What this shows.**

1. **A broker alone unlocks almost nothing now.** For 18 of the 22, a process is not yet the first failure: Node.js `fs`/`os` APIs, missing VS Code APIs, the testing and debug subsystems, an ES module or a package limit come first. Only Shellcheck, clang-format and ESLint reach their process, and ESLint then runs project code. Any phase that builds a broker must say this; it is a prerequisite, not an unlock.
2. **There are at least five distinct needs:** a one-shot **filter** (stdin to stdout: clang-format, shfmt, shellcheck, Black); a long-running **bundled server** (ruff, Lua, rust-analyzer's server); an **interpreter** running code (Node.js or Python for ESLint, Code Spell Checker, Black); a **project-code executor** (cargo, jest, vitest, `go test`, ESLint plugins); and **Git**. Each has a different risk, so each needs its own capability (§6).
3. **Some needs have process-free answers.**
   - Shellcheck ships WebAssembly, so a WebAssembly runtime in the sandboxed host would remove its process need. QuickJS has none, and Even Better TOML needs it too.
   - Todo Tree's search is ripgrep, and Yavin already ships and runs ripgrep for its own search: a search API (`workspace.findTextInFiles`) would serve it without granting a process.
   - The Git extensions want Git, which Yavin already runs through its own allow-listed `git.rs`.

   Prefer these where they fit (§6.0).

## 3. What Yavin already has, and what it proves

| Mechanism                     | Where                                         | What it does                                                                                                             | Proven by a Windows test                                                                                                               |
| ----------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| AppContainer, no capabilities | `ide-workspace/src/sandbox.rs` (EXT-10)       | The extension host process: no user files, no network (loopback too), cannot open other processes                        | Yes: `tests/sandbox.rs` probes the user profile, the repository, loopback, the parent process: all denied                              |
| Job Object                    | `sandbox.rs`                                  | One active process, committed-memory cap, CPU hard cap, UI restrictions, kill-on-close                                   | Process count, memory (allocation past the cap denied) and kill-on-drop: yes. CPU cap: **set and read back, not measured** as enforced |
| Mitigations                   | `sandbox.rs`                                  | No child processes, no Win32k, no dynamic code, strict handles, no remote or low-integrity images                        | Read back by the probe; spawning `cmd` and itself denied                                                                               |
| Handle list                   | `sandbox.rs`                                  | Only its three pipes are inherited                                                                                       | Yes: an inheritable handle of the parent is not usable                                                                                 |
| Minimal environment           | `sandbox.rs`                                  | `SystemRoot` (Windows adds the container's own folders)                                                                  | Yes                                                                                                                                    |
| Yavin's own tools             | `src/lsp.rs`, `src/checkers.rs`, `src/git.rs` | Fixed allow-lists, fixed argv, trusted folders only, **unsandboxed**, Yavin's environment, `kill_tree` (taskkill /T)     | Allow-lists and trust: yes. Not sandboxed by design                                                                                    |
| Grants bound to a copy        | `extension_service.rs` (EXT-07, EXT-16)       | `{folder, version, sha256, capabilities}`; checked natively per request under the inventory lock; an update has no grant | Yes (`ext16_*`, `extension_service_tests.rs`)                                                                                          |
| Installed-copy integrity      | EXT-19                                        | Each installed file's digest, verified                                                                                   | Yes                                                                                                                                    |
| Workspace trust               | `src/trust.rs`                                | Native; required for hosts, LSPs, checkers, terminals                                                                    | Yes                                                                                                                                    |

**A finding to report (not changed here).** Yavin's own language servers and checkers resolve their program with `resolve_program` (`lsp_process.rs`). It looks in the project's `node_modules/.bin` first, then `PATH`, trying `.exe`, `.cmd`, `.bat` and no suffix. A trusted workspace can therefore supply the program Yavin runs, and `.cmd`/`.bat` run through `cmd.exe`'s parser. That is consistent with "a trusted folder may run its own code", but **the broker must not reuse it**: §9.3 specifies a stricter resolution. Whether Yavin's own tools should move to it is question Q10.

## 4. Trust boundaries

### 4.1 Principals

| Principal                                 | Trusted for                                                        | Not trusted for                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| The user                                  | Decisions: trust a folder, install, grant                          | Judging whether a program is safe (§8.6)                                                         |
| Yavin's native process (`yavin-ide`)      | Authorization, resolution, launch, ending processes, the inventory | — (the trusted computing base)                                                                   |
| Yavin's window (renderer)                 | Showing what the native side decided; conveying the user's answer  | Authorization. Today it conveys consent for every capability (EXT-07); for process grants see Q2 |
| The extension host (AppContainer)         | Nothing                                                            | Everything: it runs third-party code                                                             |
| An extension (its code, workers, package) | Nothing; its package's integrity is checked                        | Its requests, arguments, file names, manifests, timing                                           |
| A brokered program                        | Nothing; less still if the extension supplied it                   | Its output, exit code, timing, files it writes, children                                         |
| The workspace's contents                  | Nothing (even a trusted one)                                       | Config files, scripts, `node_modules`, `.cmd` shims                                              |
| Other programs running as the user        | **Out of scope** (§4.2)                                            | —                                                                                                |
| Administrators, kernel, firmware          | **Out of scope**                                                   | —                                                                                                |

### 4.2 The model's boundary: same user and administrators

- **Same Windows user, outside Yavin.** A malicious program already running as the user can read and write everything the user can: Yavin's data, the inventory, installed copies, executables on disk, the credential store. It can inject into Yavin. **Nothing in this design defends against it**, and no claim here should be read as doing so. The design does defend against such code _inside_ the extension host (AppContainer), and against a brokered program turning a narrow grant into the user's full power where the class allows containment (§6).
- **A brokered program that is not contained** (class C3, §6) runs with the user's full power. Its grant is the user's decision to run that code; the broker limits only how it starts and when it is ended, and even that is not airtight (§9.10).
- **Administrators** can bypass ACLs, Job Objects and AppContainers, and debug any process. Out of scope.
- **What AppContainer and Job Objects do not provide.**
  - _AppContainer_ isolates by token and ACLs. It does not stop a process from reading what grants `ALL APPLICATION PACKAGES` (much of `C:\Windows`, `Program Files`) or anything granted to its SID. It is not a VM, and a Windows or driver vulnerability breaks it.
  - _Job Objects_ limit processes in the job; they do not limit work done outside it on the job's behalf. They do not count handles or files, do not bound disk I/O unless I/O rate control is configured and proven (not done), and do not stop a non-AppContainer process from asking WMI, the Task Scheduler, a COM server or a service to start a process outside the job.

## 5. Threat model

For each threat: the attacker's capability, the asset protected, the attack path, the required mitigation, the residual risk, and a test that demonstrates the mitigation. **A** is a malicious or compromised extension (its code in the sandboxed host); **P** is a malicious brokered program or interpreter script; **W** is malicious workspace content.

| #   | Threat                                     | Attacker / asset                             | Attack path                                                                                                                                                  | Mitigation                                                                                                                                                                                                                                                                                                                                                       | Residual                                                                                                                                                                                                                                 | Test                                                                                                                                                                                                     |
| --- | ------------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Arbitrary execution through the broker     | A / the user's account                       | Asks to run `cmd.exe`, `powershell.exe`, `rundll32`, an interpreter with its own script                                                                      | No generic API. A request names a **grant id** whose program identity was fixed at consent (§7). There is no path, no shell and no interpreter unless that class was granted. Interpreters are class C3 (§6)                                                                                                                                                     | A user who grants C3 has granted code execution                                                                                                                                                                                          | A request with a program path, `cmd.exe`, or an ungranted id: refused natively before resolution (unit + packaged)                                                                                       |
| T2  | Executable substitution after consent      | P, W, same-user code / the grant's meaning   | Replaces the granted file (same path, new content)                                                                                                           | Identity = canonical path **and** SHA-256 **and** file ID (volume serial + file index), checked at every launch (§7.3); a change voids the grant and asks again                                                                                                                                                                                                  | Same-user code can also change the inventory (out of scope, §4.2)                                                                                                                                                                        | Grant, then rewrite the program: next launch refused, `ExecutableChanged`                                                                                                                                |
| T3  | Time-of-check to time-of-use               | P, W / the identity check                    | Swaps the file between hash and `CreateProcess`                                                                                                              | Open the image with `FILE_SHARE_READ` only (no write or delete sharing), hash through that handle, keep it open across `CreateProcess`, then compare the new process's image path (`QueryFullProcessImageNameW`) and file ID with the held handle's. Package programs launch from the verified store (§7.2)                                                      | `CreateProcess` takes a path, not a handle: the held handle blocks writes and deletes, but not renaming a _parent_ folder. Hence the post-launch comparison: on mismatch, the process is killed before it is resumed (created suspended) | A thread that renames or rewrites the program in a loop during 10 000 launches: no unidentified image ever runs (Windows)                                                                                |
| T4  | PATH hijacking and search-order abuse      | W, P / which program runs                    | A `clangd.exe` in the workspace, the current folder, `node_modules/.bin`; `.cmd` shims                                                                       | No `PATH` search at launch. Absolute canonical path from consent; `PATH` only proposes candidates during consent, shown to the user with full path and signer; never the workspace, current folder or `node_modules`; `.cmd`, `.bat` and `.ps1` are refused (§9.3)                                                                                               | The user may choose a planted program in an odd location (consent shows it)                                                                                                                                                              | A workspace `clang-format.exe` and a `PATH` entry: neither is used without being the consented path                                                                                                      |
| T5  | DLL planting                               | W, P / the granted program's integrity       | A DLL beside the program or in its working folder                                                                                                            | Working folder is a Yavin-chosen empty folder (C1) or the workspace root only where the class needs it (C2/C3). `PreferSystem32Images` and remote/low-label image mitigations where the program tolerates them (§9.6). Bundled programs' own DLLs are part of the verified copy                                                                                  | An external program's own folder is not Yavin's to protect: a writable install folder lets same-user code plant                                                                                                                          | A planted `version.dll` in the working folder and the workspace: not loaded (C1, C2)                                                                                                                     |
| T6  | Argument injection                         | A / files, config, other programs            | `--output`, `-i` on files outside the workspace, `--config` pointing at a script, `@response` files, git `-c core.sshCommand=`, `rg --pre`, `--load-plugins` | Arguments are built from a **tool profile** (§9.2): a Yavin-authored argv template with typed slots (enumerated flags, a document on stdin, a canonical file inside the workspace). An extension fills slots; it never supplies raw argv for C1/C2. C3's argv is the user's decision, shown at consent                                                           | A tool with an unsafe flag inside an allowed slot type (profiles must be reviewed per tool)                                                                                                                                              | Each profile's slots are fuzzed: no produced argv contains a value outside its slot grammar; `@file` and `--` handling per tool                                                                          |
| T7  | Shell injection and quoting                | A / the command line                         | Metacharacters in values; Windows' per-program command-line parsing; `.bat` re-parsing (CVE-2024-24576 class)                                                | Never a shell. `CreateProcessW` with `lpApplicationName` set and a command line built by one quoting function (the MSVCRT/`CommandLineToArgvW` rules), round-trip tested. Batch files refused. Values with NUL, newline or quote-escape patterns that the target's parser treats differently are refused                                                         | Programs with non-standard parsers (rare)                                                                                                                                                                                                | Round-trip: for every value in a corpus (quotes, backslashes, `%`, `^`, `&`, `                                                                                                                           | `, Unicode), the child's `argv` equals the slot values |
| T8  | Path traversal and reparse points          | A, W / files outside the workspace           | `..`, `\\?\`, `\\.\`, device names (`NUL`, `COM1`), 8.3 short names, alternate data streams, junctions and symlinks into `C:\Users`                          | File slots take workspace-relative paths, canonicalized natively: final path by handle (`GetFinalPathNameByHandle`), must stay inside the canonical workspace root; reparse points refused (`FILE_FLAG_OPEN_REPARSE_POINT` and the attribute checked); ADS and device names refused. The same rules as `extension_package`, `read_resource`                      | A path checked then swapped before the program opens it (the program, not Yavin, opens it): C1 avoids file slots (stdin)                                                                                                                 | Junction, symlink, `..`, ADS, short name, device name: each refused (Windows)                                                                                                                            |
| T9  | Environment secrets                        | A, P / tokens in Yavin's environment         | Yavin's own environment (proxy credentials, `GITHUB_TOKEN`, `NODE_OPTIONS`) inherited                                                                        | The environment is built from nothing: `SystemRoot`, `TEMP`/`TMP` (a per-process folder), `PATH` = the system folders only, plus profile-declared variables with fixed values. Nothing inherited, `NODE_OPTIONS`/`PYTHON*` never passed                                                                                                                          | A program that reads the user's files directly (C3) finds secrets there                                                                                                                                                                  | The child's environment, printed by a probe, equals the profile's list exactly                                                                                                                           |
| T10 | Inherited handles                          | P / Yavin's files, pipes, the inventory      | Yavin's inheritable handles leak into the child (Rust `Command` on Windows inherits all inheritable handles)                                                 | `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` with exactly the child's stdio pipes, as `sandbox.rs` does. Never `std::process::Command` for brokered launches                                                                                                                                                                                                              | —                                                                                                                                                                                                                                        | The EXT-10 probe's inheritable-handle check, run for each class                                                                                                                                          |
| T11 | Credentials and network                    | P / the network, the credential store        | A program uploads workspace contents, or reads the credential store                                                                                          | C1/C2 run in an AppContainer with no network capability (proven: loopback refused); the credential store is not reachable from an AppContainer without capabilities. C3 cannot be contained                                                                                                                                                                      | C3: full network and credentials as the user                                                                                                                                                                                             | Probe: connect to loopback and a public address, read a credential: denied (C1, C2)                                                                                                                      |
| T12 | Child processes and job escape             | P / process lifetime, containment            | Spawns children; asks WMI, `schtasks`, a COM server or a service to spawn outside the job                                                                    | C1/C2: AppContainer, a job with an active-process limit, and the child-process mitigation (proven to deny `cmd` and itself). C3: a job with kill-on-close and a process limit; WMI/COM/Task Scheduler escape **cannot be prevented** for a non-AppContainer process                                                                                              | C3 processes can escape their job and outlive Yavin                                                                                                                                                                                      | C1/C2: spawn and WMI `Win32_Process.Create` from the probe: denied. C3: documented as residual, with a test that the _job's_ processes all end                                                           |
| T13 | Process injection                          | P / Yavin and other processes                | `OpenProcess` on Yavin, `WriteProcessMemory`                                                                                                                 | AppContainer cannot open Yavin (proven). C3 runs as the user and can open other same-user processes, Yavin included                                                                                                                                                                                                                                              | C3: Yavin is not protected from a C3 program (an approval point, Q4)                                                                                                                                                                     | Probe: `OpenProcess(PROCESS_VM_WRITE)` on Yavin: denied (C1, C2)                                                                                                                                         |
| T14 | CPU, memory, process and time exhaustion   | P, A / the machine, Yavin's responsiveness   | Infinite loop, fork bomb, allocations, a process that never exits                                                                                            | Per-process job: committed memory cap (proven), process count (proven), CPU hard cap (set; **enforcement to be proven**), wall-clock deadlines enforced by the broker (kill the job), at most N concurrent processes per extension and host (§11)                                                                                                                | CPU and disk I/O rates are not proven enforced. Handle counts cannot be limited by a job                                                                                                                                                 | A memory hog: killed at its cap. A spinner: ended at its deadline, CPU measured under the cap (Windows, measured with `QueryInformationJobObject` accounting). A fork bomb: refused at the process limit |
| T15 | Output and input exhaustion                | P, A / Yavin's memory                        | Unbounded stdout, a 10 GB stdin                                                                                                                              | Bounded reads (§11): over the bound, the process is killed and the result is `OutputTooLarge`; stdin bounded by the request size; LSP framing's 64 MiB per message (`lsp_framing`)                                                                                                                                                                               | —                                                                                                                                                                                                                                        | A program that writes forever: killed at the bound, Yavin's memory unchanged                                                                                                                             |
| T16 | Orphans on cancellation, crash or shutdown | A, P / process lifetime                      | Cancel mid-run; the host crashes; the workspace switches; Yavin crashes                                                                                      | Every process belongs to a session `(window, workspace generation, extension, copy)`. Each process gets its own job with kill-on-close; Yavin holds the handle. Ending: on cancel, extension stop, crash, disable, uninstall, host exit, workspace switch, revocation and window close (§9.11). Yavin's own crash closes the handles, and Windows ends every job | C3 escapees (T12)                                                                                                                                                                                                                        | Each trigger, then the job's process list is empty within 2 s (Windows); Yavin killed with `TerminateProcess`: the jobs' processes gone                                                                  |
| T17 | Cross-extension access                     | A / another extension's grants and processes | Uses another extension's grant id or process id; reads another's output                                                                                      | Grant and process ids are the owner's (`<ext>#process#n`, as webviews and prompts are); checked natively; output and events to the owner only                                                                                                                                                                                                                    | —                                                                                                                                                                                                                                        | Extension B names A's grant and A's process: refused; A's events never reach B (host-level, as EXT-31's V06)                                                                                             |
| T18 | Confused deputy                            | A / a granted program's authority            | Uses a granted formatter's file slot to write outside the workspace, or the window to approve on its behalf                                                  | Slots restrict paths to the workspace; C1 writes nothing (stdout only), and the extension applies edits through `documents.edit` (version-checked). Consent is shown by Yavin, naming the extension, never by extension UI (webviews cannot render it)                                                                                                           | A C3 grant is a broad delegation by nature                                                                                                                                                                                               | A file slot naming `..\\..\\x`: refused; a webview's message cannot produce a consent dialog                                                                                                             |
| T19 | Revocation and concurrency races           | A / revocation's promise                     | Launches while a revocation commits; floods launches                                                                                                         | Authorization and launch happen under the inventory lock, like secret operations (EXT-16): a revocation either precedes the launch (refused) or follows it, and then ends that grant's running processes before `set_grants` returns. Launch queue and concurrency bounded per extension                                                                         | —                                                                                                                                                                                                                                        | Revoke during 1000 concurrent launches: no process of the revoked grant runs after `set_grants` returns (Windows)                                                                                        |
| T20 | Upgrade, rollback and reinstall            | A / consent's scope                          | A benign version is granted, a malicious update keeps the grant                                                                                              | Grants bind to the copy (version, package hash); an update has no grant (EXT-07); bundled programs bind to their file digest in the verified copy; rollback finds the old copy's grant only if that copy is unchanged                                                                                                                                            | A user who re-grants a malicious update                                                                                                                                                                                                  | Update a granted extension: launch refused until consent, the consent shows "changed since you allowed it"                                                                                               |
| T21 | Malformed and oversized requests           | A / the broker                               | Huge argv, invalid UTF-16, NUL bytes, deep JSON                                                                                                              | Requests validated at the protocol (1 MiB per message, as now), slot grammars, lengths, counts; nothing passes as-is                                                                                                                                                                                                                                             | —                                                                                                                                                                                                                                        | A fuzzer over the request schema: every case refused with a structured error, no panic                                                                                                                   |
| T22 | Misleading consent                         | A / the user's decision                      | A friendly name and icon ("Spell checker") for `powershell.exe`                                                                                              | Consent text is Yavin's, from the resolved identity: file name, full path, signer (or "unsigned"), hash prefix, class, what it may reach. The extension's own text is shown only as quoted, labelled text                                                                                                                                                        | Users may not read it                                                                                                                                                                                                                    | A manifest naming `cmd.exe` as "formatter": consent shows `C:\Windows\System32\cmd.exe`, and its class (C3), never the extension's label alone                                                           |
| T23 | Interpreter escape paths                   | A / containment                              | A "filter" that is really `python -c`, `node -e`, `pwsh -Command`                                                                                            | Interpreters are recognised natively (a list of interpreter image names and PE version info) and allowed only in C3, or in C2 with a fixed script from the verified copy and no `-c`/`-e`/`-m` slot                                                                                                                                                              | A program that embeds an interpreter (rare)                                                                                                                                                                                              | Requesting `python.exe` as a C1 filter: refused; with a package script in C2: only that script's hash runs                                                                                               |
| T24 | Platform and build differences             | All / the guarantees                         | A development build (program in `target/`), a portable install, an older Windows without an API                                                              | The broker states its guarantees per platform and build at start; a guarantee it cannot set up (AppContainer, job, mitigations, handle list) fails the launch (`SandboxUnavailable`). Never a silent unsandboxed fallback. Other platforms: refused                                                                                                              | Old Windows versions refuse more                                                                                                                                                                                                         | The packaged run and the development run both pass the probe set; `sandbox::SUPPORTED == false` builds refuse every launch                                                                               |

## 6. Capability classes

One permission for "run a program" would hide large differences in risk. These classes are proposed, each a separate capability with its own consent text. **Approval Q1.**

### 6.0 First: a process-free alternative

Before any class, prefer a sandboxed alternative where the evidence shows one:

- **WebAssembly in the host** (Shellcheck's `shellcheck.wasm`, Even Better TOML's server). This is a separate design: a WASM engine in the AppContainer host, fuel- and memory-bounded.
- **Yavin's own services:** search (ripgrep, which Yavin runs already) and Git (Yavin's `git.rs`), exposed as APIs with the extension's existing permissions.

### 6.1 The classes

| Class                    | What it is                                                                                                                                             | Contained?                                                                                                                                                             | Typical use (evidence)                                                                            | Grant binds to                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **C1. Filter**           | One-shot program: input on stdin (an open document's text), output on stdout. No files, no network, no children, no folder but an empty one of its own | **Yes**: AppContainer with no capabilities (EXT-10's sandbox), its own job, all mitigations; the program's folder granted read/execute to the container SID            | clang-format, shfmt, Black (if the interpreter is allowed, §6.2), shellcheck                      | Program identity (§7) + extension copy + profile                                                   |
| **C2. Contained server** | Long-running program speaking LSP over stdio; reads the workspace, writes nothing                                                                      | **Mostly**: AppContainer, no network, no children; the workspace root granted **read-only** to its container SID (an ACL change on the user's folder, Q5); its own job | ruff (`ruff server`), Lua language server                                                         | Program identity + copy + **workspace** + profile                                                  |
| **C3. Uncontained**      | A program that runs project code or needs the user's environment: toolchains, test runners, interpreters, Git with hooks                               | **No**: a job (kill-on-close, process and memory limits, CPU cap) and a minimal environment only. Runs as the user, with the user's network and files                  | rust-analyzer (cargo, proc macros), ESLint (project plugins), jest, vitest, `go`, Node.js servers | Program identity + copy + workspace + exact argv shown at consent; **per workspace, never global** |
| **C4. Debug adapters**   | Out of scope (§1)                                                                                                                                      | —                                                                                                                                                                      | CodeLLDB, debugpy, Firefox                                                                        | —                                                                                                  |

### 6.2 Bundled programs, external programs and interpreters

- **Bundled** (the program is a file of the extension's verified copy: ruff, Lua, rust-analyzer's server, shellcheck): identity comes from the package's signature chain. The file's digest is in the installed copy's record (EXT-19), and the copy is read-only to extensions. The consent says "a program shipped by <extension>, version v". It may be C1, C2 or C3.
- **External** (installed by the user: clang-format, clangd, git, node, python): identity is established at consent (§7.1). The consent says where it is, who signed it, and that Yavin did not install it.
- **Interpreters** (node, python, pwsh): running one with any script is code execution. They are allowed only as C3, or as C2 with a script that is a verified file of the extension's copy and fixed interpreter flags (no `-c`, `-e`, `-m`, `--require`, `NODE_OPTIONS`). **Approval Q6.**

## 7. Executable identity

### 7.1 External programs: resolution at consent

1. The extension's manifest declares what it needs as a **profile id** (§9.2) and, optionally, a program name (`clang-format`). It never declares a path.
2. At consent, Yavin's native side proposes candidates:
   - a path the user chooses in a native file dialog;
   - the profile's known install locations (for example `C:\Program Files\LLVM\bin\clang-format.exe`);
   - a `PATH` search of the **user's and system's** `PATH` (not Yavin's environment, not the workspace), `.exe` only.
3. Each candidate is canonicalized (`GetFinalPathNameByHandle` on a handle opened with `FILE_FLAG_OPEN_REPARSE_POINT`; reparse points, UNC and device paths refused unless approved, Q8). It is identified by SHA-256, file ID (volume serial and 128-bit file ID), size and Authenticode signer (`WinVerifyTrust`; "unsigned" is shown, not refused, Q7).
4. The user picks one. The grant records all of the above.

### 7.2 Bundled programs: the verified copy

The program's path is a path inside the installed copy, checked like `read_resource` (canonical, inside, no links). Its digest must equal the copy's recorded digest for that file (EXT-19) at every launch. The copy folder is granted read/execute to the class's container SID only for C1/C2, the same mechanism EXT-10 uses for the host's program.

### 7.3 At every launch

1. Open the program (`FILE_SHARE_READ` only), check its file ID and size, and hash it through the handle. It must match the grant.
2. Create the process **suspended**.
3. Check that the new process's image (`QueryFullProcessImageNameW` and its file ID) matches the held handle.
4. Resume. On any mismatch: terminate, void the grant, report `ExecutableChanged`.

**Cost.** Hashing a 37 MiB program per launch takes about 0.1 s; for C1 one-shot filters a cached digest keyed by file ID plus last-write time is acceptable only if the held-handle check (no write sharing) stays. **Approval Q9.**

### 7.4 What identity does not tell

A matching hash proves the bytes are the ones the user allowed, not that they are benign. A signature proves who signed, not intent.

## 8. Consent and permission model

### 8.1 What the user sees, before granting

A Yavin dialog, never extension UI. It shows:

- the extension's name, publisher and version, and whether it is signed (EXT-09);
- **what will run**: the file name, the full path, the signer or "not signed", the first 12 hex digits of the hash, bundled or external;
- **the class, in plain words**:
  - C1: "Can read the text you send it and return text. Cannot read your files, use the network or start programs."
  - C2: "Can read this folder. Cannot change files, use the network or start programs."
  - C3: "Runs with your full permissions. It can read and change your files, use the network and start other programs. Yavin can only stop it."
- the arguments, for C3 (exact argv);
- the workspace it applies to (C2, C3);
- the choices:
  - _Allow once_: for this launch only, C1 and C3 (Q3).
  - _Allow for this workspace_.
  - _Allow for this extension version_: C1 only.
  - _Don't allow_: the default, and what Enter and Escape choose.

### 8.2 What a grant binds to

| Class | Program identity | Extension copy (id, version, package hash) | Workspace                | Profile | Argv       |
| ----- | ---------------- | ------------------------------------------ | ------------------------ | ------- | ---------- |
| C1    | Yes              | Yes                                        | No (input is stdin)      | Yes     | Slots only |
| C2    | Yes              | Yes                                        | **Yes** (canonical root) | Yes     | Slots only |
| C3    | Yes              | Yes                                        | **Yes**                  | Yes     | **Exact**  |

### 8.3 Changes

| Change                             | Effect on grants                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| Extension update                   | No grant (as today); asked again, the dialog says "changed since you allowed it" |
| Rollback                           | The old copy's grant applies if that copy and program are unchanged              |
| Program replaced (hash or file ID) | Voided at the next launch, then asked again                                      |
| Workspace switch                   | C2/C3 grants of the old workspace do not apply; its processes end                |
| Workspace no longer trusted        | No launch of any class (trust is required for any class, as for hosts)           |
| Revocation                         | `set_grants` ends that grant's processes before it returns (T19)                 |
| Disable or uninstall               | All the extension's processes end; uninstall drops its grants                    |
| Profile switch                     | Profiles never grant (EXT-13)                                                    |

### 8.4 Requests without a declaration

An extension can request only what its manifest's `permissions.request` declares, and only profiles Yavin ships. A request for an undeclared class or an unknown profile is refused (`Unknown`, as today).

### 8.5 Denied, unsupported, failed

- **Denied** (not granted, revoked): the extension gets `PermissionDenied`. The extension's page shows "Blocked: wanted to run clang-format" with an _Allow_ button (EXT-16's pattern).
- **Unsupported** (no profile, platform without the sandbox, a class not approved): `UnsupportedApi: …`, logged once, with the reason.
- **Failed** (not found, identity changed, sandbox could not be set up, deadline, output too large, exit code): a structured error to the extension, and a line in its Output channel naming the program and the reason. The process's stderr goes to that channel, bounded.

### 8.6 Consent is not safety

The dialog never says or implies "safe", "verified safe" or "trusted program". A signature is shown as who signed it. Yavin's guarantees are only the class's containment (§6), and for C3 there is none beyond ending it.

## 9. Native broker architecture

### 9.1 Data flow and authorization sequence

```text
Extension (AppContainer host)           Yavin native (broker)                         Windows
------------------------------           ----------------------------------------      -------
process.start {grantId, profile,   ──►   1 validate request schema, sizes
  slots, input, timeoutMs}               2 session = (window, generation, ext, copy)
  (id <ext>#process#n, owned)            3 under the inventory lock:
                                            trust(folder) ∧ enabled ∧ HostCopy current
                                            ∧ declared ∧ granted(grantId) ∧ class approved
                                            ∧ profile known ∧ bounds free
                                            → reserve a process slot
                                         4 resolve: grant's canonical path (no PATH)
                                         5 identity: open (share-read), file ID, SHA-256
                                         6 argv from profile + slots; env from nothing;
                                            cwd per class; stdio pipes only
                                         7 class C1/C2: AppContainer + job + mitigations ──► CreateProcess
                                            class C3: job (+ limits)                           SUSPENDED
                                         8 verify image = held handle; assign job;   ◄──
                                            resume                                      ──► running
                                         9 release lock; return {processId}
process.output / process.exit    ◄──    10 bounded readers, deadline, cancel
process.cancel {processId}       ──►    11 terminate job, report
```

The extension host never holds a process handle, pipe or job, and nothing of the process reaches it but messages. The window is not in the launch path; it shows consent and status.

### 9.2 Tool profiles (the API's narrowness)

A profile is a Yavin-authored record, shipped with Yavin and reviewed per tool:

```text
profile "clang-format.stdin" (class C1)
  program:    external, image name "clang-format.exe"
  argv:       ["--assume-filename=" <slot file-name-only>, "--style=" <slot enum: file|LLVM|Google|…>]
  stdin:      <slot document text, ≤ 8 MiB>
  stdout:     ≤ 16 MiB → result
  cwd:        an empty per-process folder
  env:        SystemRoot, TEMP, TMP, PATH=system folders
  timeout:    30 s
```

- **Slot types:**
  - `enum` (fixed set);
  - `int` (range);
  - `file-name-only` (a name, no separators);
  - `workspace-file` (canonical, inside the workspace, no links), allowed only where the class reads files;
  - `document` (the open document's text, with its version for the result);
  - `literal` (none: no free text slots in C1/C2).
- Extensions cannot add profiles. A manifest names profiles it needs; Yavin shows and grants them.
- **C3's argv** is free, but shown in full at consent and bound exactly to the grant. A different argv is a different grant.

### 9.3 Resolution

The broker never searches. It launches the grant's canonical absolute path (§7). `.cmd`, `.bat`, `.ps1`, `.vbs`, `.js`, `.lnk` and `.url` are refused as programs, and so is anything that is not a PE image (checked by header). npm shims are not followed: a Node.js tool is `node.exe` plus a script (C3, or C2 with a verified package script).

### 9.4 Arguments

Arguments are built as a vector from the profile and quoted by one function to the `CommandLineToArgvW` rules. There is no shell. `lpApplicationName` is always set, so Windows' search does not apply. Values containing NUL are refused; values containing `\r` or `\n` are refused unless the slot allows them.

### 9.5 Environment and working folder

- **Environment:** built from nothing (T9). `TEMP` and `TMP` are a per-process folder, deleted at exit.
- **C1's working folder:** that empty folder.
- **C2/C3's working folder:** the canonical workspace root, or a `workspace-file` slot's folder where the profile says.

### 9.6 Handles, mitigations, sandbox

- **All classes:** `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` with the stdio pipes only, `EXTENDED_STARTUPINFO_PRESENT`, `CREATE_SUSPENDED`, `CREATE_UNICODE_ENVIRONMENT`, `CREATE_NO_WINDOW`, and a new job before resume.
- **C1/C2:** `sandbox.rs`'s AppContainer (a container per class and extension, Q11) and its mitigations. A program that fails under a mitigation (dynamic code: JIT runtimes) needs a per-profile, reviewed exception, never a silent drop.
- **C3:** no AppContainer. It gets the job, and the image-load mitigations `PreferSystem32` and no-remote-images where the program tolerates them.

### 9.7 Output, deadlines, exit

- **Readers:** stdout and stderr are read on their own threads into bounded buffers (§11). Over a bound, the job is ended and the result is `OutputTooLarge`. For servers, stdout is framed (`lsp_framing`, 64 MiB per message) and relayed as messages to the owner. The host's 1 MiB protocol bound applies, so a larger LSP message is refused and the server ended (Q12).
- **Deadlines:** a start deadline (the process must exist and, for servers, write within it) and a total deadline (C1). Servers have none, but an idle ping is optional (Q13).
- **Exit:** the exit code is reported, and so is the kind of end: `Exited{code}`, `Killed{reason: cancel|deadline|output|revoked|stopped|crashed|shutdown}`, `FailedToStart{reason}`.

### 9.8 Errors

Every error is structured: `{code, message, program?, profile?}`. The codes are:

- `PermissionDenied`, `ExtensionDisabled`, `ExtensionChanged`, `TrustRequired`, `UnknownProfile`, `UnsupportedPlatform`;
- `SandboxUnavailable`, `ExecutableNotFound`, `ExecutableChanged`;
- `OutputTooLarge`, `Timeout`, `TooManyProcesses`, `Cancelled`.

Messages name what was refused, never Yavin's internals.

### 9.9 Atomic authorization

Steps 3 to 8 hold the inventory's lock, the same lock `set_grants`, disable, update and uninstall take (EXT-16's model for secrets). A revocation therefore either comes first (the launch is refused) or waits until the process is in its job, and then ends it. **Holding the lock across `CreateProcess`** costs about 10 to 50 ms. The alternative is a generation counter re-checked after resume, which kills the process if the generation moved. **Approval Q14.**

### 9.10 Child-process policy

- **C1/C2:** `ActiveProcessLimit` = 1 and the child-process mitigation, so the program cannot start children (proven for the host). A server that needs helper processes (rust-analyzer runs cargo) is therefore C3.
- **C3:** the job has a process limit (§11) and no breakaway (`JOB_OBJECT_LIMIT_BREAKAWAY_OK` not set). Escape through WMI, the Task Scheduler, COM or services is possible and **not prevented**; it is stated in the consent and in §12.

### 9.11 Cleanup

A process ends on, and these events are ordered so cleanup happens exactly once (a process table entry is removed only by the one path that ended its job):

- its deadline;
- cancel;
- its extension's stop, crash, disable or uninstall;
- the host's exit;
- the workspace switching;
- its grant's revocation;
- the folder's trust being withdrawn;
- the window closing;
- Yavin exiting.

At each, the broker terminates the job (`TerminateJobObject`), waits for the job's process list to empty (`JobObjectBasicProcessIdList`), closes the handles and reports. Yavin's crash closes the job handles, so kill-on-close ends them.

## 10. Platform enforcement strategy

| Property                                             | Windows 10 1809+ and 11 (packaged)                      | Development build (`target/`)                                     | Other Windows                     | Other platforms |
| ---------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------- | --------------- |
| AppContainer, no capabilities (C1/C2)                | Required; proven (EXT-10 probe)                         | Required; the program's folder granted to the SID (as the host's) | Refuse if any API fails           | Refuse all      |
| Job: memory, process count, kill-on-close            | Required; proven                                        | Same                                                              | Refuse if any limit cannot be set | Refuse all      |
| Job: CPU hard cap                                    | Required to be **set**; enforcement to be measured (E3) | Same                                                              | Refuse if it cannot be set        | —               |
| Mitigations (child process, Win32k, dynamic code, …) | Required for C1/C2                                      | Same                                                              | Refuse                            | —               |
| Handle list                                          | Required                                                | Same                                                              | Refuse                            | —               |
| Image check after suspended create                   | Required                                                | Same                                                              | Refuse                            | —               |
| Disk I/O, network rate, handle count                 | **Not claimed**                                         | —                                                                 | —                                 | —               |

The broker checks its required properties at start (as the host's sandbox does) and refuses every launch when it cannot set them up, reporting which. There is **no unsandboxed fallback** for C1/C2: if AppContainer creation fails, C1/C2 launches fail and are **not** run as C3.

## 11. Resource and lifecycle bounds (proposed)

Each bound is justified from the evidence. "Enforced by" names the mechanism; "Proven" means a Windows test shows it already (EXT-10) or the implementation must show it (E-phases).

| Bound                                         | Proposed                                          | Justification                                                                                                       | Enforced by                             | Proven                         |
| --------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------ |
| Concurrent C1 processes per extension / host  | 2 / 8                                             | A formatter or linter runs per save or keystroke (debounced); two allow overlap                                     | Broker counter under the lock           | To prove (E4)                  |
| Concurrent C2/C3 servers per extension / host | 1 / 4                                             | One server per language per extension (ruff, Lua, rust-analyzer each run one)                                       | Broker counter                          | To prove (E4)                  |
| Queued launch requests per extension          | 8                                                 | Beyond this, the extension is looping                                                                               | Broker queue                            | To prove                       |
| C1 start deadline / total deadline            | 5 s / 30 s                                        | clang-format, shfmt, shellcheck and Black finish a file in well under 2 s; 30 s covers a cold cache on a large file | Broker timer, then `TerminateJobObject` | To prove (E3)                  |
| C2/C3 start deadline                          | 30 s                                              | rust-analyzer's start on a cold machine                                                                             | Broker timer                            | To prove                       |
| C1 memory (job committed)                     | 512 MiB                                           | Formatters and linters use under 100 MiB; Black with its interpreter about 60 MiB                                   | Job memory limit                        | Mechanism proven (EXT-10)      |
| C2 memory                                     | 2 GiB                                             | ruff server and the Lua server use 100 to 300 MiB on medium projects                                                | Job memory limit                        | Mechanism proven               |
| C3 memory                                     | 8 GiB (a setting, Q15)                            | rust-analyzer reaches 2 to 6 GiB on large workspaces                                                                | Job memory limit                        | Mechanism proven               |
| CPU (all classes)                             | 2 logical processors' worth (`cpu_rate_for`)      | Keeps the editor responsive; the host uses the same rule                                                            | Job CPU hard cap                        | **Set, not yet measured** (E3) |
| Process count in the job                      | C1/C2: 1; C3: 64                                  | C1/C2 start none; cargo and test runners fork many                                                                  | Job active-process limit                | Mechanism proven (limit 1)     |
| C1 stdin / stdout / stderr                    | 8 MiB / 16 MiB / 1 MiB                            | An open document is at most what the extension protocol carries; formatted output may grow                          | Broker bounded readers                  | To prove (E4)                  |
| Server message (stdout framing)               | 1 MiB relayed (the host protocol); 64 MiB framing | The host protocol's bound; a larger LSP message is refused                                                          | `lsp_framing`, host protocol            | Framing proven                 |
| Handles and files                             | Not bounded                                       | Jobs cannot limit handle counts; Windows' per-process limits apply                                                  | —                                       | **Not claimed**                |
| Process-tree depth                            | Not bounded separately                            | Jobs count processes, not depth; the count bounds the tree                                                          | Job process count                       | —                              |

**Cancellation semantics.**

- **Cancel** (the extension's token, Yavin stopping waiting) terminates the job and reports `Cancelled`. A result that arrives after a cancel is discarded.
- **Verification:** after `TerminateJobObject`, the broker waits until `JobObjectBasicProcessIdList` is empty, up to 5 s. If processes remain, it reports `KillFailed` with their ids, logs, and retries every second. The process-tree termination tests check the job's list, not just the first process.

## 12. Failure modes and residual risks

| Failure or residual                                     | Consequence                                                          | Accepted?                                                                                                      |
| ------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| C3 programs run as the user                             | Full user power: files, network, credentials, other processes, Yavin | Only as the user's explicit, per-workspace decision; never a default (Q4)                                      |
| C3 job escape (WMI, Task Scheduler, COM, services)      | Processes outlive cancel and Yavin                                   | Stated; not preventable without AppContainer                                                                   |
| Same-user malware replaces programs or the inventory    | Grants mean nothing                                                  | Out of scope (§4.2)                                                                                            |
| C2 read grant on the workspace changes the folder's ACL | An ACE for the container SID persists on the user's files            | Needs approval (Q5); it must be removed at revocation and uninstall, with recovery if Yavin crashes in between |
| AppContainer or kernel vulnerability                    | Containment broken                                                   | As for the host today                                                                                          |
| Programs that cannot run under mitigations              | The profile is unsupported, or needs a reviewed exception            | Per profile                                                                                                    |
| CPU cap not enforced as set                             | Slower editor under load                                             | Until E3 measures it                                                                                           |
| A user who grants a malicious program                   | Whatever its class allows                                            | Consent is not safety (§8.6)                                                                                   |
| A large LSP message over 1 MiB                          | The server is ended                                                  | Q12                                                                                                            |

## 13. Implementation phases and acceptance criteria (EXT-34 onward, each separately approved)

| Phase                                                           | Builds                                                                                                                                                                                      | Acceptance criteria                                                                                                                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **E0. Process-free alternatives** (optional, recommended first) | Search API on Yavin's ripgrep; a design for WebAssembly in the host                                                                                                                         | Todo Tree's search works without a process grant; the WASM design reviewed                                                                                                              |
| **E1. Broker core, C1 only, no extension API**                  | Native broker: profiles, identity, resolution, argv quoting, environment, handle list, AppContainer + job via `sandbox.rs`, deadlines, bounded output, cleanup; driven by native tests only | Every T-test of §14 for C1 passes on Windows; no code path accepts a program path, shell or PATH search; mutation set M1 (§14.6) all caught; nothing reachable from the window or hosts |
| **E2. Consent and grants**                                      | Inventory grant records `{class, profile, identity, copy, workspace?}`; native authorization under the lock; the consent dialog; the extension's page states                                | Revocation race test passes; update and rollback behave per §8.3; consent shows path, signer, hash and class; undeclared and unknown profiles refused                                   |
| **E3. Measured enforcement**                                    | Windows measurements: CPU cap, memory, process count, deadline kill, tree termination, Yavin crash                                                                                          | Each bound in §11 marked proven only with a passing measurement; any that fails is removed from the claims                                                                              |
| **E4. Extension API, C1**                                       | `process.run` protocol (owned ids, cancel, results to owner), both permission checks, the layer's shim for the profiles in use                                                              | clang-format and shfmt profiles work end to end in the packaged app; cross-extension and malformed-request tests pass                                                                   |
| **E5. C2 servers**                                              | Long-running servers over stdio, workspace read grant, LSP relay to the owner                                                                                                               | Ruff's server gives diagnostics in the packaged app (after its other blockers are fixed); ACL grant and removal proven, including crash recovery                                        |
| **E6. C3** (only with Q4 approved)                              | Uncontained, per-workspace grants with exact argv                                                                                                                                           | Every C3 residual shown in consent; job kill tests pass; escape residual documented in the UI                                                                                           |

## 14. Test plan

### 14.1 Positive

- **C1:** a probe program run as a filter. Its stdout equals its stdin transformed; its environment, working folder and handles are exactly as specified.
- **C2:** a probe server reads a workspace file, cannot write it, and answers LSP.
- **Profiles:** each argv produced from its slots, round-tripped through the child's own `argv`.

### 14.2 Negative

- Program path, shell, interpreter flags, `.cmd`/`.bat`/`.lnk`, a non-PE file, PATH and workspace candidates: refused.
- Ungranted, revoked, undeclared or unknown profile; a disabled extension; an untrusted folder: refused.
- File slots: `..`, junction, symlink, ADS, device name, 8.3 name, UNC: refused.
- From inside C1/C2 (the EXT-10 probe extended): network, user files, Yavin's data, opening Yavin, spawning a process, WMI `Win32_Process.Create`, reading a credential: all denied.

### 14.3 Races

- Rewrite or rename the program (and its parent folder) in a loop during launches: no unidentified image runs.
- Revoke during concurrent launches: no process of the revoked grant after `set_grants` returns.
- Workspace switch during a launch: the process ends.
- Cancel at every step of §9.1: no orphan.

### 14.4 Malformed input

Fuzz the request schema: oversized fields, invalid UTF-16, NUL bytes, deep JSON, unknown fields, ids of other extensions. Each must give a structured refusal and no panic.

### 14.5 Resource exhaustion

- Memory hog: killed at its cap.
- Spinner: ended at its deadline; CPU measured under its cap.
- Fork bomb: refused at the process limit.
- Endless stdout: killed at the output bound.
- Launch flood: refused at the queue bound.
- Each case leaves Yavin's memory and responsiveness bounded (measured).

### 14.6 Mutations (security, as EXT-24's runner)

Each control below is removed in turn, and its intended test must fail:

- the handle list;
- the environment construction;
- the AppContainer for C1/C2;
- the identity check after resume;
- the lock across launch;
- the slot grammar;
- the `.cmd` refusal;
- the deadline;
- the output bound;
- job kill-on-close;
- the trust check;
- the owner check;
- the revocation kill.

### 14.7 Must run on Windows (mocks cannot prove these)

- AppContainer denials: files, network, credentials, opening processes.
- Job limits: memory, process count, CPU measurement, kill-on-close after Yavin's `TerminateProcess`.
- Mitigations, including WMI and COM spawn attempts.
- Handle list inheritance.
- File identity: file IDs, reparse points, ADS, short names.
- `QueryFullProcessImageNameW` after a suspended create.
- Command-line round-trips through real `CommandLineToArgvW` parsing.
- The ACL grant and its removal on the workspace (C2).
- The packaged MSI run of all of the above, in a per-user install and in `Program Files`.

### 14.8 Packaged

- Install a test extension from a signed mirror (as EXT-31/32) and grant a C1 profile in the real consent dialog. It runs, and can be revoked while running (the process ends). Updating the extension asks again.
- The focus test's unresolved state is independent and stays reported as such.

## 15. Open questions requiring explicit approval

| #   | Question                                                                                                                                                                                                                  | Recommendation                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | Approve separate capabilities per class (C1, C2, C3) rather than one "process" capability?                                                                                                                                | Yes                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Q2  | Consent for process grants: keep it in the window (as all grants today, EXT-07: "a compromised window is outside this model") or move it to a native dialog the renderer cannot answer?                                   | A native dialog for C2/C3 at least                                                                                                                                                                                                                                                                                                                                                                                                   |
| Q3  | Allow one-time grants ("Allow once"), and for which classes?                                                                                                                                                              | C1 and C3 only; C2 servers per workspace                                                                                                                                                                                                                                                                                                                                                                                             |
| Q4  | Allow C3 (uncontained) at all?                                                                                                                                                                                            | Not before E1 to E5 are proven; then per workspace, with the residuals in the dialog                                                                                                                                                                                                                                                                                                                                                 |
| Q5  | Accept C2's read-only ACL grant on the user's workspace folder (a persistent change to their files' ACLs)? Alternatives: a broker-mediated file API (servers would need adapting), or copying the workspace (impractical) | **Unresolved — E5 BLOCKED.** A recommended Option A design (per-extension/class SID, read-only, reparse-refusal, native consent, async grant/removal, journaled crash recovery) is **proposed, not approved**, in §24.1, with acceptance gates; needs explicit human approval before any ACL mechanism is built                                                                                                                      |
| Q6  | Allow interpreters (node, python) in C2 with a verified package script?                                                                                                                                                   | Only after E5; C3 otherwise                                                                                                                                                                                                                                                                                                                                                                                                          |
| Q7  | Unsigned external programs: allowed with a warning, or refused?                                                                                                                                                           | Allowed, labelled "not signed"                                                                                                                                                                                                                                                                                                                                                                                                       |
| Q8  | Programs on network shares (UNC) or removable drives?                                                                                                                                                                     | Refused                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Q9  | Re-hash on every launch, or cache by file ID and last-write time with the held handle?                                                                                                                                    | Re-hash for C2/C3; cache for C1                                                                                                                                                                                                                                                                                                                                                                                                      |
| Q10 | Move Yavin's own LSP and checker resolution off `node_modules/.bin`, `PATH` and `.cmd` shims (§3)?                                                                                                                        | **Reopened by E0.2, addressed in E0.3 (§19); verify before closing.** A project server runs only once chosen (path and SHA-256); the choice binds to the code that runs, including TypeScript's `tsserver.js` (V3) and a program selected inside the workspace even through a link (V6); "installed" refuses when it would still run project code (V5). Checkers run project tooling when trusted, by policy (V4)                    |
| Q11 | One AppContainer per extension and class, or per process?                                                                                                                                                                 | Per extension and class (profiles and ACL grants stay bounded)                                                                                                                                                                                                                                                                                                                                                                       |
| Q12 | Raise the host protocol's 1 MiB bound for relayed LSP messages, or end servers that exceed it?                                                                                                                            | End them first; raise only with evidence                                                                                                                                                                                                                                                                                                                                                                                             |
| Q13 | An idle deadline for servers?                                                                                                                                                                                             | No; end with the session                                                                                                                                                                                                                                                                                                                                                                                                             |
| Q14 | Hold the inventory lock across `CreateProcess`, or re-check a generation after resume?                                                                                                                                    | Hold the lock (simpler to prove), and measure its cost                                                                                                                                                                                                                                                                                                                                                                               |
| Q15 | C3 memory: a user setting with an 8 GiB default?                                                                                                                                                                          | Yes, within the job's enforcement                                                                                                                                                                                                                                                                                                                                                                                                    |
| Q16 | (E0-B, F-G1) Gate Yavin's own Git on Workspace Trust, or run it in untrusted folders with protective settings (no fsmonitor, hooks or filters)?                                                                           | **Reopened by E0.2, addressed in E0.3 (§19); verify before closing.** Both. Untrusted folders read only (changes and the network refused until trust), always with protective settings, every configured driver emptied, and submodule/embedded-repository recursion ignored (V1). The background index check (`git_dirty`) runs under the same hardening, and no refused untrusted write records bookkeeping that could run it (V2) |

## 17. E0: process-free alternatives (done) and Yavin's own executable lookup (audited)

E0 is the only phase begun. **No process capability, broker, permission for execution, interpreter, shell, sandbox or ACL change was made.** E1–E6 and the questions of §15 stay as they were, unapproved.

### 17.1 E0-A: what was investigated, and the outcome

| Alternative                                             | Evidence (packages, not run)                                                                                                                                                                                                                                                                                                | Outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`workspace.findFiles`** through Yavin's own search    | Named by 12 benchmark entry points; reached at activation by Path IntelliSense; SVG Preview's Preview All stopped there in the installed application (EXT-31)                                                                                                                                                               | **Implemented.** The layer's `workspace.findFiles` sends `fs.findFiles` (an id of its own, `<id>#find#n`; `fs.cancelFind` on its token), which needs `workspace.fs.read` in both permission checks. The window answers with Yavin's search, `search_project` in its file-listing mode: Yavin's bundled ripgrep, fixed arguments, the open workspace only (natively checked), `.git` always excluded, cancellable (`cancel_search`) and bounded (at most 10 000 results). The glob is ripgrep's (`--glob`, its own argument), refused natively in the window if absolute, containing `..`, beginning with `-` or `!`, holding NUL or a line break, or longer than 1000 characters. Results are canonical workspace URIs (as documents are spelled); anything outside is dropped. No new search engine, no new process, no file access beyond what `workspace.fs.read` already gives |
| A text-search API (`findTextInFiles`) for **Todo Tree** | Todo Tree uses no VS Code search API: it finds ripgrep under VS Code's install folder (`env.appRoot`) and runs it with `child_process`; it writes its icons with Node.js `fs` into its storage folder; its view is a tree view                                                                                              | **No E0 route.** An API Yavin added would not be called; the extension would have to change. Its blockers stay Node.js `fs`, a process and tree views                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Shellcheck's WebAssembly build**                      | Verified: `node_modules/@vscode-shellcheck/shellcheck-wasm` with `dist/shellcheck.wasm` (9.4 MiB). Its web entry (the one Yavin runs) starts `dist/wasm-worker.js`, an **ES-module worker** that receives a compiled **`WebAssembly.Module`**, and a **`SharedArrayBuffer`** for a synchronous WASI file bridge (`Atomics`) | **Deferred, needs a design.** It needs a WebAssembly engine (QuickJS has none), module workers, structured cloning of a module, and shared memory with `Atomics` (Yavin's workers carry JSON only), plus WASI preview 1. The host runs with `PROHIBIT_DYNAMIC_CODE`, so a JIT engine cannot run there; only an interpreter (wasmi- or wasm3-class) could, with fuel and memory bounds. Its speed on a 9.4 MiB GHC-compiled module, its memory, and its attack surface are unmeasured. Nothing was added                                                                                                                                                                                                                                                                                                                                                                            |
| **Git** extensions through Yavin's Git (`git.rs`)       | Git Graph and Git History spawn `git` themselves (Git History asks the `vscode.git` API only for Git's path, then spawns it, sometimes with `shell`); GitLens and Git Blame never reach code (a package limit, an ES module)                                                                                                | **No E0 route.** A `vscode.git` API backed by `git.rs` would not remove their own spawns; exposing Yavin's Git commands to extensions as a substitute for a broker is excluded. Unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Other survey entries                                    | rust-analyzer, clangd, Go, Lua, ruff, Black, clang-format, shfmt, ESLint, Code Spell Checker, test runners, debuggers                                                                                                                                                                                                       | No process-free route that fits E0: each needs its program, an interpreter or a subsystem (testing, debug)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

**Real extensions, measured** (the benchmark's packages, Yavin's install path; the application built after this change):

- **SVG Preview (jock.svg), "Preview All Svg"**: in the installed application (`tests/real/webview-svg.spec.ts`) its page asks, the extension finds the workspace's SVG files with `workspace.findFiles`, the page **draws each** (the probe drawing, 120 px wide), and a click **opens the file** in Yavin's editor. Genuinely working, with no process. Its single-file Preview SVG still previews only documents whose language is `svg` (EXT-25's rule), so its main feature stays **Partly**.
- The benchmark's activation rerun is in the audit's Part I.

### 17.2 E0-B: Yavin's own executable lookup, audited

Every place Yavin itself starts a process (production code; tests excluded):

| Call site                               | How the program is chosen                                                                                              | Through the workspace?                                               | Shell / interpreter?                                                                                                    | Arguments, environment, folder                                                                                                          | Trust / consent / identity                  | Depends on it                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------- |
| `lsp.rs` (language servers)             | `resolve_program`: the project's `node_modules/.bin` first for Node servers (`node_package`), then `PATH`              | **Yes**, by design: a trusted project pins its own TypeScript server | `.cmd`/`.bat` npm shims run through `cmd.exe` (Rust escapes batch arguments since 1.77.2; the toolchain is 1.99.1)      | Fixed argv from the allow-list (`--stdio`); Yavin's own environment; a folder inside the workspace                                      | Workspace Trust (native); no identity check | The TypeScript server and every npm-installed server          |
| `checkers.rs` (project checkers)        | `resolve_program` on `PATH` only                                                                                       | No                                                                   | `npx.cmd` and other shims via `cmd.exe`                                                                                 | Fixed argv; Yavin's environment; the workspace root                                                                                     | Workspace Trust; none                       | `npx tsc`, `cargo check`, … (they run project code by nature) |
| `dap.rs` (debug adapters; Python probe) | `resolve_program` on `PATH` (`py`, `python3`, `python`)                                                                | No                                                                   | Shims possible                                                                                                          | Fixed argv from the allow-list                                                                                                          | Workspace Trust (twice); none               | Debugging                                                     |
| `git.rs`                                | `Command::new("git")`: Rust's search (the child's `PATH`, Yavin's own folder, the system folders, `PATH`; `.exe` only) | No (the repository is the working folder)                            | No shell; **Git itself runs what repository configuration names** (`core.fsmonitor`, hooks, filters, `core.sshCommand`) | An argv allow-list per subcommand; `GIT_TERMINAL_PROMPT=0`, `GIT_EDITOR=true`, `LC_ALL=C`; remote URLs validated (`is_safe_remote_url`) | **No Workspace Trust check** (finding F-G1) | The Git view, on every folder                                 |
| `workbench.rs` (search)                 | The bundled `resources/search/rg.exe`, an absolute path                                                                | No                                                                   | No                                                                                                                      | An argv built from options, every value its own argument; `.git` excluded last; hostile glob values stay globs (tested)                 | The workspace only; none needed             | Search, Quick Open, `workspace.findFiles`                     |
| `ports.rs`                              | `netstat`, `taskkill` by name (Rust's search)                                                                          | No                                                                   | No                                                                                                                      | Fixed argv                                                                                                                              | —                                           | The Ports view                                                |
| `external.rs`, `file_tree.rs`           | `explorer` (macOS `open`, Linux `xdg-open`)                                                                            | No                                                                   | `explorer.exe` acts on its argument (a URL or a path)                                                                   | URLs validated (scheme, host, no commas or quotes); paths canonicalized                                                                 | —                                           | Open in browser, Reveal in Explorer                           |
| `terminal.rs`                           | The user's shell, chosen by the user                                                                                   | —                                                                    | It is the shell, by design                                                                                              | The user's                                                                                                                              | Workspace Trust                             | Terminals                                                     |

**Hardening done (narrow, tested, nothing silently re-selected).** `resolve_program` (`ide-workspace/src/lsp_process.rs`):

1. Looks only in **absolute** `PATH` folders. A relative entry (`.` or an empty one) was resolved against Yavin's own working folder, where a planted file would have been chosen.
2. On Windows, tries only names Windows can start: `.exe`, then `.cmd` and `.bat`. It no longer tries a suffix-less name, which `CreateProcess` cannot run.

`.exe` still comes before any shim, and the trusted project's `node_modules/.bin` still comes first for Node servers. Tests: `only_absolute_path_folders_and_startable_names_are_chosen`, plus the existing lookup and real-server tests. A server found before only through a relative `PATH` entry, or a suffix-less file, is now "not found on PATH", with the existing error.

**Findings needing a separate decision (not changed).**

- **F-G1. Git runs without Workspace Trust.** Every other runner of project-controlled programs asks for trust first: tasks, debugging, language servers, checkers, terminals and extension hosts. Opening a folder runs `git` there, and a folder's own `.git/config` can name programs Git runs during ordinary commands (`core.fsmonitor` during `status`). That is how a downloaded folder can run code when opened. The options are to gate Git on trust, or to pass protective `-c` settings for untrusted folders (`core.fsmonitor=false`, `core.hooksPath=` empty, no filters). Either changes behaviour and needs a decision (Q16).
- **F-L1. `node_modules/.bin` first for Node servers.** A trusted project chooses the server Yavin runs. That is intended (the project's TypeScript version), but it is a choice by workspace content. Making it visible (the server's path in its status) or confirmable is Q10's review.
- **F-L2. `.cmd`/`.bat` shims run through `cmd.exe`.** Needed for npm-installed servers. Today's arguments are fixed by Yavin's allow-lists, so no request reaches `cmd.exe`'s parser. A future broker must refuse shims (§9.3), and Yavin's own use should stay restricted to fixed argv.

All three are addressed by E0.1 (§18).

## 18. E0.1: Git and language-server executable trust (done)

A separate hardening phase for F-G1, F-L1 and F-L2. It changes Yavin's own launches only. No extension capability, workspace ACL, sandbox setting, extension permission or process-execution path was changed, and E1–E6 are not begun.

### 18.1 F-G1: Git in an untrusted repository

**Finding, confirmed by test.** Git runs programs that a repository's own configuration names, during operations that only read:

- `core.fsmonitor` runs during `status`;
- a filter driver picked by `.gitattributes` runs while comparing the working tree (`filter.<name>.clean` or `process`) and in `cat-file --filters`, which the diff view uses (`smudge`);
- a diff driver (`diff.<name>.textconv`, `command`) runs in any porcelain diff;
- hooks run in operations that write;
- more keys apply to the network and signing paths.

The adversarial test plants each one as a command that only appends to a marker file. Its control shows each runs when Git uses the repository as configured. Before E0.1, Yavin ran Git in every opened folder, trusted or not. E0.1's first version still let `diff --no-ext-diff --no-textconv` run the repository's filter: those flags turn off diff drivers, not filters. The adversarial test found this, and the fix below closes it.

**Fix (`src-tauri/src/git.rs`).**

1. **A trust gate before the argument check.** `git_exec` resolves the repository root's trust (`trust::is_path_trusted`, the nearest folder's decision; an unreadable store counts as untrusted). In an untrusted folder, `exec_on` runs only:
   - `operation_scope`'s `Read` set: `status`, `log`, `show`, `diff`, `for-each-ref`, `rev-parse`, `cat-file`, `check-ref-format`, the `remote` listing, `worktree list`, `stash list` and `stash show`;
   - the read form of `symbolic-ref` (at most one name, no `-d`).

   Everything else is refused with `RESTRICTED_GIT` ("…changes its Git repository only after you trust the folder. Viewing history and changes still works."): staging, commits, checkout, switch, merge, rebase, reset, branch, tag, stash push/apply/pop, fetch, pull, push, ref updates. The argv allow-list (`validate_args`) still applies after the gate.

2. **Fixed `-c` hardening** (`HARDENING`), command-line settings that override the repository's own configuration. They run on every untrusted operation and on all of Yavin's internal bookkeeping (`run`, `run_read_only`):
   - `core.fsmonitor=`, `core.hooksPath=`, `core.pager=cat`, `core.editor=true`;
   - `core.sshCommand=`, `core.askpass=`, `core.alternateRefsCommand=`;
   - `diff.external=`, `log.showSignature=false`, `gpg.program=`, `credential.helper=`;
   - `protocol.ext.allow=never`, `uploadpack.packObjectsHook=`, `safe.bareRepository=explicit`.
3. **Drivers by name** (`driver_overrides`). A driver is chosen by name from `.gitattributes`, so no fixed list can cover it. Before a hardened command, Yavin lists the configuration's `filter.*` and `diff.*` names with `git config -z --name-only --get-regexp` (reading configuration runs nothing; it runs under `HARDENING`). Each driver it finds is emptied: `filter.<name>.clean=`, `smudge=`, `process=` and `required=false`, and `diff.<name>.textconv=` and `command=`.
   - Names are kept exactly (case, dots).
   - A name the `-c` syntax cannot spell (one holding `=`) refuses the operation; it is never skipped.
   - If Git cannot read the configuration, nothing is assumed about it: the operation fails.
4. **Patch paths carry `--no-ext-diff --no-textconv`.** That was already the case for the window's diff and show calls. It now holds for `stash show` too (`repository.ts`; the `STASH` rules accept both flags). A hardened diff without these flags runs no driver either: Git refuses to spawn the emptied command ("cannot spawn"), and the diff fails closed.
5. **Reads take no optional locks** (`GIT_OPTIONAL_LOCKS=0`). An untrusted `status` therefore never writes the index, so no index hook has an occasion to run.

**Before and after.**

| In a folder that is                  | Before E0.1                                                                               | After E0.1                                                                                                                                           |
| ------------------------------------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Untrusted: viewing                   | Status, history and diffs, with the repository's fsmonitor, filters and diff drivers live | Status, history, diffs, stashes, branches and refs shown; none of the repository's programs run                                                      |
| Untrusted: changing, or the network  | Allowed, with its hooks, filters and merge drivers                                        | Refused with `RESTRICTED_GIT` until the folder is trusted                                                                                            |
| Trusted                              | The repository's configuration applies                                                    | Unchanged: no hardening on `git_exec`, so filters (Git LFS), hooks, credential helpers and signing work as before                                    |
| Yavin's own bookkeeping (any folder) | The repository's configuration applies                                                    | Always hardened. A repository whose configuration names a driver with `=` cannot be opened; one whose configuration Git cannot read fails, as before |

**Residual.**

- **A trusted repository runs its own configuration.** That is the meaning of trust, as for tasks and terminals.
- **Untrusted diffs of filtered files show the stored form.** For example, an LFS pointer rather than the content, because the user's own filters are emptied too.
- **One extra `git config` per hardened command.** It runs the bookkeeping and untrusted paths, not trusted `git_exec`.
- **Clone (`run_within`) is unchanged.** It is user-initiated, the URL is validated (`is_safe_remote_url`), and the repository's configuration does not exist yet.
- **Git's own program.** `Command::new("git")`, resolved by Rust's search (§17.2), is outside this phase.
- **Keys beyond the list.** A Git release could add a new program-running key; `the_hardening_set_covers_every_config_key_that_runs_a_program` records the list to review.

### 18.2 F-L1: a project's own language server

**Finding.** For Node servers, `resolve_program` looks in the project's `node_modules/.bin` first. Trusting the folder therefore also chose the program Yavin ran, and the file could change between runs. The same applied to any `PATH` folder inside the workspace.

**Fix (`src-tauri/src/lsp.rs`, the window's `client.ts`, `manager.ts`, `App.tsx`).**

- **Workspace trust is necessary, not sufficient.** After resolution, a program whose canonical path lies inside the canonical workspace (`project_provided`) runs only if the user chose it for that workspace and server (`chosen_program`). The choice is recorded natively in `project-servers.json` (app config directory) with the program's canonical path and SHA-256. It runs only while both still match.
  - Not yet chosen: the start fails with `needs-approval:`, shown as "TypeScript: choose server" (a warning, not a failure, and with no restart loop).
  - Changed since chosen: refused with the same prefix ("…changed since you chose it…"), asking again.
- **The choice** (`lsp_choose_program`) needs trust. The window sends only the server id, the folder and `project`/`installed`; never a path. Yavin re-resolves and hashes natively.
  - "Use the project's server" records that file.
  - "Use the installed server" makes Yavin look on absolute `PATH` folders only (no `node_modules/.bin`), and never run the project's.
- **A program outside the workspace** runs as resolved, unchanged.

**Residual.** The hash covers the entry program only (the npm `.cmd` shim), not the JavaScript it runs or the `node.exe` it picks (npm shims prefer one next to themselves). Choosing the project's server is a decision to run the project's code. It is recorded, explicit and invalidated by a change to the entry file, but it is not a verification of that code. There is also a window between hashing and starting in which a same-user process could swap the file; same-user attackers are outside the model (§4.2).

### 18.3 F-L2: Windows `.cmd`/`.bat` shims

**Kept, because npm-installed servers and `npx` are shims.** They are controlled as follows:

- **Lookup** (§17.2): absolute `PATH` folders only; on Windows `.exe` first, then `.cmd`, then `.bat`; never a suffix-less name.
- **Who uses them:** language servers, checkers and the debug adapters' Python probe, each with fixed argv from its allow-list (`--stdio`, the checker's own flags). Nothing a window or extension sends becomes an argument.
- **Project shims** run only after the F-L1 choice.
- **The broker** (§9.3) must refuse shims and interpreters.

**The exact invocation, observed on this toolchain** (Rust 1.99.1; the batch-argument fix shipped in 1.77.2, CVE-2024-24576). Rust's `Command` runs a `.cmd`/`.bat` as:

```text
cmd.exe /e:ON /v:OFF /d /c ""<shim path>" <arg> <arg>…"
```

- `/d` skips the AutoRun registry commands, and `/v:OFF` disables delayed expansion.
- The shim's path is quoted, and every argument is quoted and escaped for `cmd.exe`'s parser.
- A probe ran a `.cmd` printing `%CMDCMDLINE%` and `%*`:
  - `a&echo INJECTED` arrived as one argument, with no command run;
  - `%PATH%` arrived unexpanded, rewritten as `%%cd:~,%PATH%%cd:~,%`;
  - an embedded `"` arrived doubled;
  - an argument holding a line break was refused before launch (`InvalidInput`, "batch file arguments are invalid").

**Residual.** Escaping protects the invocation, not the script. A batch file that re-parses its own arguments (`echo %*`, `call`, `for`) can still act on them. The probe's own `echo %CMDCMDLINE%` line did exactly that. Yavin's fixed argv keeps this out of reach. Arbitrary arguments must never reach a shim, so a future broker must refuse them (§9.3). The shim and `cmd.exe` also run with Yavin's environment (`PATHEXT`, `COMSPEC`) as the user set it.

### 18.4 Tests and mutations (E0.1)

| Check                                                                                | What it proves                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git::a_hostile_repositorys_configured_programs_never_run_for_untrusted_reads` (new) | fsmonitor, a filter (clean/process), a diff driver (textconv/command) and two hooks planted as marker writers. The control shows each runs as configured. Six untrusted reads (status ×2, diff ×3, `cat-file --filters`) plus log, and hardened bookkeeping, run none. Trusted, the filter runs as before |
| `git::every_configured_driver_is_emptied_and_an_unspellable_one_refuses` (new)       | Every driver emptied by its exact name (mixed case, dots); two-part keys skipped; a name with `=` refuses, and a hardened `status` then fails                                                                                                                                                             |
| `git::an_untrusted_workspace_allows_reads_and_refuses_the_rest` (new)                | The reads succeed; 11 writes, ref updates and network operations return `RESTRICTED_GIT` untrusted, and reach Git trusted                                                                                                                                                                                 |
| `git::command_line_overrides_beat_a_repositorys_own_config` (new)                    | `-c` beats the repository's value; the hardened value is empty                                                                                                                                                                                                                                            |
| `git::the_hardening_set_covers_every_config_key_that_runs_a_program` (new)           | The fixed list                                                                                                                                                                                                                                                                                            |
| `lsp::project_server_tests` (3 new)                                                  | Outside the workspace runs as resolved; a project server is refused until chosen, then runs only while its path and hash match (a changed file is refused again); choosing "installed" never runs the project's                                                                                           |
| `lsp_process::only_absolute_path_folders_and_startable_names_are_chosen` (E0)        | Relative `PATH` entries and suffix-less names are never chosen (executable substitution through `.` or an empty entry)                                                                                                                                                                                    |
| `manager.test.ts` (extended)                                                         | `needs-approval:` becomes the `approval` state with the marker stripped, starts nothing and does not retry; "TypeScript: choose server"                                                                                                                                                                   |
| Shim invocation (a probe, §18.3)                                                     | The `cmd.exe` command line and argument escaping, observed                                                                                                                                                                                                                                                |
| Security mutations EXT-33 H01–H06                                                    | All caught by their intended test: the trust gate, the fixed hardening, project-server approval, the hash check, the driver overrides, the unspellable-name refusal                                                                                                                                       |

## 19. E0.3: fixes from the independent review (done)

E0.2 was an independent, read-only security review of E0 and E0.1. It confirmed six defects. E0.3 fixes them. It changes Yavin's own launches only -- no extension capability, workspace ACL, sandbox setting or extension permission -- and E1–E6 are not begun. Each fix has a regression test and a security mutation caught by that test.

### 19.1 V1 -- a submodule's or embedded repository's own filters (High)

**The hole.** The driver overrides (§18.1) empty the drivers the _outer_ repository names. A submodule, or a bare embedded repository shipped inside a downloaded folder (a nested `.git` with its own config), carries its own filters and diff drivers; `git status`/`git diff` recurse into it and run them. The first version of E0.1 missed this, and so did the review's first probe until a nested filter was planted.

**The fix.** `diff.ignoreSubmodules=all` is now part of the fixed hardening set (`git_harden::HARDENING`), so every hardened status and diff -- on every call path, untrusted or bookkeeping -- ignores submodule state and does not recurse into the inner repository. A trusted repository is never hardened, so its submodules work as before. The test plants a filter in both a real submodule and an embedded repository, proves each is live, and shows an untrusted status and diff of the outer repository run neither.

### 19.2 V2 -- the background index check, and trust ordering (Medium)

**The hole.** `operations::git_dirty`, which checks whether paths match the index while attributing watcher events, ran `status` with only `core.fsmonitor=false` -- no fixed hardening, no driver overrides, no trust gate. It is reached whenever a `GitClean` operation is in flight (`git_exec` on a worktree-writing command, or a clone). A refused untrusted write still recorded that operation and its crash intent _before_ the trust gate, so a concurrent watcher batch could run this weak check against a hostile untrusted repository; a freshly cloned hostile remote reached it too.

**The fix.**

- `git_dirty` now runs under the same hardening as the user-facing Git, from one shared source (`ide_workspace::git_harden`): the fixed `HARDENING` set and the per-name driver overrides, computed for the repository. If the drivers cannot be read safely, it declines to check (returns "could not say") rather than run a program.
- `git_exec` resolves trust and refuses an untrusted non-read operation **before** it records any `GitClean` expectation or crash intent, so none is ever left for a watcher batch to act on. `exec_on` still gates too (defence in depth, and for direct callers).

The documentation claim that "Yavin's own bookkeeping is hardened" is now true, enforced from the single `git_harden` definition. Tests: `git_dirty` runs neither an outer clean filter, an outer fsmonitor, nor a submodule/embedded filter, while still reporting a dirty tracked file; and no worktree-writing subcommand is an allowed untrusted read (so no stale expectation is created).

### 19.3 V3 -- TypeScript's `tsserver.js` (Medium)

**The hole.** `typescript-language-server` runs the workspace's own `node_modules/typescript/lib/tsserver.js` when the project ships one -- even when the server program itself is installed. So a trusted workspace ran project JavaScript with no choice, and "Use the installed server" still loaded it.

**The fix.** A server may declare a `delegate`: a workspace file it auto-loads and runs (TypeScript's `tsserver.js`). The F-L1 machinery now binds to the _project artifact_ -- the code that actually runs -- which is the server program when it is inside the workspace (§19.5) or the delegate file otherwise. The approval's identity (path and SHA-256) is that artifact, not the entry shim, so it reflects the JavaScript that executes and a change to it asks again. "Use the installed server" is honoured only when it would run no project code; if the installed server would still auto-load the workspace delegate, Yavin refuses rather than run it unchosen, and asks the user to choose the project's server or remove it.

**Residual.** A seamless pin of the installed server to a bundled TypeScript (`initializationOptions.tsserver.path`) is deferred: it crosses the renderer's LSP initialize contract and needs its own design. Until then, "installed" is refused (not silently unsafe) when the workspace ships its own `tsserver.js`.

### 19.4 V4 -- checkers (Low, documentation)

Checkers (`npx --no-install tsc`, `npx eslint`, `cargo check`) run the project's own tooling, and ESLint loads the project's JavaScript configuration. This is intended: checkers are trust-gated (the command requires the folder trusted), exactly like tasks and the terminal, and the launcher is resolved on absolute `PATH` only (§17.2). This is **not** the per-server approval language servers get. E0.1's audit table wrongly implied checkers do not go through the workspace; §17.2 and `ARCHITECTURE.md` now state the behaviour plainly. No code change.

### 19.5 V5, V6 -- the installed path and links (Low)

- **V5.** The "installed" re-resolution searches absolute `PATH` only, but a `PATH` folder can lie inside the workspace. The installed result is now itself checked for being project code; if it is, "installed" is refused, so a workspace `PATH` entry cannot run unchosen.
- **V6.** "Inside the workspace" is judged by the program's _selected location_ (lexically), not only its canonical target, so a `node_modules/.bin` entry that is a symlink or junction leading outside the workspace is still the project's and needs a choice. A link from outside that lands inside the workspace is caught by the canonical test. The approval binds to the selected location.

### 19.6 Review notes

- **Signature programs.** `gpg.ssh.program=` and `gpg.x509.program=` are added to the fixed hardening set, matching `gpg.program=`. Yavin never asks Git for signature status, so these run only for a compromised window (outside the EXT-07 model); emptied as defence in depth.
- **`core.hooksPath`.** Confirmed on Git 2.55 that an empty `core.hooksPath=` disables repository hooks (probe: a hook fired with the repository's configuration, not with the override).
- **Shim-only hashing and the hash-to-launch race** remain documented residual risks (§18.2), unchanged.

### 19.7 Tests and mutations (E0.3)

| Check                                                                               | What it proves                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git::a_hostile_repositorys_...` (extended)                                         | V1: an embedded repository's own clean filter, live by its own diff, runs during no untrusted status or diff of the outer repository                                                                       |
| `git::no_worktree_writing_operation_is_an_allowed_untrusted_read` (new)             | V2: every worktree-writing subcommand is refused untrusted, so `git_exec` records no `GitClean` expectation before the trust gate                                                                          |
| `operations::the_background_index_check_runs_no_configured_program` (new)           | V2: `git_dirty` runs neither an outer filter, an outer fsmonitor, nor a submodule/embedded filter, and still reports a dirty tracked file                                                                  |
| `git_harden::*` (new, `ide-workspace`)                                              | the shared hardening set names each program key, every driver is emptied by exact name, an unspellable name refuses                                                                                        |
| `lsp::a_server_that_loads_a_workspace_file_needs_a_choice_keyed_to_that_file` (new) | V3: a workspace `tsserver.js` needs a choice keyed to that file; "installed" is refused while it would still load it; without it, "installed" runs                                                         |
| `lsp::an_installed_path_inside_the_workspace_is_still_the_projects` (new)           | V5: a `PATH` entry inside the workspace is refused for "installed"                                                                                                                                         |
| `lsp::a_program_selected_inside_the_workspace_is_the_projects_by_location` (new)    | V6: a program is the project's by its selected location, not its canonical target                                                                                                                          |
| Security mutations EXT-33 H01–H10                                                   | All caught by their intended test (H07 submodule recursion, H08 driver overrides in `git_dirty`, H09 the installed guard, H10 the fixed set in `git_dirty`, and H01–H06 retargeted to the refactored code) |

## 20. E1: the native C1 broker (done)

E1 implements the first and narrowest brokered capability, **C1** -- a one-shot stdin→stdout filter -- as a private native module (`ide-workspace/src/broker.rs`). It realises §6.1 (C1), §7 (identity), §9.1–§9.8 (data flow, profiles, resolution, arguments, environment, sandbox, output/deadlines, errors) and §11's C1 bounds. It does **not** implement E2 (consent/grants), E3 (expanded resource work), or E4 (extension APIs, C2 servers, C3). The module is not a Tauri command and has no `native(...)` binding; no extension JavaScript can reach it, and Yavin ships no C1 profiles yet.

### 20.1 Architecture

A `C1Broker` holds a fixed set of Yavin-authored `C1Profile`s and a live-process counter. `run(profile_id, slots, stdin, cancel)`:

1. refuses oversized `stdin` and an unknown `profile_id` before anything else;
2. builds the argv from the profile's typed `Slot` template and the caller's `SlotValue`s -- a caller value can only be an enumerated string, a bounded integer, or a bare file name, never a path, a flag, a separator, a NUL or a newline (T6);
3. verifies the program's identity (§20.3) and holds the file open with no write/delete sharing;
4. takes a concurrency slot (fail: `TooManyProcesses`);
5. starts it with `sandbox::spawn` (EXT-10): an AppContainer with no capabilities, its own job (one process, memory cap, CPU cap, kill-on-close), every mitigation, three pipes, nothing inherited. **If the sandbox cannot be set up the run fails (`SandboxUnavailable`); there is no unsandboxed fallback;**
6. feeds `stdin`, reads stdout/stderr on their own threads into bounded buffers, and waits under the total deadline, the cancel flag and the output bound, ending the job (`TerminateJobObject`) on any of them.

The OS boundary is `sandbox.rs`'s, proven by the EXT-10 integration test and re-proven through the broker in E1 (§20.5).

### 20.2 OS-enforced restrictions (Windows, the shipped platform)

Inherited from the sandbox and confirmed from inside a brokered C1 process: it is an AppContainer (`appcontainer=yes`); it cannot read a user's file, reach loopback or any network, start a child process, or open a handle to its parent; it has one process, a committed-memory cap, and all mitigations (no child processes, no Win32k, no dynamic code, strict handles, no remote/low-label images, …). Off Windows, every run is `UnsupportedPlatform` (fail closed).

### 20.3 Executable identity and no-swap (§7.3)

The program is canonicalised; refused if it is a reparse point, a script by extension (`.cmd/.bat/.ps1/.vbs/.js/.lnk/.url/.msi`), or not a PE image (checked by header, not name). It is opened with `FILE_SHARE_READ` only -- no writer, renamer or deleter while the handle lives -- hashed (SHA-256) from that handle, and checked against the profile's pinned digest; a mismatch is `ExecutableChanged`. The handle is held across `CreateProcess`, so the verified bytes cannot be swapped between the check and the launch. **E1 re-hashes on every launch** (the conservative side of Q9; no caching), so Q9 is not relied upon.

### 20.4 Resource limits, and how each was measured

| Limit                        | Value                            | Enforced by                                         | Measured by                                                                                     |
| ---------------------------- | -------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| stdin                        | ≤ 8 MiB                          | broker, before launch                               | `input_past_the_bound_is_refused_before_launch` (`InputTooLarge`)                               |
| stdout                       | ≤ 16 MiB                         | broker reader; job ended over it                    | `output_past_the_bound_ends_the_run` (a real filter floods 20 MiB → `OutputTooLarge`)           |
| total deadline               | 30 s (default; a seam for tests) | broker timer → `TerminateJobObject`                 | `a_filter_past_its_deadline_is_ended` (a blocking filter, 1 s deadline → `Timeout`)             |
| concurrency                  | ≤ 8 host-wide                    | atomic counter under the cap                        | `the_concurrency_cap_holds_and_slots_are_returned` (8 ok, 9th refused, released slot reusable)  |
| committed memory             | 512 MiB (job)                    | Job Object memory limit                             | EXT-10 `the_job_holds_its_limits` (job reports the cap) + the probe's over-limit alloc = denied |
| processes in the job         | 1                                | `ActiveProcessLimit = 1` + child-process mitigation | EXT-10 `the_job_holds_its_limits` (active=1); broker probe: `spawn-cmd` denied                  |
| CPU (resource, not security) | 1 logical processor's worth      | Job CPU rate cap                                    | EXT-10 `the_job_holds_its_limits` (cpu_rate readback)                                           |

### 20.5 Security tests and mutations

The broker's tests drive a probe **through** `C1Broker::run` -- the test binary is itself the brokered program -- so each refusal is the operating system's, not a mock, and not merely "a program started":

- `a_brokered_filter_is_sandboxed_and_sees_only_its_stdin`: AppContainer; a user file, loopback, a child process and a handle to the parent all denied.
- `stdin_goes_in_and_stdout_comes_back`; `slots_are_released_so_runs_in_a_row_succeed`.
- `a_substituted_or_mismatched_program_is_refused` (`ExecutableChanged`, `ExecutableNotFound`, a `.cmd` script refused); `a_non_program_file_is_refused` (header checked).
- `output_past_the_bound_ends_the_run`; `a_filter_past_its_deadline_is_ended`; `a_running_filter_can_be_cancelled`.
- Cross-platform unit tests: argument injection through enum/int/file-name slots, slot kind/arity, unknown profile, input bound, the concurrency cap, and `UnsupportedPlatform` off Windows.

Security mutations **EXT-33 B01–B05**, each caught by its intended test: skipping the identity check, the input bound, the concurrency cap, the file-name separator check, and the output-bound precedence (a flood that exits before the wait loop notices -- a real gap the test found and the fix closed).

### 20.6 Residual risks

- **Same-user trust.** The pinned digest and the held handle stop substitution of the file between check and launch; they do not stop a same-user process from having planted a different program at the profile's path earlier (that is the verified-copy/EXT-19 guarantee, and consent is E2). Off-model per §4.2.
- **The program's own behaviour.** The sandbox bounds what it can reach; a filter that merely mangles its stdin→stdout within those bounds is the user's choice to run it (E2's consent).
- **Deferred to later phases:** consent and grants (E2), the per-extension concurrency cap and the extension-facing API (E4), and the empty production profile set until then.

## 21. E2: consent and capability grants (done)

E2 adds the native consent and grant authority that gates the E1 C1 broker (`ide-workspace/src/grants.rs`), realising §8 and §9.1's authorization step. **Deny by default:** a C1 filter runs only when the user has granted it. E2 does not wire a window command or an extension-facing API (E4), does not expand resource limits (E3), and does not implement C2 (E5) or C3 (E6); Yavin still registers no production profiles.

### 21.1 The grant, and what it binds to (§8.2)

A `Grant` binds the extension id, the installed **copy** id (version + package hash, EXT-19), the program's canonical **path and SHA-256**, the **profile**, the **scope** (C1 only in E2), and optionally a **workspace**, with a monotonic `grant_id` for revocation. A `LaunchKey` describes the launch; a grant authorises it only when every binding is equal (workspace either unbound or the same). Any change — an update (copy id), a replaced program (hash), a different profile, scope or workspace — matches no grant, so the user is asked again (§8.3).

### 21.2 Consent — native, deny by default

`request(GrantRequest, &dyn Approver)` records a grant **only** if the approver approves; the `Approver` is the sole authority, and in production it is a native OS dialog (`DialogApprover`, `rfd`) — the window cannot answer it. There is no API anywhere that turns a renderer- or extension-supplied "approved" into a grant: the renderer can trigger a request, never decide it, and an extension cannot approve itself or broaden a grant. The dialog shows the extension, the program's path, signer and first 12 hash digits, the profile and the C1 class in plain words, and never says "safe" (§8.6; `consent_body`, tested). Workspace Trust is necessary for any class but is **not** consent to run a program.

### 21.3 Native enforcement at launch (§9.1)

`GrantAuthority::run_c1(broker, key, slots, stdin, cancel)` authorises `key` (deny by default → `PermissionDenied`), then runs through the E1 broker with a `LaunchObserver` so the process can be ended on revocation. The broker independently re-verifies the program's bytes against the pinned SHA-256 and holds the file open (E1, §7.3), so even a valid grant cannot run a swapped program. The renderer is never in this path.

### 21.4 Revocation, and the launch-versus-revoke race

`revoke(grant_id)` removes the grant and **ends its running processes before it returns** (§8.3, T19). It is race-safe against a launch in flight because the authority's lock is held across both the register-at-launch (the observer's `started`) and the revoke:

- revoke before the launch registers → `started` finds the grant gone and tells the broker to end the process at once;
- revoke after it registers → revoke clears the launch's live flag and ends its job.

Either way the process dies and the run fails `PermissionDenied`. A subtlety the tests caught: when revoke ends the job the process may exit just as the broker's wait loop polls it, so the broker judges the cleared live flag to win over the exit — revocation is never reported as a successful run.

### 21.5 Persistence and fail-closed

Grants are Yavin's alone: JSON in the app config folder, written atomically (`durable::write_json`). A grant that cannot be persisted is not kept in memory (never silently in force). An unreadable or corrupt store yields **no** grants, so every launch is denied. Grants are stored and keyed separately from the trust store.

### 21.6 Outstanding questions

- **Q2** (native consent dialog): taken — `DialogApprover` is a native OS dialog, not renderer UI.
- **Q14** (hold the lock across the launch vs a generation counter): taken the **hold-the-lock** side (simpler to prove), across register and revoke.
- **Q3** ("Allow once"): **not** implemented in E2 — grants are per extension-version (and optionally per workspace); a one-shot grant is deferred. No approval invented.
- The window/extension consent flow and the "Blocked … Allow" affordance (§8.5) are E4.

### 21.7 Tests and mutations

- Unit (cross-platform, `grants.rs`): deny by default; a grant only after approval; the consent body names the program and never says "safe"; reapproval on a changed copy, program, profile or path; no reuse across extensions or installs; a workspace-bound grant applies only there; persistence across a restart; a corrupt store grants nothing; a grant that cannot be saved is not in force.
- Live (Windows, `tests/grants.rs`), through the real broker and sandbox: a granted filter runs end to end; an ungranted one is denied; **revocation ends a running filter before `revoke` returns**, the run fails `PermissionDenied`, and the grant is gone afterwards.
- Security mutations **EXT-33 GR01–GR06**, each caught by its intended test: consent bypass, cross-extension reuse, surviving an update, surviving a changed program, ignoring the workspace binding, and revocation that fails to signal a running process. E1's B01–B05 still hold.

### 21.8 Residual risks

- Same-user tampering with the grants file or the program is off-model (§4.2); the authority re-checks every binding and the broker re-verifies the bytes, but a same-user attacker who can write Yavin's config can also do worse directly.
- Revocation persistence is best-effort after the kill: if the write fails the processes are still ended, but the grant could reappear on restart; reported as an error.
- No production profiles and no window/extension path yet (E4), so nothing reaches the authority in the shipped build.

## 22. E3: resource limits, measured and enforced (done)

E3 audited every C1 resource limit, verified each **live through the broker** (not by trusting a configuration call), fixed the gaps found, and proved cleanup on every termination path. No new capability, no extension API (E4), no C2/C3; the broker and grant authority stay private to the native side.

### 22.1 Each limit: value, mechanism, evidence

| Limit          | Configured           | Enforced by                                         | Live test                                                                                     | Observed                                                             | Known limits                                                                         |
| -------------- | -------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| CPU            | ~1 logical processor | Job CPU rate **hard cap**                           | `the_cpu_hard_cap_holds_under_sustained_load`                                                 | 20 cores spun 1.5 s → ~1.7–2.5 s CPU vs a 30 s uncapped budget (~8%) | short-window scheduling drifts above exactly 1×; no cap on a 1-core box (test skips) |
| Memory         | 512 MiB (job commit) | Job `JobMemoryLimit`                                | `the_job_memory_cap_refuses_an_over_limit_allocation`                                         | a 600 MiB allocation is refused inside the sandbox                   | a commit cap: a program that handles allocation failure keeps running under it       |
| Processes      | 1                    | `ActiveProcessLimit = 1` + child-process mitigation | `a_brokered_filter_is_sandboxed_and_sees_only_its_stdin`, EXT-10                              | starting `cmd.exe` is denied                                         | —                                                                                    |
| Total deadline | 30 s (a test seam)   | broker timer → `TerminateJobObject`                 | `a_filter_past_its_deadline_is_ended`                                                         | a blocking filter at a 1 s deadline → `Timeout`                      | —                                                                                    |
| Cancellation   | —                    | cancel flag → kill                                  | `a_running_filter_can_be_cancelled`                                                           | `Cancelled`                                                          | —                                                                                    |
| stdin          | 8 MiB                | checked before launch                               | `input_past_the_bound_is_refused_before_launch`                                               | `InputTooLarge`                                                      | —                                                                                    |
| stdout         | 16 MiB               | bounded reader → job ended                          | `output_past_the_bound_ends_the_run`                                                          | a 20 MiB flood → `OutputTooLarge`                                    | the kept slice is the head                                                           |
| stderr         | 64 KiB               | bounded reader; **pipe still drained**              | `stderr_is_bounded_and_does_not_deadlock`                                                     | an 8 MiB flood → kept exactly 64 KiB, run still finished             | the kept slice is the head, diagnostic only                                          |
| Concurrency    | 8 host-wide          | atomic counter, RAII slot                           | `the_concurrency_cap_holds_and_slots_are_returned`, `a_slot_is_released_after_an_aborted_run` | a 9th launch refused; the slot is 0 again after a timeout            | per-extension cap is E4                                                              |

### 22.2 The gap E3 found and fixed

The stderr reader kept a bounded slice with `if text.len() < MAX_STDERR { … buf[..n.min(room)] }`. Because the read buffer (8 KiB) evenly divides the 64 KiB cap, the `n.min(room)` clamp never actually truncated — the `if` did all the bounding, and a mutation of the clamp was equivalent (and a naive mutation of the `if` only made the subtraction underflow and panic, leaving stderr empty, so it looked "bounded"). E3 restructured it to a single `take = MAX_STDERR.saturating_sub(len).min(n)` with no guard: the bound now truncates correctly for any buffer size, the pipe is always drained (no deadlock, tested with an 8 MiB flood), and a mutation that drops the clamp observably keeps ~8 MiB (caught by R01). No behavioural change to a well-behaved filter.

### 22.3 Cleanup on every path

Every termination path — normal exit, a non-zero/crashing exit, the deadline, cancellation, output overflow, and grant revocation — ends with the job closed (kill-on-close kills the process tree), the stdin/stdout/stderr reader threads joined, and the concurrency slot released by its RAII guard. A verification failure takes **no** slot (the slot is reserved only after identity is verified), so refused launches cannot exhaust concurrency; a spawn failure drops the slot it reserved. Tests: `a_crashing_filter_is_reported_and_cleans_up` (exit 3 reported, slot 0), `a_filter_that_never_reads_stdin_is_still_ended` (a non-reading filter with a 2 MiB stdin that blocks the writer is still ended by the deadline, no hang, slot 0), `a_refused_launch_takes_no_slot` (20 refused launches, slot 0), and the E2 revocation test (a revoked process ended before `revoke` returns). `running_now()` reads the live count for this evidence.

### 22.4 Residual risks and limitations

- **CPU** is a hard cap that holds strongly under load (~8% of the uncapped budget), but over a short window it is not exactly one core (scheduling granularity); it is a throughput cap, not an anti-DoS guarantee against a filter that merely uses its allowed core for the deadline.
- **Memory** is a commit cap; a filter that degrades gracefully under allocation failure keeps running within it rather than being killed.
- **stdout/stderr** keep the head of an over-long stream; the tail is dropped.
- The **per-extension** concurrency cap (2) and any configurable limits are E4/E-config; E3 enforces the host-wide cap (8).

## 23. E4: the C1 extension API (done)

E4 exposes the C1 filter to extensions and routes every call through the native grant authority and broker. It realises §8.4 (requests from a declaration), §9.1 (the authorization sequence) and the extension-facing half of §6.1. It does **not** implement C2 (E5) or C3 (E6), add a general process-execution API, or ship any production profile.

### 23.1 The exposed API

An extension calls `yavin.process.runFilter(profileId, slots, input)` (the Yavin API object the host passes to `activate`; `bootstrap.js`). It names only a Yavin-shipped **profile id** and **typed slots** (enum, bounded int, bare file name) with the document text as `input`. It can never name a program path, raw arguments, or a shell. The call becomes a `process.runFilter` request; its manifest must declare the `process` permission (§8.4), and an undeclared or unknown method is refused as before.

### 23.2 The native authorization path (§9.1)

`process.runFilter` is handled exactly like `secrets.*`: a request the host allows by capability and then answers **natively**, so the window never holds the process.

1. `need_of_request` validates the request's shape and requires the `process` capability.
2. The host's `decide`/`HostAuthority::allow` checks that capability for the loaded copy (trusted, enabled, still the installed copy, granted) — the **first native gate**.
3. `ProcessCapability::run_filter` builds a `LaunchKey` whose identity is the **loaded `HostCopy`** (extension id, and a copy id of version + package hash) — never anything in the request — and whose program path and SHA-256 come from the **profile**, never the request.
4. `GrantAuthority::authorize` checks the specific grant (copy, program, profile, scope, workspace) — the **second native gate** — and the per-extension concurrency cap.
5. The broker runs it (E1–E3): identity re-verified from a held handle, no-capability sandbox, bounded I/O, deadline, host-wide concurrency. Its result returns to the extension; a refusal is a structured error, and the window is told only the method and capability, never the payload.

The renderer and extension JavaScript are authoritative for nothing here: identity is the host's, the program is the profile's, consent is the native dialog's.

### 23.3 Consent

A grant is created only through `GrantAuthority::request` and a native `Approver` (the OS dialog, `DialogApprover`). The window-facing commands `process_request_consent`, `process_revoke` and `process_grants` let the window trigger consent and manage grants, but the **decision is the dialog's** and the **identity is the loaded copy's** (`ExtensionService::host_copy`), so an extension cannot approve itself, borrow another extension's grant, or broaden its own, and the renderer cannot forge approval. Workspace trust is necessary but is not this consent. Denial, cancellation, a revoked grant and a changed copy or program all surface as a refusal the extension's page can show with an _Allow_ affordance; wiring that button in the renderer waits until the first profile ships (§23.6).

### 23.4 Per-extension concurrency

`GrantAuthority` enforces a per-extension cap of `MAX_PER_EXTENSION` = 2 (the broker enforces the host-wide 8). A slot is reserved under the authority's lock when a run is authorized and released when it ends, however it ends, so one extension cannot starve the host.

### 23.5 Tests and mutations

- **End to end through the real QuickJS host** (`extension_host::real_host::a_filter_request_is_gated_by_the_process_capability_natively`): a sample extension calls `yavin.process.runFilter`; granted the `process` capability it reaches the native authority (and, with no profile registered, gets `UnknownProfile`); ungranted it is refused at the capability gate, and the window is told only the method and capability. No process is spawned (no profile), so the test needs no sandbox.
- **`process_capability` unit tests** (no spawn): an unknown profile is refused; without a grant the broker is never reached; a grant lets it reach the broker (which refuses a missing program); **identity is the copy's, not the request's** (another extension with identical params is denied); an updated copy loses the grant; malformed slots are refused; a workspace-bound grant does not apply elsewhere.
- **Per-extension cap, live** (`ide-workspace`): two filters block, a third is `TooManyProcesses`, and the cap frees after they end — proven with the real sandbox (where 4551 does not apply).
- Security mutations **EXT-33 E4-01..03**, each caught by its intended test: the per-extension cap removed, identity taken from the request, and the capability gate dropped (the last caught end to end through the real host). E1–E3's mutations on the changed files still hold.

### 23.6 Residual risks and what is deferred

- **No production profiles.** E4 ships none; every `process.runFilter` is `UnknownProfile` in the shipped build. A profile needs a concrete use case and a security review (its program's identity and every argv slot), not a benchmark number.
- **The renderer _Allow_ affordance** (§8.5) and a per-call cancellation token are deferred until a profile ships; the native commands and the broker's cancel/deadline/revocation already exist.
- **Same-user trust** is off-model (§4.2): identity and grants are re-checked natively and the broker re-verifies bytes, but a same-user attacker who can write Yavin's config can do worse directly.

## 24. E5: C2 contained servers (BLOCKED on Q5)

E5 was attempted and is **blocked**, not implemented. A C2 server's defining requirement is **read-only access to the workspace** from inside a no-capability AppContainer (§6.1, §9.5). On Windows the only way a real third-party server — ruff (`ruff server`), the Lua language server, the concrete use cases — can read the workspace is for Yavin to add a read ACE for the container's SID to the **user's workspace folder** (line 145, line 401). That is design question **Q5**, whose recommendation is "**decide before E5**" and whose residual (line 401) is "an ACE for the container SID persists on the user's files … needs approval (Q5)."

Why this cannot be enforced within scope:

- **It is an unresolved approval.** Q5 is open; implementing C2 would mean inventing that approval, which this work does not do.
- **It modifies the user's files' ACLs persistently.** The EXT-10 sandbox grants read/execute only on the extension's own program folder (`sandbox::grant_program`, one `SetNamedSecurityInfoW` on that folder); there is no workspace-granting path. Adding one would write an ACE onto the user's workspace, with removal required at revocation, disable and uninstall and recovery if Yavin crashes in between — and its cost on large trees is unmeasured (Q5).
- **The Q5 alternatives do not work for a real server.** A broker-mediated file API would require adapting each server (they read files through the OS filesystem, not a Yavin API); copying the workspace is impractical (size, staleness). Neither lets ruff or the Lua server run.

Implementing C2 any other way would be a **weaker fallback** — running the server with full (uncontained) workspace access, or without the read-only guarantee — which the E5 instruction forbids and which would weaken the model C1 relies on. So E5 stops here.

**To unblock E5,** Q5 must be decided (approve the scoped, read-only, removal-tracked ACL grant and measure its cost on large trees; or choose a broker-mediated FS API and accept adapting servers). Until then, C1 (E1–E4) stands on its own: it needs no workspace access and no such grant.

No C2 code, profile, capability or ACL change was added. C1's broker, grants, limits and extension API are untouched, and E6 is not begun.

### 24.1 Recommended Q5 design — PROPOSED, not approved

The following is the **recommended** resolution of Q5 (from the §Q5 assessment), recorded so a reviewer can approve or reject a concrete design. It is **not** authorization: E5 stays **blocked**, no ACL is modified, and no C2 code or mechanism is built until a **separate, explicit** human approval to implement the ACL mechanism. The chosen direction is **Option A** (a scoped read-only ACL grant); Option B (broker-mediated FS) is rejected for C2 because it cannot run the concrete servers (ruff, Lua LS) unmodified.

**Design preferences (proposed):**

1. **Dedicated container SID per extension and security class.** The read grant is for that SID alone — **never** `ALL APPLICATION PACKAGES` (S-1-15-2-1), which would open the folder to every AppContainer app on the machine. One extension+class+workspace cannot read another's.
2. **Read-only.** A single ACE granting `FILE_GENERIC_READ` only — no write, execute, delete, `WRITE_DAC` or `WRITE_OWNER` — inheritable to the tree (`CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE`) on the canonical workspace root. Write/network/child-process denial stays the sandbox's, unchanged.
3. **Refuse the whole grant on unsafe reparse points.** Before granting, the workspace tree is scanned; if any symlink or junction points **outside** the canonical workspace root, the grant is **refused entirely** (not partially applied), because the container would otherwise read through it. (Reparse points resolving inside the root are allowed.)
4. **Explicit consent disclosure.** The C2 consent dialog states plainly that the server **can read every file in this folder, including secrets such as `.env` files, keys and `.git/config`**, and never says "safe" (§8.6). Consent is native (§8.1), identity-bound (§8.2), and separate from Workspace Trust and from ordinary extension permissions.
5. **Asynchronous grant/removal with progress; never block the UI.** Applying and removing the recursive ACE runs off the UI thread with progress; a server does not start until its grant has fully applied, and the window stays responsive throughout.
6. **Measured latency.** Grant and removal latency is measured on **10k, 100k and 500k-file** workspaces and must meet a stated budget (below); the mechanism is not approved until the numbers exist.
7. **Journaled ACL changes with crash recovery.** Every ACE add/remove is journaled (`recovery::{record_intent, Effect, DiskState}`), and startup recovery **verifies zero residual container-SID ACEs** on a tree whose grant was not cleanly removed (crash, kill, power loss), re-removing any it finds.

**Concrete acceptance criteria (all required before any implementation is approved):**

- **Containment (live, in the real sandbox).** A C2 probe proves, from inside the container: write to any workspace path **denied**; loopback and public network **denied**; child process **denied**; `OpenProcess` on Yavin **denied**; and that it **can** read an ordinary workspace file (so the grant actually works).
- **Reparse refusal (live).** A workspace containing a junction/symlink/`..`/ADS/8.3-name path pointing outside the root causes the grant to be **refused** (no ACE written); one pointing inside is allowed and read-through stays inside.
- **Write denial despite pre-existing ACEs.** If an ancestor carries an `ALL APPLICATION PACKAGES` write/modify ACE, the grant is refused or the design documents and blocks that case — write must be provably denied, not assumed.
- **Zero residue.** After grant → revoke (and after disable, uninstall, workspace switch, and normal shutdown), re-reading the tree's DACLs finds **no** container-SID ACE, including on a child with a protected (non-inheriting) DACL.
- **Crash recovery.** A simulated crash between grant and removal is reconciled to **zero** container-SID ACEs at next startup; the journal names what to undo.
- **Per-extension / per-workspace isolation.** Two extensions, or two workspaces, cannot read each other's trees; a workspace switch revokes the old grant before the new one applies.
- **UI non-blocking.** Grant/removal on a 100k-file tree never blocks the window; progress is shown; the server waits for a complete grant.

**Failure behavior (fail closed).** If the tree scan finds an outward reparse point, if the ACL cannot be fully applied, if isolation cannot be established, or if the platform is not Windows → **no grant, no server start**, a structured error (`SandboxUnavailable`/`PermissionDenied`), and no partial ACE left behind. Removal failure is journaled and retried at next startup; a server is never left running against a grant that could not be fully established.

**Test scenarios to add when implemented (not now):** the live containment probe above; reparse refusal (each of junction, symlink, `..`, ADS, device name, 8.3 short name); grant→revoke zero-residue (plain tree and a protected-DACL child); crash-between-grant-and-removal recovery; per-extension and per-workspace isolation; consent-denied and revocation-during-run (process tree ends before `revoke` returns, reusing the C1 observer); resource exhaustion and cleanup (reuse E3). Security mutations: dropping the reparse refusal, using `ALL APPLICATION PACKAGES`, granting write, skipping journal/recovery, and not scoping the SID — each caught by its scenario.

**Performance measurements to produce when implemented (not now):** grant and removal wall-clock at 10k / 100k / 500k files, on warm and cold caches, with the window's responsiveness recorded; a stated budget (proposed starting point, to be ratified: grant and removal each **asynchronous and never UI-blocking**, with 100k files applied in ≤ ~2 s of background work and 500k bounded and cancellable). The numbers, not the estimate, gate approval.

**Still requiring explicit human approval (not granted here):** whether to accept the recursive read-only ACL change to the user's files at all (Q5); the ratified latency budget; the exact reparse policy wording; multi-root/nested-repo scope; the secrets-disclosure dialog text; and the per-extension-vs-per-class SID choice (Q11). Until all are approved, **E5 remains blocked**.

### 24.2 Q5/Q11 decisions, feasibility proof, and the ACL primitive (done); E5 still BLOCKED

The Q5 feasibility gate was investigated and the **core ACL mechanism built and verified live** on disposable temp directories (`sandbox::{grant_read_tree, revoke_read_tree, container_aces}`, `crates/ide-workspace/tests/workspace_acl.rs`). The **full production foundation is not finished** and **E5 remains BLOCKED** on measured-budget and human-decision gates below.

**Decisions, classified:**

| #                               | Decision                                                                                                            | Classification                                                                                                                                                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 ACL model                     | Dedicated AppContainer SID per extension/class (derived by name, deterministic); never `ALL APPLICATION PACKAGES`   | **Resolved from architecture** (EXT-10 derives per-name SIDs; isolation proven live)                                                                                                                                                                                                 |
| 2 Access                        | One inheritable ACE, `FILE_GENERIC_READ` only (no write/append/delete/execute/WRITE_DAC/WRITE_OWNER)                | **Resolved + verified live**: an AppContainer process with only this ACE can read but cannot create, modify or delete (the OS denies it); `FILE_GENERIC_READ` is _not_ assumed — the resulting access was tested                                                                     |
| 3 Workspace scope               | One canonical root per grant; reject ambiguous multi-root/nested                                                    | **Proposed** (single-root is clear; multi-root isolation unresolved)                                                                                                                                                                                                                 |
| 4 Reparse/alternate paths       | Scan and **refuse the grant** when any symlink/junction/`..`/ADS/device/8.3 path reaches outside the canonical root | **Partly resolved** (outward junctions are detectable, proven live) **+ unresolved residual**: a one-time scan cannot stop a _later_ substitution by concurrent same-user code under the inherited ACE; that is a same-user residual (§4.2) whose acceptance is a **human decision** |
| 5 Secrets disclosure            | Consent states the server can read workspace files incl. `.env`, keys, `.git/config`; never "safe"                  | **Proposed** (wording needs approval; §8.1/§8.6)                                                                                                                                                                                                                                     |
| 6 Async / verified-before-start | Grant/removal off the UI thread with progress; server waits for a verified complete grant                           | **Unresolved — not implemented** (the primitive is synchronous today; async + verification + lifecycle states are remaining foundation work)                                                                                                                                         |
| 7 Latency budget                | Measured; distinguish UI responsiveness from total duration                                                         | **Measured, budget not ratified** (below)                                                                                                                                                                                                                                            |
| 8 Recovery                      | Journal before mutation; reconcile; verify zero residual ACEs; preserve unrelated                                   | **Partly**: zero-residue and unrelated-ACE preservation proven for revoke; **journaling + crash recovery not implemented**                                                                                                                                                           |
| 9 Cleanup lifecycle             | revoke, exit, disable/uninstall, workspace switch, shutdown, failed grant, interrupted cleanup                      | **Unresolved — not implemented** (only revoke exists)                                                                                                                                                                                                                                |
| 10 Isolation / Q11              | Per extension+class SID; one grant not shared                                                                       | **Resolved + verified live** for the SID mechanism; the extension-vs-class granularity choice (Q11) remains **proposed**                                                                                                                                                             |

**Security invariant → test → observed (live, this Windows):**

| Invariant                                        | Test                                                    | Observed                                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Read-only grant allows reads                     | `a_read_only_grant_allows_reads_and_denies_every_write` | read of a file and a nested file: **ok**                                                                                      |
| …and denies all writes                           | same                                                    | create / modify / delete from inside the AppContainer: **denied** by the OS                                                   |
| A broad pre-existing write ACE defeats read-only | `a_pre_existing_broad_write_ace_defeats_read_only`      | with `ALL APPLICATION PACKAGES:(M)` present, the sandbox **can write** → the foundation **must** detect and refuse such trees |
| Revocation leaves zero residue                   | `revocation_removes_the_grant_and_preserves_other_aces` | container ACEs after revoke: **0**; an unrelated ACE **survives**                                                             |
| Container isolation                              | `a_grant_to_one_container_is_not_shared_with_another`   | another container's ACEs here: **0**                                                                                          |
| Outward reparse detectable                       | `an_outward_junction_is_detectable`                     | a junction to outside the root: **detected**; a plain tree: clean                                                             |

**Latency (this machine, warm; recursive ACE propagation is O(tree)):** 1k files grant/revoke ≈ 33 / 27 ms; 10k ≈ 263 / 222 ms; 100k ≈ 2.58 / 2.27 s (500k extrapolates to ~12 s). **Conclusion:** at 100k+ files the operation takes seconds and **must** be asynchronous and cancellable — so "never blocks the UI" is only achievable with async execution, which is not yet built. A flat synchronous budget is not viable for large trees. Proposed budget to ratify: async always; a visible-progress threshold at ~10k files; large trees cancellable.

**Mutations (live-caught):** `EXT-33 ACL-01` (the read grant broadened to include write) → caught by the write-denied test; `EXT-33 ACL-02` (ACE ownership not checked by SID) → caught by the isolation test. Mutations for root validation, journaling, cleanup and reparse-refusal are deferred with the code they would guard (not yet built).

**What is implemented:** the native, renderer-inaccessible ACL primitive — grant a read-only inheritable ACE to a per-name container SID, revoke by removing exactly that SID's ACEs (preserving others), and count a SID's ACEs for verification — all proven live. **What is not, and blocks E5:** the safe grant wrapper that refuses outward-reparse and container-reachable-write trees and verifies effective read-only after applying; journal-before-mutation with crash recovery; asynchronous execution with progress and lifecycle states; the full cleanup lifecycle; and a ratified latency budget. Plus the human decisions in §24.1. **E5 stays BLOCKED**; no C2 profile, server, `runFilter` profile or E6 work was added, and E1–E4 are untouched.

### 24.3 Reparse threat model resolved; safe-grant foundation implemented

Two things changed since §24.2: the reparse threat was investigated to a conclusion, and the safe-grant foundation (minus async and wiring) was built and verified live.

**Reparse threat model — reads cannot escape the root (proven, favourable).** The feared session-time substitution residual does **not** grant out-of-workspace reads. Windows evaluates a read against the **target** object's DACL, and the granted container holds an ACE only on the workspace tree, never on any outside target; granting the inheritable ACE also does **not** propagate it through a junction to the target. So a junction or symlink under the root pointing outside — whether present at grant time or planted afterwards by concurrent same-user code — is **denied** when the container tries to read through it (test `reads_cannot_escape_the_root_through_a_junction`, both cases). Decision row 4 is therefore **resolved**: the one-time scan is kept as defence in depth (and to avoid granting onto unexpected objects), but it is not what prevents escape — the target DACL is.

**Residual to note (narrower, same-user):** a **hard link** created inside the workspace to a file outside it is a second directory entry to the _same_ object; granting the inheritable ACE during propagation can apply the read ACE to that shared object, which is then also reachable from outside. This is a same-user action (§4.2) and grants only read of a file the user hard-linked in; it is flagged for **explicit human note**, not silently accepted. Detecting it (files with link count > 1 whose other names are outside the root) is possible but not implemented.

**Implemented and verified (`crates/ide-workspace/src/workspace_acl.rs`, `sandbox::container_writable`, tests `tests/workspace_acl.rs`):**

- **`safe_grant`** = canonical single root → refuse outward reparse → **refuse if any existing ACE already grants the container (or ALL APPLICATION PACKAGES / ALL RESTRICTED APPLICATION PACKAGES) write** (`container_writable`; a read-only ACE cannot cancel a write ACE) → grant → **verify** the ACE is present and the folder is still not container-writable, else roll back. Fail-closed on every branch.
- **Journalled lifecycle:** the intent is written durably (`durable::write_json`) **before** the ACL is touched; `revoke` verifies zero residue before clearing; **`reconcile`** at startup removes the ACE of every journalled grant and verifies zero residue, keeping (and erroring on) anything it cannot clean; a **corrupt journal fails closed**.
- **Proven live:** read allowed / create-modify-delete denied; a pre-existing broad write ACE defeats read-only (so `safe_grant` refuses it); outward junction refused; **a crash that skips revoke is reconciled to zero ACEs on the next start**; a protected-DACL child accumulates no ACE and leaves no residue; unrelated ACEs preserved; two containers isolated.
- **Mutations** `EXT-33 ACL-01..05`, each caught live: access mask broadened to write; ACE ownership not checked by SID; broad-ACE refusal bypassed; reparse refusal bypassed; journaling skipped.

**Still required before E5 (deferred / human):** asynchronous execution with progress and lifecycle states (so "never blocks the UI" is true and verified — the 100k-file grant takes ~2.6 s synchronously, §24.2); the per-workspace SID derivation and wiring to consent and the extension host (Q11); investigation/decision on the hard-link residual; and the §24.1 human decisions (accept the ACL change at all; ratified latency budget; secrets wording). The foundation is native-only and reachable by nothing in production. **E5 remains BLOCKED**; E1–E4 untouched; E6 not begun.

### 24.4 Hard-link isolation resolved; async lifecycle implemented; 500k measured

**Hard links — investigated and resolved (not a silent residual).** Established live (`hard_links_present_at_grant_expose_the_object_but_later_ones_do_not`):

- A hard link under the root to an **outside** file, **present at grant time**, has the inherited read ACE propagated onto the shared object, so the sandbox can read it — unlike a junction. These trees are therefore **refused** at grant (`sandbox::external_hard_link_name` via `GetFileInformationByHandle` link count + `FindFirstFileNameW`; `workspace_acl::external_hard_link`; `safe_grant` → `ExternalHardLink`). Hard links are **same-volume only**, so `FindFirstFileNameW` enumerates _every_ name of an object — enumeration is complete, not best-effort.
- A hard link created **after** the grant to an outside file is **denied** by the OS: the object was never in the tree, so it carries no container ACE (same reason junction substitution is denied).

So hard-link exposure is eliminated by grant-time refusal plus the OS's own denial of post-grant links; it is **not** accepted as an open residual. (A narrower theoretical case — an attacker racing a hard link in during the grant scan — lands in the same post-grant-denied bucket, since the object is not re-ACL'd after the one propagation.) Decision row on hard links: **resolved by refusal**, with the same-volume completeness noted.

**Asynchronous lifecycle — implemented (`WorkspaceGrantManager`).** `begin_grant` returns immediately and runs `safe_grant` off-thread; the state goes `Pending` → `Granted` (and `is_ready` is true **only** in `Granted`, after verification) or `Failed(reason)`; `begin_revoke` → `Revoking` → removed, or `RecoveryRequired` if residue could not be cleared; `cancel` rolls back a grant that applied after cancellation (or flags recovery-required). All ACL mutations are serialized by one lock, so concurrent grant/revoke/workspace-switch cannot race the DACL. Windows' `SetNamedSecurityInfoW` is atomic with **no** sub-operation callback, so "progress" is the state transition, not a percentage — documented, not overstated. Verified live: grant→ready→revoke; a refused tree ends `Failed` and never readies; two workspaces granted concurrently both ready and stay isolated.

**Latency, measured (warm; this machine):** 10k ≈ 0.26 s, 100k ≈ 2.6 s, **500k grant ≈ 25.8 s / revoke ≈ 27.4 s**. Roughly linear with overhead; the 500k figure is actual, not extrapolated. **Conclusion:** grant/removal must be async and **cancellable** (the manager is async; cancellation is best-effort post-apply because the ACL call is uninterruptible); a flat time budget is infeasible for very large trees. **Proposed budget (for ratification):** async-always; the server never starts before `Granted`; a progress/"working" indication once the operation exceeds ~1 s; large trees cancellable (cancellation rolls back). Cold-cache runs were not separately measured.

**Decision status now:** Q5 — _proposed, conditional_ (every gate below met). Latency policy — _proposed, measured_. Q11 (per ext+class+workspace SID) — _proposed_; the manager keys per (root, container) and isolation is proven, but the per-workspace SID _derivation_ and token wiring are not built. Reparse — _resolved_. Broad-ACE/effective-write — _resolved_. Hard links — _resolved by refusal_. Secrets wording — _proposed_. **Requiring human approval:** accept the recursive read-only ACL change to real user files at all; ratify the latency policy; approve the secrets-disclosure wording; confirm Q11 SID granularity.

**Still required before E5:** the per-workspace SID _derivation_ and the wiring to consent and the extension host (none of which touches a real workspace yet), plus the human approvals above. The foundation remains native-only, reachable by nothing in production. **E5 remains BLOCKED; E1–E4 untouched; E6 not begun.**

### 24.5 Full lifecycle, stale-op safety, and server-start gating implemented

This increment finished the asynchronous lifecycle and added native server-start gating. No real workspace is touched and nothing is reachable from the renderer; all behaviour below is proven by live Windows tests in `crates/ide-workspace/tests/workspace_acl.rs` and guarded by compiling security mutations.

- **Explicit lifecycle states.** `GrantState` is now `Pending → Scanning → Applying → Verifying → Granted` on success, `Revoking → (removed)` on revoke, and `RollingBack → Cancelled` on cancellation, plus `Failed(reason)` and `RecoveryRequired(reason)`. `safe_grant_observed` drives the phase transitions synchronously and in a fixed order (test `safe_grant_observed_reports_phases_in_order`). `is_ready` is true only in `Granted`.
- **Stale-operation safety.** Every `begin_grant`/`begin_revoke` stamps the entry with a fresh monotonic sequence (`OP_SEQ`). A worker re-checks its captured sequence before publishing and, if a newer operation has taken the entry, **undoes its own grant instead of publishing it** — so a slow grant can never re-apply permissions behind a newer revoke. `begin_revoke` bumps the sequence and sets the cancel flag, superseding any in-flight grant. Proven by `a_newer_revoke_prevents_a_stale_grant_from_reapplying` (12 interleavings, each ending with zero container ACEs) and mutation **ACL-08**.
- **Quiescence for shutdown/switch.** An in-flight worker counter backs `quiescent()`, so a shutdown or workspace switch can wait until no worker can still mutate a DACL. Used to make the stale-op and cancellation tests deterministic.
- **Cancellation with rollback.** `cancel` rolls back a grant whether the cancel beats the worker (worker rolls back to `Cancelled`) or loses the race (an explicit revoke removes the applied grant). Either way the key ends with no applied permission (test `cancelling_a_grant_leaves_no_applied_permission`).
- **Server-start gating (`may_start`, native-authoritative).** A contained server may launch only when the grant is `Granted` with a stored grant whose workspace+identity match, the journal is readable and still records it, and a **fresh** effective re-verify shows ≥1 container ACE present and no effective write. Pending, failed, revoking, cancelled, recovery-required, absent, mismatched, or journal-unreadable all refuse. Nothing the renderer sends can substitute for this check. Proven by `may_start_gates_a_server_launch_on_a_verified_grant` and `may_start_refuses_a_failed_grant`, and mutations **ACL-07** (no-grant bypass) and **ACL-09** (non-`Granted` state accepted).
- **Latency, remeasured (warm; this machine, now under heavier load):** 10k ≈ grant 0.60 s / revoke 0.61 s; 100k ≈ grant 11.5 s / revoke 9.9 s. Higher than the §24.4 run (machine/disk load varies); the trend only reinforces that grant/removal **must** be async and cancellable. 500k not re-run this increment (the §24.4 actual of ~26 s stands as the large-tree figure).
- **Mutations:** ACL-01…ACL-09 all caught by their named tests (`node scripts/security-mutations.mjs --only "EXT-33 ACL"` → 9 of 9).

**Still deferred to before E5 (engineering):** the per-ext+class+workspace SID _derivation_ from native records and the wiring to native consent and the extension host — `may_start` is the gate they will call, but no consent flow or host dispatch is wired yet, and no C2 profile exists. **Still requiring human approval:** accept the recursive read-only ACL change on real user files at all; ratify the latency policy; approve the secrets-disclosure wording; confirm Q11 SID granularity. **E5 remains BLOCKED; E1–E4 untouched; E6 not begun.**

### 24.6 Native C2 launch core: identity, consent, gating and isolation — implemented test-only

This increment built the native core of the C2 contained-server launch path and proved it live. It is reachable only from tests; **production registers no C2 profiles and launches nothing**, and the human approvals below still gate any real enablement.

- **Derived container identity (`workspace_identity.rs`).** `derive(copy_id, class, workspace_root)` returns a deterministic AppContainer name `Yavin.<class>.v1.<32 hex>`, a length-prefixed domain-separated SHA-256 over `(version, class, copy, canonical-root)`. Inputs are native-sourced; a renderer string never selects a SID, name, path or ACL target. Canonicalization + case-folding map path aliases to one identity; distinct copy/class/workspace never collide; invalid input fails closed. The format is versioned (bumping `IDENTITY_VERSION` re-derives all identities). Proven by unit tests (determinism, aliases, copy/class/workspace separation, invalid input) and mutation **C2-11**.
- **SID agreement (`sandbox.rs`).** `container_sid_string(name)` and `process_container_sid(child)` expose the derived SID and the SID actually on a running server's token. The launch verifies **token SID == derived SID** (else it kills the server). The live happy-path test asserts token == derived **and** that the ACL manager granted that same SID read on the workspace — so the derivation, the token and the ACL are one identity.
- **C2 consent (`grants.rs`).** `Scope::C2` is grantable (always workspace-bound; a C2 grant without a workspace is refused). The C2 consent wording names the extension and workspace and states that the server can read any workspace file **including `.env`, credentials, private keys and `.git/config`**, and that allowing access does **not** mean the server is safe — it never claims safety/trust/verification. Deny-by-default, persisted, corrupt-store-fails-closed and revocation-ends-processes all come from the existing E2 authority unchanged.
- **Launch authority (`c2.rs`, `C2Authority`).** `launch` enforces, in order and unskippably: profile resolution (program is the profile's, never the request's) → identity derivation → **consent** (`authorize`, deny by default) → asynchronous workspace grant (`WorkspaceGrantManager::begin_grant`, waited to a verified `Granted`) → **`may_start`** fresh effective re-verify → program-bytes re-hash → sandboxed spawn in the derived container → **token-SID match** → registration for revocation (losing the race to a concurrent revoke ends the server). Any failure rolls back the ACL and kills the process. `revoke` ends the server, drops the grant, removes the workspace ACE and verifies zero residue.
- **Test-only profile, build-level exclusion.** `C2Authority::with_profiles` (the only way to register a profile) is gated behind the `c2-test-profiles` cargo feature, **off in every production build**, so no profile can be compiled into a shipped binary. `C2Authority::new` has an empty set; a packaged build answers every launch `UnknownProfile`. Proven by `production_registers_no_profiles_and_launches_nothing` and mutation **C2-15**.
- **Live isolation, observed from inside the container.** A consented, verified launch starts the server in its derived AppContainer; the workspace is readable (including `.env`) while **create, modify, delete, the network and child processes are all denied**. Revocation ends the process and leaves zero workspace ACEs; a relaunch needs fresh consent.
- **Mutations:** C2-10 (consent bypass), C2-11 (identity substitution), C2-12 (launch without a verified grant), C2-14 (revocation skips ACL cleanup), C2-15 (test profile in production) — all caught (`node scripts/security-mutations.mjs --only "EXT-33 C2"` → 5 of 5). `may_start`'s own bypass remains covered by ACL-07/ACL-09.

**Still deferred (production enablement, not built):** the `src-tauri` Tauri-command + extension-host IPC wrapper that extracts identity from the loaded `HostCopy` and the open workspace and calls `C2Authority` (pure plumbing mirroring E4's `process_capability.rs`; it adds no new enforcement, since every decision is already native here); and a reviewed, concrete production C2 profile. **Blocker for turning C2 on:** the human approvals in §24.1/§24.4 — accept the recursive read-only ACL change on real user files, ratify the latency policy, approve the C2 secrets-disclosure wording, confirm Q11 SID granularity. Until those are given, C2 stays disabled (no profiles) and reachable only from tests. **E5 is not complete** (its acceptance needs the production wiring + the human approvals); **E1–E4 untouched; E6 not begun.**

### 24.7 Tauri + application plumbing over the native C2 core — implemented, activation disabled

This increment connected the native C2 core (§24.6) to Yavin's application layer, keeping production C2 inert.

- **Application state + lifecycle (`src-tauri/src/lib.rs`).** A single `C2Authority` is managed in app state (grants at `c2-grants.json`, ACL journal at `c2-acl-journal.json`, in the config folder); **startup reconciliation** (`C2Authority::reconcile`) runs before any launch is possible; on exit the run loop calls `C2Authority::shutdown`, which revokes every live server (ending the process, removing its workspace ACE) and waits for the ACL workers to **quiesce** so none outlives the app. No duplicate authority: C1 (`ProcessCapability`) and C2 (`C2Authority`) are separate scopes with separate stores.
- **Renderer commands (`src-tauri/src/c2_capability.rs`, mirrors `process_capability.rs`).** `c2_request_consent`, `c2_revoke`, `c2_grants`. Identity is built **only** from the loaded `HostCopy` (`ExtensionService::host_copy`); the workspace is Yavin's **native** open-workspace root (no request path); the program/class come from the profile and the fixed C2 class. A request carries only a lookup key (extension id) and a profile id — never an executable, SID, container, workspace or approval. No open workspace, extension not loaded, or unknown profile → structured refusal. `c2_revoke` verifies the id is a C2 grant in the native authority before revoking (and surfaces an unverified-cleanup error, never a silent success). `c2_grants` returns a minimal view (`grantId, extensionId, workspace, profileId`) — no program path/hash, copy id, SID or container.
- **C2 is not an extension-callable API.** No `process.*`/`c2.*` method for starting or consenting to a server is served to extensions, so each resolves to `Need::Unknown` (denied); the E4 C1 filter (`process.runFilter`) is unchanged. Consent for a workspace-reading server is a decision in Yavin's own UI (native dialog), not something extension JS can trigger.
- **Tests:** `c2_capability` (7, identity-from-copy, workspace-required, unknown-profile, denied-dialog, minimal-view, revoke-unknown-refused, production-no-profiles), the permissions regression `c2_is_not_reachable_through_the_extension_api`, and the full §24.6 native C2 suite. **Mutations C2T-01…05** (HostCopy-identity bypass, native-workspace-required bypass, consent skip, revoke-ownership bypass, production-profile registration) — all caught; C2-10…15 and ACL-01…09 still caught. Full Rust workspace suite 52/52 binaries, 0 failures, E4 real-host filter test green; clippy `-D warnings` clean with and without `c2-test-profiles`; fmt clean.

**Still deferred (activation, not built):** the extension↔server communication/activation channel and any extension-callable launch path (intentionally not exposed — C2 must not reach ordinary extensions), and a reviewed production C2 profile. **Blocker for enabling C2:** the §24.1/§24.4 human approvals (recursive read-only ACL on real files; latency policy; C2 secrets wording; Q11 SID granularity). Until then production registers no profile and every command answers "no such contained server." **E5 is not complete** (acceptance needs the production profile + activation + human approvals); **E1–E4 untouched; E6 not begun.**

### 24.8 Extension-to-server request channel — implemented, production still inert

This increment added the narrow, native-authorized channel an extension uses to talk to a contained C2 server, and wired it through the extension host. It reuses the existing authority, grant store and sandbox; it adds no second permission system, no general IPC server, and no arbitrary execution. Production still registers no C2 profile, so every call answers `UnknownProfile`.

- **Transport (`c2.rs`).** The server is a sandboxed process the authority owns; the host holds its pipes (never an extension) and serializes one length-prefixed JSON frame in / one out per server (so responses cannot cross-deliver). Frames carry a **native**-assigned correlation id, a marker for resync, and are bounded: request input ≤ 64 KiB, response ≤ 1 MiB (refused by the length prefix before allocation), one request's deadline 10 s, ≤ 2 in flight per grant.
- **Per-request authorization (`C2Authority::request`).** Every request re-derives the identity, re-authorizes the grant (copy + program + profile + scope + workspace), lazily launches or reuses the server (reuse re-verifies `may_start`), checks bounds, round-trips, and — after the round trip — re-checks the grant before delivering, so a grant revoked mid-call yields no response. A timeout or a dead server ends the process and is a structured error; the extension never gets a raw handle or pipe. `op`/`input` are the extension's only say.
- **Host integration (`extension_host.rs`, `c2_capability.rs`, `extension_permissions.rs`, `bootstrap.js`).** `yavin.process.callServer(profile, op, input)` is dispatched natively like `process.runFilter`, needs the `process` capability (deny-by-default), and routes to the C2 authority with identity from the loaded `HostCopy` and the workspace from the native manager. It is distinct from the C1 filter path, and the separate C2 grant (per-workspace consent) is the real gate. The window never holds the server; a refusal tells the window only the method and capability. E4 C1 behavior is unchanged.
- **Lifecycle.** `revoke` ends the channel server, removes it (no reuse), cleans the workspace ACE and verifies zero residue; `shutdown` revokes every launched and channel server and waits for ACL quiescence.
- **Test-only profile, production exclusion unchanged.** The server profile exists only behind `c2-test-profiles` (off in production); `C2Authority::new` registers none. The real-host test uses an **empty** production authority, so `callServer` reaches it and answers `UnknownProfile` — proving the gate without a profile.
- **Tests:** live Windows channel tests (round-trip + workspace read, oversized request, oversized response, unknown op, crash, timeout, no-consent, unknown-profile, changed-copy/workspace, revocation-ends-and-refuses), a real-host integration test (`callServer` gated by the capability and reaching the C2 authority; the ungranted extension refused; C1 unchanged), `c2_capability` command tests, and the permissions regression. **Mutations C2S-01…06** (caller-identity bypass, C2-through-ordinary-API, request-bound removal, response-bound removal, revocation bypass — plus C2-10/C2-14/C2-15 for consent, ACL cleanup and production profile) all caught; ACL-01…09, C2-10…15, C2T-01…05 still caught (203 targets). Full Rust workspace suite 52/52 binaries, 0 failures; clippy `-D warnings` clean with and without the feature; fmt clean.

**Not independently mutation-tested (documented):** the post-round-trip "deliver-after-revocation" guard is defense-in-depth behind the server-kill + grant-removal on revoke (which C2S-06 and the channel revoke test prove); a deterministic mid-round-trip revoke could not be forced, so that guard is asserted by code review, not a mutation.

**Still deferred / human-gated:** a reviewed production C2 profile, and the §24.1/§24.4 human approvals (recursive read-only ACL on real files; latency policy; C2 secrets wording; Q11 SID granularity). Until then C2 is reachable by an extension in shape but inert (no profile → `UnknownProfile`). **E5 is not complete; E1–E4 untouched; E6 not begun.**

### 24.9 Governance and release-readiness package — gate BLOCKED

The E5 decisions, evidence, and release gate are tracked in companion documents so a reviewer has an auditable package (production C2 stays disabled throughout). [`C2_FINAL_GATE_REVIEW.md`](C2_FINAL_GATE_REVIEW.md) is the entry point — D1–D4 decision briefs, verified Ruff provenance, the release-build/latency evidence, and the exact gate status (**BLOCKED**). It draws on:

- [`C2_DECISION_LOG.md`](C2_DECISION_LOG.md) — the four required decisions (D1 recursive read-only ACL/Q5; D2 latency budget; D3 consent/disclosure wording; D4 SID granularity/Q11), each with role, recommendation, evidence, and status. **All four are `Proposed`/`Pending review`; none is approved.** Owners and dates are `TBD` (none assigned).
- [`C2_PRODUCTION_PROFILE_REVIEW.md`](C2_PRODUCTION_PROFILE_REVIEW.md) — a candidate profile specification (Ruff primary, Lua LS alternative). Registers nothing; provenance, signature, version, and hash are all `Unverified`/`TBD` (no binary verified).
- [`C2_RELEASE_READINESS.md`](C2_RELEASE_READINESS.md) — hard-link and cleanup/revocation evidence, the release-acceptance run (release-config registry assertion `tests/c2_production.rs`; release-config compile; 27 gate mutations incl. the re-anchored `E4-03`; 52 live tests), and the release-gate checklist + rollback/activation procedure.

**Gate result: BLOCKED** on G1 (D1–D4 unapproved) and G2 (no reviewed profile). Enforcement is complete and proven under test; the remaining gap is governance, not missing controls. The packaged `tauri build`/foreground-focus test was **not** run and is listed outstanding. E5 is not complete; E6 not begun.

## 16. What these phases did and did not do

- **The design step** changed no runtime code, permission, sandbox, consent or launch path.
- **E0** (§17) changed two things, neither a process capability:
  - `workspace.findFiles`, answered by Yavin's own search with `workspace.fs.read`;
  - Yavin's own lookup (`resolve_program`), which now searches only absolute `PATH` folders and on Windows tries only startable names.
- **E0.1** (§18) changed Yavin's own launches, none an extension capability:
  - Git in an untrusted folder only reads, with the repository's program-running configuration neutralised;
  - a project's own language server runs only once chosen, bound to its path and hash;
  - shims stay, with their invocation and residual risks documented.
- **E0.3** (§19) fixed the six defects the independent review (E0.2) found, each with a test and a caught mutation; still no extension capability:
  - submodule and embedded-repository recursion is ignored under hardening (V1);
  - the background index check runs under the same hardening, and no refused untrusted write leaves bookkeeping behind (V2);
  - a project's `tsserver.js` and a program selected inside the workspace (even through a link) need an explicit choice, and "installed" is refused when it would still run project code (V3, V5, V6);
  - checkers' trust-gated use of project tooling is documented (V4).
- **E1** (§20) added the native C1 broker (a stdin→stdout filter in the EXT-10 sandbox), private to the native side.
- **E2** (§21) added the native consent and grant authority that gates it: deny by default, grants bound to the extension copy, program identity, profile and scope, native-only consent, and revocation that ends running processes.
- **E3** (§22) audited and verified every C1 resource limit live through the broker (CPU hard cap, 512 MiB memory, one process, deadline, cancellation, stdin/stdout/stderr bounds, concurrency), fixed the stderr-bound gap it found, and proved cleanup on every termination path.
- **E4** (§23) exposed the C1 filter to extensions (`yavin.process.runFilter`), routed through the native capability gate, grant authority and broker, with identity from the loaded copy, native-only consent, and a per-extension concurrency cap of 2. Yavin registers no C1 profiles, so nothing runs in the shipped build; C2 servers (E5) and C3 execution (E6) are not begun, and there is no general process-execution API. Extensions' `child_process` stays unsupported.
- The §3 finding became §17.2's F-L1 and F-L2, and F-G1 is new. E0 reported all three; E0.1 addressed them (§18).
