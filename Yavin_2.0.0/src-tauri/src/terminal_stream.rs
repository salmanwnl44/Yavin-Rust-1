//! The terminal's output pipeline (TERMINAL-02): from the PTY reader to every subscriber, in
//! order, bounded, with backpressure and cumulative acknowledgements.
//!
//! ```text
//! PTY ─> reader ─push─> pending (bounded) ─pump─> sealed entries (shared, bounded)
//!                                                   ├─ subscriber A: cursor, in-flight window ─> its channel
//!                                                   └─ subscriber B: cursor, in-flight window ─> its channel
//!                         reader pauses <─ queued bytes ≥ INGRESS_HIGH, resumes ≤ INGRESS_LOW
//!                         a subscriber's window refills <─ ACK(generation, seq), cumulative
//! ```
//!
//! - The reader only appends bytes; it never serializes, never delivers, never waits on a
//!   subscriber -- only on the bound below, which is the backpressure: while it waits, the PTY
//!   fills and the program writing to it blocks, so no byte is ever dropped to keep up.
//! - One pump thread per generation seals what is pending into numbered chunks (at most
//!   `MAX_CHUNK_BYTES`, after `MAX_BATCH_LATENCY` or `MAX_BATCH_READS` reads at the latest),
//!   serializes each message once, and hands it to every subscriber whose window has room. It
//!   sends outside the lock; it is the only sender, so every subscriber sees one ordered stream.
//! - Entries are kept, shared by every subscriber, only until every subscriber has been sent
//!   them. A subscriber's "queue" is its cursor into them, plus what it has been sent and has
//!   not acknowledged (its in-flight window).
//! - Lifecycle messages travel in the same ordered stream as output, so each subscriber sees
//!   `Running`, the output in order, `Exiting`, then exactly one end -- after all the output.
//!
//! Three regimes, never confused:
//!
//! - **Normal**: every byte reaches every subscriber.
//! - **Backpressured**: the reader is paused until subscribers acknowledge; nothing is lost.
//! - **Overflow**: a subscriber that has fallen behind the others and kept the reader paused for
//!   `STALL_TIMEOUT` would otherwise need unbounded memory or a hole in its stream. It is
//!   detached instead, with a `detached` message saying how far it got (`OutputOverflow`), and
//!   the others carry on. A sole subscriber is never detached for being slow: it is simply
//!   backpressured -- unless it has stopped acknowledging altogether for
//!   `UNRESPONSIVE_TIMEOUT`, when it is detached (`SubscriberFailed`) so a broken view cannot hold
//!   its terminal (and its end) for ever.
//!
//! Replay (TERMINAL-03) is kept apart from that flow-control buffering: a bounded ring of the
//! most recent sealed messages (`REPLAY_BYTES` of output, the same shared messages subscribers
//! are sent -- nothing is copied), plus the generation's `Running` message and its end. A view
//! that attaches is sent the ring and then continues live from exactly where the ring stops, so
//! it sees nothing twice and misses nothing the ring still holds. The ring outlives the
//! generation's end until the session is released, so a view can attach to a session that has
//! exited. A *lifecycle* subscriber (the workspace's TerminalService) is sent only lifecycle
//! messages: it never holds output back and never counts as anyone's laggard. Nothing logs
//! terminal content.

use crate::terminal_shell::{host_name, OscScanner};
use ide_terminal_protocol::{
    Generation, LiveState, Sequence, SubscriptionId, TerminalDetached, TerminalError,
    TerminalErrorCause, TerminalErrorEvent, TerminalExit, TerminalId, TerminalMessage,
    TerminalOutputChunk, TerminalShellEvent, TerminalStateChanged, FIRST_SEQUENCE,
};
use serde::Serialize;
use std::{
    collections::VecDeque,
    sync::{Arc, Condvar, Mutex, MutexGuard},
    thread,
    time::{Duration, Instant},
};

