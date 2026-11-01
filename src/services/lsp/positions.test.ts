import assert from "node:assert/strict";
import test from "node:test";
import {
  LineIndex,
  OverlappingEditsError,
  applyTextEdits,
  encodingOf,
  incrementalChange,
} from "./positions.ts";

test("positions and offsets agree in every encoding, around multi-unit characters", () => {
  // "é" is 1 UTF-16 unit / 2 UTF-8 bytes; "😀" is 2 UTF-16 units / 4 bytes / 1 code point.
  const text = "héllo 😀 x\nsecond";
  const index = new LineIndex(text);
  const x = text.indexOf("x");
  assert.deepEqual(index.positionAt(x, "utf-16"), { line: 0, character: 9 });
  assert.deepEqual(index.positionAt(x, "utf-8"), { line: 0, character: 12 });
  assert.deepEqual(index.positionAt(x, "utf-32"), { line: 0, character: 8 });
  for (const encoding of ["utf-16", "utf-8", "utf-32"] as const)
    for (let offset = 0; offset <= text.length; offset++) {
      // Inside a surrogate pair is not a position; both halves map to its start.
      if (offset === text.indexOf("😀") + 1) continue;
      assert.equal(
        index.offsetAt(index.positionAt(offset, encoding), encoding),
        offset,
        `${encoding} @${offset}`,
      );
    }
  // A position inside a character lands on its start, never half a pair.
  const emoji = text.indexOf("😀");
  assert.equal(index.offsetAt({ line: 0, character: 8 }, "utf-8"), emoji);
  assert.equal(index.offsetAt({ line: 0, character: 9 }, "utf-8"), emoji);
  assert.equal(encodingOf("utf-8"), "utf-8");
  assert.equal(encodingOf("utf-32"), "utf-32");
  assert.equal(encodingOf("utf-7"), "utf-16");
  assert.equal(encodingOf(undefined), "utf-16");
});

test("line breaks of every kind, and out-of-range positions clamp as the protocol says", () => {
  const index = new LineIndex("a\r\nbb\rccc\nd");
  assert.equal(index.lineCount, 4);
  assert.equal(index.lineText(0), "a");
  assert.equal(index.lineText(1), "bb");
  assert.equal(index.lineText(2), "ccc");
  assert.deepEqual(index.positionAt(3), { line: 1, character: 0 });
  // A character past the end of a line is its end, not the next line.
  assert.equal(index.offsetAt({ line: 0, character: 50 }), 1);
  assert.equal(index.offsetAt({ line: 99, character: 0 }), "a\r\nbb\rccc\nd".length);
  assert.equal(index.offsetAt({ line: -1, character: 3 }), 0);
  // The \r\n of line 0 is never inside a position.
  assert.deepEqual(index.positionAt(2), { line: 0, character: 1 });
});

test("an edit becomes the one incremental change that reproduces it", () => {
  const cases: [string, string][] = [
    ["hello world", "hello brave world"],
    ["line one\nline two\nline three", "line one\nline 2\nline three"],
    ["a\nb\nc", "a\nc"],
    ["x", ""],
    ["", "new text\nover lines"],
    ["héllo 😀", "héllo 😀😀 !"],
    ["same", "same"],
  ];
  for (const encoding of ["utf-16", "utf-8", "utf-32"] as const)
    for (const [before, after] of cases) {
      const change = incrementalChange(before, after, encoding);
      if (before === after) {
        assert.equal(change, null);
        continue;
      }
      assert.ok(change);
      // Applying it the way a server does gives exactly the new text.
      assert.equal(
        applyTextEdits(before, [{ range: change.range, newText: change.text }], encoding),
        after,
        `${encoding}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
      );
    }
});

test("text edits apply from their original positions, in order, and overlaps are refused", () => {
  const text = "const a = 1;\nconst b = 2;\n";
  const at = (line: number, character: number) => ({ line, character });
  const edits = [
    { range: { start: at(1, 6), end: at(1, 7) }, newText: "beta" },
    { range: { start: at(0, 6), end: at(0, 7) }, newText: "alpha" },
    { range: { start: at(2, 0), end: at(2, 0) }, newText: "// end\n" },
  ];
  assert.equal(applyTextEdits(text, edits), "const alpha = 1;\nconst beta = 2;\n// end\n");
  // Two insertions at one place keep the order they were given in.
  assert.equal(
    applyTextEdits("ab", [
      { range: { start: at(0, 1), end: at(0, 1) }, newText: "1" },
      { range: { start: at(0, 1), end: at(0, 1) }, newText: "2" },
    ]),
    "a12b",
  );
  assert.throws(
    () =>
      applyTextEdits(text, [
        { range: { start: at(0, 0), end: at(0, 5) }, newText: "x" },
        { range: { start: at(0, 3), end: at(0, 8) }, newText: "y" },
      ]),
    OverlappingEditsError,
  );
});

test("rapid edits: a thousand keystrokes stay in step, and converting is fast", () => {
  let server = "";
  let client = "";
  const started = performance.now();
  for (let i = 0; i < 1000; i++) {
    const next = i % 10 === 9 ? client.slice(0, -3) : `${client}${i % 3 ? "a" : "\n"}é`;
    const change = incrementalChange(client, next, "utf-8");
    if (change)
      server = applyTextEdits(server, [{ range: change.range, newText: change.text }], "utf-8");
    client = next;
  }
  assert.equal(server, client);
  assert.ok(performance.now() - started < 2000);
});
