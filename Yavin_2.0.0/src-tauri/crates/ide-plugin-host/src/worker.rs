//! An extension's workers (EXT-32): `new Worker(url)` in a VS Code extension's code -- a web
//! extension's language server, typically -- runs here as a QuickJS runtime of its own.
//!
//! **What a worker is.** Its own runtime and context (`worker.js`: a worker's global scope, the
//! extension bootstrap's timers and text, the Web globals): its own objects, memory limit and
//! deadline. Its script is a file of its extension's package (the layer resolves the address;
//! nothing is read here). It speaks only to the extension that started it: what it posts goes to
//! that extension's `onmessage`, never to Yavin. It has no requests, events, files, network or
//! workers of its own -- less than its extension has, so starting one gains an extension nothing
//! it could not already run in its own runtime.
//!
//! **Ownership.** An extension's workers live in its `ExtensionRuntime` (`runtime.rs`): unloading
//! the extension (its stop, disable, uninstall, crash) or ending the host (a workspace switch, the
//! window closing) drops them with it. Ids are the extension's own: another extension's worker
//! cannot be named.
//!
//! **Bounds.** `MAX_WORKERS` an extension (and `MAX_HOST_WORKERS` a host), messages of at most
//! `MAX_WORKER_MESSAGE` of JSON each way, `MAX_QUEUED` waiting each way, a script of at most
//! `MAX_SOURCE`. Every entry into a worker (its script, each message, each timer) runs under the
//! host's call deadline and the memory limit, one at a time between the extensions' own entries
//! (`lib.rs`): a worker that runs past its deadline, or cannot be entered, is ended, and its
//! extension hears an `error`. It cannot hold the host: the host's watchdog sees each entry.

use crate::protocol::HostLimits;
use rquickjs::{Context, Function, Persistent, Runtime};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, VecDeque};
use std::rc::Rc;
use std::time::{Duration, Instant};

const WORKER_BOOTSTRAP: &str = include_str!("worker.js");
const BOOTSTRAP: &str = include_str!("bootstrap.js");
const WEB: &str = include_str!("web.js");
const INTL: &str = include_str!("intl.js");

/// The most workers one extension may have at once.
pub const MAX_WORKERS: usize = 4;
/// The most workers one host may have at once, across its extensions.
pub const MAX_HOST_WORKERS: usize = 16;
/// The largest message either way, as JSON text.
pub const MAX_WORKER_MESSAGE: usize = 4 * 1024 * 1024;
/// The most messages waiting either way, for one worker.
pub const MAX_QUEUED: usize = 1000;
/// The largest worker script.
pub const MAX_SOURCE: usize = 16 * 1024 * 1024;
/// The most timers one worker may have waiting.
pub const MAX_WORKER_TIMERS: usize = 1000;
/// Log lines one worker may say in one entry (the rest are dropped).
const MAX_LOGS: usize = 100;

/// The part of the extension bootstrap a worker has too: its timers and text, between its marks.
pub fn platform() -> &'static str {
    const START: &str = "// <yavin-platform>\n";
    const END: &str = "// </yavin-platform>";
    let from = BOOTSTRAP.find(START).map(|i| i + START.len()).unwrap_or(0);
    let to = BOOTSTRAP[from..]
        .find(END)
        .map(|i| from + i)
        .unwrap_or(from);
    &BOOTSTRAP[from..to]
}

/// What a worker said, for its extension (or its log).
pub enum FromWorker {
    Message(String),
    Error(String),
    Log(String, String),
    Close,
}

struct WorkerTimer {
    due: Instant,
    every: Option<Duration>,
}

