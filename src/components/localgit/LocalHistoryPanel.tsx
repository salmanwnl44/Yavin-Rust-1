/**
 * Local History (LG-08): the window's view of the workspace's Local Git -- history, commits,
 * checkpoints, AI runs, stashes, diffs, restore and Undo AI Run.
 *
 * A consumer only. Every fact comes from the workspace's Local Git service
 * (`services/localgit/service.ts`, over the `localgit_*` commands); every change goes through
 * it, which plans it, refuses it with its reasons, carries it out and reconciles the documents.
 * Nothing here orders history, computes diffs, judges safety or attributes AI changes: the
 * panel lists what the service lists, shows what a dry run says, and asks before anything that
 * changes the disk. A result arriving after the workspace was left is dropped (the service
 * refuses it, and so does the panel's own generation check).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type { DiffDocument } from "../layout/DiffEditor";
import type { LocalGitService } from "../../services/localgit/service";
import { LocalGitClosedError } from "../../services/localgit/service";
import type {
  LocalGitAiRun,
  LocalGitAiUndoResult,
  LocalGitBranch,
  LocalGitCommit,
  LocalGitCommitInfo,
  LocalGitDiff,
  LocalGitDiffEntry,
  LocalGitHeadInfo,
  LocalGitOperationState,
  LocalGitRestorePlan,
  LocalGitStash,
  LocalGitTag,
} from "../../services/localgit/types";
import {
  CHANGE_LABEL,
  CHANGE_LETTER,
  ENTRY_LABEL,
  aiStatusLabel,
  describeAiRefusal,
  describeError,
  describeRestoreConflict,
  entryKind,
  provenance,
  relativeTime,
  unavailableReason,
  unifiedDiff,
} from "../../services/localgit/presentation";
import type { EntryKind } from "../../services/localgit/presentation";

const PAGE = 100;
const ROW_HEIGHT = 46;
const OVERSCAN = 8;

type Tab = "history" | "ai" | "stashes";
type Selection =
  | { kind: "commit"; id: string }
  | { kind: "ai"; id: string }
  | { kind: "stash"; id: string }
  | null;

type Failure = { title: string; detail: string };

const KIND_STYLE: Record<EntryKind, string> = {
  commit: "text-gray-300 border-gray-600",
  merge: "text-sky-300 border-sky-700",
  ai: "text-violet-300 border-violet-700",
  checkpoint: "text-amber-300 border-amber-700",
  recovery: "text-orange-300 border-orange-700",
  automatic: "text-gray-400 border-gray-700",
};

function Badge({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={`inline-block shrink-0 rounded border px-1 text-[10px] leading-4 uppercase tracking-wide ${className}`}
    >
      {children}
    </span>
  );
}

function FailureView({ failure, onRetry }: { failure: Failure; onRetry?: () => void }) {
  return (
    <div role="alert" className="m-2 rounded border border-red-800 bg-red-950/40 p-2 text-xs">
      <div className="text-red-300">{failure.title}</div>
      {failure.detail && (
        <details className="mt-1 text-gray-400">
          <summary className="cursor-pointer">Details</summary>
          <div className="mt-1 break-words font-mono">{failure.detail}</div>
        </details>
      )}
      {onRetry && (
        <button type="button" className="mt-2 text-sky-300 hover:underline" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  if (children === null || children === undefined || children === "") return null;
  return (
    <div className="flex gap-2 text-xs leading-5">
      <dt className="w-24 shrink-0 text-gray-500">{label}</dt>
      <dd className="min-w-0 break-all text-gray-200">{children}</dd>
    </div>
  );
}

/** A modal confirmation: focus kept inside, Escape cancels. */
function Sheet({
  title,
  children,
  onClose,
  actions,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  actions: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef(document.activeElement);
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>("button:not([disabled])");
    first?.focus();
    const previous = opener.current;
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !ref.current) return;
    const focusable = [
      ...ref.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), summary, [tabindex='0']",
      ),
    ];
    if (!focusable.length) return;
    const [first, last] = [focusable[0], focusable[focusable.length - 1]];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return (
    <div className="absolute inset-0 z-20 flex items-start justify-center bg-black/60 p-2">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={onKeyDown}
        className="mt-6 max-h-[85%] w-full overflow-auto rounded border border-gray-700 bg-[#151515] p-3 shadow-xl"
      >
        <h3 className="mb-2 text-sm font-semibold text-gray-100">{title}</h3>
        <div className="text-xs text-gray-300">{children}</div>
        <div className="mt-3 flex justify-end gap-2">{actions}</div>
      </div>
    </div>
  );
}

const button =
  "rounded px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40 focus:outline focus:outline-1 focus:outline-sky-500";
const primary = `${button} bg-sky-700 text-white hover:bg-sky-600`;
const danger = `${button} bg-red-800 text-white hover:bg-red-700`;
const plain = `${button} border border-gray-700 text-gray-200 hover:bg-gray-800`;

