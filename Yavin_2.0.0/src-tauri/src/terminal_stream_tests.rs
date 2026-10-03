use super::*;
use ide_terminal_protocol::{LiveState, FIRST_GENERATION};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

/// Small bounds, so every regime is reached with little output.
fn small() -> Limits {
    Limits {
        max_chunk_bytes: 16,
        max_batch_reads: 4,
        max_batch_latency: Duration::from_millis(5),
        ingress_high: 256,
        ingress_low: 64,
        subscriber_high: 64,
        subscriber_low: 16,
        stall_timeout: Duration::from_millis(300),
        unresponsive_timeout: Duration::from_millis(900),
        replay_bytes: 64,
    }
}

fn sid(text: &str) -> SubscriptionId {
    SubscriptionId::new(text).unwrap()
}

fn session() -> TerminalId {
    TerminalId::new("t-stream").unwrap()
}

/// Records what a subscriber is sent; can be made to fail like a closed window.
#[derive(Default)]
struct Recorder {
    messages: Mutex<Vec<TerminalMessage>>,
    sent: Condvar,
    gone: AtomicBool,
}

impl Sink for Recorder {
    fn send(&self, message: &str) -> bool {
        if self.gone.load(Ordering::SeqCst) {
            return false;
        }
        let parsed: TerminalMessage =
            serde_json::from_str(message).expect("every message is in the contract's shape");
        self.messages.lock().unwrap().push(parsed);
        self.sent.notify_all();
        true
    }
}

impl Recorder {
    fn all(&self) -> Vec<TerminalMessage> {
        self.messages.lock().unwrap().clone()
    }

    fn bytes(&self) -> Vec<u8> {
        bytes_of(&self.all())
    }

    fn outputs(&self) -> Vec<TerminalOutputChunk> {
        self.all()
            .into_iter()
            .filter_map(|m| match m {
                TerminalMessage::Output(chunk) => Some(chunk),
                _ => None,
            })
            .collect()
    }

    fn wait(&self, timeout: Duration, done: impl Fn(&[TerminalMessage]) -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        let mut messages = self.messages.lock().unwrap();
        loop {
            if done(&messages) {
                return true;
            }
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            messages = self
                .sent
                .wait_timeout(messages, (deadline - now).min(Duration::from_millis(50)))
                .unwrap()
                .0;
        }
    }

    fn ended(messages: &[TerminalMessage]) -> bool {
        messages.iter().any(|m| {
            matches!(
                m,
                TerminalMessage::Exit(_) | TerminalMessage::Error(_) | TerminalMessage::Detached(_)
            )
        })
    }
}

/// The output bytes among `messages`, for use inside a `wait` predicate (which holds the lock).
fn bytes_of(messages: &[TerminalMessage]) -> Vec<u8> {
    messages
        .iter()
        .filter_map(|m| match m {
            TerminalMessage::Output(chunk) => Some(chunk.bytes.clone()),
            _ => None,
        })
        .flatten()
        .collect()
}

fn open(limits: Limits) -> (Arc<OutputStream>, Arc<Recorder>) {
    let recorder = Arc::new(Recorder::default());
    let stream = OutputStream::start(
        session(),
        FIRST_GENERATION,
        limits,
        (sid("a"), recorder.clone(), Delivery::Output),
    );
    (stream, recorder)
}

/// Acknowledges everything `recorder` is sent, as xterm's write callback would, `delay` after
/// each chunk. Stops when the stream is over or `stop` is set.
fn consume(
    stream: &Arc<OutputStream>,
    recorder: &Arc<Recorder>,
    id: &str,
    delay: Duration,
    stop: Arc<AtomicBool>,
) -> thread::JoinHandle<()> {
    let (stream, recorder, id) = (stream.clone(), recorder.clone(), sid(id));
    thread::spawn(move || {
        let mut acked = 0usize;
        while !stop.load(Ordering::SeqCst) {
            let outputs = recorder.outputs();
            for chunk in &outputs[acked..] {
                if !delay.is_zero() {
                    thread::sleep(delay);
                }
                let _ = stream.ack(&id, chunk.generation, chunk.seq);
            }
            acked = outputs.len();
            if Recorder::ended(&recorder.all()) {
                return;
            }
            let _ = recorder.wait(Duration::from_millis(20), |m| {
                m.iter()
                    .filter(|m| matches!(m, TerminalMessage::Output(_)))
                    .count()
                    > acked
                    || Recorder::ended(m)
            });
        }
    })
}

