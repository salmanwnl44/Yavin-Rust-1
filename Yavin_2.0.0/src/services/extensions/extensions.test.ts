import assert from "node:assert/strict";
import test from "node:test";
import { createSettingsRegistry } from "../settings/settings.ts";
import type { WorkspaceId } from "../terminalProtocol.ts";
import type { ExtensionModule, ViewItem } from "./api.ts";
import { ExtensionError } from "./errors.ts";
import { canMoveExtension, createExtensionHost } from "./host.ts";
import { EXTENSION_API, readManifest, satisfies } from "./manifest.ts";
import { createExtensionRegistry, DISABLED_KEY } from "./registry.ts";
import {
  createExtensionStorage,
  globalStorageKey,
  STORAGE_LIMIT,
  workspaceStorageKey,
} from "./storage.ts";

const A = "file://c:/a" as WorkspaceId;
const B = "file://c:/b" as WorkspaceId;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A Storage in memory, for the registry and storage. */
function memoryStorage(seed: Record<string, string> = {}): Storage & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return {
    data,
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
  engines: { yavin: "^1.0.0" },
  main: "./out/extension.js",
  activationEvents: ["onCommand:acme.hello.greet"],
  contributes: {
    commands: [{ command: "acme.hello.greet", title: "Greet", category: "Hello" }],
    keybindings: [{ command: "acme.hello.greet", key: "Mod+Alt+g" }],
    configuration: {
      properties: {
        "acme.hello.loud": { type: "boolean", default: false, description: "Greet loudly." },
        "acme.hello.name": { type: "string", default: "world", description: "Who to greet." },
        "acme.hello.mood": { enum: ["calm", "bright"], default: "calm", description: "Mood." },
      },
    },
    views: [{ id: "acme.hello.people", name: "People", location: "sidebar" }],
    menus: {
      "view/title": [{ command: "acme.hello.greet", view: "acme.hello.people" }],
      commandPalette: [{ command: "acme.hello.greet", when: true }],
    },
  },
  ...overrides,
});

// --- Manifest ----------------------------------------------------------------------------------

test("a valid manifest is read whole; identity is publisher.name, never the display name", () => {
  const result = readManifest(manifest());
  assert.ok(result.ok, JSON.stringify(!result.ok && result.problems));
  const m = result.manifest;
  assert.equal(m.id, "acme.hello");
  assert.equal(m.displayName, "Hello");
  assert.deepEqual(m.activationEvents, [{ kind: "command", id: "acme.hello.greet" }]);
  assert.equal(m.contributes.commands[0].category, "Hello");
  assert.equal(m.contributes.keybindings[0].key, "Mod+Alt+g");
  assert.deepEqual(
    m.contributes.settings.map((s) => [s.id, s.type, s.default]),
    [
      ["acme.hello.loud", "boolean", false],
      ["acme.hello.name", "string", "world"],
      ["acme.hello.mood", "enum", "calm"],
    ],
  );
  assert.equal(m.contributes.views[0].location, "sidebar");
  assert.equal(m.contributes.menus.length, 2);
});

