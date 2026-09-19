import type { RepoEntry } from "../../services/git/registry";
import { divergence } from "../../services/git/parsers/branch";
import { guardedAffecting } from "../../services/git/sync";

/**
 * The single "sync" action VS Code's repo-row icon performs: fetch when even,
 * fast-forward pull/push toward whichever side is ahead, or hand off to the caller
 * (to reveal the branch drawer's Rebase/Merge choice) when the branch has diverged --
 * the same one case that can't safely resolve with a single click.
 */
export function syncAction(entry: RepoEntry, dirty: boolean) {
  const snapshot = entry.store.getSnapshot();
  const state = divergence(snapshot.branch);
  const repo = entry.store.repository;
  const title =
    state === "diverged"
      ? "Sync changes (diverged — choose Rebase or Merge)"
      : state === "ahead"
        ? `Sync changes (push ${snapshot.branch.ahead})`
        : state === "behind"
          ? `Sync changes (pull ${snapshot.branch.behind})`
          : "Sync changes (fetch)";

  const run = (onDiverged: () => void) => {
    if (state === "diverged") {
      entry.store.setNotice(
        `Your branch and its upstream have diverged (${snapshot.branch.ahead} local and ${snapshot.branch.behind} remote commits). Choose Rebase or Merge to reconcile them.`,
      );
      onDiverged();
      return;
    }
    if (state === "ahead") void guardedAffecting(entry, "push", dirty, () => repo.push());
    else if (state === "behind") void guardedAffecting(entry, "pull", dirty, () => repo.pull());
    else void guardedAffecting(entry, "fetch", dirty, () => repo.fetch());
  };

  return { title, run, state };
}