fn running() -> TerminalStateChanged {
    TerminalStateChanged {
        session_id: session(),
        generation: FIRST_GENERATION,
        state: LiveState::Running { pid: Some(7) },
    }
}

fn exiting() -> TerminalStateChanged {
    TerminalStateChanged {
        session_id: session(),
        generation: FIRST_GENERATION,
        state: LiveState::Exiting,
    }
}

/// A byte pattern that tells any reordering, loss or duplication apart.
fn pattern(offset: usize, len: usize) -> Vec<u8> {
    (offset..offset + len)
        .map(|i| (i.wrapping_mul(31) ^ (i >> 8)) as u8)
        .collect()
}

/// Every chunk numbered from 0 without gaps or repeats, each within the size bound.
fn assert_sequenced(chunks: &[TerminalOutputChunk], max: usize) {
    for (index, chunk) in chunks.iter().enumerate() {
        assert_eq!(
            chunk.seq.get(),
            index as u64,
            "a gap, a repeat or a reordering"
        );
        assert_eq!(chunk.generation, FIRST_GENERATION);
        assert!(
            !chunk.bytes.is_empty() && chunk.bytes.len() <= max,
            "{}",
            chunk.bytes.len()
        );
    }
}

// --- A. Ordering, B. arbitrary boundaries -----------------------------------------------------

#[test]
fn output_arrives_byte_for_byte_in_order_and_numbered_without_gaps() {
    let (stream, recorder) = open(small());
    let stop = Arc::new(AtomicBool::new(false));
    let consumer = consume(&stream, &recorder, "a", Duration::ZERO, stop.clone());
    let mut expected = Vec::new();
    for (offset, len) in [(0, 3), (3, 40), (43, 1), (44, 100), (144, 7)] {
        let bytes = pattern(offset, len);
        expected.extend_from_slice(&bytes);
        assert!(stream.push(&bytes));
    }
    stream.finish(End::Exit(Some(0)));
    assert!(stream.wait_finished(Duration::from_secs(5)));
    consumer.join().unwrap();
    assert_eq!(recorder.bytes(), expected);
    assert_sequenced(&recorder.outputs(), 16);
}

#[test]
fn characters_and_escape_sequences_split_across_reads_pass_through_untouched() {
    let (stream, recorder) = open(small());
    let stop = Arc::new(AtomicBool::new(false));
    let consumer = consume(&stream, &recorder, "a", Duration::ZERO, stop);
    // A euro sign, an SGR sequence, an OSC title and a lone invalid byte, cut everywhere.
    let whole: Vec<u8> = [
        "€".as_bytes(),
        b"\x1b[31mred\x1b[0m",
        b"\x1b]0;title\x07",
        &[0xff, 0x00],
    ]
    .concat();
    for piece in whole.chunks(1) {
        assert!(stream.push(piece));
    }
    stream.finish(End::Exit(Some(0)));
    assert!(stream.wait_finished(Duration::from_secs(5)));
    consumer.join().unwrap();
    assert_eq!(recorder.bytes(), whole);
}

// --- C. Batching ------------------------------------------------------------------------------

#[test]
fn many_tiny_reads_become_few_bounded_batches() {
    let (stream, recorder) = open(small());
    let stop = Arc::new(AtomicBool::new(false));
    let consumer = consume(&stream, &recorder, "a", Duration::ZERO, stop);
    for i in 0..200 {
        assert!(stream.push(&pattern(i, 1)));
    }
    stream.finish(End::Exit(Some(0)));
    assert!(stream.wait_finished(Duration::from_secs(5)));
    consumer.join().unwrap();
    let chunks = recorder.outputs();
    assert_eq!(recorder.bytes(), pattern(0, 200));
    assert_sequenced(&chunks, 16);
    // 200 reads of one byte: batched by the four-read and 16-byte bounds, never one per read.
    assert!(
        chunks.len() <= 60,
        "{} messages for 200 reads",
        chunks.len()
    );
}

