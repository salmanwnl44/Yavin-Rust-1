import type { RepoEntry } from "../../services/git/registry";
import { guardedAffecting } from "../../services/git/sync";
import { syncAction } from "./syncAction";
import type { MenuEntry } from "./GitMenu";
import type { DialogRequest, DialogOption } from "../ui/AppDialog";
import type { DiffDocument } from "../layout/DiffEditor";
import type { ChangesSort } from "../../services/git/changesSort";

/**
 * The shared item list behind the repo row's "..." menu, the Changes section's "..." menu and
 * the Commit split button's dropdown -- the same three places a VS Code-family Source Control
 * panel shows this exact command set from. Every name-, remote- or target-requiring action
 * opens the shared `AppDialog` (`onDialog`) rather than a bespoke popup, the same modal the
 * rest of the app already uses for New File/Delete/Go to Line.
 */
export function buildGitCommandMenu({
  entry,
  dirty,
  hasMessage,
  getMessage,
  onCommitted,
  onDialog,
  onDiff,
  onDiscardAll,
  includeViewOptions,
  onSortChanges,
  changesSort,
  changesViewAsTree,
  onToggleViewAsTree,
  onClone,
  onShowOutput,
}: {
  entry: RepoEntry;
  dirty: boolean;
  /** Whether a commit message is currently typed in the Changes section. */
  hasMessage: boolean;
  /** Reads the message at click time, so the menu never commits stale text. */
  getMessage: () => string;
  onCommitted: () => void;
  /** Opens the shared prompt/picker dialog -- see `ui/AppDialog.tsx`. */
  onDialog: (request: DialogRequest) => void;
  /** Shows a stash's own diff ("View Stash…"). Omitted for a repo row that isn't the active
   * repo, where there is no diff pane to show it in -- the item is disabled instead. */
  onDiff?: (doc: DiffDocument) => void;
  /** Runs the panel's own careful Discard All flow (scope explanation, confirm, partial-failure
   * handling) -- duplicating that here would risk drifting from it. Omitted the same way. */
  onDiscardAll?: () => void;
  includeViewOptions?: boolean;
  onSortChanges?: (order: ChangesSort) => void;
  changesSort?: ChangesSort;
  changesViewAsTree?: boolean;
  onToggleViewAsTree?: () => void;
  /** Runs the panel's clone flow (pick a folder, prompt for a URL, open the result). */
  onClone?: () => void;
  /** Opens the Git Output view -- the log of every command the app has run. */
  onShowOutput?: () => void;
}): MenuEntry[] {
  const repo = entry.store.repository;
  const snapshot = entry.store.getSnapshot();
  const run = (kind: string, op: () => Promise<string>) =>
    void guardedAffecting(entry, kind, dirty, op);
  const hasUpstream = !!snapshot.branch.upstream;
  const staged = snapshot.entries.filter((e) => !e.conflict && !e.untracked && e.index !== " ");
  const modified = snapshot.entries.filter((e) => !e.conflict && e.worktree !== " ");
  const conflictCount = snapshot.entries.filter((e) => e.conflict).length;
  // The same gate as the Commit button (`CommitBox`): a message and no unresolved conflicts.
  // "Commit"/"Commit All" don't also require something already staged -- they stage tracked
  // changes themselves (`-a`) when nothing was staged first.
  const canCommitAny = hasMessage && conflictCount === 0;
  const canCommitStaged = canCommitAny && staged.length > 0;
  const otherBranches = snapshot.branches.filter((b) => b !== snapshot.branch.name);

  const branchPicker = (branches: readonly string[]): DialogOption[] =>
    branches.map((name) => ({ value: name, label: name }));
  const remotePicker = (): DialogOption[] =>
    snapshot.remotes.map((name) => ({ value: name, label: name }));
  const stashPicker = (): DialogOption[] =>
    snapshot.stashes.map((s) => ({
      value: String(s.index),
      label: s.message || `stash@{${s.index}}`,
      description: s.branch ? `On ${s.branch}` : undefined,
    }));

  /** "Delete Branch…"'s safe two-tier delete (-d, then a confirmed -D), exactly matching the
   * branch drawer's own escalation (Section D.2/Q): the only refusal with a real, informed
   * override is "commits not on any other branch" -- every other refusal has none that would
   * actually succeed, so nothing else is offered a confirm. */
  const deleteBranchSafely = async (name: string) => {
    const ok = await guardedAffecting(entry, "deleteBranch", dirty, () =>
      repo.deleteBranch(name, false),
    );
    if (ok) return;
    const notice = entry.store.getSnapshot().notice;
    if (
      notice.includes("commits not on any other branch") &&
      window.confirm(`"${name}" has commits not on any other branch. Delete it anyway?`)
    ) {
      await guardedAffecting(entry, "deleteBranch", dirty, () => repo.deleteBranch(name, true));
    }
  };

  const items: MenuEntry[] = [];

  if (includeViewOptions) {
    const asTree = !!changesViewAsTree;
    items.push(
      // The label names the action (the mode you'd switch TO), not the current mode --
      // the same convention VS Code's own scm.viewAsTree/scm.viewAsList commands use.
      { label: asTree ? "View as List" : "View as Tree", onSelect: onToggleViewAsTree },
      {
        label: "View & Sort",
        children: [
          {
            label: "View as List",
            checked: !asTree,
            onSelect: () => asTree && onToggleViewAsTree?.(),
          },
          {
            label: "View as Tree",
            checked: asTree,
            onSelect: () => !asTree && onToggleViewAsTree?.(),
          },
          { separator: true },
          {
            label: "Sort Changes by Name",
            checked: changesSort === "name",
            onSelect: () => onSortChanges?.("name"),
          },
          {
            label: "Sort Changes by Path",
            checked: (changesSort ?? "path") === "path",
            onSelect: () => onSortChanges?.("path"),
          },
          {
            label: "Sort Changes by Status",
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
    {
      label: "Clone…",
      disabled: !onClone,
      onSelect: () => onClone?.(),
    },
    {
      label: "Checkout to…",
      // A repository with only the current branch has nothing to check out to; the Branch
      // submenu is where a new one gets created.
      disabled: otherBranches.length === 0,
      onSelect: () =>
        onDialog({
          title: "Checkout to branch",
          options: branchPicker(otherBranches),
          submit: (branch) => void run("switch", () => repo.switchBranch(branch)),
        }),
    },
    { label: "Fetch", onSelect: () => run("fetch", () => repo.fetch({ prune: false })) },
    { separator: true },
    {
      label: "Commit",
      children: [
        {
          label: "Commit",
          disabled: !canCommitAny,
          onSelect: () => {
            void guardedAffecting(entry, "commit", dirty, () =>
              repo.commit(getMessage(), { all: staged.length === 0 }),
            ).then((ok) => ok && onCommitted());
          },
        },
        {
          label: "Commit Staged",
          disabled: !canCommitStaged,
          onSelect: () => {
            // Through `guardedAffecting`, like every other mutation, so the shared graph
            // resets and siblings refresh exactly as after the Commit button.
            void guardedAffecting(entry, "commit", dirty, () => repo.commit(getMessage())).then(
              (ok) => {
                if (ok) onCommitted();
              },
            );
          },
        },
        {
          label: "Commit All",
          disabled: !canCommitAny,
          onSelect: () => {
            void guardedAffecting(entry, "commit", dirty, () =>
              repo.commit(getMessage(), { all: true }),
            ).then((ok) => ok && onCommitted());
          },
        },
        {
          label: "Undo Last Commit",
          disabled: snapshot.operationInProgress !== "",
          onSelect: () => run("undoLastCommit", () => repo.undoLastCommit()),
        },
        {
          label: "Abort Rebase",
          disabled: snapshot.operationInProgress !== "rebase",
          onSelect: () => run("abort", () => repo.abort()),
        },
        { separator: true },
        {
          label: "Commit (Amend)",
          disabled: !canCommitAny,
          onSelect: () => {
            void guardedAffecting(entry, "commit", dirty, () =>
              repo.commit(getMessage(), { all: staged.length === 0, amend: true }),
            ).then((ok) => ok && onCommitted());
          },
        },
        {
          label: "Commit Staged (Amend)",
          disabled: !canCommitStaged,
          onSelect: () => {
            void guardedAffecting(entry, "commit", dirty, () =>
              repo.commit(getMessage(), { amend: true }),
            ).then((ok) => ok && onCommitted());
          },
        },
        {
          label: "Commit All (Amend)",
          disabled: !canCommitAny,
          onSelect: () => {
            void guardedAffecting(entry, "commit", dirty, () =>
              repo.commit(getMessage(), { all: true, amend: true }),
            ).then((ok) => ok && onCommitted());
          },
        },
        { separator: true },
        {
          label: "Commit (Signed Off)",
          disabled: !canCommitAny,
          onSelect: () => {
            void guardedAffecting(entry, "commit", dirty, () =>
              repo.commit(getMessage(), { all: staged.length === 0, signoff: true }),
            ).then((ok) => ok && onCommitted());
          },
        },
        {
          label: "Commit Staged (Signed Off)",
          disabled: !canCommitStaged,
          onSelect: () => {
            void guardedAffecting(entry, "commit", dirty, () =>
              repo.commit(getMessage(), { signoff: true }),
            ).then((ok) => ok && onCommitted());
          },
        },
        {
          label: "Commit All (Signed Off)",
          disabled: !canCommitAny,
          onSelect: () => {
            void guardedAffecting(entry, "commit", dirty, () =>
              repo.commit(getMessage(), { all: true, signoff: true }),
            ).then((ok) => ok && onCommitted());
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
        ...(onDiscardAll
          ? [
              {
                label: "Discard All Changes",
                disabled: modified.length === 0,
                onSelect: onDiscardAll,
              },
            ]
          : []),
      ],
    },
    {
      label: "Pull, Push",
      children: [
        {
          label: "Sync",
          disabled: !hasUpstream,
          // Shares the repo row's sync-pill decision instead of reimplementing it. The
          // reimplementation here was `behind > 0 ? pull() : push()`, which on a *diverged*
          // branch (ahead AND behind) silently took the pull branch and created a merge
          // commit the user never chose -- exactly the one case `syncAction` refuses to
          // decide, and refuses with an explanation naming Rebase and Merge, both of which
          // this same menu offers.
          onSelect: () => syncAction(entry, dirty).run(() => {}),
        },
        { separator: true },
        {
          label: "Pull",
          disabled: !hasUpstream,
          onSelect: () => run("pull", () => repo.pull()),
        },
        {
          label: "Pull (Rebase)",
          disabled: !hasUpstream,
          onSelect: () => run("pullRebase", () => repo.pullRebase()),
        },
        { label: "Pull from…", onSelect: () => promptPullFrom() },
        { separator: true },
        { label: "Push", onSelect: () => run("push", () => repo.push()) },
        { label: "Push to…", onSelect: () => promptPushTo() },
        { separator: true },
        { label: "Fetch", onSelect: () => run("fetch", () => repo.fetch()) },
        {
          label: "Fetch (Prune)",
          onSelect: () => run("fetch", () => repo.fetch({ prune: true })),
        },
        {
          label: "Fetch From All Remotes",
          onSelect: () => run("fetch", () => repo.fetch({ allRemotes: true })),
        },
      ],
    },
    {
      label: "Branch",
      children: [
        {
          label: "Merge…",
          disabled: otherBranches.length === 0,
          onSelect: () =>
            onDialog({
              title: "Merge branch",
              options: branchPicker(otherBranches),
              submit: (branch) => void run("mergeBranch", () => repo.mergeBranch(branch)),
            }),
        },
        {
          label: "Rebase Branch…",
          disabled: otherBranches.length === 0,
          onSelect: () =>
            onDialog({
              title: "Rebase onto branch",
              options: branchPicker(otherBranches),
              submit: (branch) => void run("rebaseOnto", () => repo.rebaseOnto(branch)),
            }),
        },
        { separator: true },
        {
          label: "Create Branch…",
          onSelect: () =>
            onDialog({
              title: "Create branch",
              input: "",
              confirmLabel: "Create Branch",
              submit: (name) => {
                if (!name.trim()) throw new Error("Enter a branch name.");
                run("branch", () => repo.createBranch(name.trim()));
              },
            }),
        },
        {
          label: "Create Branch From…",
          disabled: snapshot.branches.length === 0,
          onSelect: () =>
            onDialog({
              title: "Create branch from…",
              options: branchPicker(snapshot.branches),
              submit: (startPoint) =>
                onDialog({
                  title: `Create branch from "${startPoint}"`,
                  input: "",
                  confirmLabel: "Create Branch",
                  submit: (name) => {
                    if (!name.trim()) throw new Error("Enter a branch name.");
                    run("branch", () => repo.createBranchFrom(name.trim(), startPoint));
                  },
                }),
            }),
        },
        { separator: true },
        {
          label: "Rename Branch…",
          disabled: snapshot.branches.length === 0,
          onSelect: () =>
            onDialog({
              title: "Rename branch",
              options: branchPicker(snapshot.branches),
              submit: (oldName) =>
                onDialog({
                  title: `Rename "${oldName}"`,
                  input: oldName,
                  confirmLabel: "Rename Branch",
                  submit: (newName) => {
                    if (!newName.trim()) throw new Error("Enter a new branch name.");
                    run("renameBranch", () => repo.renameBranch(oldName, newName.trim()));
                  },
                }),
            }),
        },
        {
          label: "Delete Branch…",
          disabled: otherBranches.length === 0,
          onSelect: () =>
            onDialog({
              title: "Delete branch",
              options: branchPicker(otherBranches),
              submit: (name) => void deleteBranchSafely(name),
            }),
        },
        {
          label: "Delete Remote Branch…",
          disabled: snapshot.remotes.length === 0,
          onSelect: () => promptDeleteRemoteRef("branch"),
        },
        { separator: true },
        {
          label: "Publish Branch…",
          disabled: snapshot.remotes.length === 0,
          onSelect: () =>
            onDialog({
              title: "Publish branch to…",
              options: remotePicker(),
              submit: (remote) => void run("publish", () => repo.publish(remote)),
            }),
        },
      ],
    },
    {
      label: "Remote",
      children: [
        {
          label: "Add Remote…",
          onSelect: () =>
            onDialog({
              title: "Add remote",
              message: "Remote name",
              input: "origin",
              confirmLabel: "Next",
              submit: (name) => {
                if (!name.trim()) throw new Error("Enter a remote name.");
                onDialog({
                  title: `Add remote "${name.trim()}"`,
                  message: "Remote URL",
                  input: "",
                  confirmLabel: "Add Remote",
                  submit: (url) => {
                    if (!url.trim()) throw new Error("Enter a URL.");
                    run("addRemote", () => repo.addRemote(name.trim(), url.trim()));
                  },
                });
              },
            }),
        },
        {
          label: "Remove Remote",
          disabled: snapshot.remotes.length === 0,
          onSelect: () =>
            onDialog({
              title: "Remove remote",
              options: remotePicker(),
              submit: (remote) => {
                if (!window.confirm(`Remove remote "${remote}"?`)) return;
                run("removeRemote", () => repo.removeRemote(remote));
              },
            }),
        },
      ],
    },
    {
      label: "Stash",
      children: [
        {
          label: "Stash",
          disabled: modified.length === 0,
          onSelect: () => promptStash({}),
        },
        {
          label: "Stash (Include Untracked)",
          disabled: modified.length === 0 && snapshot.entries.every((e) => !e.untracked),
          onSelect: () => promptStash({ untracked: true }),
        },
        {
          label: "Stash Staged",
          disabled: staged.length === 0,
          onSelect: () => promptStash({ staged: true }),
        },
        { separator: true },
        {
          label: "Apply Latest Stash",
          disabled: snapshot.stashes.length === 0,
          onSelect: () => run("stashApply", () => repo.stashApply(0)),
        },
        {
          label: "Apply Stash…",
          disabled: snapshot.stashes.length === 0,
          onSelect: () =>
            onDialog({
              title: "Apply stash",
              options: stashPicker(),
              submit: (index) => void run("stashApply", () => repo.stashApply(Number(index))),
            }),
        },
        { separator: true },
        {
          label: "Pop Latest Stash",
          disabled: snapshot.stashes.length === 0,
          onSelect: () => run("stashPop", () => repo.stashPop()),
        },
        {
          label: "Pop Stash…",
          disabled: snapshot.stashes.length === 0,
          onSelect: () =>
            onDialog({
              title: "Pop stash",
              options: stashPicker(),
              submit: (index) => void run("stashPop", () => repo.stashPop(Number(index))),
            }),
        },
        { separator: true },
        {
          label: "Drop Stash…",
          disabled: snapshot.stashes.length === 0,
          onSelect: () =>
            onDialog({
              title: "Drop stash",
              options: stashPicker(),
              submit: (index) => {
                const stash = snapshot.stashes.find((s) => s.index === Number(index));
                if (
                  !window.confirm(
                    `Drop the stash "${stash?.message ?? index}"? This cannot be undone.`,
                  )
                )
                  return;
                run("stashDrop", () => repo.stashDrop(Number(index)));
              },
            }),
        },
        {
          label: "Drop All Stashes…",
          disabled: snapshot.stashes.length === 0,
          onSelect: () => {
            if (
              window.confirm(`Drop all ${snapshot.stashes.length} stashes? This cannot be undone.`)
            )
              run("stashClear", () => repo.stashClear());
          },
        },
        { separator: true },
        {
          label: "View Stash…",
          disabled: snapshot.stashes.length === 0 || !onDiff,
          onSelect: () =>
            onDialog({
              title: "View stash",
              options: stashPicker(),
              submit: async (index) => {
                const text = await repo.stashShow(Number(index));
                const stash = snapshot.stashes.find((s) => s.index === Number(index));
                onDiff?.({
                  path: `stash@{${index}}`,
                  title: stash?.message ? `Stash: ${stash.message}` : `stash@{${index}}`,
                  text:
                    text || "No textual differences. The change may be metadata or binary only.",
                });
              },
            }),
        },
      ],
    },
    {
      label: "Tags",
      children: [
        {
          label: "Create Tag…",
          onSelect: () =>
            onDialog({
              title: "Create tag",
              input: "",
              confirmLabel: "Create Tag",
              submit: (name) => {
                if (!name.trim()) throw new Error("Enter a tag name.");
                run("createTag", () => repo.createTag(name.trim()));
              },
            }),
        },
        {
          label: "Delete Tag…",
          onSelect: () =>
            void repo.tags().then((tags) => {
              if (!tags.length) {
                entry.store.setNotice("No tags in this repository.");
                return;
              }
              onDialog({
                title: "Delete tag",
                options: tags.map((name) => ({ value: name, label: name })),
                submit: (name) => void run("deleteTag", () => repo.deleteTag(name)),
              });
            }),
        },
        {
          label: "Delete Remote Tag…",
          disabled: snapshot.remotes.length === 0,
          onSelect: () => promptDeleteRemoteRef("tag"),
        },
        { separator: true },
        { label: "Push Tags", onSelect: () => run("pushTags", () => repo.pushTags()) },
      ],
    },
    // No "Worktrees" item: Antigravity's menu has none, and Yavin's own worktree support is
    // reached from the repository switcher. A permanently-disabled entry was only ever noise.
    { separator: true },
    { label: "Show Git Output", disabled: !onShowOutput, onSelect: () => onShowOutput?.() },
  );

  function promptStash(options: { untracked?: boolean; staged?: boolean }) {
    onDialog({
      title: "Stash message (optional)",
      input: "",
      confirmLabel: "Stash",
      submit: (message) =>
        run("stash", () => repo.stash({ message: message || undefined, ...options })),
    });
  }

  function promptPushTo() {
    if (!snapshot.remotes.length) {
      entry.store.setNotice("No remote is configured. Add one with `git remote add` first.");
      return;
    }
    onDialog({
      title: "Push to remote",
      options: remotePicker(),
      submit: (remote) =>
        onDialog({
          title: `Push to "${remote}"`,
          message: "Branch name on the remote",
          input: snapshot.branch.name,
          confirmLabel: "Push",
          submit: (branch) => {
            if (!branch.trim()) throw new Error("Enter a branch name.");
            run("pushTo", () => repo.pushTo(remote, branch.trim()));
          },
        }),
    });
  }

  function promptPullFrom() {
    if (!snapshot.remotes.length) {
      entry.store.setNotice("No remote is configured. Add one with `git remote add` first.");
      return;
    }
    onDialog({
      title: "Pull from remote",
      options: remotePicker(),
      submit: (remote) =>
        onDialog({
          title: `Pull from "${remote}"`,
          message: "Branch name on the remote",
          input: snapshot.branch.name,
          confirmLabel: "Pull",
          submit: (branch) => {
            if (!branch.trim()) throw new Error("Enter a branch name.");
            run("pullFrom", () => repo.pullFrom(remote, branch.trim()));
          },
        }),
    });
  }

  function promptDeleteRemoteRef(kind: "branch" | "tag") {
    onDialog({
      title: `Delete remote ${kind}`,
      options: remotePicker(),
      submit: (remote) =>
        onDialog({
          title: `Delete a ${kind} on "${remote}"`,
          message: `${kind === "branch" ? "Branch" : "Tag"} name on the remote`,
          input: "",
          confirmLabel: "Next",
          submit: (name) => {
            if (!name.trim()) throw new Error(`Enter a ${kind} name.`);
            if (
              !window.confirm(
                `Delete ${kind} "${name.trim()}" from "${remote}"? This cannot be undone.`,
              )
            )
              return;
            run("deleteRemoteRef", () => repo.deleteRemoteRef(remote, name.trim()));
          },
        }),
    });
  }

  return items;
}
