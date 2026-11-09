/**
 * The command registry (IDE-08): the one owner of the window's commands -- Yavin's own and
 * extensions' -- that the menus, the command palette and the shortcut handler read.
 *
 * Yavin's own commands are defined by the window, which re-states them as its state changes
 * (`setCore`: their enablement and labels follow the window). Extensions' commands come from
 * the extension registry (`setExtensions`) and run through the workspace's extension host. Ids
 * are unique: an extension's command is namespaced by its id and can never replace a core one.
 *
 * Shortcuts, in a fixed order: user overrides first, then Yavin's own, then extensions'
 * contributed ones in the order the extensions are sorted by id -- the first claimant of a key
 * keeps it. A contribution conflict is reported (`conflicts`), never resolved silently by taking
 * the key. User keybinding overrides (WS20, `settings/keybindings.ts`) come before everything:
 * each command's effective shortcut is its user override if there is one, else its default; an
 * extension's contributed key is offered only against the *effective* core keys. The store owns
 * the overrides and this registry only reads them, so there is still one command list.
 */
import type { AppCommand } from "./commands.ts";
import { resolveKeybindings, type KeybindingConflict } from "./extensions/contributions.ts";
import type { ContributedCommand } from "./extensions/registry.ts";

/** How the registry reads the user's keybinding overrides without owning them (WS20). */
export interface KeybindingOverrides {
  /** The override for `commandId`: a key, `null` (unbound), or `undefined` (none). */
  override(commandId: string): string | null | undefined;
}

export function createCommandRegistry() {
  let core: readonly AppCommand[] = [];
  let contributed: readonly ContributedCommand[] = [];
  let run: (command: string) => void = () => {};
  let name: (extensionId: string) => string = (id) => id;
  let overrides: KeybindingOverrides | null = null;
  let cache: { list: AppCommand[]; conflicts: KeybindingConflict[] } | null = null;
  const listeners = new Set<() => void>();

  /** The shortcut `command` resolves to: the user's override (a key or, if `null`, none), else
   * its default. Returns `undefined` when the command has, or is bound to, no key. */
  const effective = (id: string, fallback: string | undefined): string | undefined => {
    const over = overrides?.override(id);
    if (over === undefined) return fallback;
    return over ?? undefined;
  };

  const compose = () => {
    if (cache) return cache;
    const coreIds = new Set(core.map((command) => command.id));
    const sorted = [...contributed]
      .filter((command) => !coreIds.has(command.command))
      .sort(
        (a, b) => a.extensionId.localeCompare(b.extensionId) || a.command.localeCompare(b.command),
      );
    // Extensions compete against the core keys *as the user has them*, not the hard defaults.
    const keys = resolveKeybindings(
      sorted,
      core.flatMap((command) => {
        const key = effective(command.id, command.shortcut);
        return key ? [key] : [];
      }),
    );
    cache = {
      conflicts: keys.conflicts,
      list: [
        ...core.map((command): AppCommand =>
          overrides ? { ...command, shortcut: effective(command.id, command.shortcut) } : command,
        ),
        ...sorted.map((command): AppCommand => ({
          id: command.command,
          menu: command.category ?? name(command.extensionId),
          label: command.title,
          shortcut: effective(command.command, keys.shortcuts.get(command.command)),
          palette: command.palette,
          run: () => run(command.command),
        })),
      ],
    };
    return cache;
  };

  return {
    /** The window's own commands, as they are now. */
    setCore(commands: readonly AppCommand[]) {
      core = commands;
      cache = null;
    },
    /** Extensions' commands (the registry's enabled contributions) and how to run one. */
    setExtensions(
      commands: readonly ContributedCommand[],
      runner: (command: string) => void,
      displayName: (extensionId: string) => string,
    ) {
      if (commands !== contributed) {
        contributed = commands;
        cache = null;
        for (const listener of [...listeners]) listener();
      }
      run = runner;
      name = displayName;
    },
    /**
     * The user's keybinding overrides (WS20). Reading them here keeps one command list: the
     * effective shortcut each command exposes already reflects the user's choice, so the keyboard
     * handler, menus and palette need no change. `null` clears them. Call again on any change to
     * recompose and tell subscribers.
     */
    setKeybindings(source: KeybindingOverrides | null) {
      // Idempotent on the same source (it is re-pushed every render): only a changed source
      // recomposes and notifies. Live override edits are picked up because `setCore` clears the
      // cache every render and the window re-renders on the store's change subscription.
      if (overrides === source) return;
      overrides = source;
      cache = null;
      for (const listener of [...listeners]) listener();
    },
    list: () => compose().list,
    conflicts: () => compose().conflicts,
    get: (id: string) => compose().list.find((command) => command.id === id),
    /** Runs a command by id (core or extension); false when there is none or it is disabled. */
    execute(id: string): boolean {
      const command = compose().list.find((one) => one.id === id);
      if (!command || command.disabled) return false;
      void command.run();
      return true;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type CommandRegistry = ReturnType<typeof createCommandRegistry>;

/** The window's command registry. */
export const commandRegistry = createCommandRegistry();
