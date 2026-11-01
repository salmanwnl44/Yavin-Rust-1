/**
 * The extension manifest (IDE-07): what an extension is and what it contributes, as plain data,
 * validated before anything of it is used. Versioned by `manifestVersion`; an extension states
 * which extension API it needs with `engines.yavin` (a semver range against `EXTENSION_API`).
 *
 * Identity is `publisher.name` -- never the display name -- and is the one key for the
 * extension everywhere: the registry, its activation, the commands, views and settings it
 * contributes (all namespaced by it), its storage, its output channel and its errors. Its rule
 * is `identity.ts`, the native side's too (EXT-02).
 */
import { ID_PART, MAX_ID_PART } from "./identity.ts";
import { declaredPermissions, type DeclaredPermissions } from "./permissions.ts";

/** The extension API this Yavin provides. Bumped on a breaking change to `api.ts`. */
export const EXTENSION_API = "2.1.0";
/** The manifest formats this Yavin reads. */
export const MANIFEST_VERSION = 1;
/** The manifest's file name in an extension's folder. */
export const MANIFEST_FILE = "yavin-extension.json";

export type ActivationEvent =
  | { kind: "startup" }
  | { kind: "workspace" }
  | { kind: "command"; id: string }
  | { kind: "view"; id: string }
  | { kind: "language"; id: string };

export interface CommandContribution {
  /** `<extensionId>.<name>`. */
  command: string;
  title: string;
  category: string | null;
}

export interface KeybindingContribution {
  command: string;
  /** In the window's shortcut syntax: `Mod+Shift+k`, `F7`, `Alt+x`. */
  key: string;
}

export type SettingType = "boolean" | "number" | "string" | "enum";

export interface SettingContribution {
  /** `<extensionId>.<name>`. */
  id: string;
  title: string;
  description: string;
  type: SettingType;
  default: boolean | number | string;
  /** `enum`: the allowed values. */
  values: string[];
  minimum: number | null;
  maximum: number | null;
  scope: "user" | "both";
}

export interface ViewContribution {
  /** `<extensionId>.<name>`. */
  id: string;
  name: string;
  /**
   * `sidebar`: the Extensions side bar; `panel`: a tab of the bottom panel; `container`: its
   * own Activity Bar container (`container` names it).
   */
  location: "sidebar" | "panel" | "container";
  container: string | null;
}

/** An Activity Bar entry of an extension's own, holding its `container` views. */
export interface ViewContainerContribution {
  /** `<extensionId>.<name>`. */
  id: string;
  title: string;
}

/** When a menu item applies: one equality on what the menu is about. */
export interface WhenClause {
  key: "resourceExtname" | "resourceLangId";
  value: string;
}

export type MenuLocation = "commandPalette" | "view/title" | "editor/context" | "explorer/context";

export interface MenuContribution {
  location: MenuLocation;
  command: string;
  /** `view/title`: the view the action belongs to (one of this extension's). */
  view: string | null;
  /** `commandPalette`: false hides the command from the palette (it still runs from elsewhere). */
  visible: boolean;
  /** `editor/context`, `explorer/context`: shown only for what this matches (null: always). */
  when: WhenClause | null;
}

/** A colour theme (EXT-04): a VS Code colour theme file, applied to the editor. */
export interface ThemeContribution {
  label: string;
  /** The Monaco base it builds on. */
  uiTheme: "vs" | "vs-dark" | "hc-black" | "hc-light";
  /** The theme file, relative to the extension's folder. */
  path: string;
}

/**
 * A file icon theme (EXT-30): a VS Code icon theme file, whose SVG icons the explorer and the
 * editor's tabs show (`services/extensions/iconThemes.ts`).
 */
export interface IconThemeContribution {
  /** Its VS Code id: what the `explorer.iconTheme` setting names, with its extension. */
  id: string;
  label: string;
  /** The theme file, relative to the extension's folder. */
  path: string;
}

/** Snippets for one language (EXT-04): a VS Code snippets file. */
export interface SnippetContribution {
  language: string;
  path: string;
}

/**
 * A language (EXT-25): an id, the files that are written in it (by extension or whole name),
 * and its language configuration file (comments, brackets, auto-closing pairs, indentation).
 */
export interface LanguageContribution {
  id: string;
  extensions: string[];
  filenames: string[];
  aliases: string[];
  /** A VS Code `language-configuration.json`, relative to the extension's folder. */
  configuration: string | null;
}

/** A TextMate grammar (EXT-25): tokens for its language, from a `.tmLanguage(.json)` file. */
export interface GrammarContribution {
  scopeName: string;
  path: string;
  /** The language it colours; null for a grammar only others embed. */
  language: string | null;
  /** Scopes inside it that are other languages. */
  embeddedLanguages: Record<string, string>;
}