test("invalid ids, versions, engines, paths and contributions are rejected with every reason", () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ publisher: "Acme Corp" }, /publisher/],
    [{ name: "../x" }, /name/],
    [{ version: "1.2" }, /semantic version/],
    [{ engines: { yavin: "^2.0.0" } }, /Needs extension API \^2\.0\.0/],
    [{ engines: { yavin: "whenever" } }, /not a range/],
    [{ main: "../../etc/evil.js" }, /inside the extension's folder/],
    [{ main: "C:\\evil.js" }, /inside the extension's folder/],
    [{ extensionDependencies: ["acme.other"] }, /not supported yet/],
    [{ manifestVersion: 9 }, /manifest version/],
    [{ contributes: { commands: [{ command: "other.cmd", title: "x" }] } }, /acme\.hello\.<name>/],
    [
      {
        contributes: {
          commands: [
            { command: "acme.hello.a", title: "A" },
            { command: "acme.hello.a", title: "A again" },
          ],
        },
      },
      /contributed twice/,
    ],
    [
      { contributes: { keybindings: [{ command: "acme.hello.greet", key: "Ctrl+Hyper+Q" }] } },
      /not a shortcut|commands/,
    ],
    [
      {
        contributes: {
          configuration: {
            properties: { "acme.hello.x": { type: "number", default: "1", description: "x" } },
          },
        },
      },
      /valid number/,
    ],
    [
      {
        contributes: {
          configuration: {
            properties: { "other.x": { type: "boolean", default: true, description: "x" } },
          },
        },
      },
      /setting is/,
    ],
    [
      { contributes: { views: [{ id: "acme.hello.v", name: "V", location: "floating" }] } },
      /sidebar/,
    ],
  ];
  for (const [overrides, reason] of cases) {
    const result = readManifest(manifest(overrides));
    assert.equal(result.ok, false, JSON.stringify(overrides));
    if (!result.ok)
      assert.ok(
        result.problems.some((problem) => reason.test(`${problem.field}: ${problem.message}`)),
        `${JSON.stringify(overrides)} -> ${JSON.stringify(result.problems)}`,
      );
  }
  assert.equal(readManifest("not an object").ok, false);
});

test("unknown fields and contribution points are warnings, never a crash", () => {
  const result = readManifest(
    manifest({
      sponsor: "someone",
      contributes: { commands: [], themes: [{}], menus: { "scm/title": [] } },
      activationEvents: ["onDebugResolve:python"],
    }),
  );
  assert.ok(result.ok);
  const warnings = result.warnings.map((w) => w.field).sort();
  assert.deepEqual(warnings, [
    "activationEvents[0]",
    "contributes.menus.scm/title",
    "contributes.themes",
    "sponsor",
  ]);
});

test("engine ranges: ^, ~, >=, exact and *", () => {
  assert.equal(satisfies("1.2.3", "^1.0.0"), true);
  assert.equal(satisfies("2.0.0", "^1.0.0"), false);
  assert.equal(satisfies("1.2.3", "~1.2.0"), true);
  assert.equal(satisfies("1.3.0", "~1.2.0"), false);
  assert.equal(satisfies("1.0.0", ">=0.9.0"), true);
  assert.equal(satisfies("1.0.0", "1.0.0"), true);
  assert.equal(satisfies("1.0.0", "*"), true);
  assert.equal(satisfies(EXTENSION_API, "^1.0.0"), true);
});

// --- Registry ----------------------------------------------------------------------------------

function setup(options: { trusted?: boolean; storage?: Storage } = {}) {
  const settings = createSettingsRegistry([], null);
  const storage = options.storage ?? memoryStorage();
  const registry = createExtensionRegistry({ settings, storage });
  const extensionStorage = createExtensionStorage(storage);
  const notes: [string, string, string][] = [];
  const logs = new Map<string, string[]>();
  let trusted = options.trusted ?? true;
  let generation = 0;
  const host = (workspace: WorkspaceId | null = A) =>
    createExtensionHost({
      registry,
      settings,
      storage: extensionStorage,
      workspace,
      folder: workspace ? "C:/a" : null,
      generation: ++generation,
      trusted: async () => trusted,
      notify: (level, id, message) => notes.push([level, id, message]),
      channel: (id) => ({
        appendLine: (text: string) => logs.set(id, [...(logs.get(id) ?? []), text]),
      }),
    });
  return {
    settings,
    storage,
    registry,
    host,
    notes,
    logs,
    setTrusted: (v: boolean) => (trusted = v),
  };
}

