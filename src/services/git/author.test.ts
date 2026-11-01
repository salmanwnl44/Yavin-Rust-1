import assert from "node:assert/strict";
import test from "node:test";
import { handleFor, initials } from "../../services/git/author.ts";

test("the avatar is the author's initials, with no network fetch", () => {
  // Yavin fetches no images anywhere; a gravatar request would be the first, from a hover.
  assert.equal(initials("Ada Lovelace"), "AL");
  assert.equal(initials("prince"), "PR");
  assert.equal(initials("  Grace  Brewster  Hopper "), "GB");
});

test("an author with no name still gets a circle rather than an empty one", () => {
  assert.equal(initials(""), "?");
  assert.equal(initials("   "), "?");
});

test("the handle is the local part of the email address", () => {
  assert.equal(handleFor("ada@example.com"), "@ada");
  assert.equal(handleFor(""), "");
  // A commit can carry a malformed address; showing it beats showing nothing.
  assert.equal(handleFor("nobody"), "@nobody");
});
