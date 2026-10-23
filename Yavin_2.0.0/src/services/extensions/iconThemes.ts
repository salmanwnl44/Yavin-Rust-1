/**
 * File icon themes (EXT-30): the icons a VS Code icon theme gives files and folders, shown by
 * the explorer and wherever Yavin draws a file's icon (`components/ui/FileIcons.tsx`). Data only,
 * never code: the theme file and its icons come from the native side
 * (`extensions_read_resource`: only the inventory's verified copy of an enabled extension,
 * contained, at most 1 MiB each), and nothing in them is trusted:
 *
 * - **The theme file** is VS Code's icon theme JSON (comments allowed): `iconDefinitions`, the
 *   defaults (`file`, `folder`, `folderExpanded`, `rootFolder`, `rootFolderExpanded`), the maps
 *   (`fileNames`, `fileExtensions`, `languageIds`, `folderNames`, `folderNamesExpanded`,
 *   `rootFolderNames`, `rootFolderNamesExpanded`) and their `light` variants. Bounded: at most
 *   10,000 definitions and 50,000 map entries; anything malformed is left out and said.
 * - **Icons** are SVG files only. An icon's path is resolved against the theme file's folder and
 *   must stay inside the extension's package: not absolute, no drive, no URL, no `..` above its
 *   root. Icons by font character (`fontCharacter`) and PNG icons are not shown, and said.
 * - **Drawn as images**, from a `data:` URL of the SVG's own text: an image never runs an SVG's
 *   scripts or loads what it links to, whatever the file holds. At most 256 KiB an icon; an
 *   icon that cannot be read falls back to Yavin's own.
 *
 * Which theme applies is the `explorer.iconTheme` setting: Yavin's own icons (`yavin`), or an
 * enabled extension's theme (`ext:<extension id>:<theme id>`). A chosen theme whose extension is
 * disabled or uninstalled is not shown -- Yavin's icons are -- and stays chosen for its return.
 */
import { parseJsonc } from "./declarative.ts";
import type { RegistrySnapshot } from "./registry.ts";
import { languageFor } from "../language.ts";
import type { SettingDefinition } from "../settings/settings.ts";

