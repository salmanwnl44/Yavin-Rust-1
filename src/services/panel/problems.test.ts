import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  allProblems,
  clearProblems,
  groupByFile,
  includeProblem,
  matchesFilter,
  PROBLEM_KINDS,
  problemCounts,
  publishProblems,
  resetProblems,
  subscribeProblems,
} from "./problems.ts";
import type { Diagnostic } from "./problemMatchers.ts";

beforeEach(() => resetProblems());

const at = (file: string, line: number, severity: Diagnostic["severity"], message = "x") => ({
  file,
  line,
  column: 1,
  severity,
  message,
});

test("a tool running again replaces its own results and leaves other tools alone", () => {
  // The whole reason diagnostics are keyed by owner.
  publishProblems("tsc", "TypeScript", [at("a.ts", 1, "error")]);
  publishProblems("eslint", "ESLint", [at("b.ts", 2, "warning")]);

  publishProblems("tsc", "TypeScript", [at("a.ts", 9, "error", "a new problem")]);

  const files = groupByFile(allProblems());
  assert.deepEqual(
    files.map((f) => f.file),
    ["a.ts", "b.ts"],
  );
  assert.equal(files[0].problems.length, 1, "the old TypeScript result is gone");
  assert.equal(files[0].problems[0].line, 9);
  assert.equal(files[1].problems[0].message, "x", "ESLint's result is untouched");
});

test("groupByFile preserves a diagnostic's related information for the panel (WS11)", () => {
  publishProblems("tsc", "TypeScript", [
    {
      ...at("a.ts", 3, "error", "cannot redeclare"),
      related: [{ file: "a.ts", line: 1, column: 5, message: "first declared here" }],
    },
  ]);
  const problem = groupByFile(allProblems())[0]!.problems[0]!;
  assert.deepEqual(problem.related, [
    { file: "a.ts", line: 1, column: 5, message: "first declared here" },
  ]);
  assert.equal(problem.source, "TypeScript", "source is carried alongside the related info");
});

test("a tool that finds nothing clears its previous results rather than leaving them stale", () => {
  publishProblems("tsc", "TypeScript", [at("a.ts", 1, "error")]);
  publishProblems("tsc", "TypeScript", []);
  assert.deepEqual(groupByFile(allProblems()), []);
});

test("clearing one owner leaves the others", () => {
  publishProblems("tsc", "TypeScript", [at("a.ts", 1, "error")]);
  publishProblems("eslint", "ESLint", [at("b.ts", 1, "warning")]);
  clearProblems("tsc");
  assert.deepEqual(
    groupByFile(allProblems()).map((f) => f.file),
    ["b.ts"],
  );
});

test("counts are per severity, across every tool", () => {
  publishProblems("tsc", "TypeScript", [at("a.ts", 1, "error"), at("a.ts", 2, "warning")]);
  publishProblems("eslint", "ESLint", [at("b.ts", 1, "error"), at("b.ts", 2, "info")]);
  assert.deepEqual(problemCounts(), { error: 2, warning: 1, info: 1 });
});

test("problems are grouped by file, files in path order and entries by position", () => {
  publishProblems("tsc", "TypeScript", [
    at("src/z.ts", 10, "error"),
    at("src/a.ts", 20, "error"),
    at("src/a.ts", 2, "warning"),
  ]);
  const files = groupByFile(allProblems());
  assert.deepEqual(
    files.map((f) => f.file),
    ["src/a.ts", "src/z.ts"],
  );
  assert.deepEqual(
    files[0].problems.map((p) => p.line),
    [2, 20],
  );
});

test("each entry carries the label of the tool that found it", () => {
  publishProblems("tsc", "TypeScript", [at("a.ts", 1, "error")]);
  assert.equal(groupByFile(allProblems())[0].problems[0].source, "TypeScript");
});

test("severity toggles narrow what is listed", () => {
  publishProblems("tsc", "TypeScript", [at("a.ts", 1, "error"), at("a.ts", 2, "warning")]);
  const errorsOnly = groupByFile(allProblems(), { severities: ["error"] });
  assert.equal(errorsOnly[0].problems.length, 1);
  assert.equal(errorsOnly[0].problems[0].severity, "error");
});

test("the active-file view shows only that file", () => {
  publishProblems("tsc", "TypeScript", [at("a.ts", 1, "error"), at("b.ts", 1, "error")]);
  const justA = groupByFile(allProblems(), { file: "a.ts" });
  assert.deepEqual(
    justA.map((f) => f.file),
    ["a.ts"],
  );
});

test("the filter matches a path or a message, as VS Code's does", () => {
  publishProblems("tsc", "TypeScript", [
    at("src/login.ts", 1, "error", "cannot find name"),
    at("src/other.ts", 1, "error", "unused variable"),
  ]);
  assert.deepEqual(
    groupByFile(allProblems(), { filter: "login" }).map((f) => f.file),
    ["src/login.ts"],
  );
  assert.deepEqual(
    groupByFile(allProblems(), { filter: "unused" }).map((f) => f.file),
    ["src/other.ts"],
  );
});