/** A bundled module whose activation is recorded, with a greet command and a view. */
function helloModule(record: string[] = [], extra: Partial<ExtensionModule> = {}): ExtensionModule {
  return {
    activate(context, yavin) {
      record.push("activate");
      context.subscriptions.push(
        yavin.commands.registerCommand("acme.hello.greet", (who) => {
          record.push(`greet:${String(who)}`);
          return `hello ${String(who ?? yavin.workspace.getConfiguration("acme.hello").get("name"))}`;
        }),
      );
      context.subscriptions.push({ dispose: () => record.push("disposed") });
    },
    deactivate() {
      record.push("deactivate");
    },
    ...extra,
  };
}

test("register, reject a duplicate, unregister; contributions follow enabled state", () => {
  const t = setup();
  const added = t.registry.add(manifest(), { kind: "bundled", module: helloModule() }, "bundled");
  assert.ok("manifest" in added);
  const again = t.registry.add(manifest(), { kind: "bundled", module: helloModule() }, "elsewhere");
  assert.ok("problems" in again);
  assert.match(again.problems[0], /already registered/);
  let snap = t.registry.getSnapshot();
  assert.deepEqual(
    snap.commands.map((c) => [c.command, c.key, c.palette]),
    [["acme.hello.greet", "Mod+Alt+g", true]],
  );
  assert.deepEqual(
    snap.views.map((v) => [v.id, v.actions]),
    [["acme.hello.people", ["acme.hello.greet"]]],
  );
  // Settings go to the SettingsRegistry, its owner, namespaced and in the extension's section.
  assert.deepEqual(
    t.settings.definitions.map((d) => [d.id, d.section]),
    [
      ["acme.hello.loud", "Hello"],
      ["acme.hello.name", "Hello"],
      ["acme.hello.mood", "Hello"],
    ],
  );

  t.registry.setEnabled("acme.hello", false);
  snap = t.registry.getSnapshot();
  assert.equal(snap.commands.length, 0);
  assert.equal(t.settings.definitions.length, 0, "a disabled extension's settings are withdrawn");
  assert.match(t.storage.getItem(DISABLED_KEY)!, /acme\.hello/);
  // Remembered: a new window starts it disabled.
  const later = createExtensionRegistry({
    settings: createSettingsRegistry([], null),
    storage: t.storage,
  });
  later.add(manifest(), { kind: "bundled", module: helloModule() }, "bundled");
  assert.equal(later.get("acme.hello")?.enabled, false);

  t.registry.setEnabled("acme.hello", true);
  t.registry.remove("acme.hello");
  assert.equal(t.registry.getSnapshot().extensions.length, 0);
  assert.equal(t.settings.definitions.length, 0);
});

test("an extension cannot replace another's (or an existing) setting", () => {
  const t = setup();
  t.settings.register({
    id: "acme.hello.loud",
    title: "Taken",
    description: "",
    section: "Other",
    scopes: ["user"],
    default: true,
    parse: (v: unknown) => (typeof v === "boolean" ? v : undefined),
    control: { kind: "boolean" },
  });
  const added = t.registry.add(manifest(), { kind: "bundled", module: helloModule() }, "bundled");
  assert.ok("manifest" in added);
  assert.ok(added.warnings.some((w) => /acme\.hello\.loud: not added/.test(w)));
  assert.equal(t.settings.definitions.find((d) => d.id === "acme.hello.loud")?.section, "Other");
});

test("a rejected manifest is kept with its reasons and contributes nothing", () => {
  const t = setup();
  const result = t.registry.add(
    { publisher: "acme" },
    { kind: "folder", path: "C:/ext/broken" },
    "C:/ext/broken",
  );
  assert.ok("problems" in result);
  assert.equal(t.registry.getSnapshot().rejected.length, 1);
  assert.equal(t.registry.getSnapshot().commands.length, 0);
});

// --- Lifecycle, lazy activation, commands ------------------------------------------------------