/// The pipeline's bounds. One set for the application (`LIMITS`); the tests use smaller ones.
#[derive(Clone, Debug)]
pub struct Limits {
    /// The largest output chunk, and so the largest batch. 64 KiB matches the largest input
    /// request (`MAX_WRITE_BYTES`); xterm parses that much in well under a frame, and the base64
    /// message it becomes (~88 KiB) still goes through the transport's fast path in one piece.
    pub max_chunk_bytes: usize,
    /// How many PTY reads one batch may gather before it is sent anyway: many tiny writes (a
    /// progress bar) become one message, not hundreds.
    pub max_batch_reads: usize,
    /// How long the first byte of a batch may wait for more. Short enough that typing echoes
    /// without a visible delay; long enough that a burst becomes a few messages. (Windows timer
    /// resolution can stretch it to ~16 ms.)
    pub max_batch_latency: Duration,
    /// Output not yet sent to every subscriber (pending plus sealed), past which the reader
    /// stops reading: the memory one terminal's output may hold.
    pub ingress_high: usize,
    /// Where the reader resumes. Well below the high mark, so a paused reader resumes with room
    /// for a burst rather than toggling on every chunk.
    pub ingress_low: usize,
    /// Output sent to one subscriber and not yet acknowledged, past which it is sent no more:
    /// how much can be in its transport and its terminal's parser at once.
    pub subscriber_high: usize,
    /// Where a subscriber is sent output again.
    pub subscriber_low: usize,
    /// How long a subscriber that is behind another may keep the reader paused before it is
    /// detached (`OutputOverflow`), so one slow view never holds up the others.
    pub stall_timeout: Duration,
    /// How long a subscriber with a full window may go without acknowledging anything before
    /// it is taken to have stopped and is detached (`SubscriberFailed`) -- even a sole one, so a
    /// broken view cannot pause its terminal for ever. Long, so a slow (or throttled, hidden)
    /// view that is still acknowledging is never mistaken for a dead one.
    pub unresponsive_timeout: Duration,
    /// Recent output kept for views that attach later (replay): enough to redraw a terminal's
    /// screen and its recent scrollback, never a history. At most one subscriber window, so a
    /// replay never has to wait on acknowledgements to be sent.
    pub replay_bytes: usize,
}

pub const LIMITS: Limits = Limits {
    max_chunk_bytes: 64 * 1024,
    max_batch_reads: 32,
    max_batch_latency: Duration::from_millis(5),
    ingress_high: 1024 * 1024,
    ingress_low: 256 * 1024,
    subscriber_high: 512 * 1024,
    subscriber_low: 128 * 1024,
    stall_timeout: Duration::from_secs(5),
    unresponsive_timeout: Duration::from_secs(30),
    replay_bytes: 256 * 1024,
};

/// Where one subscriber's messages go: its window's channel, or a test's recorder.
pub trait Sink: Send + Sync + 'static {
    /// Hands one serialized `TerminalMessage` to the transport. `false` when the transport is
    /// gone (its window closed): the subscriber is then removed, as a normal end.
    fn send(&self, message: &str) -> bool;
}

/// What a subscriber is sent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Delivery {
    /// Everything: output (under flow control) and lifecycle. A view.
    Output,
    /// Lifecycle only -- state changes and the end. The workspace's TerminalService, which keeps
    /// a session's state whether or not a view is attached.
    Lifecycle,
}

/// How a generation ended.
pub enum End {
    Exit(Option<i32>),
    Error(TerminalError),
}

enum Pending {
    Bytes(Vec<u8>),
    Live(TerminalStateChanged),
    /// A shell-integration signal (TERMINAL-05A), after the bytes that carried it.
    Shell(TerminalShellEvent),
    End(End),
}

/// What one subscriber is about to be sent, outside the lock: who, where, and the messages.
type Outgoing = (SubscriptionId, Arc<dyn Sink>, Vec<Arc<str>>);

