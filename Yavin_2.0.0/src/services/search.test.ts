import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_RESULT,
  MAX_HITS,
  describeSearchResult,
  hitOffset,
  parseFileList,
  parseSearch,
  replaceHits,
  searchWorkspace,
  type SearchResult,
} from "./search.ts";
import { fakeRipgrep } from "./search.fake.ts";
import type { SearchOptions } from "./native.ts";

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

// --- IDE-02: the whole TypeScript side, against the native boundary --------------------------

/**
 * The native side as the window reaches it (`window.__TAURI_INTERNALS__.invoke`), answering
 * searches from files held in memory (`fakeRipgrep`). Only the IPC boundary is stood in for:
 * `searchWorkspace` runs as it does in the app.
 */
function nativeSearch(
  disk: Record<string, string>,
  options: {
    hold?: Promise<void>;
    answer?: (request: Record<string, unknown>) => unknown;
  } = {},
) {
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  Object.assign(globalThis, {
    isTauri: true,
    window: globalThis,
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: Record<string, unknown>) => {
        calls.push({ command, args });
        if (command === "cancel_search") return null;
        if (options.hold) await options.hold;
        const request = args.options as Record<string, unknown>;
        const answer = options.answer?.(request);
        if (answer !== undefined) return answer;
        return fakeRipgrep(disk, request as unknown as Parameters<typeof fakeRipgrep>[1]);
      },
    },
  });
  return {
    calls,
    searches: () => calls.filter((call) => call.command === "search_project"),
    buffers: () =>
      calls.filter(
        (call) =>
          call.command === "search_project" &&
          (call.args.options as { buffer: string | null }).buffer !== null,
      ),
  };
}

const DISK = {
  "C:/work/src/a.ts": "const needle = 1;\nneedle();\n",
  "C:/work/src/b.ts": "no match here\n",
  "C:/work/lib/c.rs": "fn needle() {}\r\n",
};

const request = (query: string, extra: Partial<SearchOptions> = {}): SearchOptions => ({
  query,
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  hidden: false,
  ignored: false,
  include: [],
  exclude: [],
  folder: "C:/work",
  buffer: null,
  filesOnly: false,
  ...extra,
});

const live = () => new AbortController().signal;
const where = (result: SearchResult) =>
  result.hits.map((hit) => `${hit.path}:${hit.line}:${hit.start}`);

test("workspace, folder and glob scopes, regex, case and whole word reach the native search", async () => {
  nativeSearch(DISK);
  const all = await searchWorkspace("C:/work", request("needle"), {}, false, live());
  assert.deepEqual(where(all), [
    "C:/work/lib/c.rs:1:3",
    "C:/work/src/a.ts:1:6",
    "C:/work/src/a.ts:2:0",
  ]);
  const folder = await searchWorkspace(
    "C:/work",
    request("needle", { folder: "C:/work/src" }),
    {},
    false,
    live(),
  );
  assert.deepEqual(where(folder), ["C:/work/src/a.ts:1:6", "C:/work/src/a.ts:2:0"]);
  const included = await searchWorkspace(
    "C:/work",
    request("needle", { include: ["*.rs"] }),
    {},
    false,
    live(),
  );
  assert.deepEqual(where(included), ["C:/work/lib/c.rs:1:3"]);
  const excluded = await searchWorkspace(
    "C:/work",
    request("needle", { exclude: ["lib/**"] }),
    {},
    false,
    live(),
  );
  assert.equal(excluded.hits.length, 2);
  const regex = await searchWorkspace(
    "C:/work",
    request("need.e\\(", { regex: true }),
    {},
    false,
    live(),
  );
  assert.deepEqual(where(regex), ["C:/work/lib/c.rs:1:3", "C:/work/src/a.ts:2:0"]);
  const cased = await searchWorkspace(
    "C:/work",
    request("NEEDLE", { caseSensitive: true }),
    {},
    false,
    live(),
  );
  assert.equal(cased.hits.length, 0);
  const word = await searchWorkspace(
    "C:/work",
    request("need", { wholeWord: true }),
    {},
    false,
    live(),
  );
  assert.equal(word.hits.length, 0);
  assert.equal(describeSearchResult(all), "3 matches in 2 files");
});

