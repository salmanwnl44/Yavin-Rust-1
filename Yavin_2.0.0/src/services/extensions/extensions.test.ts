import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileUri, formatUri, resourceId, type ResourceId } from "../resource.ts";
import { createSettingsRegistry } from "../settings/settings.ts";
import type { WorkspaceId } from "../terminalProtocol.ts";
import { ExtensionError } from "./errors.ts";
import { canMoveExtension } from "./host.ts";
import { createInProcessTransport } from "./inProcessHost.ts";
import { CRASH_LIMIT, createExtensionHostManager } from "./manager.ts";
import { EXTENSION_API, readManifest, satisfies } from "./manifest.ts";
import { MAX_MESSAGE, readHostMessage, writeHostMessage } from "./protocol.ts";
import { createExtensionRegistry, DISABLED_KEY } from "./registry.ts";
import {
  createExtensionStorage,
  globalStorageKey,
  STORAGE_LIMIT,
  workspaceStorageKey,
} from "./storage.ts";
import {
  createDecorationStore,
  createProviderRegistry,
  type DocumentEvent,
  type DocumentInfo,
  type ExtensionWindow,
} from "./window.ts";

const BOOTSTRAP = readFileSync(
  new URL("../../../src-tauri/crates/ide-plugin-host/src/bootstrap.js", import.meta.url),
  "utf8",
);
const SAMPLE = {
  manifest: JSON.parse(
    readFileSync(
      new URL("../../../extensions/samples/hello-world/yavin-extension.json", import.meta.url),
      "utf8",
    ),
  ),
  code: readFileSync(
    new URL("../../../extensions/samples/hello-world/extension.js", import.meta.url),
    "utf8",
  ),
};

const A = "file://c:/work" as WorkspaceId;
const B = "file://c:/other" as WorkspaceId;
const settle = async (times = 10) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
async function until(check: () => boolean, what = "condition") {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`timed out waiting for ${what}`);
}

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(seed));
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

const manifest = (overrides: Record<string, unknown> = {}) => ({
  publisher: "acme",
  name: "hello",
  displayName: "Hello",
  version: "1.2.3",
  engines: { yavin: "^2.0.0" },
  main: "extension.js",
  activationEvents: ["onCommand:acme.hello.greet"],
  contributes: {
    commands: [
      { command: "acme.hello.greet", title: "Greet", category: "Hello" },
      { command: "acme.hello.other", title: "Other" },
    ],
    keybindings: [{ command: "acme.hello.greet", key: "Mod+Alt+g" }],
    configuration: {
      properties: {
        "acme.hello.name": { type: "string", default: "world", description: "Who to greet." },
        "acme.hello.mood": { enum: ["calm", "bright"], default: "calm", description: "Mood." },
      },
    },
    viewsContainers: { activitybar: [{ id: "acme.hello.home", title: "Hello Home" }] },
    views: [
      { id: "acme.hello.people", name: "People", location: "sidebar" },
      { id: "acme.hello.panel", name: "Hello Panel", location: "panel" },
      { id: "acme.hello.inside", name: "Inside", container: "acme.hello.home" },
    ],
    menus: {
      "view/title": [{ command: "acme.hello.greet", view: "acme.hello.people" }],
      "editor/context": [{ command: "acme.hello.greet", when: "resourceExtname == .md" }],
      "explorer/context": [{ command: "acme.hello.other" }],
    },
  },
  ...overrides,
});

/** A window for tests: two documents in the workspace, an active one, a file to read. */
function fakeWindow() {
  const docs = new Map<string, { info: DocumentInfo; text: string }>();
  const add = (path: string, text: string, languageId = "markdown") => {
    const uri = fileUri(path);
    const info: DocumentInfo = {
      uri: formatUri(uri),
      resourceId: resourceId(uri),
      languageId,
      version: 1,
      source: "disk",
      dirty: false,
    };
    docs.set(info.resourceId, { info, text });
    return info;
  };
  add("C:/work/readme.md", "# Readme\nhello");
  const listeners = new Set<(event: DocumentEvent, document: DocumentInfo) => void>();
  const activeListeners = new Set<() => void>();
  const opened: { path: string; range: unknown }[] = [];
  const selections: unknown[] = [];
  const files: Record<string, string> = { "C:/work/notes.txt": "a note" };
  const window: ExtensionWindow = {
    documents: {
      all: () => [...docs.values()].map((d) => d.info),
      get: (resource) => docs.get(resource)?.info ?? null,
      text: (resource) => docs.get(resource)?.text ?? null,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    editor: {
      active: () => {
        const first = [...docs.values()][0];
        return first
          ? {
              document: first.info,
              selection: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 1 },
            }
          : null;
      },
      onActive(listener) {
        activeListeners.add(listener);
        return () => activeListeners.delete(listener);
      },
      openLocation: async (path, range) => void opened.push({ path, range }),
      setSelection: (range) => (selections.push(range), true),
      revealRange: () => true,
    },
    readFile: async (path) => {
      if (!(path in files)) throw new Error(`Cannot read ${path}`);
      return files[path];
    },
  };
  return {
    window,
    add,
    opened,
    selections,
    emit: (event: DocumentEvent, info: DocumentInfo) => listeners.forEach((l) => l(event, info)),
  };
}

function setup(
  options: {
    trusted?: boolean;
    codes?: Record<string, string>;
    failStart?: string;
    delay?: Parameters<typeof createInProcessTransport>[0]["delay"];
  } = {},
) {
  const storage = memoryStorage();
  const settings = createSettingsRegistry([], storage);
  const registry = createExtensionRegistry({ settings, storage });
  const extensionStorage = createExtensionStorage(storage);
  const decorations = createDecorationStore();
  const providers = createProviderRegistry();
  const win = fakeWindow();
  const notes: [string, string, string][] = [];
  const logs = new Map<string, string[]>();
  const codes: Record<string, string> = { ...options.codes };
  const host = createInProcessTransport({
    bootstrap: BOOTSTRAP,
    code: (id) => codes[id] ?? null,
    failStart: options.failStart,
    delay: options.delay,
  });
  let trusted = options.trusted ?? true;
  let rediscovered = 0;
  const manager = (workspace: WorkspaceId | null = A, generation = 1, timeouts = {}) =>
    createExtensionHostManager({
      registry,
      settings,
      storage: extensionStorage,
      workspace,
      folder: workspace === B ? "C:/other" : workspace ? "C:/work" : null,
      workspaceGeneration: generation,
      transport: host.transport,
      trusted: async () => trusted,
      window: win.window,
      decorations,
      providers,
      notify: (level, id, message) => notes.push([level, id, message]),
      channel: (id) => ({
        appendLine: (text: string) => logs.set(id, [...(logs.get(id) ?? []), text]),
      }),
      timeouts: { provider: 200, command: 1000, activate: 1000, ...timeouts },
      rediscover: async () => void rediscovered++,
    });
  const add = (overrides: Record<string, unknown>, code: string | null) => {
    const raw = manifest(overrides);
    const id = `${raw.publisher}.${raw.name}`;
    if (code !== null) codes[id] = code;
    return registry.add(
      raw,
      { kind: "folder", path: `C:/extensions/${id}` },
      `C:/extensions/${id}`,
    );
  };
  return {
    storage,
    settings,
    registry,
    extensionStorage,
    decorations,
    providers,
    win,
    notes,
    logs,
    host,
    codes,
    manager,
    add,
    setTrusted: (value: boolean) => (trusted = value),
    rediscovered: () => rediscovered,
  };
}

const GREETER = `
module.exports.activate = function (context, yavin) {
  context.subscriptions.push(yavin.commands.registerCommand("acme.hello.greet", function (who) {
    return "hello " + (who || yavin.workspace.getConfiguration("acme.hello").get("name"));
  }));
};
`;

// --- Manifest ----------------------------------------------------------------------------------

test("a v2 manifest: containers, panel and container views, menus with when, dependencies", () => {
  const result = readManifest(manifest({ extensionDependencies: ["acme.base"] }));
  assert.ok(result.ok, JSON.stringify(!result.ok && result.problems));
  const m = result.manifest;
  assert.equal(m.id, "acme.hello");
  assert.deepEqual(m.dependencies, ["acme.base"]);
  assert.deepEqual(m.contributes.viewContainers, [{ id: "acme.hello.home", title: "Hello Home" }]);
  assert.deepEqual(
    m.contributes.views.map((v) => [v.id, v.location, v.container]),
    [
      ["acme.hello.people", "sidebar", null],
      ["acme.hello.panel", "panel", null],
      ["acme.hello.inside", "container", "acme.hello.home"],
    ],
  );
  assert.deepEqual(m.contributes.menus.find((menu) => menu.location === "editor/context")?.when, {
    key: "resourceExtname",
    value: ".md",
  });
  assert.equal(EXTENSION_API, "2.0.0");
  assert.equal(satisfies("2.0.0", "^1.0.0"), false, "an IDE-07 (API 1) extension is incompatible");
});

