import { useMemo, useState, useSyncExternalStore } from "react";
import type { CursorStatusStore } from "../../services/cursorStatus";
import type { EditorRange, OutlineStore, OutlineSymbol } from "../../services/lsp/outline";
import { symbolPath } from "../../services/lsp/outline";
import { symbolKindName } from "../../services/lsp/symbols";

/**
 * The Outline (a section under the Explorer's tree) and the symbol breadcrumbs (after the
 * file's path above the editor): the symbols of the document in front, as its language server
 * reports them, with the one the cursor is in marked. Both only show; revealing a symbol is the
 * window's (`onReveal`), which puts the editor's cursor on the symbol's name.
 */

/** VS Code's symbol colours, by kind: classes orange, functions purple, variables blue. */
const KIND_COLOR: Record<number, string> = {
  5: "#ee9d28",
  10: "#ee9d28",
  11: "#75beff",
  23: "#ee9d28",
  6: "#b180d7",
  9: "#b180d7",
  12: "#b180d7",
  7: "#75beff",
  8: "#75beff",
  13: "#75beff",
  14: "#75beff",
  22: "#75beff",
};

function KindGlyph({ kind }: { kind: number }) {
  const name = symbolKindName(kind);
  return (
    <span
      aria-hidden
      title={name}
      className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-[2px] font-mono text-[9px] font-bold leading-none"
      style={{ color: KIND_COLOR[kind] ?? "#c5c5c5", border: "1px solid currentColor" }}
    >
      {name[0].toUpperCase()}
    </span>
  );
}

const useCursor = (cursor: CursorStatusStore | undefined) =>
  useSyncExternalStore(cursor?.subscribe ?? (() => () => {}), () => cursor?.get() ?? null);

/** The name's start: where revealing a symbol puts the cursor. */
const atName = (symbol: OutlineSymbol): EditorRange => ({
  startLineNumber: symbol.selection.startLineNumber,
  startColumn: symbol.selection.startColumn,
  endLineNumber: symbol.selection.startLineNumber,
  endColumn: symbol.selection.startColumn,
});

/** Collapsed until opened, as VS Code's is: the Explorer's tree keeps its height. */
const readOpen = () => {
  try {
    return localStorage.getItem("yavin.outline.open") === "true";
  } catch {
    return false;
  }
};

