import { useEffect, useState } from "react";
import type { ExtensionHostManager } from "../../services/extensions/manager";
import type { ExtensionRegistry } from "../../services/extensions/registry";
import type { ExtensionInstaller } from "../../services/extensions/marketplace/installer";
import type { ExtensionMarketplaceService } from "../../services/extensions/marketplace/service";
import {
  MarketplaceError,
  type MarketplaceExtension,
} from "../../services/extensions/marketplace/types";
import { compareVersions } from "../../services/extensions/marketplace/versions";
import { EXTENSION_API } from "../../services/extensions/manifest";
import { openExternalUrl } from "../../services/git/remoteUrl";
import { CardButton } from "./ExtensionCard";
import { ExtensionIcon } from "./ExtensionIcon";
import { ExtensionMarkdown } from "./ExtensionMarkdown";
import { statusOf, useExtensionsState } from "./model";

type Tab = "overview" | "features" | "requirements" | "changelog" | "information";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "features", label: "Features" },
  { id: "requirements", label: "Requirements" },
  { id: "changelog", label: "Changelog" },
  { id: "information", label: "Information" },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="mb-5">
      <h3 className="mb-2 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 border-b border-[#141414] py-1.5 text-[12.5px]">
      <span className="w-40 shrink-0 text-zinc-500">{label}</span>
      <span className="min-w-0 flex-1 break-words text-zinc-200">{children}</span>
    </div>
  );
}

/**
 * An extension's page (IDE-09), in the editor area: what it is, what it contributes, what it
 * needs, its changelog and versions, and Install / Update / Enable / Disable / Uninstall. It
 * shows only what the marketplace published and the installed manifest says.
 */