/** Yavin's own icons: the setting's default. */
export const YAVIN_ICONS = "yavin";
/** An extension's icon theme as the setting names it. */
export const EXTENSION_ICON_THEME =
  /^ext:[a-z0-9][a-z0-9.-]{2,100}:[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const MAX_DEFINITIONS = 10_000;
const MAX_ENTRIES = 50_000;
export const MAX_ICON_BYTES = 256 * 1024;
/** Icons kept read at once (a theme has about 1500; a folder shows a few dozen). */
const MAX_LOADED = 3000;

/** The maps of an icon theme (or of its `light` variant): lowercase name → definition id. */
export interface IconMaps {
  file?: string;
  folder?: string;
  folderExpanded?: string;
  rootFolder?: string;
  rootFolderExpanded?: string;
  fileNames: Map<string, string>;
  fileExtensions: Map<string, string>;
  languageIds: Map<string, string>;
  folderNames: Map<string, string>;
  folderNamesExpanded: Map<string, string>;
  rootFolderNames: Map<string, string>;
  rootFolderNamesExpanded: Map<string, string>;
}

/** A theme file, read and checked. */
export interface ParsedIconTheme extends IconMaps {
  /** Definition id → the SVG's path in the package. */
  icons: Map<string, string>;
  light: IconMaps | null;
  /** What of it is not applied, and why. */
  problems: string[];
}

const DEFAULTS = ["file", "folder", "folderExpanded", "rootFolder", "rootFolderExpanded"] as const;
const MAPS = [
  "fileNames",
  "fileExtensions",
  "languageIds",
  "folderNames",
  "folderNamesExpanded",
  "rootFolderNames",
  "rootFolderNamesExpanded",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * `relative` resolved against the folder of `from` (both `/`-separated paths in the package),
 * or null when it leaves the package, names a drive, a URL or an absolute path, or is malformed.
 */
export function resolveInside(from: string, relative: string): string | null {
  if (typeof relative !== "string" || !relative || relative.length > 400) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(relative) || relative.startsWith("/") || relative.includes("\\"))
    return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f<>"|?*]/.test(relative)) return null;
  const parts = from.split("/").slice(0, -1);
  for (const part of relative.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

function mapsOf(
  raw: Record<string, unknown>,
  defined: Set<string>,
  problems: string[],
  count: { entries: number },
  where: string,
): IconMaps {
  const maps: IconMaps = {
    fileNames: new Map(),
    fileExtensions: new Map(),
    languageIds: new Map(),
    folderNames: new Map(),
    folderNamesExpanded: new Map(),
    rootFolderNames: new Map(),
    rootFolderNamesExpanded: new Map(),
  };
  for (const key of DEFAULTS) {
    const id = raw[key];
    if (id === undefined) continue;
    if (typeof id === "string" && defined.has(id)) maps[key] = id;
    else problems.push(`${where}${key} names no icon that is shown.`);
  }
  for (const key of MAPS) {
    const map = raw[key];
    if (map === undefined) continue;
    if (!isRecord(map)) {
      problems.push(`${where}${key} is not a map.`);
      continue;
    }
    let unknown = 0;
    for (const [name, id] of Object.entries(map)) {
      if (count.entries >= MAX_ENTRIES) {
        problems.push(`More than ${MAX_ENTRIES} names: the rest are left out.`);
        return maps;
      }
      count.entries++;
      if (typeof id !== "string" || !defined.has(id) || !name || name.length > 255) {
        unknown++;
        continue;
      }
      maps[key].set(name.toLowerCase(), id);
    }
    if (unknown) problems.push(`${where}${key}: ${unknown} names point at no shown icon.`);
  }
  return maps;
}

/** An icon theme file (`text`, at `path` in the package), checked. Throws when it is not JSON. */
export function parseIconTheme(text: string, path: string): ParsedIconTheme {
  const raw = parseJsonc(text);
  if (!isRecord(raw)) throw new Error("it is not a JSON object");
  const problems: string[] = [];
  const icons = new Map<string, string>();
  const definitions = raw.iconDefinitions;
  if (!isRecord(definitions)) throw new Error("it has no iconDefinitions");
  let fonts = 0;
  let images = 0;
  let outside = 0;
  let empty = 0;
  for (const [id, definition] of Object.entries(definitions)) {
    if (icons.size >= MAX_DEFINITIONS) {
      problems.push(`More than ${MAX_DEFINITIONS} icon definitions: the rest are left out.`);
      break;
    }
    if (!isRecord(definition)) continue;
    if (typeof definition.iconPath !== "string") {
      if (definition.fontCharacter !== undefined) fonts++;
      continue;
    }
    if (!definition.iconPath) {
      empty++;
      continue;
    }
    const resolved = resolveInside(path, definition.iconPath);
    if (!resolved) {
      outside++;
      continue;
    }
    if (!resolved.toLowerCase().endsWith(".svg")) {
      images++;
      continue;
    }
    icons.set(id, resolved);
  }
  if (fonts) problems.push(`${fonts} icons drawn with a font are not shown.`);
  if (images) problems.push(`${images} icons that are not SVG (PNG and others) are not shown.`);
  if (outside) problems.push(`${outside} icons with a path outside the extension are not shown.`);
  if (empty) problems.push(`${empty} icon definitions have no path.`);
  const defined = new Set(icons.keys());
  const count = { entries: 0 };
  const maps = mapsOf(raw, defined, problems, count, "");
  const light = isRecord(raw.light) ? mapsOf(raw.light, defined, problems, count, "light.") : null;
  if (raw.highContrast !== undefined) problems.push("Its high-contrast variant is not applied.");
  if (raw.fonts !== undefined) problems.push("Its fonts are not loaded.");
  return { ...maps, icons, light, problems };
}

/** What an icon is asked for. */
export interface IconQuery {
  name: string;
  isDir: boolean;
  expanded?: boolean;
  /** The workspace's root folder. */
  isRoot?: boolean;
  /** For a file: its language, when known (else from its name). */
  languageId?: string;
  /** The editor shows a light theme: the theme's `light` variant first. */
  light?: boolean;
}

/**
 * The definition id a theme gives `query`, as VS Code chooses: for a file its whole name, then
 * its extensions from the longest (`a.test.ts`: `test.ts`, then `ts`), then its language, then
 * the default file; for a folder its name (expanded or not, root or not), then the default.
 * The `light` variant's answer comes first when the editor is light.
 */
export function iconIdFor(theme: ParsedIconTheme, query: IconQuery): string | null {
  const layers = query.light && theme.light ? [theme.light, theme] : [theme];
  const name = query.name.toLowerCase();
  if (query.isDir) {
    const open = query.expanded;
    const folder: (keyof IconMaps)[] = [
      open ? "folderNamesExpanded" : "folderNames",
      open ? "folderExpanded" : "folder",
    ];
    // A root folder: its own names and default first, then a folder's.
    const order: (keyof IconMaps)[] = query.isRoot
      ? [
          open ? "rootFolderNamesExpanded" : "rootFolderNames",
          folder[0],
          open ? "rootFolderExpanded" : "rootFolder",
          folder[1],
        ]
      : folder;
    for (const key of order)
      for (const layer of layers) {
        const value = layer[key];
        const id = value instanceof Map ? value.get(name) : value;
        if (id) return id;
      }
    return null;
  }
  for (const layer of layers) {
    const id = layer.fileNames.get(name);
    if (id) return id;
  }
  const parts = name.split(".");
  for (let i = 1; i < parts.length; i++) {
    const extension = parts.slice(i).join(".");
    for (const layer of layers) {
      const id = layer.fileExtensions.get(extension);
      if (id) return id;
    }
  }
  const language = (query.languageId ?? languageFor(query.name)).toLowerCase();
  for (const layer of layers) {
    const id = layer.languageIds.get(language);
    if (id) return id;
  }
  for (const layer of layers) if (layer.file) return layer.file;
  return null;
}

/** An SVG icon file's text as an image URL, or null when it is not an SVG Yavin draws. */
export function svgImage(text: string): string | null {
  if (typeof text !== "string" || text.length > MAX_ICON_BYTES) return null;
  const start = text.replace(/^\uFEFF/, "").trimStart();
  // An SVG document: its root element, perhaps after an XML declaration, comments or a DOCTYPE.
  if (!/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(start))
    return null;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(start)}`;
}

/** An extension's icon theme, as the setting offers it. */
export interface IconThemeOption {
  /** `ext:<extension id>:<theme id>`. */
  id: string;
  label: string;
  extensionId: string;
}

export type IconReader = (extensionId: string, path: string) => Promise<string>;

/** What a theme in use is, for the icon lookups. */
interface Loaded {
  option: IconThemeOption;
  copy: string;
  theme: ParsedIconTheme;
}

/**
 * The icon themes enabled extensions contribute, the one chosen, and its icons as they are read
 * (each once, on first use). `version` changes whenever an icon could look different.
 */
export function createIconThemes() {
  let contributed: (IconThemeOption & { copy: string; path: string })[] = [];
  let chosen = YAVIN_ICONS;
  let light = false;
  let read: IconReader | null = null;
  let loaded: Loaded | null = null;
  let loading: string | null = null;
  let problems: Record<string, string[]> = {};
  /** `<copy>\n<path>` → its image (null: not drawable), or pending. */
  let images = new Map<string, string | null>();
  const pending = new Set<string>();
  let version = 0;
  const listeners = new Set<() => void>();
  const changed = () => {
    version++;
    for (const listener of [...listeners])
      try {
        listener();
      } catch {
        /* One listener's failure is not the others'. */
      }
  };

  const active = () => contributed.find((one) => one.id === chosen) ?? null;

  /** Reads the chosen theme's file, if it is not the one loaded. */
  function load() {
    const want = active();
    const key = want ? `${want.copy}\n${want.path}` : null;
    if (!want || !read) {
      if (loaded) {
        loaded = null;
        changed();
      }
      return;
    }
    if (loaded && `${loaded.copy}\n${loaded.option.id}` === `${want.copy}\n${want.id}`) return;
    if (loading === key) return;
    loading = key;
    const reader = read;
    reader(want.extensionId, want.path).then(
      (text) => {
        if (loading !== key) return;
        loading = null;
        try {
          const theme = parseIconTheme(text, want.path);
          problems = { ...problems, [want.id]: theme.problems };
          loaded = { option: want, copy: want.copy, theme };
          images = new Map();
        } catch (error) {
          problems = {
            ...problems,
            [want.id]: [`It could not be read: ${(error as Error).message}`],
          };
          loaded = null;
        }
        changed();
      },
      (error: Error) => {
        if (loading !== key) return;
        loading = null;
        problems = { ...problems, [want.id]: [`It could not be read: ${error.message}`] };
        loaded = null;
        changed();
      },
    );
  }

  return {
    /** The themes enabled extensions contribute, for the setting. */
    list: (): readonly IconThemeOption[] =>
      contributed.map(({ id, label, extensionId }) => ({ id, label, extensionId })),
    /** Follows the registry's enabled extensions' icon themes, read by `reader`. */
    follow(
      registry: { getSnapshot(): RegistrySnapshot; subscribe(listener: () => void): () => void },
      reader: IconReader,
    ) {
      read = reader;
      let known: string | null = null;
      const update = () => {
        const labels = new Map<string, number>();
        const themes = registry.getSnapshot().iconThemes;
        for (const theme of themes) labels.set(theme.label, (labels.get(theme.label) ?? 0) + 1);
        const next = themes.map((theme) => ({
          id: `ext:${theme.extensionId}:${theme.id}`,
          label:
            (labels.get(theme.label) ?? 0) > 1
              ? `${theme.label} (${theme.extensionId})`
              : theme.label,
          extensionId: theme.extensionId,
          copy: theme.copy,
          path: theme.path,
        }));
        // The registry changes for many reasons; icons change only when its icon themes do.
        const key = JSON.stringify(next);
        if (key === known) return;
        known = key;
        contributed = next;
        load();
        changed();
      };
      update();
      return registry.subscribe(update);
    },
    /** The `explorer.iconTheme` setting's value. */
    select(id: string) {
      if (id === chosen) return;
      chosen = id;
      load();
      changed();
    },
    /** Whether the editor shows a light theme (the icon theme's `light` variant then). */
    setLight(value: boolean) {
      if (value === light) return;
      light = value;
      changed();
    },
    /** The theme shown: null while Yavin's own icons are (chosen, or the chosen one absent). */
    shown: (): IconThemeOption | null => (loaded ? loaded.option : null),
    /** What of each theme is not applied. */
    problems: () => problems,
    /**
     * The image for `query` in the theme shown: a `data:` URL, or null for Yavin's own icon
     * (no theme, no icon for it, or not drawable). An icon not read yet is read; listeners hear
     * when it arrives.
     */
    image(query: IconQuery): string | null {
      if (!loaded || !read) return null;
      const id = iconIdFor(loaded.theme, { ...query, light });
      const path = id ? loaded.theme.icons.get(id) : undefined;
      if (!path) return null;
      const key = `${loaded.copy}\n${path}`;
      const known = images.get(key);
      if (known !== undefined) return known;
      if (!pending.has(key) && images.size + pending.size < MAX_LOADED) {
        pending.add(key);
        const theme = loaded;
        read(loaded.option.extensionId, path).then(
          (text) => {
            pending.delete(key);
            if (loaded !== theme) return;
            images.set(key, svgImage(text));
            changed();
          },
          () => {
            pending.delete(key);
            if (loaded !== theme) return;
            images.set(key, null);
            changed();
          },
        );
      }
      return null;
    },
    getVersion: () => version,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type IconThemes = ReturnType<typeof createIconThemes>;

/** The window's icon themes. */
export const iconThemes = createIconThemes();

/**
 * Which file icons Yavin shows (EXT-30): its own, or an enabled extension's icon theme. A chosen
 * theme whose extension is not enabled shows Yavin's icons until it is.
 */
export function iconThemeSetting(themes: IconThemes = iconThemes): SettingDefinition<string> {
  return Object.freeze({
    id: "explorer.iconTheme",
    title: "File Icon Theme",
    description:
      "The icons of files and folders: Yavin's own, or an icon theme an installed extension contributes (its SVG icons).",
    section: "Explorer",
    default: YAVIN_ICONS,
    scopes: ["user"] as const,
    parse: (value: unknown) =>
      typeof value === "string" && (value === YAVIN_ICONS || EXTENSION_ICON_THEME.test(value))
        ? value
        : undefined,
    get control() {
      return {
        kind: "enum" as const,
        options: [
          { value: YAVIN_ICONS, label: "Yavin" },
          ...themes.list().map((one) => ({ value: one.id, label: one.label })),
        ],
      };
    },
  });
}

export const ICON_THEME_SETTING = iconThemeSetting();
