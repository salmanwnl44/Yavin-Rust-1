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

export type DocumentEvent = "open" | "change" | "close";

export interface ExtensionWindow {
  documents: {
    all(): DocumentInfo[];
    get(resource: ResourceId): DocumentInfo | null;
    text(resource: ResourceId): string | null;
    /** Documents opening, changing (a new version) and closing. */
    subscribe(listener: (event: DocumentEvent, document: DocumentInfo) => void): () => void;
  };
  editor: {
    active(): { document: DocumentInfo; selection: ExtensionRange } | null;
    onActive(listener: () => void): () => void;
    /** Opens a file of the workspace (by its path) at `range`, through the editor's own navigation. */
    openLocation(path: string, range: ExtensionRange | null): Promise<void>;
    /** In the active editor; false when there is none. */
    setSelection(range: ExtensionRange): boolean;
    revealRange(range: ExtensionRange): boolean;
  };
  /** A workspace file's text (the native side refuses anything outside the workspace). */
  readFile(path: string): Promise<string>;
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
    /** Everything of an extension (deactivated, crashed, its host ended). */
    clearExtension(extensionId: string) {
      if (!sets.some((one) => one.extensionId === extensionId)) return;
      sets = sets.filter((one) => one.extensionId !== extensionId);
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

export type ProviderKind = "completion" | "hover" | "definition" | "references" | "symbols";

export interface LanguageProvider {
  providerId: string;
  extensionId: string;
  kind: ProviderKind;
  language: string;
  /** Asks the provider; rejects on timeout or failure, never hangs. */
  invoke(
    params: { document: DocumentInfo; position: { line: number; column: number } | null },
    signal: AbortSignal,
  ): Promise<unknown>;
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
    remove(providerId: string) {
      if (!providers.some((one) => one.providerId === providerId)) return;
      providers = providers.filter((one) => one.providerId !== providerId);
      changed();
    },
    clearExtension(extensionId: string) {
      if (!providers.some((one) => one.extensionId === extensionId)) return;
      providers = providers.filter((one) => one.extensionId !== extensionId);
      changed();
    },
    for: (kind: ProviderKind, language: string) =>
      providers.filter((one) => one.kind === kind && one.language === language),
  };
}
export type ProviderRegistry = ReturnType<typeof createProviderRegistry>;
