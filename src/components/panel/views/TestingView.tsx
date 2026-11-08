import { useState, useSyncExternalStore } from "react";
import type { TestingPlatform } from "../../../services/testing/platform";
import type { TestRow, TestTreeNode } from "../../../services/testing/treeProvider";
import type { TestStatus } from "../../../services/testing/model";
import { EmptyView } from "./EmptyView";

/**
 * The Test Explorer (WS5): the panel view that binds to a {@link TestingPlatform}. It is a thin
 * renderer — all the logic (detection, running, the tree projection, expansion, history) lives in
 * the view-model, which is unit-tested without a DOM. Here we only draw the toolbar, the status
 * summary, the indented tree and the selected failure's detail, and forward clicks to the
 * view-model.
 *
 * Rows come pre-flattened and already honour expansion, so the list renders them directly; a
 * virtualized window can wrap this later exactly as the file Explorer does, since row identities
 * are stable.
 */

const STATUS_GLYPH: Record<TestStatus, { mark: string; className: string; label: string }> = {
  passed: { mark: "✓", className: "text-emerald-400", label: "passed" },
  failed: { mark: "✗", className: "text-red-400", label: "failed" },
  running: { mark: "○", className: "animate-pulse text-amber-400", label: "running" },
  skipped: { mark: "–", className: "text-zinc-600", label: "skipped" },
  pending: { mark: "·", className: "text-zinc-600", label: "pending" },
};

function StatusMark({ status }: { status: TestStatus }) {
  const g = STATUS_GLYPH[status];
  return (
    <span aria-label={g.label} className={`w-3 shrink-0 text-center font-mono ${g.className}`}>
      {g.mark}
    </span>
  );
}

function Row({
  row,
  selected,
  onToggle,
  onSelect,
  onRun,
  onDebug,
  debuggable,
  debugReason,
  onOpen,
}: {
  row: TestRow;
  selected: boolean;
  onToggle: (node: TestTreeNode) => void;
  onSelect: (id: string) => void;
  onRun: (node: TestTreeNode) => void;
  onDebug: (node: TestTreeNode) => void;
  /** Whether this framework's tests can be debugged (WS5.3). */
  debuggable: boolean;
  /** Why not, shown as the disabled Debug button's tooltip. */
  debugReason?: string;
  onOpen?: (file: string, line?: number) => void;
}) {
  const { node, expanded } = row;
  const indent = 6 + node.depth * 12;
  return (
    <div
      role="treeitem"
      aria-selected={selected}
      aria-expanded={node.expandable ? expanded : undefined}
      className={`group/row flex items-center gap-1.5 py-0.5 pr-2 text-[11px] ${
        selected ? "bg-[#161616]" : "hover:bg-[#0c0c0c]"
      }`}
      style={{ paddingLeft: indent }}
      onClick={() => {
        onSelect(node.id);
        if (node.expandable) onToggle(node);
        else if (node.kind === "case") onOpen?.(node.file, node.line);
      }}
    >
      <span className="w-2 shrink-0 text-zinc-600">
        {node.expandable ? (expanded ? "▾" : "▸") : ""}
      </span>
      <StatusMark status={node.status} />
      <span
        className={`truncate ${
          node.kind === "file"
            ? "text-zinc-200"
            : node.kind === "suite"
              ? "text-zinc-300"
              : "text-zinc-400"
        }`}
      >
        {node.label}
      </span>
      {node.flaky && (
        <span
          title="Passed only after a retry"
          className="ml-1 shrink-0 rounded bg-amber-950/60 px-1 text-[9px] font-medium text-amber-300"
        >
          flaky
        </span>
      )}
      {node.durationMs !== undefined && (
        <span className="ml-1 shrink-0 text-[10px] text-zinc-600">
          {Math.round(node.durationMs)}ms
        </span>
      )}
      {(node.kind === "file" || node.kind === "case") && (
        <button
          title={`Run ${node.label}`}
          aria-label={`Run ${node.label}`}
          onClick={(e) => {
            e.stopPropagation();
            void onRun(node);
          }}
          className={`${node.kind === "case" ? "" : "ml-auto"} shrink-0 rounded px-1 text-zinc-600 opacity-0 transition-opacity hover:text-zinc-200 group-hover/row:opacity-100 focus:opacity-100`}
        >
          ▷
        </button>
      )}
      {node.kind === "case" && (
        <button
          title={debuggable ? `Debug ${node.label}` : (debugReason ?? "Debugging is not available")}
          aria-label={`Debug ${node.label}`}
          disabled={!debuggable}
          onClick={(e) => {
            e.stopPropagation();
            if (debuggable) onDebug(node);
          }}
          className="shrink-0 rounded px-1 text-zinc-600 opacity-0 transition-opacity hover:text-amber-300 group-hover/row:opacity-100 focus:opacity-100 disabled:cursor-not-allowed disabled:hover:text-zinc-700"
        >
          🐞
        </button>
      )}
    </div>
  );
}

