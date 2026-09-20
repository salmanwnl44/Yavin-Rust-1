import assert from "node:assert/strict";
import test from "node:test";
import { readChangesSort, saveChangesSort, sortChanges, statusLetter } from "./changesSort.ts";
import type { GitEntry } from "./parsers/status.ts";

const entry = (path: string, over: Partial<GitEntry> = {}): GitEntry => ({
  path,
  index: " ",
  worktree: "M",
  untracked: false,
  conflict: false,
  ...over,
});
const paths = (entries: GitEntry[]) => entries.map((e) => e.path);

const MIXED: GitEntry[] = [
  entry("/r/src/b.ts"),
  entry("/r/README.md", { worktree: " ", index: "A" }),
  entry("/r/src/a.ts", { worktree: "D" }),
  entry("/r/new.txt", { untracked: true, worktree: " " }),
  entry("/r/lib/A.ts"),
  entry("/r/clash.ts", { conflict: true, index: "U", worktree: "U" }),
  entry("/r/moved.ts", { index: "R", worktree: " ", originalPath: "/r/old.ts" }),
];

test("discovery keeps Git's order, with conflicts first", () => {
  assert.deepEqual(paths(sortChanges(MIXED, "discovery")), [
    "/r/clash.ts",
    "/r/src/b.ts",
    "/r/README.md",
    "/r/src/a.ts",
    "/r/new.txt",
    "/r/lib/A.ts",
    "/r/moved.ts",
  ]);
});

test("name sorts by file name (any case), then folder, with conflicts still first", () => {
  assert.deepEqual(paths(sortChanges(MIXED, "name")), [
    "/r/clash.ts",
    "/r/lib/A.ts", // "A.ts" and "a.ts" sort together; the folder breaks the tie
    "/r/src/a.ts",
    "/r/src/b.ts",
    "/r/moved.ts",
    "/r/new.txt",
    "/r/README.md",
  ]);
});

test("name sorts numbers naturally", () => {
  const files = ["/r/file10.ts", "/r/file2.ts", "/r/file1.ts"].map((p) => entry(p));
  assert.deepEqual(paths(sortChanges(files, "name")), [
    "/r/file1.ts",
    "/r/file2.ts",
    "/r/file10.ts",
  ]);
});

test("status groups by the letter shown, then by path, with conflicts first", () => {
  const sorted = sortChanges(MIXED, "status");
  assert.deepEqual(paths(sorted), [
    "/r/clash.ts", // conflict
    "/r/lib/A.ts", // M
    "/r/src/b.ts", // M
    "/r/README.md", // A (staged add)
    "/r/moved.ts", // R
    "/r/src/a.ts", // D
    "/r/new.txt", // U (untracked)
  ]);
  assert.deepEqual(sorted.map(statusLetter), ["!", "M", "M", "A", "R", "D", "U"]);
});

test("a renamed file sorts by its new path, not the old one", () => {
  const files = [
    entry("/r/zzz.ts", { index: "R", worktree: " ", originalPath: "/r/aaa.ts" }),
    entry("/r/mmm.ts"),
  ];
  assert.deepEqual(paths(sortChanges(files, "name")), ["/r/mmm.ts", "/r/zzz.ts"]);
});

test("sorting is stable: equal keys keep Git's order between calls", () => {
  const files = [
    entry("/r/a/same.ts", { worktree: "M" }),
    entry("/r/b/same.ts", { worktree: "M" }),
    entry("/r/a/same.ts", { worktree: "M", index: "M" }), // identical path: order is Git's
  ];
  const first = sortChanges(files, "name");
  assert.deepEqual(sortChanges(first, "name"), first);
  assert.equal(first[1], files[2]);
});

test("sorting never mutates its input and handles an empty list", () => {
  const copy = [...MIXED];
  sortChanges(MIXED, "status");
  sortChanges(MIXED, "name");
  assert.deepEqual(MIXED, copy);
  for (const order of ["discovery", "name", "status"] as const)
    assert.deepEqual(sortChanges([], order), []);
});

test("a large list sorts quickly and completely", () => {
  const many = Array.from({ length: 20_000 }, (_, i) =>
    entry(`/r/dir${i % 50}/file${(i * 7919) % 20_000}.ts`, { worktree: "MD"[i % 2] }),
  );
  const started = Date.now();
  for (const order of ["name", "status"] as const) {
    assert.equal(sortChanges(many, order).length, many.length);
  }
  assert.ok(Date.now() - started < 3000, "sorting 20,000 files should take well under 3 s");
});

test("the chosen order is remembered, and an invalid or missing value falls back to discovery", () => {
  const data = new Map<string, string>();
  const g = globalThis as unknown as { localStorage?: unknown };
  const previous = Object.getOwnPropertyDescriptor(g, "localStorage");
  Object.defineProperty(g, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    },
  });
  try {
    assert.equal(readChangesSort(), "discovery");
    saveChangesSort("name");
    assert.equal(readChangesSort(), "name");
    data.set("yavin.scm.changesSort", "size"); // not an offered order
    assert.equal(readChangesSort(), "discovery");
  } finally {
    if (previous) Object.defineProperty(g, "localStorage", previous);
    else delete g.localStorage;
  }
});
