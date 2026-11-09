/**
 * Merge-conflict model and resolution engine (WS10). Two concerns, both pure (no Git, DOM or
 * filesystem access):
 *
 *  1. **Conflict type** from Git's actual unmerged index code (the status XY, e.g. `UU`/`AA`/`UD`),
 *     which says *which sides exist* — never inferred from markers in the text. The three content
 *     sides (base / current / incoming) are read separately from the index stages (1/2/3) and are
 *     represented as **available or not**, since a delete/add conflict has no three sides.
 *  2. **Region resolution** of a working-tree file's conflict markers — parsing `<<<<<<<`,
 *     `|||||||` (diff3 base), `=======`, `>>>>>>>` into regions, and rebuilding the resolved text
 *     from a per-region choice (Accept Current/Incoming/Both/Base, or leave it for manual editing).
 *
 * Resolution produces text with the document's own (LF) line endings; the existing guarded apply
 * path re-encodes to the file's real encoding/EOL, so nothing here touches encoding.
 */

/** Git's seven unmerged states, named. */
export type ConflictType =
  | "both-modified" // UU
  | "both-added" // AA
  | "both-deleted" // DD
  | "added-by-us" // AU
  | "added-by-them" // UA
  | "deleted-by-us" // DU
  | "deleted-by-them"; // UD

export interface ConflictClassification {
  readonly type: ConflictType;
  /** Which index stages/content sides exist for this conflict. */
  readonly sides: { readonly base: boolean; readonly current: boolean; readonly incoming: boolean };
  /** A conflict whose resolution is just "keep or delete the file" (no in-file regions to merge). */
  readonly fileLevel: boolean;
  readonly label: string;
}

const XY_TO_TYPE: Record<string, ConflictType> = {
  UU: "both-modified",
  AA: "both-added",
  DD: "both-deleted",
  AU: "added-by-us",
  UA: "added-by-them",
  DU: "deleted-by-us",
  UD: "deleted-by-them",
};

const SIDES: Record<ConflictType, { base: boolean; current: boolean; incoming: boolean }> = {
  "both-modified": { base: true, current: true, incoming: true },
  "both-added": { base: false, current: true, incoming: true },
  "both-deleted": { base: true, current: false, incoming: false },
  "added-by-us": { base: false, current: true, incoming: false },
  "added-by-them": { base: false, current: false, incoming: true },
  "deleted-by-us": { base: true, current: false, incoming: true },
  "deleted-by-them": { base: true, current: true, incoming: false },
};

const LABELS: Record<ConflictType, string> = {
  "both-modified": "Both modified",
  "both-added": "Both added",
  "both-deleted": "Both deleted",
  "added-by-us": "Added by us",
  "added-by-them": "Added by them",
  "deleted-by-us": "Deleted by us",
  "deleted-by-them": "Deleted by them",
};

/** Classify a conflict from its Git status code (`index`+`worktree`, e.g. `"UU"`). Returns null
 * when the code is not an unmerged state. */
export function classifyConflict(code: string): ConflictClassification | null {
  const type = XY_TO_TYPE[code];
  if (!type) return null;
  const sides = SIDES[type];
  // A conflict with in-file regions to merge has at least two content sides; the rest are
  // resolved by keeping or removing the file (add-by-one-side / delete conflicts).
  const contentSides = Number(sides.current) + Number(sides.incoming);
  return { type, sides, fileLevel: contentSides < 2, label: LABELS[type] };
}

// --- conflict-marker parsing -------------------------------------------------------------------

export interface ConflictRegion {
  /** 0-based ordinal among the file's conflict regions. */
  readonly index: number;
  /** 1-based line of the `<<<<<<<` marker and of the `>>>>>>>` marker. */
  readonly startLine: number;
  readonly endLine: number;
  readonly currentLabel: string;
  readonly incomingLabel: string;
  readonly current: readonly string[];
  /** Present only for a diff3-style conflict (a `|||||||` base section); null otherwise. */
  readonly base: readonly string[] | null;
  readonly incoming: readonly string[];
}

type Segment =
  | { readonly kind: "text"; readonly lines: readonly string[] }
  | { readonly kind: "conflict"; readonly region: ConflictRegion };

export interface ParsedConflicts {
  readonly segments: readonly Segment[];
  readonly regions: readonly ConflictRegion[];
}

const CURRENT = "<<<<<<<";
const BASE = "|||||||";
const SEP = "=======";
const INCOMING = ">>>>>>>";

/** Parse a file's text into text/conflict segments and its conflict regions. Robust to a file with
 * no conflicts (one text segment) and to diff3 (`|||||||`) base sections. */
