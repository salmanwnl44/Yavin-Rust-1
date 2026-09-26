import {
  basename,
  fileUri,
  fsPath,
  parseUri,
  relativePath,
  resourceId,
  unprefixed,
} from "./resource.ts";
import type { ResourceUri } from "./resource.ts";
import type { ResourceChange } from "./resourceEvents.ts";
import { languageFor } from "./language.ts";

/**
 * The Document Model: the one owner of what is open in memory.
 *
 * A document is text being worked on -- a file's contents as loaded and then edited, an
 * untitled buffer, or content Yavin proposes for a file. The filesystem stays the owner of
 * what is on disk; this owns the in-memory copy, how it relates to the disk (the exact text
 * it was loaded from or last saved as), whether it has changes that are not there yet, and
 * what happened to the file underneath it while it was open.
 *
 * ```text
 * Filesystem ── read ──> Document ── edit ──> dirty ── save (Module 03/04 operation) ──> Filesystem
 *      │                    ^
 *      └── resource-changes (Module 02) ── verify against the base ──> reload | conflict
 * ```
 *
 * What it does not own: the editor's presentation and undo stack (the editor), Git status,
 * language state, the index, AI runs, ChangeSets. Every disk mutation still goes through the
 * native operation system (`write_file_guarded`, `create_file_with_content`), which records
 * Module 04's recovery intent and Module 03's watcher expectations; this never writes a file
 * any other way.
 *
 * Identity: a disk document is identified by its Module 01 `ResourceId`, so one resource has
 * at most one document however its path is spelled. Untitled documents and proposals have ids
 * of their own (`untitled:3`, `proposed:1`) -- a proposal is not the file, and the file can be
 * open beside it.
 *
 * The core is written against `DocumentIO` rather than the native bridge, so it runs under
 * `node --test` with a fake disk.
 */

export type DocumentId = string & { readonly __documentId: unique symbol };

/**
 * Where a document's content comes from. A union rather than flags, so that "untitled and
 * proposed" cannot be spelled.
 */
export type DocumentSource =
  | { readonly kind: "disk" }
  | { readonly kind: "untitled" }
  /** `baseHash` is the fingerprint of the file the proposal was made against, null when it
   * proposes a file that did not exist. */
  | { readonly kind: "proposed"; readonly baseHash: string | null };

/** The encodings Yavin reads: UTF-8, with or without a byte order mark. */
export type Encoding = "utf8" | "utf8bom";
/** How lines end on disk. In memory they always end in `\n`, as the editor presents them. */
export type LineEnding = "lf" | "crlf";

/** What happened to the file underneath an open document, when it no longer matches. */
export type ExternalChange =
  /** The file's content is not what the document was loaded from or last saved as. */
  | { readonly kind: "modified"; readonly fingerprint: string }
  /** The file is gone. Saving recreates it. */
  | { readonly kind: "deleted" }
  /** The file is there but could not be read (locked, too large, no longer text). */
  | { readonly kind: "unreadable"; readonly message: string };

export type SaveActivity =
  | { readonly kind: "idle" }
  /** A save of `version` is on its way to disk. */
  | { readonly kind: "saving"; readonly version: number }
  /** The last save, of `version`, did not reach the disk. */
  | { readonly kind: "failed"; readonly version: number; readonly message: string };

/** The exact text on disk that a document corresponds to, and its fingerprint. */
export interface DiskBase {
  /** As read or written: byte order mark and `\r\n` included. What a guarded save expects. */
  readonly raw: string;
  readonly fingerprint: string;
}

export interface TextDocument {
  readonly id: DocumentId;
  /** The resource: the file for a disk document, the file proposed for a proposal. */
  readonly uri: ResourceUri | null;
  /** The path as the native side takes it; null for an untitled document. */
  readonly path: string | null;
  /**
   * What the editor keys the document by: `path` for a file, `id` for anything else. Changes
   * when the document does (`sourceChanged`).
   */
  readonly key: string;
  readonly name: string;
  readonly source: DocumentSource;
  /** The content, with `\n` line endings and no byte order mark. */
  readonly text: string;
  /** Increases whenever `text` changes, including by a reload. Never reused. */
  readonly version: number;
  /** Whether `text` is not what is known to be on disk. Derived, never set directly. */
  readonly dirty: boolean;
  readonly encoding: Encoding;
  readonly lineEnding: LineEnding;
  readonly languageId: string;
  /** The disk text this document was loaded from or last saved as; null if none. */
  readonly base: DiskBase | null;
  readonly external: ExternalChange | null;
  readonly save: SaveActivity;
}