/** What a restore plan will do, and what stands in its way. */
function PlanView({ plan, affected }: { plan: LocalGitRestorePlan; affected?: string }) {
  const files = plan.operations.filter(
    (op) => op.kind !== "createDirectory" && op.kind !== "removeDirectory",
  );
  const groups = {
    Changed: files.filter((op) => op.kind === "writeFile" && op.expected.kind !== "absent"),
    Added: files.filter(
      (op) =>
        (op.kind === "writeFile" || op.kind === "createLink") && op.expected.kind === "absent",
    ),
    Deleted: files.filter((op) => op.kind === "removeFile" || op.kind === "removeLink"),
  };
  return (
    <div className="space-y-2">
      {affected && <div className="text-gray-400">{affected}</div>}
      {plan.conflicts.length > 0 && (
        <div>
          <div className="font-semibold text-red-300">
            Refused -- nothing will change ({plan.conflicts.length}):
          </div>
          <ul className="ml-3 list-disc" aria-label="Reasons">
            {plan.conflicts.map((conflict, at) => (
              <li key={at}>{describeRestoreConflict(conflict)}</li>
            ))}
          </ul>
        </div>
      )}
      {(Object.entries(groups) as [string, typeof files][]).map(([label, ops]) =>
        ops.length ? (
          <div key={label}>
            <div className="font-semibold">
              {label} ({ops.length})
            </div>
            <ul className="ml-3 max-h-32 overflow-auto font-mono" aria-label={label}>
              {ops.slice(0, 200).map((op) => (
                <li key={`${op.folderId}:${op.path}`}>{op.path}</li>
              ))}
              {ops.length > 200 && <li>…and {ops.length - 200} more</li>}
            </ul>
          </div>
        ) : null,
      )}
      {plan.documents.length > 0 && (
        <div className="text-amber-300">
          Unsaved changes will be discarded in: {plan.documents.map((doc) => doc.path).join(", ")}
        </div>
      )}
      {plan.conflicts.length === 0 && files.length === 0 && plan.documents.length === 0 && (
        <div>The workspace already matches: nothing would change.</div>
      )}
    </div>
  );
}

