import { createConnection } from "./jsonrpc.ts";
import type { Connection, MessageChannel, RequestOptions } from "./jsonrpc.ts";
import { encodingOf } from "./positions.ts";
import type { PositionEncoding } from "./positions.ts";
import type {
  InitializeResult,
  PublishDiagnosticsParams,
  ServerCapabilities,
  WorkspaceEdit,
} from "./protocol.ts";
import { settingAt } from "./registry.ts";
import type { LanguageServerDefinition } from "./registry.ts";

/**
 * One language server process and the protocol conversation with it:
 *
 * ```text
 * starting -> initializing -> ready -> stopping -> stopped
 *     |            |            |
 *     +------------+------------+--> crashed (the process went away) / failed (never came up)
 * unavailable: not installed          restarting: between a crash and the next start (manager)
 * ```
 *
 * It knows nothing about documents -- the manager decides what the server is told -- and
 * nothing about Monaco. What a server asks of the client (configuration, applying an edit,
 * publishing diagnostics) is handed to the `ClientHandlers` it was given.
 */

export type ServerState =
  | "starting"
  | "initializing"
  | "ready"
  | "stopping"
  | "stopped"
  | "crashed"
  | "restarting"
  | "failed"
  | "unavailable"
  | "disabled";

/** How a server process is reached: natively (`lsp.rs`), or an in-memory fake in tests. */
export interface ServerTransport {
  /** Starts server `serverId` in folder `root`; rejects when it cannot run at all. */
  start(serverId: string, root: string): Promise<ServerChannel>;
}

export interface ServerChannel extends MessageChannel {
  /** Ends the process (after, or instead of, a polite shutdown). */
  stop(): Promise<void> | void;
  /** Where it runs from, for messages. */
  program: string;
}

export interface WorkspaceFolderInfo {
  uri: string;
  name: string;
  path: string;
}

export interface ClientHandlers {
  diagnostics(params: PublishDiagnosticsParams): void;
  /** `workspace/applyEdit`: the server wants the workspace changed (a command's result). */
  applyEdit(
    edit: WorkspaceEdit,
    label: string | undefined,
  ): Promise<{ applied: boolean; failureReason?: string }>;
  log(text: string, level: "error" | "warning" | "info" | "log"): void;
  /** The server asked for something to be refreshed (semantic tokens, inlay hints...). */
  refresh?(what: string): void;
}

/** A transport's error for a server that is not installed starts with this. */
export const NOT_INSTALLED = "not-installed:";

const SHUTDOWN_TIMEOUT = 2_000;
const EXIT_TIMEOUT = 2_000;

/** A server's request to hear about files (`workspace/didChangeWatchedFiles` registration). */
export interface FileWatcher {
  globPattern: string | { baseUri: string | { uri: string }; pattern: string };
  /** Created 1, Changed 2, Deleted 4 (a bit set); all by default. */
  kind?: number;
}

export interface LanguageClient {
  readonly definition: LanguageServerDefinition;
  /** The files the server asked to be told about. */
  readonly watchers: readonly FileWatcher[];
  readonly state: ServerState;
  /** Why the state is what it is, when that needs saying. */
  readonly message: string;
  readonly capabilities: ServerCapabilities;
  readonly encoding: PositionEncoding;
  readonly serverInfo: InitializeResult["serverInfo"];
  start(): Promise<void>;
  stop(): Promise<void>;
  request<T>(method: string, params: unknown, options?: RequestOptions): Promise<T>;
  notify(method: string, params: unknown): void;
  onState(listener: (state: ServerState) => void): () => void;
  /** Mark as restarting (the manager's decision, between a crash and the next start). */
  setState(state: ServerState, message?: string): void;
}

