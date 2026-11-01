/**
 * How the editor's minimap looks -- what its right-click menu changes, as VS Code's does --
 * remembered on this computer.
 *
 * A convenience of this installation, not part of a project: kept in the webview's storage,
 * and never trusted. Storage can be missing, blocked or hold anything, so reading falls back
 * to the defaults, field by field, and a failure to write is ignored.
 */
export interface MinimapPreferences {
  enabled: boolean;
  /** Draw the characters, or blocks where text is. */
  renderCharacters: boolean;
  /** Proportional: one line per line. Fill and Fit stretch or shrink it to the editor. */
  size: "proportional" | "fill" | "fit";
  /** When the slider showing the visible part is drawn. */
  showSlider: "mouseover" | "always";
}

export const DEFAULT_MINIMAP: MinimapPreferences = {
  enabled: true,
  renderCharacters: true,
  size: "proportional",
  showSlider: "mouseover",
};

const KEY = "yavin.editor.minimap";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

const storage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export function loadMinimapPreferences(from: Storage | null = storage()): MinimapPreferences {
  let saved: Partial<Record<keyof MinimapPreferences, unknown>> = {};
  try {
    const raw = from?.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") saved = parsed;
  } catch {
    // Unreadable or not JSON: the defaults.
  }
  return {
    enabled: typeof saved.enabled === "boolean" ? saved.enabled : DEFAULT_MINIMAP.enabled,
    renderCharacters:
      typeof saved.renderCharacters === "boolean"
        ? saved.renderCharacters
        : DEFAULT_MINIMAP.renderCharacters,
    size:
      saved.size === "proportional" || saved.size === "fill" || saved.size === "fit"
        ? saved.size
        : DEFAULT_MINIMAP.size,
    showSlider:
      saved.showSlider === "mouseover" || saved.showSlider === "always"
        ? saved.showSlider
        : DEFAULT_MINIMAP.showSlider,
  };
}

export function saveMinimapPreferences(
  preferences: MinimapPreferences,
  to: Storage | null = storage(),
): void {
  try {
    to?.setItem(KEY, JSON.stringify(preferences));
  } catch {
    // Full or blocked: the choice still applies until the window closes.
  }
}
