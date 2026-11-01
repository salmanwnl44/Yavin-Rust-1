/**
 * The command registry (IDE-08): the one owner of the window's commands -- Yavin's own and
 * extensions' -- that the menus, the command palette and the shortcut handler read.
 *
 * Yavin's own commands are defined by the window, which re-states them as its state changes
 * (`setCore`: their enablement and labels follow the window). Extensions' commands come from
 * the extension registry (`setExtensions`) and run through the workspace's extension host. Ids
 * are unique: an extension's command is namespaced by its id and can never replace a core one.
 *
 * Shortcuts, in a fixed order: Yavin's own first; then extensions' contributed ones, in the
 * order the extensions are sorted by id -- the first claimant of a key keeps it. A conflict is
 * reported (`conflicts`), never resolved silently by taking the key. (There are no user
 * keybinding overrides in Yavin yet; when there are, they come before everything.)
 */
import type { AppCommand } from "./commands.ts";
import { resolveKeybindings, type KeybindingConflict } from "./extensions/contributions.ts";
import type { ContributedCommand } from "./extensions/registry.ts";

export function createCommandRegistry() {
  let core: readonly AppCommand[] = [];
  let contributed: readonly ContributedCommand[] = [];
  let run: (command: string) => void = () => {};
  let name: (extensionId: string) => string = (id) => id;
  let cache: { list: AppCommand[]; conflicts: KeybindingConflict[] } | null = null;
  const listeners = new Set<() => void>();

  const compose = () => {
    if (cache) return cache;
    const coreIds = new Set(core.map((command) => command.id));
    const sorted = [...contributed]
      .filter((command) => !coreIds.has(command.command))
      .sort(
        (a, b) => a.extensionId.localeCompare(b.extensionId) || a.command.localeCompare(b.command),
      );
    const keys = resolveKeybindings(
      sorted,
      core.flatMap((command) => (command.shortcut ? [command.shortcut] : [])),
    );
    cache = {
      conflicts: keys.conflicts,
      list: [
        ...core,
        ...sorted.map((command): AppCommand => ({
          id: command.command,
          menu: command.category ?? name(command.extensionId),
          label: command.title,
          shortcut: keys.shortcuts.get(command.command),
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
