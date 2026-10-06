/**
 * The extension API (IDE-07, version `EXTENSION_API`): everything extension code is given, and
 * nothing more. It is deliberately small. There is no access to native IPC, processes,
 * terminals, the filesystem, Git, documents, tasks, debugging, React, Monaco or the DOM through
 * it: an extension asks for what the API offers and the IDE's own services do the work.
 */

export interface Disposable {
  dispose(): void;
}

/** Key-value state kept for one extension: JSON values only, bounded, its own alone. */
export interface ExtensionMemento {
  get<T = unknown>(key: string): T | undefined;
  keys(): string[];
  /** `undefined` removes the key. Rejects with `StorageLimit` past the bound. */
  update(key: string, value: unknown): Promise<void>;
}

export interface ExtensionLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** What an extension is told about itself when it activates. */
export interface ExtensionContext {
  readonly extensionId: string;
  /** Its folder, for an extension installed from one; null for one bundled with Yavin. */
  readonly extensionPath: string | null;
  /** The workspace's folder; null with none open. */
  readonly workspaceFolder: string | null;
  /** Kept for this extension in every workspace. */
  readonly globalState: ExtensionMemento;
  /** Kept for this extension in this workspace; null with none open. */
  readonly workspaceState: ExtensionMemento | null;
  /** Disposed, newest first, when the extension is deactivated. */
  readonly subscriptions: Disposable[];
  /** Its own output channel ("Extension: <name>"). */
  readonly log: ExtensionLog;
}

/** One row of a contributed view. */
export interface ViewItem {
  label: string;
  description?: string;
  /** One of the extension's commands, run when the row is chosen. */
  command?: string;
}

export interface ViewProvider {
  getItems(): ViewItem[] | Promise<ViewItem[]>;
  /** Tells the view to ask again. */
  onDidChange?(listener: () => void): Disposable;
}

export interface Configuration {
  /** `key` is relative to the section (the extension's id). */
  get<T = unknown>(key: string): T | undefined;
}

export interface YavinApi {
  readonly version: string;
  commands: {
    /** One of the commands its manifest contributes. */
    registerCommand(id: string, handler: (...args: unknown[]) => unknown): Disposable;
    /** A command any extension contributes (activating it if needed). */
    executeCommand(id: string, ...args: unknown[]): Promise<unknown>;
  };
  window: {
    showInformationMessage(message: string): void;
    showWarningMessage(message: string): void;
    showErrorMessage(message: string): void;
  };
  workspace: {
    getWorkspaceFolder(): string | null;
    /** Its own settings only: `section` is its id. */
    getConfiguration(section: string): Configuration;
    /** Its own settings changing for this workspace (the key relative to its id). */
    onDidChangeConfiguration(listener: (key: string) => void): Disposable;
  };
  views: {
    /** Supplies one of the views its manifest contributes. */
    registerView(id: string, provider: ViewProvider): Disposable;
  };
}

/** An extension's code: what its entry point exports. */
export interface ExtensionModule {
  activate(context: ExtensionContext, yavin: YavinApi): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
