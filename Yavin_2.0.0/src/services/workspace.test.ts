import assert from "node:assert/strict";
import test from "node:test";
import { flattenFiles, isWithin, parseGitStatus, remapPath } from "./workspace.ts";

test("folder rename remaps descendants without matching sibling prefixes", () => {
  assert.equal(remapPath("/work/src/a.ts", "/work/src", "/work/lib"), "/work/lib/a.ts");
  assert.equal(remapPath("/work/src-old/a.ts", "/work/src", "/work/lib"), "/work/src-old/a.ts");
  assert.equal(remapPath("/work/src", "/work/src", "/work/lib"), "/work/lib");
  assert.equal(isWithin("/work/src-old", "/work/src"), false);
});

test("Git status preserves special filenames and consumes rename source records", () => {
  const result = parseGitStatus(
    ' M file with spaces.ts\0?? quote"name.ts\0R  new.ts\0old.ts\0 M line\nbreak.ts\0',
    "/work",
  );
  assert.deepEqual(result, {
    "/work/file with spaces.ts": "M",
    '/work/quote"name.ts': "U",
    "/work/new.ts": "R",
    "/work/line\nbreak.ts": "M",
  });
});

test("Git conflicts are distinct from untracked files", () => {
  assert.deepEqual(parseGitStatus("UU conflict.ts\0AA added.ts\0 D removed.ts\0", "/work/"), {
    "/work/conflict.ts": "CONFLICT",
    "/work/added.ts": "CONFLICT",
    "/work/removed.ts": "D",
  });
  assert.deepEqual(parseGitStatus("", "/work"), {});
});

test("quick open uses full native paths and skips folders", () => {
  assert.deepEqual(
    flattenFiles({
      name: "work",
      path: "/work",
      is_dir: true,
      children: [
        {
          name: "src",
          path: "/work/src",
          is_dir: true,
          children: [{ name: "app.tsx", path: "/work/src/app.tsx", is_dir: false }],
        },
        { name: "empty", path: "/work/empty", is_dir: true, children: null },
      ],
    }),
    [{ title: "app.tsx", subtitle: "/work/src/app.tsx", type: "file" }],
  );
});
