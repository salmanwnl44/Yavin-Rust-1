import type { RepoEntry } from "../../services/git/registry";
import { guardedAffecting } from "../../services/git/sync";
import type { StashEntry } from "../../services/git/parsers/stash";
import { ChevronIcon } from "../ui/FileIcons";
import { ArrowDownIcon, TrashIcon, UndoIcon } from "../ui/Icons";

export function StashesSection({
  entry,
  stashes,
  dirty,
  collapsed,
  onToggleCollapse,
}: {
  entry: RepoEntry | null;
  stashes: StashEntry[];
  dirty: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  if (!entry) return null;

  const run = (kind: string, op: () => Promise<string>) =>
    void guardedAffecting(entry, kind, dirty, op);

  const drop = (index: number, message: string) => {
    if (!window.confirm(`Drop the stash "${message}"? This cannot be undone.`)) return;
    run("stashDrop", () => entry.store.repository.stashDrop(index));
  };

  return (
    <section aria-label="Stashes" className="text-xs flex flex-col min-h-0 border-b border-border">
      <div
        onClick={onToggleCollapse}
        className="flex items-center gap-1.5 px-2.5 py-1.5 cursor-pointer hover:bg-surface-hover transition-colors shrink-0"
      >
        <ChevronIcon isExpanded={!collapsed} className="size-3" />
        <span className="font-semibold text-[11px] uppercase tracking-wider text-ink-2">
          Stashes
        </span>
        {stashes.length > 0 && (
          <span className="text-ink-3 text-[10px] font-mono">{stashes.length}</span>
        )}
      </div>

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
                <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover/stash:opacity-100 transition-opacity">
                  <button
                    title="Apply Stash"
                    aria-label={`Apply stash ${stash.message}`}
                    onClick={() =>
                      run("stashApply", () => entry.store.repository.stashApply(stash.index))
                    }
                    className="p-1 rounded text-ink-3 hover:text-ink hover:bg-surface-hover"
                  >
                    <ArrowDownIcon size={11} />
                  </button>
                  <button
                    title="Pop Stash (apply and remove)"
                    aria-label={`Pop stash ${stash.message}`}
                    onClick={() =>
                      run("stashPop", () => entry.store.repository.stashPop(stash.index))
                    }
                    className="p-1 rounded text-ink-3 hover:text-ink hover:bg-surface-hover"
                  >
                    <UndoIcon size={11} />
                  </button>
                  <button
                    title="Drop Stash"
                    aria-label={`Drop stash ${stash.message}`}
                    onClick={() => drop(stash.index, stash.message)}
                    className="p-1 rounded text-ink-3 hover:text-rose-300 hover:bg-surface-hover"
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
