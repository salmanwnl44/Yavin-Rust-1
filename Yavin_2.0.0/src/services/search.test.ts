import assert from "node:assert/strict";
import test from "node:test";
import { hitOffset, parseFileList, parseSearch } from "./search.ts";

const match = JSON.stringify({
  type: "match",
  data: {
    path: { text: "./a.ts" },
    lines: { text: "a needle\n" },
    line_number: 1,
    submatches: [{ start: 2, end: 8 }],
  },
});
const summary = JSON.stringify({ type: "summary", data: {} });

test("search keeps partial results when some paths cannot be read", () => {
  const result = parseSearch(
    {
      stdout: `${match}\n${summary}\n`,
      stderr: "rg: locked.db: Access denied",
      code: 2,
      truncated: false,
    },
    "/work",
  );
  assert.deepEqual(result.hits, [
    { path: "/work/a.ts", line: 1, text: "a needle\n", start: 2, end: 8 },
  ]);
  assert.equal(result.truncated, true);
  assert.match(result.warning, /Access denied/);
});

test("file lists map ripgrep paths and drop a cut-off final name", () => {
  assert.deepEqual(
    parseFileList(
      { stdout: ".\\src\\b.ts\0./a.ts\0", stderr: "", code: 0, truncated: false },
      "/work/",
    ),
    { files: ["/work/a.ts", "/work/src/b.ts"], truncated: false },
  );
  assert.deepEqual(
    parseFileList({ stdout: "a.ts\0parti", stderr: "", code: 0, truncated: true }, "/work").files,
    ["/work/a.ts"],
  );
});

test("search reports fatal errors such as an invalid regex", () => {
  assert.throws(
    () =>
      parseSearch(
        { stdout: "", stderr: "rg: regex parse error", code: 2, truncated: false },
        "/work",
      ),
    /regex parse error/,
  );
});

test("a hit is found in its document whatever the file's line endings", () => {
  const content = "one\ntwo words\nthree";
  const hit = { path: "/w/a.txt", line: 2, start: 4, end: 9 };
  // Found on disk: ripgrep reports the line with its own ending, CRLF or LF.
  assert.equal(hitOffset(content, { ...hit, text: "two words\r\n" }), 8);
  assert.equal(hitOffset(content, { ...hit, text: "two words\n" }), 8);
  // Found in an open document's text, the last line has no ending.
  assert.equal(hitOffset(content, { ...hit, line: 3, start: 0, end: 5, text: "three" }), 14);
  // The line has changed since: no position.
  assert.equal(hitOffset(content, { ...hit, text: "two other words\r\n" }), null);
  assert.equal(hitOffset(content, { ...hit, line: 9, text: "two words\n" }), null);
});
