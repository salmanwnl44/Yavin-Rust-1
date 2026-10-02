use super::*;
use ide_terminal_protocol::{
    TerminalDetached, TerminalErrorEvent, TerminalExit, TerminalMessage, TerminalOutputChunk,
    TerminalProfile, FIRST_SEQUENCE,
};
use std::path::Path;
use std::sync::Condvar;
use std::time::Instant;

const WORKSPACE: &str = "file://c:/test-workspace";

fn offered() -> Vec<Shell> {
    vec![
        Shell {
            name: "First".into(),
            path: "C:/Windows/System32/cmd.exe".into(),
        },
        Shell {
            name: "Second".into(),
            path: "C:/Program Files/Git/bin/bash.exe".into(),
        },
    ]
}

// --- Recording events ------------------------------------------------------------------------

#[derive(Clone, Debug)]
enum Event {
    Output(TerminalOutputChunk),
    State(TerminalStateChanged),
    Exit(TerminalExit),
    Error(TerminalErrorEvent),
    Detached(TerminalDetached),
}

#[derive(Default)]
struct Recorder {
    events: Mutex<Vec<Event>>,
    changed: Condvar,
    /// Where to acknowledge output, once known.
    acks: Mutex<Option<(Terminals, SubscriptionId)>>,
}

impl Recorder {
    fn push(&self, event: Event) {
        self.events.lock().unwrap().push(event);
        self.changed.notify_all();
    }

    fn snapshot(&self) -> Vec<Event> {
        self.events.lock().unwrap().clone()
    }

    /// Everything the shell has written so far, as text (for matching only).
    fn text(&self) -> String {
        let bytes: Vec<u8> = self
            .snapshot()
            .into_iter()
            .filter_map(|event| match event {
                Event::Output(chunk) => Some(chunk.bytes),
                _ => None,
            })
            .flatten()
            .collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }

    fn ended(&self) -> bool {
        self.snapshot()
            .iter()
            .any(|event| matches!(event, Event::Exit(_) | Event::Error(_) | Event::Detached(_)))
    }

    /// Waits until `done` holds or `timeout` passes; answers whether it held.
    fn wait(&self, timeout: Duration, done: impl Fn(&Recorder) -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if done(self) {
                return true;
            }
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            let events = self.events.lock().unwrap();
            let _ = self
                .changed
                .wait_timeout(events, (deadline - now).min(Duration::from_millis(100)))
                .unwrap();
        }
    }
}

/// A subscriber's channel, as the tests see it: every message parsed back from the wire, and
/// each output chunk acknowledged as soon as it arrives, the way xterm's write callback does.
impl Sink for Recorder {
    fn send(&self, message: &str) -> bool {
        let message: TerminalMessage =
            serde_json::from_str(message).expect("every message is in the contract's shape");
        if let TerminalMessage::Output(chunk) = &message {
            if let Some((terminals, subscription)) = &*self.acks.lock().unwrap() {
                let _ = ack(
                    terminals,
                    TerminalAckRequest {
                        subscription_id: subscription.clone(),
                        session_id: chunk.session_id.clone(),
                        generation: chunk.generation,
                        seq: chunk.seq,
                    },
                );
            }
        }
        self.push(match message {
            TerminalMessage::Output(chunk) => Event::Output(chunk),
            TerminalMessage::State(event) => Event::State(event),
            TerminalMessage::Exit(event) => Event::Exit(event),
            TerminalMessage::Error(event) => Event::Error(event),
            TerminalMessage::Detached(event) => Event::Detached(event),
        });
        true
    }
}

// --- Helpers ---------------------------------------------------------------------------------

fn id(text: &str) -> TerminalId {
    TerminalId::new(text).unwrap()
}

fn generation(value: u64) -> Generation {
    Generation::new(value).unwrap()
}

fn request(session: &str, launch: u64) -> TerminalOpenRequest {
    TerminalOpenRequest {
        session_id: id(session),
        workspace_id: WORKSPACE.into(),
        generation: generation(launch),
        profile: None,
        cwd: None,
        dimensions: TerminalDimensions::new(120, 30).unwrap(),
    }
}

fn launch() -> Launch {
    Launch {
        root: env::temp_dir(),
        workspace_id: WORKSPACE.into(),
        shells: available_shells(),
    }
}

/// A subscription id for one launch of `session`.
fn subscription(session: &str, launch: u64) -> SubscriptionId {
    SubscriptionId::new(format!("{session}-{launch}-view")).unwrap()
}

/// A recorder subscribed as `session`'s launch `launch` opener, acknowledging what it is sent.
fn subscriber(
    terminals: &Terminals,
    session: &str,
    launch: u64,
) -> (SubscriptionId, Arc<Recorder>) {
    let id = subscription(session, launch);
    let recorder = Arc::new(Recorder::default());
    *recorder.acks.lock().unwrap() = Some((terminals.clone(), id.clone()));
    (id, recorder)
}

/// Opens `session`'s launch `launch` with a recording, acknowledging subscriber.
fn open_recorded(
    terminals: &Terminals,
    session: &str,
    launch: u64,
) -> Result<Arc<Recorder>, TerminalError> {
    let (id, recorder) = subscriber(terminals, session, launch);
    open(
        terminals,
        request(session, launch),
        self::launch(),
        (id, recorder.clone()),
    )?;
    Ok(recorder)
}