export function LocalHistoryPanel({
  service,
  visible,
  onDiff,
  onChanged,
}: {
  service: LocalGitService | null;
  visible: boolean;
  /** Shows a diff in the editor area (read-only: no staging for Local History). */
  onDiff: (diff: DiffDocument) => void;
  /** After the disk changed: the window refreshes the Explorer and Source Control. */
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<Tab>("history");
  const [head, setHead] = useState<LocalGitHeadInfo | null>(null);
  const [refs, setRefs] = useState<{ branches: LocalGitBranch[]; tags: LocalGitTag[] }>({
    branches: [],
    tags: [],
  });
  const [operation, setOperation] = useState<LocalGitOperationState | null>(null);
  const [items, setItems] = useState<LocalGitCommitInfo[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [broken, setBroken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [runs, setRuns] = useState<LocalGitAiRun[] | null>(null);
  const [stashes, setStashes] = useState<LocalGitStash[] | null>(null);
  const [filter, setFilter] = useState("");
  const [selection, setSelection] = useState<Selection>(null);
  const [folders, setFolders] = useState<{ folderId: string; path: string }[]>([]);
  const [readOnly, setReadOnly] = useState(false);
  // A result for an earlier service (another workspace, a reload) is never shown.
  const generation = useRef(0);
  const loaded = useRef({ runs: false, stashes: false });

  const guard = useCallback(
    async <T,>(work: () => Promise<T>): Promise<{ value?: T; failure?: Failure }> => {
      const at = generation.current;
      try {
        const value = await work();
        if (at !== generation.current) return {};
        return { value };
      } catch (error) {
        if (at !== generation.current || error instanceof LocalGitClosedError) return {};
        return { failure: describeError(error) };
      }
    },
    [],
  );

  const refresh = useCallback(async () => {
    if (!service) return;
    generation.current++;
    setLoading(true);
    setFailure(null);
    const at = generation.current;
    const [opened, info, page, branches, tags, current] = await Promise.all([
      guard(() => service.ready),
      guard(() => service.head()),
      guard(() => service.history({ limit: PAGE })),
      guard(() => service.branches()),
      guard(() => service.tags()),
      guard(() => service.operation()),
    ]);
    if (at !== generation.current) return;
    setLoading(false);
    const first = [opened, info, page].find((r) => r.failure)?.failure;
    if (first) {
      setFailure(first);
      return;
    }
    if (opened.value) {
      setFolders(opened.value.folders);
      setReadOnly(opened.value.mode !== "writer");
    }
    setHead(info.value ?? null);
    setItems(page.value?.items ?? []);
    setNext(page.value?.next ?? null);
    setBroken(page.value?.broken?.message ?? null);
    setRefs({ branches: branches.value ?? [], tags: tags.value ?? [] });
    setOperation(current.value ?? null);
    // Lists already shown are reloaded in place (what is selected in them stays open).
    if (loaded.current.runs) {
      const { value } = await guard(() => service.ai.history(500));
      if (value && at === generation.current) setRuns(value.items);
    }
    if (loaded.current.stashes) {
      const { value } = await guard(() => service.stashList(200));
      if (value && at === generation.current) setStashes(value.items);
    }
  }, [service, guard]);

  useEffect(() => {
    setSelection(null);
    setItems([]);
    void refresh();
  }, [refresh]);

  const loadMore = useCallback(async () => {
    if (!service || !next || loading) return;
    setLoading(true);
    const { value, failure: failed } = await guard(() =>
      service.history({ cursor: next, limit: PAGE }),
    );
    setLoading(false);
    if (failed) return setFailure(failed);
    if (!value) return;
    setItems((previous) => [...previous, ...value.items]);
    setNext(value.next);
    setBroken(value.broken?.message ?? null);
  }, [service, next, loading, guard]);

  useEffect(() => {
    if (!service || !visible) return;
    if (tab === "ai" && runs === null)
      void guard(() => service.ai.history(500)).then(({ value, failure: failed }) => {
        if (failed) return setFailure(failed);
        if (!value) return;
        loaded.current.runs = true;
        setRuns(value.items);
      });
    if (tab === "stashes" && stashes === null)
      void guard(() => service.stashList(200)).then(({ value, failure: failed }) => {
        if (failed) return setFailure(failed);
        if (!value) return;
        loaded.current.stashes = true;
        setStashes(value.items);
      });
  }, [service, visible, tab, runs, stashes, guard]);

  /** Refs at each commit (branches and tags), as Local Git names them. */
  const decorations = useMemo(() => {
    const out = new Map<string, string[]>();
    const add = (id: string, label: string) => out.set(id, [...(out.get(id) ?? []), label]);
    for (const branch of refs.branches) add(branch.commit, branch.name);
    for (const tag of refs.tags) add(tag.commit, `tag: ${tag.name}`);
    return out;
  }, [refs]);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return items;
    return items.filter(
      (item) =>
        item.message.toLowerCase().includes(needle) ||
        item.id.startsWith(needle) ||
        item.authorName.toLowerCase().includes(needle) ||
        ENTRY_LABEL[entryKind(item)].toLowerCase() === needle,
    );
  }, [items, filter]);

  const absolute = useCallback(
    (folderId: string, path: string) => {
      const root = folders.find((f) => f.folderId === folderId)?.path ?? folders[0]?.path ?? "";
      return `${root.replace(/[\\/]+$/, "")}/${path}`;
    },
    [folders],
  );

  if (!visible) return null;

  const headLabel = (() => {
    const state = head?.state;
    if (!state) return "…";
    if (state.kind === "branch") return state.name;
    if (state.kind === "unborn") return `${state.name} (no commits yet)`;
    return `detached at ${state.commit.slice(0, 12)}`;
  })();

  return (
    <aside
      aria-label="Local History"
      className="relative flex w-80 shrink-0 flex-col border-r border-[#2b2b2b] bg-[#0b0b0b] text-gray-200"
    >
      <header className="flex items-center justify-between px-3 py-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
          Local History
        </h2>
        <button
          type="button"
          className={plain}
          aria-label="Refresh Local History"
          onClick={() => void refresh()}
        >
          Refresh
        </button>
      </header>
      {!service ? (
        <div className="p-3 text-xs text-gray-400">
          Local History is available once a folder is open.
        </div>
      ) : (
        <>
          <div className="px-3 pb-2 text-xs" aria-label="Local HEAD">
            <span className="text-gray-500">HEAD </span>
            <span className={head?.state.kind === "detached" ? "text-amber-300" : "text-gray-100"}>
              {headLabel}
            </span>
            {readOnly && <Badge className="ml-2 border-gray-600 text-gray-400">read-only</Badge>}
          </div>
          {operation && (
            <OperationBanner
              service={service}
              state={operation}
              guard={guard}
              onDone={() => {
                onChanged();
                void refresh();
              }}
            />
          )}
          <div
            role="tablist"
            aria-label="Local History views"
            className="flex border-b border-[#2b2b2b] px-2 text-xs"
          >
            {(["history", "ai", "stashes"] as Tab[]).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={`px-2 py-1 ${tab === id ? "border-b-2 border-sky-500 text-gray-100" : "text-gray-400 hover:text-gray-200"}`}
                onClick={() => {
                  setTab(id);
                  setSelection(null);
                }}
              >
                {id === "history" ? "History" : id === "ai" ? "AI Runs" : "Stashes"}
              </button>
            ))}
          </div>
          {failure && <FailureView failure={failure} onRetry={() => void refresh()} />}
          <div className="flex min-h-0 flex-1 flex-col">
            {tab === "history" && (
              <HistoryList
                items={shown}
                total={items.length}
                filter={filter}
                onFilter={setFilter}
                loading={loading}
                hasMore={next !== null}
                broken={broken}
                headId={head?.commit?.id ?? null}
                decorations={decorations}
                selected={selection?.kind === "commit" ? selection.id : null}
                onSelect={(id) => setSelection({ kind: "commit", id })}
                onMore={() => void loadMore()}
              />
            )}
            {tab === "ai" && (
              <AiList
                runs={runs}
                selected={selection?.kind === "ai" ? selection.id : null}
                onSelect={(id) => setSelection({ kind: "ai", id })}
              />
            )}
            {tab === "stashes" && (
              <StashList
                stashes={stashes}
                selected={selection?.kind === "stash" ? selection.id : null}
                onSelect={(id) => setSelection({ kind: "stash", id })}
              />
            )}
          </div>
          {selection?.kind === "commit" && (
            <CommitDetail
              key={selection.id}
              service={service}
              id={selection.id}
              guard={guard}
              readOnly={readOnly}
              absolute={absolute}
              decorations={decorations.get(selection.id) ?? []}
              onDiff={onDiff}
              onSelectCommit={(id) => setSelection({ kind: "commit", id })}
              onRestored={() => {
                onChanged();
                void refresh();
              }}
            />
          )}
          {selection?.kind === "ai" && runs && (
            <AiDetail
              key={selection.id}
              service={service}
              run={runs.find((r) => r.agentRunId === selection.id) ?? null}
              guard={guard}
              readOnly={readOnly}
              onSelectCommit={(id) => {
                setTab("history");
                setSelection({ kind: "commit", id });
              }}
              onUndone={() => {
                onChanged();
                void refresh();
              }}
            />
          )}
          {selection?.kind === "stash" && stashes && (
            <StashDetail stash={stashes.find((s) => s.id === selection.id) ?? null} />
          )}
        </>
      )}
    </aside>
  );
}