export interface Contributions {
  commands: CommandContribution[];
  keybindings: KeybindingContribution[];
  settings: SettingContribution[];
  views: ViewContribution[];
  viewContainers: ViewContainerContribution[];
  menus: MenuContribution[];
  themes: ThemeContribution[];
  iconThemes: IconThemeContribution[];
  snippets: SnippetContribution[];
  languages: LanguageContribution[];
  grammars: GrammarContribution[];
}

/**
 * A VS Code package this manifest was made from (EXT-04, `src-tauri/src/vsix.rs`): its
 * published spelling, and what of it Yavin uses, leaves out and refused.
 */
/**
 * A VS Code extension's code, as the compatibility layer runs it (EXT-25): the entry point it
 * chose, the API level, and the Yavin ids the adapter gave its commands, settings and views
 * (Yavin id → VS Code id), with the defaults of settings Yavin cannot show.
 */
export interface VscodeRuntime {
  entry: "main" | "browser";
  level: string;
  commands: Record<string, string>;
  settings: Record<string, string>;
  views: Record<string, string>;
  defaults: Record<string, unknown>;
}

export interface VsixOrigin {
  publisher: string | null;
  name: string | null;
  /** Its `engines.vscode` range. */
  vscode: string | null;
  /** It has code (`main`, `browser`); it runs only when `runtime` says how (EXT-25). */
  code: boolean;
  /** Its code runs through the VS Code compatibility layer (EXT-25); null: it does not run. */
  runtime: VscodeRuntime | null;
  supported: string[];
  ignored: string[];
  rejected: string[];
  /**
   * Fixed: the manifest itself makes no claim about a signature. What the package's signature
   * was found to be is the inventory's record (EXT-09, `NativeSignature`), never the manifest's.
   */
  signature: "not verified";
}

export interface ExtensionManifest {
  manifestVersion: number;
  /** `publisher.name`, lower case. */
  id: string;
  name: string;
  publisher: string;
  displayName: string;
  version: string;
  description: string | null;
  /** The extension API range it needs (`engines.yavin`); `*` when absent. */
  engine: string;
  activationEvents: ActivationEvent[];
  /** Its code's entry point, relative to its folder; null for a declarative extension. */
  main: string | null;
  contributes: Contributions;
  /** Runs its code in an untrusted folder (`capabilities.untrustedWorkspaces: true`). */
  untrustedWorkspaces: boolean;
  /** Extensions that must be enabled, compatible and active first (`extensionDependencies`). */
  dependencies: string[];
  /** Ones it uses when they are installed and enabled, and runs without (EXT-12). */
  optionalDependencies: string[];
  /** Made from a VS Code package (EXT-04); null for a Yavin extension. */
  vsix: VsixOrigin | null;
  /** What it asks to be allowed (`permissions`, EXT-07): granted only by the user. */
  permissions: DeclaredPermissions;
}

/** One thing wrong with a manifest. `field` is a JSON path into it. */
export interface ManifestProblem {
  field: string;
  message: string;
  /** A warning is reported and the rest is used; an error rejects the extension. */
  severity: "error" | "warning";
}

export type ManifestResult =
  | { ok: true; manifest: ExtensionManifest; warnings: ManifestProblem[] }
  | { ok: false; problems: ManifestProblem[]; id: string | null };