fn type_in(terminals: &Terminals, session: &str, launch: u64, text: &str) {
    write(
        terminals,
        TerminalWriteRequest {
            session_id: id(session),
            generation: generation(launch),
            data: text.into(),
        },
    )
    .unwrap();
}

/// Opens a real shell and waits until it is ready for input. ConPTY asks for the cursor
/// position (ESC[6n) before it lets cmd.exe draw a prompt; xterm.js answers that in the
/// application, and this answers it the same way. A Unix shell does not ask: it is ready once
/// it has printed something and gone quiet.
fn start(terminals: &Terminals, session: &str, launch_no: u64) -> Arc<Recorder> {
    let recorder = open_recorded(terminals, session, launch_no).unwrap();
    let started = Instant::now();
    let ready = recorder.wait(Duration::from_secs(30), |r| {
        let text = r.text();
        text.contains("\u{1b}[6n")
            || (!text.is_empty() && started.elapsed() > Duration::from_secs(2))
    });
    assert!(ready, "the shell never started; saw {:?}", recorder.text());
    if recorder.text().contains("\u{1b}[6n") {
        type_in(terminals, session, launch_no, "\x1b[1;1R");
    }
    recorder
}

/// The events of one generation are in the contract's order: `Running` first, then output
/// numbered from 0 without gaps, `Exiting` at most once, and exactly one end, last, naming
/// the last chunk.
fn assert_protocol_order(events: &[Event], launch: u64) {
    let mut next_seq = FIRST_SEQUENCE.get();
    let mut ended = false;
    let mut exiting = 0;
    for (index, event) in events.iter().enumerate() {
        assert!(!ended, "an event after the end: {event:?}");
        match event {
            Event::State(state) => {
                assert_eq!(state.generation, generation(launch));
                match state.state {
                    LiveState::Running { pid } => {
                        assert_eq!(index, 0, "Running is the first event");
                        assert!(pid.is_some(), "the shell's pid is reported");
                    }
                    LiveState::Exiting => exiting += 1,
                }
            }
            Event::Output(chunk) => {
                assert!(index > 0, "output before Running");
                assert_eq!(chunk.generation, generation(launch));
                assert_eq!(chunk.seq.get(), next_seq, "output out of order");
                next_seq += 1;
            }
            Event::Detached(detached) => panic!("a subscriber was detached: {detached:?}"),
            Event::Exit(TerminalExit { last_seq, .. })
            | Event::Error(TerminalErrorEvent { last_seq, .. }) => {
                let expected = next_seq.checked_sub(1);
                assert_eq!(
                    last_seq.map(|s| s.get()),
                    expected,
                    "the end names the last chunk"
                );
                ended = true;
            }
        }
    }
    assert!(exiting <= 1, "Exiting reported {exiting} times");
    assert!(ended, "the generation never ended");
}

fn registered(terminals: &Terminals, session: &str) -> bool {
    terminals.find(&id(session)).is_some()
}

// --- The session runtime, with a real shell --------------------------------------------------

#[test]
fn a_real_shell_runs_a_command_and_every_event_follows_the_protocol() {
    const MARKER: &str = "yavin-terminal-works";
    let terminals = Terminals::default();
    let recorder = start(&terminals, "t-run", 1);

    type_in(&terminals, "t-run", 1, &format!("echo {MARKER}\r"));
    assert!(
        recorder.wait(Duration::from_secs(30), |r| r
            .text()
            .matches(MARKER)
            .count()
            >= 2),
        "the command did not run; saw {:?}",
        recorder.text()
    );

    close(
        &terminals,
        TerminalCloseRequest {
            session_id: id("t-run"),
            generation: generation(1),
        },
    );
    assert!(
        recorder.wait(Duration::from_secs(30), Recorder::ended),
        "never ended"
    );
    assert_protocol_order(&recorder.snapshot(), 1);
    // Reaped: the session is gone once its end is reported.
    assert!(!registered(&terminals, "t-run"));
}

#[test]
fn a_shell_that_exits_by_itself_is_reported_and_reaped() {
    // Typing `exit` must end the generation on every platform. With ConPTY the output pipe
    // stays open until the pseudoconsole is closed, so the end has to come from the process,
    // not from the reader running dry.
    let terminals = Terminals::default();
    let recorder = start(&terminals, "t-exit", 1);
    type_in(&terminals, "t-exit", 1, "exit 3\r");

    assert!(
        recorder.wait(Duration::from_secs(30), Recorder::ended),
        "the shell's own exit was never reported; saw {:?}",
        recorder.text()
    );
    let events = recorder.snapshot();
    assert_protocol_order(&events, 1);
    let Some(Event::Exit(exit)) = events.last() else {
        panic!("ended without an exit: {events:?}");
    };
    assert_eq!(exit.exit_code, Some(3));
    assert!(!registered(&terminals, "t-exit"));
}