test("lazy: nothing runs until its command is invoked; then activate once, run, deactivate, dispose", async () => {
  const t = setup();
  const record: string[] = [];
  t.registry.add(manifest(), { kind: "bundled", module: helloModule(record) }, "bundled");
  const host = t.host();
  await host.fire({ kind: "startup" });
  await host.fire({ kind: "workspace" });
  assert.deepEqual(record, [], "not activated at startup: it waits for its command");

  assert.equal(await host.executeCommand("acme.hello.greet", "ada"), "hello ada");
  assert.equal(
    await host.executeCommand("acme.hello.greet"),
    "hello world",
    "its own settings, by default",
  );
  assert.deepEqual(record, ["activate", "greet:ada", "greet:undefined"]);
  assert.equal(host.getSnapshot().statuses["acme.hello"].state, "active");
  assert.ok((host.getSnapshot().statuses["acme.hello"].activationMs ?? -1) >= 0);

  // Concurrent activations join one.
  await Promise.all([host.activate("acme.hello"), host.activate("acme.hello")]);
  assert.equal(record.filter((r) => r === "activate").length, 1);

  await host.dispose();
  assert.deepEqual(record.slice(-2), ["deactivate", "disposed"]);
  assert.equal(host.getSnapshot().statuses["acme.hello"].state, "disposed");
  await assert.rejects(
    host.executeCommand("acme.hello.greet"),
    (e: ExtensionError) => e.code === "HostDisposed",
  );
});

test("a startup extension activates at startup; one failing does not stop another", async () => {
  const t = setup();
  const record: string[] = [];
  t.registry.add(
    manifest({ name: "boom", activationEvents: ["onStartupFinished"], contributes: {} }),
    { kind: "bundled", module: { activate: () => Promise.reject(new Error("kaboom")) } },
    "bundled",
  );
  t.registry.add(
    manifest({ name: "fine", activationEvents: ["onStartupFinished"], contributes: {} }),
    { kind: "bundled", module: { activate: () => void record.push("fine") } },
    "bundled",
  );
  const host = t.host();
  await host.fire({ kind: "startup" });
  const statuses = host.getSnapshot().statuses;
  assert.equal(statuses["acme.boom"].state, "failed");
  assert.match(statuses["acme.boom"].reason!, /kaboom/);
  assert.equal(statuses["acme.fine"].state, "active");
  assert.deepEqual(record, ["fine"]);
  assert.ok(t.logs.get("acme.boom")?.some((line) => /kaboom/.test(line)));
  // A failed extension is not retried behind the user's back.
  await assert.rejects(
    host.activate("acme.boom"),
    (e: ExtensionError) => e.code === "ActivationFailed",
  );
});

test("handler failure, unknown and unregistered commands, and foreign registrations are typed errors", async () => {
  const t = setup();
  t.registry.add(
    manifest(),
    {
      kind: "bundled",
      module: {
        activate(context, yavin) {
          context.subscriptions.push(
            yavin.commands.registerCommand("acme.hello.greet", () => {
              throw new Error("handler broke");
            }),
          );
          assert.throws(
            () => yavin.commands.registerCommand("other.ext.cmd", () => 1),
            (e: ExtensionError) => e.code === "NotOwned",
          );
          assert.throws(
            () => yavin.commands.registerCommand("acme.hello.greet", () => 2),
            (e: ExtensionError) => e.code === "DuplicateCommand",
          );
          assert.throws(
            () => yavin.workspace.getConfiguration("editor"),
            (e: ExtensionError) => e.code === "NotOwned",
          );
        },
      },
    },
    "bundled",
  );
  t.registry.add(
    manifest({
      name: "silent",
      activationEvents: [],
      contributes: { commands: [{ command: "acme.silent.go", title: "Go" }] },
    }),
    { kind: "bundled", module: { activate() {} } },
    "bundled",
  );
  const host = t.host();
  await assert.rejects(host.executeCommand("acme.hello.greet"), (e: ExtensionError) => {
    assert.equal(e.code, "CommandFailed");
    assert.equal(e.extensionId, "acme.hello");
    assert.match(e.message, /handler broke/);
    return true;
  });
  await assert.rejects(
    host.executeCommand("nobody.cmd"),
    (e: ExtensionError) => e.code === "UnknownCommand",
  );
  await assert.rejects(host.executeCommand("acme.silent.go"), (e: ExtensionError) => {
    assert.equal(e.code, "CommandFailed");
    assert.match(e.message, /did not register/);
    return true;
  });
});

