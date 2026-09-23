import assert from "node:assert/strict";
import test from "node:test";
import { folderKey, folderName, parentPath } from "./paths.ts";

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

test("the parent is shown beside the name, so two projects called src can be told apart", () => {
  assert.equal(parentPath("/home/me/work/project"), "/home/me/work");
  assert.equal(parentPath(`C:${BACKSLASH}Projects${BACKSLASH}Yavin`), `C:${BACKSLASH}Projects`);
  // Nothing above it, rather than a misleading fragment.
  assert.equal(parentPath("/project"), "");
  assert.equal(parentPath("project"), "");
});

test("the same folder spelled differently has the same key", () => {
  // The two spellings that actually occur: a dialog's backslashes and a typed forward slash,
  // in either case. Remembering a session per folder depends on these matching.
  assert.equal(folderKey(`C:${BACKSLASH}Work${BACKSLASH}Project`), folderKey("c:/work/project/"));
});

test("folders that only share a prefix keep different keys", () => {
  assert.notEqual(folderKey("/work/project"), folderKey("/work/project-two"));
});
