import assert from "node:assert/strict";
import test from "node:test";
import { createSettingsRegistry } from "../settings/settings.ts";
import { EDITOR_SETTINGS, resolveEditorSettings } from "../../editor/editorSettings.ts";
import { editorThemes } from "../../editor/themes.ts";
import {
  createDeclarativeContributions,
  parseJsonc,
  snippetsFrom,
  themeFrom,
  type ResourceReader,
} from "./declarative.ts";
import { readManifest } from "./manifest.ts";
import { createExtensionRegistry } from "./registry.ts";

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test("JSONC: comments and trailing commas are dropped, strings are left exactly as they are", () => {
  assert.deepEqual(
    parseJsonc(`{
      // a comment
      "a": "x // not a comment, ]", /* block */
      "b": [1, 2,],
      "c": "/* not one either */",
    }`),
    { a: "x // not a comment, ]", b: [1, 2], c: "/* not one either */" },
  );
  assert.throws(() => parseJsonc("{ not json"));
});

test("a VS Code theme maps to the editor: editor colours kept, workbench colours and unknown scopes reported", () => {
  const mapped = themeFrom({
    colors: {
      "editor.background": "#282A36",
      "editorCursor.foreground": "#f8f8f2",
      "editorLineNumber.foreground": "#abc",
      "activityBar.background": "#000000",
      "terminal.ansiRed": "#ff5555",
      "editor.foreground": "red",
    },
    tokenColors: [
      { settings: { foreground: "#F8F8F2", background: "#282A36" } },
      { scope: "keyword.control", settings: { foreground: "#FF79C6" } },
      { scope: "keyword", settings: { foreground: "#111111" } },
      {
        scope: ["comment", "punctuation.definition.comment"],
        settings: { foreground: "#6272A4", fontStyle: "italic" },
      },
      { scope: "string, string.quoted", settings: { foreground: "#F1FA8C" } },
      { scope: "source.js entity.name.function", settings: { foreground: "#50FA7B" } },
      { scope: "markup.heading", settings: { foreground: "#BD93F9" } },
      {
        scope: "constant.numeric",
        settings: { foreground: "#BD93F9", fontStyle: "bold underline" },
      },
      { scope: "string.regexp", settings: { foreground: "#FF5555" } },
      { scope: "comment", settings: { foreground: "#222222" } },
      { scope: "invalid.illegal", settings: { foreground: "nope" } },
    ],
    semanticTokenColors: {
      function: "#50FA7B",
      "variable.readonly": "#ffffff",
      unknownType: "#000",
    },
  });
  assert.deepEqual(mapped.colors, {
    "editor.background": "#282A36",
    "editorCursor.foreground": "#f8f8f2",
    "editorLineNumber.foreground": "#aabbcc",
  });
  const rule = (token: string) => mapped.rules.find((one) => one.token === token);
  assert.deepEqual(rule(""), { token: "", foreground: "F8F8F2", background: "282A36" });
  // The most specific scope wins whatever its order (keyword.control over keyword)...
  assert.equal(rule("keyword")?.foreground, "FF79C6");
  // ...and on a tie, the later rule (TextMate's order).
  assert.equal(rule("comment")?.foreground, "222222");
  assert.equal(rule("string")?.foreground, "F1FA8C");
  assert.equal(
    rule("function")?.foreground,
    "50FA7B",
    "a descendant selector colours its last scope; semantic too",
  );
  assert.deepEqual(rule("number"), {
    token: "number",
    foreground: "BD93F9",
    fontStyle: "bold underline",
  });
  assert.equal(rule("regexp")?.foreground, "FF5555");
  assert.equal(rule("invalid"), undefined, "an invalid colour applies nothing");
  for (const key of [
    "activityBar.background",
    "terminal.ansiRed",
    "editor.foreground",
    "markup.heading",
    "semanticTokenColors.variable.readonly",
    "semanticTokenColors.unknownType",
  ])
    assert.ok(mapped.unmapped.includes(key), key);
  assert.ok(themeFrom({ tokenColors: "./dracula.tmTheme" }).unmapped[0].includes("TextMate"));
  assert.deepEqual(themeFrom("not an object"), { rules: [], colors: {}, unmapped: [] });
});

