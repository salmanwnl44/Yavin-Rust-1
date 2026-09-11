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

export function matchesShortcut(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
  shortcut: string,
): boolean {
  const parts = shortcut.toLowerCase().split("+");
  const key = parts.pop();
  return (
    event.key.toLowerCase() === key &&
    (event.ctrlKey || event.metaKey) === parts.includes("mod") &&
    event.altKey === parts.includes("alt") &&
    event.shiftKey === parts.includes("shift")
  );
}

export function shortcutLabel(shortcut: string): string {
  const mac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
  return shortcut.replace("Mod", mac ? "⌘" : "Ctrl");
}
