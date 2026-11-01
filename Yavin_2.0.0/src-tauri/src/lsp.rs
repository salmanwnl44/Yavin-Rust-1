//! Language servers, as processes the renderer can ask for by name.
//!
//! The same shape as `checkers.rs`: a language server is an executable program -- and a server
//! running in a project runs that project's code (TypeScript plugins, build scripts, proc
//! macros) -- so there is no "run this program" here. There is a fixed allow-list of servers,
//! each with a fixed command line; the renderer picks one by id, and nothing it sends becomes
//! part of a command. Starting one needs the folder to be trusted, like the checkers and the
//! terminal. The working directory is a folder inside the workspace; the environment is
//! Yavin's own. Everything above the framing -- JSON-RPC, initialize, shutdown -- is the
//! renderer's (`src/services/lsp`).

use crate::trust::{is_trusted, require_trust, Trust};
use crate::{with_workspace, Workspace};
use ide_workspace::file_tree::clean_path_str;
use ide_workspace::lsp_process::{resolve_program, ServerEvents, ServerProcess};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

/// EXT-33 E0.1 (F-L1): a language server the project provides itself (its `node_modules/.bin`)
/// is the project's code chosen by the project, so trusting the folder does not by itself choose
/// to run it. `lsp_start` refuses one the user has not chosen with this prefix; the window asks.
pub const NEEDS_APPROVAL: &str = "needs-approval:";

/// What the user chose, per workspace and server, for a server the project provides.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectServerChoice {
    /// The workspace folder, as Yavin spells paths.
    root: String,
    server: String,
    /// `project`: run the project's program -- exactly the file below, with this SHA-256, so a
    /// replaced file is asked about again. `installed`: run the one on `PATH`, never the project's.
    choice: String,
    program: Option<String>,
    sha256: Option<String>,
}

/// The choices, kept in the app's config folder (`project-servers.json`), read on first use.
#[derive(Default)]
pub struct ProjectServers(Mutex<Option<Vec<ProjectServerChoice>>>);

fn choices_file(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("project-servers.json"))
        .map_err(|e| format!("Cannot find the settings folder: {e}"))
}

fn with_choices<T>(
    app: &AppHandle,
    projects: &ProjectServers,
    run: impl FnOnce(&mut Vec<ProjectServerChoice>) -> T,
) -> Result<T, String> {
    let mut guard = projects.0.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        // Unreadable or malformed: no choice is assumed (each project server asks again).
        let loaded = std::fs::read_to_string(choices_file(app)?)
            .ok()
            .and_then(|text| serde_json::from_str::<Vec<ProjectServerChoice>>(&text).ok())
            .unwrap_or_default();
        *guard = Some(loaded);
    }
    Ok(run(guard.as_mut().expect("loaded")))
}

/// EXT-33 E0.3 (V6): whether `candidate` is within `workspace` by its *own location*, not only
/// by where it finally points. A `node_modules/.bin` entry that is a symlink or junction leading
/// outside the workspace is still project-provided -- its selected location is inside -- so the
/// lexical test catches it; and a link from outside that lands inside the workspace is caught by
/// the canonical test. Either way the program is treated as the project's and needs a choice.
fn within_workspace(workspace: &Path, candidate: &Path) -> bool {
    let ws = clean_path_str(workspace);
    let here = clean_path_str(candidate);
    if here == ws || here.starts_with(&format!("{ws}/")) {
        return true;
    }
    match (
        std::fs::canonicalize(workspace),
        std::fs::canonicalize(candidate),
    ) {
        (Ok(w), Ok(c)) => c.starts_with(&w),
        _ => false,
    }
}

/// EXT-33 E0.1/E0.3 (F-L1, V3, V6): the project-provided code that starting `spec` would run, or
/// `None` if only installed code runs. Two sources, each needing the user's explicit choice:
/// - the server program itself, when its selected location is inside the workspace (V6);
/// - a file the server auto-loads from the workspace even when its own program is installed
///   elsewhere -- TypeScript's `tsserver.js` (V3). That file, not the entry program, is the code
///   that actually runs, so the approval's identity (path and SHA-256) binds to it.
fn project_artifact(
    spec: &ServerSpec,
    workspace: &Path,
    folder: &Path,
    resolved: &Path,
) -> Option<PathBuf> {
    if within_workspace(workspace, resolved) {
        return Some(resolved.to_path_buf());
    }
    let delegate = folder.join(spec.delegate?);
    delegate.is_file().then_some(delegate)
}

