/**
 * Type hierarchy (WS15) over the generic {@link createHierarchy} model: a lazy, cycle-safe tree of
 * a type's supertypes or subtypes, from the LSP `typeHierarchy/supertypes` / `subtypes` requests
 * (injected). A thin wrapper — identical tree logic (lazy loading, cycle detection, stale-token
 * protection, snapshot caching, disposal) is shared with call hierarchy (WS14) in `hierarchy.ts`.
 * The supertypes/subtypes responses are plain item lists (no call-site ranges), so each maps to a
 * child with only its item.
 */
import { createHierarchy, type Hierarchy } from "./hierarchy.ts";
import type { TypeHierarchyItem } from "./protocol.ts";

export type TypeDirection = "supertypes" | "subtypes";

export interface TypeHierarchyDeps {
  readonly direction: TypeDirection;
  readonly root: TypeHierarchyItem;
  readonly supertypes: (item: TypeHierarchyItem) => Promise<TypeHierarchyItem[] | null>;
  readonly subtypes: (item: TypeHierarchyItem) => Promise<TypeHierarchyItem[] | null>;
}

export function createTypeHierarchy(deps: TypeHierarchyDeps): Hierarchy {
  return createHierarchy({
    initial: deps.direction,
    directions: ["supertypes", "subtypes"],
    root: deps.root,
    load: async (direction, item) =>
      ((await (direction === "supertypes" ? deps.supertypes : deps.subtypes)(item)) ?? []).map(
        (type) => ({ item: type }),
      ),
  });
}
