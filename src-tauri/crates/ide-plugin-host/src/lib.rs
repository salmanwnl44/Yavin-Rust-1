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
//! - **Engine.** QuickJS without its `std`/`os` modules: no filesystem, network, process or
//!   native code exist in the language environment to call. Timers (EXT-25) are kept by this
//!   process (`runtime.rs`): each fires as an entry of its own, under the same deadline. The only way out is one function,
//!   `__yavin_send`, captured by the bootstrap before extension code runs; everything an
//!   extension wants is a message Yavin decides on.
//! - **Per extension.** Each extension has its own runtime (globals, memory limit) -- one
//!   extension cannot see another's objects.
//! - **Time and memory.** Every entry into an extension (loading it, each message) runs under a
//!   deadline enforced by QuickJS's interrupt handler, and each runtime has a memory limit.
//! - **Identity.** Every message an extension sends is stamped here with its real extension id,
//!   workspace and host generation, whatever the script put in it.
//!
//! - **Watchdog.** An entry still running at twice its deadline plus a second -- code QuickJS
//!   could not interrupt -- ends this process (`watchdog`, EXT-10).
//! - **Workers (EXT-32).** An extension's `new Worker(...)` is a runtime of its own, owned by
//!   that extension's (`worker`): it speaks only to its extension, and each entry into it is one
//!   step between the extensions' own, under the same deadline and watchdog (`pump`).
//!
//! **The OS sandbox (EXT-10).** Yavin starts this process in a Windows AppContainer with no
//! capabilities, in a job of its own (`ide_workspace::sandbox`): no file but its program and the
//! system's, no network, no child process, memory and CPU capped. It needs none of them: its
//! input is stdin (extension code included, read by Yavin), its output stdout and stderr. A bug
//! in QuickJS would still be a bug in the script's confinement -- inside that sandbox.

pub mod protocol;
mod runtime;
pub mod watchdog;
mod worker;

use ide_workspace::lsp_framing::{frame, FrameReader};
use protocol::{HostLimits, Inbound, MAX_MESSAGE};
use runtime::{ExtensionRuntime, VscodeCode};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::time::Instant;

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

/// Stamps what an extension sent with its identity, as every message from the host is.
fn stamped(mut message: Value, extension_id: &str, host: &Identity) -> Value {
    if let Some(object) = message.as_object_mut() {
        object.insert("extensionId".into(), json!(extension_id));
        object.insert("workspaceId".into(), json!(host.workspace_id));
        object.insert("hostGeneration".into(), json!(host.generation));
    }
    message
}

/// The most worker steps (`ExtensionRuntime::pump_step`) in one turn of the loop, and the time
/// they may take, before it reads its input and fires its timers again: a busy worker shares
/// the host, it does not hold it.
const MAX_WORKER_STEPS: usize = 256;
const MAX_WORKER_TURN: std::time::Duration = std::time::Duration::from_millis(50);

/// EXT-32: the extensions' workers' work -- each step one entry, under the watchdog, each
/// extension in turn -- until there is none, or the turn's steps are spent.
fn pump(
    extensions: &mut HashMap<String, ExtensionRuntime>,
    host: &Identity,
    watchdog: &watchdog::Watchdog,
    output: &mut impl Write,
) {
    let mut ids: Vec<String> = extensions.keys().cloned().collect();
    ids.sort();
    let mut steps = 0;
    let started = Instant::now();
    loop {
        let mut worked = false;
        for id in &ids {
            let running: usize = extensions
                .values()
                .map(ExtensionRuntime::worker_count)
                .sum();
            let capacity = worker::MAX_HOST_WORKERS.saturating_sub(running);
            let Some(runtime) = extensions.get_mut(id) else {
                continue;
            };
            // A start runs the worker's script under the load deadline; anything else, the call's.
            watchdog.enter(host.limits.load_ms.max(host.limits.call_ms));
            let sent = runtime.pump_step(&host.limits, capacity);
            watchdog.leave();
            let Some(sent) = sent else {
                continue;
            };
            worked = true;
            steps += 1;
            for outgoing in sent {
                write(output, &stamped(outgoing, id, host));
            }
            if steps >= MAX_WORKER_STEPS || started.elapsed() >= MAX_WORKER_TURN {
                return;
            }
        }
        if !worked {
            return;
        }
    }
}