export function createLanguageClient(init: {
  definition: LanguageServerDefinition;
  root: WorkspaceFolderInfo;
  folders: () => WorkspaceFolderInfo[];
  transport: ServerTransport;
  handlers: ClientHandlers;
}): LanguageClient {
  const { definition, root, transport, handlers } = init;
  let state: ServerState = "stopped";
  let message = "";
  let capabilities: ServerCapabilities = {};
  let encoding: PositionEncoding = "utf-16";
  let serverInfo: InitializeResult["serverInfo"];
  let connection: Connection | null = null;
  let channel: ServerChannel | null = null;
  let closed: Promise<void> = Promise.resolve();
  let generation = 0;
  const listeners = new Set<(state: ServerState) => void>();
  /** Capabilities the server registered after `initialize`, by registration id. */
  const registrations = new Map<string, { method: string; registerOptions?: unknown }>();

  const setState = (next: ServerState, why = "") => {
    state = next;
    message = why;
    for (const listener of [...listeners]) listener(next);
  };

  const wire = (conn: Connection) => {
    conn.onNotification("textDocument/publishDiagnostics", (params) =>
      handlers.diagnostics(params as PublishDiagnosticsParams),
    );
    const levels = ["log", "error", "warning", "info", "log"] as const;
    const logMessage = (params: unknown) => {
      const { type, message: text } = (params ?? {}) as { type?: number; message?: string };
      handlers.log(String(text ?? ""), levels[type ?? 4] ?? "log");
    };
    conn.onNotification("window/logMessage", logMessage);
    conn.onNotification("window/showMessage", logMessage);
    conn.onUnhandledNotification(() => {});
    conn.onRequest("workspace/configuration", (params) =>
      ((params as { items?: { section?: string }[] })?.items ?? []).map((item) =>
        settingAt(definition, item.section),
      ),
    );
    conn.onRequest("workspace/workspaceFolders", () =>
      init.folders().map((folder) => ({ uri: folder.uri, name: folder.name })),
    );
    conn.onRequest("client/registerCapability", (params) => {
      for (const registration of (
        params as { registrations?: { id: string; method: string; registerOptions?: unknown }[] }
      )?.registrations ?? [])
        registrations.set(registration.id, registration);
      return null;
    });
    conn.onRequest("client/unregisterCapability", (params) => {
      // The protocol's own misspelling: `unregisterations`.
      const list =
        (params as { unregisterations?: { id: string }[]; unregistrations?: { id: string }[] }) ??
        {};
      for (const one of list.unregisterations ?? list.unregistrations ?? [])
        registrations.delete(one.id);
      return null;
    });
    conn.onRequest("window/workDoneProgress/create", () => null);
    conn.onRequest("window/showMessageRequest", (params) => {
      logMessage(params);
      return null;
    });
    conn.onRequest("window/showDocument", () => ({ success: false }));
    conn.onRequest("workspace/applyEdit", async (params) => {
      const { edit, label } = (params ?? {}) as { edit?: WorkspaceEdit; label?: string };
      if (!edit) return { applied: false, failureReason: "No edit" };
      return await handlers.applyEdit(edit, label);
    });
    for (const what of ["semanticTokens", "inlayHint", "codeLens", "diagnostic"])
      conn.onRequest(`workspace/${what}/refresh`, () => {
        handlers.refresh?.(what);
        return null;
      });
  };

  const initializeParams = () => ({
    processId: null,
    clientInfo: { name: "Yavin", version: "2.0.0" },
    locale: "en",
    rootPath: root.path,
    rootUri: root.uri,
    workspaceFolders: init.folders().map((folder) => ({ uri: folder.uri, name: folder.name })),
    initializationOptions: definition.initializationOptions,
    trace: "off",
    capabilities: CLIENT_CAPABILITIES,
  });

  const client: LanguageClient = {
    definition,
    get state() {
      return state;
    },
    get message() {
      return message;
    },
    get capabilities() {
      return capabilities;
    },
    get encoding() {
      return encoding;
    },
    get serverInfo() {
      return serverInfo;
    },
    get watchers() {
      return [...registrations.values()]
        .filter((one) => one.method === "workspace/didChangeWatchedFiles")
        .flatMap(
          (one) =>
            (one.registerOptions as { watchers?: FileWatcher[] } | undefined)?.watchers ?? [],
        );
    },
    setState,
    onState(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async start() {
      if (state === "starting" || state === "initializing" || state === "ready") return;
      const mine = ++generation;
      // A new process registers afresh.
      registrations.clear();
      setState("starting");
      let opened: ServerChannel;
      try {
        opened = await transport.start(definition.id, root.path);
      } catch (error) {
        const text = String(error instanceof Error ? error.message : error);
        if (text.startsWith(NOT_INSTALLED))
          setState("unavailable", text.slice(NOT_INSTALLED.length).trim());
        else setState("failed", text);
        return;
      }
      if (mine !== generation) {
        void opened.stop();
        return;
      }
      channel = opened;
      let resolveClosed!: () => void;
      closed = new Promise((resolve) => (resolveClosed = resolve));
      const conn = createConnection(opened, {
        timeout: definition.requestTimeout,
        onMalformed: (text, reason) =>
          handlers.log(`Ignored a malformed message (${reason}): ${text.slice(0, 200)}`, "warning"),
      });
      connection = conn;
      wire(conn);
      opened.onClose((reason) => {
        resolveClosed();
        if (mine !== generation) return;
        connection = null;
        channel = null;
        if (state === "stopping" || state === "stopped") setState("stopped");
        else setState("crashed", reason);
      });

      setState("initializing");
      try {
        const result = await conn.sendRequest<InitializeResult>("initialize", initializeParams(), {
          timeout: definition.startupTimeout,
        });
        if (mine !== generation) return;
        capabilities = result?.capabilities ?? {};
        serverInfo = result?.serverInfo;
        encoding = encodingOf(capabilities.positionEncoding);
        conn.sendNotification("initialized", {});
        if (definition.settings)
          conn.sendNotification("workspace/didChangeConfiguration", {
            settings: definition.settings,
          });
        setState("ready");
      } catch (error) {
        if (mine !== generation) return;
        // It never came up: nothing to shut down politely. Its process ending now is this
        // decision, not a crash, so it is no longer listened to first.
        generation++;
        conn.close("initialization failed");
        connection = null;
        channel = null;
        void opened.stop();
        setState(
          "failed",
          `Initialization failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },

    async stop() {
      const conn = connection;
      const open = channel;
      generation++;
      if (!open) {
        if (state !== "unavailable" && state !== "disabled") setState("stopped");
        return;
      }
      setState("stopping");
      if (conn && !conn.isClosed()) {
        try {
          await conn.sendRequest("shutdown", undefined, { timeout: SHUTDOWN_TIMEOUT });
          conn.sendNotification("exit");
        } catch {
          // A server that does not answer shutdown is ended anyway.
        }
        await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, EXIT_TIMEOUT))]);
        conn.close("stopped");
      }
      await open.stop();
      connection = null;
      channel = null;
      setState("stopped");
    },

    request<T>(method: string, params: unknown, options?: RequestOptions) {
      if (!connection || state !== "ready")
        return Promise.reject(new Error(`${definition.label} is not ready.`));
      return connection.sendRequest<T>(method, params, options);
    },

    notify(method: string, params: unknown) {
      if (connection && state === "ready") connection.sendNotification(method, params);
    },
  };
  return client;
}

const SEMANTIC_TOKEN_TYPES = [
  "namespace",
  "type",
  "class",
  "enum",
  "interface",
  "struct",
  "typeParameter",
  "parameter",
  "variable",
  "property",
  "enumMember",
  "event",
  "function",
  "method",
  "macro",
  "keyword",
  "modifier",
  "comment",
  "string",
  "number",
  "regexp",
  "operator",
  "decorator",
];
const SEMANTIC_TOKEN_MODIFIERS = [
  "declaration",
  "definition",
  "readonly",
  "static",
  "deprecated",
  "abstract",
  "async",
  "modification",
  "documentation",
  "defaultLibrary",
];
const range = (count: number) => Array.from({ length: count }, (_, i) => i + 1);

/** What Yavin can do, as `initialize` tells a server. Every feature here is implemented. */
export const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ["utf-16", "utf-8", "utf-32"] },
  workspace: {
    applyEdit: true,
    workspaceEdit: {
      documentChanges: true,
      resourceOperations: ["create", "rename", "delete"],
      failureHandling: "abort",
    },
    configuration: true,
    workspaceFolders: true,
    didChangeConfiguration: { dynamicRegistration: false },
    didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
    symbol: { symbolKind: { valueSet: range(26) } },
    executeCommand: {},
    semanticTokens: { refreshSupport: true },
    inlayHint: { refreshSupport: true },
    codeLens: { refreshSupport: true },
  },
  textDocument: {
    synchronization: { dynamicRegistration: false, willSave: false, didSave: true },
    completion: {
      contextSupport: true,
      completionItem: {
        snippetSupport: true,
        commitCharactersSupport: true,
        documentationFormat: ["markdown", "plaintext"],
        deprecatedSupport: true,
        preselectSupport: true,
        insertReplaceSupport: true,
        labelDetailsSupport: true,
        tagSupport: { valueSet: [1] },
        resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] },
      },
      completionItemKind: { valueSet: range(25) },
    },
    hover: { contentFormat: ["markdown", "plaintext"] },
    signatureHelp: {
      contextSupport: true,
      signatureInformation: {
        documentationFormat: ["markdown", "plaintext"],
        parameterInformation: { labelOffsetSupport: true },
        activeParameterSupport: true,
      },
    },
    declaration: { linkSupport: true },
    definition: { linkSupport: true },
    typeDefinition: { linkSupport: true },
    implementation: { linkSupport: true },
    references: {},
    documentSymbol: {
      hierarchicalDocumentSymbolSupport: true,
      symbolKind: { valueSet: range(26) },
    },
    codeAction: {
      isPreferredSupport: true,
      disabledSupport: true,
      dataSupport: true,
      codeActionLiteralSupport: {
        codeActionKind: {
          valueSet: [
            "",
            "quickfix",
            "refactor",
            "refactor.extract",
            "refactor.inline",
            "refactor.rewrite",
            "source",
            "source.organizeImports",
            "source.fixAll",
          ],
        },
      },
    },
    codeLens: {},
    documentLink: { tooltipSupport: true },
    formatting: {},
    rangeFormatting: {},
    onTypeFormatting: {},
    rename: { prepareSupport: true },
    publishDiagnostics: {
      relatedInformation: true,
      versionSupport: true,
      tagSupport: { valueSet: [1, 2] },
      codeDescriptionSupport: true,
      dataSupport: true,
    },
    semanticTokens: {
      requests: { full: { delta: true }, range: false },
      tokenTypes: SEMANTIC_TOKEN_TYPES,
      tokenModifiers: SEMANTIC_TOKEN_MODIFIERS,
      formats: ["relative"],
      overlappingTokenSupport: false,
      multilineTokenSupport: false,
    },
    inlayHint: {},
  },
  window: { workDoneProgress: true, showMessage: {} },
};