test("disposal failures are logged and do not stop the rest", async () => {
  const t = setup();
  const record: string[] = [];
  t.registry.add(
    manifest({ activationEvents: ["onStartupFinished"] }),
    {
      kind: "bundled",
      module: {
        activate(context) {
          context.subscriptions.push({ dispose: () => record.push("first") });
          context.subscriptions.push({
            dispose: () => {
              throw new Error("stuck");
            },
          });
        },
        deactivate: () => {
          throw new Error("refuses");
        },
      },
    },
    "bundled",
  );
  const host = t.host();
  await host.fire({ kind: "startup" });
  await host.dispose();
  assert.deepEqual(record, ["first"]);
  const log = t.logs.get("acme.hello")!.join("\n");
  assert.match(log, /Deactivation failed: refuses/);
  assert.match(log, /failed to dispose: stuck/);
});

test("only the lifecycle's own moves are allowed", () => {
  assert.ok(canMoveExtension("registered", "activating"));
  assert.ok(canMoveExtension("activating", "failed"));
  assert.ok(canMoveExtension("active", "deactivating"));
  for (const [from, to] of [
    ["registered", "active"],
    ["active", "activating"],
    ["disposed", "activating"],
    ["failed", "active"],
  ] as const)
    assert.equal(canMoveExtension(from, to), false, `${from} -> ${to}`);
});

// --- Trust and runtimes ------------------------------------------------------------------------

test("an untrusted folder runs no extension code; trusting it lets it activate", async () => {
  const t = setup({ trusted: false });
  const record: string[] = [];
  t.registry.add(manifest(), { kind: "bundled", module: helloModule(record) }, "bundled");
  const host = t.host();
  await assert.rejects(host.executeCommand("acme.hello.greet"), (e: ExtensionError) => {
    assert.equal(e.code, "TrustRequired");
    assert.match(e.message, /Manage Workspace Trust/);
    return true;
  });
  assert.deepEqual(record, []);
  const status = host.getSnapshot().statuses["acme.hello"];
  assert.equal(status.state, "registered", "still registered, waiting");
  assert.match(status.reason!, /not trusted/);
  // Its declarative contributions stay.
  assert.equal(t.registry.getSnapshot().commands.length, 1);
  t.setTrusted(true);
  assert.equal(await host.executeCommand("acme.hello.greet", "x"), "hello x");
});

test("an extension declaring untrusted support activates in an untrusted folder", async () => {
  const t = setup({ trusted: false });
  const record: string[] = [];
  t.registry.add(
    manifest({ capabilities: { untrustedWorkspaces: true } }),
    { kind: "bundled", module: helloModule(record) },
    "bundled",
  );
  await t.host().executeCommand("acme.hello.greet", "y");
  assert.deepEqual(record, ["activate", "greet:y"]);
});

test("an installed extension's code is never run; a declarative one needs no runtime", async () => {
  const t = setup();
  const added = t.registry.add(
    manifest(),
    { kind: "folder", path: "C:/ext/hello" },
    "C:/ext/hello",
  );
  assert.ok("manifest" in added && added.warnings.some((w) => /Its code is not run/.test(w)));
  const host = t.host();
  await assert.rejects(
    host.executeCommand("acme.hello.greet"),
    (e: ExtensionError) => e.code === "UnsupportedRuntime",
  );
  assert.match(
    host.getSnapshot().statuses["acme.hello"].reason!,
    /does not run code from installed extensions/,
  );

  const declarative = manifest({
    name: "decl",
    main: undefined,
    activationEvents: [],
    contributes: {
      configuration: {
        properties: { "acme.decl.on": { type: "boolean", default: true, description: "On." } },
      },
    },
  });
  t.registry.add(declarative, { kind: "folder", path: "C:/ext/decl" }, "C:/ext/decl");
  await host.activate("acme.decl");
  assert.ok(t.settings.definitions.some((d) => d.id === "acme.decl.on"));
});