#[test]
fn a_lone_read_is_sent_within_the_batch_latency() {
    let (stream, recorder) = open(LIMITS.clone());
    let started = Instant::now();
    assert!(stream.push(b"$ "));
    assert!(recorder.wait(Duration::from_secs(1), |m| !m.is_empty()));
    // 5 ms nominal; Windows timer resolution can make it ~16 ms.
    assert!(
        started.elapsed() < Duration::from_millis(100),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(recorder.bytes(), b"$ ");
    stream.finish(End::Exit(None));
}

// --- D. Backpressure --------------------------------------------------------------------------

#[test]
fn a_full_stream_pauses_the_reader_until_acknowledgements_drain_it() {
    let limits = small();
    let (stream, recorder) = open(limits.clone());
    let pushed = Arc::new(AtomicUsize::new(0));
    let reader = {
        let (stream, pushed) = (stream.clone(), pushed.clone());
        thread::spawn(move || {
            for i in 0..100 {
                if !stream.push(&pattern(i * 8, 8)) {
                    return;
                }
                pushed.fetch_add(1, Ordering::SeqCst);
            }
        })
    };
    // Nothing is acknowledged: the subscriber's window fills, then the stream, then the reader
    // stops -- with memory at the bound, not past it.
    thread::sleep(Duration::from_millis(200));
    let stalled_at = pushed.load(Ordering::SeqCst);
    assert!(stalled_at < 100, "the reader never paused");
    assert!(stream.reader_paused());
    let stats = stream.stats();
    assert!(stats.backpressured);
    assert!(
        stats.peak_queued_bytes <= limits.ingress_high + 8,
        "{} queued past the bound",
        stats.peak_queued_bytes
    );
    thread::sleep(Duration::from_millis(100));
    assert_eq!(
        pushed.load(Ordering::SeqCst),
        stalled_at,
        "a paused reader kept reading"
    );

    // Acknowledging lets it resume, and every byte still arrives.
    let consumer = consume(
        &stream,
        &recorder,
        "a",
        Duration::ZERO,
        Arc::new(AtomicBool::new(false)),
    );
    reader.join().unwrap();
    stream.finish(End::Exit(Some(0)));
    assert!(stream.wait_finished(Duration::from_secs(5)));
    consumer.join().unwrap();
    assert_eq!(recorder.bytes(), pattern(0, 800));
    assert!(stream.stats().peak_queued_bytes <= limits.ingress_high + 8);
}

// --- E. Acknowledgements ----------------------------------------------------------------------

#[test]
fn acknowledgements_are_cumulative_and_checked() {
    let (stream, recorder) = open(small());
    for i in 0..4 {
        assert!(stream.push(&pattern(i * 16, 16)));
    }
    assert!(recorder.wait(Duration::from_secs(2), |m| m.len() >= 4));
    let seq = |n| Sequence::new(n).unwrap();
    let a = sid("a");

    // Beyond what was sent: refused.
    assert_eq!(
        stream.ack(&a, FIRST_GENERATION, seq(99)).unwrap_err().code,
        TerminalErrorCause::ProtocolError
    );
    // Another generation's: stale.
    assert_eq!(
        stream
            .ack(&a, Generation::new(2).unwrap(), seq(0))
            .unwrap_err()
            .code,
        TerminalErrorCause::StaleGeneration
    );
    // An unknown subscriber: no such session for it.
    assert_eq!(
        stream
            .ack(&sid("nobody"), FIRST_GENERATION, seq(0))
            .unwrap_err()
            .code,
        TerminalErrorCause::InvalidSession
    );
    // Cumulative: acknowledging 2 releases 0, 1 and 2 at once.
    stream.ack(&a, FIRST_GENERATION, seq(2)).unwrap();
    let after = stream.stats().subscribers[0].clone();
    assert_eq!(after.acked_seq, Some(2));
    assert_eq!(after.in_flight_bytes, 16);
    // A duplicate, or an older one arriving late, changes nothing.
    stream.ack(&a, FIRST_GENERATION, seq(2)).unwrap();
    stream.ack(&a, FIRST_GENERATION, seq(1)).unwrap();
    assert_eq!(stream.stats().subscribers[0].acked_seq, Some(2));
    assert_eq!(stream.stats().subscribers[0].in_flight_bytes, 16);
    stream.finish(End::Exit(None));
}

// --- F. Subscriber isolation ------------------------------------------------------------------

#[test]
fn a_slow_subscriber_never_holds_up_a_fast_one_and_is_detached_explicitly() {
    let limits = small();
    let (stream, fast) = open(limits.clone());
    let slow = Arc::new(Recorder::default());
    stream
        .subscribe(sid("slow"), slow.clone(), Delivery::Output, false)
        .unwrap();
    let consumer = consume(
        &stream,
        &fast,
        "a",
        Duration::ZERO,
        Arc::new(AtomicBool::new(false)),
    );

    let total = 4000;
    let reader = {
        let stream = stream.clone();
        thread::spawn(move || {
            for i in 0..total / 8 {
                assert!(stream.push(&pattern(i * 8, 8)));
            }
        })
    };
    reader.join().unwrap();
    stream.finish(End::Exit(Some(0)));
    assert!(stream.wait_finished(Duration::from_secs(10)));
    consumer.join().unwrap();

    // The fast one got everything, in order.
    assert_eq!(fast.bytes(), pattern(0, total));
    assert_sequenced(&fast.outputs(), 16);
    // The slow one got an unbroken prefix, then a stated end -- never a stream with a hole.
    let messages = slow.all();
    let Some(TerminalMessage::Detached(detached)) = messages.last() else {
        panic!(
            "the slow subscriber was not told it was detached: {:?}",
            messages.last()
        );
    };
    assert_eq!(detached.error.code, TerminalErrorCause::OutputOverflow);
    let received = slow.bytes();
    assert_eq!(received, pattern(0, received.len()), "not a prefix");
    let chunks = slow.outputs();
    assert_sequenced(&chunks, 16);
    assert_eq!(
        detached.last_seq.map(|s| s.get()),
        chunks.last().map(|c| c.seq.get())
    );
    assert!(stream.stats().peak_queued_bytes <= limits.ingress_high + 8);
}

#[test]
fn a_closed_window_is_removed_without_disturbing_the_others() {
    let (stream, open_window) = open(small());
    let closed = Arc::new(Recorder::default());
    stream
        .subscribe(sid("closed"), closed.clone(), Delivery::Output, false)
        .unwrap();
    let consumer = consume(
        &stream,
        &open_window,
        "a",
        Duration::ZERO,
        Arc::new(AtomicBool::new(false)),
    );
    assert!(stream.push(b"first"));
    assert!(closed.wait(Duration::from_secs(2), |m| !m.is_empty()));
    closed.gone.store(true, Ordering::SeqCst);
    assert!(stream.push(b"second"));
    assert!(open_window.wait(Duration::from_secs(2), |m| bytes_of(m) == b"firstsecond"));
    // Removed in the same delivery pass that found its transport gone -- which finishes after
    // the other subscriber's send, so it is waited for (bounded), not assumed.
    let deadline = Instant::now() + Duration::from_secs(2);
    while stream.has_subscriber(&sid("closed")) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    assert!(!stream.has_subscriber(&sid("closed")));
    stream.finish(End::Exit(Some(0)));
    assert!(stream.wait_finished(Duration::from_secs(5)));
    consumer.join().unwrap();
    // Its transport went away: no error, just gone.
    assert!(!closed
        .all()
        .iter()
        .any(|m| matches!(m, TerminalMessage::Detached(_))));
}

#[test]
fn unsubscribing_releases_what_was_held_for_that_subscriber() {
    let limits = small();
    let (stream, recorder) = open(limits.clone());
    let idle = Arc::new(Recorder::default());
    stream
        .subscribe(sid("idle"), idle, Delivery::Output, false)
        .unwrap();
    let consumer = consume(
        &stream,
        &recorder,
        "a",
        Duration::ZERO,
        Arc::new(AtomicBool::new(false)),
    );
    // The idle subscriber never acknowledges: output piles up for it alone.
    for i in 0..20 {
        assert!(stream.push(&pattern(i * 8, 8)));
    }
    assert!(recorder.wait(Duration::from_secs(2), |m| bytes_of(m).len() == 160));
    thread::sleep(Duration::from_millis(50));
    let held = stream.stats().queued_bytes;
    assert!(held > 0, "nothing was held for the idle subscriber");
    assert!(stream.unsubscribe(&sid("idle")));
    assert!(
        !stream.unsubscribe(&sid("idle")),
        "a second unsubscribe is harmless"
    );
    let deadline = Instant::now() + Duration::from_secs(2);
    while stream.stats().queued_bytes > 0 && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(stream.stats().queued_bytes, 0);
    assert_eq!(stream.stats().subscribers.len(), 1);
    stream.finish(End::Exit(Some(0)));
    assert!(stream.wait_finished(Duration::from_secs(5)));
    consumer.join().unwrap();
}

// --- H. Exit ordering -------------------------------------------------------------------------

#[test]
fn every_subscriber_sees_running_the_output_exiting_and_exactly_one_end_last() {
    let (stream, recorder) = open(small());
    let consumer = consume(
        &stream,
        &recorder,
        "a",
        Duration::ZERO,
        Arc::new(AtomicBool::new(false)),
    );
    stream.live(running());
    assert!(stream.push(&pattern(0, 40)));
    stream.live(exiting());
    // Output still draining after the end was seen comes after Exiting, and before the end.
    assert!(stream.push(&pattern(40, 10)));
    stream.close_input();
    assert!(!stream.push(b"late"), "input accepted after it was closed");
    stream.finish(End::Exit(Some(3)));
    stream.finish(End::Exit(Some(4))); // a second end is ignored
    assert!(stream.wait_finished(Duration::from_secs(5)));
    consumer.join().unwrap();

    let messages = recorder.all();
    let kinds: Vec<&str> = messages
        .iter()
        .map(|m| match m {
            TerminalMessage::Output(_) => "output",
            TerminalMessage::State(s) if matches!(s.state, LiveState::Running { .. }) => "running",
            TerminalMessage::State(_) => "exiting",
            TerminalMessage::Exit(_) => "exit",
            TerminalMessage::Error(_) => "error",
            TerminalMessage::Detached(_) => "detached",
            TerminalMessage::Shell(_) => "shell",
        })
        .collect();
    assert_eq!(kinds.first(), Some(&"running"));
    let exiting_at = kinds.iter().position(|k| *k == "exiting").unwrap();
    assert!(kinds[1..exiting_at].iter().all(|k| *k == "output"));
    assert_eq!(kinds.iter().filter(|k| **k == "exit").count(), 1);
    assert_eq!(kinds.last(), Some(&"exit"));
    let Some(TerminalMessage::Exit(exit)) = messages.last() else {
        unreachable!()
    };
    assert_eq!(exit.exit_code, Some(3));
    assert_eq!(
        exit.last_seq.map(|s| s.get()),
        recorder.outputs().last().map(|c| c.seq.get())
    );
    assert_eq!(recorder.bytes(), pattern(0, 50));
    // Nothing is held for flow control once it is over; a view attaching now is sent the
    // replay and the end (TERMINAL-03), and once released, nothing at all.
    assert_eq!(stream.stats().queued_bytes, 0);
    let late = Arc::new(Recorder::default());
    stream
        .subscribe(sid("late"), late.clone(), Delivery::Output, true)
        .unwrap();
    assert_eq!(late.bytes(), pattern(0, 50));
    assert!(matches!(late.all().last(), Some(TerminalMessage::Exit(_))));
    stream.release();
    assert_eq!(
        stream
            .subscribe(
                sid("later"),
                Arc::new(Recorder::default()),
                Delivery::Output,
                true
            )
            .unwrap_err()
            .code,
        TerminalErrorCause::InvalidSession
    );
}

#[test]
fn a_generation_with_no_output_ends_with_no_last_chunk() {
    let (stream, recorder) = open(small());
    stream.live(running());
    stream.finish(End::Error(TerminalError::new(
        TerminalErrorCause::ProcessFailed,
        "Lost track of the shell.",
    )));
    assert!(stream.wait_finished(Duration::from_secs(5)));
    let Some(TerminalMessage::Error(error)) = recorder.all().last().cloned() else {
        panic!("{:?}", recorder.all());
    };
    assert_eq!(error.last_seq, None);
    assert_eq!(error.error.code, TerminalErrorCause::ProcessFailed);
}

// --- I. Overflow ------------------------------------------------------------------------------

#[test]
fn a_subscriber_that_stops_acknowledging_is_detached_rather_than_holding_its_terminal_forever() {
    let limits = small();
    let (stream, recorder) = open(limits.clone());
    let reader = {
        let stream = stream.clone();
        thread::spawn(move || {
            for i in 0..200 {
                if !stream.push(&pattern(i * 8, 8)) {
                    return;
                }
            }
        })
    };
    // Its only subscriber never acknowledges. Being slow alone is backpressure, not loss --
    // but nothing at all for the unresponsive timeout is a failure, stated as one.
    assert!(recorder.wait(Duration::from_secs(5), Recorder::ended));
    let Some(TerminalMessage::Detached(detached)) = recorder.all().last().cloned() else {
        panic!("{:?}", recorder.all().last());
    };
    assert_eq!(detached.error.code, TerminalErrorCause::SubscriberFailed);
    let received = recorder.bytes();
    assert_eq!(received, pattern(0, received.len()));
    assert_eq!(
        detached.last_seq.map(|s| s.get()),
        recorder.outputs().last().map(|c| c.seq.get())
    );
    // With no subscriber left the reader is no longer held, and memory was bounded throughout.
    reader.join().unwrap();
    assert!(stream.stats().peak_queued_bytes <= limits.ingress_high + 8);
    stream.finish(End::Exit(Some(0)));
    assert!(stream.wait_finished(Duration::from_secs(5)));
}

// --- J. Stress --------------------------------------------------------------------------------

/// Streams `total` bytes in PTY-sized reads through the application's own limits, the consumer
/// acknowledging `delay` after each chunk; checks every byte, every sequence number, the memory
/// bound, and that the stream answers other calls promptly while busy.
fn stress(total: usize, delay: Duration) {
    let (stream, recorder) = open(LIMITS.clone());
    let consumed = Arc::new(Mutex::new((0usize, 0u64))); // (bytes checked, next seq)
    let done = Arc::new(AtomicBool::new(false));
    // A consumer that checks as it goes and keeps nothing: 50 MB is not held in the test.
    let consumer = {
        let (stream, recorder, consumed, done) = (
            stream.clone(),
            recorder.clone(),
            consumed.clone(),
            done.clone(),
        );
        thread::spawn(move || loop {
            let batch: Vec<TerminalMessage> = {
                let mut messages = recorder.messages.lock().unwrap();
                std::mem::take(&mut *messages)
            };
            for message in batch {
                match message {
                    TerminalMessage::Output(chunk) => {
                        let mut progress = consumed.lock().unwrap();
                        assert_eq!(chunk.seq.get(), progress.1, "a gap or a repeat");
                        assert!(chunk.bytes.len() <= LIMITS.max_chunk_bytes);
                        assert_eq!(chunk.bytes, pattern(progress.0, chunk.bytes.len()));
                        progress.0 += chunk.bytes.len();
                        progress.1 += 1;
                        drop(progress);
                        if !delay.is_zero() {
                            thread::sleep(delay);
                        }
                        stream.ack(&sid("a"), chunk.generation, chunk.seq).unwrap();
                    }
                    TerminalMessage::Exit(_) => {
                        done.store(true, Ordering::SeqCst);
                        return;
                    }
                    other => panic!("unexpected {other:?}"),
                }
            }
            let messages = recorder.messages.lock().unwrap();
            if messages.is_empty() {
                let _ = recorder
                    .sent
                    .wait_timeout(messages, Duration::from_millis(10));
            }
        })
    };

    let started = Instant::now();
    let mut slowest_call = Duration::ZERO;
    let mut offset = 0;
    while offset < total {
        let len = READ.min(total - offset);
        assert!(stream.push(&pattern(offset, len)));
        offset += len;
        if offset % (1024 * 1024) < READ {
            let asked = Instant::now();
            let _ = stream.stats();
            slowest_call = slowest_call.max(asked.elapsed());
        }
    }
    stream.finish(End::Exit(Some(0)));
    assert!(
        stream.wait_finished(Duration::from_secs(300)),
        "never finished"
    );
    consumer.join().unwrap();
    assert!(done.load(Ordering::SeqCst));
    let (bytes, chunks) = *consumed.lock().unwrap();
    assert_eq!(bytes, total);
    let peak = stream.stats().peak_queued_bytes;
    assert!(
        peak <= LIMITS.ingress_high + READ,
        "peak {peak} past the bound"
    );
    assert!(
        slowest_call < Duration::from_millis(250),
        "stats took {slowest_call:?}"
    );
    eprintln!(
        "stress {} MB (consumer delay {delay:?}): {:.2?}, {chunks} chunks, peak queued {} KiB, slowest call {slowest_call:?}",
        total / (1024 * 1024),
        started.elapsed(),
        peak / 1024
    );
}

const READ: usize = 8192;

#[test]
fn stress_1_mb_with_a_slow_consumer() {
    stress(1024 * 1024, Duration::from_micros(500));
}

#[test]
fn stress_10_mb() {
    stress(10 * 1024 * 1024, Duration::ZERO);
}

#[test]
#[ignore = "large: run with --ignored (see ARCHITECTURE.md, Terminal)"]
fn stress_50_mb() {
    stress(50 * 1024 * 1024, Duration::ZERO);
}

#[test]
fn stress_10_mb_with_a_slow_consumer() {
    // The consumer is slower than the producer, so the reader spends most of this paused: the
    // memory bound holds under sustained backpressure, and nothing is lost.
    stress(10 * 1024 * 1024, Duration::from_millis(1));
}

// --- TERMINAL-03: replay and lifecycle subscribers ---------------------------------------------

/// The kinds of messages, in order, with each output's seq.
fn shape(messages: &[TerminalMessage]) -> Vec<String> {
    messages
        .iter()
        .map(|m| match m {
            TerminalMessage::Output(c) => format!("output {}", c.seq.get()),
            TerminalMessage::State(s) if matches!(s.state, LiveState::Running { .. }) => {
                "running".into()
            }
            TerminalMessage::State(_) => "exiting".into(),
            TerminalMessage::Exit(_) => "exit".into(),
            TerminalMessage::Error(_) => "error".into(),
            TerminalMessage::Detached(_) => "detached".into(),
            TerminalMessage::Shell(s) => format!("shell {:?}", s.signal),
        })
        .collect()
}

#[test]
fn a_view_attaching_later_is_replayed_the_recent_output_then_continues_live() {
    let (stream, first) = open(small());
    let consumer = consume(
        &stream,
        &first,
        "a",
        Duration::ZERO,
        Arc::new(AtomicBool::new(false)),
    );
    stream.live(running());
    assert!(stream.push(&pattern(0, 40)));
    assert!(first.wait(Duration::from_secs(2), |m| bytes_of(m).len() == 40));

    // The second view attaches mid-stream: the replay, then live, with nothing twice.
    let late = Arc::new(Recorder::default());
    stream
        .subscribe(sid("late"), late.clone(), Delivery::Output, true)
        .unwrap();
    let late_consumer = consume(
        &stream,
        &late,
        "late",
        Duration::ZERO,
        Arc::new(AtomicBool::new(false)),
    );
    assert!(stream.push(&pattern(40, 24)));
    stream.finish(End::Exit(Some(0)));
    assert!(stream.wait_finished(Duration::from_secs(5)));
    consumer.join().unwrap();
    late_consumer.join().unwrap();

    assert_eq!(late.bytes(), pattern(0, 64), "missing or repeated output");
    assert_eq!(late.bytes(), first.bytes());
    let kinds = shape(&late.all());
    assert_eq!(kinds.first().map(String::as_str), Some("running"));
    assert_eq!(kinds.last().map(String::as_str), Some("exit"));
    assert_sequenced(&late.outputs(), 16);
}

#[test]
fn replay_is_bounded_and_says_where_it_starts() {
    let mut limits = small();
    limits.replay_bytes = 32;
    let (stream, first) = open(limits);
    let consumer = consume(
        &stream,
        &first,
        "a",
        Duration::ZERO,
        Arc::new(AtomicBool::new(false)),
    );
    stream.live(running());
    for i in 0..10 {
        assert!(stream.push(&pattern(i * 16, 16)));
        assert!(first.wait(Duration::from_secs(2), |m| bytes_of(m).len()
            == (i + 1) * 16));
    }
    let late = Arc::new(Recorder::default());
    stream
        .subscribe(sid("late"), late.clone(), Delivery::Output, true)
        .unwrap();
    assert!(late.wait(Duration::from_secs(2), |m| bytes_of(m).len() == 32));
    // Only the most recent 32 bytes are kept; the replay is the tail of the stream, numbered
    // as it was, so the view knows where it joined.
    let chunks = late.outputs();
    assert_eq!(chunks.first().map(|c| c.seq.get()), Some(8));
    assert_eq!(late.bytes(), pattern(128, 32));
    assert!(stream.stats().replay_bytes <= 32);
    stream.finish(End::Exit(None));
    assert!(stream.wait_finished(Duration::from_secs(5)));
    consumer.join().unwrap();
}

#[test]
fn a_lifecycle_subscriber_gets_no_output_and_never_holds_the_reader() {
    let limits = small();
    let lifecycle = Arc::new(Recorder::default());
    let stream = OutputStream::start(
        session(),
        FIRST_GENERATION,
        limits.clone(),
        (sid("service"), lifecycle.clone(), Delivery::Lifecycle),
    );
    stream.live(running());
    // Far more than every bound, with no view attached and nothing acknowledged: the reader is
    // never paused, and memory stays at the replay bound.
    let started = Instant::now();
    for i in 0..500 {
        assert!(stream.push(&pattern(i * 8, 8)));
    }
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "the reader was held"
    );
    stream.live(exiting());
    stream.finish(End::Exit(Some(0)));
    assert!(stream.wait_finished(Duration::from_secs(5)));
    assert_eq!(shape(&lifecycle.all()), ["running", "exiting", "exit"]);
    assert!(stream.stats().replay_bytes <= limits.replay_bytes);
    assert!(stream.stats().peak_queued_bytes <= limits.ingress_high + 8);
}

