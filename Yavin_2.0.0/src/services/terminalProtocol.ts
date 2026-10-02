/**
 * The Terminal contract (TERMINAL-00): identities, the session state machine, typed errors, the
 * output protocol, events, requests, dimensions, subscriptions and profiles that the terminal
 * runtime is built on. Its Rust twin is `src-tauri/crates/ide-terminal-protocol`; the two are
 * held to the same wire forms by `terminalProtocol.fixtures.json`.
 *
 * The terminal speaks only this protocol: the native session runtime (`terminal.rs`,
 * TERMINAL-01) sends these events and takes these requests, and the renderer parses every
 * event with the parsers here. The renderer's own session model (`applyEvent`, subscriptions)
 * arrives with TERMINAL-03. See ARCHITECTURE.md, "Terminal".
 *
 * Nothing here talks to the native side: these are types, validation and the pure rules a
 * consumer applies to a stream of events.
 */
import type { WorkspaceId } from "./workspaceManager.ts";

export type { WorkspaceId };

// ---------------------------------------------------------------------------------------------
// Identities

/** A terminal session. The same id across restarts; `Generation` tells its incarnations apart. */
export type TerminalId = string & { readonly __terminalId: unique symbol };
/** One incarnation (launch) of a session: an integer >= 1, never reused for the same id. */
export type Generation = number & { readonly __terminalGeneration: unique symbol };
/** An output chunk's position within its generation: an integer >= 0. */
export type Sequence = number & { readonly __terminalSequence: unique symbol };
/** One subscriber's delivery of one session's events. */
export type SubscriptionId = string & { readonly __terminalSubscriptionId: unique symbol };

/** The first generation of any session. 0 is never a valid generation. */
export const FIRST_GENERATION = 1 as Generation;
/** The `seq` of the first output chunk of every generation. */
export const FIRST_SEQUENCE = 0 as Sequence;

