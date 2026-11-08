//! Running a project's own test framework (Vitest/Jest) so the Test Explorer (WS5) can show
//! results, built on exactly the same security model as `checkers.rs` -- not a second
//! process-execution system.
//!
//! The renderer never names a program. It names an **adapter id** (`vitest` / `jest`) and passes
//! the argv its adapter built; the native side owns authorization end to end:
//!
//! 1. The folder must be trusted (`require_trust`) -- running tests runs the project's toolchain.
//! 2. The adapter id must be one of a fixed allow-list; the native side maps it to the program
//!    name and that program's fixed base flags.
//! 3. The provided argv is re-parsed against the adapter's grammar and **rebuilt natively**
//!    (`authorize_args`): only the fixed base flags, an optional `-t <name>` (the test's full
//!    name, opaque and carried as exactly one argv element -- never a shell string), and an
//!    optional file are allowed. Any other flag, extra argument or altered base is rejected.
//! 4. A file selector is run through `WorkspaceManager::validate_path`, so it must lie inside the
//!    workspace root (`..` traversal and symlink escapes are rejected).
//! 5. The program is resolved with `resolve_program(.., node_package = true, ..)` -- the project's
//!    own `node_modules/.bin` first, then absolute `PATH` -- so the renderer cannot choose an
//!    arbitrary executable even by naming one: a path it sends is never used.
//! 6. The run goes through the existing `capture_classified` (bounded output, deadline, cancel
//!    flag, process-tree kill), and a native run registry (`TestRuns`) owns cancellation.

use crate::trust::{require_trust, Trust};
use crate::{with_workspace, Workspace};
use ide_workspace::lsp_process::resolve_program;
use ide_workspace::process::{capture_classified, CaptureError};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tauri::{AppHandle, State};

/// How an adapter's renderer argv is authorized. Node runners (Vitest/Jest) share one grammar
/// (fixed base flags + an optional file / `-t <name>`); Cargo has its own (package + test-name
/// filter, rebuilt into the nightly libtest-JSON invocation).
#[derive(PartialEq, Eq)]
enum Grammar {
    Node,
    Cargo,
    Playwright,
    Pytest,
}

/// A supported test framework: its renderer-facing id, the program to resolve, the fixed base
/// flags a Node run starts with, whether the program lives in the project's `node_modules/.bin`,
/// and which argument grammar authorizes it.
struct Adapter {
    id: &'static str,
    program: &'static str,
    base: &'static [&'static str],
    node_package: bool,
    grammar: Grammar,
}

/// The allow-list. Adding a framework here (Playwright, pytest) is the only way to make one
/// runnable; there is no path by which the renderer can name a program of its own.
const ADAPTERS: &[Adapter] = &[
    Adapter {
        id: "vitest",
        program: "vitest",
        base: &["run", "--reporter=json"],
        node_package: true,
        grammar: Grammar::Node,
    },
    Adapter {
        id: "jest",
        program: "jest",
        base: &["--json", "--silent"],
        node_package: true,
        grammar: Grammar::Node,
    },
    Adapter {
        id: "cargo",
        program: "cargo",
        base: &[],
        node_package: false,
        grammar: Grammar::Cargo,
    },
    Adapter {
        id: "playwright",
        program: "playwright",
        base: &[],
        node_package: true,
        grammar: Grammar::Playwright,
    },
    Adapter {
        // The program is resolved specially (a trusted Python interpreter), not by this name.
        id: "pytest",
        program: "python",
        base: &[],
        node_package: false,
        grammar: Grammar::Pytest,
    },
];

fn find_adapter(id: &str) -> Option<&'static Adapter> {
    ADAPTERS.iter().find(|a| a.id == id)
}

/// How long a test run may take before it is killed. A whole suite can be minutes of legitimate
/// work; bounded so a watch-mode or hung runner cannot pin a slot forever.
const TEST_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// The most runs that may be in flight at once, across all workspaces. The Test Explorer starts
/// one run per workspace, so this is headroom, not a normal limit; it caps resource use if
/// something drives runs in a loop.
const MAX_CONCURRENT_RUNS: usize = 8;

/// What a run produced. A test suite that fails exits nonzero -- that is the result, not an error
/// -- so the exit `code` comes back and only `outcome` says whether the run itself ran, was
/// stopped, or outlived its deadline. `root` is the folder it ran in, for resolving relative
/// paths the report prints.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TestRunOutput {
    pub outcome: TestOutcome,
    pub output: String,
    pub code: i32,
    pub root: String,
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TestOutcome {
    Completed,
    Cancelled,
    TimedOut,
}

/// One in-flight run, owned by the workspace that started it.
struct ActiveRun {
    id: u64,
    cancel: Arc<AtomicBool>,
    /// The workspace root that started this run -- the ownership check for cancellation.
    root: PathBuf,
}

/// The registry of in-flight runs. Cancellation is by workspace ownership: a `cancel_test` from a
/// workspace signals only the runs that workspace started, and a run deregisters itself by its own
/// id on completion, so a superseded run finishing never removes a newer run's registration.
#[derive(Default)]
pub struct TestRuns {
    inner: Mutex<Vec<ActiveRun>>,
    next_id: AtomicU64,
}

/// What `TestRuns::register` returns: whether the run was admitted (within the concurrency bound),
/// its native id, and its cancel flag.
struct Admission {
    id: u64,
    cancel: Arc<AtomicBool>,
    admitted: bool,
}

