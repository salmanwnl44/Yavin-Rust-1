/**
 * The window side of a VS Code extension, for behavioural conformance tests (EXT-27). Everything
 * here is Yavin's real code -- the registry, settings, storage, the extension host (`host.ts`)
 * and its manager, the document service with `applyExtensionEdit`, the decoration, provider and
 * status bar stores, the window-focus store, and (EXT-29) the Problems store, the prompt service
 * and the before-save step as the window wires it -- except two doubles: the extension host *process*
 * (the in-process transport, which runs the real `bootstrap.js` and `vscode.js` in this realm),
 * and the native side's checks, which the Rust real-host tests cover. Tests only.
 */
import { readFileSync } from "node:fs";
import { createDocumentService, type DocumentIO, type TextDocument } from "../../documents.ts";
import { createSettingsRegistry } from "../../settings/settings.ts";
import { allProblems, clearProblems, publishProblems } from "../../panel/problems.ts";
import { createPromptService } from "../prompts.ts";
import { createWebviewStore, type WebviewNative } from "../webviews.ts";
import { createWindowFocus } from "../../windowFocus.ts";
import { applyExtensionEdit } from "../documentEdit.ts";
import { documentInfoOf } from "../documentInfo.ts";
import { createInProcessTransport } from "../inProcessHost.ts";
import { createExtensionHostManager } from "../manager.ts";
import { createExtensionRegistry } from "../registry.ts";
import { createExtensionStorage } from "../storage.ts";
import {
  createDecorationStore,
  createProviderRegistry,
  createStatusBarStore,
  type DocumentEvent,
  type DocumentInfo,
  type ExtensionWindow,
  type FileChange,
  type SelectionChange,
} from "../window.ts";
import type { WorkspaceId } from "../../terminalProtocol.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const BOOTSTRAP = read("../../../../src-tauri/crates/ide-plugin-host/src/bootstrap.js");
// As runtime.rs puts it in the bootstrap: the Web globals and Intl (EXT-28), then the layer.
const LAYER = ["web.js", "intl.js", "vscode.js"]
  .map((name) => read(`../../../../src-tauri/crates/ide-plugin-host/src/${name}`))
  .join("\n");

export const FOLDER = "C:/work";
export const ID = "acme.probe";
export const PROBE = "acme.probe.probe-0001";
export const VIEW = "acme.probe.tree-0003";
const WORKSPACE = "file://c:/work" as WorkspaceId;

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

/**
 * The probe extension: its contributed command runs a step of JavaScript (`vscode`, `context`, `T`
 * kept between steps) and returns its value.
 */
export const PROBE_CODE = `
const vscode = require("vscode");
globalThis.T = { events: [] };
exports.activate = function (context) {
  T.context = context;
  context.subscriptions.push(vscode.commands.registerCommand("probe.run", async (step) => {
    const value = await new Function("vscode", "context", "T", "return (async () => {" + step + "})()")(vscode, context, T);
    return value === undefined ? null : JSON.parse(JSON.stringify(value));
  }));
};
`;

/** The probe's manifest, as `vsix.rs` generates one for a VS Code package. */
export function probeManifest(id = ID, events: string[] = []) {
  const [publisher, name] = id.split(".");
  const probe = `${id}.probe-0001`;
  const view = `${id}.tree-0003`;
  return {
    manifestVersion: 1,
    publisher,
    name,
    version: "1.0.0",
    displayName: `Probe ${name}`,
    engines: { yavin: "^2.1.0" },
    main: "extension/out/main.js",
    activationEvents: [`onCommand:${probe}`, `onView:${view}`, ...events],
    permissions: {
      version: 1,
      request: ["documents.edit", "documents.read", "editor.control", "workspace.fs.read"],
    },
    contributes: {
      commands: [{ command: probe, title: "Probe" }],
      views: [{ id: view, name: "Probe tree" }],
    },
    vsix: {
      publisher,
      name,
      vscode: "^1.80.0",
      code: true,
      runtime: {
        api: "vscode",
        level: "1.90.0",
        entry: "main",
        commands: { [probe]: "probe.run" },
        settings: {},
        views: { [view]: "probe.tree" },
        defaults: {},
      },
      supported: ["Its code (main: out/main.js) runs in Yavin's extension sandbox"],
      ignored: [],
      rejected: [],
      signature: "not verified",
    },
  };
}

