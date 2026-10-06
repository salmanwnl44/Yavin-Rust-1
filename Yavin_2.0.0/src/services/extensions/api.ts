/**
 * The extension API, version 2 (IDE-08), as extension authors see it: the shape of `yavin` and
 * of the context an extension's `activate(context, yavin)` receives. It is implemented inside
 * the extension host (`src-tauri/crates/ide-plugin-host/src/bootstrap.js`); every operation is a
 * protocol request that Yavin checks (`host.ts`) before anything happens. This file is the
 * contract, not an implementation -- nothing in Yavin's window hands these objects to code.
 *
 * Positions are 1-based. Documents are named by URI and resolved by Yavin to canonical
 * resources inside the workspace; nothing outside it can be reached.
 */

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

export interface ExtensionContext {
  readonly extensionId: string;
  readonly extensionPath: string | null;
  readonly workspaceFolder: string | null;
  readonly apiVersion: string;
  readonly environment: { apiVersion: string; hostGeneration: number };
  readonly globalState: Memento;
  readonly workspaceState: Memento | null;
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
