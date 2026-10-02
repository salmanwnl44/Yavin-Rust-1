import type { MenuItem } from "../../components/ui/ContextMenu.tsx";
import type { RawCommit } from "./parsers/log.ts";

export interface CommitMenuActions {
  /** Absent where the graph cannot expand a commit (it was given no diff view to open into). */
  open?: () => void;
  copyHash: () => void;
  undoLastCommit: () => void;
  /** Absent where there is no dialog to confirm them in. */
  revert?: () => void;
  cherryPick?: () => void;
  /** Absent until the repository's remote is known to have a web page, or when it has none. */
  openOnRemote?: { label: string; open: () => void };
}

/**
 * The right-click menu of a commit in the graph. Undo Last Commit is offered on the
 * checked-out commit only: it is a soft reset one commit back, which means nothing anywhere
 * else. The items that change history say why they cannot run while another operation is
 * running or one is stopped half-way.
 */
export function buildCommitMenu(
  commit: RawCommit,
  state: { busy: boolean; operationInProgress: string },
  actions: CommitMenuActions,
): MenuItem[] {
  const blocked = state.busy
    ? "Another Git operation is running"
    : state.operationInProgress
      ? `Finish or abort the ${state.operationInProgress} in progress first`
      : undefined;
  const changing = (label: string, onClick: () => void): MenuItem => ({
    label,
    onClick,
    disabled: blocked !== undefined,
    reason: blocked,
  });

  const items: MenuItem[] = [];
  if (actions.open) items.push({ label: "Open", onClick: actions.open });
  items.push({ label: "Copy Commit Hash", onClick: actions.copyHash });

  const history: MenuItem[] = [];
  if (commit.refs.some((ref) => ref.kind === "head"))
    history.push(changing("Undo Last Commit", actions.undoLastCommit));
  if (actions.revert) history.push(changing("Revert Commit…", actions.revert));
  if (actions.cherryPick) history.push(changing("Cherry-pick Commit…", actions.cherryPick));
  if (history.length > 0) items.push({ divider: true }, ...history);

  if (actions.openOnRemote) {
    const { label, open } = actions.openOnRemote;
    items.push({ divider: true }, { label: `Open on ${label}`, onClick: open });
  }
  return items;
}
