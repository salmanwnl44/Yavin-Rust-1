import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  allProblems,
  clearProblems,
  groupByFile,
  includeProblem,
  matchesFilter,
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
