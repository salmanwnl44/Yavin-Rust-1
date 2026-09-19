import type { RepoEntry } from "../../services/git/registry";
import { guardedAffecting } from "../../services/git/sync";
import type { MenuEntry } from "./GitMenu";

/**
 * The shared item list behind both the repo row's "..." menu and the Changes
 * section's "..." menu (VS Code shows the same command set from either place).
 * Branch/Remote management stays in the existing inline drawer (`onOpenBranches`)
 * rather than being reimplemented as menu flyouts -- that UI is already built,
 * tested, and handles the diverged/publish flows that don't reduce to one click.
 */
export function buildGitCommandMenu({
  entry,
  dirty,
  message,
  onCommitted,
  includeViewOptions,
  onOpenBranches,
  onSortChanges,
  changesSort,
}: {
  entry: RepoEntry;
  dirty: boolean;
  /** The commit message currently typed in the Changes section, if any. */
  message: string;
  onCommitted: () => void;
  includeViewOptions?: boolean;
  onOpenBranches: () => void;
  onSortChanges?: (order: "discovery" | "name" | "status") => void;
  changesSort?: "discovery" | "name" | "status";
}): MenuEntry[] {
  const repo = entry.store.repository;
  const snapshot = entry.store.getSnapshot();
  const run = (kind: string, op: () => Promise<string>) =>
    void guardedAffecting(entry, kind, dirty, op);
  const hasUpstream = !!snapshot.branch.upstream;
  const staged = snapshot.entries.filter((e) => !e.conflict && !e.untracked && e.index !== " ");
  const modified = snapshot.entries.filter((e) => !e.conflict && e.worktree !== " ");
  const canCommit = message.trim().length > 0 && staged.length > 0;

  const items: MenuEntry[] = [];

  if (includeViewOptions) {
    items.push(
      { label: "View as Tree", disabled: true },
      {
        label: "Sort Changes",
        children: [
          {
            label: "Discovery Time",
            checked: (changesSort ?? "discovery") === "discovery",
            onSelect: () => onSortChanges?.("discovery"),
          },
          {
            label: "Name",
            checked: changesSort === "name",
            onSelect: () => onSortChanges?.("name"),
          },
          {
            label: "Status",
            checked: changesSort === "status",
            onSelect: () => onSortChanges?.("status"),
          },
        ],
      },
      { separator: true },
    );
  }

  items.push(
    { label: "Pull", disabled: !hasUpstream, onSelect: () => run("pull", () => repo.pull()) },
    { label: "Push", disabled: !hasUpstream, onSelect: () => run("push", () => repo.push()) },
    { label: "Clone…", disabled: true },
    { label: "Checkout to…", disabled: true },
    { label: "Fetch", onSelect: () => run("fetch", () => repo.fetch()) },
    { separator: true },
    {
      label: "Commit",
      children: [
        {
          label: "Commit Staged",
          disabled: !canCommit,
          onSelect: () => {
            void entry.store
              .guarded("commit", dirty, () => repo.commit(message))
              .then((ok) => {
                if (ok) onCommitted();
              });
          },
        },
      ],
    },
    {
      label: "Changes",
      children: [
        {
          label: "Stage All Changes",
          disabled: modified.length === 0,
          onSelect: () =>
            run("stage", async () => {
              for (const e of modified) await repo.stage(e.path);
              return `Staged ${modified.length} files.`;
            }),
        },
        {
          label: "Unstage All Changes",
          disabled: staged.length === 0,
          onSelect: () =>
            run("unstage", async () => {
              for (const e of staged) await repo.unstage(e.path);
              return `Unstaged ${staged.length} files.`;
            }),
        },
      ],
    },
    {
      label: "Pull, Push",
      children: [
        {
          label: "Pull (Rebase)",
          disabled: !hasUpstream,
          onSelect: () => run("pullRebase", () => repo.pullRebase()),
        },
        {
          label: "Pull (Merge)",
          disabled: !hasUpstream,
          onSelect: () => run("pullMerge", () => repo.pullMerge()),
        },
      ],
    },
    { label: "Branch", onSelect: onOpenBranches },
    { label: "Remote", onSelect: onOpenBranches },
    {
      label: "Stash",
      children: [
        {
          label: "Stash Changes",
          disabled: modified.length === 0,
          onSelect: () => {
            const stashMessage = window.prompt("Stash message (optional)") ?? "";
            run("stash", () => repo.stash(stashMessage || undefined));
          },
        },
        { label: "Pop Latest Stash", onSelect: () => run("stashPop", () => repo.stashPop()) },
      ],
    },
    {
      label: "Tags",
      children: [
        {
          label: "List Tags",
          onSelect: () => {
            void repo
              .tags()
              .then((tags) =>
                entry.store.setNotice(
                  tags.length ? tags.join(", ") : "No tags in this repository.",
                ),
              )
              .catch((error) => entry.store.setNotice(String(error)));
          },
        },
      ],
    },
    { label: "Worktrees", disabled: true },
    { separator: true },
    { label: "Show Git Output", disabled: true },
  );

  return items;
}
