export interface AppCommand {
  id: string;
  menu: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  reason?: string;
  checked?: boolean;
  run: () => void | Promise<void>;
}

export const menuNames = ["File", "Edit", "Selection", "View", "Go", "Terminal", "Help"];

/**
 * The physical key of each punctuation shortcut key. With Shift held, `event.key` is the
 * shifted character (Shift+\` is "~" on a US layout), so a shortcut such as `Mod+Shift+\``
 * never matched by `key` alone; the key's position (`event.code`) does.
 */
const PUNCTUATION_CODES: Record<string, string> = {
  "`": "Backquote",
  "-": "Minus",
  "=": "Equal",
  "[": "BracketLeft",
  "]": "BracketRight",
  "\\": "Backslash",
  ";": "Semicolon",
  "'": "Quote",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
};

export function matchesShortcut(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"> & {
    code?: string;
  },
  shortcut: string,
): boolean {
  const parts = shortcut.toLowerCase().split("+");
  const key = parts.pop() ?? "";
  const sameKey =
    event.key.toLowerCase() === key ||
    (PUNCTUATION_CODES[key] !== undefined && event.code === PUNCTUATION_CODES[key]);
  return (
    sameKey &&
    (event.ctrlKey || event.metaKey) === parts.includes("mod") &&
    event.altKey === parts.includes("alt") &&
    event.shiftKey === parts.includes("shift")
  );
}

export function shortcutLabel(shortcut: string): string {
  const mac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
  return shortcut.replace("Mod", mac ? "⌘" : "Ctrl");
}
