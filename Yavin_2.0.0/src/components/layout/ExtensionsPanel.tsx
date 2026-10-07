import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ExtensionHostManager } from "../../services/extensions/manager";
import type {
  ExtensionRegistry,
  ContributedView,
  RegisteredExtension,
} from "../../services/extensions/registry";
import type { ExtensionInstaller } from "../../services/extensions/marketplace/installer";
import { createSearchController } from "../../services/extensions/marketplace/search";
import type { ExtensionMarketplaceService } from "../../services/extensions/marketplace/service";
import type {
  ExtensionCategory,
  MarketplaceError,
  MarketplaceExtension,
} from "../../services/extensions/marketplace/types";
import { CardButton, ExtensionCard } from "../extensions/ExtensionCard";
import { statusOf, useExtensionsState, useStore } from "../extensions/model";
import { ContextMenu, type MenuItem } from "../ui/ContextMenu";
import { CloseIcon, FilterIcon, MoreIcon, RefreshIcon, SearchIcon } from "../ui/Icons";
import type { KeybindingConflict } from "../../services/extensions/contributions";
import type { ViewRow } from "../../services/extensions/host";

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

/** Which list the Extensions view shows. */
export type ExtensionsListView = "all" | "installed" | "updates" | "recommended";

/** A request from elsewhere in the window (the command palette) to the Extensions view. */
export interface ExtensionsViewCommand {
  kind: "search" | "installed" | "recommended" | "updates" | "checkUpdates";
  nonce: number;
}

const VIEW_LABEL: Record<ExtensionsListView, string> = {
  all: "All",
  installed: "Installed",
  updates: "Updates",
  recommended: "Recommended",
};

