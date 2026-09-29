import type { DocumentService, TextDocument } from "./documents.ts";

/**
 * The editor model bridge: how an editing engine's text models relate to the Document Model.
 *
 * ```text
 * DocumentService ── content, versions, persistence ──┐
 *        ^                                             │ open / sync / close
 *        │ edit(key, text)                             v
 *        └──────────── model content change ──── EditorModel (one per document)
 * ```
 *
 * The Document Model stays the source of truth; a model is the editing engine's working copy
 * of a document's text, kept equal to it in both directions:
 *
 * - a change the user makes in the model goes to `documents.edit`, and the version that makes
 *   is recorded as the one the model shows, so the document's report of it writes nothing back;
 * - any other change to the document -- a reload, Revert, replace-in-files -- is applied to
 *   the model as one undoable edit of just the changed span, carrying cursors with it.
 *
 * A guard around each direction stops either from being mistaken for the other; nothing uses
 * timers. Models are keyed by the document itself (the object `DocumentService` keeps for it),
 * so a rename or Save As -- which changes the document's key and id but not the document --
 * keeps its model, its undo history and its views. A model lives while its document is open
 * or an editor view still holds it, and is disposed when neither is true.
 *
 * Written against `EditorModelHost`, not Monaco, so the synchronization rules run under
 * `node --test` with a fake model; `src/editor/monacoHost.ts` is the Monaco implementation.
 */

export interface Disposable {
  dispose(): void;
}

/** A text model as the bridge needs it. */
export interface EditorModel {
  getValue(): string;
  /** Replaces what differs from `text` in one undoable edit, as the engine's own edit would. */
  applyExternal(text: string): void;
  onDidChangeContent(listener: () => void): Disposable;
  setLanguage(languageId: string): void;
  /** Ends the current undo group: the next edit starts a new one. */
  pushUndoStop(): void;
  /** Sets one owner's decorations, replacing that owner's previous ones. */
  setDecorations(owner: string, decorations: readonly EditorDecoration[]): void;
  dispose(): void;
}

/** A decoration over a character span (offsets into the document's text). */
export interface EditorDecoration {
  start: number;
  end: number;
  /** A CSS class for the text span. */
  className?: string;
  /** Marks the whole lines the span covers. */
  wholeLine?: boolean;
  /** Plain text shown on hover -- never HTML. */
  hoverMessage?: string;
}

export interface EditorModelHost {
  /** A model holding `text`, identified by `uri` (the document's resource, as the engine names it). */
  create(text: string, languageId: string, uri: string): EditorModel;
}

/** Where the bridge learns a document's engine language and URI (`src/editor/*`). */
export interface EditorModelNaming {
  languageOf(doc: TextDocument): string;
  uriOf(doc: TextDocument): string;
}

interface Entry {
  doc: TextDocument;
  model: EditorModel;
  /** The document version the model is known to hold. */
  synced: number;
  /** Set while the model's own change is being given to the document. */
  pushing: boolean;
  /** Set while the document's change is being applied to the model. */
  applying: boolean;
  /** Editor views holding the model. */
  holders: number;
  /** The document was closed; dispose as soon as no view holds the model. */
  closed: boolean;
  language: string;
  owners: Set<string>;
  subscription: Disposable;
}

export type EditorModelBridge = ReturnType<typeof createEditorModelBridge>;