type Guard = <T>(work: () => Promise<T>) => Promise<{ value?: T; failure?: Failure }>;

function HistoryList({
  items,
  total,
  filter,
  onFilter,
  loading,
  hasMore,
  broken,
  headId,
  decorations,
  selected,
  onSelect,
  onMore,
}: {
  items: LocalGitCommitInfo[];
  total: number;
  filter: string;
  onFilter: (value: string) => void;
  loading: boolean;
  hasMore: boolean;
  broken: string | null;
  headId: string | null;
  decorations: Map<string, string[]>;
  selected: string | null;
  onSelect: (id: string) => void;
  onMore: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight || 400));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Only the rows in view (and a few around them) are rendered.
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(items.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
  const index = items.findIndex((item) => item.id === selected);
  const move = (by: number) => {
    const target = items[Math.max(0, Math.min(items.length - 1, (index < 0 ? -1 : index) + by))];
    if (!target) return;
    onSelect(target.id);
    const element = scroller.current;
    const at = items.indexOf(target) * ROW_HEIGHT;
    if (
      element &&
      (at < element.scrollTop || at + ROW_HEIGHT > element.scrollTop + element.clientHeight)
    )
      element.scrollTop = at;
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <input
        aria-label="Filter Local History"
        placeholder="Filter loaded entries (message, id, author, type)"
        value={filter}
        onChange={(event) => onFilter(event.target.value)}
        className="mx-2 my-1 rounded border border-gray-700 bg-black px-2 py-1 text-xs outline-none focus:border-sky-600"
      />
      {items.length === 0 && !loading && (
        <div className="p-3 text-xs text-gray-400">
          {total === 0
            ? "No Local History yet. Checkpoints and local commits will appear here."
            : "No loaded entry matches the filter."}
        </div>
      )}
      <div
        ref={scroller}
        role="listbox"
        aria-label="Local History entries"
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto outline-none focus:ring-1 focus:ring-sky-700"
        onScroll={(event) => {
          const element = event.currentTarget;
          setScrollTop(element.scrollTop);
          if (
            hasMore &&
            !loading &&
            element.scrollTop + element.clientHeight > element.scrollHeight - ROW_HEIGHT * 4
          )
            onMore();
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            move(1);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            move(-1);
          }
        }}
      >
        <div style={{ height: items.length * ROW_HEIGHT, position: "relative" }}>
          {items.slice(first, last).map((item, offset) => {
            const kind = entryKind(item);
            const isHead = item.id === headId;
            return (
              <div
                key={item.id}
                role="option"
                aria-selected={item.id === selected}
                aria-label={`${ENTRY_LABEL[kind]} ${item.shortId} ${item.summary}${isHead ? " (HEAD)" : ""}`}
                onClick={() => onSelect(item.id)}
                style={{
                  position: "absolute",
                  top: (first + offset) * ROW_HEIGHT,
                  height: ROW_HEIGHT,
                  left: 0,
                  right: 0,
                }}
                className={`cursor-pointer border-l-2 px-2 py-1 text-xs ${item.id === selected ? "border-sky-500 bg-[#1d2a36]" : "border-transparent hover:bg-[#161616]"}`}
              >
                <div className="flex items-center gap-1 truncate">
                  <Badge className={KIND_STYLE[kind]}>{ENTRY_LABEL[kind]}</Badge>
                  {isHead && <Badge className="border-emerald-700 text-emerald-300">HEAD</Badge>}
                  {(decorations.get(item.id) ?? []).map((label) => (
                    <Badge key={label} className="border-gray-600 text-gray-300 normal-case">
                      {label}
                    </Badge>
                  ))}
                  <span className="truncate text-gray-100">{item.summary || "(no message)"}</span>
                </div>
                <div className="truncate text-[11px] text-gray-500">
                  <span className="font-mono">{item.shortId}</span> · {item.authorName} ·{" "}
                  <time dateTime={new Date(item.timeMs).toISOString()}>
                    {relativeTime(item.timeMs)}
                  </time>
                </div>
              </div>
            );
          })}
        </div>
        {loading && <div className="p-2 text-xs text-gray-500">Loading…</div>}
        {broken && <div className="p-2 text-xs text-orange-300">History ends early: {broken}</div>}
        {hasMore && !loading && (
          <button type="button" className={`${plain} m-2`} onClick={onMore}>
            Load older entries
          </button>
        )}
      </div>
    </div>
  );
}

