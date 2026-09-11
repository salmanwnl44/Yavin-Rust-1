import React, { useLayoutEffect, useRef, useState } from "react";

export interface MenuItem {
  divider?: boolean;
  label?: string;
  icon?: React.ReactNode;
  shortcut?: string;
  disabled?: boolean;
  reason?: string;
  checked?: boolean;
  danger?: boolean;
  onClick?: () => void | Promise<void>;
}

export function ContextMenu({
  x,
  y,
  onClose,
  items,
  label = "Actions",
  onSwitch,
  onError,
  initialLast = false,
}: {
  x: number;
  y: number;
  onClose: () => void;
  items: MenuItem[];
  label?: string;
  onSwitch?: (direction: number) => void;
  onError?: (error: unknown) => void;
  initialLast?: boolean;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const previous = document.activeElement;
    const bounds = menu.getBoundingClientRect();
    setPosition({
      x: Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8)),
    });
    const buttons = menu.querySelectorAll<HTMLButtonElement>("[role^=menuitem]");
    buttons[initialLast ? buttons.length - 1 : 0]?.focus();
    const dismiss = (event: PointerEvent) => {
      if (
        !menu.contains(event.target as Node) &&
        !(event.target instanceof Element && event.target.closest("[data-menu-trigger]"))
      )
        closeRef.current();
    };
    const resize = () => closeRef.current();
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("resize", resize);
      if (
        menu.contains(document.activeElement) &&
        previous instanceof HTMLElement &&
        previous.isConnected
      )
        previous.focus();
    };
  }, [x, y, initialLast]);

  const activate = (item: MenuItem) => {
    if (item.disabled || !item.onClick) return;
    onClose();
    try {
      Promise.resolve(item.onClick()).catch((reason) => {
        if (onError) onError(reason);
        else window.alert(String(reason));
      });
    } catch (reason) {
      if (onError) onError(reason);
      else window.alert(String(reason));
    }
  };
  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      style={{ top: position.y, left: position.x, maxHeight: "calc(100vh - 16px)" }}
      className="fixed z-50 flex w-64 overflow-y-auto flex-col rounded-xl border border-[#262626] bg-[#0c0c0c] p-1.5 text-xs text-zinc-200 shadow-2xl select-none"
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        const buttons = Array.from(
          menuRef.current?.querySelectorAll<HTMLButtonElement>("[role^=menuitem]") ?? [],
        );
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        let next = current;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          return;
        }
        if (event.key === "Tab") {
          onClose();
          return;
        }
        if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && onSwitch) {
          event.preventDefault();
          onSwitch(event.key === "ArrowLeft" ? -1 : 1);
          return;
        }
        if (event.key === "ArrowDown") next = (current + 1) % buttons.length;
        else if (event.key === "ArrowUp") next = (current - 1 + buttons.length) % buttons.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = buttons.length - 1;
        else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && event.key !== " ") {
          const offset = buttons
            .slice(current + 1)
            .concat(buttons.slice(0, current + 1))
            .find((button) =>
              button.textContent?.trim().toLowerCase().startsWith(event.key.toLowerCase()),
            );
          offset?.focus();
          event.preventDefault();
          return;
        } else return;
        event.preventDefault();
        buttons[next]?.focus();
      }}
    >
      {items.map((item, index) =>
        item.divider ? (
          <div key={index} role="separator" className="my-1 h-px bg-zinc-800" />
        ) : (
          <button
            key={index}
            type="button"
            role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
            aria-label={item.label}
            aria-checked={item.checked}
            aria-disabled={item.disabled || undefined}
            tabIndex={-1}
            title={item.reason}
            onClick={() => activate(item)}
            className={`flex w-full items-center justify-between gap-3 rounded px-2.5 py-2 text-left focus:bg-indigo-950 focus:outline-none hover:bg-zinc-800 ${item.disabled ? "text-zinc-600" : item.danger ? "text-red-400" : ""}`}
          >
            <span className="flex items-center gap-2">
              {item.checked !== undefined && (
                <span aria-hidden="true">{item.checked ? "✓" : "○"}</span>
              )}
              {item.icon}
              {item.label}
            </span>
            {item.shortcut && (
              <span className="shrink-0 text-[10px] text-zinc-500">{item.shortcut}</span>
            )}
          </button>
        ),
      )}
    </div>
  );
}
