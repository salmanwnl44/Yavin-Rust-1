/** EXT-27: the window's focus as extensions are told it -- changes only, read from the window. */
import assert from "node:assert/strict";
import test from "node:test";
import { createNativeWindowFocus, createWindowFocus } from "./windowFocus.ts";
import { applyExtensionEdit } from "./extensions/documentEdit.ts";
import type { TextDocument } from "./documents.ts";

function source(initial: boolean) {
  let focused = initial;
  const listeners = { focus: new Set<() => void>(), blur: new Set<() => void>() };
  return {
    hasFocus: () => focused,
    addEventListener: (type: "focus" | "blur", l: () => void) => listeners[type].add(l),
    removeEventListener: (type: "focus" | "blur", l: () => void) => listeners[type].delete(l),
    fire(type: "focus" | "blur", now = type === "focus") {
      focused = now;
      for (const l of [...listeners[type]]) l();
    },
    count: () => listeners.focus.size + listeners.blur.size,
  };
}

test("focus: the initial state, then each real change once", () => {
  const s = source(true);
  const focus = createWindowFocus(s);
  const heard: boolean[] = [];
  const stop = focus.onChange((f) => heard.push(f));
  assert.equal(focus.focused(), true);
  s.fire("blur");
  s.fire("blur"); // no change
  s.fire("focus");
  s.fire("focus"); // no change
  assert.deepEqual(heard, [false, true]);
  // A blur that leaves the document focused (focus moved into a frame of its own) is no change.
  s.fire("blur", true);
  assert.deepEqual(heard, [false, true]);
  stop();
  s.fire("blur");
  assert.deepEqual(heard, [false, true], "an unsubscribed listener hears nothing");
  assert.equal(focus.focused(), false, "the state still follows");
  focus.dispose();
  assert.equal(s.count(), 0, "dispose removes the window listeners");
});

test("focus: one listener's failure is not another's", () => {
  const s = source(false);
  const focus = createWindowFocus(s);
  const heard: boolean[] = [];
  focus.onChange(() => {
    throw new Error("listener broke");
  });
  focus.onChange((f) => heard.push(f));
  s.fire("focus");
  assert.deepEqual(heard, [true]);
});

/** A native window whose answers and events the test releases. */
function native() {
  let answer: (focused: boolean) => void = () => undefined;
  let subscribed: (stop: () => void) => void = () => undefined;
  let listener: ((focused: boolean) => void) | null = null;
  let unsubscribed = 0;
  return {
    source: {
      isFocused: () => new Promise<boolean>((resolve) => (answer = resolve)),
      onFocusChanged: (l: (focused: boolean) => void) => {
        listener = l;
        return new Promise<() => void>((resolve) => (subscribed = resolve));
      },
    },
    answer: (focused: boolean) => answer(focused),
    subscribe: () => subscribed(() => void unsubscribed++),
    fire: (focused: boolean) => listener?.(focused),
    unsubscribed: () => unsubscribed,
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("native focus: corrected once from isFocused, then each event's change once", async () => {
  const n = native();
  const focus = createNativeWindowFocus(n.source, true);
  const heard: boolean[] = [];
  focus.onChange((f) => heard.push(f));
  n.subscribe();
  n.answer(false); // launched behind another application
  await tick();
  assert.equal(focus.focused(), false);
  n.fire(false); // no change
  n.fire(true);
  n.fire(true); // no change
  n.fire(false);
  assert.deepEqual(heard, [false, true, false]);
  focus.dispose();
  assert.equal(n.unsubscribed(), 1, "dispose unsubscribes");
  n.fire(true);
  assert.deepEqual(heard, [false, true, false], "nothing after dispose");
});

test("native focus: an event is newer than a late isFocused answer; disposed early, it still unsubscribes", async () => {
  const n = native();
  const focus = createNativeWindowFocus(n.source, false);
  n.fire(true);
  n.answer(false); // answered for a moment before the event
  await tick();
  assert.equal(focus.focused(), true);
  focus.dispose();
  n.subscribe(); // the subscription resolves after dispose
  await tick();
  assert.equal(n.unsubscribed(), 1);
});

const doc = (over: Partial<TextDocument> = {}) =>
  ({
    key: "k",
    text: "one\ntwo\n",
    version: 3,
    readOnly: false,
    source: { kind: "disk" },
    ...over,
  }) as TextDocument;

test("an extension edit: applied as one change at its version; refused when stale, a proposal, read-only or overlapping", () => {
  const edits: [string, string][] = [];
  const documents = { edit: (key: string, text: string) => void edits.push([key, text]) } as never;
  const range = (sl: number, sc: number, el: number, ec: number) => ({
    startLine: sl,
    startColumn: sc,
    endLine: el,
    endColumn: ec,
  });
  assert.equal(
    applyExtensionEdit(documents, doc(), 3, [
      { range: range(1, 1, 1, 4), text: "ONE" },
      { range: range(2, 4, 2, 4), text: "!" },
    ]),
    true,
  );
  assert.deepEqual(edits, [["k", "ONE\ntwo!\n"]]);
  assert.equal(
    applyExtensionEdit(documents, doc(), null, [{ range: range(1, 1, 1, 1), text: ">" }]),
    true,
    "null: any version",
  );
  assert.equal(
    applyExtensionEdit(documents, doc(), 2, [{ range: range(1, 1, 1, 1), text: "x" }]),
    false,
    "stale",
  );
  assert.equal(
    applyExtensionEdit(documents, doc({ source: { kind: "proposed" } as never }), 3, []),
    false,
    "a proposal",
  );
  assert.equal(
    applyExtensionEdit(documents, doc({ readOnly: true }), 3, [
      { range: range(1, 1, 1, 1), text: "x" },
    ]),
    false,
    "read-only",
  );
  assert.equal(
    applyExtensionEdit(
      documents,
      doc({ readOnly: true }),
      3,
      [{ range: range(1, 1, 1, 1), text: "x" }],
      () => true,
    ),
    true,
    "read-only, unlocked",
  );
  assert.equal(
    applyExtensionEdit(documents, doc(), 3, [
      { range: range(1, 1, 1, 3), text: "a" },
      { range: range(1, 2, 1, 4), text: "b" },
    ]),
    false,
    "overlapping",
  );
  assert.equal(applyExtensionEdit(documents, undefined, 3, []), false, "no such document");
  assert.equal(edits.length, 3, "only the accepted edits reached the document service");
});