test("the filter understands globs and negation", () => {
  assert.equal(matchesFilter("src/app.ts", "*.ts"), true);
  assert.equal(matchesFilter("src/app.ts", "*.js"), false);
  assert.equal(matchesFilter("src/app.ts", "src/*"), true);
  // Negation is how node_modules gets excluded.
  assert.equal(matchesFilter("node_modules/x/a.ts", "!*node_modules*"), false);
  assert.equal(matchesFilter("src/a.ts", "!*node_modules*"), true);
  // A bare word is a substring match, not a glob.
  assert.equal(matchesFilter("src/App.tsx", "app"), true);
  assert.equal(matchesFilter("", ""), true);
});

test("a filter with regex characters is matched literally, not as a pattern", () => {
  // Otherwise typing `a+b` or `(x)` would throw or silently match the wrong thing.
  assert.equal(matchesFilter("src/a+b.ts", "a+b"), true);
  assert.equal(matchesFilter("src/aab.ts", "a+b"), false);
  assert.doesNotThrow(() => matchesFilter("src/a.ts", "*(unclosed"));
});

test("a negated filter excludes an entry whose path OR message matches it", () => {
  // The combining rule flips with negation: `login` means either field may match, but
  // `!node_modules` means neither may. Combining a negated filter with OR let anything
  // through whose message merely happened not to contain the excluded word.
  assert.equal(includeProblem("src/other.ts", "';' expected.", "!*other*"), false);
  assert.equal(includeProblem("src/app.ts", "other thing broke", "!*other*"), false);
  assert.equal(includeProblem("src/app.ts", "';' expected.", "!*other*"), true);
  // Without negation, either field matching is enough.
  assert.equal(includeProblem("src/other.ts", "';' expected.", "other"), true);
  assert.equal(includeProblem("src/app.ts", "other thing broke", "other"), true);
  assert.equal(includeProblem("src/app.ts", "';' expected.", "other"), false);
  assert.equal(includeProblem("any", "any", ""), true);
});

test("a negated filter drops the whole file from the grouping", () => {
  publishProblems("tsc", "TypeScript", [
    at("src/app.ts", 1, "error", "broken"),
    at("src/other.ts", 1, "error", "also broken"),
  ]);
  assert.deepEqual(
    groupByFile(allProblems(), { filter: "!*other*" }).map((f) => f.file),
    ["src/app.ts"],
  );
});

test("subscribers hear about every publish and clear", () => {
  let calls = 0;
  const stop = subscribeProblems(() => calls++);
  publishProblems("tsc", "TypeScript", []);
  clearProblems("tsc");
  assert.equal(calls, 2);
  stop();
  publishProblems("tsc", "TypeScript", []);
  assert.equal(calls, 2);
});

test("the snapshot is stable between changes and fresh after one", () => {
  publishProblems("tsc", "TypeScript", [at("a.ts", 1, "error")]);
  const before = allProblems();
  assert.equal(before, allProblems(), "stable so useSyncExternalStore does not loop");
  publishProblems("eslint", "ESLint", []);
  assert.notEqual(before, allProblems());
});

// --- IDE-01: one file, one identity ------------------------------------------------------------

test("a language server's and a checker's diagnostics for one file are one group", () => {
  // The server reports the canonical path; the checker's was resolved to it (another spelling).
  publishProblems("lsp:ts:file:///C:/p/src/app.ts", "TypeScript Server", [
    at("C:/p/src/app.ts", 3, "error", "from the server"),
  ]);
  publishProblems("tsc", "TypeScript", [at("c:\\p\\src\\app.ts", 3, "error", "from tsc")]);
  const files = groupByFile(allProblems());
  assert.equal(files.length, 1);
  // Owners are never merged: the same error from two producers is listed twice, by source.
  assert.deepEqual(files[0].problems.map((problem) => problem.source).sort(), [
    "TypeScript",
    "TypeScript Server",
  ]);
});

test("the current-file filter matches by identity, whatever the spelling", () => {
  publishProblems("tsc", "TypeScript", [
    at("C:/p/src/app.ts", 1, "error"),
    at("C:/p/src/other.ts", 1, "error"),
  ]);
  for (const active of ["C:/p/src/app.ts", "c:\\p\\src\\app.ts", "\\\\?\\C:\\p\\src\\app.ts"])
    assert.deepEqual(
      groupByFile(allProblems(), { file: active }).map((file) => file.file),
      ["C:/p/src/app.ts"],
      active,
    );
  // Switching to another tab shows that file's; a file with none shows nothing.
  assert.deepEqual(
    groupByFile(allProblems(), { file: "C:/p/src/other.ts" }).map((file) => file.file),
    ["C:/p/src/other.ts"],
  );
  assert.deepEqual(groupByFile(allProblems(), { file: "C:/p/src/none.ts" }), []);
});