test("snippets: prefixes, bodies, descriptions; malformed entries reported, never applied", () => {
  const { snippets, problems } = snippetsFrom(
    {
      Log: { prefix: ["log", "clg"], body: ["console.log($1);", "$0"], description: "Log it" },
      Plain: { prefix: "todo", body: "// TODO: $1" },
      NoPrefix: { body: "x" },
      BadBody: { prefix: "bad", body: [1, 2] },
      Empty: { prefix: "e", body: "" },
    },
    "acme.snippets",
    "javascript",
  );
  assert.deepEqual(
    snippets.map((one) => [one.prefix, one.body, one.description]),
    [
      ["log", "console.log($1);\n$0", "Log it"],
      ["clg", "console.log($1);\n$0", "Log it"],
      ["todo", "// TODO: $1", null],
    ],
  );
  assert.ok(
    snippets.every((one) => one.language === "javascript" && one.extensionId === "acme.snippets"),
  );
  assert.equal(problems.length, 3);
  assert.deepEqual(snippetsFrom([], "a.b", "x").problems, [
    "The snippets file is not a JSON object.",
  ]);
});

test("manifests: themes and snippets are checked; a VS Code report is data, and has no code", () => {
  const base = { publisher: "acme", name: "theme", version: "1.0.0", engines: { yavin: "^2.0.0" } };
  const ok = readManifest({
    ...base,
    contributes: {
      themes: [{ label: "Acme Dark", uiTheme: "vs-dark", path: "extension/theme/dark.json" }],
      snippets: [{ language: "javascript", path: "extension/snippets/js.json" }],
    },
  });
  assert.ok(ok.ok);
  if (ok.ok) assert.deepEqual(ok.manifest.contributes.themes[0].uiTheme, "vs-dark");
  for (const [contributes, field] of [
    [{ themes: [{ label: "x", uiTheme: "vs", path: "../escape.json" }] }, "path"],
    [{ themes: [{ label: "x", uiTheme: "vs", path: "C:/x.json" }] }, "path"],
    [{ themes: [{ label: "x", uiTheme: "vs", path: "a\\b.json" }] }, "path"],
    [{ themes: [{ label: "x", uiTheme: "solarized", path: "a.json" }] }, "uiTheme"],
    [{ themes: [{ uiTheme: "vs", path: "a.json" }] }, "label"],
    [
      {
        themes: [
          { label: "x", uiTheme: "vs", path: "a.json" },
          { label: "x", uiTheme: "vs", path: "b.json" },
        ],
      },
      "twice",
    ],
    [{ snippets: [{ language: "../js", path: "a.json" }] }, "language"],
  ] as const) {
    const result = readManifest({ ...base, contributes });
    assert.equal(result.ok, false, JSON.stringify(contributes));
    if (!result.ok)
      assert.ok(
        result.problems.some((p) => `${p.field} ${p.message}`.includes(field)),
        JSON.stringify(result.problems),
      );
  }
  const report = {
    publisher: "Dracula-Theme",
    name: "theme-dracula",
    vscode: "^1.13.0",
    code: false,
    supported: ['Colour theme "Dracula"'],
    ignored: [],
    rejected: [],
    signature: "not verified",
  };
  const adapted = readManifest({ ...base, vsix: report });
  assert.ok(adapted.ok && adapted.manifest.vsix?.publisher === "Dracula-Theme");
  assert.equal(readManifest({ ...base, vsix: { ...report, signature: "verified" } }).ok, false);
  assert.equal(readManifest({ ...base, vsix: { ...report, supported: "all" } }).ok, false);
  assert.equal(readManifest({ ...base, main: "out/x.js", vsix: report }).ok, false, "never code");
});

/** A registry with extensions contributing themes and snippets, read from `files`. */
function setup(files: Record<string, string>) {
  const settings = createSettingsRegistry([], memoryStorage());
  const registry = createExtensionRegistry({ settings, storage: memoryStorage() });
  const reads: string[] = [];
  const read: ResourceReader = async (id, path) => {
    reads.push(`${id}:${path}`);
    const text = files[`${id}:${path}`];
    if (text === undefined) throw new Error(`LoadFailed: ${path} does not exist in the extension.`);
    return text;
  };
  const store = createDeclarativeContributions({ registry, read });
  const add = (publisher: string, contributes: object) =>
    registry.add(
      { publisher, name: "pack", version: "1.0.0", engines: { yavin: "^2.0.0" }, contributes },
      { kind: "folder", path: `/x/${publisher}` },
      `/x/${publisher}`,
    );
  return { registry, store, add, reads };
}

