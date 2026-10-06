import { useEffect, useSyncExternalStore } from "react";
import type { ExtensionHost } from "../../services/extensions/host";
import type { ExtensionRegistry } from "../../services/extensions/registry";
import type { KeybindingConflict } from "../../services/extensions/contributions";

const STATE_LABEL: Record<string, string> = {
  registered: "Not activated",
  activating: "Activating",
  active: "Active",
  failed: "Failed",
  deactivating: "Deactivating",
  disposed: "Ended",
};

/**
 * The Extensions view (IDE-07): which extensions Yavin knows, what each is doing in this
 * workspace and why, the manifests it could not use, and the side-bar views extensions
 * contribute. A view of the registry and the workspace's host; enabling, disabling and running
 * a view's commands go through them.
 */
export function ExtensionsPanel({
  registry,
  host,
  visible,
  conflicts,
  onRunCommand,
  onReload,
}: {
  registry: ExtensionRegistry;
  host: ExtensionHost;
  visible: boolean;
  conflicts: readonly KeybindingConflict[];
  onRunCommand: (command: string) => void;
  onReload: () => void;
}) {
  const known = useSyncExternalStore(
    registry.subscribe,
    registry.getSnapshot,
    registry.getSnapshot,
  );
  const running = useSyncExternalStore(host.subscribe, host.getSnapshot, host.getSnapshot);
  const sidebarViews = known.views.filter((view) => view.location === "sidebar");
  const viewKey = sidebarViews.map((view) => view.id).join(",");
  // A contributed view being shown activates its extension (once).
  useEffect(() => {
    if (!visible) return;
    for (const view of sidebarViews) void host.showView(view.id).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, viewKey, host]);
  const titleOf = (command: string) =>
    known.commands.find((one) => one.command === command)?.title ?? command;

  return (
    <aside
      hidden={!visible}
      aria-label="Extensions"
      className="flex w-[280px] shrink-0 flex-col border-r border-[#141414] bg-black text-[12px] text-zinc-300"
    >
      <div className="flex h-9 items-center justify-between border-b border-[#101010] px-3">
        <span className="text-[11px] font-semibold tracking-wider uppercase">Extensions</span>
        <button onClick={onReload} className="text-[11px] text-zinc-500 hover:text-zinc-200">
          Reload
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {sidebarViews.map((view) => {
          const rows = running.views[view.id];
          return (
            <section
              key={view.id}
              aria-label={view.name}
              className="border-b border-[#101010] px-2 py-1.5"
            >
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
                      {titleOf(command)}
                    </button>
                  ))}
                </div>
              </div>
              {!rows && (
                <p className="px-1 text-[11px] text-zinc-600">
                  {running.statuses[view.extensionId]?.reason ?? "Loading…"}
                </p>
              )}
              {rows?.map((row, index) => (
                <button
                  key={`${row.label}:${index}`}
                  disabled={!row.command}
                  onClick={() => row.command && onRunCommand(row.command)}
                  className="flex w-full gap-2 rounded px-1 py-0.5 text-left hover:bg-[#0c0c0c] disabled:hover:bg-transparent"
                >
                  <span className="min-w-0 flex-1 truncate">{row.label}</span>
                  {row.description && (
                    <span className="shrink-0 text-[10px] text-zinc-500">{row.description}</span>
                  )}
                </button>
              ))}
            </section>
          );
        })}

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
                  {extension.id} · {extension.manifest.version} ·{" "}
                  {extension.source.kind === "bundled" ? "bundled" : "installed"}
                  {extension.manifest.main ? "" : " · declarative"}
                </div>
                <div data-testid="extension-state" className="text-[10px] text-zinc-400">
                  {!extension.enabled ? "Disabled" : STATE_LABEL[status?.state ?? "registered"]}
                  {status?.reason ? ` — ${status.reason}` : ""}
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