/// The program to run for `spec` in `folder`. A server whose code is entirely installed runs as
/// resolved. One that would run project code ([`project_artifact`]) runs only as the user chose:
/// `project` runs the entry program once the project artifact still matches by path and SHA-256;
/// `installed` runs the one on `PATH`, but only when that would itself run no project code (not a
/// `PATH` entry inside the workspace (V5), nor a workspace file the installed server auto-loads
/// (V3)); otherwise it is refused with `NEEDS_APPROVAL`.
fn chosen_program(
    choices: &[ProjectServerChoice],
    spec: &ServerSpec,
    workspace: &Path,
    folder: &Path,
    resolved: PathBuf,
    path_var: Option<std::ffi::OsString>,
) -> Result<PathBuf, String> {
    let Some(artifact) = project_artifact(spec, workspace, folder, &resolved) else {
        return Ok(resolved);
    };
    let root = clean_path_str(workspace);
    let identity = clean_path_str(&artifact);
    let choice = choices
        .iter()
        .find(|c| c.root == root && c.server == spec.id);
    match choice {
        Some(c) if c.choice == "installed" => {
            let installed = resolve_program(spec.program, false, folder, path_var)
                .ok_or_else(|| {
                    format!(
                        "not-installed: The {} language server ({}) is not installed (you chose the installed one over this project's).",
                        spec.label, spec.program
                    )
                })?;
            // V5 + V3: "installed" must run no project code. If the one on `PATH` is itself inside
            // the workspace, or the installed server would still auto-load a workspace file, Yavin
            // cannot honour "installed" safely -- so it asks rather than run that code unchosen.
            if project_artifact(spec, workspace, folder, &installed).is_some() {
                return Err(format!(
                    "{NEEDS_APPROVAL} The installed {} language server would still run code this project provides ({}). Choose the project's server to run it, or remove it from the project.",
                    spec.label, identity
                ));
            }
            Ok(installed)
        }
        Some(c)
            if c.choice == "project"
                && c.program.as_deref() == Some(identity.as_str())
                && c.sha256.as_deref()
                    == crate::extension_package::sha256_file(&artifact).ok().as_deref() =>
        {
            Ok(resolved)
        }
        Some(c) if c.choice == "project" => Err(format!(
            "{NEEDS_APPROVAL} The {} language server this project provides ({}) changed since you chose it. Click to choose again.",
            spec.label, identity
        )),
        _ => Err(format!(
            "{NEEDS_APPROVAL} This project provides its own {} language server ({}). Yavin runs it only once you choose it: click to choose the project's or the installed one.",
            spec.label, identity
        )),
    }
}

/// A server Yavin knows how to start: its program and exact arguments.
struct ServerSpec {
    /// The id the renderer's registry (`src/services/lsp/registry.ts`) uses.
    id: &'static str,
    label: &'static str,
    program: &'static str,
    args: &'static [&'static str],
    /// Installed with npm, so a project may pin its own version in `node_modules/.bin`.
    node_package: bool,
    /// EXT-33 E0.3 (V3): a file, relative to the LSP root, that this server auto-loads and runs
    /// from the workspace even when its own program is installed elsewhere -- the way
    /// `typescript-language-server` runs the workspace's own `tsserver.js`. When the workspace
    /// provides it, it is project code, so it needs the same explicit choice as a project server.
    delegate: Option<&'static str>,
}