/// Input as it arrives: framed messages, the end of input, or a stream that cannot be read.
enum Input {
    Messages(Vec<String>),
    End,
    Broken,
}

/// Runs the host on `input`/`output` until `shutdown` or end of input. Returns the exit code.
pub fn run(mut input: impl Read + Send + 'static, mut output: impl Write) -> i32 {
    // Input is read on a thread of its own, so the loop can wake for a timer that is due.
    let (sender, inbox) = channel();
    std::thread::spawn(move || {
        let mut reader = FrameReader::default();
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            let next = match input.read(&mut buffer) {
                Ok(0) | Err(_) => Input::End,
                Ok(count) => match reader.push(&buffer[..count]) {
                    Ok(messages) => Input::Messages(messages),
                    // The stream cannot be resynchronized: the host ends, and Yavin sees it end.
                    Err(_) => Input::Broken,
                },
            };
            let last = !matches!(next, Input::Messages(_));
            if sender.send(next).is_err() || last {
                return;
            }
        }
    });
    let mut identity: Option<Identity> = None;
    let mut extensions: HashMap<String, ExtensionRuntime> = HashMap::new();
    let watchdog = watchdog::Watchdog::start();
    loop {
        let due = extensions
            .values()
            .filter_map(ExtensionRuntime::next_due)
            .min();
        let next = match due {
            Some(due) => inbox.recv_timeout(due.saturating_duration_since(Instant::now())),
            None => inbox.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };
        let messages = match next {
            Ok(Input::Messages(messages)) => messages,
            Ok(Input::End) | Err(RecvTimeoutError::Disconnected) => return 0,
            Ok(Input::Broken) => return 2,
            Err(RecvTimeoutError::Timeout) => {
                // Timers that are due, each extension's in turn.
                if let Some(host) = identity.as_ref() {
                    let now = Instant::now();
                    let mut ids: Vec<String> = extensions.keys().cloned().collect();
                    ids.sort();
                    for id in ids {
                        let Some(runtime) = extensions.get_mut(&id) else {
                            continue;
                        };
                        if runtime.next_due().is_none_or(|due| due > now) {
                            continue;
                        }
                        watchdog.enter(host.limits.call_ms);
                        let sent = runtime.fire_due(now, &host.limits);
                        watchdog.leave();
                        for mut outgoing in sent {
                            if let Some(object) = outgoing.as_object_mut() {
                                object.insert("extensionId".into(), json!(id));
                                object.insert("workspaceId".into(), json!(host.workspace_id));
                                object.insert("hostGeneration".into(), json!(host.generation));
                            }
                            write(&mut output, &outgoing);
                        }
                    }
                    pump(&mut extensions, host, &watchdog, &mut output);
                }
                continue;
            }
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
                            let vscode = match (
                                message.get("modules"),
                                message.get("vscode"),
                                message.get("main").and_then(Value::as_str),
                            ) {
                                (Some(modules), Some(runtime), Some(main))
                                    if modules.is_object() && runtime.is_object() =>
                                {
                                    Some(VscodeCode {
                                        modules,
                                        runtime,
                                        main,
                                    })
                                }
                                _ => None,
                            };
                            watchdog.enter(host.limits.load_ms);
                            let created = ExtensionRuntime::load(
                                &extension_id,
                                &host.workspace_id,
                                host.generation,
                                host.workspace_folder.as_deref(),
                                extension_path.as_deref(),
                                &host.api_version,
                                code,
                                vscode,
                                &host.limits,
                            );
                            watchdog.leave();
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
                            watchdog.enter(host.limits.call_ms);
                            let sent = runtime.deliver(&message, &host.limits);
                            watchdog.leave();
                            for outgoing in sent {
                                write(&mut output, &stamp(outgoing));
                            }
                        }
                    }
                }
            }
        }
        // What the messages set going in workers.
        if let Some(host) = identity.as_ref() {
            pump(&mut extensions, host, &watchdog, &mut output);
        }
    }
}
