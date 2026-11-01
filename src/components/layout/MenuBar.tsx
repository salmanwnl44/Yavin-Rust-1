import { useRef, useState } from "react";
import { menuNames, shortcutLabel } from "../../services/commands";
import type { AppCommand } from "../../services/commands";
import { ContextMenu } from "../ui/ContextMenu";

export function MenuBar({
  commands,
  onError,
}: {
  commands: AppCommand[];
  onError: (error: unknown) => void;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const [focused, setFocused] = useState(0);
  const [last, setLast] = useState(false);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const trigger = open === null ? undefined : buttons.current[open];
  const bounds = trigger?.getBoundingClientRect();
  const activate = (index: number, lastItem = false) => {
    setFocused(index);
    setLast(lastItem);
    buttons.current[index]?.focus();
    setOpen(index);
  };
  return (
    <nav
      role="menubar"
      aria-label="Application"
      className="flex shrink-0 items-center gap-0.5 text-[11.5px] text-zinc-300"
    >
      {menuNames.map((name, index) => (
        <button
          key={name}
          type="button"
          ref={(element) => {
            buttons.current[index] = element;
          }}
          data-menu-trigger
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={open === index}
          tabIndex={focused === index ? 0 : -1}
          className={`rounded px-2 py-1 hover:bg-zinc-800 focus:bg-zinc-800 focus:outline-none ${open === index ? "bg-zinc-800 text-white" : ""}`}
          onFocus={() => setFocused(index)}
          onPointerEnter={() => {
            if (open !== null && open !== index) activate(index);
          }}
          onClick={() => (open === index ? setOpen(null) : activate(index))}
          onKeyDown={(event) => {
            if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
              event.preventDefault();
              activate(index, event.key === "ArrowUp");
            } else if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? menuNames.length - 1
                    : (index + (event.key === "ArrowLeft" ? -1 : 1) + menuNames.length) %
                      menuNames.length;
              setFocused(next);
              buttons.current[next]?.focus();
              if (open !== null) activate(next);
            } else if (event.key === "Escape") setOpen(null);
          }}
        >
          {name}
        </button>
      ))}
      {open !== null && bounds && (
        <ContextMenu
          key={open}
          label={menuNames[open]}
          x={bounds.left}
          y={bounds.bottom + 4}
          initialLast={last}
          onClose={() => setOpen(null)}
          onError={onError}
          onSwitch={(direction) =>
            activate((open + direction + menuNames.length) % menuNames.length)
          }
          items={commands
            .filter((command) => command.menu === menuNames[open])
            .map((command) => ({
              label: command.label,
              shortcut: command.shortcut && shortcutLabel(command.shortcut),
              checked: command.checked,
              disabled: command.disabled,
              reason: command.reason,
              onClick: command.run,
            }))}
        />
      )}
    </nav>
  );
}