/// One worker. Fields drop in order: what lives in the runtime before the runtime.
pub struct Worker {
    receive: Persistent<Function<'static>>,
    context: Context,
    runtime: Runtime,
    deadline: Rc<Cell<Option<Instant>>>,
    outbox: Rc<RefCell<VecDeque<FromWorker>>>,
    logs: Rc<Cell<usize>>,
    timers: Rc<RefCell<BTreeMap<u32, WorkerTimer>>>,
    /// Messages from its extension, waiting to be given to it (JSON text each).
    pub inbox: VecDeque<String>,
    pub name: String,
}

fn failure(ctx: &rquickjs::Ctx<'_>, error: rquickjs::Error) -> String {
    if let rquickjs::Error::Exception = error {
        let value = ctx.catch();
        if let Some(object) = value.as_object() {
            if let Ok(message) = object.get::<_, String>("message") {
                return message;
            }
        }
        if let Some(text) = value.as_string().and_then(|s| s.to_string().ok()) {
            return text;
        }
        return "it ran out of time or memory".into();
    }
    error.to_string()
}

impl Worker {
    /// A worker running `source` (its package's script at `url`): its scope is set up, then the
    /// script runs under the load deadline. A script that throws is said (as a browser's
    /// `error`), and the worker stays; one that cannot finish in time is not a worker.
    pub fn start(
        source: &str,
        url: &str,
        name: &str,
        limits: &HostLimits,
    ) -> Result<Worker, String> {
        if source.len() > MAX_SOURCE {
            return Err(format!(
                "A worker's script is at most {} MiB.",
                MAX_SOURCE / 1024 / 1024
            ));
        }
        let runtime = Runtime::new().map_err(|e| e.to_string())?;
        runtime.set_memory_limit(limits.memory_bytes);
        runtime.set_max_stack_size(crate::runtime::MAX_STACK);
        let deadline: Rc<Cell<Option<Instant>>> = Rc::new(Cell::new(None));
        let watched = deadline.clone();
        runtime.set_interrupt_handler(Some(Box::new(move || {
            watched.get().is_some_and(|until| Instant::now() > until)
        })));
        let context = Context::full(&runtime).map_err(|e| e.to_string())?;
        let outbox: Rc<RefCell<VecDeque<FromWorker>>> = Rc::new(RefCell::new(VecDeque::new()));
        let logs = Rc::new(Cell::new(0usize));
        let timers: Rc<RefCell<BTreeMap<u32, WorkerTimer>>> =
            Rc::new(RefCell::new(BTreeMap::new()));
        let init = json!({"url": url, "name": name, "maxMessage": MAX_WORKER_MESSAGE});
        let bootstrap = WORKER_BOOTSTRAP
            .replace("/*__YAVIN_PLATFORM__*/", platform())
            .replace("/*__YAVIN_WEB__*/", &format!("{WEB}\n{INTL}"))
            .replace("__YAVIN_WORKER_INIT__", &init.to_string());
        deadline.set(Some(Instant::now() + Duration::from_millis(limits.load_ms)));
        let started = context.with(|ctx| -> Result<Persistent<Function<'static>>, String> {
            let sink = outbox.clone();
            let said = logs.clone();
            // What the worker sends its extension: refused (false) when too large, or when too
            // many are waiting.
            let send = Function::new(ctx.clone(), move |text: String| -> bool {
                let Ok(message) = serde_json::from_str::<Value>(&text) else {
                    return false;
                };
                let mut queue = sink.borrow_mut();
                let field = |name: &str| {
                    message
                        .get(name)
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string()
                };
                match message.get("kind").and_then(Value::as_str) {
                    Some("message") => {
                        let data = field("data");
                        if data.len() > MAX_WORKER_MESSAGE || queue.len() >= MAX_QUEUED {
                            return false;
                        }
                        queue.push_back(FromWorker::Message(data));
                    }
                    Some("error") if queue.len() < MAX_QUEUED => queue.push_back(
                        FromWorker::Error(field("text").chars().take(2000).collect()),
                    ),
                    Some("log") if said.get() < MAX_LOGS && queue.len() < MAX_QUEUED => {
                        said.set(said.get() + 1);
                        queue.push_back(FromWorker::Log(
                            field("level"),
                            field("text").chars().take(4000).collect(),
                        ));
                    }
                    Some("close") => queue.push_back(FromWorker::Close),
                    _ => return false,
                }
                true
            })
            .map_err(|e| e.to_string())?;
            let waiting = timers.clone();
            let set_timer =
                Function::new(ctx.clone(), move |id: u32, ms: f64, repeat: bool| -> bool {
                    let mut waiting = waiting.borrow_mut();
                    if waiting.len() >= MAX_WORKER_TIMERS && !waiting.contains_key(&id) {
                        return false;
                    }
                    let ms = if ms.is_finite() {
                        ms.clamp(0.0, 2_147_483_647.0)
                    } else {
                        0.0
                    } as u64;
                    let every = repeat
                        .then(|| Duration::from_millis(ms.max(crate::runtime::MIN_INTERVAL_MS)));
                    let delay = every.unwrap_or(Duration::from_millis(ms));
                    waiting.insert(
                        id,
                        WorkerTimer {
                            due: Instant::now() + delay,
                            every,
                        },
                    );
                    true
                })
                .map_err(|e| e.to_string())?;
            let cleared = timers.clone();
            let clear_timer = Function::new(ctx.clone(), move |id: u32| {
                cleared.borrow_mut().remove(&id);
            })
            .map_err(|e| e.to_string())?;
            let random = Function::new(ctx.clone(), |n: u32| -> Option<String> {
                let n = n as usize;
                if n > crate::runtime::MAX_RANDOM {
                    return None;
                }
                let mut bytes = vec![0u8; n];
                getrandom::fill(&mut bytes).ok()?;
                Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
            })
            .map_err(|e| e.to_string())?;
            let globals = ctx.globals();
            for (name, function) in [
                ("__yavin_worker_send", send),
                ("__yavin_timer", set_timer),
                ("__yavin_untimer", clear_timer),
                ("__yavin_random", random),
            ] {
                globals.set(name, function).map_err(|e| e.to_string())?;
            }
            ctx.eval::<(), _>(bootstrap.as_str())
                .map_err(|e| format!("The worker could not be set up: {}", failure(&ctx, e)))?;
            // Taken before the worker's script runs: it cannot replace them.
            let receive: Function = globals
                .get("__yavin_worker_receive")
                .map_err(|e| e.to_string())?;
            let uncaught: Function = globals
                .get("__yavin_worker_uncaught")
                .map_err(|e| e.to_string())?;
            for name in ["__yavin_worker_receive", "__yavin_worker_uncaught"] {
                globals.remove(name).map_err(|e| e.to_string())?;
            }
            if let Err(error) = ctx.eval::<(), _>(source) {
                let reason = failure(&ctx, error);
                if deadline.get().is_some_and(|until| Instant::now() > until) {
                    return Err("The worker's script ran past its time limit.".into());
                }
                let _ = uncaught.call::<_, ()>((reason,));
            }
            Ok(Persistent::save(&ctx, receive))
        });
        let receive = match started {
            Ok(receive) => receive,
            Err(reason) => {
                deadline.set(None);
                return Err(reason);
            }
        };
        let mut worker = Worker {
            receive,
            context,
            runtime,
            deadline,
            outbox,
            logs,
            timers,
            inbox: VecDeque::new(),
            name: name.chars().take(100).collect(),
        };
        worker.drain()?;
        Ok(worker)
    }

    /// Gives the worker one entry (`{"type":"message","data"}` or `{"type":"timer","id"}`) and
    /// runs what it starts, under the call deadline. An error is the reason it must end.
    fn enter(&mut self, entry: &Value, limits: &HostLimits) -> Result<(), String> {
        self.deadline
            .set(Some(Instant::now() + Duration::from_millis(limits.call_ms)));
        self.logs.set(0);
        let text = entry.to_string();
        let failed = self.context.with(|ctx| {
            let receive = self.receive.clone().restore(&ctx).ok()?;
            receive
                .call::<_, ()>((text,))
                .err()
                .map(|e| failure(&ctx, e))
        });
        if let Some(reason) = failed {
            self.deadline.set(None);
            return Err(format!("The worker was stopped: {reason}"));
        }
        self.drain()
    }

    /// Its promise jobs, within the current deadline.
    fn drain(&mut self) -> Result<(), String> {
        let mut jobs = 0;
        let mut result = Ok(());
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
                        result = Err("The worker ran past its time limit and was stopped.".into());
                        break;
                    }
                }
            }
        }
        self.deadline.set(None);
        result
    }

    /// Gives it the next message its extension sent, if one waits.
    pub fn take_message(&mut self, limits: &HostLimits) -> Option<Result<(), String>> {
        let data = self.inbox.pop_front()?;
        Some(self.enter(&json!({"type": "message", "data": data}), limits))
    }

    /// Fires its earliest timer due by `now`, if one is.
    pub fn fire_due(&mut self, now: Instant, limits: &HostLimits) -> Option<Result<(), String>> {
        let id = {
            let mut timers = self.timers.borrow_mut();
            let (&id, _) = timers
                .iter()
                .filter(|(_, t)| t.due <= now)
                .min_by_key(|(_, t)| t.due)?;
            let timer = timers.get_mut(&id)?;
            match timer.every {
                Some(every) => timer.due = now + every,
                None => {
                    timers.remove(&id);
                }
            }
            id
        };
        Some(self.enter(&json!({"type": "timer", "id": id}), limits))
    }

    pub fn next_due(&self) -> Option<Instant> {
        self.timers.borrow().values().map(|t| t.due).min()
    }

    /// What it said since last asked, oldest first.
    pub fn take_said(&mut self) -> Option<FromWorker> {
        self.outbox.borrow_mut().pop_front()
    }

    pub fn has_said(&self) -> bool {
        !self.outbox.borrow().is_empty()
    }
}

