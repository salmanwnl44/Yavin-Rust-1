import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  FIRST_GENERATION,
  FIRST_SEQUENCE,
  TERMINAL_ERROR_CAUSES,
  TERMINAL_STATES,
  TerminalError,
  applyEvent,
  asTerminalError,
  canTransition,
  chunkInput,
  decodeBytes,
  encodeBytes,
  isFinalState,
  isGeneration,
  isNewerGeneration,
  isSequence,
  isSubscriptionId,
  isTerminalId,
  openStream,
  parseErrorEvent,
  parseExit,
  parseOutputChunk,
  parseStateChanged,
  parseTerminalMessage,
  toWireChunk,
  validateDimensions,
  validateProfile,
} from "./terminalProtocol.ts";
import type {
  Generation,
  Sequence,
  TerminalEvent,
  TerminalId,
  TerminalProfile,
  TerminalSession,
  TerminalStream,
} from "./terminalProtocol.ts";
import { workspaceIdOf } from "./workspaceManager.ts";

const fixtures = JSON.parse(
  readFileSync(new URL("./terminalProtocol.fixtures.json", import.meta.url), "utf8"),
);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const id = "terminal-a1-1" as TerminalId;
const gen = (n: number) => n as Generation;
const seq = (n: number) => n as Sequence;

// --- State machine ---------------------------------------------------------------------------

test("the state machine allows exactly the documented transitions", () => {
  for (const from of TERMINAL_STATES)
    for (const to of TERMINAL_STATES)
      assert.equal(
        canTransition(from, to),
        (fixtures.transitions[from] as string[]).includes(to),
        `${from} -> ${to}`,
      );
});

test("Exited and Failed are final; nothing goes backwards or skips Exiting", () => {
  assert.deepEqual(TERMINAL_STATES.filter(isFinalState), ["Exited", "Failed"]);
  assert.ok(!canTransition("Running", "Spawning"));
  assert.ok(!canTransition("Running", "Exited"));
  assert.ok(!canTransition("Spawning", "Exiting"));
  assert.ok(!canTransition("Exited", "Running"));
  assert.ok(!canTransition("Failed", "Spawning"));
});

// --- Identity --------------------------------------------------------------------------------

test("session ids are 1-128 characters of a safe alphabet", () => {
  assert.ok(isTerminalId("terminal-lx2k-7"));
  assert.ok(isTerminalId("a.b_c-1"));
  assert.ok(isTerminalId("x".repeat(128)));
  for (const bad of ["", "x".repeat(129), "has space", "a/b", "é", 7, null])
    assert.ok(!isTerminalId(bad), String(bad));
});

test("events of different sessions are told apart, and the workspace identity is the canonical one", () => {
  const stream = openStream(id, FIRST_GENERATION);
  const other: TerminalEvent = {
    kind: "state",
    sessionId: "terminal-a1-2" as TerminalId,
    generation: FIRST_GENERATION,
    state: "Running",
    pid: 1,
  };
  assert.deepEqual(applyEvent(stream, other), {
    accepted: false,
    reason: "other-session",
    stream,
  });
  const session = fixtures.session as TerminalSession;
  assert.equal(session.workspaceId, workspaceIdOf(["c:\\work"]));
});

// --- Generation ------------------------------------------------------------------------------

test("generations start at 1 and only ever increase for a session", () => {
  assert.equal(FIRST_GENERATION, 1);
  assert.ok(!isGeneration(0));
  assert.ok(!isGeneration(-1));
  assert.ok(!isGeneration(1.5));
  assert.ok(!isGeneration(Number.MAX_SAFE_INTEGER + 1));
  assert.ok(isGeneration(1));
  // First open, a restart, and a closed id opened again each take a newer generation.
  assert.ok(isNewerGeneration(gen(1), null));
  assert.ok(isNewerGeneration(gen(2), gen(1)));
  assert.ok(!isNewerGeneration(gen(1), gen(1)));
  assert.ok(!isNewerGeneration(gen(1), gen(2)));
});

const running = (generation = 1): TerminalStream => ({
  ...openStream(id, gen(generation)),
  state: "Running",
});
const output = (generation: number, n: number, bytes = [0x61]): TerminalEvent => ({
  kind: "output",
  sessionId: id,
  generation: gen(generation),
  seq: seq(n),
  bytes: Uint8Array.from(bytes),
});

