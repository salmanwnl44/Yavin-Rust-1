/**
 * Breakpoints (IDE-05): one set per workspace, by canonical resource identity (`resource.ts`)
 * -- never by a path string, so `c:\work\a.py`, `C:/work/a.py` and `file:///c%3A/work/a.py` are
 * one file. A set lives as long as the window (switching file or workspace and back keeps it),
 * holds no session, and says whether each breakpoint is verified only as the debug session
 * tells it to (`verify`), `null` meaning "no session to ask".
 */
import { fsPath, resourceId, type ResourceId, type ResourceUri } from "../resource.ts";
import type { WorkspaceId } from "../terminalProtocol.ts";

export interface BreakpointEntry {
  id: string;
  resource: ResourceId;
  uri: ResourceUri;
  /** 1-based, as the editor counts. */
  line: number;
  column: number | null;
  enabled: boolean;
  /** `null` with no session; else whether the adapter could set it. */
  verified: boolean | null;
  /** The adapter's reason, when it could not. */
  message: string | null;
  /** The adapter's own id for it (`Breakpoint.id`), for its `breakpoint` events. */
  adapterId: number | null;
}

export interface BreakpointChange {
  /** The files whose breakpoints changed (what a session sends `setBreakpoints` for). */
  resources: ResourceId[];
  /** Only verification changed: nothing to send to the adapter. */
  verification: boolean;
}

export interface Breakpoints {
  readonly workspace: WorkspaceId;
  getSnapshot(): readonly BreakpointEntry[];
  subscribe(listener: (change: BreakpointChange) => void): () => void;
  forResource(resource: ResourceId): BreakpointEntry[];
  /** Adds one at `line` (the one there already, if any). */
  add(uri: ResourceUri, line: number, column?: number | null): BreakpointEntry;
  /** Adds one at `line`, or removes the one there. */
  toggle(uri: ResourceUri, line: number): "added" | "removed";
  remove(id: string): void;
  setEnabled(id: string, enabled: boolean): void;
  clear(): void;
  /** The adapter's verdict on one (DebugService only). */
  verify(
    id: string,
    verdict: { verified: boolean; message?: string | null; adapterId?: number | null },
  ): void;
  /** No session any more: nothing is verified or refused. */
  forgetVerification(): void;
  byAdapterId(adapterId: number): BreakpointEntry | undefined;
}

export function createBreakpoints(workspace: WorkspaceId): Breakpoints {
  let entries: readonly BreakpointEntry[] = [];
  let next = 1;
  const listeners = new Set<(change: BreakpointChange) => void>();
  const publish = (next: readonly BreakpointEntry[], change: BreakpointChange) => {
    entries = next;
    for (const listener of [...listeners]) {
      try {
        listener(change);
      } catch {
        /* One listener's failure is not the others'. */
      }
    }
  };
  const update = (id: string, patch: Partial<BreakpointEntry>, verification = false) => {
    const found = entries.find((entry) => entry.id === id);
    if (!found) return;
    publish(
      entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
      { resources: [found.resource], verification },
    );
  };
  const sorted = (list: BreakpointEntry[]) =>
    list.sort((a, b) =>
      a.resource === b.resource ? a.line - b.line : fsPath(a.uri).localeCompare(fsPath(b.uri)),
    );

  const api: Breakpoints = {
    workspace,
    getSnapshot: () => entries,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    forResource: (resource) => entries.filter((entry) => entry.resource === resource),
    add(uri, line, column = null) {
      if (!Number.isInteger(line) || line < 1) throw new RangeError(`Line ${line} is not a line.`);
      const resource = resourceId(uri);
      const there = entries.find((entry) => entry.resource === resource && entry.line === line);
      if (there) return there;
      const entry: BreakpointEntry = {
        id: `bp-${next++}`,
        resource,
        uri,
        line,
        column,
        enabled: true,
        verified: null,
        message: null,
        adapterId: null,
      };
      publish(sorted([...entries, entry]), { resources: [resource], verification: false });
      return entry;
    },
    toggle(uri, line) {
      const resource = resourceId(uri);
      const there = entries.find((entry) => entry.resource === resource && entry.line === line);
      if (there) {
        api.remove(there.id);
        return "removed";
      }
      api.add(uri, line);
      return "added";
    },
    remove(id) {
      const found = entries.find((entry) => entry.id === id);
      if (!found) return;
      publish(
        entries.filter((entry) => entry.id !== id),
        { resources: [found.resource], verification: false },
      );
    },
    setEnabled(id, enabled) {
      const found = entries.find((entry) => entry.id === id);
      if (!found || found.enabled === enabled) return;
      // A disabled breakpoint is not sent; whether the adapter verified it no longer applies.
      update(id, { enabled, verified: null, message: null, adapterId: null });
    },
    clear() {
      if (!entries.length) return;
      const resources = [...new Set(entries.map((entry) => entry.resource))];
      publish([], { resources, verification: false });
    },
    verify(id, verdict) {
      update(
        id,
        {
          verified: verdict.verified,
          message: verdict.message ?? null,
          adapterId: verdict.adapterId ?? null,
        },
        true,
      );
    },
    forgetVerification() {
      if (entries.every((entry) => entry.verified === null && entry.adapterId === null)) return;
      publish(
        entries.map((entry) => ({ ...entry, verified: null, message: null, adapterId: null })),
        { resources: [...new Set(entries.map((entry) => entry.resource))], verification: true },
      );
    },
    byAdapterId: (adapterId) => entries.find((entry) => entry.adapterId === adapterId),
  };
  return api;
}

/** The window's breakpoints, one set per workspace, kept while the window lives. */
export function createBreakpointRegistry() {
  const sets = new Map<WorkspaceId, Breakpoints>();
  return {
    forWorkspace(id: WorkspaceId): Breakpoints {
      let set = sets.get(id);
      if (!set) sets.set(id, (set = createBreakpoints(id)));
      return set;
    },
  };
}
