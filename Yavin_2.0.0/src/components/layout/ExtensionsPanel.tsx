import { useEffect, useState, useSyncExternalStore } from "react";
import type { ExtensionHostManager } from "../../services/extensions/manager";
import type { ExtensionRegistry, ContributedView } from "../../services/extensions/registry";
import type { KeybindingConflict } from "../../services/extensions/contributions";
import type { ViewRow } from "../../services/extensions/host";

const STATE_LABEL: Record<string, string> = {
  registered: "Not activated",
  activating: "Activating",
  active: "Active",
  failed: "Failed",
  deactivating: "Deactivating",
  disposed: "Ended",
};
const HOST_LABEL: Record<string, string> = {
  idle: "not started (starts when an extension activates)",
  starting: "starting",
  running: "running",
  crashed: "crashed",
  stopped: "stopped",
};

function useManager(manager: ExtensionHostManager) {
  return useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot);
}

/** One row of an extension's view, and its children (declarative: no extension markup). */
function Row({
  row,
  depth,
  onRunCommand,
}: {
  row: ViewRow;
  depth: number;
  onRunCommand: (command: string) => void;
}) {
  const [open, setOpen] = useState(depth === 0);
  const parent = !!row.children?.length;
  return (
    <div role="treeitem" aria-label={row.label} aria-expanded={parent ? open : undefined}>
      <button
        title={row.tooltip}
        onClick={() => (parent ? setOpen(!open) : row.command && onRunCommand(row.command))}
        style={{ paddingLeft: depth * 12 + 4 }}
        className="flex w-full gap-1.5 rounded py-0.5 pr-1 text-left hover:bg-[#0c0c0c]"
      >
        <span className="w-3 shrink-0 text-zinc-600">{parent ? (open ? "▾" : "▸") : ""}</span>
        <span className="min-w-0 flex-1 truncate">{row.label}</span>
        {row.description && (
          <span className="shrink-0 text-[10px] text-zinc-500">{row.description}</span>
        )}
      </button>
      {parent &&
        open &&
        row.children!.map((child, index) => (
          <Row
            key={`${child.label}:${index}`}
            row={child}
            depth={depth + 1}
            onRunCommand={onRunCommand}
          />
        ))}
    </div>
  );
}

/**
 * A contributed view: its rows as the extension supplied them, its `view/title` actions. Being
 * shown activates its extension (once) and asks for its rows; nothing else of the extension is
 * rendered.
 */
export function ExtensionViewSection({
  view,
  manager,
  visible,
  actionTitle,
  onRunCommand,
}: {
  view: ContributedView;
  manager: ExtensionHostManager;
  visible: boolean;
  actionTitle: (command: string) => string;
  onRunCommand: (command: string) => void;
}) {
  const snapshot = useManager(manager);
  useEffect(() => {
    if (!visible) return;
    void manager.showView(view.id).catch(() => undefined);
    return () => manager.hideView(view.id);
  }, [visible, view.id, manager]);
  const rows = snapshot.views[view.id];
  const status = snapshot.statuses[view.extensionId];
  return (
    <section aria-label={view.name} className="border-b border-[#101010] px-2 py-1.5">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
          {view.name}
        </h2>
        <div className="flex gap-1">
          {view.actions.map((command) => (
            <button
              key={command}
              onClick={() => onRunCommand(command)}
              className="text-[10px] text-zinc-500 hover:text-zinc-200"
            >
              {actionTitle(command)}
            </button>
          ))}
        </div>
      </div>
      {!rows && (
        <p className="px-1 text-[11px] text-zinc-600">
          {status?.reason ?? snapshot.held ?? "Loading…"}
        </p>
      )}
      <div role="tree" aria-label={`${view.name} items`}>
        {rows?.map((row, index) => (
          <Row key={`${row.label}:${index}`} row={row} depth={0} onRunCommand={onRunCommand} />
        ))}
      </div>
    </section>
  );
}

/** An extension's own Activity Bar container: its views. */
export function ExtensionContainerPanel({
  registry,
  manager,
  containerId,
  visible,
  onRunCommand,
}: {
  registry: ExtensionRegistry;
  manager: ExtensionHostManager;
  containerId: string;
  visible: boolean;
  onRunCommand: (command: string) => void;
}) {
  const known = useSyncExternalStore(
    registry.subscribe,
    registry.getSnapshot,
    registry.getSnapshot,
  );
  const container = known.viewContainers.find((one) => one.id === containerId);
  const views = known.views.filter(
    (view) => view.location === "container" && view.container === containerId,
  );
  const titleOf = (command: string) =>
    known.commands.find((one) => one.command === command)?.title ?? command;
  return (
    <aside
      hidden={!visible}
      aria-label={container?.title ?? containerId}
      className="flex w-[280px] shrink-0 flex-col border-r border-[#141414] bg-black text-[12px] text-zinc-300"
    >
      <div className="flex h-9 items-center border-b border-[#101010] px-3">
        <span className="text-[11px] font-semibold tracking-wider uppercase">
          {container?.title ?? containerId}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {views.map((view) => (
          <ExtensionViewSection
            key={view.id}
            view={view}
            manager={manager}
            visible={visible}
            actionTitle={titleOf}
            onRunCommand={onRunCommand}
          />
        ))}
      </div>
    </aside>
  );
}

/**
 * The Extensions view (IDE-07/08): the extension host of this workspace (its state and
 * generation, Restart, Reload), each extension and what it is doing here and why, the manifests
 * that could not be used, and the side-bar views extensions contribute.
 */
