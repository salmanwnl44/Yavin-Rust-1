/**
 * WS22: `TaskOutputMatcher` read in isolation — the streaming seam between a task's raw PTY
 * bytes and the problem matchers. The service-level path (output → matchers → Problems) is
 * covered in `tasks.test.ts`; here the byte-level invariants that are hard to force through the
 * whole service: ANSI/SGR stripping, escape sequences and logical lines split across arbitrary
 * chunk boundaries, several matchers fanned out over one stream, multi-line formats assembled
 * from streamed chunks, and the final unterminated line read only on `finish()`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { TaskOutputMatcher } from "./matching.ts";

const enc = new TextEncoder();
/** Feed one string as a single chunk. */
const push = (m: TaskOutputMatcher, text: string) => m.push(enc.encode(text));

test("no matchers: nothing is read, and finish yields nothing", () => {
  const m = new TaskOutputMatcher([]);
  assert.equal(m.active, false);
  push(m, "src/app.ts:1:1 - error TS2322: Bad.\r\n");
  assert.deepEqual(m.finish(), []);
});

test("SGR colours are stripped and a diagnostic split across chunks (mid-escape) still matches", () => {
  const m = new TaskOutputMatcher(["tsc"]);
  // tsc's default terminal format, coloured, with the bytes split inside an escape and inside
  // the path/location so the streaming decoder and TerminalText must stitch it back together.
  const parts = [
    "\u001b[0msrc/a", // mid-token
    "pp.ts\u001b[", // mid-escape
    "0m:12:7 - \u001b[31merr", // mid-word
    "or\u001b[0m TS2345: Bad thing.\r\n",
  ];
  for (const part of parts) push(m, part);
  const found = m.finish();
  assert.equal(found.length, 1);
  assert.deepEqual(
    [found[0].file, found[0].line, found[0].column, found[0].severity, found[0].code],
    ["src/app.ts", 12, 7, "error", "TS2345"],
  );
  assert.equal(found[0].message, "Bad thing.");
});

test("a line with no trailing newline is read only when the output ends (finish)", () => {
  const m = new TaskOutputMatcher(["tsc"]);
  // The process printed its last diagnostic and exited without a final line break; the
  // unterminated line is read only when the output ends.
  push(m, "src/b.ts(3,4): error TS1005: ';' expected.");
  const found = m.finish();
  assert.equal(found.length, 1);
  assert.deepEqual(
    [found[0].file, found[0].line, found[0].column, found[0].code],
    ["src/b.ts", 3, 4, "TS1005"],
  );
});

test("a byte sequence gives the same diagnostics however it is split", () => {
  const whole =
    "\u001b[2Ksrc/app.ts(1,1): error TS2304: Cannot find name 'x'.\r\n" +
    "src/app.ts(2,2): warning TS6133: 'y' is declared but never used.\r\n";
  const run = (chunks: string[]): string => {
    const m = new TaskOutputMatcher(["tsc"]);
    for (const c of chunks) push(m, c);
    return JSON.stringify(m.finish());
  };
  const bytes = enc.encode(whole);
  const once = run([whole]);
  // Split every single byte into its own chunk.
  const perByte = run([...bytes].map((b) => String.fromCharCode(b)));
  // Split down the middle.
  const half = Math.floor(whole.length / 2);
  const twoChunks = run([whole.slice(0, half), whole.slice(half)]);
  assert.equal(perByte, once);
  assert.equal(twoChunks, once);
  const found = JSON.parse(once) as { line: number; severity: string }[];
  assert.deepEqual(
    found.map((d) => [d.line, d.severity]),
    [
      [1, "error"],
      [2, "warning"],
    ],
  );
});

test("several matchers each read their own tool's lines from one mixed stream", () => {
  const m = new TaskOutputMatcher(["tsc", "cargo"]);
  // A build that compiled Rust and type-checked TS into the same terminal.
  push(m, "src/main.rs:3:5: error[E0425]: cannot find value `x` in this scope\r\n");
  push(m, "src/app.ts:7:1 - error TS2304: Cannot find name 'y'.\r\n");
  push(m, "    Compiling demo v0.1.0\r\n"); // progress: matched by neither
  const found = m.finish();
  assert.deepEqual(found.map((d) => [d.file, d.code]).sort(), [
    ["src/app.ts", "TS2304"],
    ["src/main.rs", "E0425"],
  ]);
});

test("a multi-line (cargo default) format is assembled from streamed chunks", () => {
  const m = new TaskOutputMatcher(["cargo"]);
  // cargo's default: the message on one line, the location on the next — split across chunks,
  // and interrupted by a redraw (CR) that TerminalText collapses.
  push(m, "error[E0412]: cannot find type `Fo");
  push(m, "o` in this scope\r\n --> src\\mai");
  push(m, "n.rs:10:14\r\n");
  const found = m.finish();
  assert.equal(found.length, 1);
  assert.deepEqual(
    [found[0].file, found[0].line, found[0].column, found[0].code, found[0].severity],
    ["src\\main.rs", 10, 14, "E0412", "error"],
  );
  assert.match(found[0].message, /cannot find type `Foo`/);
});

test("an unknown matcher id is ignored, not an error", () => {
  const m = new TaskOutputMatcher(["tsc", "nonesuch"]);
  assert.equal(m.active, true);
  push(m, "src/a.ts(1,1): error TS1000: x.\r\n");
  assert.equal(m.finish().length, 1);
});
