//! The Terminal contract (TERMINAL-00), the native half of `src/services/terminalProtocol.ts`.
//! Both halves read and write the wire forms in `src/services/terminalProtocol.fixtures.json`
//! identically (see `tests/fixtures.rs`).
//!
//! This crate is pure: no Tauri, no PTY, no threads. The terminal's session runtime
//! (`src-tauri/src/terminal.rs`, TERMINAL-01) speaks it. See ARCHITECTURE.md, "Terminal".
//!
//! - **Identity.** A session (`TerminalId`) has incarnations (`Generation`, from 1, only ever
//!   increasing for one id). Every event and every request after `open` names both, so the
//!   events of a replaced launch are recognisably stale.
//! - **Output** is raw bytes, numbered by `Sequence` from 0 within a generation, one number
//!   per chunk, never skipped. A chunk may end anywhere -- inside a UTF-8 character or an
//!   escape sequence -- and nothing here decodes it.
//! - **Lifecycle** is one state machine, `TerminalState`; a generation ends with exactly one of
//!   `TerminalExit` (`Exited`) or `TerminalErrorEvent` (`Failed`), after all of its output.
//! - **Failures** are `TerminalError`: a `TerminalErrorCause` and a sentence fit to show, never
//!   a raw OS or Rust error.

use base64::Engine;
use serde::{Deserialize, Deserializer, Serialize};
use std::fmt;

/// The largest integer both sides represent exactly (JavaScript's `Number.MAX_SAFE_INTEGER`).
pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

// ---------------------------------------------------------------------------------------------
// Identities