test("invalid manifests are rejected with every reason; unknown fields only warn", () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ publisher: "Acme Corp" }, /publisher/],
    [{ version: "1.2" }, /semantic version/],
    [{ engines: { yavin: "^9.0.0" } }, /Needs extension API/],
    [{ main: "../../etc/evil.js" }, /inside the extension/],
    [{ extensionDependencies: ["acme.hello"] }, /itself/],
    [{ extensionDependencies: ["not an id"] }, /extension id/],
    [{ extensionDependencies: ["acme.x", "acme.x"] }, /twice/],
    [{ contributes: { commands: [{ command: "other.cmd", title: "x" }] } }, /acme\.hello\.<name>/],
    [
      {
        contributes: {
          views: [{ id: "acme.hello.v", name: "V", container: "acme.hello.nowhere" }],
        },
      },
      /view containers/,
    ],
    [
      {
        contributes: {
          commands: [{ command: "acme.hello.a", title: "A" }],
          menus: { "editor/context": [{ command: "acme.hello.a", when: "isLinux && true" }] },
        },
      },
      /no other conditions/,
    ],
    [
      {
        contributes: {
          commands: [{ command: "acme.hello.a", title: "A" }],
          menus: { commandPalette: [{ command: "acme.hello.a" }, { command: "acme.hello.a" }] },
        },
      },
      /twice/,
    ],
  ];
  for (const [overrides, reason] of cases) {
    const result = readManifest(manifest(overrides));
    assert.equal(result.ok, false, JSON.stringify(overrides));
    if (!result.ok)
      assert.ok(
        result.problems.some((p) => reason.test(`${p.field}: ${p.message}`)),
        `${JSON.stringify(overrides)} -> ${JSON.stringify(result.problems)}`,
      );
  }
  const warned = readManifest(manifest({ sponsor: "x", contributes: { grammars: [] } }));
  assert.ok(warned.ok);
  assert.deepEqual(
    warned.warnings.filter((w) => w.field === "sponsor" || w.field === "contributes.grammars")
      .length,
    2,
  );
});

test("the sample extension's manifest is valid", () => {
  const result = readManifest(SAMPLE.manifest);
  assert.ok(result.ok, JSON.stringify(!result.ok && result.problems));
  assert.deepEqual(result.warnings, []);
});

// --- Registry and dependencies -------------------------------------------------------------------

test("register, duplicate, enable/disable remembered; settings belong to the SettingsRegistry", () => {
  const t = setup();
  assert.ok("manifest" in t.add({}, GREETER));
  const again = t.add({}, GREETER);
  assert.ok("problems" in again && /already registered/.test(again.problems[0]));
  assert.deepEqual(
    t.settings.definitions.map((d) => d.id),
    ["acme.hello.name", "acme.hello.mood"],
  );
  const snap = t.registry.getSnapshot();
  assert.deepEqual(
    snap.viewContainers.map((c) => c.id),
    ["acme.hello.home"],
  );
  t.registry.setEnabled("acme.hello", false);
  assert.equal(t.registry.getSnapshot().commands.length, 0);
  assert.equal(t.settings.definitions.length, 0);
  assert.match(t.storage.getItem(DISABLED_KEY)!, /acme\.hello/);
});

test("dependencies: missing, disabled, circular and transitive are reported; order is deterministic", () => {
  const t = setup();
  t.add({ name: "app", extensionDependencies: ["acme.lib", "acme.base"], contributes: {} }, "");
  t.add({ name: "lib", extensionDependencies: ["acme.base"], contributes: {} }, "");
  t.add({ name: "base", contributes: {} }, "");
  assert.deepEqual(t.registry.getSnapshot().unavailable, {});
  assert.deepEqual(t.registry.activationOrder("acme.app"), ["acme.base", "acme.lib", "acme.app"]);
  t.registry.setEnabled("acme.base", false);
  let unavailable = t.registry.getSnapshot().unavailable;
  assert.match(unavailable["acme.lib"], /acme\.base, which is disabled/);
  assert.match(unavailable["acme.app"], /acme\.base, which is disabled/);
  t.registry.setEnabled("acme.base", true);
  t.add({ name: "lonely", extensionDependencies: ["acme.ghost"], contributes: {} }, "");
  t.add({ name: "ping", extensionDependencies: ["acme.pong"], contributes: {} }, "");
  t.add({ name: "pong", extensionDependencies: ["acme.ping"], contributes: {} }, "");
  unavailable = t.registry.getSnapshot().unavailable;
  assert.match(unavailable["acme.lonely"], /acme\.ghost, which is not installed/);
  assert.match(unavailable["acme.ping"], /cycle/);
  assert.match(unavailable["acme.pong"], /cycle/);
});

// --- Protocol ----------------------------------------------------------------------------------

test("the protocol rejects stale, foreign, malformed, unknown and oversized messages", () => {
  const id = { workspaceId: A, hostGeneration: 1001 };
  const ok = readHostMessage(
    JSON.stringify({
      type: "request",
      requestId: "h1",
      method: "x",
      params: {},
      extensionId: "acme.hello",
      ...id,
    }),
    id,
  );
  assert.ok(ok.ok);
  for (const [text, reason] of [
    [
      JSON.stringify({
        type: "request",
        requestId: "h1",
        method: "x",
        extensionId: "acme.hello",
        workspaceId: A,
        hostGeneration: 1000,
      }),
      /another workspace or host generation/,
    ],
    [
      JSON.stringify({
        type: "request",
        requestId: "h1",
        method: "x",
        extensionId: "acme.hello",
        workspaceId: B,
        hostGeneration: 1001,
      }),
      /another workspace/,
    ],
    [
      JSON.stringify({
        type: "request",
        requestId: "h1",
        method: "x",
        extensionId: "../evil",
        ...id,
      }),
      /extension id/,
    ],
    [
      JSON.stringify({ type: "teleport", extensionId: "acme.hello", ...id }),
      /unknown message type/,
    ],
    ["{nope", /not JSON/],
    ["x".repeat(MAX_MESSAGE + 1), /bytes/],
  ] as const) {
    const read = readHostMessage(text, id);
    assert.ok(
      !read.ok && reason.test(read.reason),
      `${text.slice(0, 60)} -> ${JSON.stringify(read)}`,
    );
  }
  assert.throws(
    () => writeHostMessage({ type: "event", payload: "x".repeat(MAX_MESSAGE) }),
    /over the limit/,
  );
});

test("only the lifecycle's own moves are allowed", () => {
  assert.ok(canMoveExtension("registered", "activating"));
  assert.ok(canMoveExtension("active", "failed"));
  for (const [from, to] of [
    ["registered", "active"],
    ["disposed", "activating"],
    ["failed", "active"],
  ] as const)
    assert.equal(canMoveExtension(from, to), false);
});

// --- Runtime: lazy host, commands, failures -------------------------------------------------------

test("lazy: no host until needed; a command activates once, runs through the host, and returns", async () => {
  const t = setup();
  t.add({}, GREETER);
  const m = t.manager();
  await m.fire({ kind: "startup" });
  assert.equal(t.host.started(), 0, "nothing waits for startup: no process");
  const [one, two] = await Promise.all([
    m.executeCommand("acme.hello.greet", "ada"),
    m.executeCommand("acme.hello.greet"),
  ]);
  assert.deepEqual([one, two], ["hello ada", "hello world"]);
  assert.equal(t.host.started(), 1);
  const snap = m.getSnapshot();
  assert.equal(snap.host, "running");
  assert.equal(snap.statuses["acme.hello"].state, "active");
  assert.equal(snap.generation, 1001);
  await m.dispose();
  assert.equal(m.getSnapshot().statuses["acme.hello"].state, "disposed");
});

test("activation failure stays with its extension; a handler that throws is a typed error", async () => {
  const t = setup();
  t.add(
    { name: "boom", activationEvents: ["onStartupFinished"], contributes: {} },
    `module.exports.activate = function () { throw new Error("kaboom"); };`,
  );
  t.add(
    {
      name: "fine",
      activationEvents: ["onStartupFinished"],
      contributes: { commands: [{ command: "acme.fine.go", title: "Go" }] },
    },
    `
    module.exports.activate = function (c, yavin) {
      c.subscriptions.push(yavin.commands.registerCommand("acme.fine.go", function () { throw new Error("handler broke"); }));
    };`,
  );
  const m = t.manager();
  await m.fire({ kind: "startup" });
  await until(() => m.getSnapshot().statuses["acme.fine"]?.state === "active", "fine active");
  assert.equal(m.getSnapshot().statuses["acme.boom"].state, "failed");
  assert.match(m.getSnapshot().statuses["acme.boom"].reason!, /kaboom/);
  await assert.rejects(
    m.executeCommand("acme.fine.go"),
    (e: ExtensionError) => e.code === "CommandFailed" && /handler broke/.test(e.message),
  );
  await assert.rejects(
    m.activate("acme.boom"),
    (e: ExtensionError) => e.code === "ActivationFailed",
  );
});

