/**
 * The extension manifest (IDE-07): what an extension is and what it contributes, as plain data,
 * validated before anything of it is used. Versioned by `manifestVersion`; an extension states
 * which extension API it needs with `engines.yavin` (a semver range against `EXTENSION_API`).
 *
 * Identity is `publisher.name` -- never the display name -- and is the one key for the
 * extension everywhere: the registry, its activation, the commands, views and settings it
 * contributes (all namespaced by it), its storage, its output channel and its errors.
 */

/** The extension API this Yavin provides. Bumped on a breaking change to `api.ts`. */
export const EXTENSION_API = "1.0.0";
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
  location: "sidebar" | "panel";
}

export type MenuLocation = "commandPalette" | "view/title" | "editor/context" | "explorer/context";

export interface MenuContribution {
  location: MenuLocation;
  command: string;
  /** `view/title`: the view the action belongs to (one of this extension's). */
  view: string | null;
  /** `commandPalette`: false hides the command from the palette (it still runs from elsewhere). */
  visible: boolean;
}

export interface Contributions {
  commands: CommandContribution[];
  keybindings: KeybindingContribution[];
  settings: SettingContribution[];
  views: ViewContribution[];
  menus: MenuContribution[];
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

const NAME = /^[a-z0-9][a-z0-9-]{0,49}$/;
const PART = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-.]+)?$/;
const KEY = /^((Mod|Shift|Alt)\+){0,3}([a-z0-9]|F([1-9]|1[0-2])|[`\-=[\]\\;',./])$/i;
const LANGUAGE = /^[a-z0-9][a-z0-9+#._-]{0,49}$/i;

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
const CONTRIBUTION_POINTS = new Set(["commands", "keybindings", "configuration", "views", "menus"]);
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
  if (typeof raw.publisher !== "string" || !NAME.test(raw.publisher))
    error("publisher", 'Needs a publisher: lower-case letters, digits and "-" (at most 50).');
  if (typeof raw.name !== "string" || !NAME.test(raw.name))
    error("name", 'Needs a name: lower-case letters, digits and "-" (at most 50).');
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
      if (fits === null) error("engines.yavin", `"${engine}" is not a range this Yavin reads.`);
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

  if (Array.isArray(raw.extensionDependencies) && raw.extensionDependencies.length)
    error(
      "extensionDependencies",
      "Extensions that depend on other extensions are not supported yet.",
    );

  const capabilities = (raw.capabilities ?? {}) as Record<string, unknown>;
  const untrustedWorkspaces = capabilities.untrustedWorkspaces === true;

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
    menus: [],
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

    const viewIds = new Set<string>();
    list("views").forEach((entry, index) => {
      const field = `contributes.views[${index}]`;
      const view = entry as Record<string, unknown>;
      if (!view || typeof view !== "object") return error(field, "Must be an object.");
      if (!owned(view.id))
        return error(`${field}.id`, `Must be "${id ?? "publisher.name"}.<name>".`);
      if (viewIds.has(view.id)) return error(`${field}.id`, `"${view.id}" is contributed twice.`);
      if (!oneLine(view.name, 60)) return error(`${field}.name`, "Needs a one-line name.");
      const location = view.location ?? "sidebar";
      if (location !== "sidebar" && location !== "panel")
        return error(`${field}.location`, 'Must be "sidebar" or "panel".');
      viewIds.add(view.id);
      contributes.views.push({ id: view.id, name: view.name, location });
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
            contributes.menus.push({
              location: location as MenuLocation,
              command: item.command,
              view,
              visible: item.when !== "false" && item.when !== false,
            });
          });
        }
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
    "extensionDependencies",
    "license",
    "repository",
    "icon",
    "keywords",
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
    },
  };
}

const commandIds_ = (contributes: Contributions) =>
  new Set(contributes.commands.map((command) => command.command));