impl TestRuns {
    /// Recover a poisoned lock rather than brick the whole subsystem: a panic in one run's
    /// bookkeeping must not stop every later run from being started or cancelled.
    fn guard(&self) -> std::sync::MutexGuard<'_, Vec<ActiveRun>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Admit a run for `root`, unless the concurrency bound is already reached. A new run first
    /// cancels any run the same workspace already has going (one Test Explorer, one run per
    /// workspace: a second start supersedes the first, as the checkers do).
    fn register(&self, root: &Path) -> Admission {
        let mut runs = self.guard();
        for run in runs.iter().filter(|r| r.root == root) {
            run.cancel.store(true, Ordering::Relaxed);
        }
        if runs.len() >= MAX_CONCURRENT_RUNS {
            return Admission {
                id: 0,
                cancel: Arc::new(AtomicBool::new(false)),
                admitted: false,
            };
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let cancel = Arc::new(AtomicBool::new(false));
        runs.push(ActiveRun {
            id,
            cancel: cancel.clone(),
            root: root.to_path_buf(),
        });
        Admission {
            id,
            cancel,
            admitted: true,
        }
    }

    /// Remove a run by its id. Keyed on the id, never the root, so a stale run finishing removes
    /// only itself and never a newer run that has since taken the same workspace's slot.
    fn deregister(&self, id: u64) {
        self.guard().retain(|run| run.id != id);
    }

    /// Signal every in-flight run that `root` started. Idempotent (setting an already-set flag is
    /// harmless) and ownership-scoped (runs of other workspaces are untouched). Returns how many
    /// were signalled, for tests and logging.
    fn cancel_for_root(&self, root: &Path) -> usize {
        let runs = self.guard();
        let mut signalled = 0;
        for run in runs.iter().filter(|r| r.root == root) {
            run.cancel.store(true, Ordering::Relaxed);
            signalled += 1;
        }
        signalled
    }

    /// Signal every in-flight run, whatever its workspace -- for application shutdown.
    pub fn cancel_all(&self) {
        for run in self.guard().iter() {
            run.cancel.store(true, Ordering::Relaxed);
        }
    }
}

/// Cancel every run started by the given workspace root. A free function so the shutdown hook and
/// the command share one path, mirroring `checkers::cancel_running`.
pub fn cancel_all_runs(runs: &TestRuns) {
    runs.cancel_all();
}

/// Re-parse a renderer-provided argv against an adapter's grammar and rebuild it natively, so the
/// executed command is constructed here, not trusted from the wire. Accepts exactly:
///   `base`                         -> run everything
///   `base <file>`                  -> one file
///   `base -t <fullName> <file>`    -> one test case by full name
/// and rejects anything else: an altered base, an unknown flag, extra arguments. `validate`
/// enforces workspace containment for a file path (and returns its validated form). The test name
/// is opaque -- it is copied through as a single argv element and never inspected or split, so a
/// name full of shell metacharacters is still just one argument.
fn authorize_args(
    base: &[&str],
    args: &[String],
    validate: impl Fn(&str) -> Result<String, String>,
) -> Result<Vec<String>, String> {
    if args.len() < base.len() || args.iter().zip(base).any(|(got, want)| got != want) {
        return Err(format!(
            "Invalid test arguments: a run must begin with {base:?}."
        ));
    }
    let rest = &args[base.len()..];
    let mut argv: Vec<String> = base.iter().map(|flag| flag.to_string()).collect();
    match rest {
        [] => {}
        [file] => argv.push(validate(file)?),
        [flag, name, file] if flag == "-t" => {
            argv.push("-t".to_string());
            argv.push(name.clone());
            argv.push(validate(file)?);
        }
        _ => {
            return Err(
                "Invalid test arguments: only a file, or `-t <name> <file>`, may follow the \
                 base flags."
                    .to_string(),
            )
        }
    }
    Ok(argv)
}

/// A Cargo package (and target) name: letters, digits, `_` and `-`, starting with a letter,
/// digit or `_`. This is exactly what Cargo itself permits, and it rejects path traversal
/// (`..`, `/`, `\`), shell metacharacters and whitespace outright.
fn is_cargo_ident(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphanumeric() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Authorize a Cargo run and build the real `cargo` argv natively. The renderer sends only a
/// **minimal selector encoding** (never a cargo command line):
///   `[]`                     -> the whole workspace
///   `[-p <pkg>]`             -> one package (validated against the identifier grammar)
///   `[--filter <substr>]`    -> tests whose name contains `<substr>`
///   `[--exact <full name>]`  -> exactly one test by its `module::name` path
/// A `-p` package may precede a filter. Everything else is rejected. The filter/test name is
/// **opaque** -- one argv element, never inspected or split -- and no file path is ever accepted,
/// so Cargo has no path-traversal surface. The rebuilt command is the nightly libtest-JSON run:
/// `cargo test (--workspace|-p <pkg>) --no-fail-fast --message-format json [<filter>] -- \
///  -Z unstable-options --format json --report-time [--exact]`.
fn authorize_cargo(args: &[String]) -> Result<Vec<String>, String> {
    let mut rest = args;
    let mut package: Option<&str> = None;
    if let [flag, pkg, tail @ ..] = rest {
        if flag == "-p" {
            if !is_cargo_ident(pkg) {
                return Err(format!("Invalid Cargo package name: {pkg:?}."));
            }
            package = Some(pkg);
            rest = tail;
        }
    }

    let mut filter: Option<&str> = None;
    let mut exact = false;
    match rest {
        [] => {}
        [flag, value] if flag == "--filter" => filter = Some(value),
        [flag, value] if flag == "--exact" => {
            filter = Some(value);
            exact = true;
        }
        _ => {
            return Err(
                "Invalid Cargo test arguments: only an optional `-p <pkg>` and an optional \
                 `--filter <name>` or `--exact <name>` are allowed."
                    .to_string(),
            )
        }
    }

    let mut argv: Vec<String> = vec!["test".to_string()];
    match package {
        Some(pkg) => {
            argv.push("-p".to_string());
            argv.push(pkg.to_string());
        }
        None => argv.push("--workspace".to_string()),
    }
    argv.push("--no-fail-fast".to_string());
    argv.push("--message-format".to_string());
    argv.push("json".to_string());
    if let Some(value) = filter {
        argv.push(value.to_string()); // the test-name filter: one opaque argv element
    }
    // Everything after `--` is handed to the test binary (libtest). The JSON formatter and
    // per-test timing are nightly-only (`-Z unstable-options`); on a stable toolchain Cargo
    // rejects the flag, which surfaces as a clear run error rather than wrong results.
    argv.extend(
        [
            "--",
            "-Z",
            "unstable-options",
            "--format",
            "json",
            "--report-time",
        ]
        .iter()
        .map(|s| s.to_string()),
    );
    if exact {
        argv.push("--exact".to_string());
    }
    Ok(argv)
}

// --- Cargo test-executable resolution (WS6 Part 3, for Rust debugging) ---------------------------

/// One compiled Cargo **test** binary, from `cargo test --no-run --message-format=json`.
#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CargoTestBinary {
    pub package: String,
    pub target: String,
    pub kind: String,
    pub executable: String,
}

/// The result of resolving a workspace's test executables: the binaries, or the compiler
/// diagnostics when the build failed (kept **distinct** from test failures — a build break is
/// never a failing test, and no debugger is started).
#[derive(Serialize, Debug)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum CargoTestExecutables {
    Compiled { binaries: Vec<CargoTestBinary> },
    CompileFailed { diagnostics: Vec<String> },
}

/// The package name from a Cargo `package_id` — either new-style
/// `path+file:///…#name@version` / `…#name` or old-style `name version (source)`.
fn package_name(package_id: &str) -> String {
    if let Some(hash) = package_id.rfind('#') {
        let (before, after) = (&package_id[..hash], &package_id[hash + 1..]);
        let name = after.split('@').next().unwrap_or(after);
        // `#name@version` or `#name`: the name is after `#`.
        if !name.is_empty() && !name.chars().next().unwrap().is_ascii_digit() {
            return name.to_string();
        }
        // `#version` alone: the name is the last path segment before `#`.
        if let Some(segment) = before.rsplit(['/', '\\']).next() {
            if !segment.is_empty() {
                return segment.to_string();
            }
        }
    }
    package_id
        .split_whitespace()
        .next()
        .unwrap_or(package_id)
        .to_string()
}

/// Parse `cargo test --no-run --message-format=json` output into the compiled **test** binaries,
/// or the compiler diagnostics when the build failed. A test binary is a `compiler-artifact` with
/// `profile.test == true` and a non-null `executable`; ordinary binaries (no test profile) are
/// skipped. Non-JSON noise, blank lines and a truncated final line are tolerated.
fn parse_cargo_test_artifacts(output: &str) -> CargoTestExecutables {
    let mut binaries: Vec<CargoTestBinary> = Vec::new();
    let mut diagnostics: Vec<String> = Vec::new();
    let mut build_failed = false;

    for raw in output.lines() {
        let line = raw.trim();
        if !line.starts_with('{') {
            continue;
        }
        let value: serde_json::Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(_) => continue,
        };
        match value["reason"].as_str() {
            Some("compiler-artifact") => {
                let is_test = value["profile"]["test"].as_bool().unwrap_or(false);
                if let (true, Some(executable)) = (is_test, value["executable"].as_str()) {
                    let binary = CargoTestBinary {
                        package: package_name(value["package_id"].as_str().unwrap_or("")),
                        target: value["target"]["name"].as_str().unwrap_or("").to_string(),
                        kind: value["target"]["kind"][0]
                            .as_str()
                            .unwrap_or("")
                            .to_string(),
                        executable: executable.to_string(),
                    };
                    // Duplicate artifact messages (a fresh rebuild re-reports) collapse to one.
                    if !binaries.contains(&binary) {
                        binaries.push(binary);
                    }
                }
            }
            Some("compiler-message") => {
                if value["message"]["level"].as_str() == Some("error") {
                    build_failed = true;
                    if let Some(rendered) = value["message"]["rendered"].as_str() {
                        diagnostics.push(rendered.to_string());
                    }
                }
            }
            Some("build-finished") if value["success"].as_bool() == Some(false) => {
                build_failed = true;
            }
            _ => {}
        }
    }

    if build_failed {
        CargoTestExecutables::CompileFailed { diagnostics }
    } else {
        CargoTestExecutables::Compiled { binaries }
    }
}