export function parseConflicts(text: string): ParsedConflicts {
  const lines = text.split("\n");
  const segments: Segment[] = [];
  const regions: ConflictRegion[] = [];
  let text_buffer: string[] = [];
  const flushText = () => {
    if (text_buffer.length) {
      segments.push({ kind: "text", lines: text_buffer });
      text_buffer = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.startsWith(`${CURRENT} `) && line !== CURRENT) {
      text_buffer.push(line);
      continue;
    }
    // A conflict opens here; scan to its `>>>>>>>`.
    const startLine = i + 1;
    const currentLabel = line.slice(CURRENT.length).trim();
    const current: string[] = [];
    const base: string[] = [];
    const incoming: string[] = [];
    let section: "current" | "base" | "incoming" = "current";
    let sawBase = false;
    let incomingLabel = "";
    let closed = false;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j]!;
      if (l === BASE || l.startsWith(`${BASE} `)) {
        section = "base";
        sawBase = true;
      } else if (l === SEP) section = "incoming";
      else if (l === INCOMING || l.startsWith(`${INCOMING} `)) {
        incomingLabel = l.slice(INCOMING.length).trim();
        closed = true;
        break;
      } else if (section === "current") current.push(l);
      else if (section === "base") base.push(l);
      else incoming.push(l);
    }
    if (!closed) {
      // An unterminated `<<<<<<<` is not a real region — keep it as text and stop treating it specially.
      text_buffer.push(line);
      continue;
    }
    flushText();
    const region: ConflictRegion = {
      index: regions.length,
      startLine,
      endLine: j + 1,
      currentLabel,
      incomingLabel,
      current,
      base: sawBase ? base : null,
      incoming,
    };
    regions.push(region);
    segments.push({ kind: "conflict", region });
    i = j;
  }
  flushText();
  return { segments, regions };
}

// --- resolution --------------------------------------------------------------------------------

/** A per-region resolution choice. `manual` (or an absent choice) leaves the markers in place for
 * hand editing — it never silently picks a side. */
export type Choice = "current" | "incoming" | "both" | "base" | "manual";

const markerLines = (region: ConflictRegion): string[] => {
  const out = [`${CURRENT} ${region.currentLabel}`.trimEnd(), ...region.current];
  if (region.base) out.push(`${BASE}`, ...region.base);
  out.push(SEP, ...region.incoming, `${INCOMING} ${region.incomingLabel}`.trimEnd());
  return out;
};

/** The lines a region resolves to for a given choice. `both` is **current then incoming** (a
 * documented, deterministic order). An unavailable choice (e.g. `base` with no diff3 base) falls
 * back to leaving the markers, so a side is never fabricated. */
export function resolveRegionLines(region: ConflictRegion, choice: Choice): string[] {
  switch (choice) {
    case "current":
      return [...region.current];
    case "incoming":
      return [...region.incoming];
    case "both":
      return [...region.current, ...region.incoming];
    case "base":
      return region.base ? [...region.base] : markerLines(region);
    case "manual":
      return markerLines(region);
  }
}

/** Rebuild the file text from the parsed segments and a per-region choice map. Regions with no
 * choice (or `manual`) keep their markers, so the file stays unresolved there. */
export function applyResolutions(
  parsed: ParsedConflicts,
  choices: ReadonlyMap<number, Choice>,
): string {
  const out: string[] = [];
  for (const segment of parsed.segments) {
    if (segment.kind === "text") out.push(...segment.lines);
    else
      out.push(
        ...resolveRegionLines(segment.region, choices.get(segment.region.index) ?? "manual"),
      );
  }
  return out.join("\n");
}

/** The absolute 1-based line ranges of a region's three sides, from its start line and its sides'
 * lengths (the parser guarantees the marker order). Used by the editor to tint each side; a side
 * with no lines has `end < start`. */
export function regionSideLines(region: ConflictRegion): {
  currentStart: number;
  currentEnd: number;
  baseStart: number;
  baseEnd: number;
  incomingStart: number;
  incomingEnd: number;
} {
  const currentStart = region.startLine + 1;
  const currentEnd = region.startLine + region.current.length;
  let cursor = currentEnd + 1; // the `|||||||` (diff3) or `=======` marker line
  let baseStart = 0;
  let baseEnd = -1;
  if (region.base) {
    baseStart = cursor + 1;
    baseEnd = cursor + region.base.length;
    cursor = baseEnd + 1; // the `=======` line
  }
  return {
    currentStart,
    currentEnd,
    baseStart,
    baseEnd,
    incomingStart: cursor + 1,
    incomingEnd: region.endLine - 1,
  };
}

/** Resolution progress for a file: how many regions are decided (a non-`manual` choice) vs. left. */
export function resolutionProgress(
  parsed: ParsedConflicts,
  choices: ReadonlyMap<number, Choice>,
): { total: number; resolved: number; unresolved: number } {
  const total = parsed.regions.length;
  let resolved = 0;
  for (const region of parsed.regions) {
    const choice = choices.get(region.index);
    if (choice && choice !== "manual") resolved++;
  }
  return { total, resolved, unresolved: total - resolved };
}

/** Whether any conflict markers remain in the (possibly hand-edited) text — the cheap "is this file
 * still conflicted in its content?" check used before staging-as-resolved. */
export function hasConflictMarkers(text: string): boolean {
  return parseConflicts(text).regions.length > 0;
}
