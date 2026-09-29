import type { DocumentService, TextDocument } from "../documents.ts";
import type { Diagnostic as ProblemDiagnostic } from "../panel/problemMatchers.ts";
import {
  fileUri,
  folderFor,
  fsPath,
  isCaseInsensitive,
  relativePath,
  resourceId,
} from "../resource.ts";
import type { ResourceId, WorkspaceFolder } from "../resource.ts";
import { createLanguageClient } from "./client.ts";
import type {
  LanguageClient,
  ServerState,
  ServerTransport,
  WorkspaceFolderInfo,
} from "./client.ts";
import { LineIndex, incrementalChange } from "./positions.ts";
import type { PositionEncoding } from "./positions.ts";
import type {
  Diagnostic,
  PublishDiagnosticsParams,
  ServerCapabilities,
  WorkspaceEdit,
} from "./protocol.ts";
import { DiagnosticSeverity, DiagnosticTag, TextDocumentSyncKind } from "./protocol.ts";
import { serversFor } from "./registry.ts";
import { globToRegExp, matchesGlob } from "./glob.ts";
import type { FileWatcher } from "./client.ts";
import type { LanguageServerDefinition } from "./registry.ts";
import { fromLspUri, lspPath, toLspUri } from "./uris.ts";

/**
 * Yavin's language servers: which one serves a document, keeping it told about the document,
 * and the requests made to it.
 *
 * ```text
 * DocumentService --events--> this --didOpen/didChange/didSave/didClose--> server
 *                                   <--publishDiagnostics-- -> Problems store -> Monaco markers
 * Monaco adapter --request(document, method)--> this --> server ; stale answers are dropped
 * ```
 *
 * A server is identified by what it is and where it runs: the registry's server id and the
 * workspace folder (by `ResourceId`) the document belongs to, so one server serves every
 * document of its language in its folder, and two folders get two servers. The server hears
 * about documents only from the Document Model -- never from Monaco -- and its versions are the
 * document's own versions, so an older state can never follow a newer one.
 */

export class StaleResultError extends Error {
  constructor() {
    super("The document changed while the language server was answering.");
    this.name = "StaleResultError";
  }
}

export interface ServerStatus {
  key: string;
  serverId: string;
  label: string;
  folder: string;
  state: ServerState;
  message: string;
}

export interface ProblemsSink {
  publish(owner: string, label: string, diagnostics: readonly ProblemDiagnostic[]): void;
  clear(owner: string): void;
}

export interface LspManagerOptions {
  documents: DocumentService;
  transport: ServerTransport;
  /** The workspace's folders, innermost first when they nest (see `folderFor`). */
  folders: () => readonly WorkspaceFolder[];
  /** Whether the folder is trusted, and which servers are installed. */
  availability: () => Promise<{ trusted: boolean; installed: ReadonlySet<string> }>;
  problems: ProblemsSink;
  /** Applies a server's edit through the WorkspaceEdit engine. */
  applyEdit: (
    edit: WorkspaceEdit,
    encoding: PositionEncoding,
    label: string | undefined,
  ) => Promise<{ applied: boolean; failureReason?: string }>;
  log?: (server: string, text: string, level: string) => void;
  /** Restarts allowed within `restartWindow` before a crashing server is left stopped. */
  maxRestarts?: number;
  restartWindow?: number;
  /** Milliseconds before each successive restart. */
  backoff?: readonly number[];
  /** The registry: which servers serve a language (tests narrow it). */
  serversFor?: (languageId: string) => LanguageServerDefinition[];
}

/** What a server has been told about one document. */
interface Synced {
  docId: string;
  key: string;
  /** The URI the server knows it by. */
  uri: string;
  clientKey: string;
  languageId: string;
  /** The document version the server has; -1 until it is opened there. */
  version: number;
  /** The text at that version, for computing the next incremental change. */
  text: string;
  /** Owners in the Problems store holding this document's diagnostics. */
  owner: string;
}

interface Server {
  key: string;
  client: LanguageClient;
  folder: WorkspaceFolder;
  crashes: number[];
  restartTimer?: ReturnType<typeof setTimeout>;
  /** Problems-store owners this server has published to. */
  owners: Set<string>;
}

export type LspManager = ReturnType<typeof createLspManager>;