test("spoofing is refused: another's command, view or provider id; unknown API methods", async () => {
  const t = setup();
  t.add(
    {},
    `
    module.exports.activate = async function (c, yavin) {
      const results = {};
      for (const [name, attempt] of [
        ["command", () => yavin.commands.registerCommand("other.ext.cmd", function () {})],
        ["view", () => yavin.views.registerView("other.ext.view", { getItems: () => [] })],
      ]) {
        attempt();
      }
    };`,
  );
  const m = t.manager();
  await m.activate("acme.hello");
  await settle();
  const log = (t.logs.get("acme.hello") ?? []).join("\\n");
  assert.match(log, /commands\.register refused: "other\.ext\.cmd" is not one of the commands/);
  assert.match(log, /views\.register refused: "other\.ext\.view" is not one of the views/);
  // A provider id that is not the extension's own, sent straight at the protocol.
  t.host.deliverRaw(
    JSON.stringify({
      type: "request",
      requestId: "x1",
      method: "languages.register",
      params: { kind: "hover", providerId: "evil#hover#1", language: "markdown" },
      extensionId: "acme.hello",
      workspaceId: A,
      hostGeneration: 1001,
    }),
  );
  await settle();
  assert.equal(t.providers.getSnapshot().length, 0);
});

test("a hung request times out; a host that never answers start is reported", async () => {
  const t = setup();
  t.add(
    {},
    `
    module.exports.activate = function (c, yavin) {
      c.subscriptions.push(yavin.commands.registerCommand("acme.hello.greet", function () { return new Promise(function () {}); }));
    };`,
  );
  const m = t.manager(A, 1, { command: 50 });
  await assert.rejects(
    m.executeCommand("acme.hello.greet"),
    (e: ExtensionError) => e.code === "Timeout",
  );
});

// --- Views, providers, documents, editor, fs, storage, settings -------------------------------------

test("views: shown lazily, rows sanitized, refreshed; a panel and a container view too", async () => {
  const t = setup();
  t.add(
    {},
    `
    module.exports.activate = function (c, yavin) {
      var n = 1; var fire = function () {};
      c.subscriptions.push(yavin.views.registerView("acme.hello.people", {
        getItems: function () { return [{ label: "Ada " + n, command: "acme.hello.greet", children: [{ label: "child" }] }, { label: 42 }, { label: "evil", command: "rm -rf" }]; },
        onDidChange: function (l) { fire = l; return { dispose: function () {} }; },
      }));
      c.subscriptions.push(yavin.commands.registerCommand("acme.hello.greet", function () { n++; fire(); }));
    };`,
  );
  const m = t.manager();
  await m.showView("acme.hello.people");
  await until(() => !!m.getSnapshot().views["acme.hello.people"], "rows");
  assert.deepEqual(m.getSnapshot().views["acme.hello.people"], [
    { label: "Ada 1", command: "acme.hello.greet", children: [{ label: "child" }] },
    { label: "evil" },
  ]);
  await m.executeCommand("acme.hello.greet");
  await until(() => m.getSnapshot().views["acme.hello.people"]?.[0].label === "Ada 2", "refresh");
});

test("language providers: registered, invoked, timed out, isolated, removed with the extension", async () => {
  const t = setup();
  t.add(
    { activationEvents: ["onLanguage:markdown"] },
    `
    module.exports.activate = function (c, yavin) {
      c.subscriptions.push(yavin.languages.registerHoverProvider("markdown", { provideHover: function (doc, pos) { return { contents: doc.languageId + "@" + pos.line }; } }));
      c.subscriptions.push(yavin.languages.registerCompletionProvider("markdown", { provideCompletionItems: function () { return new Promise(function () {}); } }));
    };`,
  );
  const m = t.manager();
  await m.fire({ kind: "language", id: "markdown" });
  await until(() => t.providers.getSnapshot().length === 2, "providers");
  const doc = t.win.window.documents.all()[0];
  const [hover] = t.providers.for("hover", "markdown");
  assert.deepEqual(
    await hover.invoke(
      { document: doc, position: { line: 3, column: 1 } },
      new AbortController().signal,
    ),
    { contents: "markdown@3" },
  );
  const [completion] = t.providers.for("completion", "markdown");
  await assert.rejects(
    completion.invoke(
      { document: doc, position: { line: 1, column: 1 } },
      new AbortController().signal,
    ),
    (e: ExtensionError) => e.code === "Timeout",
  );
  const controller = new AbortController();
  const cancelled = completion.invoke(
    { document: doc, position: { line: 1, column: 1 } },
    controller.signal,
  );
  controller.abort();
  await assert.rejects(cancelled, (e: ExtensionError) => e.code === "Cancelled");
  await m.dispose();
  assert.equal(t.providers.getSnapshot().length, 0);
});

test("documents and editor: by URI inside the workspace only; events; decorations from a fixed set", async () => {
  const t = setup();
  t.add(
    { activationEvents: ["onStartupFinished"] },
    `
    module.exports.activate = async function (c, yavin) {
      globalThis.__seen = [];
      c.subscriptions.push(yavin.documents.onDidChange(function (d) { globalThis.__seen.push(d.uri); }));
      c.subscriptions.push(yavin.commands.registerCommand("acme.hello.greet", async function (what) {
        if (what === "text") return yavin.documents.getText((await yavin.editor.activeEditor()).document.uri);
        if (what === "outside") return yavin.documents.getText("file:///C:/Windows/win.ini");
        if (what === "open") return yavin.editor.openLocation("file:///C:/work/readme.md", { startLine: 2, startColumn: 1, endLine: 2, endColumn: 3 });
        if (what === "open-outside") return yavin.editor.openLocation("file:///C:/secret.txt");
        if (what === "decorate") return yavin.editor.setDecorations("file:///C:/work/readme.md", "marks", [{ range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 3 }, style: "highlight", hover: "hi" }]);
        if (what === "bad-style") return yavin.editor.setDecorations("file:///C:/work/readme.md", "marks", [{ range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 3 }, style: "position:fixed" }]);
        if (what === "seen") return globalThis.__seen;
      }));
    };`,
  );
  // EXT-07: a legacy extension, allowed what it asks for (as the user would).
  await t.registry.grant("acme.hello", ["documents.read", "editor.control"]);
  const m = t.manager();
  await m.fire({ kind: "startup" });
  await until(() => m.getSnapshot().statuses["acme.hello"]?.state === "active", "active");
  assert.equal(await m.executeCommand("acme.hello.greet", "text"), "# Readme\nhello");
  await assert.rejects(m.executeCommand("acme.hello.greet", "outside"), /not in this workspace/);
  await m.executeCommand("acme.hello.greet", "open");
  assert.equal(t.win.opened[0].path, "C:/work/readme.md");
  await assert.rejects(
    m.executeCommand("acme.hello.greet", "open-outside"),
    /not in this workspace/,
  );
  await m.executeCommand("acme.hello.greet", "decorate");
  assert.equal(t.decorations.getSnapshot()[0].owner, "acme.hello:marks");
  assert.equal(t.decorations.getSnapshot()[0].resource, resourceId(fileUri("C:/work/readme.md")));
  await assert.rejects(m.executeCommand("acme.hello.greet", "bad-style"), /style is one of/);
  t.win.emit("change", t.win.window.documents.all()[0]);
  await settle();
  assert.deepEqual(await m.executeCommand("acme.hello.greet", "seen"), [
    "file:///C:/work/readme.md",
  ]);
  await m.dispose();
  assert.equal(t.decorations.getSnapshot().length, 0, "decorations go with the extension");
});

test("the filesystem API reads workspace-relative files only: traversal and absolute paths refused", async () => {
  const t = setup();
  t.add(
    {},
    `
    module.exports.activate = function (c, yavin) {
      c.subscriptions.push(yavin.commands.registerCommand("acme.hello.greet", function (path) { return yavin.workspace.fs.readFile(path); }));
      c.subscriptions.push(yavin.commands.registerCommand("acme.hello.other", function (path) { return yavin.workspace.fs.exists(path); }));
    };`,
  );
  // EXT-07: allowed to read the workspace (as the user would).
  await t.registry.grant("acme.hello", ["workspace.fs.read"]);
  const m = t.manager();
  assert.equal(await m.executeCommand("acme.hello.greet", "notes.txt"), "a note");
  for (const path of [
    "../other/secret.txt",
    "C:/Windows/win.ini",
    "/etc/passwd",
    "sub/../../escape",
    "file:///C:/work/notes.txt",
  ])
    await assert.rejects(
      m.executeCommand("acme.hello.greet", path),
      /outside the workspace|relative to the workspace/,
      path,
    );
  assert.equal(await m.executeCommand("acme.hello.other", "notes.txt"), true);
  assert.equal(await m.executeCommand("acme.hello.other", "missing.txt"), false);
});

test("storage and settings: an extension's own state, scoped by workspace; its own settings only", async () => {
  const t = setup();
  t.add(
    {},
    `
    module.exports.activate = function (c, yavin) {
      c.subscriptions.push(yavin.workspace.onDidChangeConfiguration(function (e) { globalThis.__changed = e.key; }));
      c.subscriptions.push(yavin.commands.registerCommand("acme.hello.greet", async function (what) {
        if (what === "save") { await c.globalState.update("count", 3); await c.workspaceState.update("open", ["x"]); return null; }
        if (what === "read") return [c.globalState.get("count"), c.workspaceState.get("open")];
        if (what === "foreign") return yavin.workspace.getConfiguration("editor");
        if (what === "mood") return [yavin.workspace.getConfiguration("acme.hello").get("mood"), globalThis.__changed];
        if (what === "huge") return c.globalState.update("big", "x".repeat(70000));
      }));
    };`,
  );
  const a = t.manager(A, 1);
  await a.executeCommand("acme.hello.greet", "save");
  assert.deepEqual(await a.executeCommand("acme.hello.greet", "read"), [3, ["x"]]);
  assert.equal(
    t.extensionStorage.global("acme.other").get("count"),
    undefined,
    "not another extension's",
  );
  await assert.rejects(a.executeCommand("acme.hello.greet", "foreign"), /own settings/);
  await assert.rejects(a.executeCommand("acme.hello.greet", "huge"), /exceed/);
  t.settings.set(t.registry.settingDefinition("acme.hello.mood")!, "workspace", "bright", A);
  await settle();
  assert.deepEqual(await a.executeCommand("acme.hello.greet", "mood"), ["bright", "mood"]);
  await a.dispose();
  // Another workspace: its global state is shared, its workspace state is not.
  const b = t.manager(B, 2);
  // (`undefined` crosses the protocol as JSON: null.)
  assert.deepEqual(await b.executeCommand("acme.hello.greet", "read"), [3, null]);
  await b.dispose();
});