const SERVERS: &[ServerSpec] = &[
    ServerSpec {
        id: "typescript",
        label: "TypeScript",
        program: "typescript-language-server",
        args: &["--stdio"],
        node_package: true,
        // EXT-33 E0.3 (V3): the server runs the workspace's own `tsserver.js` when the project
        // ships one, even if the server program itself is installed. That JavaScript is the code
        // that executes, so the approval binds to it.
        delegate: Some("node_modules/typescript/lib/tsserver.js"),
    },
    ServerSpec {
        id: "pyright",
        label: "Pyright",
        program: "pyright-langserver",
        args: &["--stdio"],
        node_package: true,
        delegate: None,
    },
    ServerSpec {
        id: "pylsp",
        label: "Python LSP",
        program: "pylsp",
        args: &[],
        node_package: false,
        delegate: None,
    },
    ServerSpec {
        id: "rust-analyzer",
        label: "rust-analyzer",
        program: "rust-analyzer",
        args: &[],
        node_package: false,
        delegate: None,
    },
    ServerSpec {
        id: "gopls",
        label: "gopls",
        program: "gopls",
        args: &[],
        node_package: false,
        delegate: None,
    },
    ServerSpec {
        id: "clangd",
        label: "clangd",
        program: "clangd",
        args: &[],
        node_package: false,
        delegate: None,
    },
    ServerSpec {
        id: "json",
        label: "JSON",
        program: "vscode-json-language-server",
        args: &["--stdio"],
        node_package: true,
        delegate: None,
    },
    ServerSpec {
        id: "css",
        label: "CSS",
        program: "vscode-css-language-server",
        args: &["--stdio"],
        node_package: true,
        delegate: None,
    },
    ServerSpec {
        id: "html",
        label: "HTML",
        program: "vscode-html-language-server",
        args: &["--stdio"],
        node_package: true,
        delegate: None,
    },
    ServerSpec {
        id: "yaml",
        label: "YAML",
        program: "yaml-language-server",
        args: &["--stdio"],
        node_package: true,
        delegate: None,
    },
    ServerSpec {
        id: "bash",
        label: "Bash",
        program: "bash-language-server",
        args: &["start"],
        node_package: true,
        delegate: None,
    },
];

fn find(id: &str) -> Option<&'static ServerSpec> {
    SERVERS.iter().find(|server| server.id == id)
}

