//! Running a project's own compiler or linter so the Problems view has something to show.
//!
//! Yavin has no language server, so diagnostics come the other way VS Code gets them: run the
//! tool, read its output, match it into diagnostics. What is deliberately *not* here is a
//! general "run this command" IPC. That would hand the renderer arbitrary execution as a
//! first-class capability; instead this is an allow-list in the same spirit as `git.rs` --
//! a fixed set of checkers, each with a fixed argv that the caller cannot influence. The
//! caller picks an id from the list and nothing else.

use crate::{with_workspace, Workspace};
use ide_workspace::process::capture_within;
use serde::Serialize;
use std::path::Path;
use std::process::Command;
use std::sync::{atomic::AtomicBool, Arc};
use std::time::Duration;
use tauri::State;

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

fn find(id: &str) -> Option<&'static Checker> {
    CHECKERS.iter().find(|checker| checker.id == id)
}

/// The checkers that apply here, by looking for each one's marker file in the workspace root.
#[tauri::command]
pub async fn available_checkers(state: State<'_, Workspace>) -> Result<Vec<CheckerInfo>, String> {
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
pub async fn run_checker(state: State<'_, Workspace>, id: String) -> Result<String, String> {
    let checker = find(&id).ok_or_else(|| format!("No checker named {id}."))?;
    let root = with_workspace(&state, |manager| Ok(manager.root().to_path_buf()))?;

    tauri::async_runtime::spawn_blocking(move || {
        let mut command = Command::new(checker.program);
        command.current_dir(&root).args(checker.args);
        // Long enough for a cold `cargo check` or a whole-project `tsc`, which is minutes of
        // legitimate work, but still bounded so a watch-mode tool cannot hang the view.
        let output = capture_within(
            command,
            None,
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(10 * 60),
        )
        .map_err(|e| format!("Could not run {}: {e}", checker.program))?;
        Ok(format!("{}\n{}", output.stdout, output.stderr))
    })
    .await
    .map_err(|e| e.to_string())?
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
