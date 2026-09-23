import assert from "node:assert/strict";
import test from "node:test";
import {
  asTrustState,
  folderName,
  RESTRICTED_SUMMARY,
  STILL_WORKS_SUMMARY,
  UNKNOWN_TRUST,
} from "./trust.ts";

const BACKSLASH = String.fromCharCode(92);

test("a folder is named by its last segment, whichever separator it uses", () => {
  assert.equal(folderName(`C:${BACKSLASH}Projects${BACKSLASH}Yavin`), "Yavin");
  assert.equal(folderName("/home/me/work/project"), "project");
  assert.equal(folderName("/home/me/work/project/"), "project");
  assert.equal(folderName("project"), "project");
});

test("a path that is only separators falls back to the path itself rather than empty", () => {
  assert.equal(folderName("/"), "/");
  assert.equal(folderName(null), "");
  assert.equal(folderName(""), "");
});

test("the state assumed before an answer arrives is restricted and silent", () => {
  // Assuming trusted would run the project's tooling in the window before the real answer
  // lands; assuming undecided would flash the prompt at every launch.
  assert.equal(UNKNOWN_TRUST.trusted, false);
  assert.equal(UNKNOWN_TRUST.decided, true);
});

test("an answer that is not a trust state is refused rather than stored", () => {
  // A backend that does not know the command answers with nothing. Storing that produced a
  // null state to render from, which took the whole window down when the folder changed.
  assert.throws(() => asTrustState(null));
  assert.throws(() => asTrustState(undefined));
  assert.throws(() => asTrustState({ root: "/work" }));
  assert.throws(() => asTrustState({ trusted: "yes", decided: true }));
});

test("a trust state with the paths left out still reads as a trust state", () => {
  // `root` and `parent` are genuinely absent for a window with no folder open.
  assert.deepEqual(asTrustState({ trusted: true, decided: true }), {
    trusted: true,
    decided: true,
    root: null,
    parent: null,
  });
});

test("the summaries say what is blocked and what is not, and do not overlap", () => {
  // A list that overstates what Restricted Mode blocks teaches people to click Trust
  // without reading, which costs more than it buys.
  assert.ok(RESTRICTED_SUMMARY.length > 0 && STILL_WORKS_SUMMARY.length > 0);
  const blocked = RESTRICTED_SUMMARY.join(" ").toLowerCase();
  assert.ok(!blocked.includes("terminal"), "the terminal keeps working");
  assert.ok(!blocked.includes("source control"), "Git keeps working");
  assert.ok(!blocked.includes("edit"), "editing keeps working");
});
