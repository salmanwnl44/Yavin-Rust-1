import { useMemo, useState, useSyncExternalStore } from "react";
import type { ConflictSession } from "../../services/git/conflictSession";
import type { Choice, ConflictRegion } from "../../services/git/conflict";

/**
 * The dedicated three-way merge-conflict editor (WS10). A full-area view (opened from the Source
 * Control panel, rendered like the diff view) that shows every available side — **Current** (ours),
 * **Base** (common ancestor, when it exists), **Incoming** (theirs) — and resolves the file region
 * by region. It is a thin renderer over a {@link ConflictSession} view-model: all parsing,
 * resolution, staleness and index-verifying stage logic lives there, so this component only draws
 * and forwards clicks. Labels use Git's merge-side semantics (ours/theirs), never a hard-coded
 * branch name. Manual editing is done in the normal editor via "Open in Editor".
 */

const SIDE_LABEL: Record<"current" | "base" | "incoming", string> = {
  current: "Current (ours)",
  base: "Base (common ancestor)",
  incoming: "Incoming (theirs)",
};

function SidePane({
  which,
  text,
}: {
  which: "current" | "base" | "incoming";
  text: string | null;
}) {
  return (
    <section
      aria-label={SIDE_LABEL[which]}
      className="flex min-w-0 flex-1 flex-col border-r border-[#141414] last:border-r-0"
    >
      <h3 className="shrink-0 border-b border-[#141414] bg-[#0a0a0a] px-2 py-1 text-[10px] font-semibold tracking-wide text-zinc-400 uppercase">
        {SIDE_LABEL[which]}
      </h3>
      {text === null ? (
        <p className="p-2 text-[11px] text-zinc-600">This side does not exist for this conflict.</p>
      ) : (
        <pre className="min-h-0 flex-1 overflow-auto p-2 font-mono text-[11px] leading-relaxed whitespace-pre text-zinc-300">
          {text}
        </pre>
      )}
    </section>
  );
}

/** One or two lines of a region side, truncated, for the region card. */
const preview = (lines: readonly string[]): string => {
  const text = lines.join("\n").trim();
  return text.length > 160 ? `${text.slice(0, 160)}…` : text || "(empty)";
};