/// Every language server Yavin started, by session number.
#[derive(Default)]
pub struct LspSessions {
    next: AtomicU32,
    live: Mutex<HashMap<u32, Arc<ServerProcess>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerAvailability {
    id: String,
    label: String,
    /// Where it would run from; `None` when it is not installed.
    program: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServers {
    /// False in Restricted Mode: no server is started, whatever is installed.
    trusted: bool,
    servers: Vec<ServerAvailability>,
}

/// The servers this folder could use, and whether each is installed. In Restricted Mode none
/// is offered (and none would start).
#[tauri::command]
pub async fn lsp_servers(
    app: AppHandle,
    state: State<'_, Workspace>,
    trust: State<'_, Trust>,
) -> Result<LspServers, String> {
    let trusted = is_trusted(&app, &state, &trust)?;
    let root = with_workspace(&state, |manager| Ok(manager.root().to_path_buf()))?;
    let path = std::env::var_os("PATH");
    Ok(LspServers {
        trusted,
        servers: SERVERS
            .iter()
            .map(|server| ServerAvailability {
                id: server.id.into(),
                label: server.label.into(),
                program: if trusted {
                    resolve_program(server.program, server.node_package, &root, path.clone())
                        .map(|program| program.to_string_lossy().into_owned())
                } else {
                    None
                },
            })
            .collect(),
    })
}

#[derive(Clone, Serialize)]
struct Message {
    session: u32,
    message: String,
}

#[derive(Clone, Serialize)]
struct Log {
    session: u32,
    line: String,
}

#[derive(Clone, Serialize)]
struct Exit {
    session: u32,
    code: Option<i32>,
    error: Option<String>,
}

struct Emitting {
    app: AppHandle,
    session: u32,
}

impl ServerEvents for Emitting {
    fn message(&self, message: String) {
        let _ = self.app.emit(
            "lsp-message",
            Message {
                session: self.session,
                message,
            },
        );
    }
    fn log(&self, line: String) {
        let _ = self.app.emit(
            "lsp-log",
            Log {
                session: self.session,
                line,
            },
        );
    }
    fn exit(&self, code: Option<i32>, error: Option<String>) {
        if let Ok(mut live) = self.app.state::<LspSessions>().live.lock() {
            live.remove(&self.session);
        }
        let _ = self.app.emit(
            "lsp-exit",
            Exit {
                session: self.session,
                code,
                error,
            },
        );
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    session: u32,
    program: String,
}

/// Starts server `server` for the folder `root` (inside the workspace). Its messages arrive as
/// `lsp-message` events, its log as `lsp-log`, its end as `lsp-exit`.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn lsp_start(
    app: AppHandle,
    state: State<'_, Workspace>,
    trust: State<'_, Trust>,
    sessions: State<'_, LspSessions>,
    projects: State<'_, ProjectServers>,
    server: String,
    root: String,
) -> Result<Started, String> {
    require_trust(&app, &state, &trust)?;
    let spec = find(&server).ok_or_else(|| format!("No language server named {server}."))?;
    let folder = with_workspace(&state, |manager| manager.validate_path(&root))?;
    if !folder.is_dir() {
        return Err(format!("{root} is not a folder."));
    }
    let resolved = resolve_program(
        spec.program,
        spec.node_package,
        &folder,
        std::env::var_os("PATH"),
    )
    .ok_or_else(|| {
        format!(
            "not-installed: The {} language server ({}) is not installed.",
            spec.label, spec.program
        )
    })?;
    // EXT-33 E0.1 (F-L1): a server the project provides runs only as the user chose.
    let workspace = with_workspace(&state, |manager| Ok(manager.root().to_path_buf()))?;
    let program = with_choices(&app, &projects, |choices| {
        chosen_program(
            choices,
            spec,
            &workspace,
            &folder,
            resolved,
            std::env::var_os("PATH"),
        )
    })??;
    let session = sessions.next.fetch_add(1, Ordering::Relaxed) + 1;
    let process = ServerProcess::spawn(
        &program,
        spec.args,
        &folder,
        Arc::new(Emitting {
            app: app.clone(),
            session,
        }),
    )?;
    sessions
        .live
        .lock()
        .map_err(|e| e.to_string())?
        .insert(session, Arc::new(process));
    Ok(Started {
        session,
        program: program.to_string_lossy().into_owned(),
    })
}

/// EXT-33 E0.1 (F-L1): records the user's choice for the server `server` this project
/// provides in `root`: `project` (run that very file -- resolved and hashed here, never named by
/// the window) or `installed` (the one on `PATH`, never the project's). Needs the folder trusted.
#[tauri::command]
pub async fn lsp_choose_program(
    app: AppHandle,
    state: State<'_, Workspace>,
    trust: State<'_, Trust>,
    projects: State<'_, ProjectServers>,
    server: String,
    root: String,
    choice: String,
) -> Result<(), String> {
    require_trust(&app, &state, &trust)?;
    let spec = find(&server).ok_or_else(|| format!("No language server named {server}."))?;
    let folder = with_workspace(&state, |manager| manager.validate_path(&root))?;
    let workspace = with_workspace(&state, |manager| Ok(manager.root().to_path_buf()))?;
    let record = match choice.as_str() {
        "project" => {
            let resolved = resolve_program(
                spec.program,
                spec.node_package,
                &folder,
                std::env::var_os("PATH"),
            )
            .ok_or("The project's language server is no longer there.")?;
            // EXT-33 E0.3: the identity binds to the project artifact -- the code that actually
            // runs (the server program, or a workspace file it loads such as TypeScript's
            // `tsserver.js`) -- re-derived and hashed here, never named by the window.
            let artifact = project_artifact(spec, &workspace, &folder, &resolved)
                .ok_or("This project does not provide its own language server.")?;
            ProjectServerChoice {
                root: clean_path_str(&workspace),
                server: spec.id.into(),
                choice: "project".into(),
                program: Some(clean_path_str(&artifact)),
                sha256: Some(crate::extension_package::sha256_file(&artifact)?),
            }
        }
        "installed" => ProjectServerChoice {
            root: clean_path_str(&workspace),
            server: spec.id.into(),
            choice: "installed".into(),
            program: None,
            sha256: None,
        },
        other => {
            return Err(format!(
                "\"{other}\" is not a choice (project or installed)."
            ))
        }
    };
    let file = choices_file(&app)?;
    with_choices(&app, &projects, |choices| {
        choices.retain(|c| !(c.root == record.root && c.server == record.server));
        choices.push(record);
        ide_workspace::durable::write_json(&file, choices)
    })?
}

fn live(sessions: &LspSessions, session: u32) -> Result<Arc<ServerProcess>, String> {
    sessions
        .live
        .lock()
        .map_err(|e| e.to_string())?
        .get(&session)
        .cloned()
        .ok_or_else(|| "The language server has stopped.".to_string())
}

/// Sends one JSON-RPC message (the body; framing is added here).
#[tauri::command(async)]
pub fn lsp_send(
    sessions: State<'_, LspSessions>,
    session: u32,
    message: String,
) -> Result<(), String> {
    live(&sessions, session)?.send(&message)
}

/// Ends a server's process and everything it started. The renderer asks the server to shut
/// down first; this is the end of that, or what happens when it does not.
#[tauri::command(async)]
pub fn lsp_stop(sessions: State<'_, LspSessions>, session: u32) -> Result<(), String> {
    if let Ok(process) = live(&sessions, session) {
        process.stop();
    }
    Ok(())
}

/// Ends every server: the window is closing, or the workspace changing.
pub fn stop_all(sessions: &LspSessions) {
    let all: Vec<_> = match sessions.live.lock() {
        Ok(mut live) => live.drain().map(|(_, process)| process).collect(),
        Err(_) => return,
    };
    for process in all {
        process.stop();
    }
}

#[tauri::command(async)]
pub fn lsp_stop_all(sessions: State<'_, LspSessions>) -> Result<(), String> {
    stop_all(&sessions);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_listed_server_can_be_started() {
        // The allow-list is the security story, as for the checkers: no program can be named.
        assert!(find("typescript").is_some());
        assert!(find("rust-analyzer").is_some());
        for id in [
            "",
            "cmd",
            "bash -c",
            "typescript; rm -rf /",
            "../typescript",
        ] {
            assert!(find(id).is_none(), "{id}");
        }
    }

    #[test]
    fn every_server_has_a_fixed_command_line_and_a_registry_entry() {
        let registry = include_str!("../../src/services/lsp/registry.ts");
        for server in SERVERS {
            assert!(
                registry.contains(&format!("id: \"{}\"", server.id)),
                "no registry entry for {}",
                server.id
            );
            assert!(
                !server.program.contains(['/', '\\', ' ']),
                "{}",
                server.program
            );
            for argument in server.args {
                assert!(
                    !argument.is_empty() && !argument.contains(char::is_whitespace),
                    "{}: argument {argument:?} should be a single fixed token",
                    server.id
                );
            }
        }
    }
}

/// EXT-33 E0.1 (F-L1): a server the project provides runs only as the user chose it.
#[cfg(test)]
mod project_server_tests {
    use super::*;

    const SPEC: ServerSpec = ServerSpec {
        id: "probe",
        label: "Probe",
        program: "yavin-e01-probe-server",
        args: &[],
        node_package: true,
        delegate: None,
    };

    /// A server that, like TypeScript, auto-loads a file from the workspace.
    const DELEGATING: ServerSpec = ServerSpec {
        id: "probe-ts",
        label: "Probe TS",
        program: "yavin-e01-probe-server",
        args: &[],
        node_package: true,
        delegate: Some("node_modules/probe/lib/server.js"),
    };

    fn workspace(name: &str) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("yavin-e01-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let bin = root.join("node_modules").join(".bin");
        std::fs::create_dir_all(&bin).unwrap();
        let program = bin.join("yavin-e01-probe-server.cmd");
        std::fs::write(&program, "@rem the project's own server\r\n").unwrap();
        (root, program)
    }

    fn choice(root: &Path, kind: &str, program: Option<&Path>) -> ProjectServerChoice {
        // EXT-33 E0.3: the identity is the artifact's selected location (not canonicalised), so a
        // symlinked `node_modules/.bin` entry is keyed by where the project put it, not its target.
        ProjectServerChoice {
            root: clean_path_str(root),
            server: "probe".into(),
            choice: kind.into(),
            program: program.map(clean_path_str),
            sha256: program.map(|p| crate::extension_package::sha256_file(p).unwrap()),
        }
    }

    #[test]
    fn a_program_installed_elsewhere_runs_as_resolved() {
        let (root, _) = workspace("installed");
        let elsewhere = std::env::temp_dir().join("yavin-e01-elsewhere.exe");
        std::fs::write(&elsewhere, "").unwrap();
        let chosen = chosen_program(&[], &SPEC, &root, &root, elsewhere.clone(), None).unwrap();
        assert_eq!(
            chosen, elsewhere,
            "nothing to choose for a program outside the project"
        );
        let _ = std::fs::remove_file(elsewhere);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_project_server_is_refused_until_chosen_then_runs_only_while_unchanged() {
        let (root, program) = workspace("project");
        // Trusting the folder is not choosing its server: refused, saying which file.
        let refused = chosen_program(&[], &SPEC, &root, &root, program.clone(), None).unwrap_err();
        assert!(refused.starts_with(NEEDS_APPROVAL), "{refused}");
        assert!(refused.contains("yavin-e01-probe-server.cmd"), "{refused}");
        // Chosen: that very file runs (the selected path, as resolved).
        let chosen = [choice(&root, "project", Some(&program))];
        let ran = chosen_program(&chosen, &SPEC, &root, &root, program.clone(), None).unwrap();
        assert_eq!(ran, program);
        // Replaced after the choice: asked again, never run.
        std::fs::write(&program, "@rem replaced\r\n").unwrap();
        let changed =
            chosen_program(&chosen, &SPEC, &root, &root, program.clone(), None).unwrap_err();
        assert!(
            changed.starts_with(NEEDS_APPROVAL) && changed.contains("changed"),
            "{changed}"
        );
        // A choice for another workspace or another server does not apply here.
        let other_root = [choice(&std::env::temp_dir(), "project", Some(&program))];
        assert!(chosen_program(&other_root, &SPEC, &root, &root, program.clone(), None).is_err());
        let mut other_server = choice(&root, "project", Some(&program));
        other_server.server = "typescript".into();
        assert!(
            chosen_program(&[other_server], &SPEC, &root, &root, program.clone(), None).is_err()
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn choosing_the_installed_server_never_runs_the_projects() {
        let (root, program) = workspace("prefer-installed");
        let chosen = [choice(&root, "installed", None)];
        // Not on PATH in the test: not installed -- and never the project's file.
        match chosen_program(&chosen, &SPEC, &root, &root, program.clone(), None) {
            Ok(path) => assert_ne!(
                std::fs::canonicalize(&path).ok(),
                std::fs::canonicalize(&program).ok(),
                "the project's file ran"
            ),
            Err(error) => assert!(error.starts_with("not-installed:"), "{error}"),
        }
        let _ = std::fs::remove_dir_all(root);
    }

    /// EXT-33 E0.3 (V3): a workspace that ships its own `tsserver.js` but no `.bin` shim. The
    /// server program resolves to an installed one (outside the workspace), yet it would load the
    /// project's JavaScript, so it is refused until chosen -- keyed to that `.js` file, not the
    /// server program -- and a change to the `.js` asks again.
    #[test]
    fn a_server_that_loads_a_workspace_file_needs_a_choice_keyed_to_that_file() {
        let root = std::env::temp_dir().join(format!("yavin-e03-ts-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let lib = root.join("node_modules").join("probe").join("lib");
        std::fs::create_dir_all(&lib).unwrap();
        let tsserver = lib.join("server.js");
        std::fs::write(&tsserver, "// the project's own server code\n").unwrap();
        // The server program is installed elsewhere (outside the workspace), on `PATH` under the
        // name the spec resolves, so the "installed" choice can re-resolve it.
        let elsewhere = std::env::temp_dir().join(format!("yavin-e03-bin-{}", std::process::id()));
        std::fs::create_dir_all(&elsewhere).unwrap();
        let name = if cfg!(windows) {
            "yavin-e01-probe-server.cmd"
        } else {
            "yavin-e01-probe-server"
        };
        let installed = elsewhere.join(name);
        std::fs::write(&installed, "").unwrap();
        let path = Some(std::env::join_paths([&elsewhere]).unwrap());

        // Unchosen: refused, naming the `.js` the server would run -- not the installed program.
        let refused =
            chosen_program(&[], &DELEGATING, &root, &root, installed.clone(), None).unwrap_err();
        assert!(refused.starts_with(NEEDS_APPROVAL), "{refused}");
        // Keyed to the workspace `.js` the server loads, not the installed program's own path.
        assert!(refused.contains("server.js"), "{refused}");
        assert!(
            !refused.contains(&clean_path_str(&installed)),
            "names the js, not the installed program path: {refused}"
        );

        // Chosen "project": the installed program runs (it is what loads the approved `.js`).
        let chosen = ProjectServerChoice {
            root: clean_path_str(&root),
            server: "probe-ts".into(),
            choice: "project".into(),
            program: Some(clean_path_str(&tsserver)),
            sha256: Some(crate::extension_package::sha256_file(&tsserver).unwrap()),
        };
        let ran = chosen_program(
            std::slice::from_ref(&chosen),
            &DELEGATING,
            &root,
            &root,
            installed.clone(),
            None,
        )
        .unwrap();
        assert_eq!(
            ran, installed,
            "the entry program runs; the approved artifact is the .js"
        );

        // The `.js` changes after the choice: asked again.
        std::fs::write(&tsserver, "// swapped\n").unwrap();
        let changed = chosen_program(
            std::slice::from_ref(&chosen),
            &DELEGATING,
            &root,
            &root,
            installed.clone(),
            None,
        )
        .unwrap_err();
        assert!(
            changed.starts_with(NEEDS_APPROVAL) && changed.contains("changed"),
            "{changed}"
        );

        // Chosen "installed", but the installed server would STILL load the project's `.js`:
        // refused rather than run project code unchosen.
        let prefer = [ProjectServerChoice {
            root: clean_path_str(&root),
            server: "probe-ts".into(),
            choice: "installed".into(),
            program: None,
            sha256: None,
        }];
        let still = chosen_program(
            &prefer,
            &DELEGATING,
            &root,
            &root,
            installed.clone(),
            path.clone(),
        )
        .unwrap_err();
        assert!(
            still.starts_with(NEEDS_APPROVAL) && still.contains("would still run"),
            "{still}"
        );

        // With no workspace `.js`, the installed server is fine and runs as resolved from PATH.
        std::fs::remove_dir_all(root.join("node_modules")).unwrap();
        let ok =
            chosen_program(&prefer, &DELEGATING, &root, &root, installed.clone(), path).unwrap();
        assert_eq!(ok, installed);

        let _ = std::fs::remove_dir_all(elsewhere);
        let _ = std::fs::remove_dir_all(root);
    }

    /// EXT-33 E0.3 (V5): a `PATH` directory inside the workspace must not let "installed" run a
    /// program from the workspace without a choice.
    #[test]
    fn an_installed_path_inside_the_workspace_is_still_the_projects() {
        let root = std::env::temp_dir().join(format!("yavin-e03-pathin-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let tools = root.join("tools");
        std::fs::create_dir_all(&tools).unwrap();
        let name = if cfg!(windows) {
            "yavin-e01-probe-server.cmd"
        } else {
            "yavin-e01-probe-server"
        };
        let on_path = tools.join(name);
        std::fs::write(&on_path, "").unwrap();
        // The project also provides the server in node_modules/.bin, so a choice is required.
        let bin = root.join("node_modules").join(".bin");
        std::fs::create_dir_all(&bin).unwrap();
        let provided = bin.join(name);
        std::fs::write(&provided, "").unwrap();

        // "installed" re-resolves on PATH only -- but PATH here is a workspace folder, so that
        // program is itself the project's: refused, not run.
        let prefer = [choice(&root, "installed", None)];
        let path_var = Some(std::env::join_paths([&tools]).unwrap());
        // `resolved` is the project's `.bin` copy (what lsp_start would have found first).
        let refused =
            chosen_program(&prefer, &SPEC, &root, &root, provided.clone(), path_var).unwrap_err();
        assert!(
            refused.starts_with(NEEDS_APPROVAL) && refused.contains("would still run"),
            "a PATH entry inside the workspace must not run unchosen: {refused}"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    /// EXT-33 E0.3 (V6): a program selected from inside the workspace counts as the project's by
    /// its selected location, even if that location is a link -- `within_workspace` is lexical.
    #[test]
    fn a_program_selected_inside_the_workspace_is_the_projects_by_location() {
        let root = std::env::temp_dir().join(format!("yavin-e03-loc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let bin = root.join("node_modules").join(".bin");
        std::fs::create_dir_all(&bin).unwrap();
        let selected = bin.join("srv.cmd");
        // The selected location is inside the workspace: project-provided, whatever it points at.
        assert!(within_workspace(&root, &selected));
        assert_eq!(
            project_artifact(&SPEC, &root, &root, &selected),
            Some(selected.clone()),
            "keyed to the selected location, not a canonical target"
        );
        // A path wholly outside the workspace is not the project's.
        let outside = std::env::temp_dir().join("yavin-e03-outside.exe");
        assert!(!within_workspace(&root, &outside));
        assert_eq!(project_artifact(&SPEC, &root, &root, &outside), None);
        let _ = std::fs::remove_dir_all(root);
    }
}
