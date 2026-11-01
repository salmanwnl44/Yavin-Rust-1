// EXT-30: file icon themes -- the theme file read strictly, icons resolved as VS Code does,
// paths kept inside the package, SVG drawn only as an image, the setting and the store.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createIconThemes,
  EXTENSION_ICON_THEME,
  iconIdFor,
  iconThemeSetting,
  MAX_ICON_BYTES,
  parseIconTheme,
  resolveInside,
  svgImage,
  YAVIN_ICONS,
} from "./iconThemes.ts";
import type { RegistrySnapshot } from "./registry.ts";
import { readManifest } from "./manifest.ts";

const THEME_PATH = "extension/dist/icons.json";

/** A theme in the shape both real themes use (material-icon-theme, vscode-icons). */
const THEME = JSON.stringify({
  iconDefinitions: {
    file: { iconPath: "./../icons/file.svg" },
    folder: { iconPath: "./../icons/folder.svg" },
    "folder-open": { iconPath: "./../icons/folder-open.svg" },
    "folder-root": { iconPath: "./../icons/folder-root.svg" },
    "folder-src": { iconPath: "./../icons/folder-src.svg" },
    "folder-src-open": { iconPath: "./../icons/folder-src-open.svg" },
    typescript: { iconPath: "./../icons/typescript.svg" },
    "typescript-test": { iconPath: "./../icons/test-ts.svg" },
    "typescript-def": { iconPath: "./../icons/typescript-def.svg" },
    rust: { iconPath: "./../icons/rust.svg" },
    git: { iconPath: "./../icons/git.svg" },
    "git-light": { iconPath: "./../icons/git_light.svg" },
    font: { fontCharacter: "\\E001", fontColor: "#fff" },
    png: { iconPath: "./../icons/logo.png" },
    escape: { iconPath: "../../../outside.svg" },
    url: { iconPath: "https://example.com/x.svg" },
    empty: { iconPath: "" },
  },
  file: "file",
  folder: "folder",
  folderExpanded: "folder-open",
  rootFolder: "folder-root",
  fileExtensions: {
    ts: "typescript",
    "test.ts": "typescript-test",
    "D.TS": "typescript-def",
    rs: "png",
  },
  fileNames: { ".gitignore": "git", "Weird.Name": "typescript", missing: "nothing" },
  languageIds: { rust: "rust" },
  folderNames: { src: "folder-src" },
  folderNamesExpanded: { src: "folder-src-open" },
  light: { fileNames: { ".gitignore": "git-light" } },
  highContrast: { fileNames: {} },
  hidesExplorerArrows: true,
});

test("an icon theme file: its SVG icons, defaults and maps; what it cannot show is said", () => {
  const theme = parseIconTheme(THEME, THEME_PATH);
  assert.equal(
    theme.icons.get("git"),
    "extension/icons/git.svg",
    "resolved against the theme's folder",
  );
  assert.equal(theme.icons.size, 12, "SVG icons only");
  for (const left of ["font", "png", "escape", "url"])
    assert.equal(theme.icons.has(left), false, left);
  assert.equal(theme.file, "file");
  assert.equal(theme.folderExpanded, "folder-open");
  assert.equal(
    theme.fileExtensions.get("d.ts"),
    "typescript-def",
    "names are matched in lower case",
  );
  assert.equal(theme.fileNames.get("weird.name"), "typescript");
  assert.equal(theme.fileExtensions.has("rs"), false, "a name pointing at a PNG icon is not kept");
  assert.equal(theme.light?.fileNames.get(".gitignore"), "git-light");
  const said = theme.problems.join("\n");
  assert.match(said, /1 icons drawn with a font are not shown/);
  assert.match(said, /1 icons that are not SVG/);
  assert.match(said, /2 icons with a path outside the extension/);
  assert.match(said, /1 icon definitions have no path/);
  assert.match(said, /high-contrast variant is not applied/);
  assert.match(said, /fileNames: 1 names point at no shown icon/);
});

test("a malformed theme file is refused or left out, never guessed", () => {
  assert.throws(() => parseIconTheme("{ not json", THEME_PATH));
  assert.throws(() => parseIconTheme("[]", THEME_PATH), /not a JSON object/);
  assert.throws(() => parseIconTheme("{}", THEME_PATH), /no iconDefinitions/);
  const odd = parseIconTheme(
    JSON.stringify({
      iconDefinitions: { a: { iconPath: "a.svg" }, b: "not an object", c: null },
      file: "nope",
      fileNames: ["not", "a", "map"],
      fileExtensions: { x: 7 },
    }),
    THEME_PATH,
  );
  assert.equal(odd.icons.size, 1);
  assert.equal(odd.file, undefined);
  assert.match(odd.problems.join("\n"), /file names no icon that is shown/);
  assert.match(odd.problems.join("\n"), /fileNames is not a map/);
  // Comments are allowed, as in VS Code.
  const commented = parseIconTheme(
    '{ // a theme\n "iconDefinitions": { "f": { "iconPath": "f.svg" } }, /* default */ "file": "f" }',
    THEME_PATH,
  );
  assert.equal(commented.file, "f");
});

