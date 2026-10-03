//! Running a project's own compiler or linter so the Problems view has something to show.
//!
//! Besides the language servers, diagnostics come the other way VS Code gets them: run the
//! tool, read its output, match it into diagnostics. What is deliberately *not* here is a
//! general "run this command" IPC. That would hand the renderer arbitrary execution as a
//! first-class capability; instead this is an allow-list in the same spirit as `git.rs` --
//! a fixed set of checkers, each with a fixed argv that the caller cannot influence. The
//! caller picks an id from the list and nothing else.

use crate::trust::{is_trusted, require_trust, Trust};
use crate::{with_workspace, Workspace};
use ide_workspace::lsp_process::resolve_program;
use ide_workspace::process::{capture_classified, CaptureError};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tauri::{AppHandle, State};

/// The cancel flag of the checker that is running, if one is.
///
/// A checker is the longest-running thing Yavin starts -- a cold `cargo check` is minutes --
/// and until this existed there was no way to stop one: the flag was constructed inline and
/// dropped, so nothing could ever set it. Closing the panel, changing folder or quitting left
/// a build running with no way to reach it.
#[derive(Default)]
pub struct Checks(pub Mutex<Option<Arc<AtomicBool>>>);

/// Stops whatever checker is running. Harmless when none is.
pub fn cancel_running(checks: &Checks) {
    if let Ok(guard) = checks.0.lock() {
        if let Some(flag) = guard.as_ref() {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

#[tauri::command(async)]
pub fn cancel_checker(checks: State<'_, Checks>) -> Result<(), String> {
    cancel_running(&checks);
    Ok(())
}

/// A checker, its exact command line, and how to tell it applies to a project.
struct Checker {
    /// Matches the matcher id on the TypeScript side, which knows how to parse the output.
    id: &'static str,
    label: &'static str,
    program: &'static str,
    args: &'static [&'static str],
    /// A file whose presence in the workspace root means this checker is worth offering.
    marker: &'static str,
}

/// Output formats are chosen for being parseable line by line rather than pretty: `--pretty
/// false`, `--message-format short`, `-f compact`, `--output-format concise`. Each has a
/// matcher of the same id in `problemMatchers.ts`.
const CHECKERS: &[Checker] = &[
    Checker {
        id: "tsc",
        label: "TypeScript",
        program: "npx",
        args: &["--no-install", "tsc", "--noEmit", "--pretty", "false"],
        marker: "tsconfig.json",
    },
    Checker {
        id: "eslint",
        label: "ESLint",
        program: "npx",
        args: &["--no-install", "eslint", ".", "-f", "compact"],
        marker: "eslint.config.js",
    },
    Checker {
        id: "cargo",
        label: "Rust",
        program: "cargo",
        args: &["check", "--message-format", "short", "--quiet"],
        marker: "Cargo.toml",
    },
    Checker {
        id: "ruff",
        label: "Ruff",
        program: "ruff",
        args: &["check", "--output-format", "concise"],
        marker: "pyproject.toml",
    },
];

#[derive(Serialize)]
pub struct CheckerInfo {
    pub id: String,
    pub label: String,
}

/// What a checker run produced. The exit code comes back because a checker that finds
/// problems and a checker that could not run both exit nonzero, and only the output tells
/// them apart -- without it, `npx --no-install tsc` in a project with no local TypeScript
/// reported "No problems found", which is the most misleading thing the view could say.
///
/// A run that was stopped or that outlived its deadline is not an error: it says so in
/// `outcome`, so the view can say "stopped" or "timed out" rather than "could not run".
/// `root` is the folder it ran in -- what the paths it prints are relative to.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CheckerOutput {
    pub outcome: CheckerOutcome,
    pub output: String,
    pub code: i32,
    pub root: String,
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CheckerOutcome {
    Completed,
    Cancelled,
    TimedOut,
}

/// How long a checker may run: long enough for a cold `cargo check` or a whole-project `tsc`,
/// which is minutes of legitimate work, but bounded so a watch-mode tool cannot hang the view.
const CHECKER_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Runs `checker` in `root`. Its program is found the way a language server's is -- on Windows
/// `npx` is an npm `npx.cmd` shim, which `Command::new("npx")` never finds -- and only ever with
/// its fixed arguments.
fn run_in(
    checker: &Checker,
    root: &Path,
    cancel: Arc<AtomicBool>,
    timeout: Duration,
) -> Result<CheckerOutput, String> {
    let program: PathBuf = resolve_program(checker.program, false, root, std::env::var_os("PATH"))
        .ok_or_else(|| {
            format!(
                "Could not run {}: it was not found on PATH.",
                checker.program
            )
        })?;
    let mut command = Command::new(program);
    command.current_dir(root).args(checker.args);
    let (outcome, output, code) = match capture_classified(command, None, cancel, timeout) {
        Ok(output) => (
            CheckerOutcome::Completed,
            format!("{}\n{}", output.stdout, output.stderr),
            output.code,
        ),
        Err(CaptureError::Cancelled) => (CheckerOutcome::Cancelled, String::new(), -1),
        Err(CaptureError::TimedOut) => (CheckerOutcome::TimedOut, String::new(), -1),
        Err(CaptureError::Failed(error)) => {
            return Err(format!("Could not run {}: {error}", checker.program))
        }
    };
    Ok(CheckerOutput {
        outcome,
        output,
        code,
        root: root.to_string_lossy().into_owned(),
    })
}

fn find(id: &str) -> Option<&'static Checker> {
    CHECKERS.iter().find(|checker| checker.id == id)
}

/// The checkers that apply here, by looking for each one's marker file in the workspace root.
///
/// A folder open in Restricted Mode offers none: running one executes the project's own
/// toolchain, so the buttons should not be there to press rather than failing when pressed.
#[tauri::command]
pub async fn available_checkers(
    app: AppHandle,
    state: State<'_, Workspace>,
    trust: State<'_, Trust>,
) -> Result<Vec<CheckerInfo>, String> {
    // Only a deliberate "no" means no checkers. Trust settings that cannot be read at all
    // are a real failure and are reported, rather than looking like a project with no tools.
    if !is_trusted(&app, &state, &trust)? {
        return Ok(Vec::new());
    }
    let root = with_workspace(&state, |manager| Ok(manager.root().to_path_buf()))?;
    Ok(CHECKERS
        .iter()
        .filter(|checker| Path::new(&root).join(checker.marker).is_file())
        .map(|checker| CheckerInfo {
            id: checker.id.to_string(),
            label: checker.label.to_string(),
        })
        .collect())
}

/// Runs one checker and returns its combined output for the matcher to read.
///
/// A checker that finds problems exits nonzero -- that is its job -- so the exit status is not
/// an error here; only failing to run it at all is. stdout and stderr are both returned
/// because tools disagree about where diagnostics go (`tsc` uses stdout, `cargo` stderr).
#[tauri::command]
pub async fn run_checker(
    app: AppHandle,
    state: State<'_, Workspace>,
    trust: State<'_, Trust>,
    checks: State<'_, Checks>,
    id: String,
) -> Result<CheckerOutput, String> {
    // Checked here as well as in `available_checkers`, because that one only decides what to
    // offer; this is the call that actually starts the project's build tooling.
    require_trust(&app, &state, &trust)?;
    let checker = find(&id).ok_or_else(|| format!("No checker named {id}."))?;
    let root = with_workspace(&state, |manager| Ok(manager.root().to_path_buf()))?;

    // Starting a second checker cancels the first: they publish into the same view, and two
    // builds competing for one target directory is worse than useless.
    let cancel = Arc::new(AtomicBool::new(false));
    cancel_running(&checks);
    *checks.0.lock().map_err(|e| e.to_string())? = Some(cancel.clone());

    let mine = cancel.clone();
    let finished = tauri::async_runtime::spawn_blocking(move || {
        run_in(checker, &root, cancel, CHECKER_TIMEOUT)
    })
    .await
    .map_err(|e| e.to_string())?;

    // Cleared whatever the outcome, so a run that has finished cannot be cancelled later --
    // but only if it is still this run's: a newer run has replaced it, and must stay stoppable.
    if let Ok(mut guard) = checks.0.lock() {
        if guard.as_ref().is_some_and(|flag| Arc::ptr_eq(flag, &mine)) {
            *guard = None;
        }
    }
    finished
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_checker_has_a_matcher_of_the_same_id_on_the_typescript_side() {
        // The id is the contract between the two halves: Rust runs it, TypeScript parses it.
        let matchers = include_str!("../../src/services/panel/problemMatchers.ts");
        for checker in CHECKERS {
            assert!(
                matchers.contains(&format!("owner: \"{}\"", checker.id)),
                "no matcher for checker {}",
                checker.id
            );
        }
    }

    #[test]
    fn only_a_named_checker_can_be_run() {
        // The allow-list is the whole security story: there is no way to name a program.
        assert!(find("tsc").is_some());
        assert!(find("cargo").is_some());
        assert!(find("bash").is_none());
        assert!(find("").is_none());
        assert!(find("tsc; rm -rf /").is_none());
    }

    #[test]
    fn no_checker_takes_an_argument_that_could_come_from_a_caller() {
        // Every argv is fixed at compile time. If one ever needs to be dynamic, that is the
        // moment to think about validation, so this test is here to force the question.
        for checker in CHECKERS {
            for argument in checker.args {
                assert!(
                    !argument.is_empty() && !argument.contains(char::is_whitespace),
                    "{}: argument {argument:?} should be a single fixed token",
                    checker.id
                );
            }
        }
    }
}

#[cfg(test)]
mod real_tests {
    use super::*;

    /// A tiny TypeScript project inside this repository's build folder, so `npx --no-install`
    /// finds the TypeScript Yavin itself depends on (no download, no network).
    fn project(name: &str) -> PathBuf {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("checker-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(
            dir.join("tsconfig.json"),
            r#"{"compilerOptions":{"strict":true,"noEmit":true},"include":["src"]}"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("src").join("bad file.ts"),
            "export const fine = 1;\nconst x: number = \"not a number\";\n",
        )
        .unwrap();
        dir
    }

    #[test]
    fn the_typescript_checker_really_runs_and_reports_paths_relative_to_its_root() {
        let dir = project("tsc");
        let run = run_in(
            find("tsc").unwrap(),
            &dir,
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(300),
        )
        .expect("npx tsc runs (on Windows through its .cmd shim)");
        assert_eq!(run.outcome, CheckerOutcome::Completed);
        assert_ne!(run.code, 0, "tsc found the error: {}", run.output);
        // Relative to the root it ran in, with the line and column of the bad assignment.
        assert!(
            run.output.contains("src/bad file.ts(2,7): error TS2322"),
            "{}",
            run.output
        );
        assert_eq!(Path::new(&run.root), dir.as_path());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_stopped_or_timed_out_checker_says_so_and_is_not_an_error() {
        let dir = project("stop");
        let stopped = run_in(
            find("tsc").unwrap(),
            &dir,
            Arc::new(AtomicBool::new(true)),
            Duration::from_secs(300),
        )
        .unwrap();
        assert_eq!(stopped.outcome, CheckerOutcome::Cancelled);
        let timed_out = run_in(
            find("tsc").unwrap(),
            &dir,
            Arc::new(AtomicBool::new(false)),
            Duration::from_millis(1),
        )
        .unwrap();
        assert_eq!(timed_out.outcome, CheckerOutcome::TimedOut);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_checker_whose_program_is_missing_says_so() {
        let missing = Checker {
            id: "missing",
            label: "Missing",
            program: "yavin-no-such-checker",
            args: &[],
            marker: "",
        };
        let error = run_in(
            &missing,
            Path::new(env!("CARGO_MANIFEST_DIR")),
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(5),
        )
        .unwrap_err();
        assert!(error.contains("not found on PATH"), "{error}");
    }
}