export type DocumentStatus =
  | "neverSaved"
  | "clean"
  | "dirty"
  | "saving"
  | "saveFailed"
  | "externallyChanged"
  | "conflicted"
  | "proposed"
  | "stale";

/**
 * The one state a document is in, from its parts. Derived rather than stored so that no two
 * of them can disagree: "saving" is never "clean", and a conflict is exactly "the disk
 * changed and there are unsaved edits".
 */
export function documentStatus(doc: TextDocument): DocumentStatus {
  if (doc.source.kind === "proposed") return doc.external ? "stale" : "proposed";
  if (doc.save.kind === "saving") return "saving";
  if (doc.source.kind === "untitled") return "neverSaved";
  if (doc.external) {
    if (doc.external.kind === "deleted") return "externallyChanged";
    return doc.dirty ? "conflicted" : "externallyChanged";
  }
  if (doc.save.kind === "failed" && doc.dirty) return "saveFailed";
  return doc.dirty ? "dirty" : "clean";
}

export type DocumentEvent =
  | { readonly type: "opened"; readonly id: DocumentId }
  | { readonly type: "changed"; readonly id: DocumentId; readonly version: number }
  | { readonly type: "saving"; readonly id: DocumentId; readonly version: number }
  | { readonly type: "saved"; readonly id: DocumentId; readonly version: number }
  | {
      readonly type: "saveFailed";
      readonly id: DocumentId;
      readonly version: number;
      readonly message: string;
    }
  /** The disk stopped (or, with `change: null`, started again) matching the document. */
  | {
      readonly type: "externallyChanged";
      readonly id: DocumentId;
      readonly change: ExternalChange | null;
    }
  /** The disk changed under unsaved edits. Both versions are kept; nothing was written. */
  | { readonly type: "conflict"; readonly id: DocumentId }
  | { readonly type: "reloaded"; readonly id: DocumentId; readonly version: number }
  /** Save As, or a rename by Yavin: the document now has another identity. */
  | {
      readonly type: "sourceChanged";
      readonly id: DocumentId;
      readonly key: string;
      readonly previousId: DocumentId;
      readonly previousKey: string;
    }
  | { readonly type: "closed"; readonly id: DocumentId; readonly key: string };

export type DocumentErrorCode =
  "untitled" | "proposed" | "dirty" | "saving" | "conflict" | "open" | "not-open";

export class DocumentError extends Error {
  readonly code: DocumentErrorCode;
  constructor(code: DocumentErrorCode, message: string) {
    super(message);
    this.name = "DocumentError";
    this.code = code;
  }
}

/** The disk, as the Document Model reaches it: the native commands, or a fake in tests. */
export interface DocumentIO {
  /** The file's text exactly as stored. Fails for a file that is missing, binary or too large. */
  read(path: string): Promise<string>;
  /**
   * Replaces the file with `content`, only if it still holds exactly `expected` -- one Module
   * 03 operation with its Module 04 intent. Resolves to that operation's id when known.
   */
  write(path: string, expected: string, content: string): Promise<unknown>;
  /** Creates the file with `content`, failing if anything is already there. Same guarantees. */
  create(path: string, content: string): Promise<unknown>;
}

// ---------------------------------------------------------------------------------------
// Encoding, line endings, fingerprints
// ---------------------------------------------------------------------------------------

export interface Decoded {
  text: string;
  encoding: Encoding;
  lineEnding: LineEnding;
}

/**
 * Disk text to document text: the byte order mark removed and remembered, line endings made
 * `\n` -- what a textarea would do to it anyway -- with the file's own style remembered so a
 * save writes it back. A file mixing both gets the one most of its lines use, as VS Code does.
 */
export function decode(raw: string): Decoded {
  const bom = raw.charCodeAt(0) === 0xfeff;
  const body = bom ? raw.slice(1) : raw;
  let crlf = 0;
  let lf = 0;
  for (let index = body.indexOf("\n"); index !== -1; index = body.indexOf("\n", index + 1)) {
    if (index > 0 && body.charCodeAt(index - 1) === 13) crlf++;
    else lf++;
  }
  return {
    text: normalize(body),
    encoding: bom ? "utf8bom" : "utf8",
    lineEnding: crlf > lf ? "crlf" : "lf",
  };
}

