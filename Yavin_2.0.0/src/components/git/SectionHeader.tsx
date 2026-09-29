import type { ReactNode } from "react";
import { ChevronIcon } from "../ui/FileIcons";

/**
 * The header every Source Control section shares -- Changes, Graph, Stashes, Repositories --
 * so they read as one panel: a chevron and title that fold the section, a count, and the
 * section's own actions on the right, shown while the header is hovered or focused (and
 * always while the section is open, where they are what the section is for).
 */
export function SectionHeader({
  title,
  count,
  countLabel,
  collapsed,
  onToggle,
  actions,
  badges,
}: {
  title: string;
  count?: number;
  /** What the count is, for assistive technology ("5 changed files"). */
  countLabel?: string;
  collapsed: boolean;
  onToggle: () => void;
  /** Buttons for this section; clicks on them never fold it. */
  actions?: ReactNode;
  /** Short state shown after the title ("Detached HEAD", "Out of date"). */
  badges?: ReactNode;
}) {
  return (
    <div className="group/section flex h-7 shrink-0 items-center gap-1 border-t border-border pl-1.5 pr-1 first:border-t-0">
      <button
        aria-expanded={!collapsed}
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-1 self-stretch text-left"
      >
        <ChevronIcon isExpanded={!collapsed} className="size-3 shrink-0 text-ink-3" />
        <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-ink-2">
          {title}
        </span>
        {count !== undefined && count > 0 && (
          <span
            aria-label={countLabel}
            className="shrink-0 rounded-full bg-border-strong px-1.5 font-mono text-[10px] leading-4 text-ink-2"
          >
            {count}
          </span>
        )}
        {badges}
      </button>
      {actions && (
        <div
          className={`flex shrink-0 items-center gap-0.5 transition-opacity focus-within:opacity-100 group-hover/section:opacity-100 ${
            collapsed ? "opacity-0" : "opacity-100"
          }`}
        >
          {actions}
        </div>
      )}
    </div>
  );
}

/** A small icon button for a section header or a row, with the same size and states. */
export function IconAction({
  label,
  title,
  onClick,
  disabled,
  danger,
  active,
  children,
}: {
  label: string;
  title?: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      aria-pressed={active}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={`rounded p-1 transition-colors disabled:opacity-40 ${
        active
          ? "bg-accent/15 text-accent-hover"
          : danger
            ? "text-ink-3 hover:bg-red/15 hover:text-red"
            : "text-ink-3 hover:bg-border-strong hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

const glyph = (children: ReactNode) => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.3"
    strokeLinecap="round"
    aria-hidden
  >
    {children}
  </svg>
);

/** Grouped into Staged / Unstaged: two stacked lists. */
export const GroupIcon = () =>
  glyph(
    <>
      <rect x="2.5" y="2.5" width="11" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="11" height="4.5" rx="1" />
    </>,
  );

/** One flat list. */
export const ListIcon = () =>
  glyph(
    <>
      <path d="M5 4h8.5M5 8h8.5M5 12h8.5" />
      <path d="M2.5 4h.01M2.5 8h.01M2.5 12h.01" />
    </>,
  );

/** Folders as a tree. */
export const TreeIcon = () =>
  glyph(
    <>
      <path d="M3 3v9.5h3M3 7.5h3" />
      <rect x="7" y="5.5" width="6.5" height="4" rx="1" />
      <rect x="7" y="10.5" width="6.5" height="4" rx="1" />
      <path d="M2 2.5h5" />
    </>,
  );
