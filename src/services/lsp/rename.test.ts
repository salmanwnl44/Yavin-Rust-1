import assert from "node:assert/strict";
import test from "node:test";
import { isValidRenameName } from "./rename.ts";

test("isValidRenameName accepts a plausible identifier and rejects empty, blank or multi-line names", () => {
  assert.equal(isValidRenameName("renamed"), true);
  assert.equal(isValidRenameName("_private$1"), true);
  // The server, not Yavin, judges language-specific validity, so an unusual-but-single-line name
  // is passed through.
  assert.equal(isValidRenameName("数値"), true);
  assert.equal(isValidRenameName("a b"), true);

  assert.equal(isValidRenameName(""), false);
  assert.equal(isValidRenameName("   "), false);
  assert.equal(isValidRenameName("\t"), false);
  assert.equal(isValidRenameName("one\ntwo"), false);
  assert.equal(isValidRenameName("one\rtwo"), false);
  assert.equal(isValidRenameName(undefined), false);
  assert.equal(isValidRenameName(42), false);
});