test("bounded: definitions and names past the limits are left out and said", () => {
  const definitions: Record<string, unknown> = {};
  for (let i = 0; i < 10_050; i++) definitions[`d${i}`] = { iconPath: `i/${i}.svg` };
  const names: Record<string, string> = {};
  for (let i = 0; i < 50_050; i++) names[`n${i}.x`] = "d1";
  const theme = parseIconTheme(
    JSON.stringify({ iconDefinitions: definitions, fileNames: names }),
    THEME_PATH,
  );
  assert.equal(theme.icons.size, 10_000);
  assert.equal(theme.fileNames.size, 50_000);
  assert.match(theme.problems.join("\n"), /More than 10000 icon definitions/);
  assert.match(theme.problems.join("\n"), /More than 50000 names/);
});

test("an icon's path stays inside the package: no URL, drive, absolute path or climbing out", () => {
  assert.equal(resolveInside(THEME_PATH, "./../icons/a.svg"), "extension/icons/a.svg");
  assert.equal(resolveInside(THEME_PATH, "../../icons/a.svg"), "icons/a.svg");
  assert.equal(resolveInside(THEME_PATH, "sub/./a.svg"), "extension/dist/sub/a.svg");
  for (const bad of [
    "../../../a.svg",
    "../../..",
    "https://example.com/a.svg",
    "data:image/svg+xml,<svg/>",
    "file:///C:/a.svg",
    "C:/Windows/a.svg",
    "c:a.svg",
    "/etc/a.svg",
    "..\\..\\a.svg",
    "a\u0000.svg",
    "a?.svg",
    "",
    "x".repeat(401),
  ])
    assert.equal(resolveInside(THEME_PATH, bad), null, bad);
});

test("icons are chosen as VS Code chooses them; the light variant first in a light editor", () => {
  const theme = parseIconTheme(THEME, THEME_PATH);
  const id = (name: string, more: Partial<Parameters<typeof iconIdFor>[1]> = {}) =>
    iconIdFor(theme, { name, isDir: false, ...more });
  assert.equal(id(".gitignore"), "git", "the whole name first");
  assert.equal(id("Weird.Name"), "typescript", "case-insensitively");
  assert.equal(id("app.test.ts"), "typescript-test", "the longest extension first");
  assert.equal(id("app.ts"), "typescript");
  assert.equal(id("types.d.ts"), "typescript-def");
  assert.equal(id("main.rs"), "rust", "by language when no extension matches");
  assert.equal(id("thing", { languageId: "rust" }), "rust", "the language given");
  assert.equal(id("notes.unknownext"), "file", "the default file");
  assert.equal(id(".gitignore", { light: true }), "git-light");
  assert.equal(id("app.ts", { light: true }), "typescript", "the light variant falls back");
  const dir = (name: string, more: Partial<Parameters<typeof iconIdFor>[1]> = {}) =>
    iconIdFor(theme, { name, isDir: true, ...more });
  assert.equal(dir("SRC"), "folder-src");
  assert.equal(dir("src", { expanded: true }), "folder-src-open");
  assert.equal(dir("docs"), "folder");
  assert.equal(dir("docs", { expanded: true }), "folder-open");
  assert.equal(dir("project", { isRoot: true }), "folder-root");
  assert.equal(
    dir("src", { isRoot: true }),
    "folder-src",
    "a root folder's name, then its default",
  );
  const bare = parseIconTheme(
    JSON.stringify({ iconDefinitions: { x: { iconPath: "x.svg" } } }),
    THEME_PATH,
  );
  assert.equal(iconIdFor(bare, { name: "a.ts", isDir: false }), null, "nothing: Yavin's own icon");
});

