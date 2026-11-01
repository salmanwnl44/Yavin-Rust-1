import assert from "node:assert/strict";
import test from "node:test";
// The explorer's path helpers live beside the component, outside the test glob; they have no
// component imports, so they are tested from here.
import { cleanPath, containingDir, getRelativePath } from "../components/explorer/paths.ts";

test("cleanPath strips extended-length prefixes and backslashes, as the native side does", () => {
  assert.equal(cleanPath("C:/Work/a.ts"), "C:/Work/a.ts");
  assert.equal(cleanPath("C:\\Work\\a.ts"), "C:/Work/a.ts");
  assert.equal(cleanPath("\\\\?\\C:\\Work\\a.ts"), "C:/Work/a.ts");
  assert.equal(cleanPath("\\\\?\\UNC\\server\\share\\a.ts"), "//server/share/a.ts");
  assert.equal(cleanPath(""), "");
});

test("a copied relative path is relative to the workspace, or absolute when outside it", () => {
  assert.equal(getRelativePath("C:/Work/src/a.ts", "C:/Work"), "src/a.ts");
  // Git and typed paths can differ from the tree in drive-letter case.
  assert.equal(getRelativePath("c:/work/src/a.ts", "C:\\Work"), "src/a.ts");
  assert.equal(getRelativePath("C:/Work", "C:/Work"), ".");
  assert.equal(getRelativePath("C:/Work-two/a.ts", "C:/Work"), "C:/Work-two/a.ts");
  assert.equal(getRelativePath("/work/a.ts", "/Work"), "/work/a.ts");
  assert.equal(getRelativePath("/work/a.ts", ""), "/work/a.ts");
  assert.equal(getRelativePath("", "/work"), "");
});

test("the containing directory of a file is its parent, and of a folder itself", () => {
  assert.equal(containingDir("C:/Work/src/a.ts", false), "C:/Work/src");
  assert.equal(containingDir("C:\\Work\\src", true), "C:/Work/src");
});