test("the current generation's events are accepted; a stale generation's never are", () => {
  const stream = running(2);
  assert.ok(applyEvent(stream, output(2, 0)).accepted);
  for (const old of [
    output(1, 0),
    { kind: "exit", sessionId: id, generation: gen(1), exitCode: 0, lastSeq: null } as const,
    {
      kind: "state",
      sessionId: id,
      generation: gen(1),
      state: "Exiting",
    } as const,
  ]) {
    const verdict = applyEvent(stream, old);
    assert.equal(verdict.accepted, false);
    assert.equal(verdict.accepted === false && verdict.reason, "stale-generation");
    assert.equal(verdict.stream, stream, "a rejected event changes nothing");
  }
  // A late event of a *newer* generation is not this stream's either.
  assert.equal(applyEvent(stream, output(3, 0)).accepted, false);
});

// --- Sequence --------------------------------------------------------------------------------

test("output starts at seq 0 and is accepted only in order, one by one", () => {
  assert.equal(FIRST_SEQUENCE, 0);
  let stream = running();
  assert.equal(stream.nextSeq, 0);
  for (let n = 0; n < 5; n++) {
    const verdict = applyEvent(stream, output(1, n));
    assert.ok(verdict.accepted, `seq ${n}`);
    stream = verdict.stream;
  }
  assert.equal(stream.nextSeq, 5);
  const duplicate = applyEvent(stream, output(1, 3));
  assert.equal(duplicate.accepted === false && duplicate.reason, "duplicate");
  const gap = applyEvent(stream, output(1, 7));
  assert.equal(gap.accepted === false && gap.reason, "gap");
});

test("lifecycle events do not move seq, and a new generation starts again at 0", () => {
  let stream = applyEvent(running(), output(1, 0)).stream;
  stream = applyEvent(stream, {
    kind: "state",
    sessionId: id,
    generation: gen(1),
    state: "Exiting",
  }).stream;
  assert.equal(stream.nextSeq, 1);
  // Output still drains while Exiting.
  stream = applyEvent(stream, output(1, 1)).stream;
  assert.equal(stream.nextSeq, 2);
  assert.equal(openStream(id, gen(2)).nextSeq, FIRST_SEQUENCE);
});

test("an end accounts for all output, and nothing of an ended generation is accepted", () => {
  const two = applyEvent(applyEvent(running(), output(1, 0)).stream, output(1, 1)).stream;
  const exiting = applyEvent(two, {
    kind: "state",
    sessionId: id,
    generation: gen(1),
    state: "Exiting",
  }).stream;
  const exit = (lastSeq: number | null): TerminalEvent => ({
    kind: "exit",
    sessionId: id,
    generation: gen(1),
    exitCode: 0,
    lastSeq: lastSeq as Sequence | null,
  });
  // The exit says output went up to seq 3, but only 0 and 1 arrived: something is missing.
  const early = applyEvent(exiting, exit(3));
  assert.equal(early.accepted === false && early.reason, "gap");

  const ended = applyEvent(exiting, exit(1));
  assert.ok(ended.accepted);
  assert.equal(ended.stream.state, "Exited");
  for (const late of [output(1, 2), exit(1)]) {
    const verdict = applyEvent(ended.stream, late);
    assert.equal(verdict.accepted === false && verdict.reason, "after-end");
  }
});

test("a generation that wrote nothing ends with lastSeq null", () => {
  const exiting: TerminalStream = { ...running(), state: "Exiting" };
  const verdict = applyEvent(exiting, {
    kind: "exit",
    sessionId: id,
    generation: gen(1),
    exitCode: 1,
    lastSeq: null,
  });
  assert.ok(verdict.accepted);
});