test("a disabled extension does not activate", async () => {
  const t = setup();
  t.registry.add(manifest(), { kind: "bundled", module: helloModule() }, "bundled");
  t.registry.setEnabled("acme.hello", false);
  await assert.rejects(
    t.host().activate("acme.hello"),
    (e: ExtensionError) => e.code === "Disabled",
  );
});

// --- Views ---------------------------------------------------------------------------------------

test("a view is filled by its provider on demand, refreshed, and gone with its extension", async () => {
  const t = setup();
  let people: ViewItem[] = [{ label: "Ada" }];
  let changed: () => void = () => {};
  t.registry.add(
    manifest(),
    {
      kind: "bundled",
      module: {
        activate(context, yavin) {
          context.subscriptions.push(
            yavin.views.registerView("acme.hello.people", {
              getItems: () => people,
              onDidChange: (listener) => ((changed = listener), { dispose() {} }),
            }),
          );
          assert.throws(
            () => yavin.views.registerView("acme.hello.people", { getItems: () => [] }),
            (e: ExtensionError) => e.code === "DuplicateView",
          );
          assert.throws(
            () => yavin.views.registerView("other.view", { getItems: () => [] }),
            (e: ExtensionError) => e.code === "NotOwned",
          );
        },
      },
    },
    "bundled",
  );
  const host = t.host();
  assert.equal(host.getSnapshot().views["acme.hello.people"], undefined);
  await host.showView("acme.hello.people");
  await settle();
  assert.deepEqual(host.getSnapshot().views["acme.hello.people"], [{ label: "Ada" }]);
  people = [
    { label: "Ada" },
    { label: "Grace", description: "admiral", command: "acme.hello.greet" },
  ];
  changed();
  await settle();
  assert.equal(host.getSnapshot().views["acme.hello.people"].length, 2);
  await host.dispose();
  assert.equal(host.getSnapshot().views["acme.hello.people"], undefined);
});

// --- Settings and storage ----------------------------------------------------------------------

test("an extension reads and hears only its own settings", async () => {
  const t = setup();
  const heard: string[] = [];
  let read: unknown;
  t.registry.add(
    manifest({ activationEvents: ["onStartupFinished"] }),
    {
      kind: "bundled",
      module: {
        activate(context, yavin) {
          context.subscriptions.push(
            yavin.workspace.onDidChangeConfiguration((key) => heard.push(key)),
          );
          read = yavin.workspace.getConfiguration("acme.hello").get("mood");
        },
      },
    },
    "bundled",
  );
  const host = t.host();
  await host.fire({ kind: "startup" });
  assert.equal(read, "calm");
  const mood = t.registry.settingDefinition("acme.hello.mood")!;
  t.settings.set(mood, "workspace", "bright", A);
  assert.deepEqual(heard, ["mood"]);
  await host.dispose();
  t.settings.set(mood, "workspace", "calm", A);
  assert.deepEqual(heard, ["mood"], "nothing after the workspace closed");
});