export function vscodeWorld() {
  const storage = memoryStorage();
  const settings = createSettingsRegistry([], storage);
  const registry = createExtensionRegistry({ settings, storage });
  const extensionStorage = createExtensionStorage(storage);
  const decorations = createDecorationStore();
  const providers = createProviderRegistry();
  const statusBar = createStatusBarStore();
  const notes: [string, string, string][] = [];
  // EXT-29: the Problems store is Yavin's own (one per process): each world starts it empty.
  clearProblems();
  const prompts = createPromptService();
  // EXT-31: the webview store, over a native side that records what it is asked (the real one is
  // tested in Rust: extension_webviews_tests.rs, and in the packaged application).
  const webviewNative = {
    opened: [] as Parameters<WebviewNative["open"]>[0][],
    updates: [] as Parameters<WebviewNative["update"]>[0][],
    closed: [] as string[],
  };
  const webviewWarnings: string[] = [];
  const webviews = createWebviewStore(
    {
      open: async (request) => {
        webviewNative.opened.push(request);
        return `https://yavin-webview.invalid/${request.token}/index.html`;
      },
      update: async (request) => void webviewNative.updates.push(request),
      close: async (token) => void webviewNative.closed.push(token),
    },
    (text) => webviewWarnings.push(text),
    { readyGraceMs: 10 },
  );
  const fileListeners = new Set<(changes: readonly FileChange[]) => void>();
  const selectionListeners = new Set<(change: SelectionChange) => void>();
  const logs = new Map<string, string[]>();

  // Documents: Yavin's document service over an in-memory disk.
  const disk = new Map<string, string>();
  const locked = new Set<string>();
  const io: DocumentIO = {
    read: async (path) => {
      const text = disk.get(path);
      if (text === undefined) throw new Error(`${path} does not exist`);
      return text;
    },
    write: async (path, _expected, content) => void disk.set(path, content),
    create: async (path, content) => void disk.set(path, content),
    readOnly: async (path) => locked.has(path),
  };
  const documents = createDocumentService(io, { base: () => FOLDER });
  let active: TextDocument | null = null;
  let selection = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 };
  const activeListeners = new Set<() => void>();
  const findDoc = (resource: string) =>
    documents.all().find((doc) => documentInfoOf(doc).resourceId === resource);

  // The window's focus, from a source the test controls.
  let hasFocus = true;
  const focusListeners = { focus: new Set<() => void>(), blur: new Set<() => void>() };
  const focus = createWindowFocus({
    hasFocus: () => hasFocus,
    addEventListener: (type, listener) => focusListeners[type].add(listener),
    removeEventListener: (type, listener) => focusListeners[type].delete(listener),
  });

  const window: ExtensionWindow = {
    documents: {
      all: () => documents.all().map(documentInfoOf),
      get: (resource) => {
        const doc = findDoc(resource);
        return doc ? documentInfoOf(doc) : null;
      },
      text: (resource) => findDoc(resource)?.text ?? null,
      subscribe(listener: (event: DocumentEvent, document: DocumentInfo) => void) {
        const last = new Map<string, DocumentInfo>();
        return documents.subscribe((event) => {
          const kind =
            event.type === "opened"
              ? "open"
              : event.type === "changed" || event.type === "reloaded"
                ? "change"
                : event.type === "closed"
                  ? "close"
                  : event.type === "saved"
                    ? "save"
                    : null;
          if (!kind) return;
          const doc = documents.all().find((one) => one.id === event.id);
          const info = doc ? documentInfoOf(doc) : last.get(event.id);
          if (doc) last.set(event.id, documentInfoOf(doc));
          if (kind === "close") last.delete(event.id);
          if (info) listener(kind, info);
        });
      },
      edit: (resource, version, edits) =>
        applyExtensionEdit(documents, findDoc(resource), version, edits),
    },
    editor: {
      active: () => (active ? { document: documentInfoOf(active), selection } : null),
      onActive(listener) {
        activeListeners.add(listener);
        return () => activeListeners.delete(listener);
      },
      onSelection(listener) {
        selectionListeners.add(listener);
        return () => selectionListeners.delete(listener);
      },
      openLocation: async () => undefined,
      setSelection: (range) => ((selection = range), !!active),
      revealRange: () => !!active,
    },
    readFile: async (path) => {
      const text = disk.get(path.replace(/\\/g, "/"));
      if (text === undefined) throw new Error(`Cannot read ${path}`);
      return text;
    },
    focus,
    files: {
      subscribe(listener) {
        fileListeners.add(listener);
        return () => fileListeners.delete(listener);
      },
    },
    prompts: {
      quickPick: (request, signal) => prompts.quickPick(request, signal),
      inputBox: (request, signal) => prompts.inputBox(request, signal),
    },
  };

  const codes = new Map<string, string>();
  const host = createInProcessTransport({
    bootstrap: BOOTSTRAP,
    vscodeLayer: LAYER,
    code: (id) => codes.get(id) ?? null,
    vscode: (id) => {
      const runtime = registry.get(id)?.manifest.vsix?.runtime;
      return runtime
        ? { modules: {}, runtime: { api: "vscode", ...runtime }, main: "extension/out/main.js" }
        : null;
    },
  });
  // Every event the window sends, and to which extension: what reaches an extension's layer,
  // whether or not its code would act on it (EXT-31: a panel's messages go to its owner only).
  const sentEvents: { extensionId: string; event: string; id: unknown }[] = [];
  const transport = {
    async start() {
      const channel = await host.transport.start();
      return {
        ...channel,
        send(text: string) {
          const message = JSON.parse(text) as {
            type?: string;
            extensionId?: string;
            event?: string;
            payload?: { id?: unknown };
          };
          if (message.type === "event")
            sentEvents.push({
              extensionId: String(message.extensionId),
              event: String(message.event),
              id: message.payload?.id,
            });
          return channel.send(text);
        },
      };
    },
  };
  const manager = createExtensionHostManager({
    registry,
    settings,
    storage: extensionStorage,
    workspace: WORKSPACE,
    folder: FOLDER,
    workspaceGeneration: 1,
    transport,
    trusted: async () => true,
    window,
    decorations,
    providers,
    statusBar,
    problems: { publish: publishProblems, clear: clearProblems },
    webviews,
    notify: (level, id, message) => notes.push([level, id, message]),
    channel: (id) => ({
      appendLine: (text: string) => logs.set(id, [...(logs.get(id) ?? []), text]),
    }),
    timeouts: { provider: 1000, command: 3000, activate: 3000 },
  });
  // The window's before-save step (EXT-29), as App.tsx sets it.
  documents.setBeforeSave(async (doc) => {
    const info = documentInfoOf(doc);
    const answers = await manager.willSave(info, "manual");
    if (!answers.length) return;
    const all = answers.flatMap((answer) => answer.edits);
    if (!applyExtensionEdit(documents, findDoc(info.resourceId), info.version, all))
      applyExtensionEdit(documents, findDoc(info.resourceId), info.version, answers[0].edits);
  });

  return {
    registry,
    settings,
    documents,
    decorations,
    providers,
    statusBar,
    notes,
    logs,
    host,
    manager,
    disk,
    locked,
    prompts,
    webviews,
    webviewNative,
    webviewWarnings,
    sentEvents,
    /**
     * EXT-31: a panel's frame, as the window would hold it: attached (its tab in front), its
     * page ready; what it receives, and a way to post as its page would. `ready()` says ready
     * as the bootstrap does, for the page the frame was last given (the panel's revision).
     */
    frame(panelId: string, ready = true) {
      const received: unknown[] = [];
      const window = {
        postMessage: (value: unknown) => void received.push(value),
      } as unknown as Window;
      webviews.attachFrame(panelId, window);
      const post = (kind: string, payload: unknown) =>
        webviews.frameMessage(panelId, { yavinWebview: 1, kind, payload });
      const sayReady = () =>
        post("ready", webviews.getSnapshot().find((panel) => panel.id === panelId)?.revision);
      if (ready) sayReady();
      return { received, post, window, ready: sayReady };
    },
    /** The Problems view's entries (Yavin's own store). */
    problems: () => allProblems(),
    /** The native watcher reports a batch. */
    changeFiles(changes: FileChange[]) {
      for (const listener of [...fileListeners]) listener(changes);
    },
    /** The user moves the selection in the active editor. */
    select(change: SelectionChange) {
      // As the editor: the active document's selection only.
      if (active && documentInfoOf(active).resourceId === change.resource)
        selection = change.selections[0];
      for (const listener of [...selectionListeners]) listener(change);
    },
    /**
     * Installs a VS Code extension (the probe, or another id's probe) with `code`; `events`
     * are activation events beyond its command and view (`onStartupFinished`, ...).
     */
    install(id = ID, code = PROBE_CODE, events: string[] = []) {
      codes.set(id, code);
      return registry.add(
        probeManifest(id, events),
        { kind: "folder", path: `C:/extensions/${id}` },
        `C:/extensions/${id}`,
      );
    },
    grant: (capabilities: string[], id = ID) => registry.grant(id, capabilities),
    /** Opens a file of the workspace as a document, and makes it the active editor. */
    async open(name: string, text: string, makeActive = true) {
      const path = `${FOLDER}/${name}`;
      disk.set(path, text);
      const doc = (await documents.open(path))!;
      if (makeActive) {
        active = doc;
        for (const listener of [...activeListeners]) listener();
      }
      return doc;
    },
    setActive(doc: TextDocument | null) {
      active = doc;
      for (const listener of [...activeListeners]) listener();
    },
    setSelection(range: typeof selection) {
      selection = range;
    },
    /** The OS gives the focus to another application, or back. */
    blur() {
      hasFocus = false;
      for (const listener of [...focusListeners.blur]) listener();
    },
    focus() {
      hasFocus = true;
      for (const listener of [...focusListeners.focus]) listener();
    },
    /** Runs a step in the probe of `id` (activating it first). */
    step: (code: string, id = ID) => manager.executeCommand(`${id}.probe-0001`, code),
    /** Lets the extension's queued work (events, timers' zero delays) and the window's settle. */
    settle: async (id = ID) => {
      for (let i = 0; i < 3; i++)
        await manager.executeCommand(
          `${id}.probe-0001`,
          "await new Promise((r) => setTimeout(r, 0));",
        );
    },
  };
}
