import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";

export interface MenuItemDef {
  label: string;
  onSelect?: () => void;
  disabled?: boolean;
  /** Renders a checkmark when true/false (a toggle); omit for a plain action item. */
  checked?: boolean;
  /** A one-level flyout revealed on hover/click; leaves with `onSelect` still apply. May
   * include separators, but never another nested flyout (one level deep only). */
  children?: (MenuItemDef | { separator: true })[];
}
export type MenuEntry = MenuItemDef | { separator: true };

const itemClass = (disabled?: boolean) =>
  `w-full flex items-center justify-between gap-3 px-3 py-1.5 text-left transition-colors ${
    disabled ? "text-ink-3 cursor-not-allowed" : "text-ink hover:bg-accent hover:text-white"
  }`;

function MenuRow({ item, onDone }: { item: MenuItemDef; onDone: () => void }) {
  const [subOpen, setSubOpen] = useState(false);
  const hasChildren = !!item.children?.length;
  return (
    <div
      className="relative"
      onMouseEnter={() => hasChildren && setSubOpen(true)}
      onMouseLeave={() => hasChildren && setSubOpen(false)}
    >
      <button
        role="menuitem"
        disabled={item.disabled}
        {...(hasChildren ? { "aria-haspopup": "menu" as const, "aria-expanded": subOpen } : {})}
        // Keyboard users cannot hover, so the flyout also opens on focus and on Right arrow.
        onFocus={() => hasChildren && setSubOpen(true)}
        onKeyDown={(e) => {
          if (hasChildren && e.key === "ArrowRight") {
            e.preventDefault();
            setSubOpen(true);
          }
        }}
        onClick={() => {
          if (hasChildren) {
            // Clicking never closes the flyout: hovering already opened it, so a toggle here
            // made a mouse user's click on "Stash" shut the submenu they were reaching for.
            // It closes when the pointer leaves the row, or with the whole menu.
            setSubOpen(true);
            return;
          }
          item.onSelect?.();
          onDone();
        }}
        className={itemClass(item.disabled)}
      >
        <span className="flex items-center gap-1.5 truncate">
          {item.checked !== undefined && (
            <span className="w-3 shrink-0 text-[10px]">{item.checked ? "✓" : ""}</span>
          )}
          {item.label}
        </span>
        {hasChildren && <span className="text-ink-3 shrink-0">›</span>}
      </button>
      {hasChildren && subOpen && (
        <div
          role="menu"
          aria-label={item.label}
          className="absolute left-full top-0 ml-0.5 min-w-[180px] rounded border border-border-strong bg-surface-hover shadow-xl py-1 z-50"
        >
          {item.children!.map((child, i) =>
            "separator" in child ? (
              <div key={i} className="my-1 border-t border-border-strong" />
            ) : (
              <button
                key={child.label}
                role="menuitem"
                disabled={child.disabled}
                onClick={() => {
                  child.onSelect?.();
                  onDone();
                }}
                className={itemClass(child.disabled)}
              >
                <span className="flex items-center gap-1.5 truncate">
                  {child.checked !== undefined && (
                    <span className="w-3 shrink-0 text-[10px]">{child.checked ? "✓" : ""}</span>
                  )}
                  {child.label}
                </span>
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A small, self-contained dropdown with one level of flyout submenus. Deliberately
 * separate from `src/components/ui/ContextMenu.tsx` (the title-bar/Explorer menu
 * system): that component has no submenu concept, and it is shared, well-tested
 * infrastructure not worth risking for Source Control's menu shapes.
 */
export function GitMenu({
  icon,
  label,
  items,
  buttonClassName,
  align = "end",
}: {
  icon: ReactNode;
  label: string;
  items: MenuEntry[];
  buttonClassName?: string;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        // Escape has to put focus back where it came from, or a keyboard user is dropped at
        // the top of the document with no idea where they are.
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Opening moves focus to the first enabled item, so the menu is operable from the keyboard
  // at all rather than requiring a Tab walk through the page to reach it.
  useEffect(() => {
    if (!open) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>(
      'button[role="menuitem"]:not(:disabled)',
    );
    first?.focus();
  }, [open]);

  /** Up/Down move between items, the way a menu is expected to behave. */
  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const buttons = [
      ...(menuRef.current?.querySelectorAll<HTMLButtonElement>(
        'button[role="menuitem"]:not(:disabled)',
      ) ?? []),
    ];
    if (!buttons.length) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next = (current + step + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        ref={triggerRef}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className={
          buttonClassName ??
          "p-1 rounded text-ink-3 hover:text-ink hover:bg-surface-hover transition-colors"
        }
      >
        {icon}
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={onMenuKeyDown}
          className={`absolute ${align === "end" ? "right-0" : "left-0"} top-full mt-1 z-50 min-w-[190px] rounded border border-border-strong bg-surface-hover shadow-xl py-1 text-[12px]`}
        >
          {items.map((entry, i) =>
            "separator" in entry ? (
              <div key={i} className="my-1 border-t border-border-strong" />
            ) : (
              <MenuRow key={entry.label} item={entry} onDone={() => setOpen(false)} />
            ),
          )}
        </div>
      )}
    </div>
  );
}