test("hints are a kind of their own in the list, and still counted as info", () => {
  publishProblems("lsp", "Server", [
    { ...at("C:/p/a.ts", 1, "info", "a hint"), hint: true },
    at("C:/p/a.ts", 2, "info", "information"),
  ]);
  const messages = (severities: Parameters<typeof groupByFile>[1]) =>
    groupByFile(allProblems(), severities).flatMap((file) => file.problems.map((p) => p.message));
  assert.deepEqual(messages({}), ["a hint", "information"]);
  assert.deepEqual(messages({ severities: ["hint"] }), ["a hint"]);
  assert.deepEqual(messages({ severities: ["info"] }), ["information"]);
  assert.equal(problemCounts().info, 2);
});

test("clearing one producer leaves the other's diagnostics for the same file", () => {
  publishProblems("lsp:x", "Server", [at("C:/p/a.ts", 1, "error")]);
  publishProblems("tsc", "TypeScript", [at("C:/p/a.ts", 1, "error")]);
  clearProblems("tsc");
  const [file] = groupByFile(allProblems());
  assert.deepEqual(
    file.problems.map((problem) => problem.source),
    ["Server"],
  );
  // A workspace's disposal clears them all.
  clearProblems();
  assert.deepEqual(groupByFile(allProblems()), []);
});

// --- WS27: heavy diagnostics ------------------------------------------------------------------
//
// The Problems list is the one un-virtualized list in the app, so a big error count is the
// workload to watch. `groupByFile` is the whole data cost behind it, and the component memoises
// the result (recomputed only when the version, filter, severities or active file change) and
// the snapshot it reads is reference-stable between changes (the test above) -- so this is not a
// per-render cost. What this guards is that the grouping itself stays near-linear: an accidental
// O(n^2) (e.g. a linear scan per diagnostic, or sorting inside the loop) would turn a routine
// 50k-diagnostic project into seconds of blocking work. Deterministic fixtures; the assertions
// are operation counts (every diagnostic projected exactly once) plus a generous ceiling that
// only an algorithmic regression breaches -- never a brittle absolute-timing threshold, which
// would flake while sibling suites share the CPU.
test("groupByFile stays near-linear as diagnostics scale: every one is projected once", () => {
  const measurements: string[] = [];
  const severities = [...PROBLEM_KINDS];
  for (const n of [1_000, 10_000, 50_000]) {
    resetProblems();
    const fileCount = Math.max(1, Math.floor(n / 50));
    const diagnostics: Diagnostic[] = [];
    for (let i = 0; i < n; i++)
      diagnostics.push({
        // A deterministic spread across files, lines and columns, out of order so the per-file
        // position sort and the path sort both do real work.
        file: `C:/w/src/dir${i % fileCount}/file${i % fileCount}.ts`,
        line: (i * 7) % 2000,
        column: (i * 3) % 120,
        severity: i % 3 === 0 ? "error" : i % 3 === 1 ? "warning" : "info",
        message: `Problem number ${i}`,
      });
    publishProblems("tsc", "TypeScript", diagnostics);

    const owned = allProblems();
    const t0 = performance.now();
    const files = groupByFile(owned, { severities });
    const ms = performance.now() - t0;

    // Operation-count correctness: one group per file, and every diagnostic present exactly once.
    assert.equal(files.length, fileCount, `${n}: one group per file`);
    const rows = files.reduce((sum, file) => sum + file.problems.length, 0);
    assert.equal(rows, n, `${n}: every diagnostic is projected exactly once`);
    // Files are in path order, and within a file diagnostics are in position order.
    const paths = files.map((file) => file.file);
    assert.deepEqual(
      paths,
      [...paths].sort((a, b) => a.localeCompare(b)),
      `${n}: files sorted`,
    );
    for (const file of files)
      for (let i = 1; i < file.problems.length; i++) {
        const prev = file.problems[i - 1];
        const cur = file.problems[i];
        assert.ok(
          prev.line < cur.line || (prev.line === cur.line && prev.column <= cur.column),
          `${n}: ${file.file} diagnostics in position order`,
        );
      }

    measurements.push(`${n.toLocaleString()}: ${ms.toFixed(1)}ms, ${files.length} groups`);
    // Linear grouping of 50k diagnostics is tens of milliseconds; an O(n^2) regression is
    // seconds. The ceiling is wide enough to never flake under sibling CPU contention while
    // still catching that regression by a wide margin.
    assert.ok(
      ms < 2_000,
      `${n} diagnostics grouped in ${ms.toFixed(1)}ms (expected well under 2s)`,
    );
  }
  console.log(`   [perf] groupByFile → ${measurements.join(" | ")}`);
});