/** Document text back to disk text. `decode(encode(t, e, l))` is `{ text: t, ... }`. */
export function encode(text: string, encoding: Encoding, lineEnding: LineEnding): string {
  const body = lineEnding === "crlf" ? text.replace(/\n/g, "\r\n") : text;
  return encoding === "utf8bom" ? "﻿" + body : body;
}

/** Every line ending as `\n`, as the editor holds text. */
const normalize = (text: string): string =>
  text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;

/**
 * A 64-bit fingerprint of disk text, with its length. Computed when text is loaded or saved,
 * never per keystroke. For a document whose disk text is held, the text itself is compared;
 * the fingerprint is what a proposal or an event carries instead of the text.
 */
export function fingerprint(raw: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < raw.length; index++) {
    const code = raw.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex = (value: number) => (value >>> 0).toString(16).padStart(8, "0");
  return `${raw.length}:${hex(h2)}${hex(h1)}`;
}

const baseOf = (raw: string): DiskBase => ({ raw, fingerprint: fingerprint(raw) });

// ---------------------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------------------

interface Doc {
  id: DocumentId;
  uri: ResourceUri | null;
  path: string | null;
  key: string;
  name: string;
  source: DocumentSource;
  text: string;
  version: number;
  dirty: boolean;
  encoding: Encoding;
  lineEnding: LineEnding;
  languageId: string;
  base: DiskBase | null;
  external: ExternalChange | null;
  save: SaveActivity;
  /** The text known to be on disk, and the version it was. */
  persisted: { version: number; text: string } | null;
  /** The ids of this document's own recent save operations, which the watcher credits. */
  own: number[];
  /** Changes reported while a save was in flight: their operation ids, to check once it ends. */
  recheck: (number | undefined)[] | null;
  /** Bumped by every disk check, so a slower earlier one cannot overwrite a later one. */
  checking: number;
}

const IDLE: SaveActivity = { kind: "idle" };
const saving = (doc: Doc) => doc.save.kind === "saving";
const OWN_OPERATIONS = 16;
const SYNTHETIC = /^(untitled|proposed):\d+$/;

/**
 * Clean when the current version is the persisted one, or its text is the persisted text.
 * Nothing persisted (`null`: the file was deleted) is never clean -- memory is the only copy.
 */
const isDirty = (doc: Doc): boolean =>
  doc.source.kind !== "proposed" &&
  (doc.persisted === null ||
    (doc.persisted.version !== doc.version && doc.persisted.text !== doc.text));

const asOperation = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : null;

export interface DocumentServiceOptions {
  /** The folder a relative path is resolved against (the workspace), if any. */
  base?: () => string | null;
}

export type DocumentService = ReturnType<typeof createDocumentService>;

