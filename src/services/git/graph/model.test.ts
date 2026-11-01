import assert from "node:assert/strict";
import test from "node:test";
import { buildCommitGraph } from "./model.ts";
import type { RawCommit } from "../parsers/log.ts";

/** A minimal commit fixture -- only `fullHash`/`parents` matter to the lane algorithm. */
function commit(fullHash: string, parents: string[]): RawCommit {
  return {
    fullHash,
    hash: fullHash.slice(0, 7),
    parents,
    authorName: "Test",
    authorEmail: "test@example.invalid",
    date: "",
    relativeTime: "",
    subject: fullHash,
    refs: [],
  };
}

const laneOf = (layout: ReturnType<typeof buildCommitGraph>, hash: string) =>
  layout.nodes.find((n) => n.commit.fullHash === hash)?.lane;

test("linear history stays on a single lane", () => {
  const commits = [commit("c3", ["c2"]), commit("c2", ["c1"]), commit("c1", [])];
  const layout = buildCommitGraph(commits);
  assert.deepEqual(
    layout.nodes.map((n) => n.lane),
    [0, 0, 0],
  );
  assert.equal(layout.laneCount, 1);
  assert.deepEqual(
    layout.edges.map((e) => [e.fromRow, e.toRow, e.kind]),
    [
      [0, 1, "parent"],
      [1, 2, "parent"],
    ],
  );
});

test("a feature branch and its merge form a diamond that reconverges onto one lane", () => {
  // M merges A and B, both of which descend from X.
  const commits = [
    commit("M", ["A", "B"]),
    commit("A", ["X"]),
    commit("B", ["X"]),
    commit("X", []),
  ];
  const layout = buildCommitGraph(commits);

  // The first-parent line (M -> A -> X) stays on one lane throughout.
  assert.equal(laneOf(layout, "M"), laneOf(layout, "A"));
  assert.equal(laneOf(layout, "A"), laneOf(layout, "X"));
  // B is a genuinely separate lane while the branch is open...
  assert.notEqual(laneOf(layout, "B"), laneOf(layout, "A"));
  assert.equal(layout.laneCount, 2);

  // ...but both of X's incoming edges land on the same lane: the diamond closes.
  const intoX = layout.edges.filter((e) => e.toRow === layout.nodes.length - 1);
  assert.equal(intoX.length, 2);
  assert.deepEqual(new Set(intoX.map((e) => e.toLane)), new Set([laneOf(layout, "X")]));

  // The merge edge (M's second parent) is tagged distinctly from first-parent edges.
  const fromM = layout.edges.filter((e) => e.fromRow === 0);
  assert.deepEqual(fromM.map((e) => e.kind).sort(), ["merge", "parent"]);
});

test("two unrelated branch tips occupy separate lanes without ever crossing", () => {
  const commits = [commit("a2", ["a1"]), commit("b2", ["b1"]), commit("a1", []), commit("b1", [])];
  const layout = buildCommitGraph(commits);
  assert.notEqual(laneOf(layout, "a2"), laneOf(layout, "b2"));
  assert.equal(laneOf(layout, "a1"), laneOf(layout, "a2"));
  assert.equal(laneOf(layout, "b1"), laneOf(layout, "b2"));
  assert.equal(layout.laneCount, 2);
});

test("an octopus merge fans out to every parent", () => {
  const commits = [
    commit("octopus", ["p1", "p2", "p3"]),
    commit("p1", []),
    commit("p2", []),
    commit("p3", []),
  ];
  const layout = buildCommitGraph(commits);
  const fromOctopus = layout.edges.filter((e) => e.fromRow === 0);
  assert.equal(fromOctopus.length, 3);
  // Three distinct destination lanes: first parent reuses the octopus's own lane,
  // the other two each open their own.
  assert.equal(new Set(fromOctopus.map((e) => e.toLane)).size, 3);
});

test("a lane freed once its chain ends is reused, with a new color, by a later unrelated tip", () => {
  const commits = [commit("x2", ["x1"]), commit("x1", []), commit("y1", [])];
  const layout = buildCommitGraph(commits);
  // y1 reuses x1/x2's lane index (no wider than necessary)...
  assert.equal(laneOf(layout, "y1"), laneOf(layout, "x1"));
  assert.equal(layout.laneCount, 1);
  // ...but is drawn as a logically distinct lane via a different color.
  const colorOf = (hash: string) => layout.nodes.find((n) => n.commit.fullHash === hash)?.color;
  assert.notEqual(colorOf("y1"), colorOf("x1"));
});

test("a parent beyond the loaded window produces a dangling (null toRow) edge", () => {
  const commits = [commit("head", ["missing-parent"])];
  const layout = buildCommitGraph(commits);
  assert.equal(layout.edges.length, 1);
  assert.equal(layout.edges[0].toRow, null);
});

test("appending more history never changes already-rendered rows (stability)", () => {
  const first = [commit("c3", ["c2"]), commit("c2", ["c1"])];
  const appended = [...first, commit("c1", ["c0"]), commit("c0", [])];

  const before = buildCommitGraph(first);
  const after = buildCommitGraph(appended);

  assert.deepEqual(after.nodes.slice(0, 2), before.nodes.slice(0, 2));
  // c2's edge to c1 was dangling before c1 loaded, and now resolves to a real row --
  // the one legitimate change, not a jitter in anything already drawn.
  assert.equal(before.edges[1].toRow, null);
  assert.equal(after.edges[1].toRow, 2);
});
