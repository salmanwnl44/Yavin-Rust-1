//! Yavin's extension host (IDE-08): runs extensions' JavaScript, and nothing else.
//!
//! ```text
//! Yavin (renderer: ExtensionHost, capabilities)  ⇄  native extension_host.rs  ⇄  this process
//!                                       Content-Length JSON frames on stdin/stdout
//!                                                       │
//!                         one QuickJS runtime + context per extension (bootstrap.js API)
//! ```
//!
//! Isolation, as it is:
//! - **Process.** One host process per workspace, started by Yavin, in the servers' Job Object:
//!   a crash or a runaway extension ends this process, not Yavin, and Yavin's exit ends it.
//! - **Engine.** QuickJS without its `std`/`os` modules: no filesystem, network, process, timers
//!   or native code exist in the language environment to call. The only way out is one function,
//!   `__yavin_send`, captured by the bootstrap before extension code runs; everything an
//!   extension wants is a message Yavin decides on.
//! - **Per extension.** Each extension has its own runtime (globals, memory limit) -- one
//!   extension cannot see another's objects.
//! - **Time and memory.** Every entry into an extension (loading it, each message) runs under a
//!   deadline enforced by QuickJS's interrupt handler, and each runtime has a memory limit.
//! - **Identity.** Every message an extension sends is stamped here with its real extension id,
//!   workspace and host generation, whatever the script put in it.
//!
//! What is not isolated: this is an OS process with the user's privileges. QuickJS confines the
//! script, not the process; a bug in QuickJS itself is a bug in that confinement. The OS process
//! is not sandboxed (no AppContainer or seccomp).

pub mod protocol;
mod runtime;

use ide_workspace::lsp_framing::{frame, FrameReader};
use protocol::{HostLimits, Inbound, MAX_MESSAGE};
use runtime::ExtensionRuntime;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};

/// The host's identity, from `init`: every later message must carry the same.
struct Identity {
    workspace_id: String,
    generation: u64,
    workspace_folder: Option<String>,
    api_version: String,
    limits: HostLimits,
}

/// Writes one message, bounded: an oversized one is replaced by an error saying so.
fn write(out: &mut impl Write, message: &Value) {
    let mut text = message.to_string();
    if text.len() > MAX_MESSAGE {
        text = json!({
            "type": "error",
            "extensionId": message.get("extensionId"),
            "workspaceId": message.get("workspaceId"),
            "hostGeneration": message.get("hostGeneration"),
            "error": {"code": "MessageTooLarge", "message": format!("A message of {} bytes was not sent (the limit is {}).", text.len(), MAX_MESSAGE)},
        })
        .to_string();
    }
    let _ = out.write_all(&frame(&text));
    let _ = out.flush();
}

/// Runs the host on `input`/`output` until `shutdown` or end of input. Returns the exit code.
pub fn run(mut input: impl Read, mut output: impl Write) -> i32 {
    let mut reader = FrameReader::default();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut identity: Option<Identity> = None;
    let mut extensions: HashMap<String, ExtensionRuntime> = HashMap::new();
    loop {
        let count = match input.read(&mut buffer) {
            Ok(0) | Err(_) => return 0,
            Ok(count) => count,
        };
        let messages = match reader.push(&buffer[..count]) {
            Ok(messages) => messages,
            // The stream cannot be resynchronized: the host ends, and Yavin sees it end.
            Err(_) => return 2,
        };
        for text in messages {
            let inbound = match protocol::parse(&text) {
                Ok(inbound) => inbound,
                Err(reason) => {
                    write(
                        &mut output,
                        &json!({"type": "error", "error": {"code": "MalformedMessage", "message": reason}}),
                    );
                    continue;
                }
            };
            match inbound {
                Inbound::Init {
                    workspace_id,
                    generation,
                    workspace_folder,
                    api_version,
                    limits,
                } => {
                    if identity.is_some() {
                        write(
                            &mut output,
                            &json!({"type": "error", "error": {"code": "AlreadyInitialized", "message": "init was sent twice"}}),
                        );
                        continue;
                    }
                    identity = Some(Identity {
                        workspace_id,
                        generation,
                        workspace_folder,
                        api_version,
                        limits,
                    });
                    write(&mut output, &json!({"type": "ready"}));
                }
                Inbound::Shutdown => return 0,
                Inbound::ToExtension {
                    workspace_id,
                    generation,
                    extension_id,
                    kind,
                    message,
                } => {
                    let Some(host) = identity.as_ref() else {
                        write(
                            &mut output,
                            &json!({"type": "error", "error": {"code": "NotInitialized", "message": "init comes first"}}),
                        );
                        continue;
                    };
                    // A message for another workspace or an earlier host is never applied.
                    if workspace_id != host.workspace_id || generation != host.generation {
                        write(
                            &mut output,
                            &json!({"type": "error", "extensionId": extension_id, "error": {"code": "StaleGeneration", "message": "This message is for another workspace or host generation."}}),
                        );
                        continue;
                    }
                    let stamp = |mut message: Value| {
                        if let Some(object) = message.as_object_mut() {
                            object.insert("extensionId".into(), json!(extension_id));
                            object.insert("workspaceId".into(), json!(host.workspace_id));
                            object.insert("hostGeneration".into(), json!(host.generation));
                        }
                        message
                    };
                    match kind.as_str() {
                        "load" => {
                            let code = message.get("code").and_then(Value::as_str).unwrap_or("");
                            let extension_path = message
                                .get("extensionPath")
                                .and_then(Value::as_str)
                                .map(str::to_string);
                            let created = ExtensionRuntime::load(
                                &extension_id,
                                &host.workspace_id,
                                host.generation,
                                host.workspace_folder.as_deref(),
                                extension_path.as_deref(),
                                &host.api_version,
                                code,
                                &host.limits,
                            );
                            match created {
                                Ok((runtime, sent)) => {
                                    for outgoing in sent {
                                        write(&mut output, &stamp(outgoing));
                                    }
                                    extensions.insert(extension_id.clone(), runtime);
                                    write(&mut output, &stamp(json!({"type": "loaded"})));
                                }
                                Err(error) => write(
                                    &mut output,
                                    &stamp(json!({"type": "error", "error": error})),
                                ),
                            }
                        }
                        "unload" => {
                            extensions.remove(&extension_id);
                            write(&mut output, &stamp(json!({"type": "unloaded"})));
                        }
                        _ => {
                            let Some(runtime) = extensions.get_mut(&extension_id) else {
                                // A request needs an answer: Yavin's waiting caller is told.
                                let request_id = message.get("requestId").cloned();
                                write(
                                    &mut output,
                                    &stamp(
                                        json!({"type": "response", "requestId": request_id, "ok": false, "error": {"code": "NotLoaded", "message": "The extension is not loaded in this host."}}),
                                    ),
                                );
                                continue;
                            };
                            for outgoing in runtime.deliver(&message, &host.limits) {
                                write(&mut output, &stamp(outgoing));
                            }
                        }
                    }
                }
            }
        }
    }
}