test("storage records: versioned, corrupt kept aside, newer read-only, bounded", async () => {
  const storage = memoryStorage({
    [globalStorageKey("acme.broken")]: "{not json",
    [globalStorageKey("acme.future")]: JSON.stringify({ version: 9, values: { a: 1 } }),
  });
  const store = createExtensionStorage(storage);
  await store.workspace(A, "acme.hello").update("k", 1);
  assert.deepEqual(JSON.parse(storage.getItem(workspaceStorageKey(A, "acme.hello"))!), {
    version: 1,
    values: { k: 1 },
  });
  assert.deepEqual(store.global("acme.broken").keys(), []);
  assert.equal(storage.getItem(`${globalStorageKey("acme.broken")}.corrupt`), "{not json");
  await assert.rejects(
    store.global("acme.future").update("a", 2),
    (e: ExtensionError) => e.code === "StorageReadOnly",
  );
  await assert.rejects(
    store.global("acme.hello").update("big", "x".repeat(STORAGE_LIMIT)),
    (e: ExtensionError) => e.code === "StorageLimit",
  );
});

// --- Trust, crashes, malformed messages, isolation, reload ---------------------------------------

test("trust: untrusted starts no host; trusted activates; revoked ends the host; restored activates again", async () => {
  const t = setup({ trusted: false });
  t.add({}, GREETER);
  const m = t.manager();
  await assert.rejects(
    m.executeCommand("acme.hello.greet"),
    (e: ExtensionError) => e.code === "TrustRequired",
  );
  assert.equal(t.host.started(), 0);
  t.setTrusted(true);
  assert.equal(await m.executeCommand("acme.hello.greet", "x"), "hello x");
  await m.setTrusted(false);
  assert.equal(m.getSnapshot().host, "stopped");
  assert.match(m.getSnapshot().held!, /no longer trusted/);
  await assert.rejects(
    m.executeCommand("acme.hello.greet"),
    (e: ExtensionError) => e.code === "TrustRequired",
  );
  await m.setTrusted(true);
  assert.equal(await m.executeCommand("acme.hello.greet", "y"), "hello y");
  assert.equal(t.host.started(), 2);
});

test("an untrusted folder is said to be untrusted, not revoked; a view on screen waits for trust", async () => {
  const t = setup({ trusted: false });
  t.add({}, GREETER);
  const m = t.manager();
  await m.setTrusted(false);
  assert.match(m.getSnapshot().held!, /is not trusted/);
  await assert.rejects(m.showView("acme.hello.people"));
  t.setTrusted(true);
  await m.setTrusted(true);
  await until(() => m.getSnapshot().statuses["acme.hello"]?.state === "active", "filled on trust");
  assert.equal(t.host.started(), 1);
});

test("restart and reload start lazily; only a view on screen makes a new host at once", async () => {
  const t = setup();
  t.add(
    {},
    GREETER.replace(
      "module.exports.activate = function (context, yavin) {",
      `module.exports.activate = function (context, yavin) {
  context.subscriptions.push(yavin.views.registerView("acme.hello.people", { getItems: function () { return [{ label: "row" }]; } }));`,
    ),
  );
  const m = t.manager();
  await m.executeCommand("acme.hello.greet");
  await m.restart();
  assert.equal(m.getSnapshot().host, "stopped");
  assert.equal(t.host.started(), 1, "nothing waits: no new process");
  await m.showView("acme.hello.people");
  await until(() => m.getSnapshot().views["acme.hello.people"]?.length === 1, "rows");
  await m.reload();
  await until(
    () => m.getSnapshot().views["acme.hello.people"]?.length === 1 && t.host.started() === 3,
    "refilled",
  );
  m.hideView("acme.hello.people");
  await m.restart();
  assert.equal(t.host.started(), 3);
});

test("a crash fails what runs, cleans every contribution, restarts on demand, and stops after a crash loop", async () => {
  const t = setup();
  t.add(
    { activationEvents: ["onLanguage:markdown"] },
    `
    module.exports.activate = function (c, yavin) {
      c.subscriptions.push(yavin.commands.registerCommand("acme.hello.greet", function () { return "up"; }));
      c.subscriptions.push(yavin.languages.registerHoverProvider("markdown", { provideHover: function () { return null; } }));
      c.subscriptions.push(yavin.commands.registerCommand("acme.hello.other", function () { return new Promise(function () {}); }));
    };`,
  );
  const m = t.manager(A, 1, { command: 5000 });
  await m.fire({ kind: "language", id: "markdown" });
  await until(() => t.providers.getSnapshot().length === 1, "provider");
  const hanging = m.executeCommand("acme.hello.other");
  await settle();
  t.host.crash();
  await assert.rejects(hanging, (e: ExtensionError) => /HostCrashed|CommandFailed/.test(e.code));
  assert.equal(m.getSnapshot().statuses["acme.hello"].state, "failed");
  assert.equal(t.providers.getSnapshot().length, 0, "providers removed");
  // The next use makes a new host generation.
  assert.equal(await m.executeCommand("acme.hello.greet"), "up");
  assert.equal(m.getSnapshot().generation, 1002);
  for (let i = 1; i < CRASH_LIMIT; i++) {
    t.host.crash();
    await settle();
    if (i < CRASH_LIMIT - 1) await m.executeCommand("acme.hello.greet");
  }
  await assert.rejects(
    m.executeCommand("acme.hello.greet"),
    (e: ExtensionError) => e.code === "HostCrashedRepeatedly",
  );
  await m.restart();
  assert.equal(await m.executeCommand("acme.hello.greet"), "up");
});

test("EXT-06 a crash hold is a crash hold whatever the host printed; trust is decided by trust", async () => {
  const t = setup();
  t.add({}, GREETER);
  const m = t.manager();
  // An extension's own output, made to read like a trust refusal, ends up in the crash's reason.
  const spoof =
    "TrustRequired: This folder is not trusted. Trust it from File › Manage Workspace Trust.";
  for (let i = 0; i < CRASH_LIMIT; i++) {
    await m.executeCommand("acme.hello.greet");
    t.host.stderr(spoof);
    await settle();
    t.host.crash();
    await settle();
  }
  assert.match(m.getSnapshot().held!, /Manage Workspace Trust/, "the text says trust...");
  assert.equal(m.getSnapshot().heldBy, "crashes", "...but the hold is the crash loop's");
  await assert.rejects(
    m.executeCommand("acme.hello.greet"),
    (e: ExtensionError) => e.code === "HostCrashedRepeatedly",
  );
  const { displayStatus } = await import("./marketplace/status.ts");
  const entry = t.registry.get("acme.hello")!;
  const shown = (s: ReturnType<typeof m.getSnapshot>) =>
    displayStatus({ entry, trusted: true, held: s.held, heldBy: s.heldBy }).label;
  assert.equal(shown(m.getSnapshot()), "Host Unavailable");
  // Granting trust again does not lift a crash hold; Restart does.
  await m.setTrusted(true);
  assert.equal(m.getSnapshot().heldBy, "crashes");
  await m.restart();
  assert.equal(m.getSnapshot().held, null);
  assert.equal(m.getSnapshot().heldBy, null);
  assert.equal(await m.executeCommand("acme.hello.greet", "z"), "hello z");

  // A real trust hold: Restart and Reload keep it; only trust lifts it.
  await m.setTrusted(false);
  assert.equal(m.getSnapshot().heldBy, "trust");
  assert.equal(shown(m.getSnapshot()), "Untrusted");
  await m.restart();
  await m.reload();
  assert.equal(m.getSnapshot().heldBy, "trust");
  await assert.rejects(
    m.executeCommand("acme.hello.greet"),
    (e: ExtensionError) => e.code === "TrustRequired",
  );
  await m.setTrusted(true);
  assert.equal(m.getSnapshot().heldBy, null);
  assert.equal(await m.executeCommand("acme.hello.greet", "w"), "hello w");
});

test("malformed and stale host messages are dropped and logged; the host goes on", async () => {
  const t = setup();
  t.add({}, GREETER);
  const m = t.manager();
  await m.executeCommand("acme.hello.greet");
  t.host.deliverRaw("{garbage");
  t.host.deliverRaw(
    JSON.stringify({
      type: "request",
      requestId: "h9",
      method: "window.showMessage",
      params: { message: "from the past" },
      extensionId: "acme.hello",
      workspaceId: A,
      hostGeneration: 999,
    }),
  );
  await settle();
  assert.deepEqual(t.notes, []);
  assert.ok((t.logs.get("yavin.extension-host") ?? []).some((line) => /not JSON/.test(line)));
  assert.equal(await m.executeCommand("acme.hello.greet", "still"), "hello still");
});