function SectionHeader({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
      <h2 className="text-[10.5px] font-semibold tracking-wider text-zinc-500 uppercase">
        {title}
      </h2>
      <div className="flex items-center gap-2">
        {children}
        {count !== undefined && (
          <span
            aria-label={`${count} ${title.toLowerCase()}`}
            className="rounded-full bg-zinc-800 px-1.5 text-[10px] text-zinc-300"
          >
            {count}
          </span>
        )}
      </div>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="px-3 py-1.5 text-[11.5px] text-zinc-500">{children}</p>;
}

/**
 * The Extensions view (IDE-07/08/09): the marketplace -- search, filters, installed and
 * recommended extensions as cards, Install / Update / Enable / Disable / Uninstall -- with the
 * views extensions contribute below. Installed extensions are the ExtensionRegistry's (never a
 * list kept here); runtime internals (the host, its generation) are under Runtime diagnostics.
 * Browsing runs no extension code.
 */
export function ExtensionsPanel({
  registry,
  manager,
  marketplace,
  installer,
  visible,
  trusted,
  showRecommendations,
  conflicts,
  command,
  onRunCommand,
  onOpenDetails,
  onUninstall,
}: {
  registry: ExtensionRegistry;
  manager: ExtensionHostManager;
  marketplace: ExtensionMarketplaceService;
  installer: ExtensionInstaller;
  visible: boolean;
  trusted: boolean;
  showRecommendations: boolean;
  conflicts: readonly KeybindingConflict[];
  command: ExtensionsViewCommand | null;
  onRunCommand: (command: string) => void;
  onOpenDetails: (id: string) => void;
  onUninstall: (id: string) => void;
}) {
  const state = useExtensionsState({ registry, manager, marketplace, installer });
  const { registry: known, runtime: running, market, operations } = state;
  const search = useMemo(
    () => createSearchController((request, signal) => marketplace.search(request, signal)),
    [marketplace],
  );
  useEffect(() => () => search.cancel(), [search]);
  const results = useStore(search);
  const [view, setView] = useState<ExtensionsListView>("all");
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    items: MenuItem[];
    label: string;
  } | null>(null);
  const [diagnostics, setDiagnostics] = useState(false);
  const [categories, setCategories] = useState<{
    status: "idle" | "loading" | "loaded" | "error";
    items: ExtensionCategory[];
  }>({ status: "idle", items: [] });
  const [recommended, setRecommended] = useState<{
    status: "idle" | "loading" | "loaded" | "error";
    items: MarketplaceExtension[];
    error: string | null;
  }>({ status: "idle", items: [], error: null });
  const [attempt, setAttempt] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const installed = useMemo(
    () =>
      [...known.extensions].sort((a, b) =>
        a.manifest.displayName.localeCompare(b.manifest.displayName),
      ),
    [known.extensions],
  );
  const installedKey = installed.map((one) => one.id).join(",");
  const text = results.query.query.trim().toLowerCase();
  const searching = view === "all" && search.active;
  const sidebarViews = known.views.filter((one) => one.location === "sidebar");
  const titleOf = (id: string) => known.commands.find((one) => one.command === id)?.title ?? id;

  // A new marketplace (Settings changed) or Refresh: search again.
  useEffect(() => {
    search.rerun();
    setCategories({ status: "idle", items: [] });
  }, [market.providerId, search, attempt]);

  // Recommendations: from the marketplace, without what is installed.
  const wantsRecommendations =
    visible && showRecommendations && (view === "recommended" || (view === "all" && !searching));
  useEffect(() => {
    if (!wantsRecommendations) return;
    const controller = new AbortController();
    setRecommended((r) => ({ ...r, status: "loading", error: null }));
    marketplace
      .getRecommendations(installedKey ? installedKey.split(",") : [], controller.signal)
      .then(
        (items) => setRecommended({ status: "loaded", items, error: null }),
        (error: unknown) => {
          if (controller.signal.aborted || (error as MarketplaceError).code === "Cancelled") return;
          setRecommended({ status: "error", items: [], error: (error as Error).message });
        },
      );
    return () => controller.abort();
  }, [wantsRecommendations, installedKey, marketplace, market.providerId, attempt]);

  const checkUpdates = () =>
    void marketplace
      .checkForUpdates(installed.map((one) => ({ id: one.id, version: one.manifest.version })))
      .catch(() => undefined);

  // The command palette steering the view.
  const nonce = command?.nonce;
  useEffect(() => {
    if (!command) return;
    if (command.kind === "search") {
      setView("all");
      requestAnimationFrame(() => input.current?.focus());
    } else if (command.kind === "checkUpdates") {
      setView("updates");
      checkUpdates();
    } else setView(command.kind);
    // Only a new request (its nonce) acts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);

  const loadCategories = () => {
    if (categories.status === "loading" || categories.status === "loaded") return;
    setCategories({ status: "loading", items: [] });
    marketplace.getCategories().then(
      (items) => setCategories({ status: "loaded", items }),
      () => setCategories({ status: "error", items: [] }),
    );
  };

  const run = (promise: Promise<unknown>) => void promise.catch(() => undefined);
  const openMenu = (label: string, x: number, y: number, items: MenuItem[]) =>
    setMenu({ label, x, y, items });

  const filterMenu = (x: number, y: number) => {
    loadCategories();
    const items: MenuItem[] = [
      ...(["all", "installed", "updates", "recommended"] as const).map((one) => ({
        label: VIEW_LABEL[one],
        checked: view === one,
        onClick: () => setView(one),
      })),
      { divider: true },
      {
        label: "Compatible only",
        checked: results.query.compatibleOnly,
        onClick: () => search.setFilters({ compatibleOnly: !results.query.compatibleOnly }),
      },
      { divider: true },
      ...(categories.status === "loaded"
        ? [
            {
              label: "Any category",
              checked: results.query.category === null,
              onClick: () => search.setFilters({ category: null }),
            },
            ...categories.items.map((c) => ({
              label: c.label,
              checked: results.query.category === c.id,
              onClick: () => {
                setView("all");
                search.setFilters({ category: c.id });
              },
            })),
          ]
        : [
            {
              label:
                categories.status === "error"
                  ? "Categories unavailable"
                  : "Loading categories… (open again)",
              disabled: true,
            },
          ]),
    ];
    openMenu("Filter extensions", x, y, items);
  };

  const moreMenu = (x: number, y: number) =>
    openMenu("More actions", x, y, [
      { label: "Check for Updates", onClick: () => (setView("updates"), checkUpdates()) },
      { label: "Reload Extensions", onClick: () => run(manager.reload()) },
      { label: "Restart Extension Host", onClick: () => run(manager.restart()) },
      { divider: true },
      {
        label: "Show Runtime Diagnostics",
        checked: diagnostics,
        onClick: () => setDiagnostics(!diagnostics),
      },
    ]);

  const cardMenu = (id: string, name: string, x: number, y: number) => {
    const entry = registry.get(id);
    const update = market.updates[id];
    const busy = !!operations.operations[id];
    const items: MenuItem[] = [{ label: "View Extension", onClick: () => onOpenDetails(id) }];
    if (entry) {
      items.push({
        label: entry.enabled ? "Disable" : "Enable",
        disabled: busy,
        onClick: () => registry.setEnabled(id, !entry.enabled),
      });
      if (update)
        items.push({
          label: `Update to ${update.available}`,
          disabled: busy,
          onClick: () => run(installer.update(id)),
        });
      if (installer.removable(entry))
        items.push({
          label: "Uninstall",
          danger: true,
          disabled: busy,
          onClick: () => onUninstall(id),
        });
    } else
      items.push({ label: "Install", disabled: busy, onClick: () => run(installer.install(id)) });
    items.push(
      { divider: true },
      {
        label: "Copy Extension ID",
        onClick: () => void navigator.clipboard?.writeText(id).catch(() => undefined),
      },
    );
    openMenu(`Actions for ${name}`, x, y, items);
  };

  const failureOf = (id: string) => {
    const failure = operations.failures[id];
    return failure ? { message: failure.message, detail: failure.detail } : null;
  };

  /** An installed extension's card. */
  const installedCard = (entry: RegisteredExtension) => {
    const name = entry.manifest.displayName;
    const update = market.updates[entry.id];
    const busy = !!operations.operations[entry.id];
    const warnings = [
      ...entry.warnings,
      ...conflicts
        .filter((c) => c.extensionId === entry.id)
        .map((c) => `Shortcut ${c.key} not used: ${c.reason}`),
    ];
    return (
      <div key={entry.id}>
        <ExtensionCard
          model={{
            id: entry.id,
            displayName: name,
            description: entry.manifest.description ?? "",
            publisher: entry.manifest.publisher,
            version: entry.manifest.version,
            status: statusOf(entry.id, state, trusted, marketplace),
            failure: failureOf(entry.id),
          }}
          marketplace={marketplace}
          onOpen={() => onOpenDetails(entry.id)}
          onContextMenu={(x, y) => cardMenu(entry.id, name, x, y)}
          onDismissFailure={() => installer.dismiss(entry.id)}
          actions={
            <>
              {update && (
                <CardButton
                  primary
                  label={`Update ${name}`}
                  disabled={busy}
                  onClick={() => run(installer.update(entry.id))}
                >
                  Update
                </CardButton>
              )}
              <CardButton
                label={entry.enabled ? `Disable ${name}` : `Enable ${name}`}
                disabled={busy}
                onClick={() => registry.setEnabled(entry.id, !entry.enabled)}
              >
                {entry.enabled ? "Disable" : "Enable"}
              </CardButton>
              <button
                type="button"
                aria-label={`Manage ${name}`}
                title="Manage"
                onClick={(event) => {
                  const box = event.currentTarget.getBoundingClientRect();
                  cardMenu(entry.id, name, box.left, box.bottom + 2);
                }}
                className="rounded p-0.5 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
              >
                <MoreIcon size={14} />
              </button>
            </>
          }
        />
        {diagnostics &&
          warnings.map((warning) => (
            <div key={warning} className="px-12 pb-1 text-[10px] text-amber-300/80">
              {warning}
            </div>
          ))}
      </div>
    );
  };

  /** A marketplace listing's card (installed ones show as installed). */
  const listingCard = (extension: MarketplaceExtension) => {
    const entry = registry.get(extension.id);
    if (entry) return installedCard(entry);
    const name = extension.displayName;
    const operation = operations.operations[extension.id];
    const latest = marketplace.latestCompatible(extension);
    const why = latest ? undefined : marketplace.compatibility(extension).reasons[0];
    const busyLabel =
      operation?.phase === "downloading"
        ? "Downloading…"
        : operation?.phase === "verifying"
          ? "Verifying…"
          : "Installing…";
    return (
      <ExtensionCard
        key={extension.id}
        model={{
          id: extension.id,
          displayName: name,
          description: extension.description,
          publisher: extension.publisherDisplayName ?? extension.publisher,
          version: extension.version,
          status: statusOf(extension.id, state, trusted, marketplace, extension),
          failure: failureOf(extension.id),
        }}
        marketplace={marketplace}
        onOpen={() => onOpenDetails(extension.id)}
        onContextMenu={(x, y) => cardMenu(extension.id, name, x, y)}
        onDismissFailure={() => installer.dismiss(extension.id)}
        actions={
          <CardButton
            primary
            label={`Install ${name}`}
            disabled={!!operation || !latest}
            title={why ?? `Install ${name}`}
            onClick={() => run(installer.install(extension.id))}
          >
            {operation ? busyLabel : "Install"}
          </CardButton>
        }
      />
    );
  };

  const matchesText = (entry: RegisteredExtension) =>
    !text ||
    entry.id.includes(text) ||
    entry.manifest.displayName.toLowerCase().includes(text) ||
    (entry.manifest.description ?? "").toLowerCase().includes(text);
  const installedShown = installed.filter(matchesText);
  // An extension being updated stays listed until its update is done.
  const updatesShown = installed.filter(
    (one) =>
      (market.updates[one.id] || operations.operations[one.id]?.kind === "update") &&
      matchesText(one),
  );
  const unavailable = (message: string | null, retry: () => void) => (
    <div
      role="alert"
      className="mx-3 my-1.5 rounded border border-zinc-800 bg-[#0b0b0b] px-2.5 py-2 text-[11.5px] text-zinc-400"
    >
      <div>{message ?? "The extension marketplace is unavailable."}</div>
      <button onClick={retry} className="mt-1 text-indigo-400 hover:text-indigo-300">
        Retry
      </button>
    </div>
  );
  const filtered = view !== "all" || !!results.query.category || results.query.compatibleOnly;

  return (
    <aside
      hidden={!visible}
      aria-label="Extensions"
      className="flex w-[300px] shrink-0 flex-col border-r border-[#141414] bg-black text-[12px] text-zinc-300"
    >
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 px-3">
        <span className="text-[11px] font-semibold tracking-wider uppercase">Extensions</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Refresh marketplace"
            title="Refresh marketplace"
            onClick={() => {
              marketplace.refresh();
              setAttempt((n) => n + 1);
            }}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
          >
            <RefreshIcon size={14} />
          </button>
          <button
            type="button"
            aria-label="More actions"
            title="More actions"
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              moreMenu(box.left, box.bottom + 2);
            }}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
          >
            <MoreIcon size={14} />
          </button>
        </div>
      </div>
      <div className="shrink-0 px-3 pb-2">
        <div className="flex items-center gap-1 rounded border border-zinc-800 bg-[#0b0b0b] px-2 focus-within:border-indigo-500/70">
          <SearchIcon size={13} className="shrink-0 text-zinc-500" />
          <input
            ref={input}
            type="search"
            aria-label="Search extensions"
            placeholder={`Search ${market.providerLabel}`}
            value={results.query.query}
            onChange={(event) => search.setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && results.query.query) {
                event.stopPropagation();
                search.clear();
              }
            }}
            className="min-w-0 flex-1 bg-transparent py-1 text-[12px] text-zinc-100 outline-none placeholder:text-zinc-600 [&::-webkit-search-cancel-button]:hidden"
          />
          {results.status === "loading" && (
            <span
              role="status"
              aria-label="Searching"
              className="size-3 shrink-0 animate-spin rounded-full border border-zinc-600 border-t-zinc-200"
            />
          )}
          {results.query.query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => search.clear()}
              className="text-zinc-500 hover:text-zinc-200"
            >
              <CloseIcon size={12} />
            </button>
          )}
          <button
            type="button"
            aria-label="Filter extensions"
            title="Filter"
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              filterMenu(box.left, box.bottom + 2);
            }}
            className={`rounded p-0.5 hover:bg-zinc-900 ${filtered ? "text-indigo-400" : "text-zinc-500 hover:text-zinc-200"}`}
          >
            <FilterIcon size={13} />
          </button>
        </div>
        {filtered && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {view !== "all" && (
              <button
                aria-label={`Remove filter ${VIEW_LABEL[view]}`}
                onClick={() => setView("all")}
                className="rounded bg-zinc-800 px-1.5 text-[10.5px] text-zinc-300 hover:bg-zinc-700"
              >
                {VIEW_LABEL[view]} ×
              </button>
            )}
            {results.query.category && (
              <button
                aria-label="Remove category filter"
                onClick={() => search.setFilters({ category: null })}
                className="rounded bg-zinc-800 px-1.5 text-[10.5px] text-zinc-300 hover:bg-zinc-700"
              >
                {categories.items.find((c) => c.id === results.query.category)?.label ??
                  results.query.category}{" "}
                ×
              </button>
            )}
            {results.query.compatibleOnly && (
              <button
                aria-label="Remove filter Compatible only"
                onClick={() => search.setFilters({ compatibleOnly: false })}
                className="rounded bg-zinc-800 px-1.5 text-[10.5px] text-zinc-300 hover:bg-zinc-700"
              >
                Compatible only ×
              </button>
            )}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {(view === "all" || view === "installed") && (!searching || installedShown.length > 0) && (
          <section aria-label="Installed extensions">
            <SectionHeader title="Installed" count={installedShown.length} />
            {installedShown.length ? (
              installedShown.map(installedCard)
            ) : (
              <Note>
                {text
                  ? "No installed extension matches."
                  : "No extensions installed yet. Search the marketplace above."}
              </Note>
            )}
          </section>
        )}

        {view === "updates" && (
          <section aria-label="Updates">
            <SectionHeader title="Updates" count={updatesShown.length}>
              <button
                onClick={checkUpdates}
                className="text-[10.5px] text-indigo-400 hover:text-indigo-300"
              >
                Check now
              </button>
            </SectionHeader>
            {market.updateError ? (
              unavailable(market.updateError, checkUpdates)
            ) : updatesShown.length ? (
              updatesShown.map(installedCard)
            ) : (
              <Note>
                {market.checkedAt ? "All installed extensions are up to date." : "Not checked yet."}
              </Note>
            )}
          </section>
        )}

        {searching && (
          <section aria-label="Marketplace results">
            <SectionHeader
              title={market.providerLabel}
              count={results.status === "loaded" ? results.total : undefined}
            />
            {results.status === "loading" && <Note>Searching…</Note>}
            {results.status === "error" &&
              unavailable(results.error?.message ?? null, () => search.retry())}
            {results.status === "loaded" && results.items.length === 0 && (
              <div className="px-3 py-1.5 text-[11.5px] text-zinc-500">
                No extensions match
                {results.query.query ? ` “${results.query.query}”` : " this filter"}.{" "}
                <button
                  onClick={() => search.clear()}
                  className="text-indigo-400 hover:text-indigo-300"
                >
                  Clear search
                </button>
              </div>
            )}
            {results.items.map(listingCard)}
            {results.status === "loaded" && results.items.length < results.total && (
              <button
                onClick={() => search.loadMore()}
                disabled={results.loadingMore}
                className="mx-3 mt-1 text-[11.5px] text-indigo-400 hover:text-indigo-300 disabled:text-zinc-600"
              >
                {results.loadingMore
                  ? "Loading…"
                  : `Show more (${results.total - results.items.length})`}
              </button>
            )}
          </section>
        )}

        {wantsRecommendations && (
          <section aria-label="Recommended extensions">
            <SectionHeader
              title="Recommended"
              count={recommended.status === "loaded" ? recommended.items.length : undefined}
            />
            {recommended.status === "loading" && <Note>Loading…</Note>}
            {recommended.status === "error" &&
              unavailable(recommended.error, () => setAttempt((n) => n + 1))}
            {recommended.status === "loaded" && !recommended.items.length && (
              <Note>Nothing to recommend right now.</Note>
            )}
            {recommended.items.map(listingCard)}
          </section>
        )}

        {view === "all" && !searching && sidebarViews.length > 0 && (
          <section aria-label="Extension views" className="mt-2 border-t border-[#141414]">
            {sidebarViews.map((one) => (
              <ExtensionViewSection
                key={one.id}
                view={one}
                manager={manager}
                visible={visible}
                actionTitle={titleOf}
                onRunCommand={onRunCommand}
              />
            ))}
          </section>
        )}

        {known.rejected.length > 0 && view !== "recommended" && (
          <section aria-label="Not loaded" className="mt-2 px-2">
            <SectionHeader title="Not loaded" count={known.rejected.length} />
            {known.rejected.map((one, index) => (
              <div
                key={`${one.origin}:${index}`}
                role="group"
                aria-label={`Not loaded: ${one.id ?? one.origin}`}
                className="px-1 py-1"
              >
                <div className="truncate text-zinc-300">{one.id ?? one.origin}</div>
                {one.problems.map((problem) => (
                  <div key={problem} className="text-[10.5px] text-red-400/90">
                    {problem}
                  </div>
                ))}
              </div>
            ))}
          </section>
        )}

        {diagnostics && (
          <section
            aria-label="Runtime diagnostics"
            className="mx-3 mt-3 rounded border border-zinc-800 px-2 py-1.5 text-[10.5px] text-zinc-500"
          >
            <div className="mb-1 font-semibold tracking-wider uppercase">Runtime diagnostics</div>
            <p data-testid="extension-host">
              Host {HOST_LABEL[running.host] ?? running.host} · generation {running.generation}
              {running.crashes
                ? ` · ${running.crashes} crash${running.crashes > 1 ? "es" : ""}`
                : ""}
              {running.held
                ? ` — ${running.held}`
                : running.host === "crashed" && running.hostReason
                  ? ` — ${running.hostReason}`
                  : ""}
            </p>
            <div className="mt-1 flex gap-3">
              <button
                onClick={() => run(manager.restart())}
                className="text-zinc-400 hover:text-zinc-200"
              >
                Restart
              </button>
              <button
                onClick={() => run(manager.reload())}
                className="text-zinc-400 hover:text-zinc-200"
              >
                Reload
              </button>
            </div>
          </section>
        )}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={menu.label}
          items={menu.items}
          onClose={() => setMenu(null)}
        />
      )}
    </aside>
  );
}