const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** Ids are 1-128 characters of `[A-Za-z0-9._-]`: safe in logs, maps and file names alike. */
export function isTerminalId(value: unknown): value is TerminalId {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function isSubscriptionId(value: unknown): value is SubscriptionId {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function isGeneration(value: unknown): value is Generation {
  return Number.isSafeInteger(value) && (value as number) >= FIRST_GENERATION;
}

export function isSequence(value: unknown): value is Sequence {
  return Number.isSafeInteger(value) && (value as number) >= FIRST_SEQUENCE;
}

/**
 * Whether `candidate` may follow `previous` for the same session id: generations only ever
 * increase. A restart, or a closed id opened again, takes a newer one; anything else is stale.
 */
export function isNewerGeneration(candidate: Generation, previous: Generation | null): boolean {
  return previous === null || candidate > previous;
}

// ---------------------------------------------------------------------------------------------
// The session state machine

/**
 * One lifecycle, one state per generation.
 *
 * - `Spawning`: the open was accepted; the process is being started.
 * - `Running`: the process runs; output and input flow.
 * - `Exiting`: the process's end has been seen or asked for; output still drains.
 * - `Exited`: the process ended and every chunk of output has been delivered. Final.
 * - `Failed`: the generation ended through an error (it could not start, or broke). Final.
 */
export type TerminalState = "Spawning" | "Running" | "Exiting" | "Exited" | "Failed";

export const TERMINAL_STATES: readonly TerminalState[] = [
  "Spawning",
  "Running",
  "Exiting",
  "Exited",
  "Failed",
];

const TRANSITIONS: Readonly<Record<TerminalState, readonly TerminalState[]>> = {
  Spawning: ["Running", "Failed"],
  Running: ["Exiting", "Failed"],
  Exiting: ["Exited", "Failed"],
  Exited: [],
  Failed: [],
};

export function canTransition(from: TerminalState, to: TerminalState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** `Exited` and `Failed` end a generation: nothing of it is valid afterwards. */
export function isFinalState(state: TerminalState): boolean {
  return TRANSITIONS[state].length === 0;
}

// ---------------------------------------------------------------------------------------------
// Dimensions

/**
 * The terminal's size in character cells. Pixel sizes are not part of the contract: the
 * renderer measures its own layout and sends only the cells that layout holds.
 */
export interface TerminalDimensions {
  cols: number;
  rows: number;
}

export const MIN_DIMENSION = 1;
export const MAX_COLS = 1000;
export const MAX_ROWS = 1000;

/**
 * `null` when the size is valid: whole numbers of cells, at least 1 and at most 1000 each way.
 * Zero, negative, fractional or non-finite sizes are refused, not clamped -- the renderer turns
 * a not-yet-laid-out panel into a real size before asking (see `usableSize`).
 */
export function validateDimensions(value: unknown): TerminalError | null {
  const size = value as Partial<TerminalDimensions> | null;
  const ok = (n: unknown, max: number) =>
    Number.isInteger(n) && (n as number) >= MIN_DIMENSION && (n as number) <= max;
  if (!size || typeof size !== "object" || !ok(size.cols, MAX_COLS) || !ok(size.rows, MAX_ROWS))
    return new TerminalError(
      "ProtocolError",
      `A terminal is 1-${MAX_COLS} columns by 1-${MAX_ROWS} rows.`,
    );
  return null;
}

// ---------------------------------------------------------------------------------------------
// Profiles

/**
 * How a terminal is launched: only what today's launch plumbing already carries (`terminal_open`
 * takes a shell, arguments, environment pairs and a folder). A login-shell switch is not a
 * field: the native side has no notion of one, and a profile asks for it through `args`.
 */
export interface TerminalProfile {
  id: string;
  /** Shown on the tab and in the New Terminal menu. */
  name: string;
  /** The shell to start: one the native side detected (it refuses anything else). */
  executable: string;
  args: string[];
  /** Where the shell starts; the workspace root when `null`. */
  cwd: string | null;
  /** Ordered pairs, not an object: a variable may be written in terms of an earlier one. */
  env: [string, string][];
}

const LAUNCH_TEXT = /^[^\0\r\n]*$/;

/** `null` when the profile can be sent: the same rules the native launch enforces. */
export function validateProfile(profile: TerminalProfile): TerminalError | null {
  const bad = (message: string) => new TerminalError("ProtocolError", message);
  if (!profile.id.trim()) return bad("A terminal profile needs an id.");
  if (!profile.name.trim()) return bad("A terminal profile needs a name.");
  if (!profile.executable.trim()) return bad("A terminal profile needs a shell to start.");
  for (const arg of profile.args)
    if (!LAUNCH_TEXT.test(arg)) return bad("Shell arguments cannot contain line breaks or NUL.");
  for (const [name, value] of profile.env) {
    if (!name || name.includes("=") || !LAUNCH_TEXT.test(name))
      return bad(`"${name}" is not a valid environment variable name.`);
    if (!LAUNCH_TEXT.test(value))
      return bad(`The value of ${name} cannot contain line breaks or NUL.`);
  }
  if (profile.cwd !== null && (!profile.cwd || !LAUNCH_TEXT.test(profile.cwd)))
    return bad("A terminal's folder cannot be empty or contain line breaks or NUL.");
  return null;
}

// ---------------------------------------------------------------------------------------------
// Sessions

/**
 * What identifies and describes a session independently of any one launch: what a later module
 * may keep across a reload. Never a native handle, a pid or anything else of one process.
 */
export interface TerminalSessionMetadata {
  sessionId: TerminalId;
  workspaceId: WorkspaceId;
  /** The profile it was opened with; `null` for the native default shell. */
  profile: TerminalProfile | null;
  /** The folder it was asked to start in; `null` for the workspace root. */
  cwd: string | null;
}

/** One generation's live facts. Runtime only: none of it survives the process. */
export interface TerminalSessionRuntime {
  generation: Generation;
  state: TerminalState;
  /** The shell's process id once it is known (from `Running`); `null` before, or if unknown. */
  pid: number | null;
  dimensions: TerminalDimensions;
  /** Milliseconds since the epoch at which this generation was opened. */
  startedAt: number;
  /** Set with `Exited`: the process's exit code, `null` when the platform reported none. */
  exitCode: number | null;
}

export type TerminalSession = TerminalSessionMetadata & TerminalSessionRuntime;

// ---------------------------------------------------------------------------------------------
// Errors

/**
 * Why a terminal operation failed. The native side reports a failure as `"Cause: message"`,
 * the convention Local Git's commands use; `asTerminalError` reads it back.
 */
export type TerminalErrorCause =
  | "InvalidSession"
  | "InvalidWorkspace"
  | "ShellUnavailable"
  | "SpawnFailed"
  | "InvalidCwd"
  | "PermissionDenied"
  | "WriteFailed"
  | "ResizeFailed"
  | "ProcessFailed"
  | "TerminationFailed"
  | "ProtocolError"
  /** A request or acknowledgement named a generation other than the current one. */
  | "StaleGeneration"
  /** A subscriber fell so far behind that it was detached rather than sent a stream with a hole. */
  | "OutputOverflow"
  /** A subscriber stopped acknowledging output and was detached. */
  | "SubscriberFailed"
  /** Output could not be handed to a subscriber's transport. */
  | "TransportFailed"
  | "Unknown";

export const TERMINAL_ERROR_CAUSES: readonly TerminalErrorCause[] = [
  "InvalidSession",
  "InvalidWorkspace",
  "ShellUnavailable",
  "SpawnFailed",
  "InvalidCwd",
  "PermissionDenied",
  "WriteFailed",
  "ResizeFailed",
  "ProcessFailed",
  "TerminationFailed",
  "ProtocolError",
  "StaleGeneration",
  "OutputOverflow",
  "SubscriberFailed",
  "TransportFailed",
  "Unknown",
];

const UNKNOWN_MESSAGE = "The terminal failed unexpectedly.";

/**
 * A terminal failure as the UI shows it: a `code` (its cause) to branch on and a sentence to
 * display.
 * `detail` keeps what an unrecognised native failure said, for logs only -- it is never the
 * message, so a raw native error never reaches the screen.
 */
export class TerminalError extends Error {
  readonly code: TerminalErrorCause;
  readonly detail: string | undefined;
  constructor(code: TerminalErrorCause, message: string, detail?: string) {
    super(message);
    this.name = "TerminalError";
    this.code = code;
    this.detail = detail;
  }

  /** The wire form: `"Cause: message"`. */
  toWire(): string {
    return `${this.code}: ${this.message}`;
  }

  toJSON(): { code: TerminalErrorCause; message: string } {
    return { code: this.code, message: this.message };
  }
}

function isCause(value: unknown): value is TerminalErrorCause {
  return TERMINAL_ERROR_CAUSES.includes(value as TerminalErrorCause);
}

/**
 * Reads a failure from the native side (an invoke rejection) or an event's `{code, message}`.
 * Anything not in the contract's shape becomes `Unknown` with a generic message.
 */
export function asTerminalError(error: unknown): TerminalError {
  if (error instanceof TerminalError) return error;
  if (error && typeof error === "object") {
    const { code, message } = error as { code?: unknown; message?: unknown };
    if (isCause(code) && typeof message === "string" && message)
      return new TerminalError(code, message);
  }
  const text = typeof error === "string" ? error : String(error);
  const match = /^([A-Za-z]+): (.+)$/s.exec(text);
  if (match && isCause(match[1])) return new TerminalError(match[1], match[2]);
  return new TerminalError("Unknown", UNKNOWN_MESSAGE, text);
}

// ---------------------------------------------------------------------------------------------
// Output protocol

/**
 * One piece of a session's output, exactly as the process wrote it.
 *
 * `bytes` are raw: a chunk may end inside a UTF-8 character, an ANSI/CSI escape or an OSC
 * sequence, and may hold several of them. Nothing in the protocol decodes it -- the consumer
 * feeds the bytes, in `seq` order, to a streaming decoder (xterm's `write(Uint8Array)`), which
 * keeps the partial tail for the next chunk. One read or a batch of many reads: the shape is
 * the same either way.
 */
export interface TerminalOutputChunk {
  sessionId: TerminalId;
  generation: Generation;
  seq: Sequence;
  bytes: Uint8Array;
}

/** On the wire (JSON), `bytes` is standard base64. */
export interface TerminalOutputChunkWire {
  sessionId: string;
  generation: number;
  seq: number;
  bytes: string;
}

export function encodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** `null` when `text` is not standard base64. */
export function decodeBytes(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return null;
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toWireChunk(chunk: TerminalOutputChunk): TerminalOutputChunkWire {
  return {
    sessionId: chunk.sessionId,
    generation: chunk.generation,
    seq: chunk.seq,
    bytes: encodeBytes(chunk.bytes),
  };
}

// ---------------------------------------------------------------------------------------------
// Events

/** A lifecycle step other than the final one. `pid` comes with `Running`, and only with it. */
export interface TerminalStateChanged {
  sessionId: TerminalId;
  generation: Generation;
  state: "Running" | "Exiting";
  pid?: number | null;
}

/**
 * The generation's end by the process exiting: its state is now `Exited`. `lastSeq` is the
 * `seq` of its final output chunk (`null` if it wrote nothing), so a consumer knows it has
 * everything.
 */
export interface TerminalExit {
  sessionId: TerminalId;
  generation: Generation;
  exitCode: number | null;
  lastSeq: Sequence | null;
}

/** The generation's end through an error: its state is now `Failed`. */
export interface TerminalErrorEvent {
  sessionId: TerminalId;
  generation: Generation;
  error: { code: TerminalErrorCause; message: string };
  lastSeq: Sequence | null;
}

/**
 * The end of one subscriber's stream while the session goes on: it was detached (it fell too
 * far behind, or stopped acknowledging). It has every chunk through `lastSeq` and will get
 * nothing more -- the loss is stated, never hidden.
 */
export interface TerminalDetached {
  sessionId: TerminalId;
  generation: Generation;
  error: { code: TerminalErrorCause; message: string };
  lastSeq: Sequence | null;
}

/**
 * Every message a subscriber receives, in one ordered stream on its own channel, tagged by
 * `kind`: per subscriber, `Running`, the output in `seq` order, `Exiting`, then exactly one of
 * exit, error or detached.
 */
export type TerminalEvent =
  | ({ kind: "output" } & TerminalOutputChunk)
  | ({ kind: "state" } & TerminalStateChanged)
  | ({ kind: "exit" } & TerminalExit)
  | ({ kind: "error" } & TerminalErrorEvent)
  | ({ kind: "detached" } & TerminalDetached);

const record = (payload: unknown): Record<string, unknown> | null =>
  payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;

const lastSeqOf = (value: unknown): Sequence | null | undefined =>
  value === null ? null : isSequence(value) ? value : undefined;

/** Typed-event parsers: `null` for anything not in the contract's shape. */
export function parseOutputChunk(payload: unknown): TerminalOutputChunk | null {
  const p = record(payload);
  if (!p || !isTerminalId(p.sessionId) || !isGeneration(p.generation) || !isSequence(p.seq))
    return null;
  if (typeof p.bytes !== "string") return null;
  const bytes = decodeBytes(p.bytes);
  return bytes && { sessionId: p.sessionId, generation: p.generation, seq: p.seq, bytes };
}

export function parseStateChanged(payload: unknown): TerminalStateChanged | null {
  const p = record(payload);
  if (!p || !isTerminalId(p.sessionId) || !isGeneration(p.generation)) return null;
  if (p.state === "Exiting" && p.pid === undefined)
    return { sessionId: p.sessionId, generation: p.generation, state: "Exiting" };
  if (
    p.state === "Running" &&
    (p.pid === null || (Number.isSafeInteger(p.pid) && (p.pid as number) > 0))
  )
    return {
      sessionId: p.sessionId,
      generation: p.generation,
      state: "Running",
      pid: p.pid as number | null,
    };
  return null;
}

export function parseExit(payload: unknown): TerminalExit | null {
  const p = record(payload);
  if (!p || !isTerminalId(p.sessionId) || !isGeneration(p.generation)) return null;
  if (!(p.exitCode === null || Number.isSafeInteger(p.exitCode))) return null;
  const lastSeq = lastSeqOf(p.lastSeq);
  if (lastSeq === undefined) return null;
  return {
    sessionId: p.sessionId,
    generation: p.generation,
    exitCode: p.exitCode as number | null,
    lastSeq,
  };
}

export function parseErrorEvent(payload: unknown): TerminalErrorEvent | null {
  const p = record(payload);
  const e = record(p?.error);
  if (!p || !e || !isTerminalId(p.sessionId) || !isGeneration(p.generation)) return null;
  if (!isCause(e.code) || typeof e.message !== "string" || !e.message) return null;
  const lastSeq = lastSeqOf(p.lastSeq);
  if (lastSeq === undefined) return null;
  return {
    sessionId: p.sessionId,
    generation: p.generation,
    error: { code: e.code, message: e.message },
    lastSeq,
  };
}

export function parseDetached(payload: unknown): TerminalDetached | null {
  // The same shape as an error end.
  return parseErrorEvent(payload);
}

/** Any message a subscriber's channel delivers; `null` for anything not in the contract. */
export function parseTerminalMessage(payload: unknown): TerminalEvent | null {
  const p = record(payload);
  switch (p?.kind) {
    case "output": {
      const chunk = parseOutputChunk(p);
      return chunk && { kind: "output", ...chunk };
    }
    case "state": {
      const event = parseStateChanged(p);
      return event && { kind: "state", ...event };
    }
    case "exit": {
      const event = parseExit(p);
      return event && { kind: "exit", ...event };
    }
    case "error": {
      const event = parseErrorEvent(p);
      return event && { kind: "error", ...event };
    }
    case "detached": {
      const event = parseDetached(p);
      return event && { kind: "detached", ...event };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// The consumer's rules

/** What a consumer knows of the one generation it is showing. */
export interface TerminalStream {
  sessionId: TerminalId;
  generation: Generation;
  state: TerminalState;
  /** The `seq` the next output chunk must carry. */
  nextSeq: Sequence;
}

export type StreamRejection =
  /** Another session's event: not this stream's to apply. */
  | "other-session"
  /** An event of a generation other than the current one: late, or from a replaced launch. */
  | "stale-generation"
  /** A chunk already applied (a `seq` below the next one): dropped, never applied twice. */
  | "duplicate"
  /** A chunk past the next one: output went missing, which the protocol never allows. */
  | "gap"
  /** Anything after `Exited` or `Failed`, or output the end's `lastSeq` did not account for. */
  | "after-end"
  /** A lifecycle step the state machine does not allow from the current state. */
  | "illegal-transition";

export type StreamVerdict =
  | { accepted: true; stream: TerminalStream }
  | { accepted: false; reason: StreamRejection; stream: TerminalStream };

/** A stream for a generation that has just been opened (`Spawning`). */
export function openStream(sessionId: TerminalId, generation: Generation): TerminalStream {
  return { sessionId, generation, state: "Spawning", nextSeq: FIRST_SEQUENCE };
}

/**
 * Applies one event to the stream of the generation being shown, or says why not. An event
 * the stream rejects changes nothing: a late event of an old generation can never touch the
 * current one, and an ended generation stays ended.
 */
export function applyEvent(stream: TerminalStream, event: TerminalEvent): StreamVerdict {
  const reject = (reason: StreamRejection): StreamVerdict => ({
    accepted: false,
    reason,
    stream,
  });
  const accept = (next: Partial<TerminalStream>): StreamVerdict => ({
    accepted: true,
    stream: { ...stream, ...next },
  });
  if (event.sessionId !== stream.sessionId) return reject("other-session");
  if (event.generation !== stream.generation) return reject("stale-generation");
  if (isFinalState(stream.state)) return reject("after-end");

  switch (event.kind) {
    case "output":
      // Output flows while the process runs and while its end drains.
      if (stream.state !== "Running" && stream.state !== "Exiting")
        return reject("illegal-transition");
      if (event.seq < stream.nextSeq) return reject("duplicate");
      if (event.seq > stream.nextSeq) return reject("gap");
      return accept({ nextSeq: (stream.nextSeq + 1) as Sequence });
    case "state":
      return canTransition(stream.state, event.state)
        ? accept({ state: event.state })
        : reject("illegal-transition");
    case "exit":
    case "error":
    case "detached": {
      // A detached subscriber's stream ends like a failed one, for that subscriber alone.
      const to = event.kind === "exit" ? "Exited" : "Failed";
      if (!canTransition(stream.state, to)) return reject("illegal-transition");
      // The end says how much output there was: all of it must already have arrived. (A
      // subscriber that joined mid-stream knows from its first chunk where it started.)
      const expected = event.lastSeq === null ? FIRST_SEQUENCE : event.lastSeq + 1;
      if (expected !== stream.nextSeq)
        return reject(expected > stream.nextSeq ? "gap" : "after-end");
      return accept({ state: to });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Requests

/**
 * Opens generation `generation` of `sessionId`. The requester (the workspace's TerminalService)
 * chooses the generation, so it can recognise the generation's events from the very first one,
 * which may arrive before this request's answer. It must be newer than any generation the id
 * had before (`isNewerGeneration`); the native side refuses one that is not.
 * Answers the session as it now is (`Spawning` or already `Running`).
 */
export interface TerminalOpenRequest {
  sessionId: TerminalId;
  workspaceId: WorkspaceId;
  generation: Generation;
  /** `null`: the native default shell, with no extra arguments or environment. */
  profile: TerminalProfile | null;
  /** Overrides the profile's folder; `null` keeps it (or the workspace root). */
  cwd: string | null;
  dimensions: TerminalDimensions;
}

/**
 * Input for the shell. Answering means the input was accepted for delivery -- queued for the
 * session's writer -- never that the process has read it: a write never waits on the PTY.
 * One request carries at most `MAX_WRITE_BYTES` of UTF-8; larger input is split with
 * `chunkInput` and sent in order.
 */
export interface TerminalWriteRequest {
  sessionId: TerminalId;
  generation: Generation;
  data: string;
}

export const MAX_WRITE_BYTES = 64 * 1024;

/**
 * Splits input into pieces of at most `maxBytes` UTF-8 bytes each, never inside a character,
 * so each piece is valid text and the pieces in order are exactly the input.
 */
export function chunkInput(data: string, maxBytes = MAX_WRITE_BYTES): string[] {
  if (maxBytes < 4) throw new RangeError("A write chunk must hold any one character.");
  const pieces: string[] = [];
  let start = 0;
  let bytes = 0;
  let i = 0;
  while (i < data.length) {
    const code = data.codePointAt(i)!;
    const units = code > 0xffff ? 2 : 1;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + size > maxBytes) {
      pieces.push(data.slice(start, i));
      start = i;
      bytes = 0;
    }
    bytes += size;
    i += units;
  }
  if (start < data.length) pieces.push(data.slice(start));
  return pieces;
}

/** The latest size wins; only a `Running` generation is resized (a new one opens at its size). */
export interface TerminalResizeRequest {
  sessionId: TerminalId;
  generation: Generation;
  dimensions: TerminalDimensions;
}

/**
 * Ends a generation the gentle way (the shell is hung up). Idempotent: closing a generation
 * that has already ended, or a stale one, succeeds and changes nothing.
 */
export interface TerminalCloseRequest {
  sessionId: TerminalId;
  generation: Generation;
}

/** Ends a generation by force: the shell and every process it started. */
export interface TerminalKillRequest {
  sessionId: TerminalId;
  generation: Generation;
}

/**
 * Ends `previousGeneration` (if it is still going) and opens `generation` of the same session
 * with the same profile and folder. `generation` must be newer than `previousGeneration`.
 */
export interface TerminalRestartRequest {
  sessionId: TerminalId;
  previousGeneration: Generation;
  generation: Generation;
  dimensions: TerminalDimensions;
}

// ---------------------------------------------------------------------------------------------
// Subscriptions

/**
 * Asks for one generation's events, delivered to this subscriber alone -- not broadcast.
 * Several subscribers may follow one session; each gets every event of the generation from the
 * moment it subscribes. Replay of output from before subscribing is not part of the contract
 * yet (TERMINAL-03 adds where to start from). The subscriber chooses its id, like a
 * generation, so it recognises its own stream from the first message.
 */
export interface TerminalSubscribeRequest {
  subscriptionId: SubscriptionId;
  sessionId: TerminalId;
  generation: Generation;
}

/**
 * "Everything through `seq` has been accepted by this subscriber" -- sent once its terminal
 * has parsed the chunk. Cumulative: a duplicate or an older one changes nothing, one for
 * another generation is stale, one beyond what was sent is a protocol error. Unacknowledged
 * output is what holds a subscriber's window (and, past the bound, its terminal's reader).
 */
export interface TerminalAckRequest {
  subscriptionId: SubscriptionId;
  sessionId: TerminalId;
  generation: Generation;
  seq: Sequence;
}

export interface TerminalSubscription {
  subscriptionId: SubscriptionId;
  sessionId: TerminalId;
  generation: Generation;
}

/** Ends one subscription; the session and its other subscribers are unaffected. Idempotent. */
export interface TerminalUnsubscribeRequest {
  subscriptionId: SubscriptionId;
}