/// How long `cargo test --no-run` may take (a cold compile of a large workspace is minutes).
const CARGO_BUILD_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Resolve a workspace's compiled Cargo test executables natively (WS6 Part 3), for debugging a
/// Rust test through lldb-dap. Runs `cargo test --no-run --message-format=json` (optionally for one
/// validated package), parses the build metadata, and **confines every executable to the workspace**
/// — a path is never guessed, never taken from the renderer, and never outside the workspace. A
/// build failure returns structured diagnostics and no executable, so the caller does not start a
/// debugger.
#[tauri::command]
pub async fn cargo_test_executable(
    app: AppHandle,
    state: State<'_, Workspace>,
    trust: State<'_, Trust>,
    package: Option<String>,
) -> Result<CargoTestExecutables, String> {
    require_trust(&app, &state, &trust)?;
    if let Some(pkg) = &package {
        if !is_cargo_ident(pkg) {
            return Err(format!("Invalid Cargo package name: {pkg:?}."));
        }
    }
    let root = with_workspace(&state, |manager| Ok(manager.root().to_path_buf()))?;
    let program = resolve_program("cargo", false, &root, std::env::var_os("PATH"))
        .ok_or_else(|| "No cargo found on PATH. Install the Rust toolchain.".to_string())?;

    let mut argv: Vec<String> = ["test", "--no-run", "--message-format", "json"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    if let Some(pkg) = &package {
        argv.push("-p".to_string());
        argv.push(pkg.clone());
    }

    let run_root = root.clone();
    let output = tauri::async_runtime::spawn_blocking(move || {
        let mut command = Command::new(program);
        command.current_dir(&run_root).args(&argv);
        capture_classified(
            command,
            None,
            Arc::new(AtomicBool::new(false)),
            CARGO_BUILD_TIMEOUT,
        )
    })
    .await
    .map_err(|e| e.to_string())?;

    let output = match output {
        Ok(out) => out,
        Err(CaptureError::TimedOut) => return Err("The cargo build timed out.".to_string()),
        Err(CaptureError::Cancelled) => return Err("The cargo build was cancelled.".to_string()),
        Err(CaptureError::Failed(error)) => return Err(format!("Could not run cargo: {error}")),
    };

    // Cargo writes the JSON artifacts to stdout; compiler messages may be on either stream.
    let parsed = parse_cargo_test_artifacts(&format!("{}\n{}", output.stdout, output.stderr));
    if let CargoTestExecutables::Compiled { binaries } = &parsed {
        // Every executable must lie inside the workspace (its `target/`); a path that does not is
        // not handed back.
        for binary in binaries {
            with_workspace(&state, |manager| manager.validate_path(&binary.executable)).map_err(
                |_| {
                    format!(
                        "A compiled test executable is outside the workspace: {}",
                        binary.executable
                    )
                },
            )?;
        }
    }
    Ok(parsed)
}

/// A Playwright project/browser name: one line, bounded, with no control characters. Unlike a
/// Cargo package it may contain spaces ("Mobile Chrome"), and it is never a path or a flag — it
/// travels as a single opaque `--project` argument, so there is no injection surface.
fn is_playwright_project(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && !name.chars().any(|c| c.is_control())
        && !name.starts_with('-')
}

/// Authorize a Playwright run and build the real `playwright` argv natively. The renderer sends a
/// **minimal selector encoding**, in this fixed order, each part optional:
///   `[--file <file>]`      -> run one spec file (containment-validated)
///   `[-g <title>]`         -> grep tests by title (opaque, never a shell string)
///   `[--project <name>]`   -> one browser/project (validated, but may contain spaces)
/// Anything else is rejected. The rebuilt command is `playwright test --reporter=json [<file>]
/// [-g <title>] [--project <name>]`. No arbitrary flags, env, config paths or executables.
fn authorize_playwright(
    args: &[String],
    validate: impl Fn(&str) -> Result<String, String>,
) -> Result<Vec<String>, String> {
    let mut rest = args;
    let mut file: Option<String> = None;
    if let [flag, value, tail @ ..] = rest {
        if flag == "--file" {
            file = Some(validate(value)?);
            rest = tail;
        }
    }
    let mut grep: Option<&str> = None;
    if let [flag, value, tail @ ..] = rest {
        if flag == "-g" {
            grep = Some(value);
            rest = tail;
        }
    }
    let mut project: Option<&str> = None;
    if let [flag, value, tail @ ..] = rest {
        if flag == "--project" {
            if !is_playwright_project(value) {
                return Err(format!("Invalid Playwright project name: {value:?}."));
            }
            project = Some(value);
            rest = tail;
        }
    }
    if !rest.is_empty() {
        return Err(
            "Invalid Playwright test arguments: only an optional `--file <file>`, `-g <title>` \
             and `--project <name>` (in that order) are allowed."
                .to_string(),
        );
    }

    let mut argv: Vec<String> = vec!["test".to_string(), "--reporter=json".to_string()];
    if let Some(file) = file {
        argv.push(file); // the containment-validated spec file (a positional filter)
    }
    if let Some(grep) = grep {
        argv.push("-g".to_string());
        argv.push(grep.to_string()); // the test title: one opaque argv element
    }
    if let Some(project) = project {
        argv.push("--project".to_string());
        argv.push(project.to_string());
    }
    Ok(argv)
}

/// Authorize a pytest run, returning the **selector tokens** (none, a file, or a node id) that
/// follow the fixed `python -m pytest --json-report …` base `run_test` assembles. The renderer
/// sends one of:
///   `[]`                 -> the whole suite
///   `["--file", <file>]` -> one file (containment-validated)
///   `["--node", <id>]`   -> one test by its node id `path::Class::test[param]`
/// A node id's path (before the first `::`) is containment-validated; the rest (classes, the test
/// name, any `[param]`) is **opaque** but must have no control characters. Nothing else is allowed.
fn authorize_pytest(
    args: &[String],
    validate: impl Fn(&str) -> Result<String, String>,
) -> Result<Vec<String>, String> {
    match args {
        [] => Ok(Vec::new()),
        [flag, file] if flag == "--file" => Ok(vec![validate(file)?]),
        [flag, node] if flag == "--node" => {
            if node.chars().any(|c| c.is_control()) {
                return Err("Invalid pytest node id: it contains control characters.".to_string());
            }
            let (path, rest) = node
                .split_once("::")
                .ok_or_else(|| "Invalid pytest node id: expected `path::test`.".to_string())?;
            // Validate the file part for containment; the rest stays as one opaque token.
            Ok(vec![format!("{}::{}", validate(path)?, rest)])
        }
        _ => Err(
            "Invalid pytest test arguments: only `--file <file>` or `--node <id>` are allowed."
                .to_string(),
        ),
    }
}

/// Where Python is, by trusted environment discovery: a workspace-local virtual environment
/// first (`.venv` / `venv`), then `python` / `python3` / the Windows `py` launcher on `PATH`. The
/// renderer never names it.
fn resolve_python(root: &Path) -> Option<PathBuf> {
    let venv_bin = if cfg!(windows) { "Scripts" } else { "bin" };
    let venv_exe = if cfg!(windows) {
        "python.exe"
    } else {
        "python"
    };
    for venv in [".venv", "venv"] {
        let candidate = root.join(venv).join(venv_bin).join(venv_exe);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    let path = std::env::var_os("PATH");
    for name in ["python", "python3", "py"] {
        if let Some(found) = resolve_program(name, false, root, path.clone()) {
            return Some(found);
        }
    }
    None
}

/// A unique temporary path for pytest's JSON report, in the OS temp dir (never the workspace).
fn pytest_report_path() -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("yavin-pytest-{}-{}.json", std::process::id(), n))
}

/// Run a resolved program with an authorized argv in `root`, honouring the cancel flag and the
/// deadline. The JSON report is on stdout for most runners (stdout returned when non-empty, else
/// stderr so a failed run still surfaces its reason); pytest instead writes it to `result_file`.
fn execute(
    program: &Path,
    root: &Path,
    argv: &[String],
    cancel: Arc<AtomicBool>,
    timeout: Duration,
    adapter_id: &str,
    result_file: Option<&Path>,
) -> Result<TestRunOutput, String> {
    let mut command = Command::new(program);
    command.current_dir(root).args(argv);
    let root_str = root.to_string_lossy().into_owned();
    let answer = capture_classified(command, None, cancel, timeout);
    // pytest writes its JSON to a file (the json-report plugin), not stdout: read it back as the
    // run's output when present. A clean-up removes it whatever the outcome. When it is absent
    // (the plugin is missing, the run was cancelled), the process's own stdout/stderr is used, so
    // the reason — e.g. "unrecognized arguments: --json-report" — still reaches the parser.
    let from_file = result_file.and_then(|path| {
        let contents = std::fs::read_to_string(path).ok();
        let _ = std::fs::remove_file(path);
        contents.filter(|text| !text.trim().is_empty())
    });
    match answer {
        Ok(out) => {
            let output = from_file.unwrap_or_else(|| {
                if out.stdout.trim().is_empty() {
                    out.stderr
                } else {
                    out.stdout
                }
            });
            Ok(TestRunOutput {
                outcome: TestOutcome::Completed,
                output,
                code: out.code,
                root: root_str,
            })
        }
        Err(CaptureError::Cancelled) => Ok(TestRunOutput {
            outcome: TestOutcome::Cancelled,
            output: String::new(),
            code: -1,
            root: root_str,
        }),
        Err(CaptureError::TimedOut) => Ok(TestRunOutput {
            outcome: TestOutcome::TimedOut,
            output: String::new(),
            code: -1,
            root: root_str,
        }),
        Err(CaptureError::Failed(error)) => Err(format!("Could not run {adapter_id}: {error}")),
    }
}

