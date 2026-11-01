import assert from "node:assert/strict";
import test from "node:test";
import { flattenSymbols, symbolKindName } from "./symbols.ts";

const range = (line: number) => ({ start: { line, character: 0 }, end: { line, character: 5 } });

test("a symbol tree is listed depth first, each with what contains it", () => {
  const listed = flattenSymbols([
    {
      name: "Outer",
      kind: 5,
      range: range(0),
      selectionRange: range(0),
      children: [
        {
          name: "method",
          kind: 6,
          range: range(1),
          selectionRange: range(1),
          children: [{ name: "inner", kind: 13, range: range(2), selectionRange: range(2) }],
        },
      ],
    },
    { name: "top", kind: 12, range: range(5), selectionRange: range(5) },
  ]);
  assert.deepEqual(
    listed.map((one) => [one.name, one.detail]),
    [
      ["Outer", "class"],
      ["method", "method · Outer"],
      ["inner", "variable · Outer.method"],
      ["top", "function"],
    ],
  );
  assert.deepEqual(listed[2].range, range(2));
});

test("flat symbol information keeps its file and container", () => {
  const [one] = flattenSymbols([
    {
      name: "helper",
      kind: 12,
      containerName: "utils",
      location: { uri: "file:///c%3A/w/utils.ts", range: range(3) },
    },
  ]);
  assert.deepEqual(one, {
    name: "helper",
    kind: 12,
    detail: "function · utils",
    path: "C:/w/utils.ts",
    range: range(3),
  });
  assert.equal(symbolKindName(26), "type parameter");
  assert.equal(symbolKindName(99), "symbol");
});
