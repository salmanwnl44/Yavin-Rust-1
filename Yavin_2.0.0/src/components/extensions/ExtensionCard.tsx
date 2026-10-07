import { memo, type ReactNode } from "react";
import type { ExtensionMarketplaceService } from "../../services/extensions/marketplace/service";
import type { DisplayStatus } from "../../services/extensions/marketplace/status";
import { ExtensionIcon } from "./ExtensionIcon";

const TONE: Record<DisplayStatus["tone"], string> = {
  neutral: "text-zinc-500",
  good: "text-emerald-400/90",
  busy: "text-sky-400/90",
  warning: "text-amber-300/90",
  error: "text-red-400/90",
};

export interface CardModel {
  id: string;
  displayName: string;
  description: string;
  publisher: string;
  version: string;
  status: DisplayStatus;
  /** A failure to show (install, update, uninstall), with its detail. */
  failure?: { message: string; detail: string | null } | null;
}

/**
 * One extension in the Extensions view: its icon, name, publisher, description, version, what
 * state it is in, and its actions. Browsing never runs extension code: a card shows marketplace
 * metadata and registry state only.
 */
export const ExtensionCard = memo(function ExtensionCard({
  model,
  marketplace,
  actions,
  onOpen,
  onContextMenu,
  onDismissFailure,
}: {
  model: CardModel;
  marketplace: ExtensionMarketplaceService;
  actions: ReactNode;
  onOpen: () => void;
  onContextMenu?: (x: number, y: number) => void;
  onDismissFailure?: () => void;
}) {
  const showState = model.status.label !== "Not installed";
  return (
    <div
      role="group"
      aria-label={model.displayName}
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target === event.currentTarget) onOpen();
      }}
      onContextMenu={(event) => {
        if (!onContextMenu) return;
        event.preventDefault();
        onContextMenu(event.clientX, event.clientY);
      }}
      className="flex cursor-pointer gap-2.5 rounded-md px-2 py-2 outline-none hover:bg-[#0d0d0d] focus-visible:bg-[#111] focus-visible:ring-1 focus-visible:ring-indigo-500/60"
    >
      <ExtensionIcon id={model.id} name={model.displayName} marketplace={marketplace} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="truncate text-[12.5px] font-medium text-zinc-100">
            {model.displayName}
          </span>
          <span className="shrink-0 text-[10px] text-zinc-600">v{model.version}</span>
        </div>
        <div className="truncate text-[11.5px] text-zinc-400" title={model.description}>
          {model.description || "No description."}
        </div>
        <div className="mt-0.5 flex min-h-[22px] items-center justify-between gap-2">
          <span className="truncate text-[11px] text-zinc-500">{model.publisher}</span>
          <div
            className="flex shrink-0 items-center gap-1"
            onClick={(event) => event.stopPropagation()}
          >
            {actions}
          </div>
        </div>
        {showState && (
          <div
            data-testid="extension-state"
            className={`truncate text-[10.5px] ${TONE[model.status.tone]}`}
            title={model.status.detail ?? undefined}
          >
            {model.status.label}
            {model.status.detail ? ` — ${model.status.detail}` : ""}
          </div>
        )}
        {model.failure && (
          <div
            role="alert"
            className="mt-1 rounded border border-red-900/60 bg-red-950/30 px-1.5 py-1 text-[10.5px] text-red-300"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2">
              <span>{model.failure.message}</span>
              {onDismissFailure && (
                <button
                  aria-label={`Dismiss the error for ${model.displayName}`}
                  onClick={onDismissFailure}
                  className="text-red-400/80 hover:text-red-200"
                >
                  ×
                </button>
              )}
            </div>
            {model.failure.detail && (
              <details className="mt-0.5 text-red-400/70">
                <summary className="cursor-pointer select-none">Details</summary>
                <span className="break-words">{model.failure.detail}</span>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

/** A small action button on a card. */
export function CardButton({
  children,
  label,
  onClick,
  primary,
  disabled,
  title,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
      className={
        primary
          ? "rounded bg-indigo-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
          : "rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-40"
      }
    >
      {children}
    </button>
  );
}