/// Run a project's tests. See the module comment for the authorization steps; the short version is
/// that the renderer may influence only *which* allow-listed adapter runs and *which* contained
/// test/file it targets, never *what program* runs or with what flags.
#[tauri::command]
pub async fn run_test(
    app: AppHandle,
    state: State<'_, Workspace>,
    trust: State<'_, Trust>,
    runs: State<'_, TestRuns>,
    adapter: String,
    args: Vec<String>,
) -> Result<TestRunOutput, String> {
    require_trust(&app, &state, &trust)?;
    let adapter_def =
        find_adapter(&adapter).ok_or_else(|| format!("No test adapter named {adapter}."))?;

    // Resolve the workspace root and authorize+rebuild the argv in one borrow of the manager. Node
    // runners validate a file selector for containment against the very root the run will use;
    // Cargo's grammar takes no path, so it needs no containment step.
    let (root, argv, result_file) = with_workspace(&state, |manager| {
        let root = manager.root().to_path_buf();
        let validate = |file: &str| {
            manager
                .validate_path(file)
                .map(|path| path.to_string_lossy().into_owned())
        };
        let (argv, result_file): (Vec<String>, Option<PathBuf>) = match adapter_def.grammar {
            Grammar::Node => (authorize_args(adapter_def.base, &args, validate)?, None),
            Grammar::Cargo => (authorize_cargo(&args)?, None),
            Grammar::Playwright => (authorize_playwright(&args, validate)?, None),
            Grammar::Pytest => {
                // Fixed JSON-report base; the plugin writes to a native temp file we read back.
                let report = pytest_report_path();
                let mut argv: Vec<String> = ["-m", "pytest", "--json-report", "--json-report-file"]
                    .iter()
                    .map(|s| s.to_string())
                    .collect();
                argv.push(report.to_string_lossy().into_owned());
                argv.push("-p".to_string());
                argv.push("no:cacheprovider".to_string());
                argv.extend(authorize_pytest(&args, validate)?);
                (argv, Some(report))
            }
        };
        Ok((root, argv, result_file))
    })?;

    // The renderer cannot supply a program path: the program is resolved here. Node runners prefer
    // the project's own `node_modules/.bin`; Cargo/Playwright resolve their CLI; pytest resolves a
    // trusted Python interpreter (a workspace venv first, then PATH).
    let program = match adapter_def.grammar {
        Grammar::Pytest => resolve_python(&root).ok_or_else(|| {
            "No Python interpreter found for this workspace. Install Python (and pytest with the \
             pytest-json-report plugin), or create a .venv, and try again."
                .to_string()
        })?,
        _ => resolve_program(
            adapter_def.program,
            adapter_def.node_package,
            &root,
            std::env::var_os("PATH"),
        )
        .ok_or_else(|| {
            format!(
                "No {} runner found for this workspace. Make sure it is installed and on PATH.",
                adapter_def.program
            )
        })?,
    };

    // Register (bounds concurrency; supersedes any run this workspace already has going).
    let admission = runs.register(&root);
    if !admission.admitted {
        return Err(
            "Too many test runs are already in progress. Try again in a moment.".to_string(),
        );
    }
    let id = admission.id;
    let cancel = admission.cancel;

    let adapter_id = adapter.clone();
    let run_root = root.clone();
    let finished = tauri::async_runtime::spawn_blocking(move || {
        execute(
            &program,
            &run_root,
            &argv,
            cancel,
            TEST_TIMEOUT,
            &adapter_id,
            result_file.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string());

    // Deregister this run by its own id, whatever the outcome, so it can no longer be cancelled;
    // a newer run that superseded it keeps its own registration.
    runs.deregister(id);
    finished?
}

/// Stop the calling workspace's test run(s). Idempotent, ownership-scoped, and harmless when none
/// is running or no workspace is open; the actual process-tree kill happens inside the run's
/// `capture_classified`, which observes the flag this sets.
#[tauri::command(async)]
pub fn cancel_test(state: State<'_, Workspace>, runs: State<'_, TestRuns>) -> Result<(), String> {
    if let Ok(root) = with_workspace(&state, |manager| Ok(manager.root().to_path_buf())) {
        runs.cancel_for_root(&root);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- allow-list -------------------------------------------------------------------------

    #[test]
    fn only_a_named_adapter_resolves_and_there_is_no_way_to_name_a_program() {
        assert_eq!(find_adapter("vitest").map(|a| a.program), Some("vitest"));
        assert_eq!(find_adapter("jest").map(|a| a.program), Some("jest"));
        assert_eq!(find_adapter("cargo").map(|a| a.program), Some("cargo"));
        assert_eq!(
            find_adapter("playwright").map(|a| a.program),
            Some("playwright")
        );
        assert!(find_adapter("pytest").is_some());
        assert!(find_adapter("").is_none());
        assert!(find_adapter("bash").is_none());
        assert!(find_adapter("vitest; rm -rf /").is_none());
        assert!(find_adapter("../../../bin/sh").is_none());
    }

    #[test]
    fn every_adapter_id_matches_a_builtin_adapter_on_the_typescript_side() {
        // The id is the contract: Rust runs it, the TypeScript adapter built the argv and parses
        // the output. If an id here is not a BUILTIN adapter there, a run could never be requested.
        let adapters_ts = include_str!("../../src/services/testing/adapters.ts");
        for adapter in ADAPTERS {
            assert!(
                adapters_ts.contains(&format!("id: \"{}\"", adapter.id)),
                "no TypeScript adapter with id {}",
                adapter.id
            );
        }
    }

    // --- argument authorization ------------------------------------------------------------

    /// A validator that accepts any path and marks it, so tests can see the file went through
    /// containment without needing a real workspace on disk.
    fn ok_validate(file: &str) -> Result<String, String> {
        Ok(format!("<validated>{file}"))
    }

    const VITEST_BASE: &[&str] = &["run", "--reporter=json"];

    fn args(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn authorize_accepts_run_all_file_and_case_and_rebuilds_the_argv() {
        assert_eq!(
            authorize_args(VITEST_BASE, &args(&["run", "--reporter=json"]), ok_validate).unwrap(),
            args(&["run", "--reporter=json"])
        );
        assert_eq!(
            authorize_args(
                VITEST_BASE,
                &args(&["run", "--reporter=json", "/w/a.test.ts"]),
                ok_validate
            )
            .unwrap(),
            args(&["run", "--reporter=json", "<validated>/w/a.test.ts"])
        );
        assert_eq!(
            authorize_args(
                VITEST_BASE,
                &args(&["run", "--reporter=json", "-t", "math adds", "/w/a.test.ts"]),
                ok_validate
            )
            .unwrap(),
            args(&[
                "run",
                "--reporter=json",
                "-t",
                "math adds",
                "<validated>/w/a.test.ts"
            ])
        );
    }

    #[test]
    fn authorize_rejects_an_altered_base_an_unknown_flag_and_extra_arguments() {
        // Base must be exactly the adapter's fixed flags.
        assert!(
            authorize_args(VITEST_BASE, &args(&["run", "--reporter=tap"]), ok_validate).is_err()
        );
        assert!(authorize_args(VITEST_BASE, &args(&["--reporter=json"]), ok_validate).is_err());
        // An injected flag after the base is not a file or a `-t` selector.
        assert!(authorize_args(
            VITEST_BASE,
            &args(&["run", "--reporter=json", "--config", "/etc/evil"]),
            ok_validate
        )
        .is_err());
        // Too many trailing arguments.
        assert!(authorize_args(
            VITEST_BASE,
            &args(&["run", "--reporter=json", "-t", "n", "f", "extra"]),
            ok_validate
        )
        .is_err());
        // A `-t`-shaped selector whose flag is not `-t`.
        assert!(authorize_args(
            VITEST_BASE,
            &args(&["run", "--reporter=json", "-x", "n", "f"]),
            ok_validate
        )
        .is_err());
    }

    #[test]
    fn a_file_selector_is_sent_through_containment_validation() {
        // The validator here rejects anything outside a fake root; an escaping path is refused.
        let validate = |file: &str| -> Result<String, String> {
            if file.contains("..") || file.starts_with("/etc") {
                Err("Security rejection: outside root".to_string())
            } else {
                Ok(file.to_string())
            }
        };
        assert!(authorize_args(
            VITEST_BASE,
            &args(&["run", "--reporter=json", "../../../etc/passwd"]),
            validate
        )
        .is_err());
        assert!(authorize_args(
            VITEST_BASE,
            &args(&["run", "--reporter=json", "/etc/passwd"]),
            validate
        )
        .is_err());
        assert!(authorize_args(
            VITEST_BASE,
            &args(&["run", "--reporter=json", "src/a.test.ts"]),
            validate
        )
        .is_ok());
    }

    #[test]
    fn a_test_name_with_shell_metacharacters_stays_exactly_one_argv_element() {
        let evil = r#"evil"; rm -rf / #`$(whoami)"#;
        let argv = authorize_args(
            VITEST_BASE,
            &args(&["run", "--reporter=json", "-t", evil, "/w/a.test.ts"]),
            ok_validate,
        )
        .unwrap();
        // The dangerous name is present verbatim as one element, right after `-t`, and no element
        // is a joined shell string.
        assert_eq!(argv.iter().filter(|a| a.as_str() == evil).count(), 1);
        let t = argv.iter().position(|a| a == "-t").unwrap();
        assert_eq!(argv[t + 1], evil);
        assert!(!argv.iter().any(|a| a.contains("; rm") && a != evil));
    }

    // --- Cargo argument authorization ------------------------------------------------------

    #[test]
    fn authorize_cargo_builds_the_nightly_json_run_for_all_filter_and_exact() {
        // Whole workspace.
        let all = authorize_cargo(&[]).unwrap();
        assert_eq!(all[0], "test");
        assert!(all.contains(&"--workspace".to_string()));
        assert!(all.contains(&"--message-format".to_string()) && all.contains(&"json".to_string()));
        // The libtest JSON tail is present.
        let tail = all.iter().position(|a| a == "--").unwrap();
        assert_eq!(
            &all[tail..],
            &[
                "--",
                "-Z",
                "unstable-options",
                "--format",
                "json",
                "--report-time"
            ]
        );

        // A module filter is one positional argument before `--`.
        let filtered = authorize_cargo(&args(&["--filter", "math::tests"])).unwrap();
        let dashes = filtered.iter().position(|a| a == "--").unwrap();
        assert_eq!(filtered[dashes - 1], "math::tests");
        assert!(!filtered.contains(&"--exact".to_string()));

        // An exact case adds `--exact` after the libtest tail.
        let exact = authorize_cargo(&args(&["--exact", "math::tests::adds"])).unwrap();
        assert_eq!(exact.last().unwrap(), "--exact");
        assert!(exact.contains(&"math::tests::adds".to_string()));
    }

    #[test]
    fn authorize_cargo_accepts_a_validated_package_and_rejects_a_bad_one() {
        let ok = authorize_cargo(&args(&["-p", "ide-workspace"])).unwrap();
        assert!(ok.windows(2).any(|w| w == ["-p", "ide-workspace"]));
        assert!(
            !ok.contains(&"--workspace".to_string()),
            "a package replaces --workspace"
        );
        // A package may precede a filter.
        let combined = authorize_cargo(&args(&["-p", "ide_core", "--exact", "m::t"])).unwrap();
        assert!(combined.windows(2).any(|w| w == ["-p", "ide_core"]));
        assert!(combined.contains(&"m::t".to_string()));
        // Path traversal, shell metacharacters and spaces are not valid package names.
        for bad in ["../evil", "a/b", "a;b", "a b", "a&b", ".."] {
            assert!(
                authorize_cargo(&args(&["-p", bad])).is_err(),
                "package {bad:?} must be rejected"
            );
        }
    }

    #[test]
    fn authorize_cargo_rejects_unknown_tokens_and_extra_arguments() {
        assert!(authorize_cargo(&args(&["--nocapture"])).is_err());
        assert!(
            authorize_cargo(&args(&["--filter"])).is_err(),
            "a bare flag with no value"
        );
        assert!(
            authorize_cargo(&args(&["--filter", "a", "b"])).is_err(),
            "trailing junk"
        );
        assert!(authorize_cargo(&args(&["-p", "pkg", "-p", "other"])).is_err());
        assert!(
            authorize_cargo(&args(&["--", "-Z", "unstable-options"])).is_err(),
            "no raw passthrough"
        );
    }

    #[test]
    fn a_cargo_test_filter_with_shell_metacharacters_stays_one_argv_element() {
        let evil = r#"mod::"; rm -rf / #`$(id)"#;
        let argv = authorize_cargo(&args(&["--exact", evil])).unwrap();
        assert_eq!(argv.iter().filter(|a| a.as_str() == evil).count(), 1);
        assert!(!argv.iter().any(|a| a.contains("rm -rf") && a != evil));
    }

    #[test]
    fn cargo_identifier_rules_match_cargo_and_reject_everything_dangerous() {
        assert!(is_cargo_ident("ide-workspace"));
        assert!(is_cargo_ident("ide_core"));
        assert!(is_cargo_ident("crate2"));
        assert!(!is_cargo_ident(""));
        assert!(!is_cargo_ident("-leading-dash"));
        assert!(!is_cargo_ident("has space"));
        assert!(!is_cargo_ident("../escape"));
        assert!(!is_cargo_ident("semi;colon"));
    }

    // --- Cargo test-executable resolution (WS6 Part 3) -------------------------------------

    #[test]
    fn parse_cargo_artifacts_identifies_test_binaries_across_targets_and_packages() {
        let out = [
            // A library unit-test binary.
            r#"{"reason":"compiler-artifact","package_id":"path+file:///w/a#crate_a@0.1.0","target":{"name":"crate_a","kind":["lib"]},"profile":{"test":true},"executable":"/w/a/target/debug/deps/crate_a-111.exe"}"#,
            // An integration-test binary in another package.
            r#"{"reason":"compiler-artifact","package_id":"crate_b 0.2.0 (path+file:///w/b)","target":{"name":"it","kind":["test"]},"profile":{"test":true},"executable":"/w/b/target/debug/deps/it-222.exe"}"#,
            // An ordinary (non-test) binary artifact: skipped.
            r#"{"reason":"compiler-artifact","package_id":"crate_a 0.1.0","target":{"name":"crate_a","kind":["bin"]},"profile":{"test":false},"executable":"/w/a/target/debug/crate_a.exe"}"#,
            r#"{"reason":"build-finished","success":true}"#,
        ]
        .join("\n");
        match parse_cargo_test_artifacts(&out) {
            CargoTestExecutables::Compiled { binaries } => {
                assert_eq!(
                    binaries.len(),
                    2,
                    "two test binaries, the plain bin skipped"
                );
                assert_eq!(binaries[0].package, "crate_a");
                assert_eq!(binaries[0].kind, "lib");
                assert!(binaries[0].executable.contains("crate_a-111"));
                assert_eq!(
                    binaries[1].package, "crate_b",
                    "old-style package_id parses too"
                );
                assert_eq!(binaries[1].kind, "test");
            }
            other => panic!("expected Compiled, got {other:?}"),
        }
    }

    #[test]
    fn parse_cargo_artifacts_collapses_duplicates_and_skips_artifacts_without_an_executable() {
        let line = r#"{"reason":"compiler-artifact","package_id":"a 0.1.0","target":{"name":"a","kind":["lib"]},"profile":{"test":true},"executable":"/w/target/debug/deps/a-1.exe"}"#;
        // A test profile with no executable (e.g. a doctest build step) is skipped.
        let no_exe = r#"{"reason":"compiler-artifact","package_id":"a 0.1.0","target":{"name":"a","kind":["lib"]},"profile":{"test":true},"executable":null}"#;
        let out = [
            line,
            line,
            no_exe,
            r#"{"reason":"build-finished","success":true}"#,
        ]
        .join("\n");
        match parse_cargo_test_artifacts(&out) {
            CargoTestExecutables::Compiled { binaries } => assert_eq!(binaries.len(), 1),
            other => panic!("expected Compiled, got {other:?}"),
        }
    }

    #[test]
    fn parse_cargo_artifacts_reports_a_compile_failure_as_diagnostics_not_a_test() {
        let out = [
            r#"{"reason":"compiler-message","message":{"level":"error","rendered":"error[E0425]: cannot find value `x`"}}"#,
            r#"{"reason":"build-finished","success":false}"#,
        ]
        .join("\n");
        match parse_cargo_test_artifacts(&out) {
            CargoTestExecutables::CompileFailed { diagnostics } => {
                assert_eq!(diagnostics.len(), 1);
                assert!(diagnostics[0].contains("cannot find value"));
            }
            other => panic!("expected CompileFailed, got {other:?}"),
        }
    }

    #[test]
    fn parse_cargo_artifacts_tolerates_noise_and_truncation_and_empty() {
        let out = [
            "   Compiling crate v0.1.0",
            "",
            r#"{"reason":"compiler-artifact","package_id":"a 0.1.0","target":{"name":"a","kind":["lib"]},"profile":{"test":true},"executable":"/w/target/debug/deps/a-1.exe"}"#,
            r#"{"reason":"build-finished","success":tru"#, // truncated
        ]
        .join("\n");
        match parse_cargo_test_artifacts(&out) {
            CargoTestExecutables::Compiled { binaries } => assert_eq!(binaries.len(), 1),
            other => panic!("expected Compiled, got {other:?}"),
        }
        assert!(matches!(
            parse_cargo_test_artifacts(""),
            CargoTestExecutables::Compiled { binaries } if binaries.is_empty()
        ));
    }

    #[test]
    fn package_name_parses_new_and_old_package_ids() {
        assert_eq!(package_name("path+file:///w/a#crate_a@0.1.0"), "crate_a");
        assert_eq!(package_name("path+file:///w/a#0.1.0"), "a"); // name-less #version
        assert_eq!(package_name("crate_b 0.2.0 (registry+...)"), "crate_b");
        assert_eq!(package_name("registry+https://x#serde@1.0"), "serde");
    }

    // --- Playwright argument authorization -------------------------------------------------

    #[test]
    fn authorize_playwright_builds_the_json_run_for_all_file_grep_and_project() {
        assert_eq!(
            authorize_playwright(&[], ok_validate).unwrap(),
            args(&["test", "--reporter=json"])
        );
        assert_eq!(
            authorize_playwright(&args(&["--file", "e2e/a.spec.ts"]), ok_validate).unwrap(),
            args(&["test", "--reporter=json", "<validated>e2e/a.spec.ts"])
        );
        assert_eq!(
            authorize_playwright(
                &args(&[
                    "--file",
                    "e2e/a.spec.ts",
                    "-g",
                    "forms submits",
                    "--project",
                    "Mobile Chrome"
                ]),
                ok_validate
            )
            .unwrap(),
            args(&[
                "test",
                "--reporter=json",
                "<validated>e2e/a.spec.ts",
                "-g",
                "forms submits",
                "--project",
                "Mobile Chrome",
            ])
        );
    }

    #[test]
    fn authorize_playwright_validates_the_file_and_rejects_unknown_or_dangerous_input() {
        let validate = |file: &str| -> Result<String, String> {
            if file.contains("..") || file.starts_with("/etc") {
                Err("Security rejection".to_string())
            } else {
                Ok(file.to_string())
            }
        };
        assert!(authorize_playwright(&args(&["--file", "../../etc/passwd"]), validate).is_err());
        assert!(authorize_playwright(&args(&["--headed"]), ok_validate).is_err());
        assert!(authorize_playwright(&args(&["-g", "x", "extra"]), ok_validate).is_err());
        // A project name that is a flag or has control characters is refused.
        assert!(authorize_playwright(&args(&["--project", "-evil"]), ok_validate).is_err());
        assert!(authorize_playwright(&args(&["--project", ""]), ok_validate).is_err());
    }

    #[test]
    fn a_playwright_grep_with_shell_metacharacters_stays_one_argv_element() {
        let evil = r#"title"; rm -rf / #`$(id)"#;
        let argv =
            authorize_playwright(&args(&["--file", "a.spec.ts", "-g", evil]), ok_validate).unwrap();
        assert_eq!(argv.iter().filter(|a| a.as_str() == evil).count(), 1);
        assert!(!argv.iter().any(|a| a.contains("rm -rf") && a != evil));
    }

    #[test]
    fn playwright_project_rules_allow_spaces_but_reject_flags_and_control_chars() {
        assert!(is_playwright_project("chromium"));
        assert!(is_playwright_project("Mobile Chrome"));
        assert!(!is_playwright_project(""));
        assert!(!is_playwright_project("-leading"));
        assert!(!is_playwright_project("has\nnewline"));
    }

    // --- pytest argument authorization + Python resolution --------------------------------

    #[test]
    fn authorize_pytest_accepts_all_file_and_node_and_validates_the_path() {
        assert_eq!(
            authorize_pytest(&[], ok_validate).unwrap(),
            Vec::<String>::new()
        );
        assert_eq!(
            authorize_pytest(&args(&["--file", "tests/test_a.py"]), ok_validate).unwrap(),
            vec!["<validated>tests/test_a.py".to_string()]
        );
        // A node id: the path before `::` is validated, the rest stays one opaque token.
        assert_eq!(
            authorize_pytest(
                &args(&["--node", "tests/test_a.py::TestC::test_m[1-2]"]),
                ok_validate
            )
            .unwrap(),
            vec!["<validated>tests/test_a.py::TestC::test_m[1-2]".to_string()]
        );
    }

    #[test]
    fn authorize_pytest_rejects_unknown_args_bad_node_ids_and_control_characters() {
        assert!(authorize_pytest(&args(&["--pdb"]), ok_validate).is_err());
        assert!(authorize_pytest(&args(&["--file", "a", "b"]), ok_validate).is_err());
        // A node id without `::` is not a node id.
        assert!(authorize_pytest(&args(&["--node", "tests/test_a.py"]), ok_validate).is_err());
        // Control characters in a node id are refused.
        assert!(authorize_pytest(&args(&["--node", "a.py::t\n"]), ok_validate).is_err());
        // The path part is containment-validated.
        let validate = |f: &str| -> Result<String, String> {
            if f.contains("..") {
                Err("escape".to_string())
            } else {
                Ok(f.to_string())
            }
        };
        assert!(authorize_pytest(&args(&["--node", "../../etc/x.py::t"]), validate).is_err());
    }

    #[test]
    fn a_pytest_node_id_with_shell_metacharacters_stays_one_argv_element() {
        let evil = r#"t"; rm -rf / #`$(id)"#;
        let node = format!("a.py::{evil}");
        let argv = authorize_pytest(&args(&["--node", &node]), ok_validate).unwrap();
        assert_eq!(argv.len(), 1, "the whole node id is one argument");
        assert!(argv[0].contains(evil) && !argv[0].contains("\n"));
    }

    #[test]
    fn resolve_python_finds_a_workspace_virtualenv_first() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("pyvenv-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let bin = if cfg!(windows) { "Scripts" } else { "bin" };
        let exe = if cfg!(windows) {
            "python.exe"
        } else {
            "python"
        };
        std::fs::create_dir_all(dir.join(".venv").join(bin)).unwrap();
        std::fs::write(dir.join(".venv").join(bin).join(exe), "").unwrap();
        assert_eq!(
            resolve_python(&dir),
            Some(dir.join(".venv").join(bin).join(exe))
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- run registry: ownership, idempotency, concurrency, stale protection ----------------

    fn root(name: &str) -> PathBuf {
        PathBuf::from(format!("/ws/{name}"))
    }

    #[test]
    fn a_run_registers_with_a_live_flag_and_deregisters_by_id() {
        let runs = TestRuns::default();
        let a = runs.register(&root("one"));
        assert!(a.admitted);
        assert!(!a.cancel.load(Ordering::Relaxed));
        assert_eq!(runs.guard().len(), 1);
        runs.deregister(a.id);
        assert_eq!(runs.guard().len(), 0);
    }

    #[test]
    fn cancellation_is_scoped_to_the_owning_workspace() {
        let runs = TestRuns::default();
        let mine = runs.register(&root("mine"));
        let other = runs.register(&root("other"));
        assert_eq!(runs.cancel_for_root(&root("mine")), 1);
        assert!(mine.cancel.load(Ordering::Relaxed), "my run is cancelled");
        assert!(
            !other.cancel.load(Ordering::Relaxed),
            "another workspace's run is untouched"
        );
    }

    #[test]
    fn cancellation_is_idempotent_and_harmless_when_nothing_matches() {
        let runs = TestRuns::default();
        let a = runs.register(&root("w"));
        assert_eq!(runs.cancel_for_root(&root("w")), 1);
        assert_eq!(
            runs.cancel_for_root(&root("w")),
            1,
            "cancelling again is fine"
        );
        assert!(a.cancel.load(Ordering::Relaxed));
        assert_eq!(
            runs.cancel_for_root(&root("absent")),
            0,
            "no match, no effect"
        );
    }

    #[test]
    fn starting_a_second_run_for_a_workspace_supersedes_the_first() {
        let runs = TestRuns::default();
        let first = runs.register(&root("w"));
        let _second = runs.register(&root("w"));
        assert!(
            first.cancel.load(Ordering::Relaxed),
            "the superseded run was signalled to stop"
        );
        assert_eq!(
            runs.guard().len(),
            2,
            "both are tracked until each deregisters"
        );
    }

    #[test]
    fn a_superseded_run_finishing_does_not_remove_the_newer_run() {
        // The core stale-protection property: deregistering by id means a late-finishing old run
        // cannot evict the newer run that took its place.
        let runs = TestRuns::default();
        let first = runs.register(&root("w"));
        let second = runs.register(&root("w"));
        runs.deregister(first.id); // the old run finishes late
        let remaining = runs.guard();
        assert_eq!(remaining.len(), 1);
        assert_eq!(
            remaining[0].id, second.id,
            "the newer run is still registered"
        );
    }

    #[test]
    fn concurrency_is_bounded() {
        let runs = TestRuns::default();
        let mut admitted = 0;
        for i in 0..(MAX_CONCURRENT_RUNS + 3) {
            if runs.register(&root(&format!("w{i}"))).admitted {
                admitted += 1;
            }
        }
        assert_eq!(
            admitted, MAX_CONCURRENT_RUNS,
            "runs past the bound are refused"
        );
    }

    #[test]
    fn cancel_all_signals_every_workspace() {
        let runs = TestRuns::default();
        let a = runs.register(&root("a"));
        let b = runs.register(&root("b"));
        runs.cancel_all();
        assert!(a.cancel.load(Ordering::Relaxed) && b.cancel.load(Ordering::Relaxed));
    }
}

#[cfg(test)]
mod real_tests {
    //! Level B -- controlled process integration. These run a **fixture script** we write (never
    //! a downloaded binary), through the real `execute` path (`capture_classified` + outcome
    //! mapping): valid JSON, invalid JSON, non-zero exit, a hang that is cancelled, and a run that
    //! outlives its deadline. Level C (a real Vitest/Jest install) is reported as skipped when no
    //! local runner is present; this repository ships none, so it is expected to skip.
    use super::*;
    use std::sync::atomic::AtomicBool;

    /// Write an executable fixture that prints `stdout`/`stderr` and exits `code`. On Windows a
    /// `.cmd`; elsewhere a shell script. Returned as a resolvable program path.
    fn fixture(
        name: &str,
        stdout: &str,
        stderr: &str,
        code: i32,
        sleep_secs: u32,
    ) -> (PathBuf, PathBuf) {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("testrun-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        #[cfg(windows)]
        let program = {
            let path = dir.join("runner.cmd");
            let mut script = String::from("@echo off\r\n");
            if sleep_secs > 0 {
                script.push_str(&format!("ping -n {} 127.0.0.1 >nul\r\n", sleep_secs + 1));
            }
            for line in stdout.lines() {
                script.push_str(&format!("echo {line}\r\n"));
            }
            for line in stderr.lines() {
                script.push_str(&format!("echo {line} 1>&2\r\n"));
            }
            script.push_str(&format!("exit /b {code}\r\n"));
            std::fs::write(&path, script).unwrap();
            path
        };
        #[cfg(not(windows))]
        let program = {
            use std::os::unix::fs::PermissionsExt;
            let path = dir.join("runner.sh");
            let mut script = String::from("#!/bin/sh\n");
            if sleep_secs > 0 {
                script.push_str(&format!("sleep {sleep_secs}\n"));
            }
            if !stdout.is_empty() {
                script.push_str(&format!("cat <<'EOF'\n{stdout}\nEOF\n"));
            }
            if !stderr.is_empty() {
                script.push_str(&format!("cat <<'EOF' 1>&2\n{stderr}\nEOF\n"));
            }
            script.push_str(&format!("exit {code}\n"));
            std::fs::write(&path, &script).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        };
        (program, dir)
    }

    fn run(
        program: &Path,
        dir: &Path,
        cancel: Arc<AtomicBool>,
        timeout: Duration,
    ) -> TestRunOutput {
        execute(
            program,
            dir,
            &args_vec(&["run", "--reporter=json"]),
            cancel,
            timeout,
            "vitest",
            None,
        )
        .expect("fixture runs")
    }

    fn args_vec(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_runner_that_prints_json_and_exits_zero_is_completed_with_that_output() {
        let json = r#"{"testResults":[]}"#;
        let (program, dir) = fixture("ok", json, "", 0, 0);
        let out = run(
            &program,
            &dir,
            Arc::new(AtomicBool::new(false)),
            TEST_TIMEOUT,
        );
        assert_eq!(out.outcome, TestOutcome::Completed);
        assert_eq!(out.code, 0);
        assert!(
            out.output.contains("testResults"),
            "stdout JSON is returned: {}",
            out.output
        );
        assert_eq!(Path::new(&out.root), dir);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_failing_suite_exits_nonzero_but_is_still_completed_not_an_error() {
        let json = r#"{"testResults":[{"name":"a","assertionResults":[{"status":"failed"}]}]}"#;
        let (program, dir) = fixture("fail", json, "", 1, 0);
        let out = run(
            &program,
            &dir,
            Arc::new(AtomicBool::new(false)),
            TEST_TIMEOUT,
        );
        assert_eq!(
            out.outcome,
            TestOutcome::Completed,
            "a nonzero exit is a result, not a run failure"
        );
        assert_eq!(out.code, 1);
        assert!(out.output.contains("failed"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_runner_with_no_stdout_surfaces_its_stderr_so_a_bad_config_is_visible() {
        let (program, dir) = fixture("nostdout", "", "could not find a config", 1, 0);
        let out = run(
            &program,
            &dir,
            Arc::new(AtomicBool::new(false)),
            TEST_TIMEOUT,
        );
        assert_eq!(out.outcome, TestOutcome::Completed);
        assert!(
            out.output.contains("could not find a config"),
            "stderr fallback: {}",
            out.output
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_hanging_runner_is_cancelled_and_killed_promptly() {
        let (program, dir) = fixture("hang", r#"{"testResults":[]}"#, "", 0, 30);
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            flag.store(true, Ordering::Relaxed);
        });
        let start = std::time::Instant::now();
        let out = run(&program, &dir, cancel, TEST_TIMEOUT);
        assert_eq!(out.outcome, TestOutcome::Cancelled);
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "cancellation must not wait for the 30s runner: took {:?}",
            start.elapsed()
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_runner_that_outlives_its_deadline_is_timed_out() {
        let (program, dir) = fixture("slow", r#"{"testResults":[]}"#, "", 0, 30);
        let out = run(
            &program,
            &dir,
            Arc::new(AtomicBool::new(false)),
            Duration::from_millis(300),
        );
        assert_eq!(out.outcome, TestOutcome::TimedOut);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_missing_runner_program_is_a_clear_error() {
        let error = execute(
            Path::new("yavin-no-such-test-runner"),
            Path::new(env!("CARGO_MANIFEST_DIR")),
            &args_vec(&["run", "--reporter=json"]),
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(5),
            "vitest",
            None,
        )
        .unwrap_err();
        assert!(error.contains("Could not run vitest"), "{error}");
    }

    #[test]
    fn pytest_reads_the_json_report_file_over_stdout_and_removes_it() {
        // pytest's json-report plugin writes a file, not stdout. A fixture that prints noise to
        // stdout but exits 0, with the report file pre-written (as the plugin would), must yield
        // the file's contents — and the file is cleaned up afterward.
        let (program, dir) = fixture("pyfile", "noise on stdout", "", 0, 0);
        let report = dir.join("report.json");
        std::fs::write(&report, r#"{"tests":[],"summary":{"total":0}}"#).unwrap();
        let out = execute(
            &program,
            &dir,
            &args_vec(&["ignored"]),
            Arc::new(AtomicBool::new(false)),
            TEST_TIMEOUT,
            "pytest",
            Some(&report),
        )
        .expect("runs");
        assert_eq!(out.outcome, TestOutcome::Completed);
        assert!(
            out.output.contains("\"tests\""),
            "the report file is used: {}",
            out.output
        );
        assert!(
            !out.output.contains("noise"),
            "stdout is not used when the file exists"
        );
        assert!(!report.exists(), "the report file is removed after reading");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn pytest_without_a_report_file_falls_back_to_stderr_so_a_missing_plugin_shows() {
        // The json-report plugin missing: pytest writes no file and complains on stderr. The error
        // must reach the parser (which turns it into a clear "install the plugin" message).
        let (program, dir) = fixture(
            "pyplugin",
            "",
            "error: unrecognized arguments: --json-report",
            2,
            0,
        );
        let out = execute(
            &program,
            &dir,
            &args_vec(&["ignored"]),
            Arc::new(AtomicBool::new(false)),
            TEST_TIMEOUT,
            "pytest",
            Some(&dir.join("does-not-exist.json")),
        )
        .expect("runs");
        assert_eq!(out.outcome, TestOutcome::Completed);
        assert!(
            out.output.contains("unrecognized arguments: --json-report"),
            "the plugin-missing error surfaces: {}",
            out.output
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn level_c_real_runner_is_reported_when_absent() {
        // Level C uses an installed Vitest/Jest if one is resolvable; this repo ships none, so
        // this records the skip explicitly rather than silently passing.
        let here = Path::new(env!("CARGO_MANIFEST_DIR"));
        let vitest = resolve_program("vitest", true, here, std::env::var_os("PATH"));
        let jest = resolve_program("jest", true, here, std::env::var_os("PATH"));
        if vitest.is_none() && jest.is_none() {
            eprintln!(
                "LEVEL C SKIPPED: no local Vitest/Jest runner is installed; the native run path \
                 is verified by Level A (authorization) and Level B (controlled process fixtures)."
            );
        } else {
            eprintln!("LEVEL C: a real runner is available and could be exercised.");
        }
    }

    /// Whether a nightly Cargo toolchain is present (libtest JSON is nightly-only). Probed with a
    /// short `cargo +nightly --version`; absence is the expected case on a stable CI.
    fn nightly_cargo_available() -> bool {
        Command::new("cargo")
            .args(["+nightly", "--version"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    #[test]
    fn level_c_real_cargo_runs_a_fixture_crate_when_nightly_is_available() {
        // Level C for Cargo: a tiny crate with one passing and one failing test, compiled and run
        // through the real authorized argv and parsed natively-equivalently. libtest JSON needs a
        // nightly toolchain; when none is installed (the stable default here) this reports the skip
        // rather than passing silently. No download: the crate has no dependencies.
        if !nightly_cargo_available() {
            eprintln!(
                "LEVEL C (cargo) SKIPPED: no nightly Cargo toolchain; libtest JSON is \
                 nightly-only. The Cargo path is verified by the libtest-JSON parser tests \
                 (cargoJson.test.ts) and Level A authorization (authorize_cargo)."
            );
            return;
        }
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("testrun-cargo-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(
            dir.join("Cargo.toml"),
            // An empty `[workspace]` table makes this a standalone crate: without it Cargo sees the
            // parent workspace (the fixture lives under `target/`) and refuses to build.
            "[package]\nname = \"wsfixture\"\nversion = \"0.0.0\"\nedition = \"2021\"\n\n[workspace]\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("src").join("lib.rs"),
            "#[test]\nfn passes() { assert_eq!(2 + 2, 4); }\n\
             #[test]\nfn fails() { assert_eq!(2 + 2, 5); }\n\
             #[test]\n#[ignore]\nfn skipped() {}\n",
        )
        .unwrap();
        // The real authorized argv, but pinned to +nightly so libtest accepts `--format json`.
        let mut argv = vec!["+nightly".to_string()];
        argv.extend(authorize_cargo(&[]).unwrap());
        let out = execute(
            Path::new("cargo"),
            &dir,
            &argv,
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(300),
            "cargo",
            None,
        )
        .expect("cargo runs");
        assert_eq!(out.outcome, TestOutcome::Completed);
        assert!(
            out.output.contains("\"type\":\"test\"") || out.output.contains("\"type\": \"test\""),
            "libtest JSON was produced: {}",
            out.output
        );
        eprintln!("LEVEL C (cargo): ran a real nightly Cargo test and got libtest JSON.");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn real_cargo_test_executable_resolution_finds_the_compiled_test_binary() {
        // Level C for the WS6 Part 3 resolution: build a real fixture crate with `cargo test
        // --no-run --message-format=json` (stable; no nightly needed) and confirm the parser finds
        // its compiled test executable, on disk. cargo is installed, so this really runs.
        let path = std::env::var_os("PATH");
        let Some(cargo) = resolve_program("cargo", false, Path::new("."), path) else {
            eprintln!("skipped: cargo is not installed");
            return;
        };
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("cargoexe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(
            dir.join("Cargo.toml"),
            "[package]\nname = \"ws6fixture\"\nversion = \"0.0.0\"\nedition = \"2021\"\n\n[workspace]\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("src").join("lib.rs"),
            "#[test]\nfn it_builds() { assert_eq!(2 + 2, 4); }\n",
        )
        .unwrap();
        let out = execute(
            &cargo,
            &dir,
            &args_vec(&["test", "--no-run", "--message-format", "json"]),
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(300),
            "cargo",
            None,
        )
        .expect("cargo runs");
        assert_eq!(
            out.outcome,
            TestOutcome::Completed,
            "cargo --no-run: {}",
            out.output
        );
        match parse_cargo_test_artifacts(&out.output) {
            CargoTestExecutables::Compiled { binaries } => {
                assert!(
                    !binaries.is_empty(),
                    "a test binary was resolved: {}",
                    out.output
                );
                let binary = &binaries[0];
                assert_eq!(binary.package, "ws6fixture");
                assert!(
                    Path::new(&binary.executable).is_file(),
                    "the compiled test executable exists on disk: {}",
                    binary.executable
                );
                assert!(
                    Path::new(&binary.executable).starts_with(&dir),
                    "the executable is inside the fixture's target dir"
                );
                eprintln!(
                    "LEVEL C (cargo-exe): resolved real test binary {}",
                    binary.executable
                );
            }
            CargoTestExecutables::CompileFailed { diagnostics } => {
                panic!("fixture should compile: {diagnostics:?}")
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn level_c_real_playwright_runs_a_fixture_project_when_installed() {
        // Level C for Playwright: this repo installs @playwright/test, so this runs a real
        // fixture project (no browser — the tests use no `page` fixture, so nothing is launched
        // or downloaded) through the real authorized argv and asserts genuine Playwright JSON.
        let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let program = match resolve_program("playwright", true, repo_root, std::env::var_os("PATH"))
        {
            Some(p) => p,
            None => {
                eprintln!(
                    "LEVEL C (playwright) SKIPPED: no local Playwright install resolvable; the \
                     adapter is verified by the JSON parser tests (playwrightJson.test.ts) and \
                     Level A authorization (authorize_playwright)."
                );
                return;
            }
        };
        // The fixture lives under the repo tree so Node resolves `@playwright/test` from the
        // repo's own node_modules.
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("pw-fixture-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("playwright.config.ts"),
            "import { defineConfig } from '@playwright/test';\n\
             export default defineConfig({ projects: [{ name: 'node' }] });\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("example.spec.ts"),
            "import { test, expect } from '@playwright/test';\n\
             test('adds', () => { expect(1 + 1).toBe(2); });\n\
             test('is wrong', () => { expect(1).toBe(2); });\n",
        )
        .unwrap();
        let out = execute(
            &program,
            &dir,
            &args_vec(&["test", "--reporter=json"]),
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(120),
            "playwright",
            None,
        )
        .expect("playwright runs");
        assert_eq!(out.outcome, TestOutcome::Completed);
        assert!(
            out.output.contains("\"suites\""),
            "Playwright JSON was produced: {}",
            &out.output.chars().take(400).collect::<String>()
        );
        eprintln!("LEVEL C (playwright): ran a real Playwright project and got reporter JSON.");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
