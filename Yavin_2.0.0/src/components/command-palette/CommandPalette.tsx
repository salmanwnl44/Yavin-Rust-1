import { useEffect, useMemo, useRef, useState } from "react";
import type { FileNode } from "../../types";
import { flattenFiles } from "../../services/workspace";
import { shortcutLabel } from "../../services/commands";
import type { AppCommand } from "../../services/commands";

export function CommandPalette({
  isOpen,
  onClose,
  onSelectFile,
  fileTree,
  commands,
  mode,
  onError,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSelectFile: (path: string, name: string) => void;
  fileTree: FileNode;
  commands: AppCommand[];
  mode: "files" | "commands";
  onError: (reason: unknown) => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const files = useMemo(() => flattenFiles(fileTree), [fileTree]);
  useEffect(() => {
    if (isOpen) {
      setQuery(mode === "commands" ? ">" : "");
      setSelectedIndex(0);
      dialog.current?.showModal();
      input.current?.focus();
    } else dialog.current?.close();
  }, [isOpen, mode]);
  const commandMode = query.startsWith(">");
  const search = (commandMode ? query.slice(1) : query).trim().toLowerCase();
  const items = (
    commandMode
      ? commands.map((command) => ({
          id: command.id,
          title: `${command.menu}: ${command.label}`,
          subtitle: command.disabled
            ? command.reason || "Unavailable in the current context"
            : command.shortcut
              ? shortcutLabel(command.shortcut)
              : "Command",
          disabled: command.disabled,
          run: command.run,
        }))
      : files.map((file) => ({
          id: file.subtitle,
          title: file.title,
          subtitle: file.subtitle,
          disabled: false,
          run: () => onSelectFile(file.subtitle, file.title),
        }))
  ).filter((item) => `${item.title} ${item.subtitle}`.toLowerCase().includes(search));
  const index = Math.min(selectedIndex, Math.max(0, items.length - 1));
  const activate = (item: (typeof items)[number]) => {
    if (item.disabled) return;
    dialog.current?.close();
    onClose();
    Promise.resolve().then(item.run).catch(onError);
  };
  useEffect(() => {
    document.getElementById(`palette-option-${index}`)?.scrollIntoView({ block: "nearest" });
  }, [index, query]);
  return (
    <dialog
      ref={dialog}
      aria-label="Quick open and commands"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
      className="mx-auto mt-24 w-[min(560px,95vw)] rounded-xl border border-zinc-700 bg-zinc-950 p-0 text-zinc-200 shadow-2xl backdrop:bg-black/70"
    >
      <div className="p-3" onClick={(event) => event.stopPropagation()}>
        <input
          ref={input}
          role="combobox"
          aria-label="Search files or commands"
          aria-expanded="true"
          aria-controls="palette-results"
          aria-autocomplete="list"
          aria-activedescendant={items.length ? `palette-option-${index}` : undefined}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedIndex(0);
          }}
          placeholder="Search files, or type > for commands"
          className="w-full rounded border border-zinc-600 bg-black px-3 py-2 text-sm outline-indigo-500"
          onKeyDown={(event) => {
            if (event.isPropagationStopped() || event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setSelectedIndex(
                (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % (items.length || 1),
              );
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (items[index]) activate(items[index]);
            }
          }}
        />
        <div
          id="palette-results"
          role="listbox"
          aria-label="Results"
          className="mt-2 max-h-80 overflow-auto"
        >
          {!items.length && (
            <p className="p-4 text-sm text-zinc-500">
              No matching {commandMode ? "commands" : "files"}
            </p>
          )}
          {items.map((item, itemIndex) => (
            <div
              key={item.id}
              id={`palette-option-${itemIndex}`}
              role="option"
              aria-selected={itemIndex === index}
              aria-disabled={item.disabled || undefined}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setSelectedIndex(itemIndex)}
              onClick={() => activate(item)}
              className={`cursor-pointer rounded px-3 py-2 text-sm ${itemIndex === index ? "bg-indigo-950" : ""} ${item.disabled ? "text-zinc-500" : ""}`}
            >
              <div>{item.title}</div>
              <div className="truncate text-xs text-zinc-500">{item.subtitle}</div>
            </div>
          ))}
        </div>
        <div className="mt-2 text-xs text-zinc-500">
          ↑ ↓ Navigate · Enter Open · Esc Close · &gt; Commands
        </div>
      </div>
    </dialog>
  );
}