test("the store applies enabled extensions' themes and snippets, deterministically, and drops them on disable and uninstall", async () => {
  const t = setup({
    "zeta.pack:theme.json": JSON.stringify({
      include: "./base.json",
      colors: { "editor.background": "#000000" },
    }),
    "zeta.pack:base.json": JSON.stringify({
      colors: { "editor.foreground": "#ffffff", "editor.background": "#111111" },
      tokenColors: [{ scope: "comment", settings: { foreground: "#00ff00" } }],
    }),
    "alpha.pack:theme.json": '{ // JSONC\n "colors": {}, }',
    "alpha.pack:js.json": JSON.stringify({ Log: { prefix: "log", body: "console.log($1);" } }),
    "alpha.pack:escape.json": JSON.stringify({ include: "../../../outside.json" }),
  });
  t.add("zeta", { themes: [{ label: "Night", uiTheme: "vs-dark", path: "theme.json" }] });
  t.add("alpha", {
    themes: [
      { label: "Night", uiTheme: "vs", path: "theme.json" },
      { label: "Escape", uiTheme: "vs", path: "escape.json" },
      { label: "Missing", uiTheme: "vs", path: "missing.json" },
    ],
    snippets: [{ language: "javascript", path: "js.json" }],
  });
  await settle();
  const snapshot = t.store.getSnapshot();
  assert.equal(snapshot.loading, false);
  // By extension id, then as listed; one label shared by two extensions is told apart.
  assert.deepEqual(
    snapshot.themes.map((one) => [one.id, one.label, one.base]),
    [
      ["ext:alpha.pack:0", "Night (alpha.pack)", "vs"],
      ["ext:zeta.pack:0", "Night (zeta.pack)", "vs-dark"],
    ],
  );
  // `include` merged, the including file's colours winning.
  const zeta = snapshot.themes[1];
  assert.deepEqual(zeta.colors, { "editor.foreground": "#ffffff", "editor.background": "#000000" });
  assert.equal(zeta.rules[0].foreground, "00ff00");
  assert.deepEqual(
    snapshot.snippets.map((one) => [one.extensionId, one.prefix]),
    [["alpha.pack", "log"]],
  );
  const problems = snapshot.problems["alpha.pack"].join("\n");
  assert.match(problems, /Escape.*outside the extension/);
  assert.match(problems, /Missing.*could not be read/);
  assert.ok(
    !t.reads.some((one) => one.includes("outside")),
    "an include outside the extension is never read",
  );

  t.registry.setEnabled("alpha.pack", false);
  await settle();
  assert.deepEqual(
    t.store.getSnapshot().themes.map((one) => [one.id, one.label]),
    [["ext:zeta.pack:0", "Night"]],
  );
  assert.deepEqual(t.store.getSnapshot().snippets, []);
  // Enabled again: back, with its snippets (EXT-05: one lifecycle for runtime and declarative).
  t.registry.setEnabled("alpha.pack", true);
  await settle();
  assert.equal(t.store.getSnapshot().themes.length, 2);
  assert.deepEqual(
    t.store.getSnapshot().snippets.map((one) => one.prefix),
    ["log"],
  );
  t.registry.remove("zeta.pack", { forget: true });
  await settle();
  // Uninstalled: its theme is gone; the other extension's, alone now, needs no suffix.
  assert.deepEqual(
    t.store.getSnapshot().themes.map((one) => [one.id, one.label]),
    [["ext:alpha.pack:0", "Night"]],
  );
  t.store.dispose();
});

test("the editor theme setting offers extensions' themes and falls back to Yavin Dark when one is gone", () => {
  const settings = createSettingsRegistry([EDITOR_SETTINGS.theme], memoryStorage());
  assert.equal(EDITOR_SETTINGS.theme.parse("ext:acme.pack:0"), "ext:acme.pack:0");
  assert.equal(EDITOR_SETTINGS.theme.parse("ext:../x:0"), undefined);
  assert.equal(EDITOR_SETTINGS.theme.parse("solarized"), undefined);
  editorThemes.setContributed([{ id: "ext:acme.pack:0", label: "Acme Night" }]);
  const options = () =>
    EDITOR_SETTINGS.theme.control.kind === "enum"
      ? EDITOR_SETTINGS.theme.control.options.map((o) => o.label)
      : [];
  assert.deepEqual(options(), ["Yavin Dark", "Yavin Light", "Acme Night"]);
  settings.set(EDITOR_SETTINGS.theme, "user", "ext:acme.pack:0");
  assert.equal(resolveEditorSettings(settings, null).settings.theme, "ext:acme.pack:0");
  // Its extension disabled: Yavin Dark, and the choice kept for when it comes back.
  editorThemes.setContributed([]);
  assert.equal(resolveEditorSettings(settings, null).settings.theme, "yavin-dark");
  assert.equal(settings.get(EDITOR_SETTINGS.theme, null), "ext:acme.pack:0");
  assert.deepEqual(options(), ["Yavin Dark", "Yavin Light"]);
});