test("unsaved edits are searched as the editor holds them; saved documents are not searched twice", async () => {
  const native = nativeSearch(DISK);
  // The editor holds a.ts under another spelling of its path, with an unsaved edit.
  const buffers = {
    "c:\\work\\src\\a.ts": "const other = 1;\nstill a needle\n",
    "C:/work/src/b.ts": "no match here\n",
  };
  const modified = (path: string) => path === "c:\\work\\src\\a.ts";
  const result = await searchWorkspace(
    "C:/work",
    request("needle"),
    buffers,
    false,
    live(),
    modified,
  );
  // a.ts's disk results are replaced by its buffer's -- whatever the spelling -- and listed
  // under the document's own path; c.rs (not open) keeps its disk result.
  assert.deepEqual(where(result), ["C:/work/lib/c.rs:1:3", "c:\\work\\src\\a.ts:2:8"]);
  // One disk search, one listing, one buffer: the saved b.ts is not searched again.
  assert.equal(native.buffers().length, 1);
  assert.equal(native.searches().length, 3);
});

test("an unsaved edit that removes every match removes the file's disk results", async () => {
  nativeSearch(DISK);
  const result = await searchWorkspace(
    "C:/work",
    request("needle"),
    { "C:/work/src/a.ts": "nothing left\n" },
    false,
    live(),
  );
  assert.deepEqual(where(result), ["C:/work/lib/c.rs:1:3"]);
});

test("'Open files only' searches every open document, and an out-of-scope one not at all", async () => {
  const native = nativeSearch(DISK);
  const buffers = {
    "C:/work/src/a.ts": "needle\n",
    "C:/work/lib/c.rs": "needle\n",
  };
  const result = await searchWorkspace(
    "C:/work",
    request("needle", { include: ["*.ts"] }),
    buffers,
    true,
    live(),
    () => false, // both saved: still searched, they are what "open files" means
  );
  assert.deepEqual(where(result), ["C:/work/src/a.ts:1:0"]);
  // No disk search; the listing kept c.rs (excluded by the glob) out.
  assert.equal(native.buffers().length, 1);
});

test("a listing that cannot complete fails the search rather than guessing", async () => {
  nativeSearch(DISK, {
    answer: (options) =>
      options.filesOnly
        ? { stdout: "", stderr: "rg: too many files", code: 2, truncated: false }
        : undefined,
  });
  await assert.rejects(
    searchWorkspace("C:/work", request("needle"), { "C:/work/src/a.ts": "x\n" }, false, live()),
    /too many files/,
  );
});

test("the status line says exactly why results are missing", async () => {
  const many: Record<string, string> = {};
  for (let i = 0; i < 101; i++) many[`C:/work/f${i}.txt`] = "x ".repeat(100) + "\n";
  nativeSearch(many);
  const capped = await searchWorkspace("C:/work", request("x"), {}, false, live());
  assert.equal(capped.hits.length, MAX_HITS);
  assert.equal(capped.limit, "hits");
  assert.match(describeSearchResult(capped), /^10000 matches in 100 files \(first 10,000 shown\)$/);

  const summary = JSON.stringify({ type: "summary", data: {} });
  const one = JSON.stringify({
    type: "match",
    data: {
      path: { text: "a.ts" },
      lines: { text: "x\n" },
      line_number: 1,
      submatches: [{ start: 0, end: 1 }],
    },
  });
  const output = parseSearch(
    { stdout: `${one}\n{"type":"ma`, stderr: "", code: 0, truncated: true },
    "C:/w",
  );
  assert.match(describeSearchResult(output), /\(output limit reached; results incomplete\)$/);
  const unreadable = parseSearch(
    { stdout: `${one}\n${summary}\n`, stderr: "locked", code: 2, truncated: false },
    "C:/w",
  );
  assert.match(describeSearchResult(unreadable), /\(some files could not be searched\)$/);
  const complete = parseSearch(
    { stdout: `${one}\n${summary}\n`, stderr: "", code: 0, truncated: false },
    "C:/w",
  );
  assert.equal(describeSearchResult(complete), "1 matches in 1 files");
  assert.equal(describeSearchResult({ ...EMPTY_RESULT }), "No matches found");
  assert.equal(
    describeSearchResult({ ...EMPTY_RESULT, unreadable: true, truncated: true }),
    "No matches found in the files that could be searched",
  );
});

