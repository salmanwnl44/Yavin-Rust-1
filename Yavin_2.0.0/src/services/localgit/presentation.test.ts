import assert from "node:assert/strict";
import test from "node:test";
import { parseUnifiedDiff } from "../git/diffHunks.ts";
import {
  aiStatusLabel,
  describeAiRefusal,
  describeError,
  describeRestoreConflict,
  entryKind,
  provenance,
  unavailableReason,
  unifiedDiff,
} from "./presentation.ts";
import { LocalGitClosedError, LocalGitError } from "./service.ts";
import type { LocalGitAiRefusal, LocalGitDiffEntry, LocalGitRestoreConflict } from "./types.ts";

test("an entry's kind comes from its recorded source and parents, nothing else", () => {
  assert.equal(entryKind({ source: "human", parents: ["a"] }), "commit");
  assert.equal(entryKind({ source: "human", parents: ["a", "b"] }), "merge");
  assert.equal(entryKind({ source: "ai", parents: ["a"] }), "ai");
  assert.equal(entryKind({ source: "checkpoint", parents: [] }), "checkpoint");
  assert.equal(entryKind({ source: "recovery", parents: ["a"] }), "recovery");
  assert.equal(entryKind({ source: "automatic", parents: [] }), "automatic");
});

test("provenance reads only the metadata keys that are there -- ids stay opaque", () => {
  const facts = provenance({
    meta: {
      "ai.run": "run:42/x",
      "ai.task": "T-1",
      "ai.changeset": "cs",
      "cherry-pick": "c".repeat(64),
    },
  });
  assert.equal(facts.agentRunId, "run:42/x");
  assert.equal(facts.taskId, "T-1");
  assert.equal(facts.changeSetId, "cs");
  assert.equal(facts.cherryPickedFrom, "c".repeat(64));
  assert.equal(facts.model, null, "never inferred");
  assert.equal(facts.validation, null);
});

const entry = (over: Partial<LocalGitDiffEntry>): LocalGitDiffEntry => ({
  folderId: "f-1",
  path: "src/a.ts",
  oldPath: null,
  kind: "modified",
  old: null,
  new: null,
  contentAvailable: true,
  unavailable: null,
  binary: false,
  lineDiff: null,
  lineDiffSkipped: null,
  ...over,
});

test("Local Git's own hunks become the unified text the diff view reads, unchanged", () => {
  const side = {
    class: "file" as const,
    id: "x",
    executable: false,
    stored: true,
    size: null,
    link: null,
  };
  const text = unifiedDiff(
    entry({
      old: side,
      new: side,
      lineDiff: {
        additions: 1,
        deletions: 1,
        hunks: [
          {
            oldStart: 2,
            oldLines: 2,
            newStart: 2,
            newLines: 2,
            lines: [
              { kind: "context", text: "keep", oldLine: 2, newLine: 2, noNewline: false },
              { kind: "deletion", text: "old", oldLine: 3, newLine: null, noNewline: true },
              { kind: "addition", text: "new", oldLine: null, newLine: 3, noNewline: false },
            ],
          },
        ],
      },
    }),
  );
  const parsed = parseUnifiedDiff(text);
  assert.equal(parsed.hunks.length, 1);
  assert.equal(parsed.hunks[0].header, "@@ -2,2 +2,2 @@");
  assert.deepEqual(parsed.hunks[0].lines, [
    " keep",
    "-old",
    "\\ No newline at end of file",
    "+new",
  ]);
  assert.ok(parsed.headerLines.includes("--- a/src/a.ts"));
  // An added file has no old side.
  assert.ok(unifiedDiff(entry({ kind: "added", new: side })).includes("--- /dev/null"));
});

test("unavailable content says why, never pretends to be empty", () => {
  assert.match(unavailableReason(entry({ unavailable: "notStored" }))!, /storage limit/);
  assert.match(unavailableReason(entry({ unavailable: "missing" }))!, /does not have/);
  assert.match(unavailableReason(entry({ binary: true }))!, /Binary/);
  assert.match(unavailableReason(entry({ lineDiffSkipped: "tooLarge" }))!, /Too large/);
  assert.equal(unavailableReason(entry({})), null);
});

test("every refusal the backend can give has its own words", () => {
  const conflicts: LocalGitRestoreConflict[] = [
    { kind: "dirtyDocumentWouldBeOverwritten", folderId: "f", path: "a" },
    { kind: "dirtyDocumentWouldBeDeleted", folderId: "f", path: "a" },
    { kind: "historicalContentUnavailable", folderId: "f", path: "a", reason: "notStored" },
    { kind: "currentContentNotStored", folderId: "f", path: "a" },
    { kind: "currentStateUnknown", folderId: "f", path: "a", reason: "locked" },
    { kind: "pathBlocked", folderId: "f", path: "a" },
    { kind: "caseOnlyRename", folderId: "f", path: "a", onDisk: "A" },
    { kind: "targetUnavailable", folderId: "f", path: "a" },
    { kind: "wouldRemoveUntracked", folderId: "f", path: "a", entry: ".git" },
    { kind: "stagedChangeConflict", folderId: "f", path: "a" },
    { kind: "unstagedChangeWouldBeOverwritten", folderId: "f", path: "a" },
    { kind: "stashBaseChanged", folderId: "f", path: "a" },
    { kind: "untrackedFileCollision", folderId: "f", path: "a" },
    { kind: "diskChangedSinceSnapshot", folderId: "f", path: "a" },
    { kind: "linkNotRestorable", folderId: "f", path: "a", reason: "no privilege" },
  ];
  const words = conflicts.map(describeRestoreConflict);
  assert.equal(new Set(words).size, words.length, "each is distinct");
  for (const text of words) assert.ok(text.startsWith("a:"), text);
  const refusals: LocalGitAiRefusal[] = [
    { kind: "headMoved", expected: "a", found: "b" },
    { kind: "staleChangeSet", expected: "1", found: "2" },
    { kind: "operationInProgress" },
    { kind: "nothingToCommit" },
    { kind: "nothingToUndo" },
    { kind: "humanChangedAiPath", folderId: "f", path: "x" },
    { kind: "preexistingHumanChange", folderId: "f", path: "x" },
    { kind: "stagedOnAiPath", folderId: "f", path: "x" },
    { kind: "undoConflict", folderId: "f", path: "x" },
    { kind: "dirtyDocument", folderId: "f", path: "x" },
    { kind: "historyMovedOn", commit: "c" },
  ];
  const ai = refusals.map(describeAiRefusal);
  assert.equal(new Set(ai).size, ai.length);
  assert.ok(ai.every((text) => !text.includes("[object")));
});

test("errors map to their meaning, with the native message kept for details", () => {
  const busy = describeError(new LocalGitError("Busy", "another operation"));
  assert.match(busy.title, /Another Local Git operation/);
  assert.equal(busy.detail, "another operation");
  assert.match(describeError(new LocalGitError("ReadOnly", "x")).title, /read-only/);
  assert.match(describeError(new LocalGitError("CorruptObject", "x")).title, /damaged/);
  assert.match(describeError(new LocalGitError("SomethingNew", "x")).title, /SomethingNew/);
  assert.match(describeError(new LocalGitClosedError()).title, /closed/);
});

test("an interrupted AI run is never shown as finished", () => {
  assert.equal(aiStatusLabel({ status: "changesDetected", interrupted: true }), "Interrupted");
  assert.equal(aiStatusLabel({ status: "committed", interrupted: false }), "Committed");
});
