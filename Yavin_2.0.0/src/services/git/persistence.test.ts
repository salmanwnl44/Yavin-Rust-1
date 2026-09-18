import assert from "node:assert/strict";
import test from "node:test";
import { parsePersistedState } from "./persistence.ts";

test("parsePersistedState reads nothing as an empty, versioned state", () => {
  assert.deepEqual(parsePersistedState(null), { schemaVersion: 1, repositories: [] });
});

test("parsePersistedState migrates the pre-worktree plain-array schema", () => {
  const state = parsePersistedState(JSON.stringify(["/work/a", "/work/b"]));
  assert.deepEqual(state, {
    schemaVersion: 1,
    repositories: [
      { commonDirHint: "/work/a", worktrees: ["/work/a"] },
      { commonDirHint: "/work/b", worktrees: ["/work/b"] },
    ],
  });
});

test("parsePersistedState ignores non-string entries in the pre-worktree schema", () => {
  const state = parsePersistedState(JSON.stringify(["/work/a", 42, null]));
  assert.deepEqual(
    state.repositories.map((r) => r.commonDirHint),
    ["/work/a"],
  );
});

test("parsePersistedState reads an already-versioned schemaVersion 1 value as-is", () => {
  const versioned = {
    schemaVersion: 1,
    repositories: [{ commonDirHint: "/work/a/.git", worktrees: ["/work/a", "/work/a-feature"] }],
    activeRepository: "/work/a/.git",
  };
  assert.deepEqual(parsePersistedState(JSON.stringify(versioned)), versioned);
});

test("parsePersistedState treats malformed JSON as empty rather than throwing", () => {
  assert.deepEqual(parsePersistedState("{not json"), { schemaVersion: 1, repositories: [] });
});

test("parsePersistedState treats an unrecognized object shape as empty", () => {
  assert.deepEqual(parsePersistedState(JSON.stringify({ somethingElse: true })), {
    schemaVersion: 1,
    repositories: [],
  });
});