function RegionCard({
  region,
  choice,
  canAccept,
  onChoose,
}: {
  region: ConflictRegion;
  choice: Choice | undefined;
  canAccept: (choice: Choice) => boolean;
  onChoose: (choice: Choice) => void;
}) {
  const resolvedBy =
    choice && choice !== "manual"
      ? { current: "Current", incoming: "Incoming", both: "Both", base: "Base" }[choice]
      : null;
  const action = (c: Choice, label: string) =>
    canAccept(c) ? (
      <button
        onClick={() => onChoose(c)}
        aria-pressed={choice === c}
        className={`rounded px-2 py-0.5 text-[11px] ${
          choice === c ? "bg-indigo-600 text-white" : "bg-[#161616] text-zinc-300 hover:bg-[#222]"
        }`}
      >
        {label}
      </button>
    ) : (
      <button
        disabled
        title="This side is not available for this conflict"
        className="cursor-not-allowed rounded px-2 py-0.5 text-[11px] text-zinc-600"
      >
        {label}
      </button>
    );
  return (
    <div
      role="group"
      aria-label={`Conflict region ${region.index + 1}`}
      data-region={region.index}
      className="border-b border-[#141414] px-3 py-2"
    >
      <div className="mb-1 flex items-center gap-2 text-[11px] text-zinc-500">
        <span className="font-medium text-zinc-300">Region {region.index + 1}</span>
        <span>
          · lines {region.startLine}–{region.endLine}
        </span>
        {resolvedBy && <span className="text-emerald-400">✓ {resolvedBy}</span>}
      </div>
      <div className="grid grid-cols-2 gap-2 text-[10.5px]">
        <pre className="overflow-hidden rounded bg-[#0d130d] p-1.5 font-mono whitespace-pre-wrap text-emerald-300/90">
          {preview(region.current)}
        </pre>
        <pre className="overflow-hidden rounded bg-[#0b1018] p-1.5 font-mono whitespace-pre-wrap text-sky-300/90">
          {preview(region.incoming)}
        </pre>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {action("current", "Accept Current")}
        {action("incoming", "Accept Incoming")}
        {action("both", "Accept Both")}
        {region.base && action("base", "Accept Base")}
        <button
          onClick={() => onChoose("manual")}
          aria-pressed={choice === "manual" || choice === undefined}
          className={`rounded px-2 py-0.5 text-[11px] ${
            choice === "manual" ? "bg-[#2a2a2a] text-zinc-200" : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          Leave for manual edit
        </button>
      </div>
    </div>
  );
}

export function ConflictEditor({
  session,
  onClose,
  onOpenInEditor,
}: {
  session: ConflictSession;
  onClose: () => void;
  /** Exit to the normal editor on this file (for free-form manual editing). */
  onOpenInEditor: () => void;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  const [active, setActive] = useState(0);
  const fileName = state.path.split(/[/\\]/).pop() || state.path;

  const navigate = (direction: 1 | -1) => {
    if (!state.regions.length) return;
    const next = (active + direction + state.regions.length) % state.regions.length;
    setActive(next);
    document
      .querySelector(`[data-region="${state.regions[next]!.index}"]`)
      ?.scrollIntoView({ block: "center" });
  };

  const header = useMemo(
    () => (state.classification ? state.classification.label : "Conflict"),
    [state.classification],
  );

  return (
    <section
      aria-label={`Resolve conflicts in ${fileName}`}
      className="flex h-full min-h-0 flex-col bg-black text-zinc-300"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[#141414] bg-[#050505] px-3 py-1.5">
        <span className="text-[12px] font-semibold text-zinc-200">{fileName}</span>
        <span className="rounded bg-[#1a1a1a] px-1.5 py-0.5 text-[10px] text-amber-300">
          {header}
        </span>
        <span className="text-[11px] text-zinc-500" role="status" aria-label="Resolution progress">
          {state.progress.resolved}/{state.progress.total} regions resolved
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {state.regions.length > 1 && (
            <>
              <button
                onClick={() => navigate(-1)}
                aria-label="Previous conflict"
                className="rounded px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-[#161616]"
              >
                ↑ Prev
              </button>
              <button
                onClick={() => navigate(1)}
                aria-label="Next conflict"
                className="rounded px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-[#161616]"
              >
                ↓ Next
              </button>
            </>
          )}
          <button
            onClick={onOpenInEditor}
            className="rounded px-2 py-0.5 text-[11px] text-zinc-400 hover:bg-[#161616] hover:text-zinc-200"
          >
            Open in Editor
          </button>
          <button
            disabled={!state.ready || state.status === "completing"}
            onClick={() => void session.complete().then((ok) => ok && onClose())}
            className="rounded bg-indigo-600 px-2.5 py-0.5 text-[11px] font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
          >
            {state.status === "completing" ? "Completing…" : "Complete Resolution"}
          </button>
          <button
            onClick={onClose}
            aria-label="Close conflict editor"
            className="rounded px-1.5 py-0.5 text-[11px] text-zinc-500 hover:text-zinc-200"
          >
            ✕
          </button>
        </div>
      </div>

      {state.error && (
        <div
          role="alert"
          className="shrink-0 border-b border-[#141414] bg-red-950/30 px-3 py-1 text-[11px] text-red-300"
        >
          {state.error}
        </div>
      )}

      {state.status === "loading" ? (
        <p className="p-3 text-[12px] text-zinc-500">Loading the conflict's sides…</p>
      ) : state.status === "done" ? (
        <p className="p-3 text-[12px] text-emerald-400">Resolved and staged.</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          {/* The three sides, all inspectable. */}
          <div className="flex min-h-0 basis-1/2 border-b border-[#141414] lg:border-r lg:border-b-0">
            <SidePane which="current" text={state.sides.current} />
            {state.sides.base !== null && <SidePane which="base" text={state.sides.base} />}
            <SidePane which="incoming" text={state.sides.incoming} />
          </div>
          {/* The regions and their resolution actions. */}
          <div className="min-h-0 basis-1/2 overflow-auto">
            {state.regions.length === 0 ? (
              <p className="p-3 text-[12px] text-zinc-500">
                No in-file conflict regions. Use Open in Editor, then stage the file as resolved.
              </p>
            ) : (
              state.regions.map((region) => (
                <RegionCard
                  key={region.index}
                  region={region}
                  choice={state.choices.get(region.index)}
                  canAccept={session.canAccept}
                  onChoose={(choice) => session.choose(region.index, choice)}
                />
              ))
            )}
          </div>
        </div>
      )}
    </section>
  );
}
