//! One extension in the host: its own QuickJS runtime and context, the bootstrap API, and the
//! one function out (`__yavin_send`), with a deadline on every entry and a memory limit.

use crate::protocol::HostLimits;
use rquickjs::{Context, Ctx, Function, Persistent, Runtime};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::{Duration, Instant};

const BOOTSTRAP: &str = include_str!("bootstrap.js");
/// Messages one extension may send in answer to one entry: a loop that sends forever is cut off.
const MAX_OUTGOING: usize = 1000;

/// Fields drop in order: what lives in the runtime (the saved function, the context) before
/// the runtime itself -- QuickJS refuses to free a runtime with objects still held.
pub struct ExtensionRuntime {
    receive: Persistent<Function<'static>>,
    context: Context,
    runtime: Runtime,
    deadline: Rc<Cell<Option<Instant>>>,
    outbox: Rc<RefCell<Vec<Value>>>,
}

fn error(code: &str, message: impl Into<String>) -> Value {
    json!({"code": code, "message": message.into()})
}

/// What QuickJS threw, as text (the exception is taken from the context).
fn thrown(ctx: &Ctx<'_>, error: rquickjs::Error) -> String {
    if let rquickjs::Error::Exception = error {
        let value = ctx.catch();
        if let Some(object) = value.as_object() {
            let message: Option<String> = object.get("message").ok();
            if let Some(message) = message {
                return message;
            }
        }
        if let Some(text) = value.as_string().and_then(|s| s.to_string().ok()) {
            return text;
        }
        return "an exception (or the call ran out of time or memory)".into();
    }
    error.to_string()
}

impl ExtensionRuntime {
    /// A runtime with the API, and the extension's code evaluated in it (not yet activated).
    #[allow(clippy::too_many_arguments)]
    pub fn load(
        extension_id: &str,
        workspace_id: &str,
        generation: u64,
        workspace_folder: Option<&str>,
        extension_path: Option<&str>,
        api_version: &str,
        code: &str,
        limits: &HostLimits,
    ) -> Result<(ExtensionRuntime, Vec<Value>), Value> {
        let runtime = Runtime::new().map_err(|e| error("HostFailed", e.to_string()))?;
        runtime.set_memory_limit(limits.memory_bytes);
        let deadline: Rc<Cell<Option<Instant>>> = Rc::new(Cell::new(None));
        let watched = deadline.clone();
        runtime.set_interrupt_handler(Some(Box::new(move || {
            watched.get().is_some_and(|until| Instant::now() > until)
        })));
        let context = Context::full(&runtime).map_err(|e| error("HostFailed", e.to_string()))?;
        let outbox: Rc<RefCell<Vec<Value>>> = Rc::new(RefCell::new(Vec::new()));
        let init = json!({
            "extensionId": extension_id,
            "workspaceId": workspace_id,
            "hostGeneration": generation,
            "workspaceFolder": workspace_folder,
            "extensionPath": extension_path,
            "apiVersion": api_version,
        });
        let bootstrap = BOOTSTRAP.replace("__YAVIN_INIT__", &init.to_string());
        deadline.set(Some(Instant::now() + Duration::from_millis(limits.load_ms)));
        let loaded = context.with(|ctx| -> Result<Persistent<Function<'static>>, Value> {
            let sink = outbox.clone();
            let send = Function::new(ctx.clone(), move |text: String| {
                let mut queue = sink.borrow_mut();
                if queue.len() < MAX_OUTGOING {
                    if let Ok(value) = serde_json::from_str::<Value>(&text) {
                        queue.push(value);
                    }
                }
            })
            .map_err(|e| error("HostFailed", e.to_string()))?;
            ctx.globals()
                .set("__yavin_send", send)
                .map_err(|e| error("HostFailed", e.to_string()))?;
            ctx.eval::<(), _>(bootstrap.as_str())
                .map_err(|e| error("HostFailed", thrown(&ctx, e)))?;
            // Taken now, before the extension's code runs: it cannot replace them.
            let receive: Function = ctx
                .globals()
                .get("__yavin_receive")
                .map_err(|e| error("HostFailed", e.to_string()))?;
            let load: Function = ctx
                .globals()
                .get("__yavin_load")
                .map_err(|e| error("HostFailed", e.to_string()))?;
            load.call::<_, ()>((code,))
                .map_err(|e| error("LoadFailed", thrown(&ctx, e)))?;
            Ok(Persistent::save(&ctx, receive))
        });
        deadline.set(None);
        let receive = loaded?;
        let mut runtime = ExtensionRuntime {
            receive,
            context,
            runtime,
            deadline,
            outbox,
        };
        let sent = runtime.drain(limits);
        Ok((runtime, sent))
    }

    /// Gives the extension one message and runs what it starts (its promise jobs) under the
    /// call deadline. Returns what it sent.
    pub fn deliver(&mut self, message: &Value, limits: &HostLimits) -> Vec<Value> {
        self.deadline
            .set(Some(Instant::now() + Duration::from_millis(limits.call_ms)));
        let text = message.to_string();
        let failed = self.context.with(|ctx| {
            let receive = self.receive.clone().restore(&ctx).ok()?;
            match receive.call::<_, ()>((text,)) {
                Ok(()) => None,
                Err(e) => Some(thrown(&ctx, e)),
            }
        });
        let mut sent = self.drain(limits);
        if let Some(reason) = failed {
            // The entry itself failed (a timeout, out of memory): a waiting request is answered.
            if let Some(request_id) = message
                .get("requestId")
                .filter(|_| message.get("type") == Some(&json!("request")))
            {
                sent.push(json!({"type": "response", "requestId": request_id, "ok": false, "error": error("ExtensionFailed", reason)}));
            } else {
                sent.push(json!({"type": "error", "error": error("ExtensionFailed", reason)}));
            }
        }
        self.deadline.set(None);
        sent
    }

    /// Runs pending promise jobs within the current deadline, then takes the outbox.
    fn drain(&mut self, limits: &HostLimits) -> Vec<Value> {
        if self.deadline.get().is_none() {
            self.deadline
                .set(Some(Instant::now() + Duration::from_millis(limits.call_ms)));
        }
        let mut jobs = 0;
        while self.runtime.is_job_pending() && jobs < 100_000 {
            jobs += 1;
            match self.runtime.execute_pending_job() {
                Ok(true) => {}
                Ok(false) => break,
                Err(_) => {
                    if self
                        .deadline
                        .get()
                        .is_some_and(|until| Instant::now() > until)
                    {
                        self.outbox.borrow_mut().push(json!({"type": "error", "error": error("Timeout", "The extension ran past its time limit.")}));
                        break;
                    }
                }
            }
        }
        std::mem::take(&mut *self.outbox.borrow_mut())
    }
}