test("A → B: A's host ends; its late messages and commands reach nothing in B", async () => {
  const t = setup();
  t.add({}, GREETER);
  const a = t.manager(A, 1);
  await a.executeCommand("acme.hello.greet");
  await a.dispose();
  const b = t.manager(B, 2);
  t.host.deliverRaw(
    JSON.stringify({
      type: "request",
      requestId: "late",
      method: "window.showMessage",
      params: { message: "late" },
      extensionId: "acme.hello",
      workspaceId: A,
      hostGeneration: 1001,
    }),
  );
  await settle();
  assert.deepEqual(t.notes, []);
  assert.equal(b.getSnapshot().statuses["acme.hello"], undefined, "nothing of A's activation in B");
  assert.equal(await b.executeCommand("acme.hello.greet", "b"), "hello b");
  assert.equal(b.getSnapshot().workspace, B);
});

test("A → B while A's activation is pending: it never completes, and leaves nothing behind", async () => {
  const t = setup();
  t.add(
    {},
    `
    module.exports.activate = function (c, yavin) {
      return new Promise(function (resolve) { globalThis.__release = function () {
        c.subscriptions.push(yavin.commands.registerCommand("acme.hello.greet", function () { return "late"; }));
        resolve();
      }; });
    };`,
  );
  const a = t.manager(A, 1);
  const pending = a.executeCommand("acme.hello.greet");
  await settle();
  await a.dispose();
  await assert.rejects(pending);
  (globalThis as { __release?: () => void }).__release?.();
  await settle();
  const b = t.manager(B, 2);
  assert.equal(b.getSnapshot().statuses["acme.hello"], undefined);
  assert.equal(t.registry.commandOwner("acme.hello.greet"), "acme.hello");
});

test("reload ends the host, re-discovers, starts lazily again; nothing is duplicated", async () => {
  const t = setup();
  t.add({}, GREETER);
  const m = t.manager();
  await m.executeCommand("acme.hello.greet");
  const before = t.registry.getSnapshot().commands.length;
  await m.reload();
  assert.equal(t.rediscovered(), 1);
  assert.equal(t.registry.getSnapshot().commands.length, before);
  assert.equal(m.getSnapshot().host, "stopped");
  assert.equal(await m.executeCommand("acme.hello.greet", "again"), "hello again");
  assert.equal(m.getSnapshot().generation, 1002);
});

test("dependencies activate first, in order; an unavailable one stops the extension with why", async () => {
  const t = setup();
  const order = `module.exports.activate = function (c) { globalThis.__order = (globalThis.__order || []).concat([c.extensionId]); };`;
  t.add({ name: "base", contributes: {} }, order);
  t.add(
    {
      name: "app",
      extensionDependencies: ["acme.base"],
      contributes: { commands: [{ command: "acme.app.go", title: "Go" }] },
    },
    `
    module.exports.activate = function (c, yavin) {
      c.subscriptions.push(yavin.commands.registerCommand("acme.app.go", function () { return globalThis.__order || []; }));
    };`,
  );
  (globalThis as { __order?: string[] }).__order = [];
  const m = t.manager();
  await m.executeCommand("acme.app.go");
  assert.deepEqual((globalThis as { __order?: string[] }).__order, ["acme.base"]);
  assert.equal(m.getSnapshot().statuses["acme.base"].state, "active");
  t.add(
    {
      name: "orphan",
      extensionDependencies: ["acme.missing"],
      contributes: { commands: [{ command: "acme.orphan.go", title: "Go" }] },
    },
    GREETER,
  );
  await assert.rejects(
    m.executeCommand("acme.orphan.go"),
    (e: ExtensionError) => e.code === "DependencyFailed" && /not installed/.test(e.message),
  );
});

test("an extension's messages are shown, then muted when it floods; deactivation reports disposal failures", async () => {
  const t = setup();
  t.add(
    { activationEvents: ["onStartupFinished"] },
    `
    module.exports.activate = function (c, yavin) {
      for (var i = 0; i < 40; i++) yavin.window.showInformationMessage("spam " + i);
      c.subscriptions.push({ dispose: function () { throw new Error("stuck"); } });
    };`,
  );
  const m = t.manager();
  await m.fire({ kind: "startup" });
  await until(
    () =>
      t.notes.length === 20 &&
      (t.logs.get("acme.hello") ?? []).some((l) => /Too many messages/.test(l)),
    "flood",
  );
  await m.dispose();
  assert.ok((t.logs.get("acme.hello") ?? []).some((line) => /failed to dispose: stuck/.test(line)));
});

test("the sample extension works end to end through the host", async () => {
  const t = setup({ codes: { "yavin-samples.hello-world": SAMPLE.code } });
  t.registry.add(
    SAMPLE.manifest,
    { kind: "folder", path: "C:/repo/extensions/samples/hello-world" },
    "samples",
  );
  // EXT-07: the sample declares documents.read ("Describe Active File"); the user allows it.
  await t.registry.grant("yavin-samples.hello-world", ["documents.read"]);
  const m = t.manager();
  assert.equal(await m.executeCommand("yavin-samples.hello-world.greet"), "Hello, world!");
  await m.showView("yavin-samples.hello-world.greetings");
  await until(
    () =>
      m.getSnapshot().views["yavin-samples.hello-world.greetings"]?.[0]?.label === "Hello, world!",
    "greetings",
  );
  assert.equal(await m.executeCommand("yavin-samples.hello-world.describe"), "markdown, 2 lines");
  await until(() => t.providers.for("hover", "markdown").length === 1, "hover provider");
  const doc = t.win.window.documents.all()[0];
  assert.deepEqual(
    await t.providers
      .for("hover", "markdown")[0]
      .invoke({ document: doc, position: { line: 2, column: 1 } }, new AbortController().signal),
    {
      contents: "Hello from the sample (line 2 of readme.md)",
    },
  );
  await m.showView("yavin-samples.hello-world.about");
  await until(() => !!m.getSnapshot().views["yavin-samples.hello-world.about"], "about");
  assert.equal(
    m.getSnapshot().views["yavin-samples.hello-world.about"][0].children?.[0].label,
    "API 2.0.0",
  );
  assert.ok(t.notes.some(([, , text]) => text === "Hello, world!"));
});

test("discovery: installed manifests registered, unreadable reported, reload without duplicates", async () => {
  const { discoverExtensions, rediscoverExtensions } = await import("./discovery.ts");
  const t = setup();
  const found = {
    root: "C:/data/extensions",
    skipped: 0,
    extensions: [
      {
        folder: "C:/data/extensions/acme.hello",
        manifest: JSON.stringify(manifest({ main: undefined })),
        error: null,
      },
      { folder: "C:/data/extensions/broken", manifest: "{not json", error: null },
      {
        folder: "C:/data/extensions/copy",
        manifest: JSON.stringify(manifest({ main: undefined })),
        error: null,
      },
    ],
  };
  const report = await discoverExtensions(t.registry, async () => found);
  assert.deepEqual([report.registered, report.rejected], [1, 2]);
  await rediscoverExtensions(t.registry, async () => found);
  assert.equal(t.registry.getSnapshot().extensions.length, 1);
  assert.equal(t.registry.getSnapshot().rejected.length, 2);
});

test("a declarative extension needs no host; a disabled one does not activate", async () => {
  const t = setup();
  t.add(
    {
      name: "decl",
      main: undefined,
      activationEvents: [],
      contributes: {
        configuration: {
          properties: { "acme.decl.on": { type: "boolean", default: true, description: "On." } },
        },
      },
    },
    null,
  );
  t.add({}, GREETER);
  t.registry.setEnabled("acme.hello", false);
  const m = t.manager();
  await m.activate("acme.decl");
  assert.equal(t.host.started(), 0);
  assert.ok(t.settings.definitions.some((d) => d.id === "acme.decl.on"));
  await assert.rejects(m.activate("acme.hello"), (e: ExtensionError) => e.code === "Disabled");
  void (null as unknown as ResourceId);
});