const PART = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-.]+)?$/;
const KEY = /^((Mod|Shift|Alt)\+){0,3}([a-z0-9]|F([1-9]|1[0-2])|[`\-=[\]\\;',./])$/i;
const LANGUAGE = /^[a-z0-9][a-z0-9+#._-]{0,49}$/i;
const SCOPE = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,99}$/;

const oneLine = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(value);

export const isSemver = (value: unknown): value is string =>
  typeof value === "string" && SEMVER.test(value);

const parts = (version: string) => version.split(/[-+]/)[0].split(".").map(Number);

/** Whether `version` satisfies `range`: `*`, an exact version, `^x.y.z`, `~x.y.z` or `>=x.y.z`. */
export function satisfies(version: string, range: string): boolean | null {
  const trimmed = range.trim();
  if (trimmed === "*") return true;
  const match = /^(\^|~|>=)?(.+)$/.exec(trimmed);
  if (!match || !isSemver(match[2])) return null;
  const [major, minor, patch] = parts(version);
  const [wantMajor, wantMinor, wantPatch] = parts(match[2]);
  const atLeast =
    major !== wantMajor
      ? major > wantMajor
      : minor !== wantMinor
        ? minor > wantMinor
        : patch >= wantPatch;
  switch (match[1]) {
    case ">=":
      return atLeast;
    case "^":
      return atLeast && major === wantMajor && (wantMajor !== 0 || minor === wantMinor);
    case "~":
      return atLeast && major === wantMajor && minor === wantMinor;
    default:
      return major === wantMajor && minor === wantMinor && patch === wantPatch;
  }
}

/** The contribution points this Yavin understands; anything else is reported, not fatal. */
const CONTRIBUTION_POINTS = new Set([
  "commands",
  "keybindings",
  "configuration",
  "views",
  "viewsContainers",
  "menus",
  "themes",
  "iconThemes",
  "snippets",
  "languages",
  "grammars",
]);
/** A file icon theme's id (EXT-30): as the VS Code package adapter keeps them. */
const ICON_THEME_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const UI_THEMES = new Set(["vs", "vs-dark", "hc-black", "hc-light"]);
/** A path inside the extension's folder: no `..`, no drive, not absolute. */
const insidePath = (value: unknown): value is string =>
  oneLine(value, 300) &&
  !/(^|[\\/])\.\.([\\/]|$)/.test(value) &&
  !/^([a-z]:|[\\/])/i.test(value) &&
  !value.includes("\\");
const MENU_LOCATIONS = new Set<MenuLocation>([
  "commandPalette",
  "view/title",
  "editor/context",
  "explorer/context",
]);

/** A manifest as Yavin may use it, or every reason it may not. */
export function readManifest(value: unknown): ManifestResult {
  const problems: ManifestProblem[] = [];
  const error = (field: string, message: string) =>
    problems.push({ field, message, severity: "error" });
  const warn = (field: string, message: string) =>
    problems.push({ field, message, severity: "warning" });

  if (!value || typeof value !== "object" || Array.isArray(value))
    return {
      ok: false,
      id: null,
      problems: [{ field: "", message: "The manifest is not an object.", severity: "error" }],
    };
  const raw = value as Record<string, unknown>;

  const manifestVersion = raw.manifestVersion ?? 1;
  if (manifestVersion !== MANIFEST_VERSION)
    error(
      "manifestVersion",
      `This Yavin reads manifest version ${MANIFEST_VERSION}, not ${JSON.stringify(manifestVersion)}.`,
    );
  if (typeof raw.publisher !== "string" || !ID_PART.test(raw.publisher))
    error(
      "publisher",
      `Needs a publisher: lower-case letters, digits and "-" (at most ${MAX_ID_PART}).`,
    );
  if (typeof raw.name !== "string" || !ID_PART.test(raw.name))
    error("name", `Needs a name: lower-case letters, digits and "-" (at most ${MAX_ID_PART}).`);
  const id =
    typeof raw.publisher === "string" && typeof raw.name === "string"
      ? `${raw.publisher}.${raw.name}`
      : null;
  if (raw.id !== undefined && raw.id !== id)
    error("id", `The id is "publisher.name" (${id ?? "unknown"}), not ${JSON.stringify(raw.id)}.`);
  if (!isSemver(raw.version)) error("version", "Needs a semantic version, like 1.0.0.");
  const displayName = raw.displayName ?? raw.name;
  if (!oneLine(displayName, 100))
    error("displayName", "Must be one line of at most 100 characters.");
  const description = raw.description ?? null;
  if (description !== null && !oneLine(description, 500))
    error("description", "Must be one line of at most 500 characters.");

  let engine = "*";
  if (raw.engines !== undefined) {
    const engines = raw.engines as Record<string, unknown> | null;
    if (!engines || typeof engines !== "object" || typeof engines.yavin !== "string")
      error("engines.yavin", "Must state the Yavin extension API range, like ^1.0.0.");
    else {
      engine = engines.yavin;
      const fits = satisfies(EXTENSION_API, engine);
      // A range this simple reader does not know is not refused here: the native side decides
      // (EXT-12, `extension_dependencies.rs`), with the semver rules this only approximates.
      if (fits === null)
        warn("engines.yavin", `"${engine}" is checked when it is installed and loaded.`);
      else if (!fits)
        error(
          "engines.yavin",
          `Needs extension API ${engine}; this Yavin provides ${EXTENSION_API}.`,
        );
    }
  }

  const main = raw.main ?? null;
  if (
    main !== null &&
    (!oneLine(main, 200) || /(^|[\\/])\.\.([\\/]|$)/.test(main) || /^([a-z]:|[\\/])/i.test(main))
  )
    error("main", "Must be a path inside the extension's folder.");

  // An extension with code must say which API it supports (EXT-12): as natively.
  if (raw.main !== undefined && raw.main !== null && raw.engines === undefined)
    error(
      "engines.yavin",
      "An extension with code must state the extension API range it supports.",
    );

  const dependencies: string[] = [];
  const optionalDependencies: string[] = [];
  const isId = (value: unknown): value is string =>
    typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,49}\.[a-z0-9][a-z0-9-]{0,49}$/.test(value);
  if (raw.extensionDependencies !== undefined) {
    if (!Array.isArray(raw.extensionDependencies))
      error("extensionDependencies", "Must be a list of extension ids.");
    else
      raw.extensionDependencies.forEach((dependency, index) => {
        const field = `extensionDependencies[${index}]`;
        if (
          typeof dependency !== "string" ||
          !/^[a-z0-9][a-z0-9-]{0,49}\.[a-z0-9][a-z0-9-]{0,49}$/.test(dependency)
        )
          return error(field, "Must be an extension id (publisher.name).");
        if (dependency === id) return error(field, "An extension cannot depend on itself.");
        if (dependencies.includes(dependency))
          return error(field, `"${dependency}" is listed twice.`);
        dependencies.push(dependency);
      });
  }
  // EXT-12: `{"publisher.name": "<range>" | {"version": "<range>", "optional": true}}`. Ranges
  // are checked natively; here only what each entry is.
  if (raw.dependencies !== undefined) {
    const map = raw.dependencies as Record<string, unknown> | null;
    if (!map || typeof map !== "object" || Array.isArray(map))
      error("dependencies", "Must be an object of extension ids and version ranges.");
    else
      for (const [dependency, spec] of Object.entries(map)) {
        const field = `dependencies.${dependency}`;
        if (!isId(dependency)) {
          error(field, "Must be an extension id (publisher.name).");
          continue;
        }
        if (dependency === id) {
          error(field, "An extension cannot depend on itself.");
          continue;
        }
        if (dependencies.includes(dependency) || optionalDependencies.includes(dependency)) {
          error(field, `"${dependency}" is listed twice.`);
          continue;
        }
        const object = spec as Record<string, unknown> | null;
        const optional =
          typeof spec === "object" && spec !== null && !Array.isArray(spec)
            ? object!.optional === true
            : false;
        const range =
          typeof spec === "string"
            ? spec
            : typeof spec === "object" && spec !== null && !Array.isArray(spec)
              ? object!.version
              : undefined;
        if (!oneLine(range, 100)) {
          error(field, "Must be a version range, or {version, optional}.");
          continue;
        }
        (optional ? optionalDependencies : dependencies).push(dependency);
      }
  }
  if (raw.incompatibilities !== undefined) {
    const map = raw.incompatibilities as Record<string, unknown> | null;
    if (!map || typeof map !== "object" || Array.isArray(map))
      error("incompatibilities", "Must be an object of extension ids and version ranges.");
    else
      for (const [other, range] of Object.entries(map))
        if (!isId(other) || other === id || !oneLine(range, 100))
          error(
            `incompatibilities.${other}`,
            "Must be another extension's id and a version range.",
          );
  }

  const capabilities = (raw.capabilities ?? {}) as Record<string, unknown>;
  const untrustedWorkspaces = capabilities.untrustedWorkspaces === true;

  // What it asks to be allowed (EXT-07): a declaration this Yavin cannot read rejects it.
  const declared = declaredPermissions(raw, id ?? "");
  if (!declared.ok) error("permissions", `${declared.error}.`);
  const permissions = declared.ok ? declared.value : { legacy: true, requested: [] };

  const prefix = id ? `${id}.` : "\u0000";
  const owned = (value: unknown): value is string =>
    typeof value === "string" && value.startsWith(prefix) && PART.test(value.slice(prefix.length));

  // --- Activation events -------------------------------------------------------------------
  const activationEvents: ActivationEvent[] = [];
  const events = raw.activationEvents ?? [];
  if (!Array.isArray(events)) error("activationEvents", "Must be a list.");
  else
    events.forEach((event, index) => {
      const field = `activationEvents[${index}]`;
      if (event === "onStartupFinished" || event === "*")
        activationEvents.push({ kind: "startup" });
      else if (event === "onWorkspace") activationEvents.push({ kind: "workspace" });
      else if (typeof event === "string" && event.startsWith("onCommand:"))
        activationEvents.push({ kind: "command", id: event.slice("onCommand:".length) });
      else if (typeof event === "string" && event.startsWith("onView:"))
        activationEvents.push({ kind: "view", id: event.slice("onView:".length) });
      else if (
        typeof event === "string" &&
        event.startsWith("onLanguage:") &&
        LANGUAGE.test(event.slice("onLanguage:".length))
      )
        activationEvents.push({ kind: "language", id: event.slice("onLanguage:".length) });
      else warn(field, `${JSON.stringify(event)} is not an activation event this Yavin knows.`);
    });

  // --- Contributions -----------------------------------------------------------------------
  const contributes: Contributions = {
    commands: [],
    keybindings: [],
    settings: [],
    views: [],
    viewContainers: [],
    menus: [],
    themes: [],
    iconThemes: [],
    snippets: [],
    languages: [],
    grammars: [],
  };
  const rawContributes = (raw.contributes ?? {}) as Record<string, unknown>;
  if (typeof rawContributes !== "object" || Array.isArray(rawContributes))
    error("contributes", "Must be an object.");
  else {
    for (const key of Object.keys(rawContributes))
      if (!CONTRIBUTION_POINTS.has(key))
        warn(
          `contributes.${key}`,
          `"${key}" is not a contribution point this Yavin supports; ignored.`,
        );

    const list = (key: string) => {
      const value = rawContributes[key];
      if (value === undefined) return [];
      if (!Array.isArray(value)) {
        error(`contributes.${key}`, "Must be a list.");
        return [];
      }
      return value as unknown[];
    };

    const commandIds = new Set<string>();
    list("commands").forEach((entry, index) => {
      const field = `contributes.commands[${index}]`;
      const command = entry as Record<string, unknown>;
      if (!command || typeof command !== "object") return error(field, "Must be an object.");
      if (!owned(command.command))
        return error(`${field}.command`, `Must be "${id ?? "publisher.name"}.<name>".`);
      if (commandIds.has(command.command))
        return error(`${field}.command`, `"${command.command}" is contributed twice.`);
      if (!oneLine(command.title, 100)) return error(`${field}.title`, "Needs a one-line title.");
      const category = command.category ?? null;
      if (category !== null && !oneLine(category, 50))
        return error(`${field}.category`, "Must be one line of at most 50 characters.");
      commandIds.add(command.command);
      contributes.commands.push({ command: command.command, title: command.title, category });
    });

    list("keybindings").forEach((entry, index) => {
      const field = `contributes.keybindings[${index}]`;
      const binding = entry as Record<string, unknown>;
      if (!binding || typeof binding !== "object") return error(field, "Must be an object.");
      if (typeof binding.command !== "string" || !commandIds.has(binding.command))
        return error(`${field}.command`, "Must be one of this extension's commands.");
      if (typeof binding.key !== "string" || !KEY.test(binding.key))
        return error(
          `${field}.key`,
          `${JSON.stringify(binding.key)} is not a shortcut (like Mod+Shift+k).`,
        );
      contributes.keybindings.push({ command: binding.command, key: binding.key });
    });

    const configuration = rawContributes.configuration;
    if (configuration !== undefined) {
      const properties = (configuration as { properties?: unknown })?.properties;
      if (!properties || typeof properties !== "object" || Array.isArray(properties))
        error("contributes.configuration.properties", "Must be an object of settings.");
      else
        for (const [key, entry] of Object.entries(properties as Record<string, unknown>)) {
          const field = `contributes.configuration.properties.${key}`;
          if (!owned(key)) {
            error(field, `A setting is "${id ?? "publisher.name"}.<name>".`);
            continue;
          }
          const setting = entry as Record<string, unknown>;
          if (!setting || typeof setting !== "object") {
            error(field, "Must be an object.");
            continue;
          }
          const type = setting.enum !== undefined ? "enum" : setting.type;
          const title = setting.title ?? key.slice(prefix.length);
          if (!oneLine(title, 100)) {
            error(`${field}.title`, "Must be one line of at most 100 characters.");
            continue;
          }
          if (!oneLine(setting.description, 500)) {
            error(`${field}.description`, "Needs a one-line description.");
            continue;
          }
          const scope = setting.scope ?? "both";
          if (scope !== "user" && scope !== "both") {
            error(`${field}.scope`, 'Must be "user" or "both".');
            continue;
          }
          const values =
            type === "enum" && Array.isArray(setting.enum) ? (setting.enum as unknown[]) : [];
          const defaultOk =
            type === "boolean"
              ? typeof setting.default === "boolean"
              : type === "number"
                ? typeof setting.default === "number" && Number.isFinite(setting.default)
                : type === "string"
                  ? typeof setting.default === "string" && setting.default.length <= 1000
                  : type === "enum"
                    ? values.length > 0 &&
                      values.every((one) => oneLine(one, 100)) &&
                      (values as unknown[]).includes(setting.default)
                    : false;
          if (!["boolean", "number", "string", "enum"].includes(String(type))) {
            error(`${field}.type`, 'Must be "boolean", "number" or "string", or give "enum".');
            continue;
          }
          if (!defaultOk) {
            error(`${field}.default`, `Needs a default that is a valid ${type}.`);
            continue;
          }
          const bound = (name: "minimum" | "maximum") =>
            typeof setting[name] === "number" && Number.isFinite(setting[name])
              ? (setting[name] as number)
              : null;
          const minimum = bound("minimum");
          const maximum = bound("maximum");
          if (type === "number" && minimum !== null && maximum !== null && minimum > maximum) {
            error(field, "Its minimum is above its maximum.");
            continue;
          }
          if (
            type === "number" &&
            ((minimum !== null && (setting.default as number) < minimum) ||
              (maximum !== null && (setting.default as number) > maximum))
          ) {
            error(`${field}.default`, "Its default is outside its minimum and maximum.");
            continue;
          }
          contributes.settings.push({
            id: key,
            title,
            description: setting.description as string,
            type: type as SettingType,
            default: setting.default as boolean | number | string,
            values: values as string[],
            minimum,
            maximum,
            scope,
          });
        }
    }

    const containerIds = new Set<string>();
    const containers = rawContributes.viewsContainers as Record<string, unknown> | undefined;
    if (containers !== undefined) {
      const activitybar = containers?.activitybar;
      if (!Array.isArray(activitybar))
        error("contributes.viewsContainers.activitybar", "Must be a list of containers.");
      else
        activitybar.forEach((entry, index) => {
          const field = `contributes.viewsContainers.activitybar[${index}]`;
          const container = entry as Record<string, unknown>;
          if (!container || typeof container !== "object")
            return error(field, "Must be an object.");
          if (!owned(container.id))
            return error(`${field}.id`, `Must be "${id ?? "publisher.name"}.<name>".`);
          if (containerIds.has(container.id))
            return error(`${field}.id`, `"${container.id}" is contributed twice.`);
          if (!oneLine(container.title, 60))
            return error(`${field}.title`, "Needs a one-line title.");
          containerIds.add(container.id);
          contributes.viewContainers.push({ id: container.id, title: container.title });
        });
    }

    const viewIds = new Set<string>();
    list("views").forEach((entry, index) => {
      const field = `contributes.views[${index}]`;
      const view = entry as Record<string, unknown>;
      if (!view || typeof view !== "object") return error(field, "Must be an object.");
      if (!owned(view.id))
        return error(`${field}.id`, `Must be "${id ?? "publisher.name"}.<name>".`);
      if (viewIds.has(view.id)) return error(`${field}.id`, `"${view.id}" is contributed twice.`);
      if (!oneLine(view.name, 60)) return error(`${field}.name`, "Needs a one-line name.");
      const location = view.location ?? (view.container !== undefined ? "container" : "sidebar");
      if (location !== "sidebar" && location !== "panel" && location !== "container")
        return error(`${field}.location`, 'Must be "sidebar", "panel" or "container".');
      let container: string | null = null;
      if (location === "container") {
        if (typeof view.container !== "string" || !containerIds.has(view.container))
          return error(`${field}.container`, "Must be one of this extension's view containers.");
        container = view.container;
      }
      viewIds.add(view.id);
      contributes.views.push({ id: view.id, name: view.name, location, container });
    });

    const menus = rawContributes.menus;
    if (menus !== undefined) {
      if (!menus || typeof menus !== "object" || Array.isArray(menus))
        error("contributes.menus", "Must be an object of menu locations.");
      else
        for (const [location, items] of Object.entries(menus as Record<string, unknown>)) {
          const field = `contributes.menus.${location}`;
          if (!MENU_LOCATIONS.has(location as MenuLocation)) {
            warn(field, `"${location}" is not a menu this Yavin supports; ignored.`);
            continue;
          }
          if (!Array.isArray(items)) {
            error(field, "Must be a list.");
            continue;
          }
          items.forEach((entry, index) => {
            const item = entry as Record<string, unknown>;
            const at = `${field}[${index}]`;
            if (!item || typeof item !== "object") return error(at, "Must be an object.");
            if (typeof item.command !== "string" || !commandIds.has(item.command))
              return error(`${at}.command`, "Must be one of this extension's commands.");
            let view: string | null = null;
            if (location === "view/title") {
              if (typeof item.view !== "string" || !viewIds.has(item.view))
                return error(`${at}.view`, "Must be one of this extension's views.");
              view = item.view;
            }
            let when: WhenClause | null = null;
            if (
              (location === "editor/context" || location === "explorer/context") &&
              item.when !== undefined
            ) {
              const match =
                typeof item.when === "string"
                  ? /^(resourceExtname|resourceLangId) == ([A-Za-z0-9._+#-]{1,40})$/.exec(
                      item.when.trim(),
                    )
                  : null;
              if (!match)
                return error(
                  `${at}.when`,
                  'Must be "resourceExtname == .ext" or "resourceLangId == id" (no other conditions are supported).',
                );
              when = { key: match[1] as WhenClause["key"], value: match[2] };
            }
            const duplicate = contributes.menus.some(
              (existing) =>
                existing.location === location &&
                existing.command === item.command &&
                existing.view === view,
            );
            if (duplicate) return error(at, `"${item.command}" is in this menu twice.`);
            contributes.menus.push({
              location: location as MenuLocation,
              command: item.command,
              view,
              visible: item.when !== "false" && item.when !== false,
              when,
            });
          });
        }
    }

    // Colour themes and snippets (EXT-04): data files, read and checked when applied.
    list("themes").forEach((entry, index) => {
      const field = `contributes.themes[${index}]`;
      const theme = entry as Record<string, unknown>;
      if (!theme || typeof theme !== "object") return error(field, "Must be an object.");
      if (!oneLine(theme.label, 100)) return error(`${field}.label`, "Needs a label (one line).");
      if (typeof theme.uiTheme !== "string" || !UI_THEMES.has(theme.uiTheme))
        return error(`${field}.uiTheme`, 'Must be "vs", "vs-dark", "hc-black" or "hc-light".');
      if (!insidePath(theme.path))
        return error(`${field}.path`, "Must be a path inside the extension's folder.");
      if (contributes.themes.some((existing) => existing.label === theme.label))
        return error(field, `The theme "${theme.label}" is contributed twice.`);
      contributes.themes.push({
        label: theme.label as string,
        uiTheme: theme.uiTheme as ThemeContribution["uiTheme"],
        path: theme.path,
      });
    });
    // File icon themes (EXT-30): data files, read and checked when applied.
    list("iconThemes").forEach((entry, index) => {
      const field = `contributes.iconThemes[${index}]`;
      const theme = entry as Record<string, unknown>;
      if (!theme || typeof theme !== "object") return error(field, "Must be an object.");
      if (typeof theme.id !== "string" || !ICON_THEME_ID.test(theme.id))
        return error(`${field}.id`, "Must be an id: letters, digits, '.', '_' and '-'.");
      if (!oneLine(theme.label, 100)) return error(`${field}.label`, "Needs a label (one line).");
      if (!insidePath(theme.path) || !theme.path.toLowerCase().endsWith(".json"))
        return error(`${field}.path`, "Must be a JSON file inside the extension's folder.");
      if (contributes.iconThemes.some((existing) => existing.id === theme.id))
        return error(field, `The icon theme "${theme.id}" is contributed twice.`);
      contributes.iconThemes.push({ id: theme.id, label: theme.label as string, path: theme.path });
    });
    list("snippets").forEach((entry, index) => {
      const field = `contributes.snippets[${index}]`;
      const snippet = entry as Record<string, unknown>;
      if (!snippet || typeof snippet !== "object") return error(field, "Must be an object.");
      if (typeof snippet.language !== "string" || !LANGUAGE.test(snippet.language))
        return error(`${field}.language`, "Must be a language id.");
      if (!insidePath(snippet.path))
        return error(`${field}.path`, "Must be a path inside the extension's folder.");
      contributes.snippets.push({ language: snippet.language, path: snippet.path });
    });

    // Languages and TextMate grammars (EXT-25): data files, read and checked when applied.
    const strings = (value: unknown, ok: (one: string) => boolean) =>
      Array.isArray(value) &&
      value.length <= 50 &&
      value.every((one) => typeof one === "string" && ok(one))
        ? (value as string[])
        : null;
    list("languages").forEach((entry, index) => {
      const field = `contributes.languages[${index}]`;
      const language = entry as Record<string, unknown>;
      if (!language || typeof language !== "object") return error(field, "Must be an object.");
      if (typeof language.id !== "string" || !LANGUAGE.test(language.id))
        return error(`${field}.id`, "Must be a language id.");
      const extensions = strings(language.extensions ?? [], (one) =>
        /^\.[A-Za-z0-9._+-]{1,30}$/.test(one),
      );
      const filenames = strings(
        language.filenames ?? [],
        (one) => oneLine(one, 100) && !/[\\/]/.test(one),
      );
      const aliases = strings(language.aliases ?? [], (one) => oneLine(one, 50));
      if (!extensions)
        return error(`${field}.extensions`, 'Must be a list of extensions, like ".x".');
      if (!filenames) return error(`${field}.filenames`, "Must be a list of file names.");
      if (!aliases) return error(`${field}.aliases`, "Must be a list of names.");
      const configuration = language.configuration ?? null;
      if (configuration !== null && !insidePath(configuration))
        return error(`${field}.configuration`, "Must be a path inside the extension's folder.");
      contributes.languages.push({
        id: language.id,
        extensions,
        filenames,
        aliases,
        configuration: configuration as string | null,
      });
    });
    list("grammars").forEach((entry, index) => {
      const field = `contributes.grammars[${index}]`;
      const grammar = entry as Record<string, unknown>;
      if (!grammar || typeof grammar !== "object") return error(field, "Must be an object.");
      if (typeof grammar.scopeName !== "string" || !SCOPE.test(grammar.scopeName))
        return error(`${field}.scopeName`, "Must be a TextMate scope name, like source.x.");
      if (!insidePath(grammar.path))
        return error(`${field}.path`, "Must be a path inside the extension's folder.");
      const language = grammar.language ?? null;
      if (language !== null && (typeof language !== "string" || !LANGUAGE.test(language)))
        return error(`${field}.language`, "Must be a language id.");
      const embedded = (grammar.embeddedLanguages ?? {}) as Record<string, unknown>;
      if (
        !embedded ||
        typeof embedded !== "object" ||
        Array.isArray(embedded) ||
        Object.entries(embedded).some(
          ([scope, id]) => !SCOPE.test(scope) || typeof id !== "string" || !LANGUAGE.test(id),
        )
      )
        return error(`${field}.embeddedLanguages`, "Must map scope names to language ids.");
      contributes.grammars.push({
        scopeName: grammar.scopeName,
        path: grammar.path,
        language: language as string | null,
        embeddedLanguages: embedded as Record<string, string>,
      });
    });
  }

  // The VS Code package it was made from, if any (EXT-04): data only, bounded.
  let vsix: VsixOrigin | null = null;
  if (raw.vsix !== undefined) {
    const origin = raw.vsix as Record<string, unknown>;
    const lines = (value: unknown) =>
      Array.isArray(value) && value.length <= 200 && value.every((one) => oneLine(one, 1000))
        ? (value as string[])
        : null;
    const optional = (value: unknown) =>
      value === null || value === undefined ? null : oneLine(value, 100) ? value : undefined;
    const [supported, ignored, rejected] = [
      origin?.supported,
      origin?.ignored,
      origin?.rejected,
    ].map(lines);
    const [publisher, name, vscode] = [origin?.publisher, origin?.name, origin?.vscode].map(
      optional,
    );
    if (
      !origin ||
      typeof origin !== "object" ||
      !supported ||
      !ignored ||
      !rejected ||
      publisher === undefined ||
      name === undefined ||
      vscode === undefined ||
      typeof origin.code !== "boolean" ||
      origin.signature !== "not verified"
    )
      error("vsix", "Must be the report of a VS Code package Yavin adapted.");
    else {
      const runtime = vscodeRuntimeOf(origin.runtime);
      if (runtime === undefined)
        error("vsix.runtime", "Must be how the VS Code compatibility layer runs its code.");
      vsix = {
        publisher,
        name,
        vscode,
        code: origin.code,
        runtime: runtime ?? null,
        supported,
        ignored,
        rejected,
        signature: "not verified",
      };
      // Its code is loaded only when the adapter said how it runs (EXT-25).
      if (main !== null && !runtime)
        error("main", "A manifest made from a VS Code package has code only with a runtime.");
      if (runtime && main === null) error("main", "A VS Code runtime needs the code it runs.");
    }
  }

  for (const event of activationEvents)
    if (event.kind === "command" && !commandIds_(contributes).has(event.id))
      warn(
        "activationEvents",
        `onCommand:${event.id} names a command this extension does not contribute.`,
      );

  const known = new Set([
    "manifestVersion",
    "id",
    "name",
    "publisher",
    "displayName",
    "version",
    "description",
    "engines",
    "activationEvents",
    "main",
    "contributes",
    "capabilities",
    "permissions",
    "extensionDependencies",
    "dependencies",
    "incompatibilities",
    "license",
    "repository",
    "icon",
    "keywords",
    "vsix",
  ]);
  for (const key of Object.keys(raw))
    if (!known.has(key)) warn(key, `"${key}" is not a manifest field this Yavin reads; ignored.`);

  if (problems.some((problem) => problem.severity === "error")) return { ok: false, id, problems };
  return {
    ok: true,
    warnings: problems,
    manifest: {
      manifestVersion: MANIFEST_VERSION,
      id: id!,
      name: raw.name as string,
      publisher: raw.publisher as string,
      displayName: displayName as string,
      version: raw.version as string,
      description: description as string | null,
      engine,
      activationEvents,
      main: main as string | null,
      contributes,
      untrustedWorkspaces,
      dependencies,
      optionalDependencies,
      vsix,
      permissions,
    },
  };
}

/** `vsix.runtime` as the compatibility layer reads it: null when absent, undefined when invalid. */
function vscodeRuntimeOf(raw: unknown): VscodeRuntime | null | undefined {
  if (raw === undefined || raw === null) return null;
  const runtime = raw as Record<string, unknown>;
  const map = (value: unknown) =>
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length <= 500 &&
    Object.entries(value).every(([key, one]) => oneLine(key, 300) && oneLine(one, 300))
      ? (value as Record<string, string>)
      : null;
  const [commands, settings, views] = [runtime?.commands, runtime?.settings, runtime?.views].map(
    map,
  );
  const defaults = runtime?.defaults;
  if (
    !runtime ||
    typeof runtime !== "object" ||
    runtime.api !== "vscode" ||
    (runtime.entry !== "main" && runtime.entry !== "browser") ||
    !oneLine(runtime.level, 20) ||
    !commands ||
    !settings ||
    !views ||
    !defaults ||
    typeof defaults !== "object" ||
    Array.isArray(defaults)
  )
    return undefined;
  return {
    entry: runtime.entry,
    level: runtime.level as string,
    commands,
    settings,
    views,
    defaults: defaults as Record<string, unknown>,
  };
}

const commandIds_ = (contributes: Contributions) =>
  new Set(contributes.commands.map((command) => command.command));