/// The shell's process id, as its `Running` event reported it.
fn shell_pid(recorder: &Recorder) -> u32 {
    recorder
        .snapshot()
        .iter()
        .find_map(|event| match event {
            Event::State(TerminalStateChanged {
                state: LiveState::Running { pid },
                ..
            }) => *pid,
            _ => None,
        })
        .expect("Running reports the shell's pid")
}

/// Whether a process with this id exists, asked of the OS.
fn process_exists(pid: u32) -> bool {
    if cfg!(windows) {
        let listed = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output()
            .expect("tasklist runs");
        String::from_utf8_lossy(&listed.stdout).contains(&format!("\"{pid}\""))
    } else {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .is_ok_and(|status| status.success())
    }
}

/// A process the shell started in the background, appending to a file every ~100 ms until a
/// stop file appears. Dropping this creates the stop file, so even a process that escaped its
/// tree -- the failure these tests look for -- ends when its test does.
struct BackgroundWriter {
    file: PathBuf,
    stop: PathBuf,
}

impl BackgroundWriter {
    fn size(&self) -> u64 {
        std::fs::metadata(&self.file).map(|m| m.len()).unwrap_or(0)
    }
}

impl Drop for BackgroundWriter {
    fn drop(&mut self) {
        let _ = std::fs::write(&self.stop, "stop");
        thread::sleep(Duration::from_millis(500));
        let _ = std::fs::remove_file(&self.file);
        let _ = std::fs::remove_file(&self.stop);
    }
}

/// Has the shell start a `BackgroundWriter` and waits until it is running.
///
/// On Windows it gets a console of its own (`start /min`, not `start /b`): a process attached
/// to the terminal's pseudoconsole is ended by closing the pseudoconsole anyway, so only one
/// outside it shows that the process tree -- the Job Object -- is what ends it.
fn start_background_writer(
    terminals: &Terminals,
    session: &str,
    recorder: &Recorder,
    name: &str,
) -> BackgroundWriter {
    let base = env::temp_dir().join(format!("yavin-terminal-{name}-{}", std::process::id()));
    let writer = BackgroundWriter {
        file: base.with_extension("txt"),
        stop: base.with_extension("stop"),
    };
    let _ = std::fs::remove_file(&writer.file);
    let _ = std::fs::remove_file(&writer.stop);
    let (path, stop) = (writer.file.to_string_lossy(), writer.stop.to_string_lossy());
    let command = if cfg!(windows) {
        format!(
            "start \"\" /min cmd /d /c \"for /l %i in (0,0,1) do @((if exist \"{stop}\" exit) & echo x>>\"{path}\" & ping -n 1 -w 100 127.0.0.1 >nul)\"\r"
        )
    } else {
        format!("(while [ ! -e '{stop}' ]; do echo x >> '{path}'; sleep 0.1; done) &\r")
    };
    type_in(terminals, session, 1, &command);
    let deadline = Instant::now() + Duration::from_secs(20);
    while writer.size() < 10 && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(100));
    }
    assert!(
        writer.size() >= 10,
        "the background process never ran; saw {:?}",
        recorder.text()
    );
    writer
}

/// After a generation's end: the shell's process is gone, and the background process it
/// started has stopped (the file it appends to no longer grows) -- nothing is left orphaned.
fn assert_nothing_left(shell: u32, writer: &BackgroundWriter) {
    thread::sleep(Duration::from_millis(500));
    let after = writer.size();
    thread::sleep(Duration::from_millis(1500));
    assert_eq!(
        writer.size(),
        after,
        "a process the shell started outlived it"
    );
    assert!(
        !process_exists(shell),
        "the shell's process {shell} is still running"
    );
}

#[test]
fn killing_a_terminal_ends_everything_its_shell_started() {
    let terminals = Terminals::default();
    let recorder = start(&terminals, "t-tree", 1);
    let shell = shell_pid(&recorder);
    let writer = start_background_writer(&terminals, "t-tree", &recorder, "kill");

    kill(
        &terminals,
        TerminalKillRequest {
            session_id: id("t-tree"),
            generation: generation(1),
        },
    )
    .unwrap();
    assert!(
        recorder.wait(Duration::from_secs(30), Recorder::ended),
        "never ended"
    );
    assert_nothing_left(shell, &writer);
    assert_protocol_order(&recorder.snapshot(), 1);
    assert!(!registered(&terminals, "t-tree"));
}

#[test]
fn a_shell_that_exits_by_itself_takes_what_it_started_with_it() {
    let terminals = Terminals::default();
    let recorder = start(&terminals, "t-leave", 1);
    let shell = shell_pid(&recorder);
    let writer = start_background_writer(&terminals, "t-leave", &recorder, "exit");

    type_in(&terminals, "t-leave", 1, "exit\r");
    assert!(
        recorder.wait(Duration::from_secs(30), Recorder::ended),
        "the shell's own exit was never reported"
    );
    let events = recorder.snapshot();
    assert!(
        matches!(events.last(), Some(Event::Exit(_))),
        "ended without an exit: {events:?}"
    );
    assert_nothing_left(shell, &writer);
    assert_protocol_order(&events, 1);
    assert!(!registered(&terminals, "t-leave"));
}

