//! The terminal's native session runtime (TERMINAL-01), speaking the contract in
//! `ide-terminal-protocol` (see ARCHITECTURE.md, "Terminal").
//!
//! One session is one PTY and the shell in it, and lives on four pieces:
//!
//! - the **commands** (`terminal_*`), which never wait on the process: they find the session,
//!   check its generation, and hand work over (starting and ending shells off the main thread);
//! - a **writer** thread per session, fed by a bounded queue: `terminal_write` only queues, so
//!   a shell that stops reading its input can never stall a command, the window or another
//!   terminal;
//! - a **reader** thread, which hands what the shell writes to the session's output stream
//!   (`terminal_stream`, TERMINAL-02): batched, numbered, delivered to each subscriber's own
//!   channel under flow control. The reader never delivers anything itself;
//! - a **reaper** thread, which waits for the shell to end, ends whatever it started, lets the
//!   reader drain, has the stream deliver the end -- after the last chunk -- and removes the
//!   session.
//!
//! A shell and everything it starts are one process tree: a Windows Job Object that ends its
//! processes when its handle closes (so they end with Yavin however Yavin ends), and on Unix the
//! shell's own process group (portable-pty starts the shell as a session leader).
//!
//! The map of sessions is locked only to look one up, add one or remove one; every session
//! has its own locks, so one terminal never waits on another.

use crate::terminal_stream::{End, OutputStream, Sink, StreamStats, LIMITS};
use crate::{with_workspace, Workspace};
use ide_terminal_protocol::{
    require_current, Generation, LiveState, SubscriptionId, TerminalAckRequest,
    TerminalCloseRequest, TerminalDimensions, TerminalError, TerminalErrorCause, TerminalId,
    TerminalKillRequest, TerminalOpenRequest, TerminalResizeRequest, TerminalSession,
    TerminalSessionMetadata, TerminalSessionRuntime, TerminalState, TerminalStateChanged,
    TerminalSubscribeRequest, TerminalUnsubscribeRequest, TerminalWriteRequest,
};
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    env,
    io::{Read, Write},
    path::PathBuf,
    sync::{
        mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender, TrySendError},
        Arc, Mutex, Weak,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

/// The renderer's `EMPTY_WORKSPACE`: the window with no folder open.
pub const EMPTY_WORKSPACE: &str = "empty:";

/// Input waiting for a shell, in requests (each at most `MAX_WRITE_BYTES`). A shell that has
/// stopped reading gets this much queued and then refuses more until it reads again.
const INPUT_QUEUE: usize = 64;

/// How long a closed shell has to end by itself after being hung up before it is killed.
const CLOSE_GRACE: Duration = Duration::from_secs(2);

/// One PTY read. The output stream batches reads into chunks of up to `LIMITS.max_chunk_bytes`.
const READ_BUFFER: usize = 8192;

/// How long the reaper waits, once the shell has ended, for output to stop arriving. ConPTY
/// keeps its output open until its console host has finished, and a host still waiting for an
/// answer (a shell killed before the terminal answered its first cursor-position query) may never
/// finish; the end is reported regardless, and nothing of the generation follows it. Time spent
/// with the reader paused by backpressure does not count: that output is still coming.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(3);

// ---------------------------------------------------------------------------------------------
// Subscribers

/// A subscriber's window: the channel it created and passed with its request. Every message is
/// already serialized (once, by the stream); a send that fails means the window has gone.
pub struct ChannelSink(pub Channel<InvokeResponseBody>);

impl Sink for ChannelSink {
    fn send(&self, message: &str) -> bool {
        self.0
            .send(InvokeResponseBody::Json(message.to_string()))
            .is_ok()
    }
}

// ---------------------------------------------------------------------------------------------
// Process trees

/// The shell and everything it starts.
struct ProcessTree {
    #[cfg(windows)]
    job: Option<ide_workspace::lsp_process::job::Job>,
    #[cfg(unix)]
    group: Option<i32>,
}

impl ProcessTree {
    /// Takes in the shell `pid`. On Windows the shell is put in a new kill-on-close job right
    /// after it starts; whatever it starts from then on is in the job. (A process it started in
    /// the instant before that would not be: portable-pty cannot start a shell suspended.)
    fn contain(pid: Option<u32>) -> ProcessTree {
        #[cfg(windows)]
        {
            let job = pid.and_then(|pid| {
                let job = ide_workspace::lsp_process::job::Job::new()?;
                job.assign_process_id(pid).then_some(job)
            });
            ProcessTree { job }
        }
        #[cfg(unix)]
        {
            ProcessTree {
                group: pid.map(|pid| pid as i32),
            }
        }
        #[cfg(not(any(windows, unix)))]
        {
            let _ = pid;
            ProcessTree {}
        }
    }