/// One sealed message, shared by every subscriber that has yet to be sent it (and by the replay
/// ring).
#[derive(Clone)]
struct Entry {
    /// For output: its sequence number and size.
    output: Option<(u64, usize)>,
    role: Role,
    encoded: Arc<str>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Role {
    Output,
    Running,
    Exiting,
    End,
    /// Shell integration: delivered live, never replayed (the service keeps what it meant).
    Shell,
}

struct Subscriber {
    id: SubscriptionId,
    sink: Arc<dyn Sink>,
    /// The absolute index of the next entry to send it.
    next: u64,
    sent_seq: Option<u64>,
    acked_seq: Option<u64>,
    /// Sent and not acknowledged: (seq, bytes), oldest first.
    in_flight: VecDeque<(u64, usize)>,
    in_flight_bytes: usize,
    /// Its window is full: nothing more until it is back under `subscriber_low`.
    throttled: bool,
    /// When it last acknowledged something (or subscribed).
    last_progress: Instant,
    lifecycle_only: bool,
    /// Sent before anything live: the replay it attached with.
    preamble: VecDeque<Entry>,
}

#[derive(Default)]
struct State {
    pending: VecDeque<Pending>,
    pending_bytes: usize,
    pending_reads: usize,
    pending_since: Option<Instant>,
    /// Being sealed by the pump right now: still counted against the bound.
    sealing_bytes: usize,
    entries: VecDeque<Entry>,
    /// The absolute index of `entries[0]`.
    first_index: u64,
    retained_bytes: usize,
    next_seq: u64,
    subscribers: Vec<Subscriber>,
    /// Subscriptions that ended (sent the end, detached, unsubscribed, or their window went): an
    /// acknowledgement arriving from one late is harmless, not an error.
    retired: Vec<SubscriptionId>,
    input_closed: bool,
    /// The end has been sealed.
    ended: bool,
    /// Every subscriber has been sent the end (or removed): the stream is over.
    finished: bool,
    reader_paused: bool,
    paused_since: Option<Instant>,
    peak_queued: usize,
    /// The most recent output and `Exiting`, oldest first, for views that attach later.
    replay: VecDeque<Entry>,
    replay_bytes: usize,
    running: Option<Entry>,
    end: Option<Entry>,
    /// The session was closed: nothing more is kept or handed out.
    released: bool,
}

impl State {
    fn queued(&self) -> usize {
        self.pending_bytes + self.sealing_bytes + self.retained_bytes
    }
}

/// What a stream is doing, for development and tests. Never terminal content.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamStats {
    pub generation: Generation,
    /// Output held for subscribers: pending plus sealed and not yet sent to all.
    pub queued_bytes: usize,
    pub peak_queued_bytes: usize,
    pub highest_seq: Option<u64>,
    pub backpressured: bool,
    pub ended: bool,
    pub finished: bool,
    /// Output kept for replay.
    pub replay_bytes: usize,
    pub subscribers: Vec<SubscriberStats>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriberStats {
    pub subscription_id: SubscriptionId,
    pub sent_seq: Option<u64>,
    pub acked_seq: Option<u64>,
    pub in_flight_bytes: usize,
    pub throttled: bool,
    pub lifecycle_only: bool,
}

/// One generation's output, from its reader to its subscribers.
pub struct OutputStream {
    session_id: TerminalId,
    generation: Generation,
    limits: Limits,
    state: Mutex<State>,
    changed: Condvar,
    /// Finds shell-integration sequences in the output, once, as it is pushed (only the reader
    /// pushes, so this is never contended).
    scanner: Mutex<OscScanner>,
}

fn encode(message: &TerminalMessage) -> Arc<str> {
    // Serializing the contract's own types cannot fail; an empty message would be refused by
    // every consumer's parser rather than misread.
    serde_json::to_string(message).unwrap_or_default().into()
}

impl OutputStream {
    /// A stream with its first subscriber already attached, so not a byte is produced before
    /// someone is there to receive it. Starts its pump.
    pub fn start(
        session_id: TerminalId,
        generation: Generation,
        limits: Limits,
        first: (SubscriptionId, Arc<dyn Sink>, Delivery),
    ) -> Arc<OutputStream> {
        let stream = Arc::new(OutputStream {
            session_id,
            generation,
            limits,
            state: Mutex::new(State::default()),
            changed: Condvar::new(),
            scanner: Mutex::new(OscScanner::new(host_name())),
        });
        stream
            .subscribe(first.0, first.1, first.2, false)
            .expect("a new stream takes its first subscriber");
        let pump = stream.clone();
        thread::spawn(move || pump.pump());
        stream
    }