test("lifecycle events follow the state machine", () => {
  const spawning = openStream(id, FIRST_GENERATION);
  // No output, Exiting or Exited before the process is running.
  for (const event of [
    output(1, 0),
    { kind: "state", sessionId: id, generation: gen(1), state: "Exiting" } as const,
    { kind: "exit", sessionId: id, generation: gen(1), exitCode: 0, lastSeq: null } as const,
  ]) {
    const verdict = applyEvent(spawning, event);
    assert.equal(verdict.accepted === false && verdict.reason, "illegal-transition");
  }
  // A launch can fail before it ever runs.
  const failed = applyEvent(spawning, {
    kind: "error",
    sessionId: id,
    generation: gen(1),
    error: { code: "SpawnFailed", message: "Cannot start sh." },
    lastSeq: null,
  });
  assert.ok(failed.accepted);
  assert.equal(failed.stream.state, "Failed");
});

// --- Output contract -------------------------------------------------------------------------

test("every fixture chunk parses to exactly its bytes and writes back identically", () => {
  for (const { about, wire, hex: expected } of fixtures.outputChunks) {
    const chunk = parseOutputChunk(wire);
    assert.ok(chunk, about);
    assert.ok(chunk.bytes instanceof Uint8Array, about);
    assert.equal(hex(chunk.bytes), expected, about);
    assert.deepEqual(toWireChunk(chunk), wire, about);
  }
});

test("chunks that are not in the contract's shape are refused", () => {
  for (const wire of fixtures.invalidOutputChunks)
    assert.equal(parseOutputChunk(wire), null, JSON.stringify(wire));
  assert.equal(parseOutputChunk(null), null);
  assert.equal(parseOutputChunk("text"), null);
});

test("arbitrary bytes survive the round trip, every value and every length", () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  for (let length = 0; length <= 256; length += 37) {
    const bytes = all.subarray(0, length);
    assert.equal(hex(decodeBytes(encodeBytes(bytes))!), hex(bytes));
  }
  const big = new Uint8Array(200_000).map((_, i) => (i * 31) % 256);
  assert.equal(hex(decodeBytes(encodeBytes(big))!), hex(big));
});

test("a character or escape split across chunks is left split: nothing is decoded", () => {
  const euro = Buffer.from("€", "utf8"); // e2 82 ac
  const sgr = Buffer.from("\x1b[31mred", "utf8");
  const whole = Buffer.concat([euro, sgr]);
  // Cut inside the character and inside the escape sequence.
  const parts = [whole.subarray(0, 2), whole.subarray(2, 5), whole.subarray(5)];
  const chunks = parts.map((part, n) =>
    parseOutputChunk({
      sessionId: id,
      generation: 1,
      seq: n,
      bytes: Buffer.from(part).toString("base64"),
    }),
  );
  // Each chunk holds exactly its bytes, even the ones that are not valid text on their own.
  chunks.forEach((chunk, n) => assert.equal(hex(chunk!.bytes), hex(parts[n])));
  const joined = Buffer.concat(chunks.map((chunk) => chunk!.bytes));
  assert.equal(joined.toString("utf8"), "€\x1b[31mred");
});

// --- Events ----------------------------------------------------------------------------------

test("lifecycle events parse, and malformed ones are refused", () => {
  for (const event of fixtures.stateChanges)
    assert.deepEqual(parseStateChanged(event), event, JSON.stringify(event));
  for (const event of fixtures.invalidStateChanges)
    assert.equal(parseStateChanged(event), null, JSON.stringify(event));
  for (const event of fixtures.exits) assert.deepEqual(parseExit(event), event);
  for (const event of fixtures.invalidExits)
    assert.equal(parseExit(event), null, JSON.stringify(event));
  for (const event of fixtures.errorEvents) assert.deepEqual(parseErrorEvent(event), event);
  for (const event of fixtures.invalidErrorEvents)
    assert.equal(parseErrorEvent(event), null, JSON.stringify(event));
});

// --- Errors ----------------------------------------------------------------------------------

test("every cause reads back from its wire form and writes back identically", () => {
  assert.deepEqual(
    fixtures.errors.map((e: { code: string }) => e.code),
    TERMINAL_ERROR_CAUSES,
  );
  for (const { wire, code, message } of fixtures.errors) {
    const error = asTerminalError(wire);
    assert.equal(error.code, code);
    assert.equal(error.message, message);
    assert.equal(error.toWire(), wire);
    assert.deepEqual(asTerminalError(JSON.parse(JSON.stringify(error))), error);
  }
});

