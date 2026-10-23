/**
 * EXT-25: TextMate grammars and language configuration -- data from extensions, applied within
 * bounds. The grammars here are written for the test; the benchmark runs real ones
 * (`scripts/openvsx-benchmark.mjs`).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTokenizer, parsePlist, SCOPE_TOKENS, DOCUMENT_MS } from "./textmate.ts";
import { languageConfigurationFrom, nestedQuantifier, patternOf } from "./languageConfiguration.ts";

const GRAMMAR = JSON.stringify({
  scopeName: "source.demo",
  patterns: [
    { match: "//.*$", name: "comment.line.double-slash.demo" },
    { match: "\\b(fun|val)\\b", name: "keyword.control.demo" },
    { begin: '"', end: '"', name: "string.quoted.double.demo" },
    { match: "\\b\\d+\\b", name: "constant.numeric.demo" },
    { match: "(?<=fun )\\w+", name: "entity.name.function.demo" },
  ],
});

const tokensOf = (line: number[]) => {
  const out: [number, number, string][] = [];
  for (let i = 0; i < line.length; i += 3)
    out.push([line[i], line[i + 1], SCOPE_TOKENS[line[i + 2]]]);
  return out;
};

test("a grammar's tokens are the editor's tokens for their scopes", () => {
  const tokenizer = createTokenizer([
    { scopeName: "source.demo", path: "demo.tmLanguage.json", text: GRAMMAR },
  ]);
  assert.deepEqual(tokenizer.problems, []);
  const { lines, partial } = tokenizer.tokenize(
    "source.demo",
    'fun main() // hi\nval x = "a\nb" + 42',
  );
  assert.equal(partial, false);
  assert.deepEqual(tokensOf(lines[0]), [
    [0, 3, "keyword"],
    [4, 4, "function"],
    [11, 5, "comment"],
  ]);
  // A string spanning lines carries its state to the next line.
  assert.deepEqual(
    tokensOf(lines[1]).map((t) => t[2]),
    ["keyword", "string"],
  );
  assert.deepEqual(tokensOf(lines[2]), [
    [0, 2, "string"],
    [5, 2, "number"],
  ]);
});

test("property-list grammars (.tmLanguage) are read; a broken grammar is said, not fatal", () => {
  const plist = `<?xml version="1.0"?><!DOCTYPE plist><plist version="1.0"><dict>
    <key>scopeName</key><string>source.p</string>
    <key>patterns</key><array><dict><key>match</key><string>&lt;\\w+&gt;</string><key>name</key><string>entity.name.tag.p</string></dict></array>
  </dict></plist>`;
  assert.deepEqual(parsePlist(plist), {
    scopeName: "source.p",
    patterns: [{ match: "<\\w+>", name: "entity.name.tag.p" }],
  });
  const tokenizer = createTokenizer([
    { scopeName: "source.p", path: "p.tmLanguage", text: plist },
    { scopeName: "source.bad", path: "bad.json", text: "{ not json" },
  ]);
  assert.equal(tokenizer.problems.length, 1);
  assert.match(tokenizer.problems[0], /source\.bad/);
  assert.deepEqual(tokensOf(tokenizer.tokenize("source.p", "a <b> c").lines[0]), [[2, 3, "tag"]]);
  assert.throws(() => tokenizer.tokenize("source.bad", "x"), /no grammar/i);
});

test("tokenizing is bounded: an endless document stops at the time limit, partial", () => {
  const tokenizer = createTokenizer([
    { scopeName: "source.demo", path: "demo.json", text: GRAMMAR },
  ]);
  let clock = 0;
  const slow = createTokenizer(
    [{ scopeName: "source.demo", path: "demo.json", text: GRAMMAR }],
    () => (clock += 100),
  );
  const text = Array.from({ length: 1000 }, () => "fun f 1").join("\n");
  const fast = tokenizer.tokenize("source.demo", text);
  assert.equal(fast.lines.length, 1000);
  const cut = slow.tokenize("source.demo", text);
  assert.equal(cut.partial, true);
  assert.ok(cut.lines.length <= DOCUMENT_MS / 100 + 1, String(cut.lines.length));
  // A line longer than the limit is left plain.
  const long = tokenizer.tokenize("source.demo", "fun " + "x".repeat(6000));
  assert.deepEqual(long.lines[0], []);
  assert.equal(long.partial, true);
});

test("language configuration: the editor's shape; risky or broken patterns are left out and said", () => {
  const { config, problems } = languageConfigurationFrom({
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [["{", "}"], ["(", ")"], ["bad"]],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: '"', close: '"', notIn: ["string"] },
      ["[", "]"],
    ],
    surroundingPairs: [["(", ")"]],
    folding: { markers: { start: "^\\s*//#region", end: "^\\s*//#endregion" } },
    wordPattern: "(-?\\d*\\.\\d\\w*)|([^\\s]+)",
    indentationRules: { increaseIndentPattern: "^.*\\{[^}]*$", decreaseIndentPattern: "^\\s*\\}" },
    onEnterRules: [
      {
        beforeText: "^\\s*/\\*\\*(?!/)([^*]|\\*(?!/))*$",
        action: { indent: "indentOutdent", appendText: " * " },
      },
      { beforeText: "(a+)+$", action: { indent: "indent" } },
      { beforeText: "x", action: { indent: "sideways" } },
    ],
  });
  assert.deepEqual(config.comments, { lineComment: "//", blockComment: ["/*", "*/"] });
  assert.deepEqual(config.brackets, [
    ["{", "}"],
    ["(", ")"],
  ]);
  assert.deepEqual(config.autoClosingPairs, [
    { open: "{", close: "}" },
    { open: '"', close: '"', notIn: ["string"] },
    { open: "[", close: "]" },
  ]);
  assert.ok(config.folding?.markers?.start.test("  //#region x"));
  assert.ok(config.wordPattern?.global, "the word pattern is global, as the editor needs");
  assert.ok(config.indentationRules?.increaseIndentPattern.test("if (x) {"));
  assert.equal(config.onEnterRules?.length, 1);
  assert.equal(config.onEnterRules?.[0].action.indentAction, 2);
  assert.equal(problems.length, 2, problems.join("; "));
  assert.match(problems.join("; "), /repetition of a repetition/);
});

test("nested unbounded repetition is refused; bounded and simple ones are not", () => {
  for (const risky of ["(a+)+", "(\\w*\\s?)*", "((ab)*c)+", "(x{2,})*", "(?:a|b+)+"])
    assert.ok(nestedQuantifier(risky), risky);
  for (const fine of [
    "(a+)?",
    "(ab)+",
    "[(+]+",
    "\\(a+\\)+",
    "(a{1,3})+",
    "^\\s*\\}",
    "(-?\\d*\\.\\d\\w*)|([^\\s]+)",
  ])
    assert.ok(!nestedQuantifier(fine), fine);
  assert.equal(typeof patternOf("("), "string");
  assert.equal(typeof patternOf("x".repeat(1001)), "string");
  assert.ok(patternOf({ pattern: "a", flags: "ig" }) instanceof RegExp);
});
