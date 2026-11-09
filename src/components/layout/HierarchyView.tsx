import { useSyncExternalStore } from "react";
import type { Hierarchy, HierarchyItem, HierarchyNode } from "../../services/lsp/hierarchy";

/**
 * The shared hierarchy view (WS14 call hierarchy, WS15 type hierarchy): a lazy, cycle-safe tree of
 * related symbols along a chosen direction, opened from the editor. A thin renderer over the
 * {@link Hierarchy} model — expansion, loading, cycle detection and server requests live there; this
 * draws the tree, switches the direction, and navigates to a node's symbol. The mode is explicit, in
 * props (`kindLabel` and `directionLabels`), so one component serves both hierarchy kinds without a
 * duplicate tree, drawer or navigation path. Reuses the host's `openLocation`; it owns no navigation
 * state and executes nothing.
 */
export function HierarchyView({
  session,
  kindLabel,
  directionLabels,
  onNavigate,
  onClose,
}: {
  session: Hierarchy;
  /** The hierarchy kind, e.g. "Call hierarchy" or "Type hierarchy" — titles the panel and tree. */
  kindLabel: string;
  /** Label for each of the model's directions, e.g. `{ incoming: "Callers", outgoing: "Callees" }`. */
  directionLabels: Readonly<Record<string, string>>;
  onNavigate: (item: HierarchyItem) => void;
  onClose: () => void;
}) {
  const rows = useSyncExternalStore(session.subscribe, session.getRows, session.getRows);
  const direction = session.direction();
  const root = session.rootItem();

  return (
    <section
      aria-label={`${kindLabel} of ${root.name}`}
      className="flex h-full min-h-0 flex-col bg-black text-zinc-300"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-[#141414] bg-[#050505] px-3 py-1.5">
        <span className="text-[12px] font-semibold text-zinc-200">{kindLabel}</span>
        <span className="truncate text-[11px] text-zinc-500">{root.name}</span>
        <div className="ml-auto flex items-center gap-1">
          {session.directions().map((value) => (
            <button
              key={value}
              aria-pressed={direction === value}
              onClick={() => session.setDirection(value)}
              className={`rounded px-2 py-0.5 text-[11px] ${
                direction === value
                  ? "bg-indigo-600 text-white"
                  : "text-zinc-400 hover:bg-[#161616]"
              }`}
            >
              {directionLabels[value] ?? value}
            </button>
          ))}
          <button
            onClick={onClose}
            aria-label={`Close ${kindLabel.toLowerCase()}`}
            className="rounded px-1.5 py-0.5 text-[11px] text-zinc-500 hover:text-zinc-200"
          >
            ✕
          </button>
        </div>
      </div>

      <div role="tree" aria-label={kindLabel} className="min-h-0 flex-1 overflow-auto py-1">
        {rows.map(({ node }) => (
          <Row
            key={node.id}
            node={node}
            onToggle={() => void session.toggle(node)}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </section>
  );
}

function Row({
  node,
  onToggle,
  onNavigate,
}: {
  node: HierarchyNode;
  onToggle: () => void;
  onNavigate: (item: HierarchyItem) => void;
}) {
  const expandable = !node.cyclic;
  const indent = 6 + node.depth * 14;
  return (
    <div
      role="treeitem"
      aria-expanded={expandable ? node.expanded : undefined}
      aria-label={node.item.name}
      className="flex items-center gap-1 py-0.5 pr-2 text-[11px] hover:bg-[#0c0c0c]"
      style={{ paddingLeft: indent }}
    >
      <button
        aria-label={node.expanded ? "Collapse" : "Expand"}
        onClick={onToggle}
        disabled={!expandable}
        className="w-3 shrink-0 text-center text-zinc-600 disabled:opacity-0"
      >
        {node.loading ? "…" : node.expanded ? "▾" : "▸"}
      </button>
      <button
        onClick={() => onNavigate(node.item)}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        title={node.item.detail ?? node.item.uri}
      >
        <span className="truncate text-zinc-200">{node.item.name}</span>
        {node.item.detail && <span className="truncate text-zinc-600">{node.item.detail}</span>}
        {node.cyclic && <span className="shrink-0 text-amber-400">↻ cyclic</span>}
        {node.error && <span className="shrink-0 text-red-400">{node.error}</span>}
      </button>
    </div>
  );
}