function CommitDetail({
  service,
  id,
  guard,
  readOnly,
  absolute,
  decorations,
  onDiff,
  onSelectCommit,
  onRestored,
}: {
  service: LocalGitService;
  id: string;
  guard: Guard;
  readOnly: boolean;
  absolute: (folderId: string, path: string) => string;
  decorations: string[];
  onDiff: (diff: DiffDocument) => void;
  onSelectCommit: (id: string) => void;
  onRestored: () => void;
}) {
  const [commit, setCommit] = useState<LocalGitCommit | null>(null);
  const [against, setAgainst] = useState<"parent" | "workspace">("parent");
  const [changes, setChanges] = useState<LocalGitDiff | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [restore, setRestore] = useState<{
    path: string | null;
    folderId: string | null;
    plan: LocalGitRestorePlan;
  } | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void guard(() => service.readCommit(id)).then(({ value, failure: failed }) => {
      if (failed) setFailure(failed);
      if (value) setCommit(value);
    });
  }, [service, id, guard]);

  useEffect(() => {
    if (!commit) return;
    setChanges(null);
    const work =
      against === "parent"
        ? () => service.diffCommits(commit.parents[0] ?? null, id, { lineDiffs: false })
        : () => service.diffWorkspace({ from: id, lineDiffs: false }).then((r) => r.diff);
    void guard(work).then(({ value, failure: failed }) => {
      if (failed) setFailure(failed);
      if (value) setChanges(value);
    });
  }, [service, id, commit, against, guard]);

  const openDiff = async (entry: LocalGitDiffEntry) => {
    const lines =
      against === "parent"
        ? () => service.diffCommits(commit?.parents[0] ?? null, id, { lineDiffs: true })
        : () => service.diffWorkspace({ from: id, lineDiffs: true }).then((r) => r.diff);
    const { value, failure: failed } = await guard(lines);
    if (failed) return setFailure(failed);
    const full = value?.entries.find((e) => e.folderId === entry.folderId && e.path === entry.path);
    if (!full) return;
    const reason = unavailableReason(full);
    onDiff({
      path: absolute(full.folderId, full.path),
      title: `${full.path} (${id.slice(0, 12)} ${against === "parent" ? "vs. its parent" : "vs. the workspace"}) -- Local History, read-only`,
      text: unifiedDiff(full),
      notice: reason ?? undefined,
    });
  };

  const planRestore = async (path: string | null, folderId: string | null) => {
    setOutcome(null);
    const { value, failure: failed } = await guard(() =>
      service.restore(id, {
        path: path ?? undefined,
        folderId: folderId ?? undefined,
        dryRun: true,
      }),
    );
    if (failed) return setFailure(failed);
    if (value) setRestore({ path, folderId, plan: value.plan });
  };

  const runRestore = async () => {
    if (!restore) return;
    setBusy(true);
    const { value, failure: failed } = await guard(() =>
      service.restore(id, {
        path: restore.path ?? undefined,
        folderId: restore.folderId ?? undefined,
      }),
    );
    setBusy(false);
    setRestore(null);
    if (failed) return setFailure(failed);
    if (!value) return;
    if (value.status === "refused")
      setOutcome(
        `Restore refused -- nothing changed: ${value.conflicts.map(describeRestoreConflict).join("; ")}`,
      );
    else if (value.succeeded)
      setOutcome(`Restored. A checkpoint of the workspace was taken first.`);
    else setOutcome(`Restore stopped (${value.status})${value.error ? `: ${value.error}` : ""}`);
    onRestored();
  };

  const kind = commit ? entryKind(commit) : null;
  const facts = commit ? provenance(commit) : null;
  return (
    <section
      aria-label="Entry details"
      className="max-h-[55%] shrink-0 overflow-auto border-t border-[#2b2b2b] p-2 text-xs"
    >
      {failure && <FailureView failure={failure} />}
      {!commit ? (
        !failure && <div className="text-gray-500">Loading…</div>
      ) : (
        <>
          <div className="mb-1 flex items-center gap-1">
            {kind && <Badge className={KIND_STYLE[kind]}>{ENTRY_LABEL[kind]}</Badge>}
            <span className="font-semibold text-gray-100">
              {commit.message.split("\n")[0] || "(no message)"}
            </span>
          </div>
          <dl>
            <Field label="Commit">
              <span className="font-mono">{commit.id}</span>
            </Field>
            <Field label="Refs">{decorations.join(", ")}</Field>
            <Field label="Author">
              {commit.authorName} ({commit.source})
            </Field>
            <Field label="Date">{new Date(commit.timeMs).toLocaleString()}</Field>
            <Field label="Parents">
              {commit.parents.length === 0
                ? "none (first commit)"
                : commit.parents.map((p) => (
                    <button
                      key={p}
                      type="button"
                      className="mr-2 font-mono text-sky-300 hover:underline"
                      onClick={() => onSelectCommit(p)}
                    >
                      {p.slice(0, 12)}
                    </button>
                  ))}
            </Field>
            <Field label="Cherry-picked">{facts?.cherryPickedFrom?.slice(0, 12)}</Field>
            <Field label="Merged">{facts?.mergedFrom?.slice(0, 12)}</Field>
            <Field label="Agent run">{facts?.agentRunId}</Field>
            <Field label="Task">{facts?.taskId}</Field>
            <Field label="ChangeSet">
              {facts?.changeSetId}
              {facts?.changeSetRevision ? ` @ ${facts.changeSetRevision}` : ""}
            </Field>
            <Field label="AI checkpoint">{facts?.checkpoint?.slice(0, 12)}</Field>
            <Field label="Validation">
              {facts?.validation}
              {facts?.validationRef ? ` (${facts.validationRef})` : ""}
            </Field>
            <Field label="Model">{facts?.model}</Field>
          </dl>
          {commit.message.includes("\n") && (
            <pre className="my-1 whitespace-pre-wrap text-gray-400">
              {commit.message.split("\n").slice(1).join("\n").trim()}
            </pre>
          )}
          <div className="mt-2 flex items-center justify-between">
            <label className="text-gray-400">
              Compare with{" "}
              <select
                aria-label="Compare with"
                value={against}
                onChange={(event) => setAgainst(event.target.value as "parent" | "workspace")}
                className="rounded border border-gray-700 bg-black px-1"
              >
                <option value="parent">its parent</option>
                <option value="workspace">the workspace</option>
              </select>
            </label>
            <button
              type="button"
              className={plain}
              disabled={readOnly}
              onClick={() => void planRestore(null, null)}
            >
              Restore…
            </button>
          </div>
          <div className="mt-1 font-semibold text-gray-300">
            Changed files{changes ? ` (${changes.entries.length})` : ""}
          </div>
          {!changes ? (
            <div className="text-gray-500">Loading…</div>
          ) : changes.entries.length === 0 ? (
            <div className="text-gray-500">No changes.</div>
          ) : (
            <ul aria-label="Changed files">
              {changes.entries.slice(0, 500).map((entry) => (
                <li key={`${entry.folderId}:${entry.path}`} className="flex items-center gap-1">
                  <span
                    className="w-4 font-mono text-gray-400"
                    title={CHANGE_LABEL[entry.kind]}
                    aria-label={CHANGE_LABEL[entry.kind]}
                  >
                    {CHANGE_LETTER[entry.kind]}
                  </span>
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-gray-200 hover:underline"
                    title={entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path}
                    onClick={() => void openDiff(entry)}
                  >
                    {entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path}
                  </button>
                  {!entry.contentAvailable && (
                    <Badge className="border-orange-700 text-orange-300">unavailable</Badge>
                  )}
                  {entry.binary && <Badge className="border-gray-600 text-gray-400">binary</Badge>}
                  <button
                    type="button"
                    className="text-gray-400 hover:text-gray-100 disabled:opacity-40"
                    aria-label={`Restore ${entry.path}`}
                    title="Restore this file from this entry"
                    disabled={readOnly}
                    onClick={() => void planRestore(entry.path, entry.folderId)}
                  >
                    ↺
                  </button>
                </li>
              ))}
              {changes.entries.length > 500 && <li>…and {changes.entries.length - 500} more</li>}
            </ul>
          )}
          {outcome && (
            <div role="status" className="mt-2 text-gray-300">
              {outcome}
            </div>
          )}
        </>
      )}
      {restore && (
        <Sheet
          title={restore.path ? `Restore ${restore.path}` : `Restore ${id.slice(0, 12)}`}
          onClose={() => setRestore(null)}
          actions={
            <>
              <button type="button" className={plain} onClick={() => setRestore(null)}>
                Cancel
              </button>
              <button
                type="button"
                className={danger}
                disabled={busy || restore.plan.conflicts.length > 0 || restore.plan.unchanged}
                onClick={() => void runRestore()}
              >
                Restore
              </button>
            </>
          }
        >
          <PlanView
            plan={restore.plan}
            affected={
              restore.path
                ? `The file will be made exactly as it is in ${id.slice(0, 12)}.`
                : `The workspace will be made exactly as it is in ${id.slice(0, 12)}. Local Git takes a checkpoint of it first; HEAD does not move.`
            }
          />
        </Sheet>
      )}
    </section>
  );
}