/// What the extension asked of its workers, for the host to do between entries.
pub enum WorkerRequest {
    Start {
        id: u32,
        source: String,
        url: String,
        name: String,
    },
    Post {
        id: u32,
        data: String,
    },
    End {
        id: u32,
    },
}

/// The requests waiting, which ids are the extension's (started or starting), and how many of
/// its messages each has not yet been given -- shared with the functions its context is given.
#[derive(Default)]
pub struct WorkerRequests {
    pub queue: VecDeque<WorkerRequest>,
    pub known: std::collections::BTreeSet<u32>,
    pub undelivered: BTreeMap<u32, usize>,
}

impl WorkerRequests {
    /// `None` when started, else why not.
    pub fn start(&mut self, id: u32, source: String, url: String, name: String) -> Option<String> {
        if self.known.contains(&id) {
            return Some("That worker id is in use.".into());
        }
        if self.known.len() >= MAX_WORKERS {
            return Some(format!(
                "An extension may have at most {MAX_WORKERS} workers at once."
            ));
        }
        if source.len() > MAX_SOURCE {
            return Some(format!(
                "A worker's script is at most {} MiB.",
                MAX_SOURCE / 1024 / 1024
            ));
        }
        self.known.insert(id);
        self.queue.push_back(WorkerRequest::Start {
            id,
            source,
            url,
            name,
        });
        None
    }

