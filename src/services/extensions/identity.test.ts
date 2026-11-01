import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { canonicalId, isCanonicalId } from "./identity.ts";
import { readManifest } from "./manifest.ts";

const { cases } = JSON.parse(
  readFileSync(new URL("./identity.cases.json", import.meta.url), "utf8"),
) as { cases: { input: string; canonical: string | null }[] };

test("canonical identity: the same answers as the native rule, case by case", () => {
  assert.ok(cases.length > 20);
  for (const { input, canonical } of cases) {
    assert.equal(canonicalId(input), canonical, JSON.stringify(input));
    assert.equal(isCanonicalId(input), canonical === input, JSON.stringify(input));
  }
});

test("canonical identity: a manifest's id is the rule's, with no folding", () => {
  const manifest = (publisher: string, name: string) =>
    readManifest({ publisher, name, version: "1.0.0", engines: { yavin: "^2.0.0" } });
  for (const { input, canonical } of cases) {
    const dot = input.indexOf(".");
    if (dot < 0) continue;
    const read = manifest(input.slice(0, dot), input.slice(dot + 1));
    assert.equal(read.ok, canonical === input, JSON.stringify(input));
  }
});
