import { useImperativeHandle, useMemo, useRef, useState, useEffect } from "react";
import type { Ref } from "react";
import {
  duplicateSelection,
  selectLine,
  replaceSelection,
  recordEdit,
  stepHistory,
} from "../../services/editor";
import type { TextHistory, TextSelection } from "../../services/editor";

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

export function TextEditor({
  path,
  name,
  content,
  onChange,
  editorRef,
  histories,
  onState,
  wordWrap,
  zoom,
}: {
  path: string;
  name: string;
  content: string;
  onChange: (text: string) => void;
  editorRef: Ref<EditorHandle>;
  histories: Map<string, TextHistory>;
  onState: (state: EditorState) => void;
  wordWrap: boolean;
  zoom: number;
}) {
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
  const lineCount = useMemo(() => {
    let lines = 1;
    for (let index = 0; index < content.length; index++)
      if (content.charCodeAt(index) === 10) lines++;
    return lines;
  }, [content]);
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
  const history = histories.get(path) ?? { past: [], future: [] };
  histories.set(path, history);
  const snapshot = (): TextSelection => ({
    text: textarea.current?.value ?? content,
    start: textarea.current?.selectionStart ?? 0,
    end: textarea.current?.selectionEnd ?? 0,
  });
  const publish = () =>
    onState({
      canUndo: history.past.length > 0,
      canRedo: history.future.length > 0,
      selected: (textarea.current?.selectionStart ?? 0) !== (textarea.current?.selectionEnd ?? 0),
    });
  const apply = (next: TextSelection, remember = true) => {
    const element = textarea.current;
    if (!element) return;
    const previous = snapshot();
    if (next.text !== previous.text) {
      if (remember) recordEdit(history, previous);
      // Set the controlled element immediately so rapid commands see the latest edit.
      element.value = next.text;
      onChange(next.text);
    }
    element.focus();
    element.setSelectionRange(next.start, next.end);
    publish();
  };
  useEffect(() => {
    textarea.current?.focus();
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
          value={content}
          wrap={wordWrap ? "soft" : "off"}
          onBeforeInput={() => {
            beforeInput.current = snapshot();
          }}
          onChange={(event) => {
            const previous =
              beforeInput.current?.text === content
                ? beforeInput.current
                : {
                    text: content,
                    start: event.target.selectionStart,
                    end: event.target.selectionEnd,
                  };
            if (event.target.value !== content) recordEdit(history, previous);
            beforeInput.current = null;
            onChange(event.target.value);
            publish();
          }}
          onSelect={publish}
          onScroll={() => {
            if (gutter.current && textarea.current)
              gutter.current.scrollTop = textarea.current.scrollTop;
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
