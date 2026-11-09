/**
 * WS21 (Developer Ecosystem): the author SDK and the shipped sample extensions.
 *
 * Two guarantees:
 *  1. The distributed author typings (`extensions/yavin.d.ts`) are in lock-step with the real
 *     API contract (`api.ts`). The typings are generated from api.ts by `authorTypings`, so the
 *     committed file must equal a fresh generation; any edit to api.ts that is not reflected in
 *     the typings fails here instead of silently shipping stale types to authors.
 *  2. Every sample extension Yavin ships validates against the SAME `readManifest` the installer
 *     and discovery use -- the samples are real, loadable extensions, not decorative fixtures.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { authorTypings, AUTHOR_MODULE } from "./authoringTypings.ts";
import { EXTENSION_API, readManifest } from "./manifest.ts";

const here = import.meta.dirname;
const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (relFromHere: string) => readFileSync(`${here}/${relFromHere}`, "utf8");
const readRoot = (relFromRoot: string) => readFileSync(`${root}/${relFromRoot}`, "utf8");

test("the author typings are generated from api.ts and have not drifted", () => {
  const api = read("api.ts");
  const committed = readRoot("extensions/yavin.d.ts");
  const expected = authorTypings(api, EXTENSION_API);
  assert.equal(
    committed,
    expected,
    "extensions/yavin.d.ts is stale -- regenerate it from api.ts (authorTypings).",
  );
});

test("the author typings expose the whole author contract and name the current API version", () => {
  const dts = readRoot("extensions/yavin.d.ts");
  assert.ok(dts.includes(`declare module "${AUTHOR_MODULE}"`), "declares the yavin module");
  assert.ok(dts.includes(`Yavin Extension API ${EXTENSION_API}`), "names the API version");
  // The public surface an author builds against, each as an exported declaration.
  for (const name of [
    "YavinApi",
    "ExtensionContext",
    "ExtensionModule",
    "Document",
    "Range",
    "Memento",
    "SecretStorage",
    "Disposable",
    "ViewItem",
    "Decoration",
    "CompletionItem",
    "Hover",
    "Location",
    "DocumentSymbol",
  ])
    assert.ok(dts.includes(`export interface ${name}`), `typings declare ${name}`);
  // The typings describe only what exists: no capability the host does not broker leaks in.
  for (const forbidden of ["child_process", "require(", "writeFile", "deleteFile", "process.env"])
    assert.ok(!dts.includes(forbidden), `typings do not mention ${forbidden}`);
});

const SAMPLE_MANIFESTS = [
  "extensions/catalog/hello-world-2.0.0",
  "extensions/catalog/hello-world-2.1.0",
  "extensions/catalog/hello-world-2.1.1",
  "extensions/catalog/todo-highlighter",
  "extensions/catalog/todo-highlighter-1.0.1",
  "extensions/catalog/word-count",
  "extensions/catalog/word-count-1.0.1",
  "extensions/samples/hello-world",
];

for (const dir of SAMPLE_MANIFESTS)
  test(`the shipped sample ${dir} validates against the real manifest reader`, () => {
    const raw = JSON.parse(readRoot(`${dir}/yavin-extension.json`));
    const result = readManifest(raw);
    assert.ok(
      result.ok,
      `readManifest rejected ${dir}: ${JSON.stringify((result as { problems?: unknown }).problems)}`,
    );
    const manifest = result.manifest;
    // Identity is well-formed and the engine range is one this Yavin can satisfy (it loaded).
    assert.equal(manifest.id, `${manifest.publisher}.${manifest.name}`);
    assert.ok(manifest.version.length > 0, "has a version");
    // A sample with code declares the API it needs (enforced by the reader; asserted for intent).
    if (manifest.main) assert.ok(manifest.engine, `${dir} with code declares engines.yavin`);
  });