test("an SVG is drawn only as an image from its own text; anything else is not drawn", () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M0 0h16v16H0z"/></svg>';
  const url = svgImage(svg);
  assert.ok(url?.startsWith("data:image/svg+xml;charset=utf-8,%3Csvg"));
  assert.equal(decodeURIComponent(url!.split(",").slice(1).join(",")), svg);
  assert.ok(svgImage(`<?xml version="1.0"?>\n<!-- made by hand -->\n${svg}`));
  assert.ok(svgImage(`\uFEFF  ${svg}`));
  // Script in an SVG never runs in an image; it is still only ever an image URL.
  const scripted = svgImage('<svg><script>alert(1)</script><image href="https://x/y.png"/></svg>');
  assert.ok(scripted?.startsWith("data:image/svg+xml"));
  assert.ok(!scripted!.includes("<"), "encoded, not markup");
  for (const not of [
    "<html><svg/></html>",
    "PNG\u0089",
    "",
    "<svgfoo/>",
    `<svg>${"x".repeat(MAX_ICON_BYTES)}</svg>`,
  ])
    assert.equal(svgImage(not), null, not.slice(0, 20));
});

/** A registry of `themes`, which tests change. */
function fakeRegistry(themes: { extensionId: string; id: string; label: string; path: string }[]) {
  let current = themes;
  const listeners = new Set<() => void>();
  return {
    set(next: typeof themes) {
      current = next;
      for (const listener of listeners) listener();
    },
    getSnapshot: () =>
      ({
        iconThemes: current.map((one) => ({ ...one, copy: `${one.extensionId}@1` })),
      }) as unknown as RegistrySnapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the store: the chosen theme's icons are read once, on use; switching and disabling apply", async () => {
  const reads: string[] = [];
  const files: Record<string, string> = {
    "acme.icons extension/dist/icons.json": THEME,
    "acme.icons extension/icons/typescript.svg": "<svg><rect/></svg>",
    "acme.icons extension/icons/folder.svg": "<svg><circle/></svg>",
    "acme.icons extension/icons/file.svg": "not an svg",
  };
  const read = async (extensionId: string, path: string) => {
    reads.push(path);
    const text = files[`${extensionId} ${path}`];
    if (text === undefined) throw new Error(`${path} is not in the package`);
    return text;
  };
  const registry = fakeRegistry([
    { extensionId: "acme.icons", id: "acme", label: "Acme Icons", path: THEME_PATH },
    { extensionId: "other.icons", id: "acme", label: "Acme Icons", path: "t.json" },
  ]);
  const themes = createIconThemes();
  themes.follow(registry, read);
  assert.deepEqual(
    themes.list().map((one) => [one.id, one.label]),
    [
      ["ext:acme.icons:acme", "Acme Icons (acme.icons)"],
      ["ext:other.icons:acme", "Acme Icons (other.icons)"],
    ],
    "two themes of one label are told apart by their extension",
  );
  // Yavin's own icons until a theme is chosen: nothing is read.
  assert.equal(themes.image({ name: "a.ts", isDir: false }), null);
  assert.equal(reads.length, 0, "nothing read");
  let heard = 0;
  themes.subscribe(() => heard++);
  themes.select("ext:acme.icons:acme");
  await settle();
  assert.equal(themes.shown()?.id, "ext:acme.icons:acme");
  assert.deepEqual(reads, [THEME_PATH]);
  // An icon is read on first use, then drawn.
  assert.equal(themes.image({ name: "a.ts", isDir: false }), null, "not read yet");
  await settle();
  const ts = themes.image({ name: "b.ts", isDir: false });
  assert.ok(ts?.startsWith("data:image/svg+xml"));
  assert.equal(
    reads.filter((p) => p.endsWith("typescript.svg")).length,
    1,
    "read once for every .ts file",
  );
  // Not an SVG, or not in the package: Yavin's own icon, and not read again.
  themes.image({ name: "plain", isDir: false });
  themes.image({ name: ".gitignore", isDir: false });
  await settle();
  assert.equal(themes.image({ name: "plain", isDir: false }), null);
  assert.equal(themes.image({ name: ".gitignore", isDir: false }), null);
  themes.image({ name: ".gitignore", isDir: false });
  assert.equal(reads.filter((p) => p.endsWith("git.svg")).length, 1);
  assert.ok(heard > 0, "listeners heard each change");
  // The light variant: another icon for .gitignore.
  themes.setLight(true);
  themes.image({ name: ".gitignore", isDir: false });
  await settle();
  assert.equal(reads.filter((p) => p.endsWith("git_light.svg")).length, 1);
  themes.setLight(false);
  // Its extension disabled: Yavin's icons, the choice kept; enabled again: the theme again.
  const both = registry.getSnapshot().iconThemes;
  registry.set([]);
  assert.equal(themes.shown(), null);
  assert.equal(themes.image({ name: "b.ts", isDir: false }), null);
  registry.set(both.map(({ copy: _, ...one }) => one));
  await settle();
  assert.equal(themes.shown()?.id, "ext:acme.icons:acme");
  // Back to Yavin's.
  themes.select(YAVIN_ICONS);
  assert.equal(themes.shown(), null);
  assert.equal(themes.image({ name: "b.ts", isDir: false }), null);
});