test("EXT-08 an update with the same theme and snippet paths is read again; rollback, disable and uninstall follow the copy", async () => {
  const files: Record<string, string> = {
    "acme.pack:theme.json": JSON.stringify({ colors: { "editor.background": "#111111" } }),
    "acme.pack:js.json": JSON.stringify({ Log: { prefix: "log1", body: "one" } }),
    "other.pack:theme.json": JSON.stringify({ colors: { "editor.background": "#222222" } }),
  };
  const t = setup(files);
  const contributes = {
    themes: [{ label: "Acme", uiTheme: "vs-dark", path: "theme.json" }],
    snippets: [{ language: "javascript", path: "js.json" }],
  };
  t.add("acme", contributes);
  t.add("other", { themes: [{ label: "Other", uiTheme: "vs", path: "theme.json" }] });
  await settle();
  const background = () =>
    t.store.getSnapshot().themes.find((one) => one.extensionId === "acme.pack")?.colors[
      "editor.background"
    ];
  const prefixes = () => t.store.getSnapshot().snippets.map((one) => one.prefix);
  assert.equal(background(), "#111111");
  assert.deepEqual(prefixes(), ["log1"]);

  // Version 2, the same paths, other content, in its own copy (an update).
  files["acme.pack:theme.json"] = JSON.stringify({ colors: { "editor.background": "#999999" } });
  files["acme.pack:js.json"] = JSON.stringify({ Log: { prefix: "log2", body: "two" } });
  const reads = t.reads.length;
  const manifest = (version: string) => ({
    publisher: "acme",
    name: "pack",
    version,
    engines: { yavin: "^2.0.0" },
    contributes,
  });
  t.registry.replace(
    "acme.pack",
    manifest("2.0.0"),
    { kind: "folder", path: "/x/acme-2" },
    "/x/acme-2",
  );
  await settle();
  assert.equal(background(), "#999999", "the new copy's theme");
  assert.deepEqual(prefixes(), ["log2"], "the new copy's snippets");
  assert.ok(
    t.reads.slice(reads).every((one) => one.startsWith("acme.pack:")),
    `only the updated extension is read again: ${t.reads.slice(reads)}`,
  );
  // The theme id is kept: the user's choice still names it.
  assert.equal(
    t.store.getSnapshot().themes.find((one) => one.extensionId === "acme.pack")?.id,
    "ext:acme.pack:0",
  );

  // Rolled back to the first copy: its content again.
  files["acme.pack:theme.json"] = JSON.stringify({ colors: { "editor.background": "#111111" } });
  files["acme.pack:js.json"] = JSON.stringify({ Log: { prefix: "log1", body: "one" } });
  t.registry.replace(
    "acme.pack",
    manifest("1.0.0"),
    { kind: "folder", path: "/x/acme" },
    "/x/acme",
  );
  await settle();
  assert.equal(background(), "#111111");
  assert.deepEqual(prefixes(), ["log1"]);

  // Reconciling again with nothing changed reads nothing and changes nothing.
  const before = t.reads.length;
  const snapshot = t.store.getSnapshot();
  t.registry.setEnabled("other.pack", true);
  t.registry.setGrants("acme.pack", { granted: [], previous: null });
  await settle();
  assert.equal(t.reads.length, before);
  assert.equal(t.store.getSnapshot(), snapshot);

  // Disabled, then uninstalled: gone, and the other extension's theme untouched.
  t.registry.setEnabled("acme.pack", false);
  await settle();
  assert.equal(background(), undefined);
  assert.deepEqual(prefixes(), []);
  t.registry.setEnabled("acme.pack", true);
  await settle();
  assert.equal(background(), "#111111");
  t.registry.remove("acme.pack", { forget: true });
  await settle();
  assert.deepEqual(
    t.store.getSnapshot().themes.map((one) => one.extensionId),
    ["other.pack"],
  );
  t.store.dispose();
});
