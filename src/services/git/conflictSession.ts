/**
 * The dedicated three-way conflict editor's **view-model** (WS10). It composes the pure conflict
 * engine (`conflict.ts`) with injected Git/document operations so the editor view stays a thin
 * renderer and the logic is testable without a DOM. It never owns Git or document state: it reads
 * the three sides and the result through injected functions, tracks a per-region **choice** (so a
 * resolution is revisable and a region is never silently resolved), computes the resolved Result
 * from the *original* parse (manual edits happen in the normal editor, not here), and completes a
 * resolution only through the existing apply path + the index-verifying `resolveFile`.
 *
 * Safety: `complete()` revalidates the file against what was loaded (refusing a stale resolution),
 * refuses while any region is undecided (markers would remain), writes the Result through the
 * injected apply path (DocumentService / guarded write — never a raw FS write here), then stages
 * and verifies the index. A stale/obsolete load is dropped via a token, and listeners are the
 * caller's to dispose.
 */
import {
  applyResolutions,
  classifyConflict,
  parseConflicts,
  resolutionProgress,
  type Choice,
  type ConflictClassification,
  type ConflictRegion,
  type ParsedConflicts,
} from "./conflict.ts";

/** The three content sides, each `null` when that index stage/side does not exist. */
export interface ConflictSides {
  readonly current: string | null; // ours, stage 2
  readonly incoming: string | null; // theirs, stage 3
  readonly base: string | null; // common ancestor, stage 1
}

export type SessionStatus = "loading" | "ready" | "completing" | "done" | "error";

export interface ConflictSessionState {
  readonly status: SessionStatus;
  readonly path: string;
  readonly classification: ConflictClassification | null;
  readonly sides: ConflictSides;
  readonly regions: readonly ConflictRegion[];
  readonly choices: ReadonlyMap<number, Choice>;
  /** The Result text as resolved so far (unchosen regions keep their markers). */
  readonly resultText: string;
  readonly progress: { total: number; resolved: number; unresolved: number };
  /** True when every region has a non-manual choice (no markers remain) — safe to complete. */
  readonly ready: boolean;
  readonly error: string | null;
}

export interface ConflictSessionDeps {
  readonly path: string;
  /** The Git status code (`index`+`worktree`, e.g. `"UU"`) — the source of truth for the type. */
  readonly code: string;
  /** The current working-tree/document text (with markers). */
  readonly loadResult: () => Promise<string>;
  /** One side's content; rejects when that side/stage is unavailable (e.g. no base). */
  readonly loadSide: (side: "current" | "incoming" | "base") => Promise<string>;
  /** Re-read the live text just before completing, to refuse a stale resolution. */
  readonly liveResult: () => Promise<string>;
  /** Write the resolved text through the existing apply path (DocumentService / guarded write). */
  readonly apply: (text: string) => Promise<void>;
  /** Stage the resolved file and verify no unmerged index stage remains (`Repository.resolveFile`). */
  readonly stageResolved: () => Promise<void>;
}

export interface ConflictSession {
  getState(): ConflictSessionState;
  subscribe(listener: () => void): () => void;
  /** Choose a side for a region (revisable); `manual` keeps its markers for editing in the editor. */
  choose(regionIndex: number, choice: Choice): void;
  /** Whether a side's action is available (the side exists). */
  canAccept(choice: Choice): boolean;
  /** Validate, write the Result, stage, and verify the index. Resolves true on success. */
  complete(): Promise<boolean>;
  dispose(): void;
}

export function createConflictSession(deps: ConflictSessionDeps): ConflictSession {
  let disposed = false;
  let token = 0;
  const listeners = new Set<() => void>();
  let original: ParsedConflicts = { segments: [], regions: [] };
  let originalText = "";
  const choices = new Map<number, Choice>();

  let state: ConflictSessionState = {
    status: "loading",
    path: deps.path,
    classification: classifyConflict(deps.code),
    sides: { current: null, incoming: null, base: null },
    regions: [],
    choices,
    resultText: "",
    progress: { total: 0, resolved: 0, unresolved: 0 },
    ready: false,
    error: null,
  };

  const emit = () => {
    for (const listener of [...listeners])
      try {
        listener();
      } catch {
        /* a listener's failure is not the session's */
      }
  };

  const recompute = (status: SessionStatus = state.status, error: string | null = state.error) => {
    const resultText = applyResolutions(original, choices);
    const progress = resolutionProgress(original, choices);
    state = {
      ...state,
      status,
      regions: original.regions,
      choices,
      resultText,
      progress,
      ready: progress.total > 0 && progress.unresolved === 0,
      error,
    };
    emit();
  };

  const classification = state.classification;
  const wantsSide = (side: "current" | "incoming" | "base"): boolean =>
    classification ? classification.sides[side] : true;

  // Load the result text and the available sides; a newer load supersedes this one.
  const load = async () => {
    const mine = ++token;
    try {
      const [result, current, incoming, base] = await Promise.all([
        deps.loadResult(),
        wantsSide("current") ? deps.loadSide("current").catch(() => null) : Promise.resolve(null),
        wantsSide("incoming") ? deps.loadSide("incoming").catch(() => null) : Promise.resolve(null),
        wantsSide("base") ? deps.loadSide("base").catch(() => null) : Promise.resolve(null),
      ]);
      if (disposed || mine !== token) return;
      originalText = result;
      original = parseConflicts(result);
      state = { ...state, sides: { current, incoming, base } };
      recompute("ready", null);
    } catch (error) {
      if (disposed || mine !== token) return;
      recompute("error", error instanceof Error ? error.message : String(error));
    }
  };
  void load();

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    canAccept(choice) {
      if (choice === "manual") return true;
      if (choice === "both") return wantsSide("current") && wantsSide("incoming");
      if (choice === "base") return state.sides.base !== null;
      if (choice === "current") return wantsSide("current");
      return wantsSide("incoming"); // "incoming"
    },
    choose(regionIndex, choice) {
      if (!original.regions[regionIndex]) return;
      choices.set(regionIndex, choice);
      recompute();
    },
    async complete() {
      if (!state.ready) {
        recompute("error", "Resolve every conflict region before completing.");
        return false;
      }
      const mine = ++token;
      recompute("completing", null);
      try {
        // Refuse a stale resolution: the file must still read as it did when loaded.
        const live = await deps.liveResult();
        if (live !== originalText) {
          if (!disposed && mine === token)
            recompute(
              "error",
              "The file changed since the conflict editor opened. Reopen it to review the new state.",
            );
          return false;
        }
        await deps.apply(state.resultText);
        await deps.stageResolved();
        if (disposed || mine !== token) return true;
        recompute("done", null);
        return true;
      } catch (error) {
        if (!disposed && mine === token)
          recompute("error", error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    dispose() {
      disposed = true;
      token++;
      listeners.clear();
    },
  };
}