#[test]
fn a_lifecycle_subscriber_is_never_taken_for_a_laggard() {
    // A view that is slow but the only one: with the service always caught up, it must still be
    // backpressured rather than detached for being behind.
    let limits = small();
    let lifecycle = Arc::new(Recorder::default());
    let stream = OutputStream::start(
        session(),
        FIRST_GENERATION,
        limits.clone(),
        (sid("service"), lifecycle, Delivery::Lifecycle),
    );
    let view = Arc::new(Recorder::default());
    stream
        .subscribe(sid("view"), view.clone(), Delivery::Output, true)
        .unwrap();
    let reader = {
        let stream = stream.clone();
        thread::spawn(move || {
            for i in 0..100 {
                if !stream.push(&pattern(i * 8, 8)) {
                    return;
                }
            }
        })
    };
    // Longer than the laggard timeout, shorter than the unresponsive one.
    thread::sleep(limits.stall_timeout + Duration::from_millis(300));
    assert!(!view
        .all()
        .iter()
        .any(|m| matches!(m, TerminalMessage::Detached(_))));
    let consumer = consume(
        &stream,
        &view,
        "view",
        Duration::ZERO,
        Arc::new(AtomicBool::new(false)),
    );
    reader.join().unwrap();
    stream.finish(End::Exit(Some(0)));
    assert!(stream.wait_finished(Duration::from_secs(5)));
    consumer.join().unwrap();
    assert_eq!(view.bytes(), pattern(0, 800));
}