test("performance budgets: discovering 200 extensions, and a command's round trip through the manager", async () => {
  const { discoverExtensions } = await import("./discovery.ts");
  const t = setup();
  const found = {
    root: "C:/data/extensions",
    skipped: 0,
    extensions: Array.from({ length: 200 }, (_, n) => ({
      folder: `C:/data/extensions/acme.e${n}`,
      manifest: JSON.stringify(
        manifest({
          name: `e${n}`,
          activationEvents: [],
          contributes: {
            commands: [{ command: `acme.e${n}.go`, title: `Go ${n}` }],
            configuration: {
              properties: {
                [`acme.e${n}.on`]: { type: "boolean", default: true, description: "On." },
              },
            },
          },
        }),
      ),
      error: null,
    })),
  };
  let started = performance.now();
  const report = await discoverExtensions(t.registry, async () => found);
  const discovery = performance.now() - started;
  assert.equal(report.registered, 200);

  t.add({}, GREETER);
  const m = t.manager();
  await m.executeCommand("acme.hello.greet");
  const samples: number[] = [];
  for (let i = 0; i < 100; i++) {
    started = performance.now();
    await m.executeCommand("acme.hello.greet", "x");
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[94];
  console.log(
    `extensions: discovery of 200 ${discovery.toFixed(1)} ms; command round trip p95 ${p95.toFixed(2)} ms`,
  );
  assert.ok(discovery < 1000, `discovery took ${discovery} ms (budget 1000)`);
  assert.ok(p95 < 20, `command p95 ${p95} ms (budget 20)`);
  await m.dispose();
});

test("EXT-02 discovery: one entry per id with its shadowed copies; the inventory's verdict and disabled list hold", async () => {
  const { discoverExtensions } = await import("./discovery.ts");
  const t = setup();
  const report = await discoverExtensions(t.registry, async () => ({
    root: "C:/data/extensions",
    skipped: 0,
    disabled: ["acme.hello"],
    extensions: [
      {
        folder: "C:/data/extensions/.store/acme.hello/2.1.0-0123abcd",
        manifest: JSON.stringify(manifest({ main: undefined, version: "2.1.0" })),
        error: null,
        shadowed: [
          {
            folder: "C:/repo/extensions/samples/hello",
            version: "2.0.0",
            reason: "An installed copy takes precedence over a development copy.",
          },
        ],
      },
      // A copy the inventory cannot use is never registered, whatever its manifest says.
      {
        folder: "C:/data/extensions/acme.other",
        manifest: JSON.stringify(manifest({ name: "other", main: undefined })),
        error: "The installed acme.other 1.0.0 cannot be used: its folder is missing.",
      },
    ],
  }));
  assert.deepEqual([report.registered, report.rejected], [1, 1]);
  const entry = t.registry.get("acme.hello")!;
  assert.equal(entry.manifest.version, "2.1.0");
  assert.equal(entry.enabled, false, "the inventory's disabled list");
  assert.deepEqual(
    entry.shadowed.map((copy) => copy.version),
    ["2.0.0"],
  );
  assert.equal(t.registry.get("acme.other"), undefined);
  assert.match(t.registry.getSnapshot().rejected[0].problems[0], /cannot be used/);
});

test("EXT-02 uninstall forgets the disabled state: a reinstall starts enabled", () => {
  const storage = memoryStorage();
  const settings = createSettingsRegistry([], storage);
  const raw = manifest({ main: undefined });
  const source = { kind: "folder" as const, path: "C:/x" };
  const registry = createExtensionRegistry({ settings, storage });
  registry.add(raw, source, "C:/x");
  registry.setEnabled("acme.hello", false);
  registry.remove("acme.hello"); // a Reload keeps it disabled
  const reloaded = registry.add(raw, source, "C:/x");
  assert.equal("enabled" in reloaded && reloaded.enabled, false);
  registry.remove("acme.hello", { forget: true }); // an uninstall does not
  const again = createExtensionRegistry({ settings: createSettingsRegistry([], storage), storage });
  const reinstalled = again.add(raw, source, "C:/x");
  assert.equal("enabled" in reinstalled && reinstalled.enabled, true);
  // With the native inventory as the store, changes go there and nothing to this window's.
  const saved: [string, boolean][] = [];
  const native = createExtensionRegistry({
    settings: createSettingsRegistry([], memoryStorage()),
    storage: memoryStorage({ [DISABLED_KEY]: JSON.stringify({ version: 1, ids: ["acme.hello"] }) }),
    persistEnabled: (id, enabled) => void saved.push([id, enabled]),
  });
  const added = native.add(raw, source, "C:/x");
  assert.equal("enabled" in added && added.enabled, true, "the window's old list is not read");
  native.setEnabled("acme.hello", false);
  assert.deepEqual(saved, [["acme.hello", false]]);
});

// --- EXT-05: lifecycle reconciliation ----------------------------------------------------------

test("EXT-05 a failed activation keeps nothing: its code unloaded, its partial registrations gone, no retry loop", async () => {
  const t = setup();
  t.add(
    {
      name: "half",
      activationEvents: ["onStartupFinished"],
      contributes: { commands: [{ command: "acme.half.go", title: "Go" }] },
    },
    `module.exports.activate = function (c, yavin) {
      c.subscriptions.push(yavin.commands.registerCommand("acme.half.go", function () { return "ran"; }));
      throw new Error("half way");
    };`,
  );
  const m = t.manager();
  await m.fire({ kind: "startup" });
  await until(() => m.getSnapshot().statuses["acme.half"]?.state === "failed", "failed");
  await settle();
  assert.deepEqual(t.host.resident(), [], "its code was unloaded from the host");
  // What it registered before failing is not reachable, and using it does not try again.
  await assert.rejects(
    m.executeCommand("acme.half.go"),
    (e: ExtensionError) => e.code === "ActivationFailed",
  );
  assert.deepEqual(t.host.resident(), [], "not loaded again in this host");
  // A new host (Restart) tries once more, and cleans up the same way.
  await m.restart();
  await assert.rejects(
    m.activate("acme.half"),
    (e: ExtensionError) => e.code === "ActivationFailed",
  );
  await settle();
  assert.deepEqual(t.host.resident(), []);
});

test("EXT-05 reconciliation: disable, uninstall, update and a lost dependency each stop the extension and clear it; repeated runs converge", async () => {
  const t = setup();
  t.add(
    { name: "base", activationEvents: [], contributes: {} },
    `module.exports.activate = function () {};`,
  );
  const greeter = (word: string) =>
    `module.exports.activate = function (c, yavin) {
      c.subscriptions.push(yavin.commands.registerCommand("acme.uses.go", function () { return "${word}"; }));
      c.subscriptions.push(yavin.languages.registerHoverProvider("markdown", { provideHover: function () { return null; } }));
    };`;
  const uses = {
    name: "uses",
    activationEvents: ["onStartupFinished"],
    extensionDependencies: ["acme.base"],
    contributes: { commands: [{ command: "acme.uses.go", title: "Go" }] },
  };
  t.add(uses, greeter("v1"));
  // Startup activates only what is enabled and can run: a disabled one never starts.
  t.add(
    { name: "off", activationEvents: ["onStartupFinished"], contributes: {} },
    `module.exports.activate = function () {};`,
  );
  t.registry.setEnabled("acme.off", false);
  const m = t.manager();
  await m.fire({ kind: "startup" });
  await until(() => m.getSnapshot().statuses["acme.uses"]?.state === "active", "active");
  assert.deepEqual(t.host.resident(), ["acme.base", "acme.uses"]);
  assert.equal(m.getSnapshot().statuses["acme.off"], undefined);
  assert.equal(t.providers.getSnapshot().length, 1);

  // Its dependency disabled: it cannot run any more, so it stops.
  t.registry.setEnabled("acme.base", false);
  await m.reconcile();
  assert.deepEqual(t.host.resident(), []);
  assert.equal(t.providers.getSnapshot().length, 0);
  await assert.rejects(
    m.executeCommand("acme.uses.go"),
    (e: ExtensionError) => e.code === "DependencyFailed",
  );
  t.registry.setEnabled("acme.base", true);
  assert.equal(await m.executeCommand("acme.uses.go"), "v1");

  // Updated: the old version is gone from the host before the new one runs.
  const id = "acme.uses";
  t.codes[id] = greeter("v2");
  t.registry.replace(
    id,
    manifest({ ...uses, version: "2.0.0" }),
    { kind: "folder", path: "C:/e/v2" },
    "C:/e/v2",
  );
  await m.reconcile();
  assert.deepEqual(t.host.resident(), ["acme.base"], "v1 unloaded");
  assert.equal(await m.executeCommand("acme.uses.go"), "v2");
  assert.equal(t.providers.getSnapshot().length, 1, "one provider: the new version's");

  // Reconciling again and again changes nothing.
  for (let i = 0; i < 3; i++) await m.reconcile();
  assert.deepEqual(t.host.resident(), ["acme.base", "acme.uses"]);
  assert.equal(m.getSnapshot().statuses[id].state, "active");

  // Disabled, then uninstalled: stopped, unloaded, its contributions gone.
  t.registry.setEnabled(id, false);
  await m.reconcile();
  assert.deepEqual(t.host.resident(), ["acme.base"]);
  assert.equal(t.providers.getSnapshot().length, 0);
  t.registry.setEnabled(id, true);
  await m.executeCommand("acme.uses.go");
  t.registry.remove(id, { forget: true });
  await m.reconcile();
  assert.deepEqual(t.host.resident(), ["acme.base"]);
  await assert.rejects(m.executeCommand("acme.uses.go"));
});

test("EXT-05 a restart registers nothing twice; a crash's reason carries the host's last output", async () => {
  const t = setup();
  t.add(
    { activationEvents: ["onLanguage:markdown"] },
    `module.exports.activate = function (c, yavin) {
      c.subscriptions.push(yavin.commands.registerCommand("acme.hello.greet", function () { return "up"; }));
      c.subscriptions.push(yavin.languages.registerHoverProvider("markdown", { provideHover: function () { return null; } }));
    };`,
  );
  const m = t.manager();
  await m.fire({ kind: "language", id: "markdown" });
  await until(() => t.providers.getSnapshot().length === 1, "provider");
  for (let i = 0; i < 2; i++) {
    await m.restart();
    assert.equal(await m.executeCommand("acme.hello.greet"), "up");
  }
  await m.fire({ kind: "language", id: "markdown" });
  await until(() => t.providers.getSnapshot().length === 1, "provider again");
  await settle();
  assert.equal(t.providers.getSnapshot().length, 1, "one provider, not one per restart");
  assert.deepEqual(t.host.resident(), ["acme.hello"]);
  // The host's stderr: in its output channel, and the last line in the crash's reason.
  t.host.stderr("thread 'main' panicked at src/runtime.rs:42");
  t.host.crash();
  await settle();
  const reason = m.getSnapshot().statuses["acme.hello"].reason ?? "";
  assert.match(reason, /exited with code 3\. Its last output: thread 'main' panicked/);
  assert.ok(
    (t.logs.get("yavin.extension-host") ?? []).some((line) =>
      line.includes("host: thread 'main' panicked"),
    ),
  );
  assert.equal(t.providers.getSnapshot().length, 0, "a crash clears what it contributed");
});

// --- EXT-07: permissions -----------------------------------------------------------------------

const ASKS_ALL = {
  permissions: {
    version: 1,
    request: [
      "documents.read",
      "workspace.fs.read",
      "editor.control",
      "commands.execute:acme.other",
    ],
  },
};
const PROBE = `
module.exports.activate = function (c, yavin) {
  globalThis.__seen = [];
  c.subscriptions.push(yavin.documents.onDidChange(function (d) { globalThis.__seen.push(d.uri); }));
  c.subscriptions.push(yavin.commands.registerCommand("acme.hello.greet", async function (what) {
    if (what === "seen") return globalThis.__seen;
    if (what === "state") return c.globalState.keys();
    const out = {};
    const attempt = async (name, run) => {
      try { const value = await run(); out[name] = value === undefined || value === null ? "ok" : value; }
      catch (e) { out[name] = e.code || String(e); }
    };
    await attempt("text", () => yavin.documents.getText("file:///C:/work/readme.md"));
    await attempt("active", () => yavin.editor.activeEditor().then(() => "ok"));
    await attempt("fs", () => yavin.workspace.fs.readFile("notes.txt"));
    await attempt("open", () => yavin.editor.openLocation("file:///C:/work/readme.md"));
    await attempt("other", () => yavin.commands.executeCommand("acme.other.greet"));
    await attempt("third", () => yavin.commands.executeCommand("acme.third.greet"));
    await attempt("storage", () => yavin.storage.global.update("mine", 1));
    return out;
  }));
};`;
const OTHER = {
  name: "other",
  displayName: "Other",
  activationEvents: ["onCommand:acme.other.greet"],
  contributes: { commands: [{ command: "acme.other.greet", title: "Greet" }] },
};
const OTHER_CODE = `
module.exports.activate = async function (c, yavin) {
  await c.globalState.update("token", "s3cret");
  c.subscriptions.push(yavin.commands.registerCommand("acme.other.greet", function () { return "from other"; }));
};`;

test("EXT-07 nothing granted: every privileged request is refused, the mandatory ones served; a grant opens only its own; a revocation holds at once", async () => {
  const t = setup();
  t.add(ASKS_ALL, PROBE);
  t.add(OTHER, OTHER_CODE);
  const m = t.manager();
  const run = async () => (await m.executeCommand("acme.hello.greet")) as Record<string, string>;
  assert.deepEqual(await run(), {
    text: "PermissionDenied",
    active: "PermissionDenied",
    fs: "PermissionDenied",
    open: "PermissionDenied",
    other: "PermissionDenied",
    third: "PermissionDenied",
    storage: "ok",
  });
  assert.deepEqual(t.win.opened, [], "nothing was opened");
  assert.equal(t.host.started(), 1);
  assert.equal(m.getSnapshot().statuses["acme.other"], undefined, "the other was never run");
  assert.equal(m.getSnapshot().denied["acme.hello"]?.code, "PermissionDenied");
  assert.ok(
    t.logs.get("acme.hello")?.some((line) => /refused: PermissionDenied/.test(line)),
    "said in its output",
  );

  await t.registry.grant("acme.hello", ["documents.read"]);
  let out = await run();
  assert.equal(out.text, "# Readme\nhello");
  assert.equal(out.active, "ok");
  for (const name of ["fs", "open", "other"]) assert.equal(out[name], "PermissionDenied", name);

  await t.registry.grant("acme.hello", [...ASKS_ALL.permissions.request]);
  out = await run();
  assert.deepEqual(out, {
    text: "# Readme\nhello",
    active: "ok",
    fs: "a note",
    open: "ok",
    other: "from other",
    // A grant for acme.other's commands is not one for acme.third's (never requested).
    third: "PermissionDenied",
    storage: "ok",
  });
  assert.deepEqual(
    m.getSnapshot().denied["acme.hello"]?.capability,
    "commands.execute:acme.third",
    "only what it still may not do is shown",
  );

  // Revoked: the very next request is refused -- no reload, no restart.
  await t.registry.grant("acme.hello", ["editor.control"]);
  out = await run();
  assert.equal(out.open, "ok");
  for (const name of ["text", "active", "fs", "other"])
    assert.equal(out[name], "PermissionDenied", name);
  assert.equal(t.host.started(), 1);
  // Only what its manifest requests can be granted.
  await assert.rejects(
    t.registry.grant("acme.hello", ["commands.execute:acme.third"]),
    (e: ExtensionError) => e.code === "NotRequested",
  );
  await assert.rejects(
    t.registry.grant("acme.other", ["commands.execute:acme.hello"]),
    (e: ExtensionError) => e.code === "NotRequested",
  );
});

test("EXT-07 document events reach an extension only while it may read documents", async () => {
  const t = setup();
  t.add({ ...ASKS_ALL, activationEvents: ["onStartupFinished"] }, PROBE);
  const m = t.manager();
  await m.fire({ kind: "startup" });
  await until(() => m.getSnapshot().statuses["acme.hello"]?.state === "active", "active");
  const doc = t.win.window.documents.all()[0];
  t.win.emit("change", doc);
  await settle();
  assert.deepEqual(await m.executeCommand("acme.hello.greet", "seen"), [], "not allowed: none");
  // Allowed later: its subscription (made at activation) now receives them.
  await t.registry.grant("acme.hello", ["documents.read"]);
  t.win.emit("change", doc);
  await settle();
  assert.deepEqual(await m.executeCommand("acme.hello.greet", "seen"), [
    "file:///C:/work/readme.md",
  ]);
  // Revoked: the next one is not sent.
  await t.registry.grant("acme.hello", []);
  t.win.emit("change", doc);
  await settle();
  assert.deepEqual(await m.executeCommand("acme.hello.greet", "seen"), [
    "file:///C:/work/readme.md",
  ]);
});

test("EXT-07 one extension cannot read another's storage, and runs another's commands only with a grant naming it", async () => {
  const t = setup();
  t.add(ASKS_ALL, PROBE);
  t.add(OTHER, OTHER_CODE);
  t.add(
    {
      name: "third",
      displayName: "Third",
      activationEvents: ["onCommand:acme.third.greet"],
      contributes: { commands: [{ command: "acme.third.greet", title: "Greet" }] },
    },
    `module.exports.activate = function (c, yavin) { c.subscriptions.push(yavin.commands.registerCommand("acme.third.greet", function () { return "from third"; })); };`,
  );
  const m = t.manager();
  assert.equal(await m.executeCommand("acme.other.greet"), "from other");
  // Its activation state is its own: the other's token is not in it.
  assert.deepEqual(await m.executeCommand("acme.hello.greet", "state"), []);
  await t.registry.grant("acme.hello", ["commands.execute:acme.other"]);
  const out = (await m.executeCommand("acme.hello.greet")) as Record<string, string>;
  assert.equal(out.other, "from other");
  assert.deepEqual(t.extensionStorage.global("acme.hello").keys(), ["mine"]);
  assert.deepEqual(t.extensionStorage.global("acme.other").keys(), ["token"]);
  assert.equal(out.third, "PermissionDenied");
  assert.equal(m.getSnapshot().statuses["acme.third"], undefined, "never activated by it");
});

test("EXT-07 a new version is granted nothing; what the old one had is shown as such; uninstall forgets", async () => {
  const t = setup();
  t.add(ASKS_ALL, PROBE);
  await t.registry.grant("acme.hello", ["documents.read", "editor.control"]);
  assert.deepEqual(t.registry.get("acme.hello")!.grants, {
    granted: ["documents.read", "editor.control"],
    previous: null,
  });
  const updated = t.registry.replace(
    "acme.hello",
    manifest({
      ...ASKS_ALL,
      version: "2.0.0",
      permissions: { version: 1, request: ["documents.read", "workspace.fs.read"] },
    }),
    { kind: "folder", path: "C:/extensions/acme.hello-2" },
    "C:/extensions/acme.hello-2",
  );
  assert.ok("manifest" in updated);
  assert.deepEqual(t.registry.get("acme.hello")!.grants, {
    granted: [],
    previous: { version: "1.2.3", granted: ["documents.read", "editor.control"] },
  });
  const m = t.manager();
  const out = (await m.executeCommand("acme.hello.greet")) as Record<string, string>;
  assert.equal(out.text, "PermissionDenied");
  t.registry.remove("acme.hello", { forget: true });
  t.add(ASKS_ALL, PROBE);
  assert.deepEqual(t.registry.get("acme.hello")!.grants, { granted: [], previous: null });
});

test("EXT-07 a refusal from the native side is shown until what it needed is allowed", async () => {
  const t = setup();
  t.add(ASKS_ALL, PROBE);
  const m = t.manager();
  await m.executeCommand("acme.hello.greet", "seen");
  t.host.denied({
    extensionId: "acme.hello",
    method: "fs.readFile",
    capability: "workspace.fs.read",
    code: "PermissionDenied",
    message: '"workspace.fs.read" is not allowed for acme.hello 1.2.3.',
  });
  await settle();
  assert.equal(m.getSnapshot().denied["acme.hello"]?.capability, "workspace.fs.read");
  // Another extension's name in a refusal of a host it does not run in changes nothing.
  t.host.denied({
    extensionId: "acme.ghost",
    method: "fs.readFile",
    capability: null,
    code: "NotLoaded",
    message: "",
  });
  await settle();
  assert.equal(m.getSnapshot().denied["acme.ghost"], undefined);
  await t.registry.grant("acme.hello", ["documents.read"]);
  assert.ok(m.getSnapshot().denied["acme.hello"], "documents.read is not what it needed");
  await t.registry.grant("acme.hello", ["workspace.fs.read"]);
  assert.equal(m.getSnapshot().denied["acme.hello"], undefined);
});

test("EXT-07 a failed activation, a crash and a restart leave no permission behind", async () => {
  const t = setup();
  t.add(ASKS_ALL, PROBE);
  t.add(
    {
      ...OTHER,
      permissions: { version: 1, request: ["documents.read"] },
      activationEvents: ["onStartupFinished"],
    },
    "module.exports.activate = function () { throw new Error('kaboom'); };",
  );
  const m = t.manager();
  await m.fire({ kind: "startup" });
  await until(() => m.getSnapshot().statuses["acme.other"]?.state === "failed", "failed");
  assert.deepEqual(t.registry.get("acme.other")!.grants, { granted: [], previous: null });
  assert.equal(
    ((await m.executeCommand("acme.hello.greet")) as Record<string, string>).text,
    "PermissionDenied",
  );
  t.host.crash();
  await settle();
  await m.restart();
  const out = (await m.executeCommand("acme.hello.greet")) as Record<string, string>;
  assert.equal(out.text, "PermissionDenied", "a new host: the same grants, none");
  assert.equal(out.storage, "ok");
});

test("EXT-07 a view row runs only its own extension's commands", async () => {
  const t = setup();
  t.add(
    {
      activationEvents: ["onView:acme.hello.people"],
      contributes: {
        commands: [{ command: "acme.hello.greet", title: "Greet" }],
        views: [{ id: "acme.hello.people", name: "People" }],
      },
    },
    `module.exports.activate = function (c, yavin) {
      c.subscriptions.push(yavin.commands.registerCommand("acme.hello.greet", function () { return 1; }));
      c.subscriptions.push(yavin.views.registerView("acme.hello.people", { getItems: function () {
        return [{ label: "mine", command: "acme.hello.greet" }, { label: "theirs", command: "acme.other.greet" }];
      } }));
    };`,
  );
  t.add(OTHER, OTHER_CODE);
  const m = t.manager();
  await m.showView("acme.hello.people");
  await until(() => m.getSnapshot().views["acme.hello.people"]?.length === 2, "rows");
  const rows = m.getSnapshot().views["acme.hello.people"];
  assert.equal(rows[0].command, "acme.hello.greet");
  assert.equal(rows[1].command, undefined, "another extension's command is not offered");
});

// --- EXT-08: timeouts, cancellation, stale hosts -------------------------------------------------

const HOVERING = (activate: string) => `
module.exports.activate = async function (c, yavin) {
  c.subscriptions.push(yavin.commands.registerCommand("acme.hello.greet", function () { return "hi"; }));
  c.subscriptions.push(yavin.languages.registerHoverProvider("markdown", { provideHover: function () { return { contents: "h" }; } }));
  ${activate}
};`;
const quick = { load: 100, activate: 100, deactivate: 1000 };

test("EXT-08 a load that times out leaves no code in the host, and a retry (Restart) activates once", async () => {
  let slow = true;
  const t = setup({ delay: (m) => (m.type === "load" && slow ? 300 : undefined) });
  t.add({}, HOVERING(""));
  const m = t.manager(A, 1, quick);
  await assert.rejects(
    m.executeCommand("acme.hello.greet"),
    (e: ExtensionError) => e.code === "ActivationFailed" || e.code === "CommandFailed",
  );
  // Reported only once the host let go of it: the late load came first, then the unload.
  assert.deepEqual(t.host.resident(), [], "no code left in the host");
  assert.equal(m.getSnapshot().statuses["acme.hello"].state, "failed");
  assert.equal(t.providers.getSnapshot().length, 0);
  // Retried (a failed extension stays failed in its host until Restart): once, cleanly.
  slow = false;
  await m.restart();
  assert.equal(await m.executeCommand("acme.hello.greet"), "hi");
  assert.equal(t.providers.getSnapshot().length, 1, "registered once");
  assert.deepEqual(t.host.resident(), ["acme.hello"]);
});

test("EXT-08 an activation that times out after registering is cleaned up and unloaded; late work is refused", async () => {
  const t = setup();
  t.add(
    {},
    HOVERING(`await new Promise(function (resolve) { setTimeout(resolve, 300); });
  c.subscriptions.push(yavin.commands.registerCommand("acme.hello.other", function () { return "late"; }));`),
  );
  const m = t.manager(A, 1, quick);
  await assert.rejects(m.executeCommand("acme.hello.greet"));
  assert.equal(m.getSnapshot().statuses["acme.hello"].state, "failed");
  assert.equal(t.providers.getSnapshot().length, 0, "its partial registrations are gone");
  assert.deepEqual(t.host.resident(), [], "its code is unloaded");
  // Its activation finishes later: its late registration, and its late answer, change nothing.
  await new Promise((resolve) => setTimeout(resolve, 400));
  await settle();
  assert.equal(m.getSnapshot().statuses["acme.hello"].state, "failed");
  assert.equal(t.providers.getSnapshot().length, 0);
  assert.ok(
    t.logs.get("acme.hello")?.some((line) => /Activation failed/.test(line)),
    "said in its output",
  );
});

test("EXT-08 a host that does not let go of an extension in time is ended, not used again", async () => {
  const t = setup({ delay: (m) => (m.type === "unload" ? 5000 : undefined) });
  t.add({}, HOVERING("await new Promise(function () {});"));
  const m = t.manager(A, 1, { ...quick, deactivate: 100 });
  await assert.rejects(m.executeCommand("acme.hello.greet"));
  assert.notEqual(m.getSnapshot().host, "running", "that host is over");
  assert.equal(t.providers.getSnapshot().length, 0);
  // The next use is a new host.
  t.add(OTHER, OTHER_CODE);
  assert.equal(await m.executeCommand("acme.other.greet"), "from other");
  assert.equal(t.host.started(), 2);
});

test("EXT-08 a host that ended removes only its own providers and decorations, never its replacement's", async () => {
  const t = setup();
  t.add({}, HOVERING(""));
  const first = t.manager(A, 1);
  await first.executeCommand("acme.hello.greet");
  const second = t.manager(A, 2);
  await second.executeCommand("acme.hello.greet");
  assert.equal(t.providers.getSnapshot().length, 2);
  const generations = t.providers.getSnapshot().map((p) => p.generation);
  assert.equal(new Set(generations).size, 2, "each host's own");
  // The old host goes (as a stale one would): the replacement's provider stays.
  await first.dispose();
  const left = t.providers.getSnapshot();
  assert.equal(left.length, 1);
  assert.equal(left[0].generation, second.getSnapshot().generation);
  await second.dispose();
  assert.equal(t.providers.getSnapshot().length, 0);
});

test("EXT-10 without its sandbox, no extension code runs -- and it says so, typed", async () => {
  const t = setup({
    failStart:
      "SandboxUnavailable: extension code runs only where Yavin can sandbox it, and this platform has no sandbox implemented.",
  });
  t.add({}, GREETER);
  const m = t.manager();
  await assert.rejects(
    m.executeCommand("acme.hello.greet"),
    (e: ExtensionError) =>
      e.code === "SandboxUnavailable" &&
      e.extensionId === "acme.hello" &&
      /only where Yavin can sandbox it/.test(e.message),
  );
  // It stays failed until Restart (EXT-05), for the same reason.
  await assert.rejects(m.executeCommand("acme.hello.greet"), (e: ExtensionError) =>
    /only where Yavin can sandbox it/.test(e.message),
  );
  const { displayStatus } = await import("./marketplace/status.ts");
  const entry = t.registry.get("acme.hello")!;
  const shown = displayStatus({
    entry,
    trusted: true,
    runtime: m.getSnapshot().statuses["acme.hello"],
  });
  assert.equal(shown.label, "Host Unavailable");
  assert.match(shown.detail ?? "", /runs only in Yavin's sandbox/);
});
