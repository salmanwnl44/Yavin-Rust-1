import type { MenuItem } from "../../components/ui/ContextMenu.tsx";
import type { GitEntry } from "./parsers/status.ts";
import { hasStagedPart, hasUnstagedPart, isDiscardable } from "./changeGroups.ts";
import type { ChangeGroup } from "./changeGroups.ts";

export interface ChangeMenuActions {
  openChanges: (staged: boolean) => void;
  /** Absent where the window cannot open files (the panel was given no way to). */
  openFile?: () => void;
  stage: () => void;
  unstage: () => void;
  discard: () => void;
  acceptSide: (side: "ours" | "theirs") => void;
  ignore: () => void;
  reveal?: () => void;
  copyPath: () => void;
  copyRelativePath: () => void;
}

/**
 * The right-click menu of a changed file: what can be done with it, in the group it was
 * clicked in -- a Staged row offers Unstage, an Unstaged one Stage and Discard, a conflict
 * Ours and Theirs. Items that do not apply are left out rather than disabled, except Discard,
 * which says why it cannot (the file is not modified in the working tree).
 */
export function buildChangeMenu(
  entry: GitEntry,
  group: ChangeGroup,
  actions: ChangeMenuActions,
  busy: boolean,
): MenuItem[] {
  const staged = hasStagedPart(entry);
  const unstaged = hasUnstagedPart(entry);
  const inStaged = group === "staged" || (group === "all" && staged);
  const inUnstaged = group === "unstaged" || (group === "all" && unstaged);
  const items: MenuItem[] = [];

  if (entry.conflict) {
    items.push(
      { label: "Open Changes", onClick: () => actions.openChanges(false) },
      ...(actions.openFile ? [{ label: "Open File", onClick: actions.openFile }] : []),
      { divider: true },
      {
        label: "Accept Current (Ours)",
        disabled: busy,
        onClick: () => actions.acceptSide("ours"),
      },
      {
        label: "Accept Incoming (Theirs)",
        disabled: busy,
        onClick: () => actions.acceptSide("theirs"),
      },
      { label: "Stage as Resolved", disabled: busy, onClick: actions.stage },
    );
  } else {
    items.push({
      label: group === "staged" ? "Open Staged Changes" : "Open Changes",
      onClick: () => actions.openChanges(group === "staged"),
    });
    if (group === "all" && staged && unstaged)
      items.push({ label: "Open Staged Changes", onClick: () => actions.openChanges(true) });
    if (actions.openFile) items.push({ label: "Open File", onClick: actions.openFile });
    items.push({ divider: true });
    if (inUnstaged) items.push({ label: "Stage", disabled: busy, onClick: actions.stage });
    if (inStaged) items.push({ label: "Unstage", disabled: busy, onClick: actions.unstage });
    if (inUnstaged)
      items.push({
        label: "Discard Changes",
        danger: true,
        disabled: busy || !isDiscardable(entry),
        reason: isDiscardable(entry)
          ? undefined
          : entry.untracked
            ? "An untracked file has nothing to go back to"
            : "Only modified files can be discarded",
        onClick: actions.discard,
      });
    if (entry.untracked) items.push({ label: "Add to .gitignore", onClick: actions.ignore });
  }

  items.push({ divider: true });
  if (actions.reveal) items.push({ label: "Reveal in File Explorer", onClick: actions.reveal });
  items.push(
    { label: "Copy Path", onClick: actions.copyPath },
    { label: "Copy Relative Path", onClick: actions.copyRelativePath },
  );
  return items;
}

/** The line `Add to .gitignore` appends for a repo-relative path: anchored, `/`-separated. */
export function gitignoreLine(relativePath: string): string {
  return `/${relativePath.replace(/\\/g, "/").replace(/^\/+/, "")}`;
}

/** `.gitignore` with `line` added, once, on a line of its own. */
export function withIgnored(existing: string, line: string): string {
  const lines = existing.split(/\r?\n/);
  if (lines.includes(line)) return existing;
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const base = existing === "" || existing.endsWith("\n") ? existing : existing + eol;
  return `${base}${line}${eol}`;
}