export function OutlineSection({
  store,
  cursor,
  onReveal,
}: {
  store: OutlineStore;
  cursor?: CursorStatusStore;
  onReveal: (range: EditorRange) => void;
}) {
  const outline = useSyncExternalStore(store.subscribe, store.get);
  const position = useCursor(cursor);
  const [open, setOpen] = useState(readOpen);
  /** Collapsed symbols, by id, for the document shown; a new document starts expanded. */
  const [collapsed, setCollapsed] = useState<{ key: string | null; ids: Set<string> }>({
    key: null,
    ids: new Set(),
  });
  const ids = collapsed.key === outline.key ? collapsed.ids : new Set<string>();
  const symbols = outline.state === "none" ? [] : outline.symbols;
  const current = useMemo(() => {
    if (!position) return null;
    return symbolPath(symbols, position.line, position.column).pop()?.id ?? null;
  }, [symbols, position]);

  const toggle = () => {
    setOpen((was) => {
      try {
        localStorage.setItem("yavin.outline.open", String(!was));
      } catch {
        // Remembered where storage works.
      }
      return !was;
    });
  };
  const toggleSymbol = (id: string) => {
    const next = new Set(ids);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed({ key: outline.key, ids: next });
  };

  const rows: { symbol: OutlineSymbol; depth: number }[] = [];
  const walk = (list: readonly OutlineSymbol[], depth: number) => {
    for (const symbol of list) {
      rows.push({ symbol, depth });
      if (!ids.has(symbol.id)) walk(symbol.children, depth + 1);
    }
  };
  walk(symbols, 0);

  return (
    <section
      aria-label="Outline"
      className={`flex shrink-0 flex-col border-t border-[#161616] ${open ? "max-h-[40%] min-h-[88px]" : ""}`}
    >
      <button
        onClick={toggle}
        aria-expanded={open}
        className="flex h-6 w-full shrink-0 items-center gap-1 px-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-300 hover:bg-[#0a0a0a]"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 16 16"
          className={`transition-transform ${open ? "rotate-90" : ""}`}
          fill="currentColor"
          aria-hidden
        >
          <path d="M6 4l4 4-4 4z" />
        </svg>
        Outline
      </button>
      {open && (
        <div role="tree" aria-label="Symbols" className="min-h-0 flex-1 overflow-y-auto pb-1">
          {outline.state === "none" ? (
            <p className="px-4 py-1.5 text-[11.5px] text-zinc-500">{outline.message}</p>
          ) : rows.length === 0 ? (
            <p className="px-4 py-1.5 text-[11.5px] text-zinc-500">
              {outline.state === "loading"
                ? "Loading document symbols…"
                : "No symbols found in document."}
            </p>
          ) : (
            rows.map(({ symbol, depth }) => {
              const parent = symbol.children.length > 0;
              const expanded = parent && !ids.has(symbol.id);
              const active = symbol.id === current;
              return (
                <div
                  key={symbol.id}
                  role="treeitem"
                  aria-level={depth + 1}
                  aria-expanded={parent ? expanded : undefined}
                  aria-selected={active}
                  tabIndex={-1}
                  title={`${symbol.name} (${symbolKindName(symbol.kind)})`}
                  onClick={() => onReveal(atName(symbol))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") onReveal(atName(symbol));
                  }}
                  style={{ paddingLeft: 6 + depth * 12 }}
                  className={`flex h-[22px] cursor-pointer items-center gap-1 pr-2 text-[12px] ${
                    active ? "bg-[#1a1a1a] text-white" : "text-zinc-300 hover:bg-[#0d0d0d]"
                  }`}
                >
                  <span
                    onClick={(event) => {
                      if (!parent) return;
                      event.stopPropagation();
                      toggleSymbol(symbol.id);
                    }}
                    className="inline-flex w-3 shrink-0 justify-center text-zinc-500"
                    aria-hidden
                  >
                    {parent && (
                      <svg
                        width="10"
                        height="10"
                        viewBox="0 0 16 16"
                        className={`transition-transform ${expanded ? "rotate-90" : ""}`}
                        fill="currentColor"
                      >
                        <path d="M6 4l4 4-4 4z" />
                      </svg>
                    )}
                  </span>
                  <KindGlyph kind={symbol.kind} />
                  <span className="truncate">{symbol.name}</span>
                  {symbol.detail && (
                    <span className="truncate text-[11px] text-zinc-500">{symbol.detail}</span>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </section>
  );
}

/** The symbols the cursor is in, after the file's path: `› Outer › method`. */
export function SymbolCrumbs({
  store,
  cursor,
  activeKey,
  onReveal,
}: {
  store: OutlineStore;
  cursor?: CursorStatusStore;
  activeKey: string | null;
  onReveal: (range: EditorRange) => void;
}) {
  const outline = useSyncExternalStore(store.subscribe, store.get);
  const position = useCursor(cursor);
  if (outline.state === "none" || outline.key !== activeKey || !position) return null;
  const path = symbolPath(outline.symbols, position.line, position.column);
  if (!path.length) return null;
  return (
    <nav aria-label="Symbol breadcrumbs" className="flex min-w-0 items-center gap-1">
      {path.map((symbol) => (
        <span key={symbol.id} className="flex min-w-0 items-center gap-1">
          <span className="text-zinc-600">›</span>
          <button
            onClick={() => onReveal(atName(symbol))}
            title={`${symbol.name} (${symbolKindName(symbol.kind)})`}
            className="flex min-w-0 items-center gap-1 rounded-sm px-0.5 text-zinc-300 hover:bg-[#151515] hover:text-white"
          >
            <KindGlyph kind={symbol.kind} />
            <span className="truncate">{symbol.name}</span>
          </button>
        </span>
      ))}
    </nav>
  );
}