    /// `None` when queued, else why not.
    pub fn post(&mut self, id: u32, data: String) -> Option<String> {
        if !self.known.contains(&id) {
            return Some("That worker has ended.".into());
        }
        if data.len() > MAX_WORKER_MESSAGE {
            return Some(format!(
                "A worker's message is at most {} MiB of JSON.",
                MAX_WORKER_MESSAGE / 1024 / 1024
            ));
        }
        let undelivered = self.undelivered.entry(id).or_default();
        if *undelivered >= MAX_QUEUED {
            return Some(format!(
                "Too many messages are waiting for that worker (the limit is {MAX_QUEUED})."
            ));
        }
        *undelivered += 1;
        self.queue.push_back(WorkerRequest::Post { id, data });
        None
    }

    pub fn end(&mut self, id: u32) {
        if self.known.contains(&id) {
            self.queue.push_back(WorkerRequest::End { id });
        }
    }

    /// One of its messages was given to it.
    pub fn delivered(&mut self, id: u32) {
        if let Some(n) = self.undelivered.get_mut(&id) {
            *n = n.saturating_sub(1);
        }
    }

    /// It is gone: its id may not be used for anything more.
    pub fn forget(&mut self, id: u32) {
        self.known.remove(&id);
        self.undelivered.remove(&id);
        self.queue
            .retain(|r| !matches!(r, WorkerRequest::Post { id: i, .. } if *i == id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_worker_has_the_bootstraps_timers_and_text_marked_once() {
        for mark in ["// <yavin-platform>\n", "// </yavin-platform>"] {
            assert_eq!(BOOTSTRAP.matches(mark).count(), 1, "{mark}");
        }
        let part = platform();
        for needed in [
            "const timers = new Map();",
            "globalThis.setTimeout = schedule(false);",
            "globalThis.TextDecoder = TextDecoder;",
            "globalThis.atob =",
        ] {
            assert!(part.contains(needed), "{needed}");
        }
        // Nothing of the extension's API: no way to Yavin.
        for absent in ["__yavin_send", "post(", "call(", "init."] {
            assert!(!part.contains(absent), "{absent}");
        }
        // Each mark in the worker's bootstrap once: what is put there goes there only.
        for mark in [
            "/*__YAVIN_PLATFORM__*/",
            "/*__YAVIN_WEB__*/",
            "__YAVIN_WORKER_INIT__",
        ] {
            assert_eq!(WORKER_BOOTSTRAP.matches(mark).count(), 1, "{mark}");
        }
    }

    #[test]
    fn an_extensions_requests_of_its_workers_are_bounded_and_its_own() {
        let mut asked = WorkerRequests::default();
        for id in 1..=MAX_WORKERS as u32 {
            assert_eq!(asked.start(id, "x".into(), "u".into(), String::new()), None);
        }
        assert!(asked
            .start(9, "x".into(), "u".into(), String::new())
            .unwrap()
            .contains("at most 4 workers"));
        assert!(asked
            .start(1, "x".into(), "u".into(), String::new())
            .unwrap()
            .contains("in use"));
        assert!(
            asked.post(7, "1".into()).unwrap().contains("ended"),
            "an id it never started"
        );
        assert!(asked
            .post(1, "x".repeat(MAX_WORKER_MESSAGE + 1))
            .unwrap()
            .contains("at most 4 MiB"));
        for _ in 0..MAX_QUEUED {
            assert_eq!(asked.post(1, "1".into()), None);
        }
        assert!(asked
            .post(1, "1".into())
            .unwrap()
            .contains("Too many messages"));
        asked.delivered(1);
        assert_eq!(
            asked.post(1, "1".into()),
            None,
            "one given to it frees a place"
        );
        // Forgotten (it ended): nothing more for it, and its place is free.
        asked.forget(1);
        assert!(asked
            .queue
            .iter()
            .all(|r| !matches!(r, WorkerRequest::Post { id: 1, .. })));
        assert!(asked.post(1, "1".into()).unwrap().contains("ended"));
        assert_eq!(asked.start(9, "x".into(), "u".into(), String::new()), None);
        let mut big = WorkerRequests::default();
        assert!(big
            .start(1, "x".repeat(MAX_SOURCE + 1), "u".into(), String::new())
            .unwrap()
            .contains("at most 16 MiB"));
    }
}