#[test]
fn a_stale_generation_never_touches_the_current_launch() {
    let terminals = Terminals::default();
    let old = start(&terminals, "t-gen", 2);
    // A restart: generation 3 replaces generation 2, which ends.
    let current = open_recorded(&terminals, "t-gen", 3).unwrap();
    assert!(
        old.wait(Duration::from_secs(30), Recorder::ended),
        "the replaced launch never ended"
    );
    assert_protocol_order(&old.snapshot(), 2);

    // Requests naming generation 2 are refused or do nothing; generation 3 is untouched.
    let stale_write = write(
        &terminals,
        TerminalWriteRequest {
            session_id: id("t-gen"),
            generation: generation(2),
            data: "x".into(),
        },
    );
    assert_eq!(
        stale_write.unwrap_err().code,
        TerminalErrorCause::StaleGeneration
    );
    let stale_resize = resize(
        &terminals,
        TerminalResizeRequest {
            session_id: id("t-gen"),
            generation: generation(2),
            dimensions: TerminalDimensions::new(80, 24).unwrap(),
        },
    );
    assert_eq!(
        stale_resize.unwrap_err().code,
        TerminalErrorCause::StaleGeneration
    );
    close(
        &terminals,
        TerminalCloseRequest {
            session_id: id("t-gen"),
            generation: generation(2),
        },
    );
    kill(
        &terminals,
        TerminalKillRequest {
            session_id: id("t-gen"),
            generation: generation(2),
        },
    )
    .unwrap();
    // An open naming an older (or the same) generation is refused outright.
    for older in [1, 3] {
        let refused = open(
            &terminals,
            request("t-gen", older),
            launch(),
            (subscription("t-gen-refused", older), current.clone()),
        );
        assert_eq!(refused.unwrap_err().code, TerminalErrorCause::ProtocolError);
    }
    thread::sleep(Duration::from_millis(500));
    assert!(registered(&terminals, "t-gen"));
    assert!(!current.ended(), "a stale request ended the current launch");
    resize(
        &terminals,
        TerminalResizeRequest {
            session_id: id("t-gen"),
            generation: generation(3),
            dimensions: TerminalDimensions::new(100, 40).unwrap(),
        },
    )
    .unwrap();

    kill(
        &terminals,
        TerminalKillRequest {
            session_id: id("t-gen"),
            generation: generation(3),
        },
    )
    .unwrap();
    assert!(current.wait(Duration::from_secs(30), Recorder::ended));
}

#[test]
fn a_terminal_killed_before_its_shell_finished_starting_still_ends() {
    // Nothing answers ConPTY's first cursor-position query here, as when a terminal is closed
    // the moment it is created: its console host may never let the output end. The end is
    // reported anyway, after whatever output there was, and the session is reaped.
    let terminals = Terminals::default();
    let recorder = open_recorded(&terminals, "t-early", 1).unwrap();
    kill(
        &terminals,
        TerminalKillRequest {
            session_id: id("t-early"),
            generation: generation(1),
        },
    )
    .unwrap();
    assert!(
        recorder.wait(Duration::from_secs(30), Recorder::ended),
        "never ended"
    );
    let count = recorder.snapshot().len();
    thread::sleep(Duration::from_millis(500));
    assert_eq!(recorder.snapshot().len(), count, "an event after the end");
    assert_protocol_order(&recorder.snapshot(), 1);
    assert!(!registered(&terminals, "t-early"));
}

#[test]
fn entering_another_workspace_ends_the_previous_ones_shells() {
    let terminals = Terminals::default();
    let recorder = start(&terminals, "t-ws", 1);
    // The same workspace again changes nothing.
    end_other_workspaces(&terminals, Some(WORKSPACE));
    thread::sleep(Duration::from_millis(300));
    assert!(registered(&terminals, "t-ws"));

    end_other_workspaces(&terminals, Some("file://c:/elsewhere"));
    assert!(recorder.wait(Duration::from_secs(30), Recorder::ended));
    assert!(!registered(&terminals, "t-ws"));
}

#[test]
fn close_all_ends_every_session() {
    let terminals = Terminals::default();
    let one = start(&terminals, "t-all-1", 1);
    let two = start(&terminals, "t-all-2", 1);
    close_all(&terminals);
    assert!(one.wait(Duration::from_secs(30), Recorder::ended));
    assert!(two.wait(Duration::from_secs(30), Recorder::ended));
    assert!(terminals.registry().sessions.is_empty());
}

// --- The session runtime, without a shell ----------------------------------------------------

/// Stands in for a process that cannot be killed or waited on: these tests never start one.
#[derive(Debug, Clone)]
struct NoProcess;

impl ChildKiller for NoProcess {
    fn kill(&mut self) -> std::io::Result<()> {
        Ok(())
    }
    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(self.clone())
    }
}

