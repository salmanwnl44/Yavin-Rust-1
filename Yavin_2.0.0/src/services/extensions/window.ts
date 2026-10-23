/**
 * What extensions may do to the window, as narrow contracts (IDE-08). The extension host's
 * capabilities (`host.ts`) act only through these; the window (`App.tsx`) implements them over
 * its own services. Extensions never receive any of these objects -- they send protocol
 * requests, which the host checks and turns into calls here.
 *
 * Resources are canonical (`ResourceId`, `resource.ts`): an extension names a document by its
 * URI, Yavin resolves it to a resource and refuses anything outside the workspace.
 */
import type { ResourceId } from "../resource.ts";

/** A position or range as an extension gives and receives it: 1-based lines and columns. */
export interface ExtensionRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface DocumentInfo {
  uri: string;
  resourceId: ResourceId;
  languageId: string;
  version: number;
  source: "disk" | "untitled" | "proposed";
  dirty: boolean;
}

/** Documents opening, changing, being saved (EXT-29) and closing. */
export type DocumentEvent = "open" | "change" | "close" | "save";

/** A selection in the editor (EXT-29): its range, and whether it runs backwards (anchor at the end). */
export interface ExtensionSelection extends ExtensionRange {
  reversed?: boolean;
}

/** The active editor's selections changed (EXT-29): VS Code's onDidChangeTextEditorSelection. */
export interface SelectionChange {
  resource: ResourceId;
  selections: readonly ExtensionSelection[];
  kind: "keyboard" | "mouse" | "command" | null;
}

/** A file of the workspace created, changed, deleted or renamed (EXT-29): absolute paths. */
export interface FileChange {
  kind: "created" | "modified" | "deleted" | "renamed";
  path: string;
  /** A rename's old path. */
  from?: string;
}

/** An item of an extension's picker (EXT-29): text only, in Yavin's style. */
export interface PromptItem {
  label: string;
  description?: string;
  detail?: string;
  picked?: boolean;
  separator?: boolean;
}

/** What every prompt says about itself: which extension asks. */
interface PromptOrigin {
  /** The extension asking (shown, so a prompt is never mistaken for Yavin's own). */
  extensionId: string;
  extensionName: string;
  title?: string;
  placeHolder?: string;
  /** Kept open when the focus moves elsewhere (otherwise that cancels it). */
  ignoreFocusOut: boolean;
}

export interface QuickPickRequest extends PromptOrigin {
  items: readonly PromptItem[];
  canPickMany: boolean;
  matchOnDescription: boolean;
  matchOnDetail: boolean;
}

/** An input box's validation message (null: the value is valid). */
export interface PromptValidation {
  message: string;
  severity: "error" | "warning" | "info";
}

export interface InputBoxRequest extends PromptOrigin {
  prompt?: string;
  value: string;
  valueSelection?: readonly [number, number];
  password: boolean;
  /** Asks the extension about a value, as the user types and before accepting it. */
  validate: ((value: string) => Promise<PromptValidation | null>) | null;
}

/** A text edit an extension makes (EXT-25): the range it replaces (1-based) and the new text. */
export interface ExtensionTextEdit {
  range: ExtensionRange;
  text: string;
}

export interface ExtensionWindow {
  documents: {
    all(): DocumentInfo[];
    get(resource: ResourceId): DocumentInfo | null;
    text(resource: ResourceId): string | null;
    /** Documents opening, changing (a new version) and closing. */
    subscribe(listener: (event: DocumentEvent, document: DocumentInfo) => void): () => void;
    /**
     * Edits an open document (EXT-25), as one unsaved, undoable change through the document
     * service; false when it is not at `version` any more (null: whatever its version) or may
     * not be edited. Edits must not overlap.
     */
    edit?(
      resource: ResourceId,
      version: number | null,
      edits: readonly ExtensionTextEdit[],
    ): boolean;
  };
  editor: {
    active(): { document: DocumentInfo; selection: ExtensionSelection } | null;
    onActive(listener: () => void): () => void;
    /** The active editor's selections changing (EXT-29); without it, no selection events. */
    onSelection?(listener: (change: SelectionChange) => void): () => void;
    /** Opens a file of the workspace (by its path) at `range`, through the editor's own navigation. */
    openLocation(path: string, range: ExtensionRange | null): Promise<void>;
    /** In the active editor; false when there is none. */
    setSelection(range: ExtensionRange): boolean;
    revealRange(range: ExtensionRange): boolean;
  };
  /** A workspace file's text (the native side refuses anything outside the workspace). */
  readFile(path: string): Promise<string>;
  /**
   * Whether the window has the user's focus, and its changes (EXT-27, `services/windowFocus.ts`):
   * VS Code's `window.state`. Without it, an extension is told the state is not reported.
   */
  focus?: { focused(): boolean; onChange(listener: (focused: boolean) => void): () => void };
  /** The workspace's file changes, from the native watcher (EXT-29): VS Code's file watchers. */
  files?: { subscribe(listener: (changes: readonly FileChange[]) => void): () => void };
  /**
   * Yavin's picker and input box for extensions (EXT-29), one shown at a time: the answer, or
   * null when the user (or `signal`) cancels it.
   */
  prompts?: {
    quickPick(request: QuickPickRequest, signal: AbortSignal): Promise<number | number[] | null>;
    inputBox(request: InputBoxRequest, signal: AbortSignal): Promise<string | null>;
  };
}

