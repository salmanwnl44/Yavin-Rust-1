import {
  useDeferredValue,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useEffect,
  useSyncExternalStore,
} from "react";
import type { Ref } from "react";
import {
  duplicateSelection,
  selectLine,
  replaceSelection,
  recordEdit,
  stepHistory,
} from "../../services/editor";
import type { TextSelection } from "../../services/editor";
import { showDocumentText } from "../../services/editorBinding";
import type { DocumentService } from "../../services/documents";
import type { EditorViews } from "../../services/editorViews";

export type EditorAction =
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "selectAll"
  | "selectLine"
  | "duplicate"
  | "find"
  | "replace";
export interface EditorState {
  canUndo: boolean;
  canRedo: boolean;
  selected: boolean;
}
export interface EditorHandle {
  execute: (action: EditorAction) => Promise<void>;
  goToLine: (line: number) => void;
  revealRange: (start: number, end: number) => void;
  focus: () => void;
}

/**
 * A view of one document and a way to change it -- never a store of its own.
 *
 * The text is the Document Model's (`documents.ts`). This subscribes to that one document's
 * revision, so typing redraws this editor and not the window around it. The textarea is not
 * controlled by React: the document's text reaches it only through `showDocumentText`, which
 * writes only when the textarea does not already show it (a reload, Revert, a replace), and
 * the user's input reaches the document only through `documents.edit`. The two paths cannot
 * feed each other (see `editorBinding.ts`).
 *
 * What is the editor's own: the caret, selection, scroll position and undo history, kept per
 * document in `views` so they survive switching tabs.
 */