/// A `Running` session whose input nobody reads.
fn stalled_session(terminals: &Terminals, session: &str) -> Receiver<Vec<u8>> {
    let (input, queued) = sync_channel(INPUT_QUEUE);
    let stream = OutputStream::start(
        id(session),
        generation(1),
        LIMITS.clone(),
        (subscription(session, 1), Arc::new(Recorder::default())),
    );
    let session = Arc::new(Session {
        id: id(session),
        generation: generation(1),
        workspace_id: WORKSPACE.into(),
        metadata: TerminalSessionMetadata {
            session_id: id(session),
            workspace_id: WORKSPACE.into(),
            profile: None,
            cwd: None,
        },
        started_at: 0,
        pid: None,
        input,
        master: Mutex::new(None),
        killer: Mutex::new(Box::new(NoProcess)),
        tree: ProcessTree::contain(None),
        state: Mutex::new(TerminalState::Running),
        dimensions: Mutex::new(TerminalDimensions::new(80, 24).unwrap()),
        stream,
    });
    terminals
        .registry()
        .sessions
        .insert(session.id.clone(), session);
    queued
}

#[test]
fn input_to_a_shell_that_stops_reading_is_refused_instead_of_blocking() {
    let terminals = Terminals::default();
    let _queued = stalled_session(&terminals, "t-stall");
    let started = Instant::now();
    for _ in 0..INPUT_QUEUE {
        type_in(&terminals, "t-stall", 1, "x");
    }
    let full = write(
        &terminals,
        TerminalWriteRequest {
            session_id: id("t-stall"),
            generation: generation(1),
            data: "x".into(),
        },
    );
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "a write waited on the shell"
    );
    let error = full.unwrap_err();
    assert_eq!(error.code, TerminalErrorCause::WriteFailed);
    // Another terminal is not held up by the stalled one.
    let _other = stalled_session(&terminals, "t-other");
    type_in(&terminals, "t-other", 1, "y");
}

#[test]
fn oversized_input_is_refused_before_it_is_queued() {
    let terminals = Terminals::default();
    let queued = stalled_session(&terminals, "t-big");
    let big = write(
        &terminals,
        TerminalWriteRequest {
            session_id: id("t-big"),
            generation: generation(1),
            data: "x".repeat(ide_terminal_protocol::MAX_WRITE_BYTES + 1),
        },
    );
    assert_eq!(big.unwrap_err().code, TerminalErrorCause::ProtocolError);
    assert!(queued.try_recv().is_err());
}

#[test]
fn requests_for_a_session_that_does_not_exist_are_typed() {
    let terminals = Terminals::default();
    let missing = write(
        &terminals,
        TerminalWriteRequest {
            session_id: id("nobody"),
            generation: generation(1),
            data: "x".into(),
        },
    );
    assert_eq!(
        missing.unwrap_err().code,
        TerminalErrorCause::InvalidSession
    );
    // Closing or killing nothing is not an error.
    close(
        &terminals,
        TerminalCloseRequest {
            session_id: id("nobody"),
            generation: generation(1),
        },
    );
    kill(
        &terminals,
        TerminalKillRequest {
            session_id: id("nobody"),
            generation: generation(1),
        },
    )
    .unwrap();
}

#[test]
fn a_launch_that_cannot_start_says_why_and_reports_no_events() {
    let terminals = Terminals::default();
    let recorder = Arc::new(Recorder::default());
    let refused = |request: TerminalOpenRequest, launch: Launch| {
        open(
            &terminals,
            request,
            launch,
            (subscription("t-bad", 1), recorder.clone()),
        )
        .unwrap_err()
    };

    let mut elsewhere = request("t-bad", 1);
    elsewhere.workspace_id = "file://c:/another".into();
    assert_eq!(
        refused(elsewhere, launch()).code,
        TerminalErrorCause::InvalidWorkspace
    );

    let mut unknown = request("t-bad", 2);
    unknown.profile = Some(TerminalProfile {
        id: "calc".into(),
        name: "Calculator".into(),
        executable: "C:/Windows/System32/calc.exe".into(),
        args: vec![],
        cwd: None,
        env: vec![],
    });
    assert_eq!(
        refused(unknown, launch()).code,
        TerminalErrorCause::ShellUnavailable
    );

    let mut nowhere = request("t-bad", 3);
    nowhere.cwd = Some("/definitely/not/here/at/all".into());
    assert_eq!(
        refused(nowhere, launch()).code,
        TerminalErrorCause::InvalidCwd
    );

    let mut bad_profile = request("t-bad", 4);
    bad_profile.profile = Some(TerminalProfile {
        id: "p".into(),
        name: "P".into(),
        executable: available_shells()[0].path.clone(),
        args: vec!["a\nb".into()],
        cwd: None,
        env: vec![],
    });
    assert_eq!(
        refused(bad_profile, launch()).code,
        TerminalErrorCause::ProtocolError
    );

    let no_shells = Launch {
        shells: vec![],
        ..launch()
    };
    let error = refused(request("t-bad", 5), no_shells);
    assert_eq!(error.code, TerminalErrorCause::ShellUnavailable);
    // As a command reports it: `"Cause: message"`, never raw OS text.
    let wire = String::from(error);
    assert!(wire.starts_with("ShellUnavailable: "), "{wire}");
    assert!(!wire.contains("os error"), "{wire}");

    assert!(
        recorder.snapshot().is_empty(),
        "a failed open reported events"
    );
    assert!(terminals.registry().sessions.is_empty());
}

// --- Shells and folders ----------------------------------------------------------------------

