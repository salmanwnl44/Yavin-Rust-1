import { useEffect, useMemo, useReducer, useState } from "react";
import type { AppCommand } from "../../services/commands";
import { shortcutLabel } from "../../services/commands";
import {
  KeybindingError,
  shortcutConflicts,
  shortcutFromEvent,
  type KeybindingsStore,
  type ShortcutBinding,
} from "../../services/settings/keybindings";
import type { CommandRegistry } from "../../services/commandRegistry";

/**
 * The Keyboard Shortcuts view (WS20): every command with the key it resolves to -- its default,
 * the user's reassignment, or none -- searchable, each reassignable by pressing a key, resettable
 * to its default, and removable. Conflicts (two commands on one key in the same place) are shown
 * but never resolved silently. It owns no commands and no keys: it reads the command list from the
 * registry and writes the user's choices to the keybindings store, which the registry already
 * reads, so a change here flows to the menus, the palette and the keyboard the moment it is made.
 */
export function KeyboardShortcutsView({
  registry,
  keybindings,
  onClose,
}: {
  registry: CommandRegistry;
  keybindings: KeybindingsStore;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [capturing, setCapturing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  // The command list changes (its labels/enablement follow the window) and so do the overrides;
  // either redraws the view.
  useEffect(() => {
    const stopCommands = registry.subscribe(refresh);
    const stopKeys = keybindings.subscribe(refresh);
    return () => {
      stopCommands();
      stopKeys();
    };
  }, [registry, keybindings]);

  // A command's effective key already reflects the user's override (the registry resolved it).
  // Whether a Reset is possible is told by `source`, from the store's own view of the override.
  const commands = registry.list();
  const bindings = useMemo<ShortcutBinding[]>(() => {
    return commands
      .map((command: AppCommand): ShortcutBinding => {
        const override = keybindings.override(command.id);
        const source =
          override === undefined ? "default" : override === null ? "unbound" : "custom";
        return {
          id: command.id,
          label: command.label,
          menu: command.menu,
          defaultShortcut: command.shortcut,
          shortcut: command.shortcut,
          source,
          domain: command.scope === "terminal" ? "terminal" : "window",
        };
      })
      .sort((a, b) => a.menu.localeCompare(b.menu) || a.label.localeCompare(b.label));
  }, [commands, keybindings]);

  const conflicts = useMemo(() => shortcutConflicts(bindings), [bindings]);
  const labelOf = (id: string) => bindings.find((b) => b.id === id)?.label ?? id;

  const needle = query.trim().toLowerCase();
  const shown = bindings.filter(
    (b) =>
      !needle || `${b.menu} ${b.label} ${b.id} ${b.shortcut ?? ""}`.toLowerCase().includes(needle),
  );

  const capture = (commandId: string, event: React.KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setCapturing(null);
      setError("");
      return;
    }
    // Wait until a non-modifier key is down.
    if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
    const shortcut = shortcutFromEvent(event.nativeEvent);
    if (!shortcut) {
      setError(
        "That is not a key Yavin can bind. Hold Ctrl or Alt with a key, or use a function key.",
      );
      return;
    }
    try {
      keybindings.assign(commandId, shortcut);
      setCapturing(null);
      setError("");
    } catch (reason) {
      setError(reason instanceof KeybindingError ? reason.message : String(reason));
    }
  };

  return (
    <section
      aria-label="Keyboard Shortcuts"
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#050505] text-[12px] text-zinc-300"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-[#161616] px-5 py-2.5">
        <h1 className="text-[13px] font-semibold text-zinc-100">Keyboard Shortcuts</h1>
        <input
          aria-label="Search keyboard shortcuts"
          placeholder="Search by command or key"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="ml-auto w-72 rounded border border-[#222222] bg-[#0a0a0a] px-2 py-1 text-[11px] text-zinc-200 placeholder:text-zinc-600"
        />
        <button
          onClick={() => {
            keybindings.resetAll();
            setError("");
          }}
          className="rounded px-2 py-1 text-[11px] text-zinc-400 hover:bg-[#1c1c1c] hover:text-zinc-200"
          title="Return every shortcut to its default"
        >
          Reset All
        </button>
        <button
          aria-label="Close keyboard shortcuts"
          onClick={onClose}
          className="text-zinc-500 hover:text-zinc-200"
        >
          ✕
        </button>
      </header>

      {error && (
        <p role="alert" className="shrink-0 bg-red-950/40 px-5 py-1.5 text-[11px] text-red-300">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
        {!shown.length && <p className="text-zinc-500">No commands match “{query}”.</p>}
        <table className="w-full border-collapse">
          <thead>
            <tr className="text-left text-[10px] tracking-wider text-zinc-500 uppercase">
              <th className="py-1 pr-4 font-semibold">Command</th>
              <th className="py-1 pr-4 font-semibold">Keybinding</th>
              <th className="py-1 font-semibold">When / actions</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((b) => {
              const clash = conflicts.get(b.id);
              return (
                <tr
                  key={b.id}
                  data-testid="keybinding-row"
                  data-command={b.id}
                  className="border-t border-[#121212] align-top hover:bg-[#0a0a0a]"
                >
                  <td className="py-1.5 pr-4">
                    <div className="text-zinc-200">{b.label}</div>
                    <div className="text-[10px] text-zinc-600">
                      {b.menu} · {b.id}
                    </div>
                  </td>
                  <td className="py-1.5 pr-4">
                    {capturing === b.id ? (
                      <input
                        autoFocus
                        readOnly
                        aria-label={`Press a shortcut for ${b.label}`}
                        value="Press keys… (Esc to cancel)"
                        onKeyDown={(event) => capture(b.id, event)}
                        onBlur={() => setCapturing(null)}
                        className="w-48 rounded border border-indigo-700 bg-[#111111] px-1.5 py-0.5 text-indigo-200"
                      />
                    ) : (
                      <button
                        aria-label={`Change shortcut for ${b.label}`}
                        onClick={() => {
                          setCapturing(b.id);
                          setError("");
                        }}
                        className={`min-w-[8rem] rounded border px-1.5 py-0.5 text-left font-mono text-[11px] ${
                          clash
                            ? "border-amber-800 bg-amber-950/30 text-amber-300"
                            : "border-[#2a2a2a] bg-[#111111] text-zinc-200 hover:border-[#3a3a3a]"
                        }`}
                      >
                        {b.shortcut ? (
                          shortcutLabel(b.shortcut)
                        ) : (
                          <span className="text-zinc-600">Unbound</span>
                        )}
                      </button>
                    )}
                    {b.source === "custom" && (
                      <span className="ml-2 text-[10px] text-indigo-400">custom</span>
                    )}
                  </td>
                  <td className="py-1.5 text-[11px] text-zinc-500">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          keybindings.reset(b.id);
                          setError("");
                        }}
                        disabled={b.source === "default"}
                        className="rounded px-1.5 text-zinc-500 hover:bg-[#1c1c1c] hover:text-zinc-200 disabled:opacity-30"
                        title="Return this shortcut to its default"
                      >
                        Reset
                      </button>
                      <button
                        onClick={() => {
                          keybindings.unbind(b.id);
                          setError("");
                        }}
                        disabled={!b.shortcut}
                        className="rounded px-1.5 text-zinc-500 hover:bg-[#1c1c1c] hover:text-zinc-200 disabled:opacity-30"
                        title="Remove this command's key"
                      >
                        Remove
                      </button>
                    </div>
                    {clash && (
                      <div className="mt-0.5 text-[10px] text-amber-400" role="status">
                        Also used by {clash.map(labelOf).join(", ")}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