/**
 * The window as hosts see it before and after the window provides its own (`workspaces.ts`):
 * every member of `ExtensionWindow` forwarded to the one `current()` returns. EXT-27 made it a
 * function of its own, tested member by member: the proxy written by hand had not forwarded
 * `documents.edit` (EXT-25), so no extension edit ever reached a document in the application.
 * Before the window is provided, reads see nothing and actions are refused (`Unavailable`).
 */
export function createWindowProxy(current: () => ExtensionWindow | null): ExtensionWindow {
  const unavailable = (): never => {
    throw Object.assign(new Error("The window is not ready."), { code: "Unavailable" });
  };
  const window = () => current() ?? unavailable();
  return {
    documents: {
      all: () => current()?.documents.all() ?? [],
      get: (resource) => current()?.documents.get(resource) ?? null,
      text: (resource) => current()?.documents.text(resource) ?? null,
      subscribe: (listener) => current()?.documents.subscribe(listener) ?? (() => {}),
      edit: (resource, version, edits) => {
        const edit = window().documents.edit;
        if (!edit) unavailable();
        return edit!(resource, version, edits);
      },
    },
    editor: {
      active: () => current()?.editor.active() ?? null,
      onActive: (listener) => current()?.editor.onActive(listener) ?? (() => {}),
      onSelection: (listener) => current()?.editor.onSelection?.(listener) ?? (() => {}),
      openLocation: async (path, range) => window().editor.openLocation(path, range),
      setSelection: (range) => current()?.editor.setSelection(range) ?? false,
      revealRange: (range) => current()?.editor.revealRange(range) ?? false,
    },
    readFile: async (path) => window().readFile(path),
    // The window's own focus store, when it has one (read when a host starts following it).
    get focus() {
      return current()?.focus;
    },
    // EXT-29: file changes, and the prompts (refused before the window provides them).
    files: {
      subscribe: (listener) => current()?.files?.subscribe(listener) ?? (() => {}),
    },
    prompts: {
      quickPick: async (request, signal) => {
        const prompts = window().prompts;
        if (!prompts) unavailable();
        return prompts!.quickPick(request, signal);
      },
      inputBox: async (request, signal) => {
        const prompts = window().prompts;
        if (!prompts) unavailable();
        return prompts!.inputBox(request, signal);
      },
    },
  };
}

// --- Window-level stores the host writes and the editor reads --------------------------------

/** The styles an extension may give a decoration: a fixed set, never CSS of its own. */
export const DECORATION_STYLES = [
  "highlight",
  "underline-info",
  "underline-warning",
  "underline-error",
  "dimmed",
] as const;
export type DecorationStyle = (typeof DECORATION_STYLES)[number];

export interface ExtensionDecoration {
  range: ExtensionRange;
  style: DecorationStyle;
  hover: string | null;
}

export interface DecorationSet {
  /** `<extensionId>:<key>` -- an extension owns only its own keys. */
  owner: string;
  extensionId: string;
  resource: ResourceId;
  decorations: readonly ExtensionDecoration[];
  /** The host generation that set it (EXT-08): only that host's cleanup removes it. */
  generation?: number;
}

/** Extension decorations, by owner and resource; the editor shows them (`extensionMonaco.ts`). */
export function createDecorationStore() {
  let sets: readonly DecorationSet[] = [];
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    getSnapshot: () => sets,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(set: DecorationSet) {
      sets = [
        ...sets.filter((one) => !(one.owner === set.owner && one.resource === set.resource)),
        set,
      ].filter((one) => one.decorations.length);
      changed();
    },
    /**
     * Everything of an extension (deactivated, crashed, its host ended) -- of host `generation`
     * when given: a host that ended never removes what its replacement set (EXT-08).
     */
    clearExtension(extensionId: string, generation?: number) {
      const mine = (one: DecorationSet) =>
        one.extensionId === extensionId &&
        (generation === undefined || one.generation === generation);
      if (!sets.some(mine)) return;
      sets = sets.filter((one) => !mine(one));
      changed();
    },
    clear() {
      if (!sets.length) return;
      sets = [];
      changed();
    },
  };
}
export type DecorationStore = ReturnType<typeof createDecorationStore>;

