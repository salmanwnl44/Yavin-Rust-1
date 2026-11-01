import assert from "node:assert/strict";
import test from "node:test";
import { CARGO, ESLINT, RUFF, TSC, parseProblems } from "./problemMatchers.ts";

/** Samples are real tool output, including the surrounding noise each one prints. */

test("tsc output becomes diagnostics with file, position, code and message", () => {
  const output = [
    "src/app.ts(12,7): error TS2345: Argument of type 'string' is not assignable to type 'number'.",
    "src/util/helpers.ts(3,1): warning TS6133: 'unused' is declared but its value is never read.",
    "",
    "Found 2 errors in 2 files.",
  ].join("\n");

  assert.deepEqual(parseProblems(TSC, output), [
    {
      file: "src/app.ts",
      line: 12,
      column: 7,
      severity: "error",
      code: "TS2345",
      message: "Argument of type 'string' is not assignable to type 'number'.",
    },
    {
      file: "src/util/helpers.ts",
      line: 3,
      column: 1,
      severity: "warning",
      code: "TS6133",
      message: "'unused' is declared but its value is never read.",
    },
  ]);
});

test("a tsc summary line is not mistaken for a diagnostic", () => {
  // "Found 2 errors" names no location, so inventing one from it would be worse than
  // missing a real diagnostic.
  assert.deepEqual(
    parseProblems(TSC, "Found 2 errors in 2 files.\n\nerror TS18003: No inputs."),
    [],
  );
});

test("a Windows path with a drive letter is not split on its colon", () => {
  const output = "C:/work/src/app.ts(1,1): error TS1005: ';' expected.";
  assert.deepEqual(parseProblems(TSC, output)[0].file, "C:/work/src/app.ts");
});

test("cargo short output becomes diagnostics, with and without an error code", () => {
  const output = [
    "    Checking yavin-ide v0.1.0 (C:\\Projects\\Yavin)",
    "src/main.rs:3:5: error[E0425]: cannot find value `x` in this scope",
    "src/lib.rs:10:1: warning: unused import: `std::fs`",
    "error: could not compile `yavin-ide` (lib) due to 1 previous error",
  ].join("\n");

  assert.deepEqual(parseProblems(CARGO, output), [
    {
      file: "src/main.rs",
      line: 3,
      column: 5,
      severity: "error",
      code: "E0425",
      message: "cannot find value `x` in this scope",
    },
    {
      file: "src/lib.rs",
      line: 10,
      column: 1,
      severity: "warning",
      message: "unused import: `std::fs`",
    },
  ]);
});

test("cargo's own progress and summary lines are ignored", () => {
  // "error: could not compile ..." has no file or position; it is a summary.
  const problems = parseProblems(
    CARGO,
    "    Checking foo v0.1.0\nerror: could not compile `foo` due to 1 previous error",
  );
  assert.deepEqual(problems, []);
});

test("eslint compact output keeps the rule name as the code, not part of the message", () => {
  const output = [
    "/p/src/a.ts: line 4, col 1, Error - 'x' is assigned a value but never used. (no-unused-vars)",
    "/p/src/b.ts: line 9, col 3, Warning - Missing semicolon. (semi)",
    "",
    "2 problems",
  ].join("\n");

  assert.deepEqual(parseProblems(ESLINT, output), [
    {
      file: "/p/src/a.ts",
      line: 4,
      column: 1,
      severity: "error",
      code: "no-unused-vars",
      message: "'x' is assigned a value but never used.",
    },
    {
      file: "/p/src/b.ts",
      line: 9,
      column: 3,
      severity: "warning",
      code: "semi",
      message: "Missing semicolon.",
    },
  ]);
});

test("an eslint message with no rule still parses, keeping the whole message", () => {
  const output = "/p/a.ts: line 1, col 1, Error - Parsing error: Unexpected token";
  assert.deepEqual(parseProblems(ESLINT, output), [
    {
      file: "/p/a.ts",
      line: 1,
      column: 1,
      severity: "error",
      message: "Parsing error: Unexpected token",
    },
  ]);
});

test("ruff output becomes diagnostics, with its fixability marker stripped", () => {
  const output = [
    "app/main.py:14:24: F401 [*] `os` imported but unused",
    "app/main.py:20:1: E402 module level import not at top of file",
    "Found 2 errors.",
  ].join("\n");

  assert.deepEqual(parseProblems(RUFF, output), [
    {
      file: "app/main.py",
      line: 14,
      column: 24,
      // Ruff prints no severity word; a lint finding is a warning, not a build failure.
      severity: "warning",
      code: "F401",
      message: "`os` imported but unused",
    },
    {
      file: "app/main.py",
      line: 20,
      column: 1,
      severity: "warning",
      code: "E402",
      message: "module level import not at top of file",
    },
  ]);
});

test("empty output produces nothing rather than a bogus entry", () => {
  for (const matcher of [TSC, CARGO, ESLINT, RUFF]) {
    assert.deepEqual(parseProblems(matcher, ""), []);
    assert.deepEqual(parseProblems(matcher, "\n\n  \n"), []);
  }
});

test("a line with a non-numeric position is skipped, not turned into line zero", () => {
  // Landing a diagnostic on line 0 would make click-to-navigate jump somewhere arbitrary.
  assert.deepEqual(parseProblems(CARGO, "src/a.rs:0:0: error: something"), []);
});

test("carriage returns from a Windows pipe do not end up in the message", () => {
  const output = "src/app.ts(1,1): error TS1005: ';' expected.\r\nFound 1 error.\r\n";
  assert.equal(parseProblems(TSC, output)[0].message, "';' expected.");
});

test("a message containing parentheses keeps them when there is no trailing rule", () => {
  const output = "/p/a.ts: line 1, col 1, Error - Unexpected token (see docs)";
  const [problem] = parseProblems(ESLINT, output);
  // Ambiguous by construction: the last parenthesised group is where eslint puts the rule.
  assert.equal(problem.code, "see docs");
  assert.equal(problem.message, "Unexpected token");
});

test("an indented diagnostic is still found, not silently dropped", () => {
  // Anchoring on a non-space character meant any tool that indents its findings produced
  // nothing at all, with no error to explain why.
  const problems = parseProblems(TSC, "    src/app.ts(1,1): error TS1005: ';' expected.");
  assert.equal(problems.length, 1);
  assert.equal(problems[0].file, "src/app.ts");
});

test("a path containing spaces and parentheses is still parsed", () => {
  const problems = parseProblems(TSC, "src/my (old) app.ts(4,2): error TS1005: ';' expected.");
  assert.equal(problems[0].file, "src/my (old) app.ts");
  assert.equal(problems[0].line, 4);
});

test("a cargo path with spaces parses, and a note after an error is not a diagnostic", () => {
  const output = [
    "src/my file.rs:7:3: error[E0308]: mismatched types",
    "note: expected `u32`, found `&str`",
  ].join("\n");
  const problems = parseProblems(CARGO, output);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].file, "src/my file.rs");
});