test("storage: global and workspace scopes, one extension's alone, bounded, corrupt kept aside", async () => {
  const storage = memoryStorage({
    [globalStorageKey("acme.broken")]: "{not json",
    [globalStorageKey("acme.future")]: JSON.stringify({ version: 9, values: { a: 1 } }),
  });
  const reports: string[] = [];
  const store = createExtensionStorage(storage, (id, message) => reports.push(`${id}: ${message}`));
  const hello = store.global("acme.hello");
  await hello.update("count", 3);
  assert.equal(store.global("acme.hello").get("count"), 3);
  assert.equal(
    store.global("acme.other").get("count"),
    undefined,
    "another extension's state is not this one's",
  );
  const inA = store.workspace(A, "acme.hello");
  await inA.update("open", ["x"]);
  assert.equal(store.workspace(B, "acme.hello").get("open"), undefined, "nor another workspace's");
  assert.deepEqual(JSON.parse(storage.getItem(workspaceStorageKey(A, "acme.hello"))!), {
    version: 1,
    values: { open: ["x"] },
  });
  await assert.rejects(
    hello.update("fn", () => 1),
    (e: ExtensionError) => e.code === "StorageLimit",
  );
  await assert.rejects(
    hello.update("big", "x".repeat(STORAGE_LIMIT)),
    (e: ExtensionError) => e.code === "StorageLimit",
  );
  assert.equal(hello.get("big"), undefined, "a refused value is not kept");
  await hello.update("count", undefined);
  assert.deepEqual(hello.keys(), []);

  const broken = store.global("acme.broken");
  assert.deepEqual(broken.keys(), []);
  assert.equal(storage.getItem(`${globalStorageKey("acme.broken")}.corrupt`), "{not json");
  const future = store.global("acme.future");
  assert.equal(future.get("a"), 1);
  await assert.rejects(future.update("a", 2), (e: ExtensionError) => e.code === "StorageReadOnly");
  assert.ok(reports.some((r) => /acme\.broken: .*corrupt/.test(r)));
});

// --- Workspace isolation, messages ---------------------------------------------------------------

test("A → B: an extension of A that acts after A closed reaches nothing in B", async () => {
  const t = setup();
  let late: (() => void) | null = null;
  t.registry.add(
    manifest({ activationEvents: ["onWorkspace"] }),
    {
      kind: "bundled",
      module: {
        activate(context, yavin) {
          late = () => {
            yavin.window.showInformationMessage(`from ${context.workspaceFolder}`);
            yavin.commands.registerCommand("acme.hello.greet", () => "late");
          };
        },
      },
    },
    "bundled",
  );
  const a = t.host(A);
  await a.fire({ kind: "workspace" });
  await a.dispose();
  const b = t.host(B);
  late!();
  assert.deepEqual(t.notes, []);
  // B's handler table is its own: A's late registration is not there.
  await assert.rejects(b.executeCommand("acme.hello.greet"), (e: ExtensionError) =>
    /did not register/.test(e.message),
  );
  assert.equal(b.getSnapshot().generation, a.getSnapshot().generation + 1);
});

test("an extension's messages are shown, then muted when it floods", async () => {
  const t = setup();
  t.registry.add(
    manifest({ activationEvents: ["onStartupFinished"] }),
    {
      kind: "bundled",
      module: {
        activate(_context, yavin) {
          yavin.window.showWarningMessage("careful");
          for (let i = 0; i < 50; i++) yavin.window.showInformationMessage(`spam ${i}`);
        },
      },
    },
    "bundled",
  );
  await t.host().fire({ kind: "startup" });
  assert.equal(t.notes.length, 20);
  assert.deepEqual(t.notes[0], ["warning", "acme.hello", "careful"]);
  assert.ok(t.logs.get("acme.hello")!.some((line) => /Too many messages/.test(line)));
});

test("a language activation event activates its extension once", async () => {
  const t = setup();
  const record: string[] = [];
  t.registry.add(
    manifest({ activationEvents: ["onLanguage:python"], contributes: {} }),
    { kind: "bundled", module: { activate: () => void record.push("py") } },
    "bundled",
  );
  const host = t.host();
  await host.fire({ kind: "language", id: "typescript" });
  assert.deepEqual(record, []);
  await host.fire({ kind: "language", id: "python" });
  await host.fire({ kind: "language", id: "python" });
  assert.deepEqual(record, ["py"]);
});

// --- The sample, keybindings, discovery ----------------------------------------------------------