export function createLspManager(options: LspManagerOptions) {
  const { documents } = options;
  const maxRestarts = options.maxRestarts ?? 3;
  const restartWindow = options.restartWindow ?? 180_000;
  const backoff = options.backoff ?? [500, 2_000, 5_000];
  const servers = new Map<string, Server>();
  const synced = new Map<string, Synced>();
  /** Languages with no usable server, and why: shown instead of a server's own state. */
  const unserved = new Map<string, { state: ServerState; message: string; label: string }>();
  const listeners = new Set<() => void>();
  let availability: { trusted: boolean; installed: ReadonlySet<string> } | null = null;
  let checking: Promise<void> | null = null;
  let disposed = false;
  let unsubscribe: (() => void) | null = null;
  /** The workspace folders servers were last told about, by `ResourceId`. */
  let knownFolders = new Map<ResourceId, WorkspaceFolder>();
  let revision = 0;

  const changed = () => {
    revision++;
    for (const listener of [...listeners]) listener();
  };

  const folderInfo = (folder: WorkspaceFolder): WorkspaceFolderInfo => ({
    uri: toLspUri(folder.uri),
    name: folder.name,
    path: fsPath(folder.uri),
  });

  const byId = (docId: string) => documents.all().find((doc) => doc.id === docId);

  /** The URI a server knows a document by, or null when it should not be told about it. */
  const uriOf = (doc: TextDocument, definition: LanguageServerDefinition): string | null => {
    if (doc.source.kind === "disk" && doc.uri) return toLspUri(doc.uri);
    if (doc.source.kind === "untitled" && definition.untitled)
      return `untitled:${encodeURIComponent(doc.name)}`;
    // Proposed content shares its file's URI; telling a server would mix the two up.
    return null;
  };

  const ownerOf = (clientKey: string, uri: string) => `lsp:${clientKey}:${uri}`;

  // --- Diagnostics ---------------------------------------------------------------------------

  const toProblems = (
    params: PublishDiagnosticsParams,
    entry: Synced | undefined,
    encoding: PositionEncoding,
  ): ProblemDiagnostic[] => {
    const file = lspPath(params.uri) ?? params.uri;
    const doc = entry && byId(entry.docId);
    // Columns are shown in UTF-16 units, as the editor counts them.
    const index = doc ? new LineIndex(doc.text) : null;
    const point = (position: { line: number; character: number }) => {
      if (!index) return { line: position.line + 1, column: position.character + 1 };
      const at = index.positionAt(index.offsetAt(position, encoding));
      return { line: at.line + 1, column: at.character + 1 };
    };
    return params.diagnostics.map((diagnostic: Diagnostic) => {
      const start = point(diagnostic.range.start);
      const end = point(diagnostic.range.end);
      const severity = diagnostic.severity ?? DiagnosticSeverity.Error;
      const tags = (diagnostic.tags ?? []).flatMap((tag) =>
        tag === DiagnosticTag.Unnecessary
          ? (["unnecessary"] as const)
          : tag === DiagnosticTag.Deprecated
            ? (["deprecated"] as const)
            : [],
      );
      return {
        file,
        line: start.line,
        column: start.column,
        endLine: end.line,
        endColumn: end.column,
        severity:
          severity === DiagnosticSeverity.Error
            ? "error"
            : severity === DiagnosticSeverity.Warning
              ? "warning"
              : "info",
        hint: severity === DiagnosticSeverity.Hint || undefined,
        message: diagnostic.message,
        code: diagnostic.code === undefined ? undefined : String(diagnostic.code),
        origin: diagnostic.source,
        tags: tags.length ? tags : undefined,
        related: diagnostic.relatedInformation?.map((related) => ({
          file: lspPath(related.location.uri) ?? related.location.uri,
          line: related.location.range.start.line + 1,
          column: related.location.range.start.character + 1,
          message: related.message,
        })),
      };
    });
  };

  const onDiagnostics = (server: Server, params: PublishDiagnosticsParams) => {
    const resource = fromLspUri(params.uri);
    const id = resource ? resourceId(resource) : null;
    const entry = [...synced.values()].find(
      (one) =>
        one.clientKey === server.key &&
        (one.uri === params.uri || (id !== null && lspResourceIdOf(one.uri) === id)),
    );
    // Computed for an older version than the server now has: a newer set is on its way.
    if (
      entry &&
      params.version !== undefined &&
      params.version !== null &&
      params.version < entry.version
    )
      return;
    const owner = ownerOf(server.key, entry?.uri ?? params.uri);
    if (!params.diagnostics.length) {
      options.problems.clear(owner);
      server.owners.delete(owner);
      return;
    }
    server.owners.add(owner);
    options.problems.publish(
      owner,
      server.client.definition.label,
      toProblems(params, entry, server.client.encoding),
    );
  };

  const lspResourceIdOf = (uri: string): ResourceId | null => {
    const resource = fromLspUri(uri);
    return resource ? resourceId(resource) : null;
  };

  const clearDiagnostics = (server: Server) => {
    for (const owner of server.owners) options.problems.clear(owner);
    server.owners.clear();
  };

  // --- Servers -------------------------------------------------------------------------------

  const syncKind = (capabilities: ServerCapabilities): number => {
    const sync = capabilities.textDocumentSync;
    if (typeof sync === "number") return sync;
    return sync?.change ?? TextDocumentSyncKind.None;
  };
  const opensAndCloses = (capabilities: ServerCapabilities) => {
    const sync = capabilities.textDocumentSync;
    return typeof sync === "number"
      ? sync !== TextDocumentSyncKind.None
      : sync?.openClose !== false;
  };

  const openOn = (server: Server, entry: Synced) => {
    const doc = byId(entry.docId);
    if (!doc || server.client.state !== "ready") return;
    if (opensAndCloses(server.client.capabilities))
      server.client.notify("textDocument/didOpen", {
        textDocument: {
          uri: entry.uri,
          languageId: entry.languageId,
          version: doc.version,
          text: doc.text,
        },
      });
    entry.version = doc.version;
    entry.text = doc.text;
  };

  const serverFor = (definition: LanguageServerDefinition, folder: WorkspaceFolder): Server => {
    const key = `${definition.id}|${resourceId(folder.uri)}`;
    const existing = servers.get(key);
    if (existing) return existing;
    const server: Server = {
      key,
      folder,
      crashes: [],
      owners: new Set(),
      client: createLanguageClient({
        definition,
        root: folderInfo(folder),
        folders: () => options.folders().map(folderInfo),
        transport: options.transport,
        handlers: {
          diagnostics: (params) => onDiagnostics(server, params),
          applyEdit: (edit, label) => options.applyEdit(edit, server.client.encoding, label),
          log: (text, level) => options.log?.(definition.label, text, level),
          refresh: () => changed(),
        },
      }),
    };
    servers.set(key, server);
    server.client.onState((state) => {
      if (state === "ready") {
        // Everything assigned to it, told again from the Document Model -- after a restart
        // too, when the server has forgotten all of it.
        for (const entry of synced.values()) if (entry.clientKey === key) openOn(server, entry);
      } else if (state === "crashed") onCrash(server);
      changed();
    });
    void server.client.start();
    return server;
  };

  const onCrash = (server: Server) => {
    clearDiagnostics(server);
    for (const entry of synced.values()) if (entry.clientKey === server.key) entry.version = -1;
    if (disposed) return;
    const now = Date.now();
    server.crashes = [...server.crashes.filter((at) => now - at < restartWindow), now];
    const reason = server.client.message;
    if (server.crashes.length > maxRestarts) {
      server.client.setState(
        "failed",
        `${server.client.definition.label} stopped after crashing ${server.crashes.length} times. ${reason}`,
      );
      return;
    }
    const delay = backoff[Math.min(server.crashes.length - 1, backoff.length - 1)];
    server.client.setState("restarting", reason);
    server.restartTimer = setTimeout(() => {
      server.restartTimer = undefined;
      if (!disposed && servers.get(server.key) === server) void server.client.start();
    }, delay);
  };

  const refreshAvailability = async () => {
    try {
      availability = await options.availability();
    } catch {
      availability = { trusted: false, installed: new Set() };
    }
  };

  const ensureAvailability = () => {
    if (availability) return Promise.resolve();
    checking ??= refreshAvailability().finally(() => (checking = null));
    return checking;
  };

  // --- Documents -----------------------------------------------------------------------------

  const attach = async (doc: TextDocument) => {
    if (disposed || synced.has(doc.id)) return;
    const candidates = (options.serversFor ?? serversFor)(doc.languageId);
    if (!candidates.length) return;
    await ensureAvailability();
    const current = byId(doc.id);
    if (disposed || !current || synced.has(doc.id) || !availability) return;
    if (!availability.trusted) {
      unserved.set(doc.languageId, {
        state: "disabled",
        message: "Language servers do not run in Restricted Mode.",
        label: candidates[0].label,
      });
      changed();
      return;
    }
    const definition = candidates.find((one) => availability?.installed.has(one.id));
    if (!definition) {
      unserved.set(doc.languageId, {
        state: "unavailable",
        message: `No language server for ${candidates.map((one) => one.label).join(" or ")} is installed.`,
        label: candidates[0].label,
      });
      changed();
      return;
    }
    const uri = uriOf(current, definition);
    const folders = options.folders();
    const folder = current.uri ? folderFor(current.uri, folders) : folders[0];
    if (!uri || !folder) return;
    const server = serverFor(definition, folder);
    const entry: Synced = {
      docId: current.id,
      key: current.key,
      uri,
      clientKey: server.key,
      languageId: current.languageId,
      version: -1,
      text: "",
      owner: ownerOf(server.key, uri),
    };
    synced.set(current.id, entry);
    openOn(server, entry);
  };

  const detach = (docId: string) => {
    const entry = synced.get(docId);
    if (!entry) return;
    synced.delete(docId);
    const server = servers.get(entry.clientKey);
    if (!server) return;
    if (entry.version >= 0 && opensAndCloses(server.client.capabilities))
      server.client.notify("textDocument/didClose", { textDocument: { uri: entry.uri } });
    // Diagnostics of a document no longer open go with it (the server may say so too).
    options.problems.clear(entry.owner);
    server.owners.delete(entry.owner);
  };

  /** Tells the server about the document's current text, if it has not been told yet. */
  const sync = (doc: TextDocument) => {
    const entry = synced.get(doc.id);
    if (!entry) return;
    const server = servers.get(entry.clientKey);
    if (!server || server.client.state !== "ready" || entry.version < 0) return;
    // Never an older state after a newer one.
    if (doc.version <= entry.version) return;
    const kind = syncKind(server.client.capabilities);
    if (kind === TextDocumentSyncKind.Incremental) {
      const change = incrementalChange(entry.text, doc.text, server.client.encoding);
      server.client.notify("textDocument/didChange", {
        textDocument: { uri: entry.uri, version: doc.version },
        contentChanges: change ? [change] : [],
      });
    } else if (kind === TextDocumentSyncKind.Full) {
      server.client.notify("textDocument/didChange", {
        textDocument: { uri: entry.uri, version: doc.version },
        contentChanges: [{ text: doc.text }],
      });
    }
    entry.version = doc.version;
    entry.text = doc.text;
  };

  const didSave = (doc: TextDocument) => {
    const entry = synced.get(doc.id);
    const server = entry && servers.get(entry.clientKey);
    if (!entry || !server || server.client.state !== "ready") return;
    sync(doc);
    const save =
      typeof server.client.capabilities.textDocumentSync === "object"
        ? server.client.capabilities.textDocumentSync.save
        : undefined;
    if (!save) return;
    server.client.notify("textDocument/didSave", {
      textDocument: { uri: entry.uri },
      ...(typeof save === "object" && save.includeText ? { text: doc.text } : {}),
    });
  };

  const onDocumentEvent = (event: Parameters<Parameters<DocumentService["subscribe"]>[0]>[0]) => {
    switch (event.type) {
      case "opened": {
        const doc = byId(event.id);
        if (doc) void attach(doc);
        return;
      }
      case "changed":
      case "reloaded": {
        const doc = byId(event.id);
        if (doc) sync(doc);
        return;
      }
      case "saved": {
        const doc = byId(event.id);
        if (doc) didSave(doc);
        return;
      }
      case "closed":
        detach(event.id);
        return;
      case "sourceChanged": {
        // Save As or a rename: the server knew it by another URI (maybe as another language).
        detach(event.previousId);
        const doc = byId(event.id);
        if (doc) void attach(doc);
        return;
      }
      default:
        return;
    }
  };

  // --- Requests ------------------------------------------------------------------------------

  /**
   * The line index of a document's current text, built once per version: every provider call
   * converts positions, and several run per keystroke (semantic tokens, inlay hints...).
   */
  const indexes = new WeakMap<object, { version: number; index: LineIndex }>();
  const indexOf = (doc: TextDocument): LineIndex => {
    const cached = indexes.get(doc);
    if (cached?.version === doc.version) return cached.index;
    const index = new LineIndex(doc.text);
    indexes.set(doc, { version: doc.version, index });
    return index;
  };

  const target = (key: string) => {
    const doc = documents.get(key);
    const entry = doc && synced.get(doc.id);
    const server = entry && servers.get(entry.clientKey);
    if (!doc || !entry || !server || server.client.state !== "ready" || entry.version < 0)
      return null;
    return { doc, entry, server };
  };

  return {
    /** Starts following the Document Model: every open document, and each one opened. */
    start() {
      if (unsubscribe) return;
      knownFolders = new Map(options.folders().map((folder) => [resourceId(folder.uri), folder]));
      unsubscribe = documents.subscribe(onDocumentEvent);
      for (const doc of documents.all()) void attach(doc);
    },

    /**
     * The workspace's folders changed (one added or removed): servers that follow folder
     * changes are told, instead of being restarted; a removed folder's own servers stop; the
     * documents of an added folder get theirs.
     */
    async foldersChanged() {
      const now = new Map(options.folders().map((folder) => [resourceId(folder.uri), folder]));
      const added = [...now].filter(([id]) => !knownFolders.has(id)).map(([, folder]) => folder);
      const removed = [...knownFolders].filter(([id]) => !now.has(id)).map(([, folder]) => folder);
      knownFolders = now;
      if (!added.length && !removed.length) return;
      const event = {
        added: added.map((folder) => ({ uri: toLspUri(folder.uri), name: folder.name })),
        removed: removed.map((folder) => ({ uri: toLspUri(folder.uri), name: folder.name })),
      };
      const gone = new Set(removed.map((folder) => resourceId(folder.uri)));
      for (const server of [...servers.values()]) {
        if (gone.has(resourceId(server.folder.uri))) {
          servers.delete(server.key);
          clearTimeout(server.restartTimer);
          clearDiagnostics(server);
          for (const [docId, entry] of synced)
            if (entry.clientKey === server.key) synced.delete(docId);
          await server.client.stop();
          continue;
        }
        const folders = (
          server.client.capabilities.workspace as
            { workspaceFolders?: { changeNotifications?: boolean | string } } | undefined
        )?.workspaceFolders;
        if (folders?.changeNotifications)
          server.client.notify("workspace/didChangeWorkspaceFolders", { event });
      }
      for (const doc of documents.all()) void attach(doc);
      changed();
    },

    /**
     * Files changed on disk (the watcher's report): each server is told about the ones it
     * registered to watch, by pattern and kind (`workspace/didChangeWatchedFiles`).
     */
    filesChanged(changes: readonly { path: string; kind: string; from?: string }[]) {
      type FileEvent = { path: string; uri: string; insensitive: boolean; type: 1 | 2 | 3 };
      const events: FileEvent[] = [];
      const push = (path: string, type: 1 | 2 | 3) => {
        try {
          const uri = fileUri(path);
          events.push({
            path: fsPath(uri),
            uri: toLspUri(uri),
            insensitive: isCaseInsensitive(uri),
            type,
          });
        } catch {
          // Not a path a server could be told about.
        }
      };
      for (const change of changes) {
        if (change.kind === "renamed") {
          if (change.from) push(change.from, 3);
          push(change.path, 1);
        } else push(change.path, change.kind === "created" ? 1 : change.kind === "deleted" ? 3 : 2);
      }
      if (!events.length) return;
      const bit = { 1: 1, 2: 2, 3: 4 } as const;
      const watched = (watcher: FileWatcher, event: FileEvent) => {
        if (((watcher.kind ?? 7) & bit[event.type]) === 0) return false;
        const pattern = watcher.globPattern;
        if (typeof pattern === "string") return matchesGlob(pattern, event.path, event.insensitive);
        const base = lspPath(
          typeof pattern.baseUri === "string" ? pattern.baseUri : pattern.baseUri.uri,
        );
        const inside = base ? relativePath(base, event.path) : undefined;
        return (
          inside !== undefined &&
          inside !== "." &&
          globToRegExp(pattern.pattern, event.insensitive).test(inside)
        );
      };
      for (const server of servers.values()) {
        if (server.client.state !== "ready") continue;
        const watchers = server.client.watchers;
        if (!watchers.length) continue;
        const matching = events.filter((event) =>
          watchers.some((watcher) => watched(watcher, event)),
        );
        if (matching.length)
          server.client.notify("workspace/didChangeWatchedFiles", {
            changes: matching.map((event) => ({ uri: event.uri, type: event.type })),
          });
      }
    },

    /** The id of the server serving the document at `key`, when one is ready. */
    serverIdFor(key: string): string | null {
      return target(key)?.server.client.definition.id ?? null;
    },

    /** One ready instance of each server: what the editor registers its features from. */
    readyServers() {
      const seen = new Map<
        string,
        {
          definition: LanguageServerDefinition;
          capabilities: ServerCapabilities;
          encoding: PositionEncoding;
        }
      >();
      for (const server of servers.values())
        if (server.client.state === "ready" && !seen.has(server.client.definition.id))
          seen.set(server.client.definition.id, {
            definition: server.client.definition,
            capabilities: server.client.capabilities,
            encoding: server.client.encoding,
          });
      return [...seen.values()];
    },

    /** The capabilities of the server a document is served by; null when there is none ready. */
    capabilities(key: string): ServerCapabilities | null {
      return target(key)?.server.client.capabilities ?? null;
    },

    /** What a request about the document at `key` needs: its URI, text, version and encoding. */
    context(key: string) {
      const found = target(key);
      if (!found) return null;
      sync(found.doc);
      return {
        uri: found.entry.uri,
        version: found.doc.version,
        encoding: found.server.client.encoding,
        index: indexOf(found.doc),
        label: found.server.client.definition.label,
      };
    },

    /**
     * A request about the document at `key`, made at its current version. Throws
     * `StaleResultError` when the document changed (or closed) before the answer came: an
     * answer about an older text must not be shown for a newer one. Null when no server is ready.
     *
     * `staleOk` is for completion alone: typing on while the list is being fetched moves the
     * document on, and Monaco filters the answer against what was typed since (and cancels
     * the request itself when the answer no longer applies). The document must still be the
     * same one.
     */
    async request<T>(
      key: string,
      method: string,
      params: unknown,
      signal?: AbortSignal,
      options: { staleOk?: boolean } = {},
    ): Promise<T | null> {
      const found = target(key);
      if (!found) return null;
      sync(found.doc);
      const { doc, server } = found;
      const version = doc.version;
      const result = await server.client.request<T>(method, params, { signal });
      const now = documents.get(key);
      if (!now || now.id !== doc.id) throw new StaleResultError();
      if (now.version !== version && !options.staleOk) throw new StaleResultError();
      return result;
    },

    /** A request not about one document (workspace symbols, a command), to every ready server. */
    async requestAll<T>(method: string, params: unknown, signal?: AbortSignal) {
      const ready = [...servers.values()].filter((server) => server.client.state === "ready");
      const answers = await Promise.allSettled(
        ready.map((server) =>
          server.client
            .request<T>(method, params, { signal })
            .then((result) => ({ server, result })),
        ),
      );
      return answers.flatMap((answer) =>
        answer.status === "fulfilled"
          ? [
              {
                label: answer.value.server.client.definition.label,
                encoding: answer.value.server.client.encoding,
                capabilities: answer.value.server.client.capabilities,
                result: answer.value.result,
              },
            ]
          : [],
      );
    },

    /**
     * Runs a server command (`workspace/executeCommand`) -- only one the server serving `key`
     * itself advertised. A command from anywhere else is refused, not forwarded.
     */
    async executeCommand(key: string, command: string, args: unknown[] | undefined) {
      const found = target(key);
      if (!found) throw new Error("No language server is ready for this document.");
      const offered = found.server.client.capabilities.executeCommandProvider?.commands ?? [];
      if (!offered.includes(command))
        throw new Error(
          `${found.server.client.definition.label} does not offer the command ${command}.`,
        );
      return await found.server.client.request("workspace/executeCommand", {
        command,
        arguments: args,
      });
    },

    status(): ServerStatus[] {
      const running: ServerStatus[] = [...servers.values()].map((server) => ({
        key: server.key,
        serverId: server.client.definition.id,
        label: server.client.definition.label,
        folder: server.folder.name,
        state: server.client.state,
        message: server.client.message,
      }));
      const missing: ServerStatus[] = [...unserved].map(([languageId, why]) => ({
        key: `unserved|${languageId}`,
        serverId: "",
        label: why.label,
        folder: "",
        state: why.state,
        message: why.message,
      }));
      return [...running, ...missing];
    },

    /** The status of the server for the document at `key`, if one serves (or would) its language. */
    statusFor(key: string): ServerStatus | null {
      const doc = documents.get(key);
      if (!doc) return null;
      const entry = synced.get(doc.id);
      if (entry) {
        const server = servers.get(entry.clientKey);
        if (server)
          return {
            key: server.key,
            serverId: server.client.definition.id,
            label: server.client.definition.label,
            folder: server.folder.name,
            state: server.client.state,
            message: server.client.message,
          };
      }
      const why = unserved.get(doc.languageId);
      return why
        ? {
            key: `unserved|${doc.languageId}`,
            serverId: "",
            label: why.label,
            folder: "",
            state: why.state,
            message: why.message,
          }
        : null;
    },

    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    revision: () => revision,

    /** Stops and starts the server serving `key` (or every server), forgetting past crashes. */
    async restart(key?: string) {
      const doc = key ? documents.get(key) : undefined;
      const entry = doc && synced.get(doc.id);
      const chosen = entry ? [servers.get(entry.clientKey)].filter(Boolean) : [...servers.values()];
      for (const server of chosen as Server[]) {
        clearTimeout(server.restartTimer);
        clearDiagnostics(server);
        await server.client.stop();
        server.crashes = [];
        for (const one of synced.values()) if (one.clientKey === server.key) one.version = -1;
        void server.client.start();
      }
      if (!key) {
        // Also retry what was unavailable: something may have been installed since.
        availability = null;
        unserved.clear();
        for (const one of documents.all()) void attach(one);
      }
      changed();
    },

    /** Trust or installed servers changed: stop everything and attach again. */
    async reconsider() {
      await this.stopAll();
      availability = null;
      unserved.clear();
      synced.clear();
      disposed = false;
      knownFolders = new Map(options.folders().map((folder) => [resourceId(folder.uri), folder]));
      for (const doc of documents.all()) void attach(doc);
      changed();
    },

    /** Shuts every server down (the workspace is closing), clearing what they reported. */
    async stopAll() {
      const all = [...servers.values()];
      servers.clear();
      await Promise.all(
        all.map(async (server) => {
          clearTimeout(server.restartTimer);
          clearDiagnostics(server);
          await server.client.stop();
        }),
      );
      for (const entry of synced.values()) entry.version = -1;
      changed();
    },

    async dispose() {
      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
      await this.stopAll();
      synced.clear();
      unserved.clear();
    },

    /** Test seam: what a server has been told about a document. */
    syncedVersion: (key: string) => {
      const doc = documents.get(key);
      return doc ? (synced.get(doc.id)?.version ?? null) : null;
    },
  };
}

