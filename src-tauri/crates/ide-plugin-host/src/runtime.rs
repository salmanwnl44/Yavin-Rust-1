//! One extension in the host: its own QuickJS runtime and context, the bootstrap API, and the
//! one function out (`__yavin_send`), with a deadline on every entry and a memory limit.
//!
//! **Timers** (EXT-25): `setTimeout` and `setInterval` are kept here, not in the script -- at most
//! `MAX_TIMERS` per extension, an interval at least `MIN_INTERVAL_MS` -- and fire as entries of
//! their own (`fire_due`), under the same deadline as any message. Nothing waits in the script.

use crate::protocol::HostLimits;
use crate::worker::{FromWorker, Worker, WorkerRequest, WorkerRequests};
use rquickjs::{Context, Ctx, Function, Persistent, Runtime};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, VecDeque};
use std::rc::Rc;
use std::time::{Duration, Instant};

const BOOTSTRAP: &str = include_str!("bootstrap.js");
/// The VS Code compatibility layer (EXT-25), part of the bootstrap: used only by an extension
/// Yavin loads as a VS Code extension.
const VSCODE: &str = include_str!("vscode.js");
/// The Web platform globals and the Intl subset the layer installs (EXT-28).
const WEB: &str = include_str!("web.js");
const INTL: &str = include_str!("intl.js");
/// The most random bytes one call may ask for (Web Crypto's `getRandomValues` limit).
pub const MAX_RANDOM: usize = 65_536;
/// The most unhandled promise rejections said after one entry (the rest are counted).
const MAX_REJECTIONS: usize = 10;
/// The deepest stack one extension's script may use (its thread has far more, `main.rs`).
pub const MAX_STACK: usize = 8 * 1024 * 1024;
/// The most timers one extension may have waiting.
pub const MAX_TIMERS: usize = 1000;
/// The shortest repeat of an interval.
pub const MIN_INTERVAL_MS: u64 = 10;
/// The longest delay a timer may have (as a browser's: about 24.8 days).
const MAX_DELAY_MS: f64 = 2_147_483_647.0;

struct Timer {
    due: Instant,
    every: Option<Duration>,
}
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
    timers: Rc<RefCell<BTreeMap<u32, Timer>>>,
    /// Promises rejected with no handler yet (EXT-28), and why: said after the entry's jobs.
    rejected: Rejected,
    /// Its workers (EXT-32, `worker.rs`): what it asked of them, and those running.
    requests: Rc<RefCell<WorkerRequests>>,
    workers: BTreeMap<u32, Worker>,
    /// What it is to hear of its workers ending, not yet given it.
    notices: VecDeque<Value>,
    /// The worker served last, so each is served in turn.
    turn: u32,
}

type Rejected = Rc<RefCell<Vec<(Persistent<rquickjs::Value<'static>>, String)>>>;

impl Drop for ExtensionRuntime {
    fn drop(&mut self) {
        // The saved promises are released while their runtime is still alive.
        self.rejected.borrow_mut().clear();
    }
}

/// What a VS Code extension is loaded with (EXT-25): the modules its code may `require` (JSON:
/// path → source), the compatibility layer's mapping, and its entry point's path.
pub struct VscodeCode<'a> {
    pub modules: &'a Value,
    pub runtime: &'a Value,
    pub main: &'a str,
}

fn error(code: &str, message: impl Into<String>) -> Value {
    json!({"code": code, "message": message.into()})
}

/// What QuickJS threw, as text (the exception is taken from the context).
fn thrown(ctx: &Ctx<'_>, error: rquickjs::Error) -> String {
    thrown_with_stack(ctx, error).0
}

