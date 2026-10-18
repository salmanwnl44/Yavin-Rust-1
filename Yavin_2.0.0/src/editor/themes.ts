/**
 * The editor's colour themes: Yavin's own, and those extensions contribute (EXT-04,
 * `services/extensions/declarative.ts`, defined in Monaco by `declarativeMonaco.ts`). The
 * `editor.theme` setting offers this list; a chosen theme that is no longer here (its extension
 * disabled or uninstalled) resolves to Yavin Dark, and the choice is kept for when it returns.
 */

export interface EditorTheme {
  id: string;
  label: string;
}

export const BUILTIN_THEMES: readonly EditorTheme[] = [
  { id: "yavin-dark", label: "Yavin Dark" },
  { id: "yavin-light", label: "Yavin Light" },
];
export const DEFAULT_THEME = "yavin-dark";
/** An extension theme's id: `ext:<extension id>:<index>`. */
export const EXTENSION_THEME = /^ext:[a-z0-9][a-z0-9.-]{2,100}:\d{1,2}$/;

/**
 * The Monaco name of theme `id`. Monaco takes only letters, digits and `-` in a theme's name, so an
 * extension theme's id is escaped -- one to one: `-` → `--`, `.` → `-d`, `:` → `-c`.
 */
export const monacoThemeName = (id: string) =>
  BUILTIN_THEMES.some((one) => one.id === id)
    ? id
    : `yavin-${id.replace(/[-.:]/g, (c) => (c === "-" ? "--" : c === "." ? "-d" : "-c"))}`;

let contributed: readonly EditorTheme[] = [];
const listeners = new Set<() => void>();

/**
 * Offers `store`'s themes in the theme setting as they come and go (EXT-04). No Monaco here:
 * the editor defines them (`declarativeMonaco.ts`), so the window does not load it early.
 */
export function followContributedThemes(store: {
  getSnapshot(): { themes: readonly EditorTheme[] };
  subscribe(listener: () => void): () => void;
}): () => void {
  const follow = () =>
    editorThemes.setContributed(
      store.getSnapshot().themes.map((one) => ({ id: one.id, label: one.label })),
    );
  follow();
  return store.subscribe(follow);
}

export const editorThemes = {
  list: (): readonly EditorTheme[] => [...BUILTIN_THEMES, ...contributed],
  has: (id: string) =>
    BUILTIN_THEMES.some((one) => one.id === id) || contributed.some((one) => one.id === id),
  /** The theme to show for `id`: itself while it exists, else Yavin Dark. */
  resolve: (id: string) => (editorThemes.has(id) ? id : DEFAULT_THEME),
  /** Extensions' themes now (already defined in the editor). */
  setContributed(themes: readonly EditorTheme[]) {
    // Nothing changed, nothing to hear: an editor told of a change re-applies its options.
    const same =
      themes.length === contributed.length &&
      themes.every((one, i) => one.id === contributed[i].id && one.label === contributed[i].label);
    if (same) return;
    contributed = themes;
    for (const listener of [...listeners])
      try {
        listener();
      } catch {
        /* One listener's failure is not the others'. */
      }
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
