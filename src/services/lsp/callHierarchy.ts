/**
 * Call hierarchy (WS14) over the generic {@link createHierarchy} model: a lazy, cycle-safe tree of
 * a function's callers (incoming) or callees (outgoing), from the LSP
 * `callHierarchy/incomingCalls` / `outgoingCalls` requests (injected). This is a thin wrapper that
 * maps those call objects to the generic model's children; all the tree logic (lazy loading, cycle
 * detection, stale-token protection, snapshot caching, disposal) lives in `hierarchy.ts` and is
 * shared with type hierarchy (WS15).
 */
import {
  createHierarchy,
  itemKey,
  type Hierarchy,
  type HierarchyNode,
  type HierarchyRow,
} from "./hierarchy.ts";
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
} from "./protocol.ts";

export type CallDirection = "incoming" | "outgoing";
export type CallNode = HierarchyNode;
export type CallRow = HierarchyRow;
export type CallHierarchy = Hierarchy;
/** @deprecated use `itemKey` from `hierarchy.ts`; kept for compatibility. */
export const callItemKey = itemKey;

export interface CallHierarchyDeps {
  readonly direction: CallDirection;
  readonly root: CallHierarchyItem;
  readonly incoming: (item: CallHierarchyItem) => Promise<CallHierarchyIncomingCall[] | null>;
  readonly outgoing: (item: CallHierarchyItem) => Promise<CallHierarchyOutgoingCall[] | null>;
}

export function createCallHierarchy(deps: CallHierarchyDeps): CallHierarchy {
  return createHierarchy({
    initial: deps.direction,
    directions: ["incoming", "outgoing"],
    root: deps.root,
    load: async (direction, item) =>
      direction === "incoming"
        ? ((await deps.incoming(item)) ?? []).map((call) => ({
            item: call.from,
            fromRanges: call.fromRanges,
          }))
        : ((await deps.outgoing(item)) ?? []).map((call) => ({
            item: call.to,
            fromRanges: call.fromRanges,
          })),
  });
}
