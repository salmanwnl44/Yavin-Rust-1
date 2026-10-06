//! The host's side of the extension protocol (IDE-08). Messages are JSON objects in
//! Content-Length frames. Yavin → host:
//!
//! - `{"type":"init","workspaceId","hostGeneration","workspaceFolder","apiVersion","limits"}` -- once.
//! - `{"type":"load"|"unload","extensionId","workspaceId","hostGeneration",...}`
//! - `{"type":"request"|"response"|"event","extensionId","workspaceId","hostGeneration",...}`
//! - `{"type":"shutdown"}`
//!
//! Host → Yavin: `ready`, `loaded`, `unloaded`, `request`, `response`, `log`, `error` -- each
//! carrying the extension's id, workspace and generation (stamped by the host).

use serde_json::Value;

/// The largest message either way (Yavin enforces the same).
pub const MAX_MESSAGE: usize = 1024 * 1024;

#[derive(Clone, Debug)]
pub struct HostLimits {
    /// Memory each extension's runtime may use.
    pub memory_bytes: usize,
    /// How long loading an extension may run.
    pub load_ms: u64,
    /// How long any one entry into an extension (a message, its promise jobs) may run.
    pub call_ms: u64,
}

impl Default for HostLimits {
    fn default() -> Self {
        HostLimits {
            memory_bytes: 64 * 1024 * 1024,
            load_ms: 5_000,
            call_ms: 2_000,
        }
    }
}

pub enum Inbound {
    Init {
        workspace_id: String,
        generation: u64,
        workspace_folder: Option<String>,
        api_version: String,
        limits: HostLimits,
    },
    Shutdown,
    ToExtension {
        workspace_id: String,
        generation: u64,
        extension_id: String,
        kind: String,
        message: Value,
    },
}

/// `publisher.name`, lower case: the same rule as the renderer's manifest.
pub fn valid_extension_id(id: &str) -> bool {
    let Some((publisher, name)) = id.split_once('.') else {
        return false;
    };
    let part = |text: &str| {
        !text.is_empty()
            && text.len() <= 50
            && text
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            && !text.starts_with('-')
    };
    part(publisher) && part(name)
}

pub fn parse(text: &str) -> Result<Inbound, String> {
    if text.len() > MAX_MESSAGE {
        return Err(format!(
            "a message of {} bytes is over the limit",
            text.len()
        ));
    }
    let message: Value = serde_json::from_str(text).map_err(|e| format!("not JSON: {e}"))?;
    let kind = message
        .get("type")
        .and_then(Value::as_str)
        .ok_or("no type")?
        .to_string();
    let string = |name: &str| {
        message
            .get(name)
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or(format!("no {name}"))
    };
    let generation = || {
        message
            .get("hostGeneration")
            .and_then(Value::as_u64)
            .ok_or("no hostGeneration".to_string())
    };
    match kind.as_str() {
        "init" => {
            let limits = message.get("limits");
            let number = |name: &str, default: u64, max: u64| {
                limits
                    .and_then(|l| l.get(name))
                    .and_then(Value::as_u64)
                    .unwrap_or(default)
                    .min(max)
            };
            let defaults = HostLimits::default();
            Ok(Inbound::Init {
                workspace_id: string("workspaceId")?,
                generation: generation()?,
                workspace_folder: message
                    .get("workspaceFolder")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                api_version: string("apiVersion")?,
                limits: HostLimits {
                    memory_bytes: number("memoryBytes", defaults.memory_bytes as u64, 512 << 20)
                        as usize,
                    load_ms: number("loadMs", defaults.load_ms, 60_000),
                    call_ms: number("callMs", defaults.call_ms, 60_000),
                },
            })
        }
        "shutdown" => Ok(Inbound::Shutdown),
        "load" | "unload" | "request" | "response" | "event" => {
            let extension_id = string("extensionId")?;
            if !valid_extension_id(&extension_id) {
                return Err(format!("\"{extension_id}\" is not an extension id"));
            }
            Ok(Inbound::ToExtension {
                workspace_id: string("workspaceId")?,
                generation: generation()?,
                extension_id,
                kind,
                message,
            })
        }
        other => Err(format!("unknown message type \"{other}\"")),
    }
}