/// What QuickJS threw, and where (its first stack lines, EXT-25: why a load failed, for the
/// extension's page and the benchmark).
fn thrown_with_stack(ctx: &Ctx<'_>, error: rquickjs::Error) -> (String, Option<String>) {
    if let rquickjs::Error::Exception = error {
        let value = ctx.catch();
        if let Some(object) = value.as_object() {
            let message: Option<String> = object.get("message").ok();
            let stack: Option<String> = object.get("stack").ok();
            let stack = stack.map(|s| {
                s.lines().take(6).collect::<Vec<_>>().join(
                    "
",
                )
            });
            if let Some(message) = message {
                return (message, stack);
            }
        }
        if let Some(text) = value.as_string().and_then(|s| s.to_string().ok()) {
            return (text, None);
        }
        return (
            "an exception (or the call ran out of time or memory)".into(),
            None,
        );
    }
    (error.to_string(), None)
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
        vscode: Option<VscodeCode<'_>>,
        limits: &HostLimits,
    ) -> Result<(ExtensionRuntime, Vec<Value>), Value> {
        let runtime = Runtime::new().map_err(|e| error("HostFailed", e.to_string()))?;
        runtime.set_memory_limit(limits.memory_bytes);
        runtime.set_max_stack_size(MAX_STACK);
        let deadline: Rc<Cell<Option<Instant>>> = Rc::new(Cell::new(None));
        let watched = deadline.clone();
        runtime.set_interrupt_handler(Some(Box::new(move || {
            watched.get().is_some_and(|until| Instant::now() > until)
        })));
        let context = Context::full(&runtime).map_err(|e| error("HostFailed", e.to_string()))?;
        // A rejection with no handler is noted; one handled later (in the same entry) is let go.
        let rejected: Rejected = Rc::new(RefCell::new(Vec::new()));
        let tracked = rejected.clone();
        runtime.set_host_promise_rejection_tracker(Some(Box::new(
            move |ctx, promise, reason, handled| {
                let mut list = tracked.borrow_mut();
                if handled {
                    list.retain(|(saved, _)| {
                        saved
                            .clone()
                            .restore(&ctx)
                            .map(|p| p != promise)
                            .unwrap_or(false)
                    });
                } else if list.len() <= MAX_REJECTIONS * 10 {
                    list.push((Persistent::save(&ctx, promise), describe(&reason)));
                }
            },
        )));
        let outbox: Rc<RefCell<Vec<Value>>> = Rc::new(RefCell::new(Vec::new()));
        let init = json!({
            "extensionId": extension_id,
            "workspaceId": workspace_id,
            "hostGeneration": generation,
            "workspaceFolder": workspace_folder,
            "extensionPath": extension_path,
            "apiVersion": api_version,
            "runtime": if vscode.is_some() { "vscode" } else { "yavin" },
        });
        let bootstrap = BOOTSTRAP
            .replace("/*__YAVIN_VSCODE__*/", &format!("{WEB}\n{INTL}\n{VSCODE}"))
            .replace("__YAVIN_INIT__", &init.to_string());
        let timers: Rc<RefCell<BTreeMap<u32, Timer>>> = Rc::new(RefCell::new(BTreeMap::new()));
        let requests: Rc<RefCell<WorkerRequests>> =
            Rc::new(RefCell::new(WorkerRequests::default()));
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
            let waiting = timers.clone();
            let set_timer =
                Function::new(ctx.clone(), move |id: u32, ms: f64, repeat: bool| -> bool {
                    let mut waiting = waiting.borrow_mut();
                    if waiting.len() >= MAX_TIMERS && !waiting.contains_key(&id) {
                        return false;
                    }
                    let ms = if ms.is_finite() {
                        ms.clamp(0.0, MAX_DELAY_MS)
                    } else {
                        0.0
                    } as u64;
                    let every = repeat.then(|| Duration::from_millis(ms.max(MIN_INTERVAL_MS)));
                    let delay = every.unwrap_or(Duration::from_millis(ms));
                    waiting.insert(
                        id,
                        Timer {
                            due: Instant::now() + delay,
                            every,
                        },
                    );
                    true
                })
                .map_err(|e| error("HostFailed", e.to_string()))?;
            let cleared = timers.clone();
            let clear_timer = Function::new(ctx.clone(), move |id: u32| {
                cleared.borrow_mut().remove(&id);
            })
            .map_err(|e| error("HostFailed", e.to_string()))?;
            ctx.globals()
                .set("__yavin_timer", set_timer)
                .map_err(|e| error("HostFailed", e.to_string()))?;
            ctx.globals()
                .set("__yavin_untimer", clear_timer)
                .map_err(|e| error("HostFailed", e.to_string()))?;
            // Random bytes from the operating system (EXT-28: `crypto`), as hex; nothing if
            // more are asked for than one call may have, or if the system's source fails.
            let random = Function::new(ctx.clone(), |n: u32| -> Option<String> {
                let n = n as usize;
                if n > MAX_RANDOM {
                    return None;
                }
                let mut bytes = vec![0u8; n];
                getrandom::fill(&mut bytes).ok()?;
                Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
            })
            .map_err(|e| error("HostFailed", e.to_string()))?;
            ctx.globals()
                .set("__yavin_random", random)
                .map_err(|e| error("HostFailed", e.to_string()))?;
            // EXT-32: its workers -- asked for here, done by the host between entries
            // (`pump_step`); each answers why not, or nothing.
            let asked = requests.clone();
            let start_worker = Function::new(
                ctx.clone(),
                move |id: u32, source: String, url: String, name: String| -> Option<String> {
                    asked.borrow_mut().start(id, source, url, name)
                },
            )
            .map_err(|e| error("HostFailed", e.to_string()))?;
            let asked = requests.clone();
            let post_worker = Function::new(
                ctx.clone(),
                move |id: u32, data: String| -> Option<String> {
                    asked.borrow_mut().post(id, data)
                },
            )
            .map_err(|e| error("HostFailed", e.to_string()))?;
            let asked = requests.clone();
            let end_worker = Function::new(ctx.clone(), move |id: u32| {
                asked.borrow_mut().end(id);
            })
            .map_err(|e| error("HostFailed", e.to_string()))?;
            for (name, function) in [
                ("__yavin_worker_start", start_worker),
                ("__yavin_worker_post", post_worker),
                ("__yavin_worker_end", end_worker),
            ] {
                ctx.globals()
                    .set(name, function)
                    .map_err(|e| error("HostFailed", e.to_string()))?;
            }
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
            let (modules, runtime, main) = match &vscode {
                Some(v) => (
                    v.modules.to_string(),
                    v.runtime.to_string(),
                    v.main.to_string(),
                ),
                None => ("null".into(), "null".into(), String::new()),
            };
            load.call::<_, ()>((code, modules, runtime, main))
                .map_err(|e| {
                    let (message, stack) = thrown_with_stack(&ctx, e);
                    let mut failure = error("LoadFailed", message);
                    if let Some(stack) = stack {
                        failure["stack"] = json!(stack);
                    }
                    failure
                })?;
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
            timers,
            rejected,
            requests,
            workers: BTreeMap::new(),
            notices: VecDeque::new(),
            turn: 0,
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

    /// When it next has something to do: now, if its workers have (`pump_step`); else its or
    /// its workers' next timer, if one waits.
    pub fn next_due(&self) -> Option<Instant> {
        if self.has_worker_work() {
            return Some(Instant::now());
        }
        let own = self.timers.borrow().values().map(|t| t.due).min();
        let theirs = self.workers.values().filter_map(Worker::next_due).min();
        match (own, theirs) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    /// Its workers running now.
    pub fn worker_count(&self) -> usize {
        self.workers.len()
    }

    fn has_worker_work(&self) -> bool {
        !self.requests.borrow().queue.is_empty()
            || !self.notices.is_empty()
            || self
                .workers
                .values()
                .any(|w| !w.inbox.is_empty() || w.has_said())
    }

    /// Its workers in turn, starting after the one served last.
    fn in_turn(&self) -> Vec<u32> {
        let (after, upto): (Vec<u32>, Vec<u32>) =
            self.workers.keys().copied().partition(|id| *id > self.turn);
        after.into_iter().chain(upto).collect()
    }

    /// A worker ends (it failed, or could not start): gone, and its extension told.
    fn end_worker(&mut self, id: u32, reason: String) {
        self.workers.remove(&id);
        self.requests.borrow_mut().forget(id);
        self.notices.push_back(
            json!({"type": "worker", "id": id, "kind": "error", "text": reason, "ended": true}),
        );
    }

    /// One step of its workers' work (EXT-32), at most one entry into one runtime, so the host's
    /// watchdog sees each: requests first (in order; a start runs the worker's script), then what
    /// a worker said (given to the extension), then a message for a worker, then a worker's due
    /// timer -- each worker in turn. `capacity`: how many more workers the host may run. Returns
    /// what the extension sent meanwhile, or nothing when there was nothing to do.
    pub fn pump_step(&mut self, limits: &HostLimits, capacity: usize) -> Option<Vec<Value>> {
        loop {
            let request = self.requests.borrow_mut().queue.pop_front();
            let Some(request) = request else { break };
            match request {
                WorkerRequest::Post { id, data } => {
                    if let Some(worker) = self.workers.get_mut(&id) {
                        worker.inbox.push_back(data);
                    }
                }
                WorkerRequest::End { id } => {
                    self.workers.remove(&id);
                    self.requests.borrow_mut().forget(id);
                }
                WorkerRequest::Start {
                    id,
                    source,
                    url,
                    name,
                } => {
                    if !self.requests.borrow().known.contains(&id) {
                        continue;
                    }
                    let started = if capacity == 0 {
                        Err(format!(
                            "This host runs at most {} workers at once.",
                            crate::worker::MAX_HOST_WORKERS
                        ))
                    } else {
                        Worker::start(&source, &url, &name, limits)
                    };
                    match started {
                        Ok(worker) => {
                            self.workers.insert(id, worker);
                        }
                        Err(reason) => self.end_worker(id, reason),
                    }
                    return Some(Vec::new());
                }
            }
        }
        if let Some(notice) = self.notices.pop_front() {
            return Some(self.deliver(&notice, limits));
        }
        for id in self.in_turn() {
            let Some(worker) = self.workers.get_mut(&id) else {
                continue;
            };
            let name = worker.name.clone();
            let Some(said) = worker.take_said() else {
                continue;
            };
            self.turn = id;
            let event = |kind: &str, field: &str, text: String| json!({"type": "worker", "id": id, "kind": kind, field: text});
            return Some(match said {
                FromWorker::Message(data) => self.deliver(&event("message", "data", data), limits),
                FromWorker::Error(text) => self.deliver(&event("error", "text", text), limits),
                FromWorker::Log(level, text) => {
                    let level = if level == "warn" || level == "error" {
                        level
                    } else {
                        "info".into()
                    };
                    let who = if name.is_empty() {
                        "a worker".to_string()
                    } else {
                        format!("worker {name}")
                    };
                    vec![json!({"type": "log", "level": level, "text": format!("[{who}] {text}")})]
                }
                FromWorker::Close => {
                    self.workers.remove(&id);
                    self.requests.borrow_mut().forget(id);
                    Vec::new()
                }
            });
        }
        for id in self.in_turn() {
            let Some(worker) = self.workers.get_mut(&id) else {
                continue;
            };
            let Some(entered) = worker.take_message(limits) else {
                continue;
            };
            self.turn = id;
            self.requests.borrow_mut().delivered(id);
            if let Err(reason) = entered {
                self.end_worker(id, reason);
            }
            return Some(Vec::new());
        }
        let now = Instant::now();
        for id in self.in_turn() {
            let Some(worker) = self.workers.get_mut(&id) else {
                continue;
            };
            let Some(entered) = worker.fire_due(now, limits) else {
                continue;
            };
            self.turn = id;
            if let Err(reason) = entered {
                self.end_worker(id, reason);
            }
            return Some(Vec::new());
        }
        None
    }

    /// Fires its timers due by `now` (earliest first), each an entry of its own: an interval is
    /// due again a period later, a timeout is gone. Returns what it sent.
    pub fn fire_due(&mut self, now: Instant, limits: &HostLimits) -> Vec<Value> {
        let mut due: Vec<(Instant, u32)> = self
            .timers
            .borrow()
            .iter()
            .filter(|(_, t)| t.due <= now)
            .map(|(id, t)| (t.due, *id))
            .collect();
        due.sort();
        let mut sent = Vec::new();
        for (_, id) in due {
            {
                let mut timers = self.timers.borrow_mut();
                let Some(timer) = timers.get_mut(&id) else {
                    continue;
                };
                match timer.every {
                    Some(every) => timer.due = now + every,
                    None => {
                        timers.remove(&id);
                    }
                }
            }
            sent.extend(self.deliver(&json!({"type": "timer", "id": id}), limits));
        }
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
        // What is still rejected with no handler, once the jobs have run, is said (as Node.js
        // says it); the promises are let go.
        let unhandled: Vec<String> = std::mem::take(&mut *self.rejected.borrow_mut())
            .into_iter()
            .map(|(_, reason)| reason)
            .collect();
        let mut outbox = self.outbox.borrow_mut();
        for reason in unhandled.iter().take(MAX_REJECTIONS) {
            outbox.push(json!({"type": "log", "level": "error", "text": format!("An unhandled promise rejection: {reason}")}));
        }
        if unhandled.len() > MAX_REJECTIONS {
            outbox.push(json!({"type": "log", "level": "error", "text": format!("{} more unhandled promise rejections.", unhandled.len() - MAX_REJECTIONS)}));
        }
        std::mem::take(&mut *outbox)
    }
}

/// A rejection's reason, for the log: an error's name and message, or the value as text.
fn describe(reason: &rquickjs::Value<'_>) -> String {
    let text = if let Some(object) = reason.as_object() {
        let name: Option<String> = object.get("name").ok();
        let message: Option<String> = object.get("message").ok();
        match (name, message) {
            (Some(name), Some(message)) => format!("{name}: {message}"),
            (None, Some(message)) => message,
            _ => reason
                .get::<rquickjs::convert::Coerced<String>>()
                .map(|c| c.0)
                .unwrap_or_else(|_| "an object".into()),
        }
    } else {
        reason
            .get::<rquickjs::convert::Coerced<String>>()
            .map(|c| c.0)
            .unwrap_or_else(|_| "a value".into())
    };
    text.chars().take(300).collect()
}