test("the bundled sample is a valid extension and works end to end through a host", async () => {
  const { HELLO_WORLD_MANIFEST, helloWorld } =
    await import("../../extensions/samples/helloWorld.ts");
  const t = setup();
  const added = t.registry.add(
    HELLO_WORLD_MANIFEST,
    { kind: "bundled", module: helloWorld },
    "bundled",
  );
  assert.ok("manifest" in added, JSON.stringify(added));
  assert.deepEqual(added.warnings, []);
  const host = t.host();
  assert.equal(await host.executeCommand("yavin-samples.hello-world.greet"), "Hello, world!");
  await host.showView("yavin-samples.hello-world.greetings");
  await settle();
  assert.deepEqual(host.getSnapshot().views["yavin-samples.hello-world.greetings"], [
    { label: "Hello, world!", description: "#1" },
  ]);
  assert.deepEqual(t.notes, [["info", "yavin-samples.hello-world", "Hello, world!"]]);
  await host.executeCommand("yavin-samples.hello-world.reset");
  await settle();
  assert.equal(
    host.getSnapshot().views["yavin-samples.hello-world.greetings"][0].label,
    "No greetings yet",
  );
});

test("contributed shortcuts never take Yavin's own, and the first extension keeps a shared one", async () => {
  const { resolveKeybindings } = await import("./contributions.ts");
  const command = (name: string, key: string | null, extensionId = "acme.a") => ({
    command: `${extensionId}.${name}`,
    title: name,
    category: null,
    extensionId,
    palette: true,
    key,
  });
  const { shortcuts, conflicts } = resolveKeybindings(
    [
      command("save", "Mod+s"),
      command("go", "Mod+Alt+g"),
      command("also", "alt+MOD+G", "acme.b"),
      command("none", null),
    ],
    ["Mod+s", "Mod+Shift+p"],
  );
  assert.deepEqual([...shortcuts], [["acme.a.go", "Mod+Alt+g"]]);
  assert.deepEqual(
    conflicts.map((c) => [c.command, c.reason.replace(/ .*/, "")]),
    [
      ["acme.a.save", "Mod+s"],
      ["acme.b.also", "alt+MOD+G"],
    ],
  );
  assert.match(conflicts[0].reason, /Yavin's own/);
  assert.match(conflicts[1].reason, /already used by acme\.a\.go/);
});

test("discovery registers installed manifests, reports unreadable ones, and reloads without duplicates", async () => {
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
        folder: "C:/data/extensions/empty",
        manifest: null,
        error: "It has no yavin-extension.json.",
      },
      {
        folder: "C:/data/extensions/copy",
        manifest: JSON.stringify(manifest({ main: undefined })),
        error: null,
      },
    ],
  };
  const report = await discoverExtensions(t.registry, async () => found);
  assert.equal(report.registered, 1);
  assert.equal(report.rejected, 3);
  const snap = t.registry.getSnapshot();
  assert.equal(snap.extensions[0].source.kind, "folder");
  assert.deepEqual(
    snap.rejected.map((r) => [
      r.origin.split("/").pop(),
      /JSON|no yavin|already registered/.test(r.problems[0]),
    ]),
    [
      ["broken", true],
      ["empty", true],
      ["copy", true],
    ],
  );
  const again = await rediscoverExtensions(t.registry, async () => found);
  assert.equal(again.registered, 1);
  assert.equal(t.registry.getSnapshot().extensions.length, 1);
  assert.equal(t.registry.getSnapshot().rejected.length, 3);
});

test("the settings registry takes later definitions, never replaces one, and gives them stored values", () => {
  const storage = memoryStorage({
    "yavin.settings.user": JSON.stringify({ version: 1, values: { "acme.hello.loud": true } }),
  });
  const settings = createSettingsRegistry([], storage);
  let told = 0;
  settings.onDefinitions(() => told++);
  const registry = createExtensionRegistry({ settings, storage });
  registry.add(manifest(), { kind: "bundled", module: helloModule() }, "bundled");
  assert.equal(told, 3);
  // A value stored before the extension was known applies once its setting is.
  assert.equal(settings.get(registry.settingDefinition("acme.hello.loud")!, null), true);
  assert.throws(
    () => settings.register(registry.settingDefinition("acme.hello.loud")!),
    /already a setting/,
  );
});
