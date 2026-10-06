/**
 * The extension registry (IDE-07): which extensions Yavin knows, by identity, whether each is
 * enabled, and what their manifests contribute. One per window. It runs no extension code --
 * that is the workspace's ExtensionHost (`host.ts`) -- and owns no subsystem: contributed
 * settings are registered with the SettingsRegistry, which stays their owner; contributed
 * commands, keybindings, views and menus are indexed here for the window's command palette,
 * menus and views to show.
 *
 * Lifecycle here: discovered → validated → registered (or rejected, with every reason).
 */
import {
  booleanSetting,
  enumSetting,
  numberSetting,
  stringSetting,
  type SettingDefinition,
  type SettingsRegistry,
} from "../settings/settings.ts";
import { ExtensionError } from "./errors.ts";
import {
  readManifest,
  type CommandContribution,
  type ExtensionManifest,
  type ManifestProblem,
  type MenuContribution,
  type SettingContribution,
  type ViewContainerContribution,
  type ViewContribution,
} from "./manifest.ts";

/**
 * Where an extension was found: its folder. Its code (if any) is read from there by the native
 * side and runs in the workspace's extension host process (IDE-08) -- never in the window.
 */
export type ExtensionSource = { kind: "folder"; path: string };

export interface RegisteredExtension {
  id: string;
  manifest: ExtensionManifest;
  source: ExtensionSource;
  /** Where it was found, for messages: its folder. */
  origin: string;
  enabled: boolean;
  /** Manifest warnings, and contributions that could not be applied (with why). */
  warnings: string[];
}

export interface RejectedExtension {
  id: string | null;
  origin: string;
  problems: string[];
}

export interface ContributedCommand extends CommandContribution {
  extensionId: string;
  /** Shown in the command palette (`menus.commandPalette` can hide it). */
  palette: boolean;
  /** Its contributed shortcut, if any. */
  key: string | null;
}

export interface ContributedView extends ViewContribution {
  extensionId: string;
  /** Its `view/title` actions. */
  actions: string[];
}

export interface RegistrySnapshot {
  extensions: readonly RegisteredExtension[];
  rejected: readonly RejectedExtension[];
  /** Enabled extensions' contributions only. */
  commands: readonly ContributedCommand[];
  views: readonly ContributedView[];
  viewContainers: readonly (ViewContainerContribution & { extensionId: string })[];
  menus: readonly (MenuContribution & { extensionId: string })[];
  /**
   * Enabled extensions that cannot activate because of their dependencies (missing, disabled,
   * themselves unavailable, or in a cycle), with why. Their declarative contributions still apply.
   */
  unavailable: Readonly<Record<string, string>>;
}

export const DISABLED_KEY = "yavin.extensions.disabled";

const describe = (problem: ManifestProblem) =>
  problem.field ? `${problem.field}: ${problem.message}` : problem.message;

/** The SettingDefinition an extension's setting contribution is, in its extension's section. */
function definitionOf(setting: SettingContribution, section: string): SettingDefinition<unknown> {
  const base = {
    id: setting.id,
    title: setting.title,
    description: setting.description,
    section,
    scopes: setting.scope === "user" ? (["user"] as const) : (["user", "workspace"] as const),
  };
  switch (setting.type) {
    case "boolean":
      return booleanSetting({
        ...base,
        default: setting.default as boolean,
      }) as SettingDefinition<unknown>;
    case "number":
      return numberSetting({
        ...base,
        default: setting.default as number,
        min: setting.minimum ?? Number.MIN_SAFE_INTEGER,
        max: setting.maximum ?? Number.MAX_SAFE_INTEGER,
      }) as SettingDefinition<unknown>;
    case "string":
      return stringSetting({
        ...base,
        default: setting.default as string,
        maxLength: 1000,
      }) as SettingDefinition<unknown>;
    case "enum":
      return enumSetting({
        ...base,
        default: setting.default as string,
        options: setting.values.map((value) => ({ value, label: value })),
      }) as SettingDefinition<unknown>;
  }
}