/** An extension's status bar item (EXT-25): text in Yavin's own style, never markup of its own. */
export interface StatusBarEntry {
  /** `<extensionId>#status#<n>`: an extension owns only its own. */
  id: string;
  extensionId: string;
  text: string;
  tooltip: string | null;
  alignment: "left" | "right";
  priority: number;
  /** Clicking it runs what the extension gave it (`statusBar.activate`). */
  clickable: boolean;
  /** The host generation that set it (EXT-08): only that host's cleanup removes it. */
  generation?: number;
}

/** Extensions' status bar items; the status bar shows them, highest priority first per side. */
export function createStatusBarStore() {
  let entries: readonly StatusBarEntry[] = [];
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    getSnapshot: () => entries,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(entry: StatusBarEntry) {
      entries = [...entries.filter((one) => one.id !== entry.id), entry].sort(
        (a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
      changed();
    },
    remove(id: string, generation?: number) {
      const mine = (one: StatusBarEntry) =>
        one.id === id && (generation === undefined || one.generation === generation);
      if (!entries.some(mine)) return;
      entries = entries.filter((one) => !mine(one));
      changed();
    },
    /** Everything of an extension -- of host `generation` when given (EXT-08). */
    clearExtension(extensionId: string, generation?: number) {
      const mine = (one: StatusBarEntry) =>
        one.extensionId === extensionId &&
        (generation === undefined || one.generation === generation);
      if (!entries.some(mine)) return;
      entries = entries.filter((one) => !mine(one));
      changed();
    },
  };
}
export type StatusBarStore = ReturnType<typeof createStatusBarStore>;

export const PROVIDER_KINDS = [
  "completion",
  "hover",
  "definition",
  "references",
  "symbols",
  // EXT-29: formatting a document or a range, and code actions (quick fixes and the like).
  "formatting",
  "rangeFormatting",
  "codeActions",
] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** What some kinds are asked with besides the document (EXT-29). */
export interface ProviderExtra {
  /** Formatting a range, or the range code actions are asked for. */
  range?: ExtensionRange;
  /** The editor's indentation, for formatting. */
  options?: { tabSize: number; insertSpaces: boolean };
  /** The problems in the range, for code actions (as the Problems view holds them). */
  diagnostics?: readonly {
    range: ExtensionRange;
    message: string;
    severity: "error" | "warning" | "info" | "hint";
    source?: string;
    code?: string;
  }[];
  /** Only actions of this kind (e.g. `quickfix`), when the editor asks for one kind. */
  only?: string;
  trigger?: "invoke" | "automatic";
}

export interface LanguageProvider {
  providerId: string;
  extensionId: string;
  kind: ProviderKind;
  language: string;
  /** The host generation that registered it (EXT-08): only that host removes it. */
  generation?: number;
  /** Asks the provider; rejects on timeout or failure, never hangs. */
  invoke(
    params: {
      document: DocumentInfo;
      position: { line: number; column: number } | null;
      extra?: ProviderExtra;
    },
    signal: AbortSignal,
  ): Promise<unknown>;
  /** A chosen code action's command, run in its extension (EXT-29; code-action providers only). */
  runAction?(handle: number): Promise<unknown>;
}

/** Extension language providers (separate from language servers); the editor asks them. */
export function createProviderRegistry() {
  let providers: readonly LanguageProvider[] = [];
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    getSnapshot: () => providers,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    add(provider: LanguageProvider) {
      providers = [...providers, provider];
      changed();
    },
    /** One provider -- of host `generation` when given (provider ids restart per host). */
    remove(providerId: string, generation?: number) {
      const mine = (one: LanguageProvider) =>
        one.providerId === providerId &&
        (generation === undefined || one.generation === generation);
      if (!providers.some(mine)) return;
      providers = providers.filter((one) => !mine(one));
      changed();
    },
    /** Everything of an extension -- of host `generation` when given (EXT-08). */
    clearExtension(extensionId: string, generation?: number) {
      const mine = (one: LanguageProvider) =>
        one.extensionId === extensionId &&
        (generation === undefined || one.generation === generation);
      if (!providers.some(mine)) return;
      providers = providers.filter((one) => !mine(one));
      changed();
    },
    for: (kind: ProviderKind, language: string) =>
      providers.filter((one) => one.kind === kind && one.language === language),
  };
}
export type ProviderRegistry = ReturnType<typeof createProviderRegistry>;