/**
 * How the status bar shows a server's state: quiet while it is fine, clear when it is not.
 * A server starting up is normal and says so plainly; only what needs the user is a warning.
 */
export function describeStatus(status: ServerStatus): {
  text: string;
  title: string;
  tone: "normal" | "busy" | "warning" | "error";
} {
  const { label, state, message } = status;
  switch (state) {
    case "starting":
    case "initializing":
      return {
        text: `${label}: starting…`,
        title: `The ${label} language server is starting.`,
        tone: "busy",
      };
    case "ready":
      return { text: label, title: `The ${label} language server is ready.`, tone: "normal" };
    case "restarting":
      return {
        text: `${label}: restarting…`,
        title: `Restarting the ${label} language server. ${message}`.trim(),
        tone: "busy",
      };
    case "crashed":
      return {
        text: `${label}: crashed`,
        title: message || `The ${label} language server stopped.`,
        tone: "error",
      };
    case "failed":
      return {
        text: `${label}: not running`,
        title: `${message} Click to try again.`.trim(),
        tone: "error",
      };
    case "unavailable":
      return { text: `${label}: not installed`, title: message, tone: "warning" };
    case "disabled":
      return { text: `${label}: Restricted Mode`, title: message, tone: "warning" };
    default:
      return {
        text: `${label}: stopped`,
        title: `The ${label} language server is not running.`,
        tone: "normal",
      };
  }
}