export function createDocumentService(io: DocumentIO, options: DocumentServiceOptions = {}) {
  const docs = new Map<DocumentId, Doc>();
  const opening = new Map<DocumentId, Promise<TextDocument | null>>();
  const listeners = new Set<(event: DocumentEvent) => void>();
  /** Bumped by `reset`: work started before it must not bring its documents back. */
  let epoch = 0;
  let revision = 0;
  let untitled = 0;
  let proposals = 0;
  let buffers: Record<string, string> | null = null;

  const emit = (event: DocumentEvent) => {
    revision++;
    buffers = null;
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error("Document listener failed:", error);
      }
    }
  };

  /** A path or `file:` URI as the resource it names, and the path to hand the native side. */
  const resolve = (input: string): { uri: ResourceUri; path: string } => {
    if (/^file:/i.test(input)) {
      const uri = parseUri(input);
      return { uri, path: fsPath(uri) };
    }
    try {
      // The spelling it was given is kept, so it matches the explorer's and Git's paths.
      return { uri: fileUri(input), path: unprefixed(input) };
    } catch (error) {
      const folder = options.base?.();
      if (!folder) throw error;
      const uri = fileUri(input, fileUri(folder));
      return { uri, path: fsPath(uri) };
    }
  };
  const diskId = (uri: ResourceUri) => resourceId(uri) as string as DocumentId;

  const lookup = (key: string): Doc | undefined => {
    if (SYNTHETIC.test(key)) return docs.get(key as DocumentId);
    try {
      return docs.get(diskId(resolve(key).uri));
    } catch {
      return undefined;
    }
  };
  const required = (key: string): Doc => {
    const doc = lookup(key);
    if (!doc) throw new DocumentError("not-open", `${key} is not open.`);
    return doc;
  };
  const live = (doc: Doc) => docs.get(doc.id) === doc;

  const fromDisk = (id: DocumentId, uri: ResourceUri, path: string, raw: string): Doc => {
    const decoded = decode(raw);
    const name = basename(uri) || path;
    return {
      id,
      uri,
      path,
      key: path,
      name,
      source: { kind: "disk" },
      text: decoded.text,
      version: 1,
      dirty: false,
      encoding: decoded.encoding,
      lineEnding: decoded.lineEnding,
      languageId: languageFor(name),
      base: baseOf(raw),
      external: null,
      save: IDLE,
      persisted: { version: 1, text: decoded.text },
      own: [],
      recheck: null,
      checking: 0,
    };
  };

  /** Replaces the document with what is on disk: a new version, clean, in step with the disk. */
  const adoptDisk = (doc: Doc, raw: string) => {
    const decoded = decode(raw);
    doc.version++;
    doc.text = decoded.text;
    doc.encoding = decoded.encoding;
    doc.lineEnding = decoded.lineEnding;
    doc.base = baseOf(raw);
    doc.persisted = { version: doc.version, text: decoded.text };
    doc.external = null;
    if (doc.save.kind === "failed") doc.save = IDLE;
    doc.dirty = false;
    emit({ type: "reloaded", id: doc.id, version: doc.version });
  };

  const setExternal = (doc: Doc, change: ExternalChange | null) => {
    const same =
      doc.external === change ||
      (doc.external !== null &&
        change !== null &&
        doc.external.kind === change.kind &&
        JSON.stringify(doc.external) === JSON.stringify(change));
    if (same) return;
    doc.external = change;
    doc.dirty = isDirty(doc);
    emit({ type: "externallyChanged", id: doc.id, change });
    if (change?.kind === "modified" && doc.dirty && doc.source.kind === "disk")
      emit({ type: "conflict", id: doc.id });
  };

  /**
   * Compares the file with what the document knows of it, and acts on the difference: nothing
   * if it is the same text; a reload if the document has no unsaved edits; a conflict --
   * nothing written, nothing replaced -- if it has. `gone` says the change was a deletion, so
   * a file that cannot be read is missing rather than unreadable.
   */
  const verify = async (doc: Doc, gone = false): Promise<void> => {
    if (doc.source.kind === "untitled" || !doc.path) return;
    if (doc.save.kind === "saving") {
      (doc.recheck ??= []).push(undefined);
      return;
    }
    const check = ++doc.checking;
    let raw: string | null = null;
    let failure = "";
    try {
      raw = await io.read(doc.path);
    } catch (error) {
      failure = String(error);
    }
    if (!live(doc) || check !== doc.checking) return;
    // A save started while this was reading: its end decides. (Read through `saving`: the
    // narrowing above does not survive the await.)
    if (saving(doc)) {
      (doc.recheck ??= []).push(undefined);
      return;
    }
    if (doc.source.kind === "proposed") {
      // A proposal is stale once its file is not the one it was made against.
      const current = raw === null ? null : fingerprint(raw);
      const base = doc.base?.fingerprint ?? null;
      if (current === base) setExternal(doc, null);
      else if (current === null) setExternal(doc, { kind: "deleted" });
      else setExternal(doc, { kind: "modified", fingerprint: current });
      return;
    }
    if (raw === null) {
      // Deleted, the text is held nowhere but here: dirty until it is on disk again, so it is
      // neither closed nor replaced by a new file there without the user choosing.
      if (gone && doc.source.kind === "disk") doc.persisted = null;
      setExternal(doc, gone ? { kind: "deleted" } : { kind: "unreadable", message: failure });
      return;
    }
    if (doc.base && raw === doc.base.raw) {
      // Back as it was (a deleted file restored): persisted again.
      doc.persisted ??= { version: -1, text: decode(raw).text };
      setExternal(doc, null);
      return;
    }
    if (!doc.dirty) {
      adoptDisk(doc, raw);
      return;
    }
    setExternal(doc, { kind: "modified", fingerprint: fingerprint(raw) });
  };

  const remember = (doc: Doc, operation: number | null) => {
    if (operation === null) return;
    doc.own.push(operation);
    if (doc.own.length > OWN_OPERATIONS) doc.own.shift();
  };

  /** After a save: checks the changes that arrived during it, unless all were its own. */
  const settle = async (doc: Doc, failed: boolean) => {
    const deferred = doc.recheck;
    doc.recheck = null;
    if (!live(doc)) return;
    const foreign = deferred?.some((op) => op === undefined || !doc.own.includes(op)) ?? false;
    // A failed save is always checked: the disk having changed is the likeliest reason.
    if (failed || foreign) await verify(doc);
  };

  /** Writes `raw` for `doc` at `path` -- replacing `expected`, or creating when it is null. */
  const persist = async (path: string, expected: string | null, raw: string) =>
    asOperation(
      expected === null ? await io.create(path, raw) : await io.write(path, expected, raw),
    );

  const service = {
    /** For `useSyncExternalStore`: the listener is also handed the event. */
    subscribe(listener: (event: DocumentEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Changes whenever any document does. */
    revision: (): number => revision,

    get(key: string): TextDocument | undefined {
      return lookup(key);
    },
    all(): TextDocument[] {
      return [...docs.values()];
    },
    anySaving(): boolean {
      return [...docs.values()].some((doc) => doc.save.kind === "saving");
    },
    /**
     * The text of every document an editor can show, by key -- the compatibility view for the
     * components that still take `Record<path, text>`. The strings are the documents' own, not
     * copies; the record is rebuilt only after a change.
     */
    buffers(): Record<string, string> {
      if (!buffers) {
        buffers = {};
        for (const doc of docs.values())
          if (doc.source.kind !== "proposed") buffers[doc.key] = doc.text;
      }
      return buffers;
    },

    /**
     * The document for a file, loading it the first time. Every spelling of the same resource
     * -- slashes, case on Windows, `\\?\`, a `file:` URI, a path relative to the workspace --
     * returns the same document, and concurrent opens share one read. Null if `reset` ran
     * while it was loading. Fails, changing nothing, for a file that cannot be read as text.
     */
    open(input: string): Promise<TextDocument | null> {
      const { uri, path } = resolve(input);
      const id = diskId(uri);
      const existing = docs.get(id);
      if (existing) return Promise.resolve(existing);
      const pending = opening.get(id);
      if (pending) return pending;
      const started = epoch;
      const loading = io.read(path).then((raw) => {
        if (started !== epoch) return null;
        const again = docs.get(id);
        if (again) return again;
        const doc = fromDisk(id, uri, path, raw);
        docs.set(id, doc);
        emit({ type: "opened", id });
        return doc;
      });
      opening.set(id, loading);
      const done = () => {
        if (opening.get(id) === loading) opening.delete(id);
      };
      loading.then(done, done);
      return loading;
    },

    createUntitled(init: { name?: string; languageId?: string; text?: string } = {}): TextDocument {
      const number = ++untitled;
      const id = `untitled:${number}` as DocumentId;
      const name = init.name ?? `Untitled-${number}`;
      const text = normalize(init.text ?? "");
      const doc: Doc = {
        id,
        uri: null,
        path: null,
        key: id,
        name,
        source: { kind: "untitled" },
        text,
        version: 1,
        dirty: false,
        encoding: "utf8",
        lineEnding: "lf",
        languageId: init.languageId ?? languageFor(name),
        base: null,
        external: null,
        save: IDLE,
        persisted: { version: 0, text: "" },
        own: [],
        recheck: null,
        checking: 0,
      };
      doc.dirty = isDirty(doc);
      docs.set(id, doc);
      emit({ type: "opened", id });
      return doc;
    },

    /**
     * Content proposed for `target`, as a document of its own beside the file. It remembers
     * the file it was made against (none, for a file that does not exist yet) and is never
     * saved over it: accepting a proposal belongs to ChangeSets (Module 13).
     */
    async propose(target: string, content: string): Promise<TextDocument> {
      const { uri, path } = resolve(target);
      let raw: string | null = null;
      try {
        raw = await io.read(path);
      } catch {
        // Nothing readable there: the proposal is for a new file.
      }
      const decoded = raw === null ? null : decode(raw);
      const base = raw === null ? null : baseOf(raw);
      const id = `proposed:${++proposals}` as DocumentId;
      const name = basename(uri) || path;
      const text = normalize(content);
      const doc: Doc = {
        id,
        uri,
        path,
        key: id,
        name,
        source: { kind: "proposed", baseHash: base?.fingerprint ?? null },
        text,
        version: 1,
        dirty: false,
        encoding: decoded?.encoding ?? "utf8",
        lineEnding: decoded?.lineEnding ?? "lf",
        languageId: languageFor(name),
        base,
        external: null,
        save: IDLE,
        persisted: { version: 1, text },
        own: [],
        recheck: null,
        checking: 0,
      };
      docs.set(id, doc);
      emit({ type: "opened", id });
      return doc;
    },

    /** A proposal's fingerprints: what it was made against, and what it would write. */
    proposal(key: string): { baseHash: string | null; proposedHash: string } {
      const doc = required(key);
      if (doc.source.kind !== "proposed")
        throw new DocumentError("proposed", `${doc.name} is not a proposal.`);
      return {
        baseHash: doc.source.baseHash,
        proposedHash: fingerprint(encode(doc.text, doc.encoding, doc.lineEnding)),
      };
    },

    /** Re-reads a proposal's file: true if it is no longer the one the proposal was made against. */
    async isStale(key: string): Promise<boolean> {
      const doc = required(key);
      if (doc.source.kind !== "proposed")
        throw new DocumentError("proposed", `${doc.name} is not a proposal.`);
      await verify(doc);
      return doc.external !== null;
    },

    /** The document's text is now `text`: a new version, and dirty unless it is what is on disk. */
    edit(key: string, text: string): TextDocument {
      const doc = required(key);
      const next = normalize(text);
      if (next === doc.text) return doc;
      doc.text = next;
      doc.version++;
      doc.dirty = isDirty(doc);
      emit({ type: "changed", id: doc.id, version: doc.version });
      return doc;
    },

    /**
     * Writes the document to its file through a guarded Module 03 operation, replacing only
     * the exact text it was loaded from or last saved as. Clean afterwards only if nothing was
     * typed while it was on its way: completion marks the version it wrote, not the current
     * one. Fails -- leaving the document dirty -- if the write fails; if that was because the
     * file changed on disk, the document is in conflict and nothing was overwritten.
     */
    async save(key: string): Promise<TextDocument> {
      const doc = required(key);
      if (doc.source.kind === "untitled")
        throw new DocumentError("untitled", `${doc.name} has never been saved. Use Save As.`);
      if (doc.source.kind === "proposed")
        throw new DocumentError(
          "proposed",
          `${doc.name} is a proposal; it is never saved over its file.`,
        );
      if (doc.save.kind === "saving") return doc;
      // Refused only for a known conflict, which the user resolves first. A file that could
      // not be read is tried: the native side compares it with the base before replacing it.
      if (doc.external?.kind === "modified")
        throw new DocumentError(
          "conflict",
          `${doc.name} changed on disk. Revert it, or keep your version, before saving.`,
        );
      const recreate = doc.external?.kind === "deleted" || !doc.base;
      if (!doc.dirty && !recreate) return doc;
      const path = doc.path!;
      const version = doc.version;
      const text = doc.text;
      const raw = encode(text, doc.encoding, doc.lineEnding);
      doc.save = { kind: "saving", version };
      emit({ type: "saving", id: doc.id, version });
      let operation: number | null;
      try {
        operation = await persist(path, recreate ? null : doc.base!.raw, raw);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        doc.save = { kind: "failed", version, message };
        if (live(doc)) emit({ type: "saveFailed", id: doc.id, version, message });
        await settle(doc, true);
        throw error;
      }
      remember(doc, operation);
      doc.base = baseOf(raw);
      doc.persisted = { version, text };
      doc.external = null;
      doc.save = IDLE;
      doc.dirty = isDirty(doc);
      if (live(doc)) emit({ type: "saved", id: doc.id, version });
      await settle(doc, false);
      return doc;
    },

    /**
     * Writes the document to `target` and makes it that file's document: an untitled document
     * becomes a disk one; a file's document moves to the new file, leaving the old one as it is
     * on disk. A file already at `target` is replaced only if it still holds what was read
     * from it a moment before -- the dialog has asked about replacing it.
     */
    async saveAs(key: string, target: string): Promise<TextDocument> {
      const doc = required(key);
      if (doc.source.kind === "proposed")
        throw new DocumentError("proposed", `${doc.name} is a proposal; accept it instead.`);
      if (doc.save.kind === "saving")
        throw new DocumentError("saving", `${doc.name} is being saved.`);
      const { uri, path } = resolve(target);
      const id = diskId(uri);
      if (id === doc.id) return service.save(key);
      if (docs.has(id))
        throw new DocumentError("open", `${path} is open in another editor. Close it first.`);
      const started = epoch;
      const version = doc.version;
      const text = doc.text;
      const raw = encode(text, doc.encoding, doc.lineEnding);
      doc.save = { kind: "saving", version };
      emit({ type: "saving", id: doc.id, version });
      let operation: number | null;
      try {
        let existing: string | null = null;
        try {
          existing = await io.read(path);
        } catch {
          // Nothing readable there: created, never overwritten (`create` refuses).
        }
        operation = await persist(path, existing, raw);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        doc.save = { kind: "failed", version, message };
        if (live(doc)) emit({ type: "saveFailed", id: doc.id, version, message });
        throw error;
      }
      if (started !== epoch || !live(doc)) return doc;
      const previousId = doc.id;
      const previousKey = doc.key;
      docs.delete(previousId);
      const name = basename(uri) || path;
      Object.assign(doc, {
        id,
        uri,
        path,
        key: path,
        name,
        source: { kind: "disk" },
        languageId: languageFor(name),
        base: baseOf(raw),
        persisted: { version, text },
        external: null,
        save: IDLE,
        own: [],
        recheck: null,
      } satisfies Partial<Doc>);
      remember(doc, operation);
      doc.dirty = isDirty(doc);
      docs.set(id, doc);
      emit({ type: "sourceChanged", id, key: path, previousId, previousKey });
      return doc;
    },

    /**
     * Replaces the document with the file as it is now. Refused for a document with unsaved
     * edits unless `discard` says the user chose to lose them -- a reload never happens to
     * edits silently. Fails, changing nothing, if the file cannot be read.
     */
    async reload(key: string, { discard = false } = {}): Promise<TextDocument> {
      const doc = required(key);
      if (doc.source.kind !== "disk" || !doc.path)
        throw new DocumentError("untitled", `${doc.name} has no file to reload from.`);
      if (doc.save.kind === "saving")
        throw new DocumentError("saving", `${doc.name} is being saved.`);
      if (doc.dirty && !discard)
        throw new DocumentError("dirty", `${doc.name} has unsaved changes.`);
      const version = doc.version;
      const check = ++doc.checking;
      const raw = await io.read(doc.path);
      if (!live(doc) || check !== doc.checking) return doc;
      // Edited while reading, and the edits were not given up: they are not lost now either.
      if (doc.version !== version && !discard) {
        if (!doc.base || raw !== doc.base.raw)
          setExternal(doc, { kind: "modified", fingerprint: fingerprint(raw) });
        return doc;
      }
      adoptDisk(doc, raw);
      return doc;
    },

    /**
     * Resolves a conflict in favour of the document: the file as it is now becomes its base,
     * so the next save replaces it -- by the user's choice, and still only if it has not
     * changed again in between.
     */
    async keepLocal(key: string): Promise<TextDocument> {
      const doc = required(key);
      if (doc.source.kind !== "disk" || !doc.path || doc.external?.kind !== "modified") return doc;
      const check = ++doc.checking;
      const raw = await io.read(doc.path);
      if (!live(doc) || check !== doc.checking) return doc;
      doc.base = baseOf(raw);
      doc.persisted = { version: -1, text: decode(raw).text };
      doc.dirty = isDirty(doc);
      setExternal(doc, null);
      return doc;
    },

    /**
     * Forgets a document. Refused while it is being saved, and -- unless `discard` says the
     * user chose to lose them -- while it has unsaved changes.
     */
    close(key: string, { discard = false } = {}): void {
      const doc = lookup(key);
      if (!doc) return;
      if (doc.save.kind === "saving")
        throw new DocumentError("saving", `${doc.name} is being saved.`);
      if (doc.dirty && !discard)
        throw new DocumentError("dirty", `${doc.name} has unsaved changes.`);
      docs.delete(doc.id);
      doc.checking++;
      emit({ type: "closed", id: doc.id, key: doc.key });
    },

    /** Closes everything, for a change of workspace. Loads still in flight are dropped. */
    reset(): void {
      epoch++;
      opening.clear();
      const closing = [...docs.values()];
      docs.clear();
      for (const doc of closing) {
        doc.checking++;
        emit({ type: "closed", id: doc.id, key: doc.key });
      }
    },

    /**
     * Yavin renamed or moved `from` to `to`: every document at or under it follows. Returns
     * each one's old and new key.
     */
    moved(from: string, to: string): { previousKey: string; key: string }[] {
      const moves: { previousKey: string; key: string }[] = [];
      for (const doc of [...docs.values()]) {
        if (doc.source.kind !== "disk" || !doc.path) continue;
        const rel = relativePath(from, doc.path);
        if (rel === undefined) continue;
        const path = rel === "." ? to : `${to.replace(/\/+$/, "")}/${rel}`;
        const uri = fileUri(path);
        const previousId = doc.id;
        const previousKey = doc.key;
        docs.delete(previousId);
        doc.id = diskId(uri);
        doc.uri = uri;
        doc.path = path;
        doc.key = path;
        doc.name = basename(uri) || path;
        doc.languageId = languageFor(doc.name);
        docs.set(doc.id, doc);
        moves.push({ previousKey, key: path });
        emit({ type: "sourceChanged", id: doc.id, key: path, previousId, previousKey });
        // The watcher may have reported the rename before it returned, and a check of the old
        // path found nothing there: checked again where the file is now, which also drops any
        // check of the old path still reading.
        void verify(doc);
      }
      return moves;
    },

    /** Yavin deleted `path`, the user having agreed: its documents close, edits and all. */
    removed(path: string): string[] {
      const keys: string[] = [];
      for (const doc of [...docs.values()]) {
        if (doc.source.kind !== "disk" || !doc.path) continue;
        if (relativePath(path, doc.path) === undefined) continue;
        docs.delete(doc.id);
        doc.checking++;
        keys.push(doc.key);
        emit({ type: "closed", id: doc.id, key: doc.key });
      }
      return keys;
    },

    /**
     * What the watcher reported (Module 02), applied to the open documents. A change the
     * watcher credits to one of a document's own saves is its own and needs nothing; anything
     * else -- another program, Git, a lost notification (`rescan`) -- is checked against the
     * disk. No timing is involved: attribution is by the state the disk was left in, and
     * everything else by comparing text.
     */
    async applyResourceChanges(
      changes: readonly ResourceChange[],
      rescan: readonly string[] = [],
    ): Promise<void> {
      if (!docs.size) return;
      const byResource = new Map<string, Doc[]>();
      for (const doc of docs.values()) {
        if (!doc.uri) continue;
        const key = resourceId(doc.uri);
        byResource.set(key, [...(byResource.get(key) ?? []), doc]);
      }
      const work = new Map<Doc, { gone: boolean; ops: (number | undefined)[] }>();
      const touch = (path: string, gone: boolean, operation?: number) => {
        let key: string;
        try {
          key = resourceId(fileUri(path));
        } catch {
          return;
        }
        for (const doc of byResource.get(key) ?? []) {
          const entry = work.get(doc) ?? { gone, ops: [] };
          entry.gone = gone;
          entry.ops.push(operation);
          work.set(doc, entry);
        }
      };
      for (const change of changes) {
        if (change.kind === "renamed") {
          touch(change.from, true, change.operation);
          touch(change.path, false, change.operation);
        } else touch(change.path, change.kind === "deleted", change.operation);
      }
      for (const scope of rescan)
        for (const doc of docs.values())
          if (doc.path && relativePath(scope, doc.path) !== undefined)
            work.set(doc, { gone: true, ops: [undefined] });

      const checks: Promise<void>[] = [];
      for (const [doc, { gone, ops }] of work) {
        if (ops.every((op) => op !== undefined && doc.own.includes(op))) continue;
        if (doc.save.kind === "saving") {
          (doc.recheck ??= []).push(...ops);
          continue;
        }
        checks.push(verify(doc, gone));
      }
      await Promise.all(checks);
    },

    /**
     * Checks every open file against the disk -- after something that may have changed files
     * without the watcher being the one to say so, such as a Git command.
     */
    async revalidate(): Promise<void> {
      await Promise.all([...docs.values()].map((doc) => verify(doc)));
    },
  };
  return service;
}