#[test]
fn a_released_stream_keeps_nothing_and_refuses_views() {
    let (stream, recorder) = open(small());
    let consumer = consume(
        &stream,
        &recorder,
        "a",
        Duration::ZERO,
        Arc::new(AtomicBool::new(false)),
    );
    assert!(stream.push(&pattern(0, 40)));
    stream.finish(End::Exit(Some(0)));
    assert!(stream.wait_finished(Duration::from_secs(5)));
    consumer.join().unwrap();
    assert!(stream.stats().replay_bytes > 0);
    stream.release();
    assert_eq!(stream.stats().replay_bytes, 0);
    assert!(stream
        .subscribe(
            sid("v"),
            Arc::new(Recorder::default()),
            Delivery::Output,
            true
        )
        .is_err());
}

// --- TERMINAL-05A: shell integration -----------------------------------------------------------

#[test]
fn shell_signals_arrive_in_order_with_the_output_and_are_not_replayed() {
    let lifecycle = Arc::new(Recorder::default());
    let stream = OutputStream::start(
        session(),
        FIRST_GENERATION,
        small(),
        (sid("service"), lifecycle.clone(), Delivery::Lifecycle),
    );
    let view = Arc::new(Recorder::default());
    stream
        .subscribe(sid("view"), view.clone(), Delivery::Output, true)
        .unwrap();
    let consumer = consume(
        &stream,
        &view,
        "view",
        Duration::ZERO,
        Arc::new(AtomicBool::new(false)),
    );
    stream.live(running());
    // Split mid-sequence, as a PTY read may.
    let output: &[u8] = b"$ \x1b]133;A\x07\x1b]133;B\x07ls\r\n\x1b]133;C\x07a.txt\r\n\x1b]133;D;3\x07\x1b]7;file://localhost/c/x\x07";
    for piece in output.chunks(5) {
        assert!(stream.push(piece));
    }
    assert!(view.wait(Duration::from_secs(2), |m| bytes_of(m).len()
        == output.len()));
    // The bytes themselves are untouched: the sequences stay in the output.
    assert_eq!(view.bytes(), output);
    let shells = |r: &Recorder| -> Vec<String> {
        shape(&r.all())
            .into_iter()
            .filter(|k| k.starts_with("shell"))
            .collect()
    };
    let expected = [
        "shell Prompt",
        "shell Input",
        "shell Executing",
        "shell Finished",
        "shell Cwd",
    ];
    assert_eq!(shells(&view), expected);
    // The service's lifecycle subscription gets them too, without the output.
    assert!(lifecycle.wait(Duration::from_secs(2), |m| m.len() >= 6));
    assert_eq!(shells(&lifecycle), expected);
    assert!(lifecycle.outputs().is_empty());
    // A view attaching now is replayed the output, never the old signals.
    let late = Arc::new(Recorder::default());
    stream
        .subscribe(sid("late"), late.clone(), Delivery::Output, true)
        .unwrap();
    assert!(late.wait(Duration::from_secs(2), |m| !bytes_of(m).is_empty()));
    assert!(shells(&late).is_empty());
    stream.finish(End::Exit(Some(0)));
    assert!(stream.wait_finished(Duration::from_secs(5)));
    consumer.join().unwrap();
}