fn valid_id(text: &str) -> bool {
    (1..=128).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

macro_rules! text_id {
    ($name:ident, $what:literal) => {
        #[doc = concat!("A ", $what, ": 1-128 characters of `[A-Za-z0-9._-]`.")]
        #[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);

        impl $name {
            pub fn new(text: impl Into<String>) -> Result<Self, TerminalError> {
                let text = text.into();
                if valid_id(&text) {
                    Ok(Self(text))
                } else {
                    Err(TerminalError::protocol(concat!(
                        "That is not a valid ",
                        $what,
                        "."
                    )))
                }
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl TryFrom<String> for $name {
            type Error = TerminalError;
            fn try_from(text: String) -> Result<Self, TerminalError> {
                Self::new(text)
            }
        }

        impl From<$name> for String {
            fn from(id: $name) -> String {
                id.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

text_id!(TerminalId, "terminal session id");
text_id!(SubscriptionId, "terminal subscription id");

/// A session's incarnation: from 1, never reused for the same `TerminalId`.
///
/// It changes exactly when a new process may start under an id that already had one: the first
/// open (1 or more), every restart, and every open of an id that was closed. Nothing else changes
/// it -- not resizing, not subscribing or unsubscribing, not a workspace being detached from a
/// view. Disposing a workspace ends its sessions' generations for good.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "u64", into = "u64")]
pub struct Generation(u64);

pub const FIRST_GENERATION: Generation = Generation(1);

impl Generation {
    pub fn new(value: u64) -> Result<Self, TerminalError> {
        if (1..=MAX_SAFE_INTEGER).contains(&value) {
            Ok(Self(value))
        } else {
            Err(TerminalError::protocol(
                "A terminal generation starts at 1.",
            ))
        }
    }

    pub fn get(self) -> u64 {
        self.0
    }

    /// Whether `self` may follow `previous` for the same session id: only a newer one may.
    pub fn is_newer_than(self, previous: Option<Generation>) -> bool {
        previous.is_none_or(|previous| self > previous)
    }
}

impl TryFrom<u64> for Generation {
    type Error = TerminalError;
    fn try_from(value: u64) -> Result<Self, TerminalError> {
        Self::new(value)
    }
}

impl From<Generation> for u64 {
    fn from(generation: Generation) -> u64 {
        generation.0
    }
}

/// An output chunk's position within its generation: the first chunk is 0, each next one is one
/// more, and none is ever skipped or repeated. Only output carries a sequence number; lifecycle
/// events refer to it (`last_seq`) but never take one. A future acknowledgement names the last
/// sequence number the consumer has finished with, cumulatively, within one generation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "u64", into = "u64")]
pub struct Sequence(u64);

pub const FIRST_SEQUENCE: Sequence = Sequence(0);

impl Sequence {
    pub fn new(value: u64) -> Result<Self, TerminalError> {
        if value <= MAX_SAFE_INTEGER {
            Ok(Self(value))
        } else {
            Err(TerminalError::protocol(
                "A terminal output sequence number is too large.",
            ))
        }
    }

    pub fn get(self) -> u64 {
        self.0
    }
}

impl TryFrom<u64> for Sequence {
    type Error = TerminalError;
    fn try_from(value: u64) -> Result<Self, TerminalError> {
        Self::new(value)
    }
}

impl From<Sequence> for u64 {
    fn from(seq: Sequence) -> u64 {
        seq.0
    }
}

/// Checks a request's generation against the session's current one. A request for any other
/// generation is stale: it must never act on the current launch.
pub fn require_current(requested: Generation, current: Generation) -> Result<(), TerminalError> {
    if requested == current {
        Ok(())
    } else {
        Err(TerminalError::new(
            TerminalErrorCause::StaleGeneration,
            "That request is for an earlier launch of this terminal.",
        ))
    }
}

// ---------------------------------------------------------------------------------------------
// The session state machine

/// One lifecycle per generation; see `can_transition` for the only steps it may take.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TerminalState {
    /// The open was accepted; the process is being started.
    Spawning,
    /// The process runs; output and input flow.
    Running,
    /// The process's end has been seen or asked for; output still drains.
    Exiting,
    /// The process ended and all of its output was delivered. Final.
    Exited,
    /// The generation ended through an error. Final.
    Failed,
}

impl TerminalState {
    pub const ALL: [TerminalState; 5] = [
        TerminalState::Spawning,
        TerminalState::Running,
        TerminalState::Exiting,
        TerminalState::Exited,
        TerminalState::Failed,
    ];

    pub fn can_transition(self, to: TerminalState) -> bool {
        use TerminalState::*;
        matches!(
            (self, to),
            (Spawning, Running)
                | (Spawning, Failed)
                | (Running, Exiting)
                | (Running, Failed)
                | (Exiting, Exited)
                | (Exiting, Failed)
        )
    }

    pub fn is_final(self) -> bool {
        matches!(self, TerminalState::Exited | TerminalState::Failed)
    }

    /// The state after a step, or a protocol error for a step the machine does not allow.
    pub fn transition(self, to: TerminalState) -> Result<TerminalState, TerminalError> {
        if self.can_transition(to) {
            Ok(to)
        } else {
            Err(TerminalError::protocol(format!(
                "A terminal cannot go from {self:?} to {to:?}."
            )))
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Dimensions

pub const MIN_DIMENSION: u16 = 1;
pub const MAX_COLS: u16 = 1000;
pub const MAX_ROWS: u16 = 1000;

/// The terminal's size in character cells. Pixel sizes are the renderer's layout, not part of
/// the contract. Zero, fractional or out-of-range sizes are refused, never clamped.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "RawDimensions")]
pub struct TerminalDimensions {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Deserialize)]
struct RawDimensions {
    cols: u16,
    rows: u16,
}

impl TerminalDimensions {
    pub fn new(cols: u16, rows: u16) -> Result<Self, TerminalError> {
        if (MIN_DIMENSION..=MAX_COLS).contains(&cols) && (MIN_DIMENSION..=MAX_ROWS).contains(&rows)
        {
            Ok(Self { cols, rows })
        } else {
            Err(TerminalError::protocol(format!(
                "A terminal is 1-{MAX_COLS} columns by 1-{MAX_ROWS} rows."
            )))
        }
    }
}

impl TryFrom<RawDimensions> for TerminalDimensions {
    type Error = TerminalError;
    fn try_from(raw: RawDimensions) -> Result<Self, TerminalError> {
        Self::new(raw.cols, raw.rows)
    }
}

// ---------------------------------------------------------------------------------------------
// Profiles

/// How a terminal is launched: only what today's launch already carries. A login shell is asked
/// for through `args`; the native side has no separate notion of one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalProfile {
    pub id: String,
    pub name: String,
    /// The shell to start: one the native side detected.
    pub executable: String,
    pub args: Vec<String>,
    /// Where the shell starts; the workspace root when `None`.
    pub cwd: Option<String>,
    /// Ordered pairs: a variable may be written in terms of an earlier one.
    pub env: Vec<(String, String)>,
}

fn launch_text(text: &str) -> bool {
    !text.contains(['\0', '\r', '\n'])
}

impl TerminalProfile {
    /// The rules the launch enforces, checked before anything is started.
    pub fn validate(&self) -> Result<(), TerminalError> {
        let bad = |message: String| Err(TerminalError::protocol(message));
        if self.id.trim().is_empty() {
            return bad("A terminal profile needs an id.".into());
        }
        if self.name.trim().is_empty() {
            return bad("A terminal profile needs a name.".into());
        }
        if self.executable.trim().is_empty() {
            return bad("A terminal profile needs a shell to start.".into());
        }
        if !self.args.iter().all(|arg| launch_text(arg)) {
            return bad("Shell arguments cannot contain line breaks or NUL.".into());
        }
        for (name, value) in &self.env {
            if name.is_empty() || name.contains('=') || !launch_text(name) {
                return bad(format!(
                    "\"{name}\" is not a valid environment variable name."
                ));
            }
            if !launch_text(value) {
                return bad(format!(
                    "The value of {name} cannot contain line breaks or NUL."
                ));
            }
        }
        if let Some(cwd) = &self.cwd {
            if cwd.is_empty() || !launch_text(cwd) {
                return bad(
                    "A terminal's folder cannot be empty or contain line breaks or NUL.".into(),
                );
            }
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------
// Sessions

/// What describes a session apart from any one launch. Never a handle, a pid or a process.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionMetadata {
    pub session_id: TerminalId,
    /// The renderer's canonical `WorkspaceId` (`workspaceIdOf`), carried as it is spelled there.
    pub workspace_id: String,
    pub profile: Option<TerminalProfile>,
    pub cwd: Option<String>,
}

/// One generation's live facts. The native handles behind them (PTY, writer, child) belong to
/// the runtime and never appear in the contract.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionRuntime {
    pub generation: Generation,
    pub state: TerminalState,
    pub pid: Option<u32>,
    pub dimensions: TerminalDimensions,
    /// Milliseconds since the epoch at which this generation was opened.
    pub started_at: u64,
    pub exit_code: Option<i32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalSession {
    #[serde(flatten)]
    pub metadata: TerminalSessionMetadata,
    #[serde(flatten)]
    pub runtime: TerminalSessionRuntime,
}

// ---------------------------------------------------------------------------------------------
// Errors

/// Why a terminal operation failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TerminalErrorCause {
    InvalidSession,
    InvalidWorkspace,
    ShellUnavailable,
    SpawnFailed,
    InvalidCwd,
    PermissionDenied,
    WriteFailed,
    ResizeFailed,
    ProcessFailed,
    TerminationFailed,
    ProtocolError,
    /// A request or acknowledgement named a generation other than the current one.
    StaleGeneration,
    /// A subscriber fell so far behind that keeping up would have meant unbounded memory: it was
    /// detached instead of being sent a stream with a hole in it (see TERMINAL-02).
    OutputOverflow,
    /// A subscriber stopped acknowledging output and was detached.
    SubscriberFailed,
    /// Output could not be handed to a subscriber's transport (its window has gone).
    TransportFailed,
    /// Anything else: an internal failure, or one not in this list.
    Unknown,
}

impl TerminalErrorCause {
    pub const ALL: [TerminalErrorCause; 16] = [
        TerminalErrorCause::InvalidSession,
        TerminalErrorCause::InvalidWorkspace,
        TerminalErrorCause::ShellUnavailable,
        TerminalErrorCause::SpawnFailed,
        TerminalErrorCause::InvalidCwd,
        TerminalErrorCause::PermissionDenied,
        TerminalErrorCause::WriteFailed,
        TerminalErrorCause::ResizeFailed,
        TerminalErrorCause::ProcessFailed,
        TerminalErrorCause::TerminationFailed,
        TerminalErrorCause::ProtocolError,
        TerminalErrorCause::StaleGeneration,
        TerminalErrorCause::OutputOverflow,
        TerminalErrorCause::SubscriberFailed,
        TerminalErrorCause::TransportFailed,
        TerminalErrorCause::Unknown,
    ];

    fn parse(text: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|cause| format!("{cause:?}") == text)
    }
}

/// A failure as the user sees it. Commands return it as `"Cause: message"` (`Display`), the
/// convention Local Git's commands use; events carry it as `{code, message}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "RawError")]
pub struct TerminalError {
    pub code: TerminalErrorCause,
    pub message: String,
}

#[derive(Deserialize)]
struct RawError {
    code: TerminalErrorCause,
    message: String,
}

impl TryFrom<RawError> for TerminalError {
    type Error = String;
    fn try_from(raw: RawError) -> Result<Self, String> {
        if raw.message.is_empty() {
            Err("A terminal error needs a message.".into())
        } else {
            Ok(Self::new(raw.code, raw.message))
        }
    }
}

impl TerminalError {
    /// The message is kept on one line: it is shown as a status line, and `"Cause: message"`
    /// must stay one record.
    pub fn new(code: TerminalErrorCause, message: impl Into<String>) -> Self {
        let message: String = message.into().replace(['\r', '\n'], " ");
        let message = if message.trim().is_empty() {
            "The terminal failed unexpectedly.".to_string()
        } else {
            message
        };
        Self { code, message }
    }

    pub fn protocol(message: impl Into<String>) -> Self {
        Self::new(TerminalErrorCause::ProtocolError, message)
    }

    /// A failed OS operation, described by what was being done and the kind of failure -- never
    /// the OS's own text (`os error 5`, paths it chose to quote, debug output). A permission
    /// failure is reported as such whatever was being done.
    pub fn from_io(code: TerminalErrorCause, doing: &str, error: &std::io::Error) -> Self {
        use std::io::ErrorKind::*;
        let (code, why) = match error.kind() {
            PermissionDenied => (TerminalErrorCause::PermissionDenied, "permission denied"),
            NotFound => (code, "not found"),
            BrokenPipe => (code, "the shell has closed its input"),
            WouldBlock => (code, "it is busy"),
            TimedOut => (code, "it timed out"),
            Interrupted => (code, "it was interrupted"),
            InvalidInput | InvalidData => (code, "it was given something it cannot use"),
            OutOfMemory => (code, "out of memory"),
            _ => (code, "an operating system error"),
        };
        Self::new(code, format!("{doing}: {why}."))
    }

    /// Reads `"Cause: message"` back; anything else is not a terminal error.
    pub fn parse_wire(text: &str) -> Option<Self> {
        let (cause, message) = text.split_once(": ")?;
        let code = TerminalErrorCause::parse(cause)?;
        (!message.is_empty()).then(|| Self::new(code, message))
    }
}

impl fmt::Display for TerminalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for TerminalError {}

impl From<TerminalError> for String {
    fn from(error: TerminalError) -> String {
        error.to_string()
    }
}

// ---------------------------------------------------------------------------------------------
// Output protocol

mod base64_bytes {
    use base64::Engine;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&base64::engine::general_purpose::STANDARD.encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        let text = String::deserialize(deserializer)?;
        base64::engine::general_purpose::STANDARD
            .decode(text)
            .map_err(serde::de::Error::custom)
    }
}

/// One piece of a session's output, exactly as the process wrote it.
///
/// `bytes` are raw and may end inside a UTF-8 character, a CSI/ANSI escape or an OSC sequence,
/// or hold several of them; the consumer's streaming decoder keeps the partial tail. One PTY
/// read per chunk (TERMINAL-01) or many reads batched into one (TERMINAL-02): the shape and the
/// meaning of every field are the same. On the wire `bytes` is standard base64.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputChunk {
    pub session_id: TerminalId,
    pub generation: Generation,
    pub seq: Sequence,
    #[serde(with = "base64_bytes")]
    pub bytes: Vec<u8>,
}

/// Numbers one generation's output. The producer owns exactly one per generation, so sequence
/// numbers start at 0, go up by one per chunk and cannot be skipped or reused.
#[derive(Debug)]
pub struct OutputSequencer {
    session_id: TerminalId,
    generation: Generation,
    next: u64,
}

impl OutputSequencer {
    pub fn new(session_id: TerminalId, generation: Generation) -> Self {
        Self {
            session_id,
            generation,
            next: FIRST_SEQUENCE.0,
        }
    }

    /// The next chunk, carrying `bytes` untouched.
    pub fn chunk(&mut self, bytes: Vec<u8>) -> TerminalOutputChunk {
        let seq = Sequence(self.next);
        self.next += 1;
        TerminalOutputChunk {
            session_id: self.session_id.clone(),
            generation: self.generation,
            seq,
            bytes,
        }
    }

    /// The last chunk's number, for the generation's end event; `None` if it had no output.
    pub fn last_seq(&self) -> Option<Sequence> {
        self.next.checked_sub(1).map(Sequence)
    }
}

/// Encodes bytes the way an output chunk carries them.
pub fn encode_bytes(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

// ---------------------------------------------------------------------------------------------
// Events

/// Accepts a field only when it is present, `null` included, so `Option` does not quietly
/// default a missing one to `None`.
fn required<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    Option::deserialize(deserializer)
}

/// The two lifecycle steps that are not an end. `Running` brings the process id (`None` if the
/// platform could not say); `Exiting` brings nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LiveState {
    Running { pid: Option<u32> },
    Exiting,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "RawStateChanged", into = "RawStateChanged")]
pub struct TerminalStateChanged {
    pub session_id: TerminalId,
    pub generation: Generation,
    pub state: LiveState,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawStateChanged {
    session_id: TerminalId,
    generation: Generation,
    state: TerminalState,
    /// Missing: `None`; `null`: `Some(None)`.
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pid: Option<Option<u32>>,
}

fn present<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Option<u32>>, D::Error> {
    Option::deserialize(deserializer).map(Some)
}

impl TryFrom<RawStateChanged> for TerminalStateChanged {
    type Error = String;
    fn try_from(raw: RawStateChanged) -> Result<Self, String> {
        let state = match (raw.state, raw.pid) {
            (TerminalState::Running, Some(pid)) if pid != Some(0) => LiveState::Running { pid },
            (TerminalState::Exiting, None) => LiveState::Exiting,
            _ => return Err("Not a terminal state change.".into()),
        };
        Ok(Self {
            session_id: raw.session_id,
            generation: raw.generation,
            state,
        })
    }
}

impl From<TerminalStateChanged> for RawStateChanged {
    fn from(event: TerminalStateChanged) -> Self {
        let (state, pid) = match event.state {
            LiveState::Running { pid } => (TerminalState::Running, Some(pid)),
            LiveState::Exiting => (TerminalState::Exiting, None),
        };
        Self {
            session_id: event.session_id,
            generation: event.generation,
            state,
            pid,
        }
    }
}

/// The generation's end by the process exiting (`Exited`), sent after its last output chunk.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExit {
    pub session_id: TerminalId,
    pub generation: Generation,
    #[serde(deserialize_with = "required")]
    pub exit_code: Option<i32>,
    #[serde(deserialize_with = "required")]
    pub last_seq: Option<Sequence>,
}

/// The generation's end through an error (`Failed`), sent after its last output chunk.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalErrorEvent {
    pub session_id: TerminalId,
    pub generation: Generation,
    pub error: TerminalError,
    #[serde(deserialize_with = "required")]
    pub last_seq: Option<Sequence>,
}

// ---------------------------------------------------------------------------------------------
// Requests

/// Opens `generation` of `session_id`; the requester chooses the generation, which must be newer
/// than any the id had (`Generation::is_newer_than`). Answers the `TerminalSession`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpenRequest {
    pub session_id: TerminalId,
    pub workspace_id: String,
    pub generation: Generation,
    #[serde(deserialize_with = "required")]
    pub profile: Option<TerminalProfile>,
    #[serde(deserialize_with = "required")]
    pub cwd: Option<String>,
    pub dimensions: TerminalDimensions,
}

/// The most UTF-8 one write request carries; larger input arrives as several, in order.
pub const MAX_WRITE_BYTES: usize = 64 * 1024;

/// Input. Accepting it means it was queued for the session's writer, never that the process has
/// read it: no request waits on the PTY.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalWriteRequest {
    pub session_id: TerminalId,
    pub generation: Generation,
    pub data: String,
}

