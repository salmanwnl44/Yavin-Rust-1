/**
 * Merge-conflict engine (WS10): classification from Git's unmerged codes, conflict-marker parsing
 * (two-way and diff3), per-region resolution, rebuild, and progress. Pure fixtures; no Git.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyResolutions,
  classifyConflict,
  hasConflictMarkers,
  parseConflicts,
  regionSideLines,
  resolutionProgress,
  resolveRegionLines,
  type Choice,
} from "./conflict.ts";

test("classifyConflict names every unmerged state and its available sides", () => {
  assert.deepEqual(classifyConflict("UU"), {
    type: "both-modified",
    sides: { base: true, current: true, incoming: true },
    fileLevel: false,
    label: "Both modified",
  });
  assert.equal(classifyConflict("AA")!.type, "both-added");
  assert.equal(classifyConflict("AA")!.sides.base, false, "both-added has no base");
  assert.equal(classifyConflict("AU")!.type, "added-by-us");
  assert.equal(classifyConflict("AU")!.fileLevel, true, "a one-sided add is file-level");
  assert.equal(classifyConflict("UA")!.type, "added-by-them");
  assert.equal(classifyConflict("UD")!.type, "deleted-by-them");
  assert.equal(classifyConflict("DU")!.type, "deleted-by-us");
  assert.equal(classifyConflict("DD")!.fileLevel, true);
  assert.equal(classifyConflict(" M"), null, "a normal modified file is not a conflict");
});

const TWO_WAY = [
  "line 1",
  "<<<<<<< HEAD",
  "ours a",
  "ours b",
  "=======",
  "theirs a",
  ">>>>>>> feature",
  "line 2",
  "",
].join("\n");

test("parseConflicts reads a two-way region with its sides, labels and line span", () => {
  const parsed = parseConflicts(TWO_WAY);
  assert.equal(parsed.regions.length, 1);
  const r = parsed.regions[0]!;
  assert.deepEqual(r.current, ["ours a", "ours b"]);
  assert.deepEqual(r.incoming, ["theirs a"]);
  assert.equal(r.base, null, "no diff3 base section");
  assert.equal(r.currentLabel, "HEAD");
  assert.equal(r.incomingLabel, "feature");
  assert.equal(r.startLine, 2);
  assert.equal(r.endLine, 7);
  assert.deepEqual(parseConflicts("a\nb\n").regions, [], "a file with no markers has no regions");
});

test("parseConflicts reads a diff3 base section", () => {
  const diff3 = [
    "<<<<<<< HEAD",
    "ours",
    "||||||| base",
    "original",
    "=======",
    "theirs",
    ">>>>>>> feature",
  ].join("\n");
  const r = parseConflicts(diff3).regions[0]!;
  assert.deepEqual(r.base, ["original"]);
  assert.deepEqual(r.current, ["ours"]);
  assert.deepEqual(r.incoming, ["theirs"]);
});

test("an unterminated conflict marker is treated as plain text, not a region", () => {
  const parsed = parseConflicts("a\n<<<<<<< HEAD\nours\nno end marker\n");
  assert.equal(parsed.regions.length, 0);
  assert.equal(applyResolutions(parsed, new Map()), "a\n<<<<<<< HEAD\nours\nno end marker\n");
});

test("resolveRegionLines returns each side; Accept Both is current then incoming", () => {
  const r = parseConflicts(TWO_WAY).regions[0]!;
  assert.deepEqual(resolveRegionLines(r, "current"), ["ours a", "ours b"]);
  assert.deepEqual(resolveRegionLines(r, "incoming"), ["theirs a"]);
  assert.deepEqual(resolveRegionLines(r, "both"), ["ours a", "ours b", "theirs a"]);
  // Base with no diff3 base keeps the markers rather than fabricating a side.
  assert.ok(resolveRegionLines(r, "base").some((l) => l.startsWith("<<<<<<<")));
});

test("applyResolutions rebuilds the file; unresolved regions keep their markers", () => {
  const parsed = parseConflicts(TWO_WAY);
  assert.equal(
    applyResolutions(parsed, new Map([[0, "current"]])),
    "line 1\nours a\nours b\nline 2\n",
  );
  assert.equal(applyResolutions(parsed, new Map([[0, "incoming"]])), "line 1\ntheirs a\nline 2\n");
  assert.equal(
    applyResolutions(parsed, new Map([[0, "both"]])),
    "line 1\nours a\nours b\ntheirs a\nline 2\n",
  );
  // No choice → the markers stay (the file remains unresolved there).
  assert.ok(applyResolutions(parsed, new Map()).includes("<<<<<<< HEAD"));
});

test("multiple regions resolve independently without touching each other or surrounding text", () => {
  const text = [
    "top",
    "<<<<<<< HEAD",
    "A-ours",
    "=======",
    "A-theirs",
    ">>>>>>> f",
    "middle",
    "<<<<<<< HEAD",
    "B-ours",
    "=======",
    "B-theirs",
    ">>>>>>> f",
    "bottom",
  ].join("\n");
  const parsed = parseConflicts(text);
  assert.equal(parsed.regions.length, 2);
  const resolved = applyResolutions(
    parsed,
    new Map<number, Choice>([
      [0, "incoming"],
      [1, "current"],
    ]),
  );
  assert.equal(resolved, "top\nA-theirs\nmiddle\nB-ours\nbottom");
});

test("resolutionProgress counts decided vs. remaining regions; re-resolution updates it", () => {
  const parsed = parseConflicts(
    [
      "<<<<<<< HEAD",
      "a",
      "=======",
      "b",
      ">>>>>>> f",
      "x",
      "<<<<<<< HEAD",
      "c",
      "=======",
      "d",
      ">>>>>>> f",
    ].join("\n"),
  );
  assert.deepEqual(resolutionProgress(parsed, new Map()), { total: 2, resolved: 0, unresolved: 2 });
  const choices = new Map<number, Choice>([[0, "current"]]);
  assert.deepEqual(resolutionProgress(parsed, choices), { total: 2, resolved: 1, unresolved: 1 });
  choices.set(0, "manual"); // revising a decision back to manual
  assert.deepEqual(resolutionProgress(parsed, choices), { total: 2, resolved: 0, unresolved: 2 });
});

test("regionSideLines maps a region to the editor line ranges of each side (two-way and diff3)", () => {
  // TWO_WAY: <<< at 2, ours a/b at 3-4, ===== at 5, theirs a at 6, >>> at 7.
  const two = regionSideLines(parseConflicts(TWO_WAY).regions[0]!);
  assert.deepEqual(
    [two.currentStart, two.currentEnd, two.incomingStart, two.incomingEnd],
    [3, 4, 6, 6],
  );
  assert.ok(two.baseEnd < two.baseStart, "no base side");
  // diff3: <<< 1, ours 2, ||| 3, original 4, === 5, theirs 6, >>> 7.
  const diff3 = parseConflicts(
    [
      "<<<<<<< HEAD",
      "ours",
      "||||||| base",
      "original",
      "=======",
      "theirs",
      ">>>>>>> feature",
    ].join("\n"),
  ).regions[0]!;
  const r = regionSideLines(diff3);
  assert.deepEqual(
    [r.currentStart, r.currentEnd, r.baseStart, r.baseEnd, r.incomingStart, r.incomingEnd],
    [2, 2, 4, 4, 6, 6],
  );
});

test("hasConflictMarkers detects remaining markers after a partial hand edit", () => {
  assert.equal(hasConflictMarkers("no markers here\n"), false);
  assert.equal(hasConflictMarkers(TWO_WAY), true);
});
