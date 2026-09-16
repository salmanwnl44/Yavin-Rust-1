import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

export interface MenuItemDef {
  label: string;
  onSelect?: () => void;
  disabled?: boolean;
  /** Renders a checkmark when true/false (a toggle); omit for a plain action item. */
  checked?: boolean;
  /** A one-level flyout revealed on hover/click; leaves with `onSelect` still apply. */
  children?: MenuItemDef[];
}
export type MenuEntry = MenuItemDef | { separator: true };

const itemClass = (disabled?: boolean) =>
  `w-full flex items-center justify-between gap-3 px-3 py-1.5 text-left transition-colors ${
    disabled
      ? "text-zinc-600 cursor-not-allowed"
      : "text-zinc-200 hover:bg-indigo-600 hover:text-white"
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
        onClick={() => {
          if (hasChildren) {
            setSubOpen((open) => !open);
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
        {hasChildren && <span className="text-zinc-500 shrink-0">›</span>}
      </button>
      {hasChildren && subOpen && (
        <div
          role="menu"
          aria-label={item.label}
          className="absolute left-full top-0 ml-0.5 min-w-[180px] rounded border border-[#2a2a2a] bg-[#161616] shadow-xl py-1 z-50"
        >
          {item.children!.map((child) => (
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
              <span className="truncate">{child.label}</span>
            </button>
          ))}
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

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        title={label}
        aria-label={label}
        className={
          buttonClassName ??
          "p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-[#121212] transition-colors"
        }
      >
        {icon}
      </button>
      {open && (
        <div
          role="menu"
          aria-label={label}
          onClick={(e) => e.stopPropagation()}
          className={`absolute ${align === "end" ? "right-0" : "left-0"} top-full mt-1 z-50 min-w-[190px] rounded border border-[#2a2a2a] bg-[#161616] shadow-xl py-1 text-[12px]`}
        >
          {items.map((entry, i) =>
            "separator" in entry ? (
              <div key={i} className="my-1 border-t border-[#262626]" />
            ) : (
              <MenuRow key={entry.label} item={entry} onDone={() => setOpen(false)} />
            ),
          )}
        </div>
      )}
    </div>
  );
}