impl TerminalWriteRequest {
    pub fn validate(&self) -> Result<(), TerminalError> {
        if self.data.len() > MAX_WRITE_BYTES {
            Err(TerminalError::protocol(format!(
                "A terminal write carries at most {MAX_WRITE_BYTES} bytes."
            )))
        } else {
            Ok(())
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResizeRequest {
    pub session_id: TerminalId,
    pub generation: Generation,
    pub dimensions: TerminalDimensions,
}

/// Ends a generation gently; closing an ended or stale generation succeeds and does nothing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCloseRequest {
    pub session_id: TerminalId,
    pub generation: Generation,
}

/// Ends a generation by force: the shell and every process it started.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalKillRequest {
    pub session_id: TerminalId,
    pub generation: Generation,
}

/// Ends `previous_generation` and opens `generation` (newer) with the same profile and folder.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRestartRequest {
    pub session_id: TerminalId,
    pub previous_generation: Generation,
    pub generation: Generation,
    pub dimensions: TerminalDimensions,
}

// ---------------------------------------------------------------------------------------------
// Subscriptions

/// One generation's events for one subscriber -- delivered to it, never broadcast.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSubscribeRequest {
    /// Chosen by the subscriber, like a generation, so it recognises its own stream from the
    /// first message.
    pub subscription_id: SubscriptionId,
    pub session_id: TerminalId,
    pub generation: Generation,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSubscription {
    pub subscription_id: SubscriptionId,
    pub session_id: TerminalId,
    pub generation: Generation,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalUnsubscribeRequest {
    pub subscription_id: SubscriptionId,
}

/// "Everything through `seq` has been accepted by this subscriber." Cumulative: a duplicate or
/// an older one changes nothing, one for another generation is stale, and one beyond what the
/// subscriber has been sent is a protocol error.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAckRequest {
    pub subscription_id: SubscriptionId,
    pub session_id: TerminalId,
    pub generation: Generation,
    pub seq: Sequence,
}