#[test]
fn only_a_detected_shell_can_be_started() {
    let shells = offered();
    // No request at all takes the first detected shell.
    assert_eq!(resolve_shell(None, &shells).unwrap(), shells[0].path);
    assert_eq!(resolve_shell(Some(""), &shells).unwrap(), shells[0].path);
    // A detected shell is accepted whatever its casing on disk.
    assert_eq!(
        resolve_shell(Some("c:/windows/system32/CMD.EXE"), &shells).unwrap(),
        shells[0].path
    );
    assert_eq!(
        resolve_shell(Some(r"C:\Windows\System32\cmd.exe"), &shells).unwrap(),
        shells[0].path
    );
    // Anything else is refused, including a real program that was never offered.
    for refused in [
        "C:/Windows/System32/calc.exe",
        "/bin/sh",
        "--upload-pack=touch",
    ] {
        assert_eq!(
            resolve_shell(Some(refused), &shells).unwrap_err().code,
            TerminalErrorCause::ShellUnavailable,
            "{refused} must be refused"
        );
    }
    assert!(resolve_shell(None, &[]).is_err());
}

#[test]
fn detection_finds_a_usable_shell_and_never_repeats_one() {
    let shells = available_shells();
    assert!(!shells.is_empty(), "this machine must offer a shell");
    for shell in &shells {
        assert!(
            Path::new(&shell.path).is_file(),
            "{} does not exist",
            shell.path
        );
        assert!(!shell.name.is_empty());
    }
    let mut paths: Vec<String> = shells.iter().map(|s| s.path.to_lowercase()).collect();
    paths.sort();
    let count = paths.len();
    paths.dedup();
    assert_eq!(paths.len(), count, "a shell was offered twice");
}