test("a theme file that cannot be read or parsed shows Yavin's icons and says why", async () => {
  const themes = createIconThemes();
  themes.follow(
    fakeRegistry([
      { extensionId: "acme.broken", id: "broken", label: "Broken", path: "t.json" },
      { extensionId: "acme.gone", id: "gone", label: "Gone", path: "g.json" },
    ]),
    async (_, path) => {
      if (path === "t.json") return "{ this is not json";
      throw new Error("NotFound: g.json");
    },
  );
  themes.select("ext:acme.broken:broken");
  await settle();
  assert.equal(themes.shown(), null);
  assert.match(themes.problems()["ext:acme.broken:broken"][0], /could not be read/);
  themes.select("ext:acme.gone:gone");
  await settle();
  assert.equal(themes.shown(), null);
  assert.match(themes.problems()["ext:acme.gone:gone"][0], /NotFound/);
});

test("the setting: Yavin's icons or an extension's theme, offered while it is enabled", () => {
  const themes = createIconThemes();
  themes.follow(
    fakeRegistry([
      { extensionId: "acme.icons", id: "acme", label: "Acme Icons", path: THEME_PATH },
    ]),
    async () => THEME,
  );
  const setting = iconThemeSetting(themes);
  assert.equal(setting.id, "explorer.iconTheme");
  assert.equal(setting.default, YAVIN_ICONS);
  assert.deepEqual(setting.scopes, ["user"]);
  assert.equal(setting.parse("yavin"), "yavin");
  assert.equal(setting.parse("ext:acme.icons:acme"), "ext:acme.icons:acme");
  assert.equal(
    setting.parse("ext:gone.later:theme"),
    "ext:gone.later:theme",
    "kept for its return",
  );
  for (const bad of ["", "material", "ext:Acme:x", "ext:a:b", "ext:acme.icons:", 7, null])
    assert.equal(setting.parse(bad), undefined, String(bad));
  const control = setting.control as unknown as { options: { value: string; label: string }[] };
  assert.deepEqual(
    control.options.map((one) => one.value),
    ["yavin", "ext:acme.icons:acme"],
  );
  assert.ok(EXTENSION_ICON_THEME.test("ext:pkief.material-icon-theme:material-icon-theme"));
});

test("a manifest's icon themes are checked: an id, a label, a JSON file inside it", () => {
  const manifest = (iconThemes: unknown) => ({
    manifestVersion: 1,
    publisher: "acme",
    name: "icons",
    version: "1.0.0",
    engines: { yavin: "^2.0.0" },
    contributes: { iconThemes },
  });
  const ok = readManifest(
    manifest([{ id: "acme", label: "Acme Icons", path: "extension/dist/icons.json" }]),
  );
  assert.equal(ok.ok, true, JSON.stringify(ok));
  if (ok.ok)
    assert.deepEqual(ok.manifest.contributes.iconThemes, [
      { id: "acme", label: "Acme Icons", path: "extension/dist/icons.json" },
    ]);
  for (const [bad, why] of [
    [{ id: "", label: "A", path: "a.json" }, /\.id/],
    [{ id: "a b", label: "A", path: "a.json" }, /\.id/],
    [{ id: "a", label: "", path: "a.json" }, /\.label/],
    [{ id: "a", label: "A", path: "../a.json" }, /\.path/],
    [{ id: "a", label: "A", path: "C:/a.json" }, /\.path/],
    [{ id: "a", label: "A", path: "a.svg" }, /\.path/],
  ] as const) {
    const result = readManifest(manifest([bad]));
    assert.equal(result.ok, false, JSON.stringify(bad));
    if (!result.ok)
      assert.ok(
        result.problems.some((e) => why.test(e.field)),
        JSON.stringify(result.problems),
      );
  }
  const twice = readManifest(
    manifest([
      { id: "a", label: "A", path: "a.json" },
      { id: "a", label: "B", path: "b.json" },
    ]),
  );
  assert.equal(twice.ok, false);
});

test("a registry change that leaves the icon themes as they were redraws no icon", () => {
  const themes = createIconThemes();
  const entry = { extensionId: "acme.icons", id: "acme", label: "Acme Icons", path: THEME_PATH };
  const registry = fakeRegistry([entry]);
  themes.follow(registry, async () => THEME);
  let heard = 0;
  themes.subscribe(() => heard++);
  registry.set([{ ...entry }]);
  assert.equal(heard, 0, "the same themes: nothing to redraw");
  registry.set([]);
  assert.equal(heard, 1, "a theme gone: heard");
});