export function ExtensionDetails({
  id,
  registry,
  manager,
  marketplace,
  installer,
  trusted,
  onClose,
  onUninstall,
}: {
  id: string;
  registry: ExtensionRegistry;
  manager: ExtensionHostManager;
  marketplace: ExtensionMarketplaceService;
  installer: ExtensionInstaller;
  trusted: boolean;
  onClose: () => void;
  onUninstall: (id: string) => void;
}) {
  const state = useExtensionsState({ registry, manager, marketplace, installer });
  const entry = state.registry.extensions.find((one) => one.id === id);
  const [listing, setListing] = useState<{
    status: "loading" | "loaded" | "error";
    extension?: MarketplaceExtension;
    error?: string;
  }>({ status: "loading" });
  const [tab, setTab] = useState<Tab>("overview");
  const [documents, setDocuments] = useState<
    Partial<Record<"readme" | "changelog", string | null | Error>>
  >({});
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setListing({ status: "loading" });
    setDocuments({});
    marketplace.getExtension(id, controller.signal).then(
      (extension) => setListing({ status: "loaded", extension }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setListing({
          status: "error",
          error:
            error instanceof MarketplaceError && error.code === "NotFound"
              ? "This extension is not in the marketplace."
              : ((error as Error).message ?? String(error)),
        });
      },
    );
    return () => controller.abort();
  }, [id, marketplace, state.market.providerId, attempt]);

  const wantsDocument = tab === "overview" ? "readme" : tab === "changelog" ? "changelog" : null;
  useEffect(() => {
    if (!wantsDocument || listing.status !== "loaded" || wantsDocument in documents) return;
    let live = true;
    marketplace.getDocument(id, wantsDocument).then(
      (text) => live && setDocuments((d) => ({ ...d, [wantsDocument]: text })),
      (error: Error) => live && setDocuments((d) => ({ ...d, [wantsDocument]: error })),
    );
    return () => {
      live = false;
    };
  }, [wantsDocument, listing.status, id, marketplace, documents]);

  const extension = listing.extension;
  const manifest = entry?.manifest;
  const name = manifest?.displayName ?? extension?.displayName ?? id;
  const status = statusOf(id, state, trusted, marketplace, extension);
  const operation = state.operations.operations[id];
  const failure = state.operations.failures[id];
  const update = state.market.updates[id];
  const latest = extension ? marketplace.latestCompatible(extension) : null;
  const compatibility = extension ? marketplace.compatibility(extension, latest?.version) : null;
  const runtime = state.runtime.statuses[id];
  const report = (promise: Promise<unknown>) => void promise.catch(() => undefined);

  const commands = manifest
    ? manifest.contributes.commands.map((c) => ({
        command: c.command,
        title: c.category ? `${c.category}: ${c.title}` : c.title,
      }))
    : (extension?.contributes?.commands ?? []);
  const settings = manifest
    ? manifest.contributes.settings.map((s) => ({ id: s.id, description: s.description }))
    : (extension?.contributes?.settings ?? []);

  if (!entry && listing.status === "error")
    return (
      <div
        role="region"
        aria-label={`Extension: ${id}`}
        className="flex flex-1 flex-col items-center justify-center gap-3 bg-black text-[13px] text-zinc-400"
      >
        <p>{listing.error}</p>
        <div className="flex gap-2">
          <CardButton label="Retry" onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </CardButton>
          <CardButton label="Back to Extensions" onClick={onClose}>
            Back
          </CardButton>
        </div>
      </div>
    );

  return (
    <div
      role="region"
      aria-label={`Extension: ${name}`}
      className="flex min-h-0 flex-1 flex-col bg-black text-zinc-300"
    >
      <div className="flex items-center gap-2 border-b border-[#141414] px-4 py-2 text-[12px]">
        <button
          aria-label="Back to Extensions"
          onClick={onClose}
          className="text-zinc-500 hover:text-zinc-200"
        >
          ← Extensions
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <header className="flex gap-5 px-8 pt-6 pb-4">
          <ExtensionIcon id={id} name={name} marketplace={marketplace} size={96} />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[22px] font-semibold text-zinc-100">{name}</h1>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-zinc-400">
              <span>
                {extension?.publisherDisplayName ?? manifest?.publisher ?? extension?.publisher}
              </span>
              <span className="text-zinc-600">{id}</span>
              <span>v{manifest?.version ?? extension?.version}</span>
              {manifest &&
                extension &&
                compareVersions(extension.version, manifest.version) > 0 && (
                  <span className="text-zinc-500">latest v{extension.version}</span>
                )}
            </div>
            <p className="mt-2 text-[13px] text-zinc-300">
              {manifest?.description || extension?.description}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {!entry && (
                <CardButton
                  primary
                  label={`Install ${name}`}
                  disabled={!!operation || !latest}
                  title={!latest ? compatibility?.reasons[0] : undefined}
                  onClick={() => report(installer.install(id))}
                >
                  {operation ? "Installing…" : "Install"}
                </CardButton>
              )}
              {entry && update && (
                <CardButton
                  primary
                  label={`Update ${name}`}
                  disabled={!!operation}
                  onClick={() => report(installer.update(id))}
                >
                  {operation ? "Updating…" : `Update to ${update.available}`}
                </CardButton>
              )}
              {entry && (
                <CardButton
                  label={entry.enabled ? `Disable ${name}` : `Enable ${name}`}
                  disabled={!!operation}
                  onClick={() => registry.setEnabled(id, !entry.enabled)}
                >
                  {entry.enabled ? "Disable" : "Enable"}
                </CardButton>
              )}
              {entry && installer.removable(entry) && (
                <CardButton
                  label={`Uninstall ${name}`}
                  disabled={!!operation}
                  onClick={() => onUninstall(id)}
                >
                  Uninstall
                </CardButton>
              )}
              <span data-testid="extension-details-state" className="text-[12px] text-zinc-400">
                {status.label}
                {status.detail ? ` — ${status.detail}` : ""}
              </span>
            </div>
            {failure && (
              <div
                role="alert"
                className="mt-2 rounded border border-red-900/60 bg-red-950/30 px-2 py-1 text-[12px] text-red-300"
              >
                {failure.message}
                {failure.detail && (
                  <div className="mt-0.5 text-[11px] text-red-400/70">{failure.detail}</div>
                )}
              </div>
            )}
            {!entry && compatibility && !compatibility.compatible && !latest && (
              <p className="mt-2 text-[12px] text-amber-300/90">
                Incompatible: {compatibility.reasons.join(" ")}
              </p>
            )}
          </div>
        </header>

        <nav
          role="tablist"
          aria-label="Extension details"
          className="flex gap-4 border-b border-[#141414] px-8"
        >
          {TABS.map((one) => (
            <button
              key={one.id}
              role="tab"
              aria-selected={tab === one.id}
              onClick={() => setTab(one.id)}
              className={`-mb-px border-b-2 py-2 text-[12.5px] ${tab === one.id ? "border-indigo-500 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-300"}`}
            >
              {one.label}
            </button>
          ))}
        </nav>

        <div
          role="tabpanel"
          aria-label={TABS.find((t) => t.id === tab)!.label}
          className="max-w-[900px] px-8 py-5"
        >
          {tab === "overview" &&
            (listing.status === "loading" ? (
              <p className="text-zinc-500">Loading…</p>
            ) : !extension?.hasReadme ? (
              <p className="text-zinc-500">
                {manifest?.description || extension?.description || "No description."}
              </p>
            ) : documents.readme instanceof Error ? (
              <p className="text-red-400/90">
                The description could not be loaded: {documents.readme.message}
              </p>
            ) : documents.readme === undefined ? (
              <p className="text-zinc-500">Loading…</p>
            ) : (
              <ExtensionMarkdown text={documents.readme ?? ""} label="Overview" />
            ))}

          {tab === "features" && (
            <>
              <Section title="Commands">
                {commands.length ? (
                  commands.map((c) => (
                    <Row key={c.command} label={c.title}>
                      <code className="text-[11.5px] text-zinc-500">{c.command}</code>
                    </Row>
                  ))
                ) : (
                  <p className="text-[12.5px] text-zinc-500">None.</p>
                )}
              </Section>
              <Section title="Settings">
                {settings.length ? (
                  settings.map((s) => (
                    <Row key={s.id} label={s.id}>
                      {s.description}
                    </Row>
                  ))
                ) : (
                  <p className="text-[12.5px] text-zinc-500">None.</p>
                )}
              </Section>
              {manifest &&
                (manifest.contributes.views.length > 0 ||
                  manifest.contributes.menus.length > 0) && (
                  <Section title="Views and menus">
                    {manifest.contributes.views.map((v) => (
                      <Row key={v.id} label={v.name}>
                        View ({v.location})
                      </Row>
                    ))}
                    {manifest.contributes.menus.map((m, i) => (
                      <Row key={`${m.location}:${i}`} label={m.location}>
                        {m.command}
                      </Row>
                    ))}
                  </Section>
                )}
            </>
          )}

          {tab === "requirements" && (
            <Section title="Requirements">
              <Row label="Yavin extension API">
                {manifest?.engine ??
                  latest?.engines.yavin ??
                  extension?.engines.yavin ??
                  "Not stated"}{" "}
                (this Yavin: {EXTENSION_API})
              </Row>
              <Row label="Kind">
                {(manifest
                  ? manifest.main
                    ? "code"
                    : "declarative"
                  : extension?.extensionKind) === "declarative"
                  ? "Declarative: it only contributes; no code runs."
                  : "Runs code in Yavin's extension host (needs a trusted folder)."}
              </Row>
              {(manifest?.dependencies.length ?? 0) > 0 && (
                <Row label="Depends on">{manifest!.dependencies.join(", ")}</Row>
              )}
              {extension?.versions[0]?.platforms && (
                <Row label="Platforms">{extension.versions[0].platforms.join(", ")}</Row>
              )}
              {compatibility && (
                <Row label="Compatibility">
                  {compatibility.compatible
                    ? "Compatible"
                    : `Incompatible — ${compatibility.reasons.join(" ")}`}
                </Row>
              )}
              {!trusted && (
                <Row label="This folder">
                  Not trusted: installed extensions' code does not run here.
                </Row>
              )}
            </Section>
          )}

          {tab === "changelog" &&
            (!extension?.hasChangelog ? (
              <p className="text-zinc-500">No changelog published.</p>
            ) : documents.changelog instanceof Error ? (
              <p className="text-red-400/90">
                The changelog could not be loaded: {documents.changelog.message}
              </p>
            ) : documents.changelog === undefined ? (
              <p className="text-zinc-500">Loading…</p>
            ) : (
              <ExtensionMarkdown text={documents.changelog ?? ""} label="Changelog" />
            ))}

          {tab === "information" && (
            <>
              <Section title="Extension information">
                <Row label="Identifier">{id}</Row>
                <Row label="Publisher">
                  {extension?.publisherDisplayName ?? manifest?.publisher ?? extension?.publisher}
                </Row>
                {manifest && <Row label="Installed version">{manifest.version}</Row>}
                {extension && <Row label="Latest version">{extension.version}</Row>}
                {extension?.publishedAt && (
                  <Row label="First published">{extension.publishedAt}</Row>
                )}
                {extension?.updatedAt && <Row label="Last updated">{extension.updatedAt}</Row>}
                {extension?.license && <Row label="License">{extension.license}</Row>}
                {extension?.downloads !== undefined && (
                  <Row label="Downloads">{extension.downloads.toLocaleString()}</Row>
                )}
                {extension?.rating !== undefined && <Row label="Rating">{extension.rating}</Row>}
                {extension?.repository && (
                  <Row label="Repository">
                    <button
                      className="text-indigo-400 hover:underline"
                      onClick={() =>
                        void openExternalUrl(extension.repository!).catch(() => undefined)
                      }
                    >
                      {extension.repository}
                    </button>
                  </Row>
                )}
                {extension?.homepage && (
                  <Row label="Homepage">
                    <button
                      className="text-indigo-400 hover:underline"
                      onClick={() =>
                        void openExternalUrl(extension.homepage!).catch(() => undefined)
                      }
                    >
                      {extension.homepage}
                    </button>
                  </Row>
                )}
                {entry && <Row label="Installed in">{entry.origin}</Row>}
                {listing.status === "error" && <Row label="Marketplace">{listing.error}</Row>}
              </Section>
              {extension && (
                <Section title="Versions">
                  {extension.versions.map((v) => {
                    const fits = marketplace.compatibility(extension, v.version);
                    const current = manifest?.version === v.version;
                    return (
                      <Row key={v.version} label={v.version}>
                        <span className="flex flex-wrap items-center gap-2">
                          {v.publishedAt && <span className="text-zinc-500">{v.publishedAt}</span>}
                          {current ? (
                            <span className="text-emerald-400/90">Installed</span>
                          ) : fits.compatible ? (
                            <CardButton
                              label={`Install version ${v.version}`}
                              disabled={!!operation}
                              onClick={() => report(installer.install(id, v.version))}
                            >
                              Install this version
                            </CardButton>
                          ) : (
                            <span className="text-amber-300/90">
                              Incompatible — {fits.reasons[0]}
                            </span>
                          )}
                        </span>
                      </Row>
                    );
                  })}
                </Section>
              )}
              {entry && (
                <details className="text-[12px] text-zinc-500">
                  <summary className="cursor-pointer select-none">Runtime diagnostics</summary>
                  <div className="mt-2">
                    <Row label="Runtime state">
                      {runtime?.state ?? "not activated in this workspace"}
                    </Row>
                    {runtime?.activationMs != null && (
                      <Row label="Activation">{runtime.activationMs} ms</Row>
                    )}
                    {runtime?.reason && <Row label="Reason">{runtime.reason}</Row>}
                    <Row label="Extension host">
                      {state.runtime.host} · generation {state.runtime.generation}
                    </Row>
                  </div>
                </details>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