function AiList({
  runs,
  selected,
  onSelect,
}: {
  runs: LocalGitAiRun[] | null;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  if (runs === null) return <div className="p-3 text-xs text-gray-500">Loading…</div>;
  if (runs.length === 0)
    return <div className="p-3 text-xs text-gray-400">No AI runs in this workspace yet.</div>;
  return (
    <ul role="listbox" aria-label="AI runs" className="min-h-0 flex-1 overflow-auto">
      {runs.map((run) => (
        <li
          key={run.agentRunId}
          role="option"
          aria-selected={run.agentRunId === selected}
          onClick={() => onSelect(run.agentRunId)}
          className={`cursor-pointer border-l-2 px-2 py-1 text-xs ${run.agentRunId === selected ? "border-sky-500 bg-[#1d2a36]" : "border-transparent hover:bg-[#161616]"}`}
        >
          <div className="flex items-center gap-1">
            <Badge className={KIND_STYLE.ai}>AI</Badge>
            <Badge
              className={
                run.interrupted || run.status === "failed"
                  ? "border-orange-700 text-orange-300"
                  : "border-gray-600 text-gray-300"
              }
            >
              {aiStatusLabel(run)}
            </Badge>
            <span className="truncate text-gray-100">{run.reason}</span>
          </div>
          <div className="truncate text-[11px] text-gray-500">
            run {run.agentRunId}
            {run.taskId ? ` · task ${run.taskId}` : ""} · {run.changes.length} AI change(s) ·{" "}
            {relativeTime(run.startedMs)}
          </div>
        </li>
      ))}
    </ul>
  );
}

function AiDetail({
  service,
  run,
  guard,
  readOnly,
  onSelectCommit,
  onUndone,
}: {
  service: LocalGitService;
  run: LocalGitAiRun | null;
  guard: Guard;
  readOnly: boolean;
  onSelectCommit: (id: string) => void;
  onUndone: () => void;
}) {
  const [undo, setUndo] = useState<LocalGitAiUndoResult | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!run) return null;
  const planUndo = async () => {
    setOutcome(null);
    const { value, failure: failed } = await guard(() =>
      service.ai.undo(run.agentRunId, { dryRun: true }),
    );
    if (failed) return setFailure(failed);
    if (value) setUndo(value);
  };
  const runUndo = async () => {
    setBusy(true);
    const { value, failure: failed } = await guard(() => service.ai.undo(run.agentRunId));
    setBusy(false);
    setUndo(null);
    if (failed) return setFailure(failed);
    if (!value) return;
    if (value.status === "refused")
      setOutcome(
        `Undo refused -- nothing changed: ${[
          ...value.refusals.map(describeAiRefusal),
          ...value.conflicts.map(describeRestoreConflict),
        ].join("; ")}`,
      );
    else if (value.succeeded) setOutcome("The AI run was undone.");
    else setOutcome(`Undo stopped (${value.status})${value.error ? `: ${value.error}` : ""}`);
    onUndone();
  };
  const reasons = undo
    ? [...undo.refusals.map(describeAiRefusal), ...undo.conflicts.map(describeRestoreConflict)]
    : [];
  return (
    <section
      aria-label="AI run details"
      className="max-h-[55%] shrink-0 overflow-auto border-t border-[#2b2b2b] p-2 text-xs"
    >
      {failure && <FailureView failure={failure} />}
      <div className="mb-1 flex items-center gap-1">
        <Badge className={KIND_STYLE.ai}>AI run</Badge>
        <span className="font-semibold text-gray-100">{run.reason}</span>
      </div>
      <dl>
        <Field label="Status">{aiStatusLabel(run)}</Field>
        <Field label="Agent run">{run.agentRunId}</Field>
        <Field label="Task">{run.taskId}</Field>
        <Field label="ChangeSet">
          {run.changeSetId}
          {run.changeSetRevision ? ` @ ${run.changeSetRevision}` : ""}
        </Field>
        <Field label="Model">{run.model}</Field>
        <Field label="Started">{new Date(run.startedMs).toLocaleString()}</Field>
        <Field label="Ended">
          {run.finishedMs ? new Date(run.finishedMs).toLocaleString() : null}
        </Field>
        <Field label="Validation">
          {run.validation
            ? `${run.validation.passed ? "passed" : "failed"}${run.validation.reference ? ` (${run.validation.reference})` : ""}`
            : null}
        </Field>
        <Field label="Note">{run.note}</Field>
        <Field label="Checkpoint">
          <button
            type="button"
            className="font-mono text-sky-300 hover:underline"
            onClick={() => onSelectCommit(run.checkpoint)}
          >
            {run.checkpoint.slice(0, 12)}
          </button>
        </Field>
        <Field label="AI commit">
          {run.commit && (
            <button
              type="button"
              className="font-mono text-sky-300 hover:underline"
              onClick={() => onSelectCommit(run.commit!)}
            >
              {run.commit.slice(0, 12)}
            </button>
          )}
        </Field>
      </dl>
      <div className="mt-1 font-semibold text-gray-300">AI changes ({run.changes.length})</div>
      <ul aria-label="AI changes">
        {run.changes.map((change) => (
          <li key={`${change.folderId}:${change.path}`} className="truncate">
            <span className="mr-1 font-mono text-gray-400">
              {change.before === null ? "A" : change.after === null ? "D" : "M"}
            </span>
            {change.path}
          </li>
        ))}
      </ul>
      {run.unattributed.length > 0 && (
        <>
          <div className="mt-1 font-semibold text-gray-300">
            Not the AI's ({run.unattributed.length})
          </div>
          <ul aria-label="Changes not by the AI" className="text-gray-400">
            {run.unattributed.slice(0, 100).map((path) => (
              <li key={path} className="truncate">
                {path.slice(path.indexOf(":") + 1)}
              </li>
            ))}
          </ul>
        </>
      )}
      {run.undoAvailable && (
        <button
          type="button"
          className={`${danger} mt-2`}
          disabled={readOnly}
          onClick={() => void planUndo()}
        >
          Undo AI Run…
        </button>
      )}
      {outcome && (
        <div role="status" className="mt-2 text-gray-300">
          {outcome}
        </div>
      )}
      {undo && (
        <Sheet
          title={`Undo AI run ${run.agentRunId}`}
          onClose={() => setUndo(null)}
          actions={
            <>
              <button type="button" className={plain} onClick={() => setUndo(null)}>
                Cancel
              </button>
              <button
                type="button"
                className={danger}
                disabled={busy || reasons.length > 0}
                onClick={() => void runUndo()}
              >
                Undo AI Run
              </button>
            </>
          }
        >
          <div className="space-y-2">
            <div>
              Only the AI's changes are taken out; other changes stay.
              {undo.plan.movesHead &&
                " The run was committed: HEAD moves back to before the AI commit, which stays in the record."}
            </div>
            {reasons.length > 0 && (
              <div>
                <div className="font-semibold text-red-300">
                  Refused -- nothing will change ({reasons.length}):
                </div>
                <ul className="ml-3 list-disc" aria-label="Reasons">
                  {reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>
            )}
            {undo.plan.merged.length > 0 && (
              <div>
                A person's later edits are kept in:{" "}
                {undo.plan.merged.map((p) => p.slice(p.indexOf(":") + 1)).join(", ")}
              </div>
            )}
            {reasons.length === 0 && <PlanView plan={undo.plan.restore} />}
          </div>
        </Sheet>
      )}
    </section>
  );
}

function StashList({
  stashes,
  selected,
  onSelect,
}: {
  stashes: LocalGitStash[] | null;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  if (stashes === null) return <div className="p-3 text-xs text-gray-500">Loading…</div>;
  if (stashes.length === 0)
    return <div className="p-3 text-xs text-gray-400">No Local Git stashes.</div>;
  return (
    <ul role="listbox" aria-label="Stashes" className="min-h-0 flex-1 overflow-auto">
      {stashes.map((stash) => (
        <li
          key={stash.id}
          role="option"
          aria-selected={stash.id === selected}
          onClick={() => onSelect(stash.id)}
          className={`cursor-pointer border-l-2 px-2 py-1 text-xs ${stash.id === selected ? "border-sky-500 bg-[#1d2a36]" : "border-transparent hover:bg-[#161616]"}`}
        >
          <div className="truncate text-gray-100">{stash.message}</div>
          <div className="truncate text-[11px] text-gray-500">
            {stash.branch ?? "detached"} · {relativeTime(stash.timeMs)}
          </div>
        </li>
      ))}
    </ul>
  );
}

function StashDetail({ stash }: { stash: LocalGitStash | null }) {
  if (!stash) return null;
  return (
    <section aria-label="Stash details" className="shrink-0 border-t border-[#2b2b2b] p-2 text-xs">
      <div className="mb-1 font-semibold text-gray-100">{stash.message}</div>
      <dl>
        <Field label="Stash">{stash.id}</Field>
        <Field label="Branch">{stash.branch ?? "detached HEAD"}</Field>
        <Field label="Base">{stash.base?.slice(0, 12)}</Field>
        <Field label="Made">{new Date(stash.timeMs).toLocaleString()}</Field>
        <Field label="Staged">{String(stash.counts.staged)}</Field>
        <Field label="Unstaged">{String(stash.counts.unstaged)}</Field>
        <Field label="Untracked">{String(stash.counts.untracked)}</Field>
      </dl>
    </section>
  );
}

/** A merge or cherry-pick in progress: what it is, its conflicts, and continue or abort. */
function OperationBanner({
  service,
  state,
  guard,
  onDone,
}: {
  service: LocalGitService;
  state: LocalGitOperationState;
  guard: Guard;
  onDone: () => void;
}) {
  const [failure, setFailure] = useState<Failure | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const unresolved = state.conflicts.filter((c) => c.resolution === "unresolved").length;
  const act = async (which: "continue" | "abort") => {
    const { value, failure: failed } = await guard(() =>
      which === "continue" ? service.continueOperation() : service.abortOperation(),
    );
    if (failed) return setFailure(failed);
    if (value?.status === "refused")
      setMessage(
        `Refused -- nothing changed: ${value.conflicts.map(describeRestoreConflict).join("; ")}`,
      );
    else onDone();
  };
  return (
    <div
      role="region"
      aria-label="Operation in progress"
      className="mx-2 mb-2 rounded border border-amber-800 bg-amber-950/30 p-2 text-xs"
    >
      <div className="text-amber-200">
        {state.kind === "merge" ? "Merge" : "Cherry-pick"} of {state.label} in progress
        {state.phase === "applying" ? " (stopped while changing files)" : ""}
      </div>
      {state.conflicts.length > 0 && (
        <ul aria-label="Conflicts" className="mt-1 text-gray-300">
          {state.conflicts.map((conflict) => (
            <li key={`${conflict.folderId}:${conflict.path}`}>
              {conflict.path} -- {conflict.kind} -- {conflict.resolution}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-1 flex gap-2">
        <button
          type="button"
          className={primary}
          disabled={state.phase === "conflicts" && unresolved > 0}
          onClick={() => void act("continue")}
        >
          Continue
        </button>
        <button type="button" className={plain} onClick={() => void act("abort")}>
          Abort
        </button>
      </div>
      {message && <div className="mt-1 text-gray-300">{message}</div>}
      {failure && <FailureView failure={failure} />}
    </div>
  );
}
