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
use ide_workspace::lsp_process::{resolve_program, ServerEvents, ServerProcess};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

/// A server Yavin knows how to start: its program and exact arguments.
struct ServerSpec {
    /// The id the renderer's registry (`src/services/lsp/registry.ts`) uses.
    id: &'static str,
    label: &'static str,
    program: &'static str,
    args: &'static [&'static str],
    /// Installed with npm, so a project may pin its own version in `node_modules/.bin`.
    node_package: bool,
}

const SERVERS: &[ServerSpec] = &[
    ServerSpec {
        id: "typescript",
        label: "TypeScript",
        program: "typescript-language-server",
        args: &["--stdio"],
        node_package: true,
    },
    ServerSpec {
        id: "pyright",
        label: "Pyright",
        program: "pyright-langserver",
        args: &["--stdio"],
        node_package: true,
    },
    ServerSpec {
        id: "pylsp",
        label: "Python LSP",
        program: "pylsp",
        args: &[],
        node_package: false,
    },
    ServerSpec {
        id: "rust-analyzer",
        label: "rust-analyzer",
        program: "rust-analyzer",
        args: &[],
        node_package: false,
    },
    ServerSpec {
        id: "gopls",
        label: "gopls",
        program: "gopls",
        args: &[],
        node_package: false,
    },
    ServerSpec {
        id: "clangd",
        label: "clangd",
        program: "clangd",
        args: &[],
        node_package: false,
    },
    ServerSpec {
        id: "json",
        label: "JSON",
        program: "vscode-json-language-server",
        args: &["--stdio"],
        node_package: true,
    },
    ServerSpec {
        id: "css",
        label: "CSS",
        program: "vscode-css-language-server",
        args: &["--stdio"],
        node_package: true,
    },
    ServerSpec {
        id: "html",
        label: "HTML",
        program: "vscode-html-language-server",
        args: &["--stdio"],
        node_package: true,
    },
    ServerSpec {
        id: "yaml",
        label: "YAML",
        program: "yaml-language-server",
        args: &["--stdio"],
        node_package: true,
    },
    ServerSpec {
        id: "bash",
        label: "Bash",
        program: "bash-language-server",
        args: &["start"],
        node_package: true,
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
#[tauri::command]
pub async fn lsp_start(
    app: AppHandle,
    state: State<'_, Workspace>,
    trust: State<'_, Trust>,
    sessions: State<'_, LspSessions>,
    server: String,
    root: String,
) -> Result<Started, String> {
    require_trust(&app, &state, &trust)?;
    let spec = find(&server).ok_or_else(|| format!("No language server named {server}."))?;
    let folder = with_workspace(&state, |manager| manager.validate_path(&root))?;
    if !folder.is_dir() {
        return Err(format!("{root} is not a folder."));
    }
    let program = resolve_program(
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