export function ExtensionsPanel({
  registry,
  manager,
  visible,
  conflicts,
  onRunCommand,
}: {
  registry: ExtensionRegistry;
  manager: ExtensionHostManager;
  visible: boolean;
  conflicts: readonly KeybindingConflict[];
  onRunCommand: (command: string) => void;
}) {
  const known = useSyncExternalStore(
    registry.subscribe,
    registry.getSnapshot,
    registry.getSnapshot,
  );
  const running = useManager(manager);
  const sidebarViews = known.views.filter((view) => view.location === "sidebar");
  const titleOf = (command: string) =>
    known.commands.find((one) => one.command === command)?.title ?? command;

  return (
    <aside
      hidden={!visible}
      aria-label="Extensions"
      className="flex w-[280px] shrink-0 flex-col border-r border-[#141414] bg-black text-[12px] text-zinc-300"
    >
      <div className="flex h-9 items-center justify-between gap-2 border-b border-[#101010] px-3">
        <span className="text-[11px] font-semibold tracking-wider uppercase">Extensions</span>
        <div className="flex gap-2">
          <button
            onClick={() => void manager.restart()}
            className="text-[11px] text-zinc-500 hover:text-zinc-200"
          >
            Restart
          </button>
          <button
            onClick={() => void manager.reload()}
            className="text-[11px] text-zinc-500 hover:text-zinc-200"
          >
            Reload
          </button>
        </div>
      </div>
      <p
        data-testid="extension-host"
        className="border-b border-[#101010] px-3 py-1 text-[10px] text-zinc-500"
      >
        Host {HOST_LABEL[running.host] ?? running.host} · generation {running.generation}
        {running.crashes ? ` · ${running.crashes} crash${running.crashes > 1 ? "es" : ""}` : ""}
        {running.held
          ? ` — ${running.held}`
          : running.host === "crashed" && running.hostReason
            ? ` — ${running.hostReason}`
            : ""}
      </p>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {sidebarViews.map((view) => (
          <ExtensionViewSection
            key={view.id}
            view={view}
            manager={manager}
            visible={visible}
            actionTitle={titleOf}
            onRunCommand={onRunCommand}
          />
        ))}

        <section aria-label="Installed" className="px-2 py-1.5">
          <h2 className="px-1 py-1 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
            Installed
          </h2>
          {!known.extensions.length && (
            <p className="px-1 text-[11px] text-zinc-600">
              No extensions. Yavin reads extensions from its own data folder
              (extensions/&lt;name&gt;/yavin-extension.json); there is no marketplace yet.
            </p>
          )}
          {known.extensions.map((extension) => {
            const status = running.statuses[extension.id];
            const unavailable = known.unavailable[extension.id];
            const own = conflicts.filter((conflict) => conflict.extensionId === extension.id);
            return (
              <div
                key={extension.id}
                role="group"
                aria-label={extension.manifest.displayName}
                className="rounded px-1 py-1 hover:bg-[#0c0c0c]"
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-zinc-100">
                    {extension.manifest.displayName}
                  </span>
                  <label className="flex items-center gap-1 text-[10px] text-zinc-500">
                    <input
                      type="checkbox"
                      aria-label={`Enable ${extension.manifest.displayName}`}
                      checked={extension.enabled}
                      onChange={(event) => registry.setEnabled(extension.id, event.target.checked)}
                    />
                    Enabled
                  </label>
                </div>
                <div className="text-[10px] text-zinc-600">
                  {extension.id} · {extension.manifest.version}
                  {extension.manifest.main ? "" : " · declarative"}
                  {extension.manifest.dependencies.length
                    ? ` · needs ${extension.manifest.dependencies.join(", ")}`
                    : ""}
                </div>
                <div data-testid="extension-state" className="text-[10px] text-zinc-400">
                  {!extension.enabled
                    ? "Disabled"
                    : unavailable
                      ? `Unavailable — ${unavailable}`
                      : STATE_LABEL[status?.state ?? "registered"]}
                  {extension.enabled && !unavailable && status?.reason
                    ? ` — ${status.reason}`
                    : // Held off (not trusted, crashed repeatedly): why, for code that would run.
                      extension.enabled &&
                        !unavailable &&
                        extension.manifest.main &&
                        running.held &&
                        status?.state !== "active"
                      ? ` — ${running.held}`
                      : ""}
                </div>
                {[
                  ...extension.warnings,
                  ...own.map((c) => `Shortcut ${c.key} not used: ${c.reason}`),
                ].map((warning) => (
                  <div key={warning} className="text-[10px] text-amber-300/80">
                    {warning}
                  </div>
                ))}
              </div>
            );
          })}
        </section>

        {known.rejected.length > 0 && (
          <section aria-label="Not loaded" className="px-2 py-1.5">
            <h2 className="px-1 py-1 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
              Not loaded
            </h2>
            {known.rejected.map((one, index) => (
              <div
                key={`${one.origin}:${index}`}
                role="group"
                aria-label={`Not loaded: ${one.id ?? one.origin}`}
                className="px-1 py-1"
              >
                <div className="truncate text-zinc-300">{one.id ?? one.origin}</div>
                {one.problems.map((problem) => (
                  <div key={problem} className="text-[10px] text-red-400/90">
                    {problem}
                  </div>
                ))}
              </div>
            ))}
          </section>
        )}
      </div>
    </aside>
  );
}