    /// Ends every process in the tree now.
    fn kill(&self) {
        #[cfg(windows)]
        if let Some(job) = &self.job {
            job.terminate();
        }
        #[cfg(unix)]
        if let Some(group) = self.group {
            // SAFETY: a plain signal to the shell's own process group.
            unsafe {
                libc::killpg(group, libc::SIGKILL);
            }
        }
    }

    /// Whether the shell is held in a tree that can be ended as a whole.
    fn is_contained(&self) -> bool {
        #[cfg(windows)]
        {
            self.job.is_some()
        }
        #[cfg(unix)]
        {
            self.group.is_some()
        }
        #[cfg(not(any(windows, unix)))]
        {
            false
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Sessions

struct Session {
    id: TerminalId,
    generation: Generation,
    workspace_id: String,
    metadata: TerminalSessionMetadata,
    started_at: u64,
    pid: Option<u32>,
    /// Bounded: see `INPUT_QUEUE`.
    input: SyncSender<Vec<u8>>,
    /// The PTY. `None` once hung up: dropping it closes the pseudoconsole (Windows) or the
    /// master (Unix), which tells the shell its terminal has gone.
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    tree: ProcessTree,
    state: Mutex<TerminalState>,
    dimensions: Mutex<TerminalDimensions>,
    /// This generation's output and lifecycle, in order, to its subscribers.
    stream: Arc<OutputStream>,
}

impl Session {
    fn state(&self) -> TerminalState {
        *self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Takes one step of the state machine, reporting the live ones; `false` if the step is not
    /// allowed from where the session is (a second close, say).
    fn advance(&self, to: TerminalState) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if !state.can_transition(to) {
            return false;
        }
        *state = to;
        // Reported under the lock, so two steps are always reported in the order taken.
        let live = match to {
            TerminalState::Running => Some(LiveState::Running { pid: self.pid }),
            TerminalState::Exiting => Some(LiveState::Exiting),
            _ => None,
        };
        if let Some(state) = live {
            self.stream.live(TerminalStateChanged {
                session_id: self.id.clone(),
                generation: self.generation,
                state,
            });
        }
        true
    }

    fn hang_up(&self) {
        let master = self.master.lock().unwrap_or_else(|e| e.into_inner()).take();
        drop(master);
    }

    /// Ends the session: hung up gently, then killed if still there after `CLOSE_GRACE`; or,
    /// `forced`, its whole process tree at once. The reaper reports the end either way.
    fn end(self: &Arc<Self>, forced: bool) {
        self.advance(TerminalState::Exiting);
        if forced {
            self.kill_now();
            self.hang_up();
            return;
        }
        self.hang_up();
        let session: Weak<Session> = Arc::downgrade(self);
        thread::spawn(move || {
            thread::sleep(CLOSE_GRACE);
            // Gone already when the reaper has finished with it.
            if let Some(session) = session.upgrade() {
                session.kill_now();
            }
        });
    }

    fn kill_now(&self) {
        self.tree.kill();
        // The shell itself, should it not be in a tree (or the tree could not be ended).
        let _ = self.killer.lock().unwrap_or_else(|e| e.into_inner()).kill();
    }

    fn snapshot(&self) -> TerminalSession {
        TerminalSession {
            metadata: self.metadata.clone(),
            runtime: TerminalSessionRuntime {
                generation: self.generation,
                state: self.state(),
                pid: self.pid,
                dimensions: *self.dimensions.lock().unwrap_or_else(|e| e.into_inner()),
                started_at: self.started_at,
                exit_code: None,
            },
        }
    }
}

#[derive(Default)]
struct Registry {
    sessions: HashMap<TerminalId, Arc<Session>>,
    /// Every subscription's stream, kept after the stream ends so a late acknowledgement is
    /// recognised (and harmless) rather than unknown. Pruned of finished streams as it grows.
    subscriptions: HashMap<SubscriptionId, Arc<OutputStream>>,
    /// The newest generation each id has had, kept after its session ends, so an open naming an
    /// older one -- a late request from before a restart -- is refused rather than run.
    newest: HashMap<TerminalId, Generation>,
}

/// Every terminal session of the application.
#[derive(Default, Clone)]
pub struct Terminals(Arc<Mutex<Registry>>);

impl Terminals {
    fn registry(&self) -> std::sync::MutexGuard<'_, Registry> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn find(&self, id: &TerminalId) -> Option<Arc<Session>> {
        self.registry().sessions.get(id).cloned()
    }

    /// The session a write or resize may act on: the request's own generation, still running.
    fn running(
        &self,
        id: &TerminalId,
        generation: Generation,
    ) -> Result<Arc<Session>, TerminalError> {
        let gone = || {
            TerminalError::new(
                TerminalErrorCause::InvalidSession,
                "That terminal is no longer running.",
            )
        };
        let session = self.find(id).ok_or_else(gone)?;
        require_current(generation, session.generation)?;
        if session.state() != TerminalState::Running {
            return Err(gone());
        }
        Ok(session)
    }

    /// Records a subscription's stream, dropping finished streams once there are many.
    fn record(&self, id: SubscriptionId, stream: Arc<OutputStream>) {
        let mut registry = self.registry();
        if registry.subscriptions.len() >= 256 {
            registry
                .subscriptions
                .retain(|_, stream| !stream.is_finished());
        }
        registry.subscriptions.insert(id, stream);
    }

    fn stream_of(&self, id: &SubscriptionId) -> Result<Arc<OutputStream>, TerminalError> {
        self.registry()
            .subscriptions
            .get(id)
            .cloned()
            .ok_or_else(|| {
                TerminalError::new(
                    TerminalErrorCause::InvalidSession,
                    "There is no such subscription.",
                )
            })
    }

    /// Removes `session` if it is still the one registered under its id.
    fn forget(&self, session: &Arc<Session>) {
        let mut registry = self.registry();
        if registry
            .sessions
            .get(&session.id)
            .is_some_and(|current| Arc::ptr_eq(current, session))
        {
            registry.sessions.remove(&session.id);
        }
    }
}

/// What a launch is checked against: where the window's workspace is, and which shells exist.
pub struct Launch {
    /// The workspace's root, or the user's home with no folder open.
    pub root: PathBuf,
    /// The window's workspace, spelled as the renderer spells it (`EMPTY_WORKSPACE` with none).
    pub workspace_id: String,
    pub shells: Vec<Shell>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn pty_size(dimensions: TerminalDimensions) -> PtySize {
    PtySize {
        rows: dimensions.rows,
        cols: dimensions.cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// A portable-pty failure as a typed error: an OS failure by its kind, anything else as
/// `cause` with the given sentence -- never the library's own text.
fn pty_error(cause: TerminalErrorCause, doing: &str, error: &anyhow::Error) -> TerminalError {
    match error.root_cause().downcast_ref::<std::io::Error>() {
        Some(io) => TerminalError::from_io(cause, doing, io),
        None => TerminalError::new(cause, format!("{doing}.")),
    }
}

/// Opens a generation of a session: checks everything, starts the shell in its process tree,
/// and starts the session's threads, with `subscriber` -- the opener -- already receiving its
/// output. Answers the session, already `Running`.
pub fn open(
    terminals: &Terminals,
    request: TerminalOpenRequest,
    launch: Launch,
    subscriber: (SubscriptionId, Arc<dyn Sink>),
) -> Result<TerminalSession, TerminalError> {
    if terminals
        .registry()
        .subscriptions
        .get(&subscriber.0)
        .is_some_and(|stream| !stream.is_finished())
    {
        return Err(TerminalError::protocol("That subscription already exists."));
    }
    if request.workspace_id != launch.workspace_id {
        return Err(TerminalError::new(
            TerminalErrorCause::InvalidWorkspace,
            "That terminal belongs to a workspace that is no longer open.",
        ));
    }
    if let Some(profile) = &request.profile {
        profile.validate()?;
    }
    let executable = resolve_shell(
        request.profile.as_ref().map(|p| p.executable.as_str()),
        &launch.shells,
    )?;
    let cwd = resolve_cwd(
        request
            .cwd
            .as_deref()
            .or(request.profile.as_ref().and_then(|p| p.cwd.as_deref())),
        launch.root,
    )?;

    // Claim the generation before starting anything, so two opens of one id cannot both run.
    let replaced = {
        let mut registry = terminals.registry();
        let newest = registry.newest.get(&request.session_id).copied();
        if !request.generation.is_newer_than(newest) {
            return Err(TerminalError::protocol(
                "That terminal launch is older than one already started.",
            ));
        }
        registry
            .newest
            .insert(request.session_id.clone(), request.generation);
        registry.sessions.remove(&request.session_id)
    };
    // A restart: the previous generation ends, all of it.
    if let Some(previous) = replaced {
        previous.end(true);
    }

    let pair = native_pty_system()
        .openpty(pty_size(request.dimensions))
        .map_err(|e| {
            pty_error(
                TerminalErrorCause::SpawnFailed,
                "Cannot open a terminal",
                &e,
            )
        })?;
    let shell_name = std::path::Path::new(&executable)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| executable.clone());

    // The shell is started as itself. Arguments come only from a profile, never from an
    // interpolated command line, so there is no string to inject into.
    let mut command = CommandBuilder::new(&executable);
    if let Some(profile) = &request.profile {
        for argument in &profile.args {
            command.arg(argument);
        }
    }
    command.cwd(&cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    if let Some(profile) = &request.profile {
        for (name, value) in &profile.env {
            command.env(name, value);
        }
    }
    let starting = format!("Cannot start {shell_name}");
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| pty_error(TerminalErrorCause::SpawnFailed, &starting, &e))?;
    drop(pair.slave);
    let pid = child.process_id();
    // Contained before anything else happens, so a failure below still ends it all.
    let tree = ProcessTree::contain(pid);

    let killer = child.clone_killer();
    let fail = |error: TerminalError, mut killer: Box<dyn ChildKiller + Send + Sync>| {
        tree.kill();
        let _ = killer.kill();
        error
    };
    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(e) => {
            return Err(fail(
                pty_error(TerminalErrorCause::SpawnFailed, &starting, &e),
                killer,
            ))
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(e) => {
            return Err(fail(
                pty_error(TerminalErrorCause::SpawnFailed, &starting, &e),
                killer,
            ))
        }
    };

    let (input, queued) = sync_channel::<Vec<u8>>(INPUT_QUEUE);
    let subscription = subscriber.0.clone();
    let stream = OutputStream::start(
        request.session_id.clone(),
        request.generation,
        LIMITS.clone(),
        subscriber,
    );
    let session = Arc::new(Session {
        id: request.session_id.clone(),
        generation: request.generation,
        workspace_id: request.workspace_id.clone(),
        metadata: TerminalSessionMetadata {
            session_id: request.session_id.clone(),
            workspace_id: request.workspace_id.clone(),
            profile: request.profile.clone(),
            cwd: request.cwd.clone(),
        },
        started_at: now_ms(),
        pid,
        input,
        master: Mutex::new(Some(pair.master)),
        killer: Mutex::new(killer),
        tree,
        state: Mutex::new(TerminalState::Spawning),
        dimensions: Mutex::new(request.dimensions),
        stream: stream.clone(),
    });

    {
        let mut registry = terminals.registry();
        // A newer open of the same id arrived while this one was starting: it wins.
        if registry.newest.get(&session.id) != Some(&session.generation) {
            drop(registry);
            session.kill_now();
            stream.finish(End::Error(TerminalError::new(
                TerminalErrorCause::InvalidSession,
                "That terminal was started again before this launch finished.",
            )));
            return Err(TerminalError::new(
                TerminalErrorCause::InvalidSession,
                "That terminal was started again before this launch finished.",
            ));
        }
        registry
            .sessions
            .insert(session.id.clone(), session.clone());
    }
    terminals.record(subscription, stream);
    // `Running` is reported before any output can be: the reader starts after it.
    session.advance(TerminalState::Running);

    thread::spawn(move || write_input(queued, writer));
    let (drained, drain) = sync_channel::<()>(1);
    {
        let session = session.clone();
        thread::spawn(move || {
            read_output(&session, reader);
            let _ = drained.send(());
        });
    }
    {
        let session = session.clone();
        let terminals = terminals.clone();
        thread::spawn(move || reap(&terminals, &session, child, drain));
    }
    Ok(session.snapshot())
}

/// The writer: takes queued input in order until the session goes or the shell stops taking it.
fn write_input(queued: Receiver<Vec<u8>>, mut writer: Box<dyn Write + Send>) {
    for bytes in queued {
        if writer
            .write_all(&bytes)
            .and_then(|()| writer.flush())
            .is_err()
        {
            break;
        }
    }
}

/// The reader: hands every read, untouched, to the session's output stream, which may make it
/// wait (backpressure) but never makes it deliver anything. Stops when the PTY has nothing more
/// or the stream's input has been closed.
fn read_output(session: &Session, mut reader: Box<dyn Read + Send>) {
    let mut buffer = vec![0u8; READ_BUFFER];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => return,
            Ok(count) => {
                if !session.stream.push(&buffer[..count]) {
                    return;
                }
            }
        }
    }
}

/// The reaper: waits for the shell, then ends everything it started, hangs up so the reader
/// drains to its end, and has the stream deliver the end after the last chunk.
fn reap(
    terminals: &Terminals,
    session: &Arc<Session>,
    mut child: Box<dyn Child + Send + Sync>,
    drain: Receiver<()>,
) {
    let status = child.wait();
    session.advance(TerminalState::Exiting);
    // The shell is gone; nothing it started outlives it.
    session.tree.kill();
    // Closing the pseudoconsole is what lets a ConPTY reader reach its end. Closed apart from
    // the reaper: closing it can wait on the console host.
    {
        let session = session.clone();
        thread::spawn(move || session.hang_up());
    }
    let mut quiet_since = Instant::now();
    loop {
        match drain.recv_timeout(Duration::from_millis(100)) {
            Ok(()) | Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {
                if session.stream.reader_paused() {
                    quiet_since = Instant::now();
                } else if quiet_since.elapsed() >= DRAIN_TIMEOUT {
                    break;
                }
            }
        }
    }
    session.stream.close_input();
    terminals.forget(session);
    match status {
        Ok(status) => {
            if session.advance(TerminalState::Exited) {
                // Windows exit codes are 32-bit unsigned; the contract carries them as i32.
                session
                    .stream
                    .finish(End::Exit(Some(status.exit_code() as i32)));
            }
        }
        Err(error) => {
            if session.advance(TerminalState::Failed) {
                session.stream.finish(End::Error(TerminalError::from_io(
                    TerminalErrorCause::ProcessFailed,
                    "Lost track of the shell",
                    &error,
                )));
            }
        }
    }
}

/// Queues input for the shell; never waits for the shell to read it.
pub fn write(terminals: &Terminals, request: TerminalWriteRequest) -> Result<(), TerminalError> {
    request.validate()?;
    let session = terminals.running(&request.session_id, request.generation)?;
    match session.input.try_send(request.data.into_bytes()) {
        Ok(()) => Ok(()),
        Err(TrySendError::Full(_)) => Err(TerminalError::new(
            TerminalErrorCause::WriteFailed,
            "The shell is not reading its input. Try again when it is.",
        )),
        Err(TrySendError::Disconnected(_)) => Err(TerminalError::new(
            TerminalErrorCause::WriteFailed,
            "The shell has stopped taking input.",
        )),
    }
}

pub fn resize(terminals: &Terminals, request: TerminalResizeRequest) -> Result<(), TerminalError> {
    let session = terminals.running(&request.session_id, request.generation)?;
    let master = session.master.lock().unwrap_or_else(|e| e.into_inner());
    let Some(master) = master.as_ref() else {
        return Err(TerminalError::new(
            TerminalErrorCause::InvalidSession,
            "That terminal is no longer running.",
        ));
    };
    master.resize(pty_size(request.dimensions)).map_err(|e| {
        pty_error(
            TerminalErrorCause::ResizeFailed,
            "Cannot resize the terminal",
            &e,
        )
    })?;
    *session.dimensions.lock().unwrap_or_else(|e| e.into_inner()) = request.dimensions;
    Ok(())
}

/// Ends a generation gently. Closing one that has ended, or a stale one, does nothing.
pub fn close(terminals: &Terminals, request: TerminalCloseRequest) {
    if let Some(session) = terminals
        .find(&request.session_id)
        .filter(|s| s.generation == request.generation)
    {
        session.end(false);
    }
}

/// Ends a generation and everything it started, now. A stale generation is left alone.
pub fn kill(terminals: &Terminals, request: TerminalKillRequest) -> Result<(), TerminalError> {
    if let Some(session) = terminals
        .find(&request.session_id)
        .filter(|s| s.generation == request.generation)
    {
        if !session.tree.is_contained() && session.pid.is_none() {
            return Err(TerminalError::new(
                TerminalErrorCause::TerminationFailed,
                "Cannot end that terminal's processes.",
            ));
        }
        session.end(true);
    }
    Ok(())
}

/// Adds a subscriber to the current generation of a session: it is sent that generation's
/// output from now on (no replay -- TERMINAL-03), in its own stream with its own window.
pub fn subscribe(
    terminals: &Terminals,
    request: TerminalSubscribeRequest,
    sink: Arc<dyn Sink>,
) -> Result<(), TerminalError> {
    let session = terminals.find(&request.session_id).ok_or_else(|| {
        TerminalError::new(
            TerminalErrorCause::InvalidSession,
            "That terminal is no longer running.",
        )
    })?;
    require_current(request.generation, session.stream.generation())?;
    session
        .stream
        .subscribe(request.subscription_id.clone(), sink)?;
    terminals.record(request.subscription_id, session.stream.clone());
    Ok(())
}

/// Ends one subscription; the session and its other subscribers go on. Idempotent.
pub fn unsubscribe(terminals: &Terminals, request: TerminalUnsubscribeRequest) {
    if let Ok(stream) = terminals.stream_of(&request.subscription_id) {
        stream.unsubscribe(&request.subscription_id);
    }
}

/// A subscriber's cumulative acknowledgement (see `OutputStream::ack`).
pub fn ack(terminals: &Terminals, request: TerminalAckRequest) -> Result<(), TerminalError> {
    terminals.stream_of(&request.subscription_id)?.ack(
        &request.subscription_id,
        request.generation,
        request.seq,
    )
}

/// What a session's output stream is doing; for development and tests, never content.
pub fn stats(terminals: &Terminals, id: &TerminalId) -> Option<StreamStats> {
    terminals.find(id).map(|session| session.stream.stats())
}

/// Ends every session now: the page reloaded, the workspace was disposed, or Yavin is exiting.
pub fn close_all(terminals: &Terminals) {
    let sessions: Vec<_> = terminals.registry().sessions.values().cloned().collect();
    for session in sessions {
        session.end(true);
    }
}

/// Ends the sessions of every workspace but `current`: entering a workspace leaves nothing of
/// the previous one's shells running, whatever the renderer manages to do.
pub fn end_other_workspaces(terminals: &Terminals, current: Option<&str>) {
    let current = current.unwrap_or(EMPTY_WORKSPACE);
    let sessions: Vec<_> = terminals
        .registry()
        .sessions
        .values()
        .filter(|s| s.workspace_id != current)
        .cloned()
        .collect();
    for session in sessions {
        session.end(true);
    }
}

// ---------------------------------------------------------------------------------------------
// Shells and folders

/// A shell the user can actually start, as offered in the New Terminal menu.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Shell {
    pub name: String,
    pub path: String,
}

/// Whether two paths name the same program, ignoring separator style and case.
/// Windows is case-insensitive and the panel may echo a path back in either form.
fn same_path(one: &str, other: &str) -> bool {
    one.replace(char::from(92), "/")
        .eq_ignore_ascii_case(&other.replace(char::from(92), "/"))
}

/// The first entry of `PATH` that holds `program`, if any.
fn find_on_path(program: &str) -> Option<PathBuf> {
    env::var_os("PATH").and_then(|paths| {
        env::split_paths(&paths)
            .map(|directory| directory.join(program))
            .find(|candidate| candidate.is_file())
    })
}

fn push_shell(shells: &mut Vec<Shell>, name: &str, path: Option<PathBuf>) {
    let Some(path) = path.filter(|path| path.is_file()) else {
        return;
    };
    let path = path.to_string_lossy().into_owned();
    // The same shell can be reached by several names; offer it once.
    if shells.iter().any(|shell| same_path(&shell.path, &path)) {
        return;
    }
    shells.push(Shell {
        name: name.to_string(),
        path,
    });
}

/// The shells present on this machine, best first. The list is also the program allowlist:
/// a terminal can only be started with a program that appears here. (What the shell is then
/// told to do -- by a profile's arguments or by typing -- is the user's own authority.)
pub fn available_shells() -> Vec<Shell> {
    let mut shells = Vec::new();
    if cfg!(windows) {
        let system = env::var_os("SystemRoot").map(PathBuf::from);
        push_shell(
            &mut shells,
            "Command Prompt",
            env::var_os("COMSPEC").map(PathBuf::from).or_else(|| {
                system
                    .as_ref()
                    .map(|root| root.join("System32").join("cmd.exe"))
            }),
        );
        push_shell(&mut shells, "PowerShell", find_on_path("pwsh.exe"));
        push_shell(
            &mut shells,
            "Windows PowerShell",
            system.as_ref().map(|root| {
                root.join("System32")
                    .join("WindowsPowerShell")
                    .join("v1.0")
                    .join("powershell.exe")
            }),
        );
        for program_files in ["ProgramFiles", "ProgramFiles(x86)"] {
            push_shell(
                &mut shells,
                "Git Bash",
                env::var_os(program_files)
                    .map(|root| PathBuf::from(root).join("Git").join("bin").join("bash.exe")),
            );
        }
    } else {
        push_shell(
            &mut shells,
            "Default shell",
            env::var_os("SHELL").map(PathBuf::from),
        );
        for (name, path) in [
            ("zsh", "/bin/zsh"),
            ("bash", "/bin/bash"),
            ("sh", "/bin/sh"),
        ] {
            push_shell(&mut shells, name, Some(PathBuf::from(path)));
        }
    }
    shells
}

/// Accepts only a shell this machine actually offers. Without a request, the first detected
/// shell is used.
pub fn resolve_shell(requested: Option<&str>, offered: &[Shell]) -> Result<String, TerminalError> {
    let Some(first) = offered.first() else {
        return Err(TerminalError::new(
            TerminalErrorCause::ShellUnavailable,
            "No shell could be found on this system.",
        ));
    };
    let Some(requested) = requested.filter(|name| !name.is_empty()) else {
        return Ok(first.path.clone());
    };
    offered
        .iter()
        .find(|shell| same_path(&shell.path, requested))
        .map(|shell| shell.path.clone())
        .ok_or_else(|| {
            TerminalError::new(
                TerminalErrorCause::ShellUnavailable,
                "That shell is not available on this system.",
            )
        })
}

/// Where a terminal should start when no workspace folder is open: the user's home
/// directory, falling back to the process's own current directory.
fn default_cwd() -> PathBuf {
    let home = if cfg!(windows) {
        env::var_os("USERPROFILE")
    } else {
        env::var_os("HOME")
    };
    home.map(PathBuf::from)
        .filter(|path| path.is_dir())
        .or_else(|| env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Where a terminal starts. Must be a directory that exists: a missing or file path would
/// otherwise fail deep inside the spawn with a message that names nothing useful.
fn resolve_cwd(requested: Option<&str>, fallback: PathBuf) -> Result<PathBuf, TerminalError> {
    let Some(requested) = requested.filter(|path| !path.is_empty()) else {
        // The fallback is usually the workspace root, which is canonical and so, on Windows,
        // in the extended-length form a shell cannot start in (see `process_cwd`).
        return Ok(process_cwd(fallback));
    };
    let invalid = |message: String| TerminalError::new(TerminalErrorCause::InvalidCwd, message);
    if requested.contains(['\0', '\r', '\n']) {
        return Err(invalid(
            "A terminal's folder cannot contain a line break or NUL.".into(),
        ));
    }
    let path = PathBuf::from(requested);
    if !path.is_dir() {
        return Err(invalid(format!(
            "{requested} is not a folder this terminal can start in."
        )));
    }
    // Deliberately NOT canonicalised: that would produce the extended-length form. The path
    // has already been shown to be a real directory, which is what actually needed checking.
    Ok(process_cwd(path))
}

/// `path` in the form a process can be started in.
///
/// On Windows, `canonicalize` -- and so the workspace root -- returns the extended-length
/// `\\?\C:\...` / `\\?\UNC\server\share\...` form. That is the right form for identity and for
/// file I/O, but not for a working directory: `cmd.exe` refuses it with "UNC paths are not
/// supported" and starts in the Windows directory instead, so the terminal silently lands in
/// the wrong folder. The prefix is removed when the plain form names the same folder, and kept
/// when it would not -- a path too long for the plain form, or a component that plain Win32
/// paths cannot express -- so the shell is never quietly given a different folder.
///
/// Anywhere else a path has no such prefix, and this returns it unchanged.
fn process_cwd(path: PathBuf) -> PathBuf {
    use std::path::{Component, Prefix};

    let mut components = path.components();
    let plain = match components.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::VerbatimDisk(drive) => format!("{}:", drive as char),
            Prefix::VerbatimUNC(server, share) => format!(
                r"\\{}\{}",
                server.to_string_lossy(),
                share.to_string_lossy()
            ),
            _ => return path,
        },
        _ => return path,
    };
    let mut result = PathBuf::from(plain);
    for component in components {
        match component {
            Component::RootDir => result.push(component),
            Component::Normal(name) if plain_name_is_safe(&name.to_string_lossy()) => {
                result.push(name)
            }
            // `.`/`..` are literal names under the prefix but not without it, and a name the
            // plain form cannot hold would be read as something else.
            _ => return path,
        }
    }
    // MAX_PATH less the terminator, which is the limit a working directory has to respect.
    if result.as_os_str().len() >= 259 {
        return path;
    }
    result
}

/// Whether `name` means the same thing without the extended-length prefix: plain Win32 paths
/// trim trailing dots and spaces, and treat the reserved device names as devices.
fn plain_name_is_safe(name: &str) -> bool {
    if name.ends_with('.') || name.ends_with(' ') {
        return false;
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && matches!(stem.as_bytes()[3], b'1'..=b'9'));
    !reserved
}

// ---------------------------------------------------------------------------------------------
// Commands
//
// None waits on a shell. The ones with real work -- starting a shell, ending one, detecting
// shells -- run off the main thread (`async`). `terminal_write` and `terminal_resize` only queue
// input or set a size, so they stay on the main thread, which runs them in the order they were
// sent: keystrokes must reach the shell in the order they were typed, and async commands run
// concurrently. Failures are the contract's `"Cause: message"`.

/// The window's workspace as a launch is checked against it.
fn launch_for(workspace: &Workspace) -> Launch {
    let root = with_workspace(workspace, |manager| Ok(manager.root().to_path_buf())).ok();
    let workspace_id = root
        .as_ref()
        .and_then(|root| ide_localgit::WorkspaceSpec::from_paths(&[root]).ok())
        .map(|spec| spec.workspace_id)
        .unwrap_or_else(|| EMPTY_WORKSPACE.to_string());
    Launch {
        root: root.unwrap_or_else(default_cwd),
        workspace_id,
        shells: available_shells(),
    }
}

#[tauri::command(async)]
pub fn terminal_shells() -> Vec<Shell> {
    available_shells()
}

/// Opens a session; `events` is the opener's channel, and receives every message of this
/// generation (see `terminal_stream`), acknowledged with `terminal_ack`.
#[tauri::command(async)]
pub fn terminal_open(
    workspace: State<'_, Workspace>,
    terminals: State<'_, Terminals>,
    request: TerminalOpenRequest,
    subscription_id: SubscriptionId,
    events: Channel<InvokeResponseBody>,
) -> Result<TerminalSession, String> {
    let launch = launch_for(&workspace);
    open(
        &terminals,
        request,
        launch,
        (subscription_id, Arc::new(ChannelSink(events))),
    )
    .map_err(String::from)
}

/// Queues input; never waits for the shell (see `write`).
#[tauri::command]
pub fn terminal_write(
    terminals: State<'_, Terminals>,
    request: TerminalWriteRequest,
) -> Result<(), String> {
    write(&terminals, request).map_err(String::from)
}

#[tauri::command]
pub fn terminal_resize(
    terminals: State<'_, Terminals>,
    request: TerminalResizeRequest,
) -> Result<(), String> {
    resize(&terminals, request).map_err(String::from)
}

#[tauri::command(async)]
pub fn terminal_close(terminals: State<'_, Terminals>, request: TerminalCloseRequest) {
    close(&terminals, request);
}

#[tauri::command(async)]
pub fn terminal_kill(
    terminals: State<'_, Terminals>,
    request: TerminalKillRequest,
) -> Result<(), String> {
    kill(&terminals, request).map_err(String::from)
}

#[tauri::command(async)]
pub fn terminal_close_all(terminals: State<'_, Terminals>) {
    close_all(&terminals);
}

#[tauri::command]
pub fn terminal_subscribe(
    terminals: State<'_, Terminals>,
    request: TerminalSubscribeRequest,
    events: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    subscribe(&terminals, request, Arc::new(ChannelSink(events))).map_err(String::from)
}

#[tauri::command]
pub fn terminal_unsubscribe(terminals: State<'_, Terminals>, request: TerminalUnsubscribeRequest) {
    unsubscribe(&terminals, request);
}

/// Cheap and never waiting: a cumulative acknowledgement only moves a counter (and may wake the
/// stream's pump).
#[tauri::command]
pub fn terminal_ack(
    terminals: State<'_, Terminals>,
    request: TerminalAckRequest,
) -> Result<(), String> {
    ack(&terminals, request).map_err(String::from)
}

#[tauri::command]
pub fn terminal_stats(
    terminals: State<'_, Terminals>,
    session_id: TerminalId,
) -> Option<StreamStats> {
    stats(&terminals, &session_id)
}

#[cfg(test)]
#[path = "terminal_tests.rs"]
mod tests;