export function createEditorModelBridge(
  documents: DocumentService,
  host: EditorModelHost,
  naming: EditorModelNaming,
) {
  const entries = new Map<TextDocument, Entry>();

  const dispose = (entry: Entry) => {
    entries.delete(entry.doc);
    entry.subscription.dispose();
    entry.model.dispose();
  };

  /** Brings a model up to its document, if the document moved on without it. */
  const sync = (entry: Entry) => {
    const { doc, model } = entry;
    if (entry.pushing || doc.version === entry.synced) return;
    entry.applying = true;
    try {
      model.applyExternal(doc.text);
    } finally {
      entry.applying = false;
    }
    entry.synced = doc.version;
  };

  const stop = documents.subscribe((event) => {
    const doc = documents.all().find((one) => one.id === event.id);
    if (event.type === "closed") {
      // The document is gone from the service; find its entry by what the event names.
      for (const entry of entries.values())
        if (entry.doc.id === event.id || entry.doc.key === event.key) {
          entry.closed = true;
          if (entry.holders === 0) dispose(entry);
        }
      return;
    }
    const entry = doc && entries.get(doc);
    if (!entry) return;
    // A save is an undo stop, so Undo can land exactly on the version saved -- typing after
    // it starts a new group instead of extending the one that was saved.
    if (event.type === "saving") entry.model.pushUndoStop();
    sync(entry);
    // A rename or Save As can change what the document is written in.
    const language = naming.languageOf(doc);
    if (language !== entry.language) {
      entry.language = language;
      entry.model.setLanguage(language);
    }
  });

  const bridge = {
    /**
     * The document's model, created from the document's own text the first time. The same
     * model for every later call, whichever key the document then has.
     */
    open(key: string): EditorModel | undefined {
      const doc = documents.get(key);
      if (!doc) return undefined;
      const existing = entries.get(doc);
      if (existing) {
        sync(existing);
        return existing.model;
      }
      const language = naming.languageOf(doc);
      const model = host.create(doc.text, language, naming.uriOf(doc));
      const entry: Entry = {
        doc,
        model,
        synced: doc.version,
        pushing: false,
        applying: false,
        holders: 0,
        closed: false,
        language,
        owners: new Set(),
        subscription: { dispose: () => undefined },
      };
      entry.subscription = model.onDidChangeContent(() => {
        // The document's own change, being shown: not an edit.
        if (entry.applying) return;
        entry.pushing = true;
        try {
          entry.synced = documents.edit(entry.doc.key, model.getValue()).version;
        } finally {
          entry.pushing = false;
        }
      });
      entries.set(doc, entry);
      return model;
    },

    /** An editor view shows the model: it outlives its document's close until released. */
    retain(key: string): EditorModel | undefined {
      const model = bridge.open(key);
      const doc = documents.get(key);
      const entry = doc && entries.get(doc);
      if (entry) entry.holders++;
      return model;
    },
    /** An editor view no longer shows it. */
    release(model: EditorModel): void {
      for (const entry of entries.values())
        if (entry.model === model) {
          entry.holders = Math.max(0, entry.holders - 1);
          if (entry.closed && entry.holders === 0) dispose(entry);
        }
    },

    /** The model of the document at `key`, if it has one. */
    get(key: string): EditorModel | undefined {
      const doc = documents.get(key);
      return doc ? entries.get(doc)?.model : undefined;
    },
    /** The document a model belongs to -- its current key and resource, after any rename. */
    documentOf(model: EditorModel): TextDocument | undefined {
      for (const entry of entries.values()) if (entry.model === model) return entry.doc;
      return undefined;
    },
    /** How many models are alive -- for tests and leak checks. */
    size: (): number => entries.size,

    /**
     * An owner's decorations on a document's model -- diagnostics, Git changes, search
     * matches, AI edits: each owner's set is replaced or cleared without touching the others.
     */
    setDecorations(key: string, owner: string, decorations: readonly EditorDecoration[]): void {
      const doc = documents.get(key);
      const entry = doc && entries.get(doc);
      if (!entry) return;
      entry.owners.add(owner);
      entry.model.setDecorations(owner, decorations);
    },
    clearDecorations(key: string, owner: string): void {
      bridge.setDecorations(key, owner, []);
    },

    /** Disposes every model and stops listening: the window is going away. */
    dispose(): void {
      stop();
      for (const entry of [...entries.values()]) dispose(entry);
    },
  };
  return bridge;
}

/**
 * How many characters `a` and `b` have in common from the start (or, with `fromEnd`, from the
 * end), up to `max`. Compared in growing chunks with native string equality rather than a
 * character at a time: a keystroke in a megabyte file compares the whole file on every edit,
 * and that is the difference between a fraction of a millisecond and several.
 */
function matching(a: string, b: string, max: number, fromEnd: boolean): number {
  let at = 0;
  let step = 256;
  while (at < max) {
    const size = Math.min(step, max - at);
    const same = fromEnd
      ? a.slice(a.length - at - size, a.length - at) ===
        b.slice(b.length - at - size, b.length - at)
      : a.slice(at, at + size) === b.slice(at, at + size);
    if (same) {
      at += size;
      step *= 2;
    } else if (size === 1) break;
    else step = size >> 1;
  }
  return at;
}

/**
 * The span of `before` that became something else in `after`: the text between their longest
 * common prefix and suffix. What an external change replaces, so cursors outside it stay put.
 */
export function changedSpan(
  before: string,
  after: string,
): { start: number; end: number; text: string } {
  const shorter = Math.min(before.length, after.length);
  const prefix = matching(before, after, shorter, false);
  const suffix = matching(before, after, shorter - prefix, true);
  return {
    start: prefix,
    end: before.length - suffix,
    text: after.slice(prefix, after.length - suffix),
  };
}
