/**
 * How extensions' contributions meet the window's own (IDE-07). The window keeps its command
 * list and shortcut handling (`commands.ts`); extension commands are added to it, and a
 * contributed shortcut is used only if nothing else has it -- Yavin's own shortcuts are never
 * taken, and between two extensions the first registered keeps it.
 */
import type { ContributedCommand } from "./registry.ts";

export interface KeybindingConflict {
  command: string;
  extensionId: string;
  key: string;
  reason: string;
}

const normal = (shortcut: string) => shortcut.toLowerCase().split("+").sort().join("+");

/** Which contributed shortcuts apply (command → shortcut), and which do not, with why. */
export function resolveKeybindings(
  commands: readonly ContributedCommand[],
  taken: Iterable<string>,
): { shortcuts: Map<string, string>; conflicts: KeybindingConflict[] } {
  const builtIn = new Set([...taken].map(normal));
  const claimed = new Map<string, string>();
  const shortcuts = new Map<string, string>();
  const conflicts: KeybindingConflict[] = [];
  for (const command of commands) {
    if (!command.key) continue;
    const key = normal(command.key);
    if (builtIn.has(key)) {
      conflicts.push({
        command: command.command,
        extensionId: command.extensionId,
        key: command.key,
        reason: `${command.key} is one of Yavin's own shortcuts.`,
      });
      continue;
    }
    const holder = claimed.get(key);
    if (holder) {
      conflicts.push({
        command: command.command,
        extensionId: command.extensionId,
        key: command.key,
        reason: `${command.key} is already used by ${holder}.`,
      });
      continue;
    }
    claimed.set(key, command.command);
    shortcuts.set(command.command, command.key);
  }
  return { shortcuts, conflicts };
}
