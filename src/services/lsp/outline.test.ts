import assert from "node:assert/strict";
import test from "node:test";
import { createOutlineStore, symbolPath, toOutline } from "./outline.ts";
import type { OutlineSymbol } from "./outline.ts";
import type { DocumentSymbol, SymbolInformation } from "./protocol.ts";

const range = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
});

const names = (symbols: readonly OutlineSymbol[]): unknown =>
  symbols.map((symbol) =>
    symbol.children.length ? [symbol.name, names(symbol.children)] : symbol.name,
  );

test("a symbol tree is kept, in document order, in the editor's positions", () => {
  const symbols: DocumentSymbol[] = [
    { name: "later", kind: 12, range: range(5, 0, 6, 1), selectionRange: range(5, 9, 5, 14) },
    {
      name: "Outer",
      kind: 5,
      range: range(0, 0, 4, 1),
      selectionRange: range(0, 6, 0, 11),
      children: [
        { name: "b", kind: 6, range: range(2, 2, 3, 3), selectionRange: range(2, 2, 2, 3) },
        { name: "a", kind: 6, range: range(1, 2, 1, 9), selectionRange: range(1, 2, 1, 3) },
      ],
    },
  ];
  const outline = toOutline(symbols, null, "utf-16");
  assert.deepEqual(names(outline), [["Outer", ["a", "b"]], "later"]);
  assert.deepEqual(
    outline.map((one) => one.id),
    ["0", "1"],
  );
  assert.equal(outline[0].children[1].id, "0/1");
  assert.deepEqual(outline[1].selection, {
    startLineNumber: 6,
    startColumn: 10,
    endLineNumber: 6,
    endColumn: 15,
  });

  assert.deepEqual(
    symbolPath(outline, 3, 5).map((one) => one.name),
    ["Outer", "b"],
  );
  assert.deepEqual(
    symbolPath(outline, 1, 5).map((one) => one.name),
    ["Outer"],
  );
  assert.deepEqual(symbolPath(outline, 20, 1), []);
});

test("a flat list is nested by containment; UTF-8 columns become UTF-16 ones", () => {
  const text = "é😀 class A {\n  m() {}\n}\nfunction f() {}\n";
  const at = (sl: number, sc: number, el: number, ec: number): SymbolInformation["location"] => ({
    uri: "file:///w/a.ts",
    range: range(sl, sc, el, ec),
  });
  const symbols: SymbolInformation[] = [
    { name: "f", kind: 12, location: at(3, 0, 3, 15) },
    { name: "m", kind: 6, location: at(1, 2, 1, 8), containerName: "A" },
    // "é😀 " is 7 bytes in UTF-8 and 4 code units in UTF-16.
    { name: "A", kind: 5, location: at(0, 7, 2, 1) },
  ];
  const outline = toOutline(symbols, text, "utf-8");
  assert.deepEqual(names(outline), [["A", ["m"]], "f"]);
  assert.equal(outline[0].range.startColumn, 5);
  assert.deepEqual(
    symbolPath(outline, 2, 4).map((one) => one.name),
    ["A", "m"],
  );
});

test("the outline follows the document in front and drops answers for anything else", async () => {
  const answers = new Map<string, (symbols: OutlineSymbol[] | null) => void>();
  const asked: string[] = [];
  const store = createOutlineStore(
    {
      fetch: (key) =>
        new Promise((resolve) => {
          asked.push(key);
          answers.set(key, resolve);
        }),
    },
    5,
  );
  const symbol = (name: string): OutlineSymbol => ({
    id: name,
    name,
    kind: 12,
    range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 },
    selection: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 },
    children: [],
  });

  store.show("/a.ts");
  assert.equal(store.get().state, "loading");
  store.show("/b.ts");
  // The first document's answer comes late: dropped.
  answers.get("/a.ts")!([symbol("fromA")]);
  answers.get("/b.ts")!([symbol("fromB")]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const shown = store.get();
  assert.equal(shown.state, "ready");
  assert.deepEqual(shown.state === "ready" && shown.symbols.map((one) => one.name), ["fromB"]);

  // Edits refresh once, after the pause.
  store.refresh("/b.ts");
  store.refresh("/b.ts");
  store.refresh("/a.ts");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(asked, ["/a.ts", "/b.ts", "/b.ts"]);
  answers.get("/b.ts")!(null);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(store.get().state, "none");

  store.show(null);
  assert.deepEqual(store.get(), { state: "none", key: null, message: "No editor is open." });
  store.dispose();
});
