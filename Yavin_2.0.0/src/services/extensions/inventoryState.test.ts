import assert from "node:assert/strict";
import test from "node:test";
import {
  createInventoryStateStore,
  describeInventory,
  inventoryStateOf,
  START_OVER_WARNING,
} from "./inventoryState.ts";
import { describeRegistryTrust } from "./marketplace/registryTrust.ts";

const NEWER =
  "InventoryUnsupported: the extension inventory was written by a newer Yavin (inventory version 5; this Yavin reads up to 4). It was left exactly as it is, and no extension runs until that Yavin, or a newer one, is installed again -- then your extensions, permissions, profiles and settings are as they were. Nothing needs to be deleted.";
const NOT_READ =
  "InventoryUnsupported: the extension inventory (inventory version 4) holds data this Yavin cannot read -- most likely written by a newer Yavin. It was left exactly as it is, and no extension runs until a Yavin that reads it is installed again. Nothing needs to be deleted.";

test("EXT-21 a listing's failure: a newer or unreadable inventory is unsupported (left as it is); anything else failed", () => {
  assert.deepEqual(inventoryStateOf(NEWER), { kind: "unsupported", message: NEWER });
  assert.deepEqual(inventoryStateOf(new Error(NOT_READ)), {
    kind: "unsupported",
    message: NOT_READ,
  });
  const failed = inventoryStateOf(
    "InventoryUnavailable: the extension inventory cannot be read right now; nothing was changed.",
  );
  assert.equal(failed.kind, "failed");
  assert.equal(inventoryStateOf("InventoryUnrecoverable: x").kind, "failed");
});

test("EXT-21 each state says what was kept and what to do, and offers only the actions that apply", () => {
  assert.equal(describeInventory({ kind: "unknown" }), null);
  assert.equal(describeInventory({ kind: "ok", root: "C:/x", setAside: null }), null);

  const newer = describeInventory(inventoryStateOf(NEWER))!;
  assert.equal(newer.tone, "error");
  assert.equal(newer.title, "Extensions paused: their inventory is from a newer Yavin");
  assert.match(newer.detail, /left exactly as it is, and no extension runs here/);
  assert.match(newer.detail, /Install the Yavin you used before \(or a newer one\)/);
  assert.match(newer.detail, /Nothing needs to be deleted/);
  assert.equal(newer.reason, NEWER);
  assert.deepEqual(newer.actions, ["retry", "startOver"]);

  const unread = describeInventory(inventoryStateOf(NOT_READ))!;
  assert.equal(unread.title, "Extensions paused: their inventory cannot be read by this Yavin");
  assert.deepEqual(unread.actions, ["retry", "startOver"]);

  const failed = describeInventory(inventoryStateOf("InventoryUnavailable: locked"))!;
  assert.equal(failed.title, "Extensions could not be loaded");
  assert.match(failed.detail, /nothing was changed/);
  assert.deepEqual(failed.actions, ["retry"]);

  const offered = describeInventory({
    kind: "ok",
    root: "C:/x",
    setAside: {
      file: "inventory.json.corrupt-1790000000000.bak",
      at: Date.UTC(2026, 8, 21),
      version: 3,
      extensions: 3,
      grants: 1,
      profiles: 2,
    },
  })!;
  assert.equal(offered.tone, "warning");
  assert.equal(offered.title, "An older Yavin set your extensions aside");
  assert.match(offered.detail, /^On 2026-09-21, /);
  assert.match(offered.detail, /3 extensions, 1 permission grant and 2 profiles/);
  assert.match(offered.detail, /the inventory in use now is kept/);
  assert.match(offered.detail, /none runs that would not have/);
  assert.deepEqual(offered.actions, ["restore", "keep"]);

  // Starting over says, before it is confirmed, that nothing is lost and what it costs.
  assert.match(START_OVER_WARNING, /kept -- renamed, byte for byte/);
  assert.match(
    START_OVER_WARNING,
    /no permissions, and no extension's code running until it is reinstalled/,
  );
});

test("EXT-21 the store tells its subscribers", () => {
  const store = createInventoryStateStore();
  let heard = 0;
  const stop = store.subscribe(() => heard++);
  store.set(inventoryStateOf(NEWER));
  assert.equal(store.getSnapshot().kind, "unsupported");
  stop();
  store.set({ kind: "ok", root: "C:/x", setAside: null });
  assert.equal(heard, 1);
  assert.equal(store.get().kind, "ok");
});

test("EXT-21 an unreadable registry replay record is refused, said, and installs no code", () => {
  const said = describeRegistryTrust({
    kind: "checked",
    verification: {
      status: "stateInvalid",
      registryId: "yavin-official",
      keyId: "k",
      sequence: 3,
      issuedAt: null,
      expiresAt: null,
      sha256: "a",
      anchorsRevision: 1,
    },
  })!;
  assert.equal(said.tone, "error");
  assert.equal(said.title, "Registry replay record unreadable");
  assert.match(said.detail, /left as it is/);
  assert.match(said.detail, /Nothing is installed or updated from it/);
  assert.equal(said.installsCode, false);
});