test("cancelling before it starts asks nothing; while it runs, cancels it natively and drops its answer", async () => {
  const before = new AbortController();
  before.abort();
  const idle = nativeSearch(DISK);
  await assert.rejects(
    searchWorkspace("C:/work", request("needle"), {}, false, before.signal),
    /Cancelled/,
  );
  assert.equal(idle.calls.length, 0);

  let release!: () => void;
  const native = nativeSearch(DISK, { hold: new Promise<void>((resolve) => (release = resolve)) });
  const running = new AbortController();
  const search = searchWorkspace("C:/work", request("needle"), {}, false, running.signal);
  await new Promise((resolve) => setTimeout(resolve, 0));
  running.abort(); // a newer query, or the workspace closing (its signal is combined in)
  const [started] = native.searches();
  const cancelled = native.calls.find((call) => call.command === "cancel_search");
  assert.equal(cancelled?.args.id, started.args.id, "the running search is the one cancelled");
  release();
  await assert.rejects(search, /Cancelled/); // its late answer is not a result
});

test("a search refused for a workspace that changed reports it, and returns nothing", async () => {
  Object.assign(globalThis, {
    isTauri: true,
    window: globalThis,
    __TAURI_INTERNALS__: {
      invoke: async () => {
        throw "Workspace changed; search again";
      },
    },
  });
  await assert.rejects(
    searchWorkspace("C:/old", request("needle"), {}, false, live()),
    /Workspace changed/,
  );
});

test("replacing: LF, CRLF on disk, CRLF results in an LF editor, mixed endings", () => {
  const hit = (line: number, text: string, start: number, end: number) => ({
    path: "C:/w/a.ts",
    line,
    text,
    start,
    end,
  });
  // LF file, closed: read from disk.
  assert.equal(
    replaceHits("a foo\nfoo b\n", [hit(1, "a foo\n", 2, 5), hit(2, "foo b\n", 0, 3)], "bar"),
    "a bar\nbar b\n",
  );
  // CRLF file, closed: its own text keeps its CRLF.
  assert.equal(replaceHits("a foo\r\nb\r\n", [hit(1, "a foo\r\n", 2, 5)], "bar"), "a bar\r\nb\r\n");
  // CRLF file, open: found on disk (CRLF), replaced in the editor's LF text -- not "stale".
  assert.equal(replaceHits("a foo\nb\n", [hit(1, "a foo\r\n", 2, 5)], "bar"), "a bar\nb\n");
  // Mixed endings: each line compared as it reads.
  assert.equal(
    replaceHits("x foo\r\ny foo\nz", [hit(1, "x foo\r\n", 2, 5), hit(2, "y foo\n", 2, 5)], "bar"),
    "x bar\r\ny bar\nz",
  );
  // The last line, with no ending.
  assert.equal(replaceHits("a\nfoo", [hit(2, "foo", 0, 3)], "bar"), "a\nbar");
});

test("replacing never touches a line that changed since it was found", () => {
  const found = { path: "C:/w/a.ts", line: 1, text: "a foo\r\n", start: 2, end: 5 };
  for (const content of ["a fool\n", "a foo extra\r\n", "", "b\na foo\n"])
    assert.throws(() => replaceHits(content, [found], "bar"), /stale/, JSON.stringify(content));
  // Only the ending differs: the same line.
  assert.equal(replaceHits("a foo", [found], "bar"), "a bar");
  // Overlapping matches are refused rather than half-applied.
  assert.throws(
    () =>
      replaceHits(
        "aaaa\n",
        [
          { ...found, text: "aaaa\n", start: 0, end: 3 },
          { ...found, text: "aaaa\n", start: 1, end: 4 },
        ],
        "b",
      ),
    /Overlapping/,
  );
});