test("an unrecognised native failure never reaches the screen as its raw text", () => {
  for (const raw of fixtures.unrecognisedErrors) {
    const error = asTerminalError(raw);
    assert.equal(error.code, "Unknown");
    assert.equal(error.message, "The terminal failed unexpectedly.");
    assert.equal(error.detail, raw, "kept for logs");
  }
  assert.equal(asTerminalError(new Error("Os { code: 2 }")).code, "Unknown");
  const typed = new TerminalError("WriteFailed", "x");
  assert.equal(asTerminalError(typed), typed);
});

// --- Dimensions ------------------------------------------------------------------------------

test("dimensions are whole cells from 1 to 1000, and anything else is refused", () => {
  for (const size of fixtures.dimensions.valid) assert.equal(validateDimensions(size), null);
  for (const size of [...fixtures.dimensions.invalid, null, { cols: NaN, rows: 24 }]) {
    const error = validateDimensions(size);
    assert.equal(error?.code, "ProtocolError", JSON.stringify(size));
  }
});

// --- Profiles --------------------------------------------------------------------------------

test("profiles keep every supported field, environment order included", () => {
  for (const profile of fixtures.profiles as TerminalProfile[]) {
    assert.equal(validateProfile(profile), null, profile.id);
    assert.deepEqual(JSON.parse(JSON.stringify(profile)), profile);
  }
  const [bash] = fixtures.profiles as TerminalProfile[];
  assert.deepEqual(
    bash.env.map(([name]) => name),
    ["BASE", "TOOLS"],
  );
  for (const profile of fixtures.invalidProfiles as TerminalProfile[])
    assert.equal(validateProfile(profile)?.code, "ProtocolError", JSON.stringify(profile));
});

// --- Input -----------------------------------------------------------------------------------

test("large input is split at character boundaries into pieces that rejoin exactly", () => {
  const text = "ab€😀".repeat(5000);
  const pieces = chunkInput(text, 64);
  assert.equal(pieces.join(""), text);
  for (const piece of pieces) {
    assert.ok(Buffer.byteLength(piece, "utf8") <= 64);
    // No piece starts or ends inside a surrogate pair.
    assert.equal(Buffer.from(piece, "utf8").toString("utf8"), piece);
  }
  assert.deepEqual(chunkInput(""), []);
  assert.deepEqual(chunkInput("short"), ["short"]);
  assert.throws(() => chunkInput("x", 3), RangeError);
});

// --- TERMINAL-02 ----------------------------------------------------------------------------

test("every message a subscriber receives parses to its kind, and anything else is refused", () => {
  const kinds = (fixtures.messages as { kind: string }[]).map((message) => {
    const parsed = parseTerminalMessage(message);
    assert.ok(parsed, JSON.stringify(message));
    return parsed.kind;
  });
  assert.deepEqual(kinds, ["output", "state", "state", "exit", "error", "detached"]);
  for (const message of fixtures.invalidMessages)
    assert.equal(parseTerminalMessage(message), null, JSON.stringify(message));
});

test("a detached subscriber's stream ends, after the output it was sent", () => {
  let stream = applyEvent(running(), output(1, 0)).stream;
  const detached = (lastSeq: number | null): TerminalEvent => ({
    kind: "detached",
    sessionId: id,
    generation: gen(1),
    error: { code: "OutputOverflow", message: "Fell behind." },
    lastSeq: lastSeq as Sequence | null,
  });
  const early = applyEvent(stream, detached(4));
  assert.equal(early.accepted === false && early.reason, "gap");
  const verdict = applyEvent(stream, detached(0));
  assert.ok(verdict.accepted);
  stream = verdict.stream;
  assert.equal(stream.state, "Failed");
  assert.equal(applyEvent(stream, output(1, 1)).accepted, false);
});

test("acknowledgements and subscriptions name their subscriber", () => {
  assert.equal(fixtures.ackRequest.subscriptionId, "sub-1");
  assert.ok(isSubscriptionId(fixtures.ackRequest.subscriptionId));
  assert.ok(isSequence(fixtures.ackRequest.seq));
  assert.ok(isSubscriptionId(fixtures.subscribeRequest.subscriptionId));
});