/// The end of one subscriber's stream while the session goes on: it was detached (it fell too
/// far behind, or stopped acknowledging). It has been sent every chunk through `last_seq` and
/// will be sent nothing more -- the loss is stated, never hidden.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDetached {
    pub session_id: TerminalId,
    pub generation: Generation,
    pub error: TerminalError,
    #[serde(deserialize_with = "required")]
    pub last_seq: Option<Sequence>,
}

/// Every message a subscriber receives, in one ordered stream, tagged by `kind`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TerminalMessage {
    Output(TerminalOutputChunk),
    State(TerminalStateChanged),
    Exit(TerminalExit),
    Error(TerminalErrorEvent),
    Detached(TerminalDetached),
}

impl TerminalMessage {
    pub fn session_id(&self) -> &TerminalId {
        match self {
            TerminalMessage::Output(m) => &m.session_id,
            TerminalMessage::State(m) => &m.session_id,
            TerminalMessage::Exit(m) => &m.session_id,
            TerminalMessage::Error(m) => &m.session_id,
            TerminalMessage::Detached(m) => &m.session_id,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id() -> TerminalId {
        TerminalId::new("terminal-a1-1").unwrap()
    }

    #[test]
    fn the_sequencer_numbers_from_zero_without_gaps_and_keeps_bytes_untouched() {
        let mut out = OutputSequencer::new(id(), FIRST_GENERATION);
        assert_eq!(out.last_seq(), None);
        // A UTF-8 character and an escape sequence, each cut in two.
        let pieces: [&[u8]; 3] = [b"\xe2\x82", b"\xac\x1b[3", b"1mred"];
        for (n, piece) in pieces.iter().enumerate() {
            let chunk = out.chunk(piece.to_vec());
            assert_eq!(chunk.seq.get(), n as u64);
            assert_eq!(chunk.bytes, *piece);
            assert_eq!(chunk.generation, FIRST_GENERATION);
        }
        assert_eq!(out.last_seq(), Some(Sequence(2)));
        // A new generation starts again at 0.
        let mut next = OutputSequencer::new(id(), Generation::new(2).unwrap());
        assert_eq!(next.chunk(vec![]).seq, FIRST_SEQUENCE);
    }

    #[test]
    fn generations_start_at_one_and_only_increase() {
        assert!(Generation::new(0).is_err());
        assert!(Generation::new(MAX_SAFE_INTEGER + 1).is_err());
        let one = FIRST_GENERATION;
        let two = Generation::new(2).unwrap();
        assert!(one.is_newer_than(None));
        assert!(two.is_newer_than(Some(one)));
        assert!(!one.is_newer_than(Some(one)));
        assert!(!one.is_newer_than(Some(two)));
        assert!(require_current(two, two).is_ok());
        assert_eq!(
            require_current(one, two).unwrap_err().code,
            TerminalErrorCause::StaleGeneration
        );
    }

    #[test]
    fn the_state_machine_refuses_every_step_it_does_not_list() {
        use TerminalState::*;
        let allowed = [
            (Spawning, Running),
            (Spawning, Failed),
            (Running, Exiting),
            (Running, Failed),
            (Exiting, Exited),
            (Exiting, Failed),
        ];
        for from in TerminalState::ALL {
            for to in TerminalState::ALL {
                let ok = allowed.contains(&(from, to));
                assert_eq!(from.can_transition(to), ok, "{from:?} -> {to:?}");
                assert_eq!(from.transition(to).is_ok(), ok);
            }
        }
        assert!(Exited.is_final() && Failed.is_final() && !Exiting.is_final());
    }

    #[test]
    fn os_failures_are_described_without_the_os_text() {
        let denied = std::io::Error::from_raw_os_error(5);
        let error =
            TerminalError::from_io(TerminalErrorCause::SpawnFailed, "Cannot start sh", &denied);
        // `from_raw_os_error(5)` is access denied on Windows; elsewhere it is EIO.
        if cfg!(windows) {
            assert_eq!(error.code, TerminalErrorCause::PermissionDenied);
        }
        assert!(!error.message.contains("os error"), "{}", error.message);
        let missing = std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "C:\\secret\\path (os error 2)",
        );
        let error =
            TerminalError::from_io(TerminalErrorCause::SpawnFailed, "Cannot start sh", &missing);
        assert_eq!(
            error.to_string(),
            "SpawnFailed: Cannot start sh: not found."
        );
        // Messages stay on one line.
        assert_eq!(
            TerminalError::new(TerminalErrorCause::Unknown, "a\r\nb").message,
            "a  b"
        );
    }

    #[test]
    fn oversized_writes_are_refused() {
        let write = |data: String| TerminalWriteRequest {
            session_id: id(),
            generation: FIRST_GENERATION,
            data,
        };
        assert!(write("x".repeat(MAX_WRITE_BYTES)).validate().is_ok());
        assert!(write("x".repeat(MAX_WRITE_BYTES + 1)).validate().is_err());
    }
}