export function TextEditor({
  documentKey,
  documents,
  views,
  editorRef,
  onState,
  wordWrap,
  zoom,
}: {
  /** The document shown: its key in the Document Model. */
  documentKey: string;
  documents: DocumentService;
  views: EditorViews;
  editorRef: Ref<EditorHandle>;
  onState: (state: EditorState) => void;
  wordWrap: boolean;
  zoom: number;
}) {
  useSyncExternalStore(documents.subscribe, () => documents.documentRevision(documentKey));
  const doc = documents.get(documentKey);
  const content = doc?.text ?? "";
  const name = doc?.name ?? documentKey;
  const path = documentKey;
  const textarea = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);

  /**
   * The line numbers, as one string rather than one element per line.
   *
   * This component re-renders on every keystroke and on every unrelated render of the app
   * above it, and an element per line meant a 3,000-line file reconciled 3,000 nodes each
   * time, for a column of text that changes only when a line is added or removed. Counting
   * without `split` avoids allocating the lines themselves just to count them.
   */
  // Counted from a deferred copy of the text: the count is a scan of the whole document, and a
  // keystroke must not wait for it -- React renders the edit first and the gutter after it.
  const counted = useDeferredValue(content);
  const lineCount = useMemo(() => {
    let lines = 1;
    for (let index = 0; index < counted.length; index++)
      if (counted.charCodeAt(index) === 10) lines++;
    return lines;
  }, [counted]);
  const gutterText = useMemo(
    () => Array.from({ length: lineCount }, (_, index) => index + 1).join("\n"),
    [lineCount],
  );
  const beforeInput = useRef<TextSelection | null>(null);
  const [search, setSearch] = useState<"find" | "replace" | null>(null);
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [searchMessage, setSearchMessage] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const history = views.history(path);
  const snapshot = (): TextSelection => ({
    text: textarea.current?.value ?? content,
    start: textarea.current?.selectionStart ?? 0,
    end: textarea.current?.selectionEnd ?? 0,
  });
  /**
   * The document version the textarea is known to show. An edit made here is on the textarea
   * before the document has it, so the version it produces is marked shown at once, and the
   * document's report of it costs nothing -- not even reading back the textarea's text, which
   * for a large file is the whole file.
   */
  const shown = useRef(doc?.version ?? 0);
  /** The user's change, into the document: the one way this editor changes content. */
  const edit = (text: string) => {
    shown.current = documents.edit(path, text).version;
  };
  // Told only when something it shows changes: a new object per keystroke re-rendered the
  // whole window above this editor for every character typed.
  const published = useRef<EditorState | null>(null);
  const publish = () => {
    const next: EditorState = {
      canUndo: history.past.length > 0,
      canRedo: history.future.length > 0,
      selected: (textarea.current?.selectionStart ?? 0) !== (textarea.current?.selectionEnd ?? 0),
    };
    const last = published.current;
    if (
      last &&
      last.canUndo === next.canUndo &&
      last.canRedo === next.canRedo &&
      last.selected === next.selected
    )
      return;
    published.current = next;
    onState(next);
  };
  /**
   * Remembers where the caret is in this document, for the next time it is shown. Only the
   * selection: reading it costs nothing, where reading the scroll position after an edit would
   * make the browser lay out the whole text there and then. Scrolling is remembered from
   * scroll events (`rememberScroll`).
   */
  const rememberView = () => {
    const element = textarea.current;
    if (!element) return;
    views.setViewState(path, {
      selectionStart: element.selectionStart,
      selectionEnd: element.selectionEnd,
    });
  };
  const rememberScroll = () => {
    const element = textarea.current;
    if (element)
      views.setViewState(path, { scrollTop: element.scrollTop, scrollLeft: element.scrollLeft });
  };
  const apply = (next: TextSelection, remember = true) => {
    const element = textarea.current;
    if (!element) return;
    const previous = snapshot();
    if (next.text !== previous.text) {
      if (remember) recordEdit(history, previous);
      // On the surface first, so the document's report of it finds nothing to write back.
      element.value = next.text;
      edit(next.text);
    }
    element.focus();
    element.setSelectionRange(next.start, next.end);
    publish();
    rememberView();
  };
  // The document changed by something other than this editor -- a reload, Revert, a replace:
  // shown with the caret and scroll carried across. An edit typed here is already shown, so
  // this writes nothing for it.
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element || !doc || doc.version === shown.current) return;
    shown.current = doc.version;
    if (showDocumentText(element, content)) {
      publish();
      rememberView();
    }
  });
  // Mounted: the document's text, and back where the view was when it was last shown.
  //
  // The text is set here rather than through React. Given a `value` or `defaultValue`, React
  // compares it with the textarea's text on every render -- reading the whole text out of the
  // page and comparing it, for every keystroke, which in a large file was most of its cost.
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.value = content;
    const view = views.getViewState(path);
    if (!view) return;
    const end = element.value.length;
    element.setSelectionRange(Math.min(view.selectionStart, end), Math.min(view.selectionEnd, end));
    element.scrollTop = view.scrollTop;
    element.scrollLeft = view.scrollLeft;
    if (gutter.current) gutter.current.scrollTop = element.scrollTop;
  }, [path]);
  // And on the way out -- to another tab, or closed -- while the textarea is still in the page.
  // Not for a document that has since become another (Save As): its state went with it.
  useLayoutEffect(
    () => () => {
      if (!views.has(path)) return;
      rememberView();
      rememberScroll();
    },
    [path],
  );
  // Decided once per editor: React runs mount effects twice in development, and the second
  // run would find the "moved" mark already taken and focus anyway.
  const takesFocus = useRef<boolean | null>(null);
  useEffect(() => {
    takesFocus.current ??= views.takeFocus(path);
    // `preventScroll`: focusing must not undo the scroll position just restored. Not taken
    // from somewhere else when the document only changed key (see `takeFocus`).
    if (takesFocus.current) textarea.current?.focus({ preventScroll: true });
    publish();
  }, [path]); // History survives tab switches.
  useEffect(() => {
    if (search) searchInput.current?.focus();
  }, [search]);
  useImperativeHandle(editorRef, () => ({
    focus: () => textarea.current?.focus(),
    revealRange(start, end) {
      const current = snapshot();
      apply({ ...current, start, end });
      if (textarea.current)
        textarea.current.scrollTop =
          current.text.slice(0, start).split("\n").length * 22 * zoom - 100;
    },
    async execute(action) {
      const current = snapshot();
      if (action === "undo" || action === "redo") {
        const next = stepHistory(history, current, action);
        if (next) apply(next, false);
      } else if (action === "selectAll") apply({ ...current, start: 0, end: current.text.length });
      else if (action === "selectLine") apply(selectLine(current));
      else if (action === "duplicate") apply(duplicateSelection(current));
      else if (action === "find" || action === "replace") {
        setSearch(action);
        setSearchMessage("");
      } else {
        const element = textarea.current;
        const stillCurrent = () =>
          textarea.current === element && element?.isConnected && element.value === current.text;
        if (action === "paste") {
          const text = await navigator.clipboard.readText();
          if (!stillCurrent())
            throw new Error("The document changed while reading the clipboard. Paste again.");
          apply(replaceSelection(current, text));
        } else {
          await navigator.clipboard.writeText(current.text.slice(current.start, current.end));
          if (action === "copy" && stillCurrent()) element?.focus();
          if (action === "cut") {
            if (!stillCurrent())
              throw new Error("The document changed while copying. Nothing was cut.");
            apply(replaceSelection(current, ""));
          }
        }
      }
    },
    goToLine(line) {
      if (!Number.isInteger(line) || line < 1)
        throw new Error("Enter a positive whole line number.");
      const current = snapshot();
      const lines = current.text.split("\n");
      if (line > lines.length) throw new Error(`This document has ${lines.length} lines.`);
      const position = lines.slice(0, line - 1).reduce((sum, text) => sum + text.length + 1, 0);
      apply({ ...current, start: position, end: position });
      if (textarea.current) textarea.current.scrollTop = (line - 1) * 22 * zoom;
    },
  }));
  const findNext = () => {
    if (!query) return;
    const current = snapshot();
    let start = current.text.indexOf(query, current.end);
    if (start < 0) start = current.text.indexOf(query);
    if (start < 0) {
      setSearchMessage("No matches");
      return;
    }
    setSearchMessage("");
    apply({ ...current, start, end: start + query.length });
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {search && (
        <div
          role="search"
          aria-label="Find in file"
          className="flex flex-wrap items-center gap-2 border-b border-zinc-800 bg-zinc-950 p-2 text-xs"
        >
          <input
            ref={searchInput}
            aria-label="Find text"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSearchMessage("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                findNext();
              }
              if (event.key === "Escape") {
                setSearch(null);
                textarea.current?.focus();
              }
            }}
            className="rounded border border-zinc-600 bg-black p-1"
          />
          <button disabled={!query} onClick={findNext}>
            Find next
          </button>
          {search === "replace" && (
            <>
              <input
                aria-label="Replacement text"
                value={replacement}
                onChange={(event) => setReplacement(event.target.value)}
                className="rounded border border-zinc-600 bg-black p-1"
              />
              <button
                disabled={!query}
                onClick={() => {
                  const current = snapshot();
                  if (current.text.slice(current.start, current.end) === query)
                    apply(replaceSelection(current, replacement));
                  else findNext();
                }}
              >
                Replace
              </button>
              <button
                disabled={!query}
                onClick={() => {
                  const current = snapshot();
                  const count = current.text.split(query).length - 1;
                  apply({ text: current.text.split(query).join(replacement), start: 0, end: 0 });
                  setSearchMessage(`${count} replacements`);
                }}
              >
                Replace all
              </button>
            </>
          )}
          <span role="status">{searchMessage}</span>
          <button
            aria-label="Close find"
            onClick={() => {
              setSearch(null);
              textarea.current?.focus();
            }}
          >
            ×
          </button>
        </div>
      )}
      <div
        className="flex min-h-0 flex-1 overflow-hidden font-mono"
        style={{ fontSize: 13 * zoom, lineHeight: `${22 * zoom}px` }}
      >
        {!wordWrap && (
          <div
            ref={gutter}
            aria-hidden="true"
            className="w-14 shrink-0 overflow-hidden border-r border-zinc-900 py-3 pr-3 text-right whitespace-pre text-zinc-600"
          >
            {gutterText}
          </div>
        )}
        <textarea
          ref={textarea}
          key={path}
          aria-label={name}
          wrap={wordWrap ? "soft" : "off"}
          onBeforeInput={() => {
            beforeInput.current = snapshot();
          }}
          onChange={(event) => {
            // The document's text as it was before this input: what undo returns to.
            const before = documents.get(path)?.text ?? content;
            const previous =
              beforeInput.current?.text === before
                ? beforeInput.current
                : {
                    text: before,
                    start: event.target.selectionStart,
                    end: event.target.selectionEnd,
                  };
            if (event.target.value !== before) recordEdit(history, previous);
            beforeInput.current = null;
            edit(event.target.value);
            publish();
            rememberView();
          }}
          onFocus={() => views.setFocused(path, true)}
          onBlur={() => views.setFocused(path, false)}
          onSelect={() => {
            publish();
            rememberView();
          }}
          onKeyUp={rememberView}
          onMouseUp={rememberView}
          onScroll={() => {
            if (gutter.current && textarea.current)
              gutter.current.scrollTop = textarea.current.scrollTop;
            rememberScroll();
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if ((event.ctrlKey || event.metaKey) && ["z", "y"].includes(event.key.toLowerCase())) {
              event.preventDefault();
              event.stopPropagation();
              const next = stepHistory(
                history,
                snapshot(),
                event.key.toLowerCase() === "y" || event.shiftKey ? "redo" : "undo",
              );
              if (next) apply(next, false);
            }
          }}
          spellCheck={false}
          autoCapitalize="none"
          autoComplete="off"
          className="min-w-0 flex-1 resize-none bg-black p-3 text-zinc-200 outline-none selection:bg-indigo-800"
        />
      </div>
    </div>
  );
}