export function TestingView({
  platform,
  onOpen,
  onDebugStarted,
}: {
  /** The workspace's testing platform, or null when no workspace is open. */
  platform: TestingPlatform | null;
  /** Reveal a test's source — wired to the editor by the host (failure navigation). */
  onOpen?: (file: string, line?: number) => void;
  /** Called after a test's debug session launches, so the host can focus the Debug panel (WS5.3). */
  onDebugStarted?: () => void;
}) {
  const view = useSyncExternalStore(
    (listener) => platform?.subscribe(listener) ?? (() => {}),
    () => platform?.getViewState() ?? null,
  );
  const [debugError, setDebugError] = useState<string | null>(null);

  const handleDebug = (node: TestTreeNode) => {
    setDebugError(null);
    platform?.debugNode(node).then(
      () => onDebugStarted?.(),
      (reason) => setDebugError(reason instanceof Error ? reason.message : String(reason)),
    );
  };

  if (!platform || !view) {
    return (
      <EmptyView label="Test Results" message="Open a folder to discover and run its tests." />
    );
  }

  if (view.adapterLabel === null) {
    return (
      <EmptyView
        label="Test Results"
        message="No supported test framework was detected in this workspace. Add a Vitest, Jest or Playwright configuration, a Cargo.toml for Rust tests, or a pytest setup for Python, and it will appear here."
      />
    );
  }

  const selectedCase =
    view.selectedId &&
    view.rows.find((r) => r.node.id === view.selectedId && r.node.kind === "case")?.node;

  return (
    <section aria-label="Test Results" className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[#141414] px-3 py-1">
        <span className="text-[11px] font-medium text-zinc-300">{view.adapterLabel}</span>
        {view.compiled === false ? (
          <span className="text-[11px] font-medium text-red-400">Did not run</span>
        ) : (
          view.summary && (
            <span className="text-[11px] text-zinc-500">
              <span className="text-emerald-400">{view.summary.passed}</span> passed
              {view.summary.failed > 0 && (
                <>
                  , <span className="text-red-400">{view.summary.failed}</span> failed
                </>
              )}
              {view.summary.skipped > 0 && <>, {view.summary.skipped} ignored</>}
            </span>
          )
        )}
        {view.running && <span className="text-[11px] text-amber-400">Running…</span>}
        <div className="ml-auto flex items-center gap-1">
          {view.running ? (
            <button
              onClick={() => platform.cancel()}
              className="rounded px-2 py-0.5 text-[11px] text-zinc-400 hover:bg-[#161616] hover:text-red-400"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={() => void platform.runAll()}
              className="rounded bg-indigo-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-indigo-500"
            >
              Run All
            </button>
          )}
          <button
            onClick={() => void platform.rerunFailed()}
            disabled={view.running || !view.summary || view.summary.failed === 0}
            className="rounded px-2 py-0.5 text-[11px] text-zinc-400 hover:bg-[#161616] hover:text-zinc-200 disabled:opacity-40"
          >
            Rerun Failed
          </button>
        </div>
      </div>

      {view.error && !view.summary && (
        <div className="shrink-0 border-b border-[#141414] bg-red-950/30 px-3 py-1 text-[11px] text-red-300">
          {view.error}
        </div>
      )}

      {debugError && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[#141414] bg-amber-950/30 px-3 py-1 text-[11px] text-amber-300">
          <span className="flex-1">{debugError}</span>
          <button
            onClick={() => setDebugError(null)}
            className="shrink-0 rounded px-1 text-amber-400 hover:text-amber-200"
          >
            Dismiss
          </button>
        </div>
      )}

      {view.compiled === false && view.diagnostics.length > 0 ? (
        // A compilation failure is shown as compiler errors, distinct from test-case results —
        // no test ran, so there is no tree.
        <div className="min-h-0 flex-1 overflow-auto bg-[#070707] p-2">
          <div className="mb-1 px-1 text-[11px] text-red-400">
            The tests could not run — {view.diagnostics.length}{" "}
            {view.diagnostics.length === 1 ? "error" : "errors"} (compilation or configuration). No
            tests ran.
          </div>
          {view.diagnostics.map((d, i) => (
            <button
              key={i}
              onClick={() => d.file && onOpen?.(d.file, d.line)}
              className="block w-full border-b border-[#141414] px-1 py-1 text-left hover:bg-[#0c0c0c]"
            >
              {d.file && (
                <span className="text-[10px] text-indigo-400">
                  {d.file}
                  {d.line ? `:${d.line}` : ""}
                </span>
              )}
              <pre className="font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-red-300">
                {d.message}
              </pre>
            </button>
          ))}
        </div>
      ) : !view.hasReport ? (
        <EmptyView
          label="Test Results"
          message={`Run ${view.adapterLabel} to discover and execute this workspace's tests.`}
          action={
            <button
              onClick={() => void platform.runAll()}
              className="rounded bg-indigo-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-indigo-500"
            >
              Run All
            </button>
          }
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div role="tree" aria-label="Tests" className="min-h-0 flex-1 overflow-auto">
            {view.rows.map((row) => (
              <Row
                key={row.node.id}
                row={row}
                selected={row.node.id === view.selectedId}
                onToggle={(n) => platform.toggle(n)}
                onSelect={(id) => platform.select(id)}
                onRun={(n) => platform.runNode(n)}
                onDebug={handleDebug}
                debuggable={view.debug.supported}
                debugReason={view.debug.reason}
                onOpen={onOpen}
              />
            ))}
          </div>
          {selectedCase && selectedCase.message && (
            <div className="max-h-[40%] shrink-0 overflow-auto border-t border-[#141414] bg-[#070707] px-3 py-2">
              <div className="mb-1 flex items-center gap-2">
                <span className="text-[11px] font-medium text-zinc-300">{selectedCase.label}</span>
                <button
                  onClick={() => onOpen?.(selectedCase.file, selectedCase.line)}
                  className="text-[10px] text-indigo-400 hover:text-indigo-300"
                >
                  Go to test
                </button>
              </div>
              <pre className="font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-red-300">
                {selectedCase.message}
              </pre>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
