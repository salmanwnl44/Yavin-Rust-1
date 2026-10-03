import assert from "node:assert/strict";
import test from "node:test";
import {
  problemResourceId,
  resolveCheckerDiagnostics,
  resolveCheckerPath,
} from "./problemLocations.ts";
import type { Diagnostic } from "./problemMatchers.ts";

const ROOT = "C:\\project";
const SAME = "C:/project/src/app.ts";

test("every spelling of a checker's path is the one canonical workspace path", () => {
  for (const printed of [
    "src/app.ts", // relative to where the checker ran (tsc, cargo, ruff)
    "src\\app.ts",
    "./src/app.ts",
    "C:\\project\\src\\app.ts", // absolute (eslint)
    "c:/project/src/app.ts",
    "file:///C:/project/src/app.ts",
    "file:///c:/project/src/app.ts",
    "\\\\?\\C:\\project\\src\\app.ts", // extended-length
  ])
    assert.equal(
      problemResourceId(resolveCheckerPath(printed, ROOT)!),
      problemResourceId(SAME),
      printed,
    );
  // The text kept is canonical: `/` separators, upper-case drive, no prefix.
  assert.equal(resolveCheckerPath("src\\app.ts", "\\\\?\\c:\\project"), SAME);
});

test("paths with spaces, nested workspace folders and POSIX roots resolve", () => {
  assert.equal(resolveCheckerPath("src/bad file.ts", ROOT), "C:/project/src/bad file.ts");
  assert.equal(
    resolveCheckerPath("src/a.ts", "C:\\project\\packages\\web"),
    "C:/project/packages/web/src/a.ts",
  );
  assert.equal(resolveCheckerPath("src/main.rs", "/home/me/crate"), "/home/me/crate/src/main.rs");
  // Whether the file exists is for opening it to find out: no I/O here.
  assert.equal(resolveCheckerPath("src/gone.ts", ROOT), "C:/project/src/gone.ts");
});

test("a path outside the folder the checker ran in is not a workspace file", () => {
  for (const printed of [
    "../elsewhere/a.ts",
    "src/../../a.ts",
    "D:\\other\\a.ts",
    "file:///D:/other/a.ts",
    "C:\\projectile\\a.ts", // a sibling sharing a prefix is not inside
    "",
    "   ",
  ])
    assert.equal(resolveCheckerPath(printed, ROOT), null, JSON.stringify(printed));
});

test("only absolute paths and file URIs have an identity; text never guesses one", () => {
  assert.equal(problemResourceId("src/app.ts"), null);
  assert.equal(problemResourceId("untitled:Untitled-1"), null);
  assert.equal(problemResourceId("C:\\project\\src\\app.ts"), problemResourceId(SAME));
  assert.equal(problemResourceId("C:/PROJECT/SRC/APP.TS"), problemResourceId(SAME)); // Windows
  assert.notEqual(problemResourceId("/home/a.ts"), problemResourceId("/home/A.ts")); // POSIX
});

test("a checker's diagnostics are resolved, related places too; outside ones are counted", () => {
  const found: Diagnostic[] = [
    {
      file: "src/app.ts",
      line: 3,
      column: 7,
      severity: "error",
      message: "bad",
      related: [
        { file: "src/types.ts", line: 1, column: 1, message: "declared here" },
        { file: "../outside.ts", line: 1, column: 1, message: "dropped" },
      ],
    },
    { file: "../../escape.ts", line: 1, column: 1, severity: "error", message: "outside" },
  ];
  const { diagnostics, outside } = resolveCheckerDiagnostics(found, ROOT);
  assert.equal(outside, 1);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].file, SAME);
  assert.equal(diagnostics[0].line, 3);
  assert.equal(diagnostics[0].column, 7);
  assert.deepEqual(
    diagnostics[0].related!.map((r) => r.file),
    ["C:/project/src/types.ts"],
  );
  // The matcher's own objects are not changed.
  assert.equal(found[0].file, "src/app.ts");
});
