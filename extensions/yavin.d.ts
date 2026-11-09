// Yavin Extension API 2.1.0 -- type definitions for extension authors.
//
// AUTO-DERIVED from src/services/extensions/api.ts by authoringTypings.ts.
// Do not edit by hand: authoring.test.ts regenerates this and fails on drift.
//
// JavaScript (JSDoc):
//   /** @type {import("yavin").ExtensionModule} */
//   module.exports = { activate(context, yavin) { /* ... */ } };
// TypeScript:
//   import type { ExtensionContext, YavinApi } from "yavin";

declare module "yavin" {
export interface Disposable {
  dispose(): void;
}

export interface Range {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface Document {
  uri: string;
  resourceId: string;
  languageId: string;
  version: number;
  source: "disk" | "untitled" | "proposed";
  dirty: boolean;
}

export interface Memento {
  get<T = unknown>(key: string): T | undefined;
  keys(): string[];
  /** JSON values only, at most 64 KiB per extension and scope; `undefined` removes the key. */
  update(key: string, value: unknown): Promise<void>;
}

export interface SecretOptions {
  /** "installation" (default): this extension's, in the active profile; "workspace": also this workspace's. */
  readonly scope?: "installation" | "workspace";
}

export interface SecretStorage {
  get(key: string, options?: SecretOptions): Promise<string | null>;
  store(key: string, value: string, options?: SecretOptions): Promise<void>;
  /** Whether there was one. */
  delete(key: string, options?: SecretOptions): Promise<boolean>;
}

export interface ExtensionContext {
  readonly extensionId: string;
  readonly extensionPath: string | null;
  readonly workspaceFolder: string | null;
  readonly apiVersion: string;
  readonly environment: { apiVersion: string; hostGeneration: number };
  readonly globalState: Memento;
  readonly workspaceState: Memento | null;
  /**
   * Its own secrets (EXT-13), kept by Yavin in the operating system's credential store (Windows
   * Credential Manager) -- needs the `secrets` permission. Values are strings of at most 1024
   * bytes; names are 1 to 128 letters, digits, ".", "_" or "-". Never in settings or state.
   */
  readonly secrets: SecretStorage;
  /** Disposed, newest first, when the extension is deactivated. */
  readonly subscriptions: Disposable[];
  readonly log: {
    info(...parts: unknown[]): void;
    warn(...parts: unknown[]): void;
    error(...parts: unknown[]): void;
  };
}

export interface ViewItem {
  label: string;
  description?: string;
  tooltip?: string;
  /** One of the extension's commands, run when the row is chosen. */
  command?: string;
  /** Up to three levels deep, at most 1000 rows in all. */
  children?: ViewItem[];
}

export interface Decoration {
  range: Range;
  style: "highlight" | "underline-info" | "underline-warning" | "underline-error" | "dimmed";
  hover?: string;
}

/** What language providers return (plain data). */
export interface CompletionItem {
  label: string;
  insertText?: string;
  detail?: string;
}
export interface Hover {
  contents: string;
}
export interface Location {
  uri: string;
  range: Range;
}
export interface DocumentSymbol {
  name: string;
  detail?: string;
  range: Range;
}

export interface YavinApi {
  readonly version: string;
  commands: {
    /** One of the commands its manifest contributes. */
    registerCommand(id: string, handler: (...args: unknown[]) => unknown): Disposable;
    /** A command an extension contributes (activating it if needed). */
    executeCommand(id: string, ...args: unknown[]): Promise<unknown>;
  };
  window: {
    showInformationMessage(message: string): Promise<void>;
    showWarningMessage(message: string): Promise<void>;
    showErrorMessage(message: string): Promise<void>;
    createOutputChannel(): { appendLine(text: string): void };
  };
  workspace: {
    getWorkspaceFolder(): string | null;
    /** Its own settings only: `section` is its id. */
    getConfiguration(section: string): { get<T = unknown>(key: string): T | undefined };
    onDidChangeConfiguration(listener: (event: { key: string }) => void): Disposable;
    /** Workspace-relative paths only; read only. */
    fs: { readFile(path: string): Promise<string>; exists(path: string): Promise<boolean> };
  };
  storage: { readonly global: Memento; readonly workspace: Memento | null };
  views: {
    registerView(
      id: string,
      provider: {
        getItems(): ViewItem[] | Promise<ViewItem[]>;
        onDidChange?(listener: () => void): Disposable;
      },
    ): Disposable;
  };
  documents: {
    get(uri: string): Promise<Document | null>;
    getText(uri: string): Promise<string | null>;
    all(): Promise<Document[]>;
    onDidOpen(listener: (document: Document) => void): Disposable;
    onDidChange(listener: (document: Document) => void): Disposable;
    onDidClose(listener: (document: Document) => void): Disposable;
  };
  editor: {
    activeEditor(): Promise<{ document: Document; selection: Range } | null>;
    openLocation(uri: string, range?: Range): Promise<void>;
    setSelection(range: Range): Promise<boolean>;
    revealRange(range: Range): Promise<boolean>;
    /** Its own decorations, by key, for one document; an empty list removes them. */
    setDecorations(uri: string, key: string, decorations: Decoration[]): Promise<void>;
    onDidChangeActiveEditor(
      listener: (active: { document: Document; selection: Range } | null) => void,
    ): Disposable;
  };
  languages: {
    registerCompletionProvider(
      language: string,
      provider: {
        provideCompletionItems(
          document: Document,
          position: { line: number; column: number },
        ): CompletionItem[] | Promise<CompletionItem[]>;
      },
    ): Disposable;
    registerHoverProvider(
      language: string,
      provider: {
        provideHover(
          document: Document,
          position: { line: number; column: number },
        ): Hover | null | Promise<Hover | null>;
      },
    ): Disposable;
    registerDefinitionProvider(
      language: string,
      provider: {
        provideDefinition(
          document: Document,
          position: { line: number; column: number },
        ): Location[] | Promise<Location[]>;
      },
    ): Disposable;
    registerReferenceProvider(
      language: string,
      provider: {
        provideReferences(
          document: Document,
          position: { line: number; column: number },
        ): Location[] | Promise<Location[]>;
      },
    ): Disposable;
    registerDocumentSymbolProvider(
      language: string,
      provider: {
        provideDocumentSymbols(document: Document): DocumentSymbol[] | Promise<DocumentSymbol[]>;
      },
    ): Disposable;
  };
}

/** What an extension's entry point exports. */
export interface ExtensionModule {
  activate(context: ExtensionContext, yavin: YavinApi): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
}