    pub fn generation(&self) -> Generation {
        self.generation
    }

    /// Every subscriber has been sent the end: nothing of this stream is held any more.
    pub fn is_finished(&self) -> bool {
        self.lock().finished
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    // --- The reader's side --------------------------------------------------------------------

    /// Takes one PTY read, waiting while the stream is at its bound. `false` once the input is
    /// closed: the reader stops.
    pub fn push(&self, bytes: &[u8]) -> bool {
        let found = self
            .scanner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .feed(bytes);
        let mut state = self.lock();
        while state.reader_paused && !state.input_closed {
            state = self.changed.wait(state).unwrap_or_else(|e| e.into_inner());
        }
        if state.input_closed {
            return false;
        }
        // The bytes, unchanged; each shell-integration signal goes right after the bytes that
        // ended its sequence, so it is delivered in order with the output.
        let mut from = 0;
        for (end, signal) in found {
            Self::append(&mut state, &bytes[from..end]);
            from = end;
            state.pending.push_back(Pending::Shell(TerminalShellEvent {
                session_id: self.session_id.clone(),
                generation: self.generation,
                signal: signal.signal,
                uri: signal.uri,
                local: signal.local,
                exit_code: signal.exit_code,
            }));
        }
        Self::append(&mut state, &bytes[from..]);
        state.pending_reads += 1;
        state.pending_since.get_or_insert_with(Instant::now);
        if state.queued() >= self.limits.ingress_high {
            state.reader_paused = true;
            state.paused_since.get_or_insert_with(Instant::now);
        }
        state.peak_queued = state.peak_queued.max(state.queued());
        self.changed.notify_all();
        true
    }

    fn append(state: &mut State, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        match state.pending.back_mut() {
            Some(Pending::Bytes(tail)) => tail.extend_from_slice(bytes),
            _ => state.pending.push_back(Pending::Bytes(bytes.to_vec())),
        }
        state.pending_bytes += bytes.len();
    }

    /// Whether the reader is waiting on subscribers (the stream is backpressured).
    pub fn reader_paused(&self) -> bool {
        self.lock().reader_paused
    }

    /// A lifecycle step, in order with the output read before it.
    pub fn live(&self, event: TerminalStateChanged) {
        let mut state = self.lock();
        if state.input_closed {
            return;
        }
        state.pending.push_back(Pending::Live(event));
        self.changed.notify_all();
    }

    /// No more output: the reader is told to stop.
    pub fn close_input(&self) {
        let mut state = self.lock();
        state.input_closed = true;
        self.changed.notify_all();
    }

    /// Ends the generation: after everything already read, every subscriber is sent exactly one
    /// end, then the stream releases everything.
    pub fn finish(&self, end: End) {
        let mut state = self.lock();
        if state.pending.iter().any(|p| matches!(p, Pending::End(_))) || state.ended {
            return;
        }
        state.input_closed = true;
        state.pending.push_back(Pending::End(end));
        self.changed.notify_all();
    }

    /// Waits until every subscriber has been sent the end, or `timeout`. For tests.
    #[cfg(test)]
    pub fn wait_finished(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut state = self.lock();
        while !state.finished {
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            state = self
                .changed
                .wait_timeout(state, deadline - now)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        true
    }

    // --- The subscribers' side ----------------------------------------------------------------

    /// Adds a subscriber. With `replay`, it is first sent what the replay ring holds -- the
    /// generation's `Running`, its recent output and `Exiting`, and its end if it has ended --
    /// then everything sealed from now on, so it sees each message once. A session that has
    /// ended can still be attached to: the subscriber is sent the replay and the end.
    pub fn subscribe(
        &self,
        id: SubscriptionId,
        sink: Arc<dyn Sink>,
        delivery: Delivery,
        replay: bool,
    ) -> Result<(), TerminalError> {
        let mut state = self.lock();
        if state.released {
            return Err(TerminalError::new(
                TerminalErrorCause::InvalidSession,
                "That terminal has been closed.",
            ));
        }
        if state.subscribers.iter().any(|s| s.id == id) || state.retired.contains(&id) {
            return Err(TerminalError::protocol("That subscription already exists."));
        }
        let lifecycle_only = delivery == Delivery::Lifecycle;
        let mut preamble = VecDeque::new();
        if replay {
            preamble.extend(state.running.clone());
            preamble.extend(
                state
                    .replay
                    .iter()
                    .filter(|e| !(lifecycle_only && e.role == Role::Output))
                    .cloned(),
            );
            preamble.extend(state.end.clone());
        }
        // Over already, and its pump gone: the replay is all there is, handed over now.
        if state.finished {
            state.retired.push(id);
            drop(state);
            for entry in preamble {
                if !sink.send(&entry.encoded) {
                    break;
                }
            }
            return Ok(());
        }
        let next = state.first_index + state.entries.len() as u64;
        state.subscribers.push(Subscriber {
            id,
            sink,
            next,
            sent_seq: None,
            acked_seq: None,
            in_flight: VecDeque::new(),
            in_flight_bytes: 0,
            throttled: false,
            last_progress: Instant::now(),
            lifecycle_only,
            preamble,
        });
        self.changed.notify_all();
        Ok(())
    }

    /// The session was closed: the replay is dropped and nobody can attach any more.
    pub fn release(&self) {
        let mut state = self.lock();
        state.released = true;
        state.replay.clear();
        state.replay_bytes = 0;
        state.running = None;
        state.end = None;
        self.changed.notify_all();
    }

    /// Removes a subscriber and everything held only for it. `false` if it was not here.
    pub fn unsubscribe(&self, id: &SubscriptionId) -> bool {
        let mut state = self.lock();
        let before = state.subscribers.len();
        state.subscribers.retain(|s| &s.id != id);
        let removed = state.subscribers.len() != before;
        if removed {
            state.retired.push(id.clone());
            self.changed.notify_all();
        }
        removed
    }

    #[cfg(test)]
    pub fn has_subscriber(&self, id: &SubscriptionId) -> bool {
        self.lock().subscribers.iter().any(|s| &s.id == id)
    }

    /// A cumulative acknowledgement: everything through `seq` has been accepted.
    pub fn ack(
        &self,
        id: &SubscriptionId,
        generation: Generation,
        seq: Sequence,
    ) -> Result<(), TerminalError> {
        if generation != self.generation {
            return Err(TerminalError::new(
                TerminalErrorCause::StaleGeneration,
                "That acknowledgement is for an earlier launch of this terminal.",
            ));
        }
        let limits_low = self.limits.subscriber_low;
        let mut state = self.lock();
        if state.retired.contains(id) {
            return Ok(()); // late, after its stream ended: nothing left to release
        }
        let Some(subscriber) = state.subscribers.iter_mut().find(|s| &s.id == id) else {
            return Err(TerminalError::new(
                TerminalErrorCause::InvalidSession,
                "There is no such subscription.",
            ));
        };
        let seq = seq.get();
        if subscriber.sent_seq.is_none_or(|sent| seq > sent) {
            return Err(TerminalError::protocol(
                "That acknowledgement is for output that was never sent.",
            ));
        }
        if subscriber.acked_seq.is_some_and(|acked| seq <= acked) {
            return Ok(()); // a duplicate, or one overtaken by a later one
        }
        subscriber.acked_seq = Some(seq);
        while subscriber
            .in_flight
            .front()
            .is_some_and(|&(sent, _)| sent <= seq)
        {
            let (_, len) = subscriber.in_flight.pop_front().unwrap_or_default();
            subscriber.in_flight_bytes -= len;
        }
        if subscriber.in_flight_bytes <= limits_low {
            subscriber.throttled = false;
        }
        subscriber.last_progress = Instant::now();
        self.changed.notify_all();
        Ok(())
    }

    pub fn stats(&self) -> StreamStats {
        let state = self.lock();
        StreamStats {
            generation: self.generation,
            queued_bytes: state.queued(),
            peak_queued_bytes: state.peak_queued,
            highest_seq: state.next_seq.checked_sub(1),
            backpressured: state.reader_paused,
            ended: state.ended,
            finished: state.finished,
            replay_bytes: state.replay_bytes,
            subscribers: state
                .subscribers
                .iter()
                .map(|s| SubscriberStats {
                    subscription_id: s.id.clone(),
                    sent_seq: s.sent_seq,
                    acked_seq: s.acked_seq,
                    in_flight_bytes: s.in_flight_bytes,
                    throttled: s.throttled,
                    lifecycle_only: s.lifecycle_only,
                })
                .collect(),
        }
    }

    // --- The pump -----------------------------------------------------------------------------

    fn pump(self: Arc<Self>) {
        let limits = self.limits.clone();
        let mut state = self.lock();
        loop {
            // 1. Seal what is due, in order.
            let now = Instant::now();
            let due = state
                .pending
                .iter()
                .any(|p| !matches!(p, Pending::Bytes(_)))
                || state.pending_bytes >= limits.max_chunk_bytes
                || state.pending_reads >= limits.max_batch_reads
                || state
                    .pending_since
                    .is_some_and(|since| now - since >= limits.max_batch_latency)
                || (state.input_closed && state.pending_bytes > 0);
            if due && !state.pending.is_empty() {
                state = self.seal(state);
            }

            // 2. Deliver what each subscriber's window allows, outside the lock.
            state = self.deliver(state);

            // 3. Release what every subscriber has been sent, and let the reader go on.
            Self::trim(&mut state);
            if state.reader_paused && state.queued() <= limits.ingress_low {
                state.reader_paused = false;
                state.paused_since = None;
            } else if !state.reader_paused && state.queued() >= limits.ingress_high {
                state.reader_paused = true;
                state.paused_since = Some(Instant::now());
            }

            // 4. The last resort: detach a subscriber holding up the others, or one that stopped
            //    acknowledging at the end.
            state = self.detach_stalled(state);

            // 5. Over once the end has gone to everyone.
            if state.ended && state.subscribers.is_empty() && state.pending.is_empty() {
                state.finished = true;
                state.entries.clear();
                state.retained_bytes = 0;
                self.changed.notify_all();
                return;
            }
            self.changed.notify_all();

            // 6. Wait for more to do.
            let wait = match state.pending_since {
                Some(since) if !state.pending.is_empty() => limits
                    .max_batch_latency
                    .saturating_sub(since.elapsed())
                    .max(Duration::from_millis(1)),
                _ if state.reader_paused
                    || state.ended
                    || state.subscribers.iter().any(|s| s.throttled) =>
                {
                    Duration::from_millis(100)
                }
                _ => Duration::from_millis(500),
            };
            if !state
                .pending
                .iter()
                .any(|p| !matches!(p, Pending::Bytes(_)))
            {
                state = self
                    .changed
                    .wait_timeout(state, wait)
                    .unwrap_or_else(|e| e.into_inner())
                    .0;
            }
        }
    }

    /// Turns everything pending into entries: bytes into numbered chunks of at most
    /// `max_chunk_bytes`, lifecycle steps into their messages, the end into the end. Encodes
    /// outside the lock; only the pump appends entries, so order is kept.
    fn seal<'a>(&'a self, mut state: MutexGuard<'a, State>) -> MutexGuard<'a, State> {
        let taken: Vec<Pending> = state.pending.drain(..).collect();
        state.sealing_bytes = state.pending_bytes;
        state.pending_bytes = 0;
        state.pending_reads = 0;
        state.pending_since = None;
        let mut next_seq = state.next_seq;
        let mut sealed_end = false;
        drop(state);

        let mut entries = Vec::new();
        for item in taken {
            match item {
                Pending::Bytes(bytes) => {
                    for piece in bytes.chunks(self.limits.max_chunk_bytes) {
                        let seq = next_seq;
                        next_seq += 1;
                        let message = TerminalMessage::Output(TerminalOutputChunk {
                            session_id: self.session_id.clone(),
                            generation: self.generation,
                            seq: Sequence::new(seq).unwrap_or(FIRST_SEQUENCE),
                            bytes: piece.to_vec(),
                        });
                        entries.push(Entry {
                            output: Some((seq, piece.len())),
                            role: Role::Output,
                            encoded: encode(&message),
                        });
                    }
                }
                Pending::Shell(event) => entries.push(Entry {
                    output: None,
                    role: Role::Shell,
                    encoded: encode(&TerminalMessage::Shell(event)),
                }),
                Pending::Live(event) => entries.push(Entry {
                    output: None,
                    role: match event.state {
                        LiveState::Running { .. } => Role::Running,
                        LiveState::Exiting => Role::Exiting,
                    },
                    encoded: encode(&TerminalMessage::State(event)),
                }),
                Pending::End(end) => {
                    let last_seq = next_seq
                        .checked_sub(1)
                        .and_then(|seq| Sequence::new(seq).ok());
                    let message = match end {
                        End::Exit(exit_code) => TerminalMessage::Exit(TerminalExit {
                            session_id: self.session_id.clone(),
                            generation: self.generation,
                            exit_code,
                            last_seq,
                        }),
                        End::Error(error) => TerminalMessage::Error(TerminalErrorEvent {
                            session_id: self.session_id.clone(),
                            generation: self.generation,
                            error,
                            last_seq,
                        }),
                    };
                    entries.push(Entry {
                        output: None,
                        role: Role::End,
                        encoded: encode(&message),
                    });
                    sealed_end = true;
                    // Nothing of a generation follows its end.
                    break;
                }
            }
        }

        let mut state = self.lock();
        state.sealing_bytes = 0;
        state.next_seq = next_seq;
        for entry in entries {
            if let Some((_, len)) = entry.output {
                state.retained_bytes += len;
            }
            if !state.released {
                match entry.role {
                    Role::Running => state.running = Some(entry.clone()),
                    Role::End => state.end = Some(entry.clone()),
                    Role::Shell => {}
                    Role::Output | Role::Exiting => {
                        if let Some((_, len)) = entry.output {
                            state.replay_bytes += len;
                        }
                        state.replay.push_back(entry.clone());
                        while state.replay_bytes > self.limits.replay_bytes {
                            let Some(old) = state.replay.pop_front() else {
                                break;
                            };
                            if let Some((_, len)) = old.output {
                                state.replay_bytes -= len;
                            }
                        }
                    }
                }
            }
            state.entries.push_back(entry);
        }
        if sealed_end {
            state.ended = true;
            state.pending.clear();
            state.pending_bytes = 0;
        }
        state.peak_queued = state.peak_queued.max(state.queued());
        state
    }

    fn deliver<'a>(&'a self, mut state: MutexGuard<'a, State>) -> MutexGuard<'a, State> {
        let high = self.limits.subscriber_high;
        let first = state.first_index;
        let total = first + state.entries.len() as u64;
        let mut batches: Vec<Outgoing> = Vec::new();
        let State {
            subscribers,
            entries,
            ..
        } = &mut *state;
        for subscriber in subscribers.iter_mut() {
            let mut sending = Vec::new();
            // The replay it attached with comes first; it is bounded by one window.
            for entry in subscriber.preamble.drain(..) {
                if let Some((seq, len)) = entry.output {
                    subscriber.sent_seq = Some(seq);
                    subscriber.in_flight.push_back((seq, len));
                    subscriber.in_flight_bytes += len;
                }
                sending.push(entry.encoded);
            }
            while subscriber.next < total {
                let entry = &entries[(subscriber.next - first) as usize];
                if subscriber.lifecycle_only && entry.output.is_some() {
                    subscriber.next += 1;
                    continue;
                }
                if let Some((seq, len)) = entry.output {
                    if subscriber.throttled || subscriber.in_flight_bytes >= high {
                        subscriber.throttled = true;
                        break;
                    }
                    subscriber.sent_seq = Some(seq);
                    subscriber.in_flight.push_back((seq, len));
                    subscriber.in_flight_bytes += len;
                }
                sending.push(entry.encoded.clone());
                subscriber.next += 1;
            }
            if !sending.is_empty() {
                batches.push((subscriber.id.clone(), subscriber.sink.clone(), sending));
            }
        }
        if batches.is_empty() {
            return state;
        }
        drop(state);

        let mut gone = Vec::new();
        for (id, sink, messages) in batches {
            if !messages.iter().all(|message| sink.send(message)) {
                gone.push(id);
            }
        }

        let mut state = self.lock();
        // A transport that has gone is a window that closed: a normal end, not an error. A
        // subscriber that has been sent the end is done.
        let total = state.first_index + state.entries.len() as u64;
        let ended = state.ended;
        let (done, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut state.subscribers)
            .into_iter()
            .partition(|s| gone.contains(&s.id) || (ended && s.next >= total));
        state.subscribers = kept;
        state.retired.extend(done.into_iter().map(|s| s.id));
        state
    }

    fn trim(state: &mut State) {
        let end = state.first_index + state.entries.len() as u64;
        let keep_from = state
            .subscribers
            .iter()
            .map(|s| s.next)
            .min()
            .unwrap_or(end);
        while state.first_index < keep_from {
            let Some(entry) = state.entries.pop_front() else {
                break;
            };
            if let Some((_, len)) = entry.output {
                state.retained_bytes -= len;
            }
            state.first_index += 1;
        }
    }

    fn detach_stalled<'a>(&'a self, mut state: MutexGuard<'a, State>) -> MutexGuard<'a, State> {
        let stall = self.limits.stall_timeout;
        let mut detached: Vec<(Arc<dyn Sink>, TerminalDetached)> = Vec::new();

        // While the reader has been paused too long, a subscriber behind the furthest one is
        // what keeps everyone waiting.
        let paused_too_long = state
            .paused_since
            .is_some_and(|since| since.elapsed() >= stall);
        let views = state.subscribers.iter().filter(|s| !s.lifecycle_only);
        if paused_too_long && views.clone().count() > 1 {
            let furthest = views.map(|s| s.next).max().unwrap_or(0);
            let behind: Vec<SubscriptionId> = state
                .subscribers
                .iter()
                .filter(|s| !s.lifecycle_only)
                .filter(|s| s.next < furthest && s.last_progress.elapsed() >= stall)
                .map(|s| s.id.clone())
                .collect();
            for id in behind {
                if let Some(event) = self.take_subscriber(
                    &mut state,
                    &id,
                    TerminalErrorCause::OutputOverflow,
                    "This view fell too far behind the terminal's output and was detached.",
                ) {
                    detached.push(event);
                }
            }
            state.paused_since = Some(Instant::now());
        }

        // One that has stopped acknowledging altogether would hold everything (and the end) back
        // for ever.
        {
            let silent = self.limits.unresponsive_timeout;
            let stuck: Vec<SubscriptionId> = state
                .subscribers
                .iter()
                .filter(|s| s.throttled && s.last_progress.elapsed() >= silent)
                .map(|s| s.id.clone())
                .collect();
            for id in stuck {
                if let Some(event) = self.take_subscriber(
                    &mut state,
                    &id,
                    TerminalErrorCause::SubscriberFailed,
                    "This view stopped taking the terminal's output and was detached.",
                ) {
                    detached.push(event);
                }
            }
        }

        if detached.is_empty() {
            return state;
        }
        drop(state);
        for (sink, event) in detached {
            let _ = sink.send(&encode(&TerminalMessage::Detached(event)));
        }
        self.lock()
    }

    fn take_subscriber(
        &self,
        state: &mut State,
        id: &SubscriptionId,
        cause: TerminalErrorCause,
        message: &str,
    ) -> Option<(Arc<dyn Sink>, TerminalDetached)> {
        let index = state.subscribers.iter().position(|s| &s.id == id)?;
        let subscriber = state.subscribers.remove(index);
        state.retired.push(subscriber.id.clone());
        Some((
            subscriber.sink,
            TerminalDetached {
                session_id: self.session_id.clone(),
                generation: self.generation,
                error: TerminalError::new(cause, message),
                last_seq: subscriber.sent_seq.and_then(|seq| Sequence::new(seq).ok()),
            },
        ))
    }
}

#[cfg(test)]
#[path = "terminal_stream_tests.rs"]
mod tests;
