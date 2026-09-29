import type { RepoEntry } from "../../services/git/registry";
import { guardedAffecting } from "../../services/git/sync";
import { useRepoSnapshot } from "../../services/git/hooks";
import type { StashEntry } from "../../services/git/parsers/stash";
import type { DialogRequest } from "../ui/AppDialog";
import { ArrowDownIcon, PlusIcon, TrashIcon, UndoIcon } from "../ui/Icons";
import { IconAction, SectionHeader } from "./SectionHeader";

export function StashesSection({
  entry,
  stashes,
  dirty,
  collapsed,
  onToggleCollapse,
  onDialog,
}: {
  entry: RepoEntry | null;
  stashes: StashEntry[];
  dirty: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** Asks for the new stash's message; without it, New Stash is not offered. */
  onDialog?: (request: DialogRequest) => void;
}) {
  // Read before the early return: hooks cannot be called conditionally.
  const snapshot = useRepoSnapshot(entry?.store);
  const busy = snapshot?.busy ?? false;
  const changed = snapshot?.entries.length ?? 0;
  if (!entry) return null;

  const run = (kind: string, op: () => Promise<string>) =>
    void guardedAffecting(entry, kind, dirty, op);

  const drop = (index: number, message: string) => {
    if (!window.confirm(`Drop the stash "${message}"? This cannot be undone.`)) return;
    run("stashDrop", () => entry.store.repository.stashDrop(index));
  };

  /** Stashes the working tree: first what to include, then an optional message. */
  const newStash = () =>
    onDialog?.({
      title: "New stash",
      options: [
        { value: "tracked", label: "Tracked changes" },
        { value: "untracked", label: "Tracked changes and untracked files" },
      ],
      submit: (choice) =>
        onDialog({
          title: "Stash message (optional)",
          input: "",
          confirmLabel: "Stash",
          submit: (message) =>
            run("stash", () =>
              entry.store.repository.stash({
                message: message || undefined,
                untracked: choice === "untracked",
              }),
            ),
        }),
    });

  return (
    <section aria-label="Stashes" className="text-xs flex flex-col min-h-0 border-b border-border">
      <SectionHeader
        title="Stashes"
        count={stashes.length}
        collapsed={collapsed}
        onToggle={onToggleCollapse}
        actions={
          onDialog ? (
            <IconAction
              label="New Stash"
              title={changed ? "Stash the working tree's changes" : "Nothing to stash"}
              disabled={busy || changed === 0}
              onClick={newStash}
            >
              <PlusIcon size={12} />
            </IconAction>
          ) : undefined
        }
      />

      {!collapsed && (
        <div className="overflow-y-auto max-h-[200px] pb-1">
          {stashes.length === 0 ? (
            <p className="px-3 py-1 text-[11px] text-ink-3">No stashed changes.</p>
          ) : (
            stashes.map((stash) => (
              <div
                key={stash.index}
                className="group/stash flex items-center gap-1.5 px-2.5 py-1 hover:bg-surface-hover"
              >
                <span className="truncate flex-1 text-ink-2" title={stash.message}>
                  {stash.message}
                </span>
                {stash.branch && (
                  <span className="shrink-0 text-ink-3 text-[10px] truncate max-w-[70px]">
                    {stash.branch}
                  </span>
                )}
                {/* `focus-within` as well as hover, or tabbing to these buttons landed on
                    something invisible -- the changed-file rows already do both. */}
                <div className="flex items-center gap-0.5 shrink-0 opacity-0 transition-opacity group-hover/stash:opacity-100 focus-within:opacity-100">
                  <button
                    title="Apply Stash"
                    aria-label={`Apply stash ${stash.message}`}
                    // Stash indexes shift as soon as one is applied or dropped, so a second
                    // click before the list refreshes would act on a different stash than
                    // the one it names. `busy` closes that window.
                    disabled={busy}
                    onClick={() =>
                      run("stashApply", () => entry.store.repository.stashApply(stash.index))
                    }
                    className="p-1 rounded text-ink-3 hover:text-ink hover:bg-surface-hover disabled:opacity-40 disabled:hover:text-ink-3"
                  >
                    <ArrowDownIcon size={11} />
                  </button>
                  <button
                    title="Pop Stash (apply and remove)"
                    aria-label={`Pop stash ${stash.message}`}
                    disabled={busy}
                    onClick={() =>
                      run("stashPop", () => entry.store.repository.stashPop(stash.index))
                    }
                    className="p-1 rounded text-ink-3 hover:text-ink hover:bg-surface-hover disabled:opacity-40 disabled:hover:text-ink-3"
                  >
                    <UndoIcon size={11} />
                  </button>
                  <button
                    title="Drop Stash"
                    aria-label={`Drop stash ${stash.message}`}
                    disabled={busy}
                    onClick={() => drop(stash.index, stash.message)}
                    className="p-1 rounded text-ink-3 hover:text-rose-300 hover:bg-surface-hover disabled:opacity-40 disabled:hover:text-ink-3"
                  >
                    <TrashIcon size={11} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}