#[test]
fn a_terminal_starts_in_a_real_folder_or_says_why_not() {
    let dir = std::env::temp_dir().join(format!("yavin-cwd-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let fallback = std::env::current_dir().unwrap();

    // No request: the caller's fallback is used untouched.
    assert_eq!(resolve_cwd(None, fallback.clone()).unwrap(), fallback);
    assert_eq!(resolve_cwd(Some(""), fallback.clone()).unwrap(), fallback);

    // A real folder is accepted as given, not canonicalised. (What happens to a folder
    // that arrives in extended-length form is `a_shell_starts_in_the_workspace_root_...`.)
    let resolved = resolve_cwd(Some(&dir.to_string_lossy()), fallback.clone()).unwrap();
    assert_eq!(resolved, dir);

    // A file, and a folder that is not there, each fail by name rather than deep inside
    // the spawn with a message that identifies nothing.
    let file = dir.join("a.txt");
    std::fs::write(&file, "x").unwrap();
    let as_file = resolve_cwd(Some(&file.to_string_lossy()), fallback.clone()).unwrap_err();
    assert_eq!(as_file.code, TerminalErrorCause::InvalidCwd);
    assert!(as_file.message.contains("not a folder"));
    assert!(resolve_cwd(Some("/definitely/not/here/at/all"), fallback.clone()).is_err());
    assert!(resolve_cwd(Some("ok\u{0}evil"), fallback).is_err());

    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(windows)]
#[test]
fn a_shell_starts_in_the_workspace_root_rather_than_its_extended_length_form() {
    let dir = std::env::temp_dir().join(format!("yavin-cwd-root-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    // The workspace root, as `terminal_open` falls back to it: canonical, and so in the
    // extended-length form.
    let root = dir.canonicalize().unwrap();
    assert!(
        root.to_string_lossy().starts_with(r"\\?\"),
        "{}",
        root.display()
    );

    let cwd = resolve_cwd(None, root.clone()).unwrap();
    assert!(
        !cwd.to_string_lossy().starts_with(r"\\?\"),
        "{}",
        cwd.display()
    );
    assert!(cwd.is_dir());
    assert_eq!(cwd.canonicalize().unwrap(), root, "still the same folder");
    // A requested folder in that form is handled the same way.
    let requested = resolve_cwd(Some(&root.to_string_lossy()), PathBuf::new()).unwrap();
    assert_eq!(requested, cwd);

    // And a shell started the way `terminal_open` starts one really is in that folder.
    let printed = cmd_cd_in_pty(&cwd).to_lowercase();
    let expected = cwd.to_string_lossy().to_lowercase();
    assert!(
        printed.contains(&expected) && !printed.contains("unc paths are not supported"),
        "cmd.exe did not start in {expected}:\n{printed}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// What `cmd /c cd` prints when started in `cwd` through the same PTY and `CommandBuilder`
/// the terminal uses -- which, unlike `std::process::Command`, passes the directory to the
/// OS exactly as given.
#[cfg(windows)]
fn cmd_cd_in_pty(cwd: &Path) -> String {
    use std::sync::mpsc::{channel, RecvTimeoutError};

    let pair = native_pty_system()
        .openpty(pty_size(TerminalDimensions::new(200, 24).unwrap()))
        .unwrap();
    let mut command = CommandBuilder::new("cmd.exe");
    command.args(["/d", "/c", "cd"]);
    command.cwd(cwd);
    let mut child = pair.slave.spawn_command(command).unwrap();
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().unwrap();
    let mut writer = pair.master.take_writer().unwrap();
    let (sender, chunks) = channel();
    thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        while let Ok(count) = reader.read(&mut buffer) {
            if count == 0
                || sender
                    .send(String::from_utf8_lossy(&buffer[..count]).into_owned())
                    .is_err()
            {
                break;
            }
        }
    });

    let mut seen = String::new();
    let mut answered = false;
    let mut exited_at = None;
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        match chunks.recv_timeout(Duration::from_millis(100)) {
            Ok(text) => seen.push_str(&text),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        // ConPTY asks for the cursor position before it lets output through.
        if !answered && seen.contains("\u{1b}[6n") {
            writer.write_all(b"\x1b[1;1R").unwrap();
            writer.flush().unwrap();
            answered = true;
        }
        if exited_at.is_none() && matches!(child.try_wait(), Ok(Some(_))) {
            exited_at = Some(Instant::now());
        }
        // Output can trail the exit slightly; give it a moment, then stop.
        if exited_at.is_some_and(|at: Instant| at.elapsed() > Duration::from_millis(750)) {
            break;
        }
    }
    let _ = child.kill();
    seen
}

#[cfg(windows)]
#[test]
fn the_extended_length_prefix_is_kept_where_the_plain_form_would_name_something_else() {
    let same = |path: &str| process_cwd(PathBuf::from(path));
    assert_eq!(
        same(r"\\?\C:\Work\Project"),
        PathBuf::from(r"C:\Work\Project")
    );
    assert_eq!(same(r"\\?\C:\"), PathBuf::from(r"C:\"));
    assert_eq!(
        same(r"\\?\UNC\server\share\project"),
        PathBuf::from(r"\\server\share\project")
    );
    // Already plain: untouched.
    assert_eq!(same(r"C:\Work"), PathBuf::from(r"C:\Work"));
    assert_eq!(
        same(r"\\server\share\x"),
        PathBuf::from(r"\\server\share\x")
    );
    // Plain Win32 would trim the dot, or read a device, or overflow MAX_PATH: kept as is.
    for kept in [
        r"\\?\C:\Work\trailing.",
        r"\\?\C:\Work\trailing ",
        r"\\?\C:\Work\CON",
    ] {
        assert_eq!(same(kept), PathBuf::from(kept), "{kept}");
    }
    assert_eq!(
        same(r"\\?\C:\Work\com1.txt"),
        PathBuf::from(r"\\?\C:\Work\com1.txt")
    );
    assert_eq!(same(r"\\?\C:\Work\com0"), PathBuf::from(r"C:\Work\com0"));
    let long = format!(r"\\?\C:\{}", "a".repeat(300));
    assert_eq!(same(&long), PathBuf::from(&long));
}

#[cfg(not(windows))]
#[test]
fn a_working_directory_elsewhere_is_left_exactly_as_it_is() {
    // Without Windows path prefixes there is nothing to translate, and a name that looks
    // like one is just a (strange) relative file name.
    for path in ["/home/me/project", r"\\?\C:\x", "relative/dir"] {
        assert_eq!(process_cwd(PathBuf::from(path)), PathBuf::from(path));
    }
}

// --- TERMINAL-02: the output pipeline, with a real shell -------------------------------------

#[test]
fn a_real_shell_streaming_megabytes_stays_ordered_bounded_and_responsive() {
    // A file typed out by the shell: megabytes of output through the PTY, the pipeline and an
    // acknowledging subscriber. (ConPTY re-renders what the shell prints, so the bytes are not
    // the file's own; what is checked is the stream: numbering, bounds, and the end marker.)
    // Typed one way, printed another: only the shell's own output can contain the printed form,
    // never the echo of the command (which ConPTY may repaint).
    let (typed, printed) = if cfg!(windows) {
        ("yavin-%OS%-done", "yavin-Windows_NT-done")
    } else {
        ("yavin-$((6*7))-done", "yavin-42-done")
    };
    let terminals = Terminals::default();
    let recorder = start(&terminals, "t-big", 1);
    let file = env::temp_dir().join(format!("yavin-terminal-big-{}.txt", std::process::id()));
    let line = "0123456789abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ\r\n";
    std::fs::write(&file, line.repeat(4 * 1024 * 1024 / line.len())).unwrap();
    let command = if cfg!(windows) {
        format!("type \"{}\" & echo {typed}\r", file.display())
    } else {
        format!("cat '{}'; echo {typed}\r", file.display())
    };
    type_in(&terminals, "t-big", 1, &command);

    // Typing while the output streams is answered at once: the pipeline never holds the
    // commands up.
    let mut slowest = Duration::ZERO;
    let deadline = Instant::now() + Duration::from_secs(120);
    let finished = |r: &Recorder| r.text().contains(printed);
    while !finished(&recorder) && Instant::now() < deadline {
        let asked = Instant::now();
        let _ = stats(&terminals, &id("t-big"));
        resize(
            &terminals,
            TerminalResizeRequest {
                session_id: id("t-big"),
                generation: generation(1),
                dimensions: TerminalDimensions::new(120, 30).unwrap(),
            },
        )
        .unwrap();
        slowest = slowest.max(asked.elapsed());
        thread::sleep(Duration::from_millis(20));
    }
    assert!(
        finished(&recorder),
        "the output never finished; {} bytes so far",
        recorder.text().len()
    );
    assert!(
        slowest < Duration::from_millis(250),
        "a command waited {slowest:?}"
    );
    let stats = stats(&terminals, &id("t-big")).unwrap();
    assert!(
        stats.peak_queued_bytes <= LIMITS.ingress_high + READ_BUFFER,
        "peak {} past the bound",
        stats.peak_queued_bytes
    );
    let chunks: Vec<TerminalOutputChunk> = recorder
        .snapshot()
        .into_iter()
        .filter_map(|e| match e {
            Event::Output(chunk) => Some(chunk),
            _ => None,
        })
        .collect();
    assert!(chunks
        .iter()
        .all(|c| c.bytes.len() <= LIMITS.max_chunk_bytes));
    eprintln!(
        "real shell: {} KiB in {} chunks, peak queued {} KiB, slowest command {slowest:?}",
        chunks.iter().map(|c| c.bytes.len()).sum::<usize>() / 1024,
        chunks.len(),
        stats.peak_queued_bytes / 1024
    );

    kill(
        &terminals,
        TerminalKillRequest {
            session_id: id("t-big"),
            generation: generation(1),
        },
    )
    .unwrap();
    assert!(recorder.wait(Duration::from_secs(30), Recorder::ended));
    assert_protocol_order(&recorder.snapshot(), 1);
    let _ = std::fs::remove_file(&file);
}

#[test]
fn a_second_subscriber_gets_its_own_stream_and_leaving_it_ends_nothing() {
    let terminals = Terminals::default();
    let first = start(&terminals, "t-two", 1);
    let second_id = SubscriptionId::new("t-two-second").unwrap();
    let second = Arc::new(Recorder::default());
    *second.acks.lock().unwrap() = Some((terminals.clone(), second_id.clone()));
    subscribe(
        &terminals,
        TerminalSubscribeRequest {
            subscription_id: second_id.clone(),
            session_id: id("t-two"),
            generation: generation(1),
        },
        second.clone(),
    )
    .unwrap();
    // The same id twice, or a stale generation, is refused.
    let again = subscribe(
        &terminals,
        TerminalSubscribeRequest {
            subscription_id: second_id.clone(),
            session_id: id("t-two"),
            generation: generation(1),
        },
        second.clone(),
    );
    assert_eq!(again.unwrap_err().code, TerminalErrorCause::ProtocolError);
    let stale = subscribe(
        &terminals,
        TerminalSubscribeRequest {
            subscription_id: SubscriptionId::new("t-two-stale").unwrap(),
            session_id: id("t-two"),
            generation: generation(9),
        },
        second.clone(),
    );
    assert_eq!(stale.unwrap_err().code, TerminalErrorCause::StaleGeneration);

    type_in(&terminals, "t-two", 1, "echo both-see-this\r");
    for recorder in [&first, &second] {
        assert!(recorder.wait(Duration::from_secs(30), |r| r
            .text()
            .matches("both-see-this")
            .count()
            >= 2));
    }
    // The second numbers its own stream from where it joined: no gaps from then on.
    let seqs: Vec<u64> = second
        .snapshot()
        .into_iter()
        .filter_map(|e| match e {
            Event::Output(c) => Some(c.seq.get()),
            _ => None,
        })
        .collect();
    assert!(seqs.windows(2).all(|w| w[1] == w[0] + 1), "{seqs:?}");

    // Leaving ends that subscription only.
    unsubscribe(
        &terminals,
        TerminalUnsubscribeRequest {
            subscription_id: second_id.clone(),
        },
    );
    type_in(&terminals, "t-two", 1, "echo only-first\r");
    assert!(first.wait(Duration::from_secs(30), |r| r
        .text()
        .matches("only-first")
        .count()
        >= 2));
    assert!(!second.text().contains("only-first"));
    assert!(registered(&terminals, "t-two"));

    kill(
        &terminals,
        TerminalKillRequest {
            session_id: id("t-two"),
            generation: generation(1),
        },
    )
    .unwrap();
    assert!(first.wait(Duration::from_secs(30), Recorder::ended));
    // A late acknowledgement, after the end, is harmless; one for no subscription is not.
    let last = first
        .snapshot()
        .into_iter()
        .rev()
        .filter_map(|e| match e {
            Event::Output(c) => Some(c.seq),
            _ => None,
        })
        .next()
        .unwrap();
    ack(
        &terminals,
        TerminalAckRequest {
            subscription_id: subscription("t-two", 1),
            session_id: id("t-two"),
            generation: generation(1),
            seq: last,
        },
    )
    .unwrap();
    let unknown = ack(
        &terminals,
        TerminalAckRequest {
            subscription_id: SubscriptionId::new("never-subscribed").unwrap(),
            session_id: id("t-two"),
            generation: generation(1),
            seq: last,
        },
    );
    assert_eq!(
        unknown.unwrap_err().code,
        TerminalErrorCause::InvalidSession
    );
}