export function createExtensionRegistry(options: {
  settings: SettingsRegistry;
  storage?: Storage | null;
}) {
  const storage = (() => {
    if (options.storage !== undefined) return options.storage;
    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  })();
  const disabled = new Set<string>();
  try {
    const parsed = JSON.parse(storage?.getItem(DISABLED_KEY) ?? "null") as {
      version?: number;
      ids?: unknown;
    } | null;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.ids))
      for (const id of parsed.ids) if (typeof id === "string") disabled.add(id);
  } catch {
    /* Unreadable: every extension starts enabled. */
  }
  const saveDisabled = () => {
    try {
      storage?.setItem(DISABLED_KEY, JSON.stringify({ version: 1, ids: [...disabled].sort() }));
    } catch {
      /* Blocked or full: it holds for the window. */
    }
  };

  const extensions = new Map<string, RegisteredExtension>();
  let rejected: RejectedExtension[] = [];
  /** Settings registered for each enabled extension, to remove with it. */
  const settingRemovals = new Map<string, (() => void)[]>();
  const settingDefinitions = new Map<string, SettingDefinition<unknown>>();
  const listeners = new Set<() => void>();
  let snapshot: RegistrySnapshot = {
    extensions: [],
    rejected: [],
    commands: [],
    views: [],
    viewContainers: [],
    menus: [],
    unavailable: {},
  };

  /** Why each enabled extension's dependencies keep it from activating (cycles included). */
  const dependencyProblems = (): Record<string, string> => {
    const problems: Record<string, string> = {};
    const reason = (id: string, path: string[]): string | null => {
      if (id in problems) return problems[id];
      const entry = extensions.get(id)!;
      for (const dependency of [...entry.manifest.dependencies].sort()) {
        if (path.includes(dependency))
          return `Its dependencies form a cycle: ${[...path, dependency].join(" → ")}.`;
        const found = extensions.get(dependency);
        if (!found) return `It needs ${dependency}, which is not installed.`;
        if (!found.enabled) return `It needs ${dependency}, which is disabled.`;
        const deeper = reason(dependency, [...path, dependency]);
        if (deeper) return `It needs ${dependency}, which cannot activate: ${deeper}`;
      }
      return null;
    };
    for (const id of [...extensions.keys()].sort()) {
      if (!extensions.get(id)!.enabled) continue;
      const found = reason(id, [id]);
      if (found) problems[id] = found;
    }
    return problems;
  };

  const build = (): RegistrySnapshot => {
    const all = [...extensions.values()];
    const enabled = all.filter((one) => one.enabled);
    const menus = enabled.flatMap((one) =>
      one.manifest.contributes.menus.map((menu) => ({ ...menu, extensionId: one.id })),
    );
    return {
      extensions: all,
      rejected,
      commands: enabled.flatMap((one) =>
        one.manifest.contributes.commands.map((command) => ({
          ...command,
          extensionId: one.id,
          palette: !menus.some(
            (menu) =>
              menu.location === "commandPalette" &&
              menu.command === command.command &&
              !menu.visible,
          ),
          key:
            one.manifest.contributes.keybindings.find(
              (binding) => binding.command === command.command,
            )?.key ?? null,
        })),
      ),
      views: enabled.flatMap((one) =>
        one.manifest.contributes.views.map((view) => ({
          ...view,
          extensionId: one.id,
          actions: menus
            .filter((menu) => menu.location === "view/title" && menu.view === view.id)
            .map((menu) => menu.command),
        })),
      ),
      viewContainers: enabled.flatMap((one) =>
        one.manifest.contributes.viewContainers.map((container) => ({
          ...container,
          extensionId: one.id,
        })),
      ),
      menus,
      unavailable: dependencyProblems(),
    };
  };
  const publish = () => {
    snapshot = build();
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* One listener's failure is not the others'. */
      }
    }
  };

  /** Puts an enabled extension's settings into the SettingsRegistry (its owner). */
  const applySettings = (entry: RegisteredExtension) => {
    const removals: (() => void)[] = [];
    for (const setting of entry.manifest.contributes.settings) {
      const definition = definitionOf(setting, entry.manifest.displayName);
      try {
        removals.push(options.settings.register(definition));
        settingDefinitions.set(setting.id, definition);
      } catch (error) {
        entry.warnings.push(
          `${setting.id}: not added -- ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    settingRemovals.set(entry.id, removals);
  };
  const removeSettings = (entry: RegisteredExtension) => {
    for (const remove of settingRemovals.get(entry.id) ?? []) remove();
    settingRemovals.delete(entry.id);
    for (const setting of entry.manifest.contributes.settings)
      settingDefinitions.delete(setting.id);
  };

  return {
    /**
     * Validates a manifest and registers it. A rejected one -- invalid, or an id already
     * registered -- is kept with its reasons (for the Extensions view) and never half-applied.
     */
    add(
      raw: unknown,
      source: ExtensionSource,
      origin: string,
    ): RegisteredExtension | RejectedExtension {
      const result = readManifest(raw);
      if (!result.ok) {
        const entry = {
          id: result.id,
          origin,
          problems: result.problems.filter((p) => p.severity === "error").map(describe),
        };
        rejected = [...rejected, entry];
        publish();
        return entry;
      }
      const { manifest } = result;
      if (extensions.has(manifest.id)) {
        const entry = {
          id: manifest.id,
          origin,
          problems: [
            `"${manifest.id}" is already registered (from ${extensions.get(manifest.id)!.origin}); this copy is ignored.`,
          ],
        };
        rejected = [...rejected, entry];
        publish();
        return entry;
      }
      const entry: RegisteredExtension = {
        id: manifest.id,
        manifest,
        source,
        origin,
        enabled: !disabled.has(manifest.id),
        warnings: result.warnings.map(describe),
      };
      extensions.set(manifest.id, entry);
      if (entry.enabled) applySettings(entry);
      publish();
      return entry;
    },
    /** Forgets an extension (its contributions go with it). */
    remove(id: string) {
      const entry = extensions.get(id);
      if (!entry) return;
      if (entry.enabled) removeSettings(entry);
      extensions.delete(id);
      publish();
    },
    setEnabled(id: string, enabled: boolean) {
      const entry = extensions.get(id);
      if (!entry)
        throw new ExtensionError("UnknownExtension", id, `There is no extension "${id}".`);
      if (entry.enabled === enabled) return;
      entry.enabled = enabled;
      if (enabled) {
        disabled.delete(id);
        applySettings(entry);
      } else {
        disabled.add(id);
        removeSettings(entry);
      }
      saveDisabled();
      publish();
    },
    get: (id: string) => extensions.get(id),
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** The SettingDefinition of an enabled extension's setting. */
    settingDefinition: (id: string) => settingDefinitions.get(id),
    /** The extension contributing command `id`, when it is enabled. */
    commandOwner: (id: string) =>
      snapshot.commands.find((command) => command.command === id)?.extensionId,
    /** Records an extension that could not even be read (its manifest unreadable or not JSON). */
    reject(origin: string, problem: string) {
      rejected = [...rejected, { id: null, origin, problems: [problem] }];
      publish();
    },
    /**
     * The order to activate `id` in: its dependencies first (each before what needs it,
     * alphabetically among equals), then itself. Deterministic; cycles are refused earlier
     * (`unavailable`).
     */
    activationOrder(id: string): string[] {
      const order: string[] = [];
      const visit = (one: string, path: Set<string>) => {
        if (order.includes(one) || path.has(one)) return;
        path.add(one);
        for (const dependency of [...(extensions.get(one)?.manifest.dependencies ?? [])].sort())
          visit(dependency, path);
        path.delete(one);
        order.push(one);
      };
      visit(id, new Set());
      return order;
    },
    /** Forgets the rejected list (a new discovery). */
    clearRejected() {
      rejected = [];
      publish();
    },
  };
}

export type ExtensionRegistry = ReturnType<typeof createExtensionRegistry>;
