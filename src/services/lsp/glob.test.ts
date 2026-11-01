import assert from "node:assert/strict";
import test from "node:test";
import { matchesGlob } from "./glob.ts";

test("globs match as servers write them", () => {
  const yes = (pattern: string, path: string) =>
    assert.ok(matchesGlob(pattern, path), `${pattern} ~ ${path}`);
  const no = (pattern: string, path: string) =>
    assert.ok(!matchesGlob(pattern, path), `${pattern} !~ ${path}`);
  yes("**/*.ts", "/w/src/a.ts");
  yes("**/*.ts", "/a.ts");
  no("**/*.ts", "/w/src/a.tsx");
  yes("**/*.{ts,tsx,js}", "/w/a.tsx");
  no("**/*.{ts,tsx,js}", "/w/a.json");
  yes("**/tsconfig.json", "/w/packages/app/tsconfig.json");
  yes("**/node_modules/**", "/w/node_modules/x/index.js");
  no("**/node_modules/**", "/w/src/modules/x.js");
  yes("*.py", "/w/deep/tool.py");
  yes("src/[a-c]*.py", "/w/src/beta.py");
  no("src/[a-c]*.py", "/w/src/delta.py");
  yes("src/[!a]*.py", "/w/src/delta.py");
  yes("file?.rs", "/w/file1.rs");
  no("file?.rs", "/w/file10.rs");
  // `*` stays inside one segment.
  no("/w/*.ts", "/w/src/a.ts");
  yes("/w/*.ts", "/w/a.ts");
  // Case, where the file system ignores it.
  assert.ok(matchesGlob("**/*.TS", "C:/W/a.ts", true));
  assert.ok(!matchesGlob("**/*.TS", "/w/a.ts", false));
  // Regular-expression characters in names are literal.
  yes("**/a+b(1).ts", "/w/a+b(1).ts");
  no("**/a.ts", "/w/aXts");
});
