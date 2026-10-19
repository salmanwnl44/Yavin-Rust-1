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
import type { NativeIntegrity, NativeReplaced, NativeSignature } from "../native.ts";
import { ExtensionError } from "./errors.ts";
import {
  readManifest,
  type CommandContribution,
  type ExtensionManifest,
  type ManifestProblem,
  type MenuContribution,
  type SettingContribution,
  type SnippetContribution,
  type ThemeContribution,
  type ViewContainerContribution,
  type ViewContribution,
} from "./manifest.ts";

/**
 * Where an extension was found: its folder. Its code (if any) is read from there by the native
 * side and runs in the workspace's extension host process (IDE-08) -- never in the window.
 */
export type ExtensionSource = { kind: "folder"; path: string };

/** Another copy of a registered extension, found but not used (EXT-02: the inventory's choice). */
export interface ShadowedCopy {
  folder: string;
  version: string | null;
  reason: string;
}

/**
 * What the user allowed an extension (EXT-07), as the native inventory last said: granted for
 * the copy registered, and a grant for another copy (the version before an update), shown only.
 */
export interface GrantState {
  granted: readonly string[];
  previous: { version: string; granted: readonly string[] } | null;
}

export const NO_GRANTS: GrantState = { granted: [], previous: null };

export interface RegisteredExtension {
  id: string;
  manifest: ExtensionManifest;
  source: ExtensionSource;
  /** Where it was found, for messages: its folder. */
  origin: string;
  enabled: boolean;
  /** Manifest warnings, and contributions that could not be applied (with why). */
  warnings: string[];
  /** Other copies of it that were found, and why they are not used. */
  shadowed: readonly ShadowedCopy[];
  /** What the user allowed it (EXT-07): the native side decides; this shows it. */
  grants: GrantState;
  /**
   * What its package's signature was found to be when installed (EXT-09), as the native
   * inventory said: null when it has not said (not recorded, or not listed yet).
   */
  signature: NativeSignature | null;
  /** What is known of its files (EXT-17), as the native inventory said: null until it has. */
  integrity: NativeIntegrity | null;
  /** The copy its intact previous one replaced (EXT-17), while that is so. */
  replaced: NativeReplaced | null;
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
  /** Enabled extensions' colour themes and snippets (EXT-04), in order of extension id. */
  /** `copy`: which installed copy contributes it (EXT-08) -- its folder and version. */
  themes: readonly (ThemeContribution & { extensionId: string; copy: string })[];
  snippets: readonly (SnippetContribution & { extensionId: string; copy: string })[];
  /**
   * Enabled extensions that cannot activate because of their dependencies (missing, disabled,
   * themselves unavailable, or in a cycle), with why. Their declarative contributions still apply.
   */
  unavailable: Readonly<Record<string, string>>;
}

/**
 * Which installed copy an entry is (EXT-08): its folder and version. An update, a reinstall or
 * a rollback is another copy (the store keeps each in a folder of its own), so what was read
 * from the old one is never taken for the new one's.
 */
const copyOf = (entry: RegisteredExtension) => `${entry.origin}@${entry.manifest.version}`;

export const DISABLED_KEY = "yavin.extensions.disabled";

/**
 * The disabled ids a window's storage holds (IDE-07's place for them; since EXT-02 the desktop
 * app moves them into the native inventory once).
 */
export function readStoredDisabled(storage: Storage | null | undefined): string[] {
  try {
    const parsed = JSON.parse(storage?.getItem(DISABLED_KEY) ?? "null") as {
      version?: number;
      ids?: unknown;
    } | null;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.ids))
      return parsed.ids.filter((id): id is string => typeof id === "string");
  } catch {
    /* Unreadable: every extension starts enabled. */
  }
  return [];
}

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
  /**
   * Where enabled state is kept (EXT-02: the native inventory). Without it, this window's
   * storage keeps it (the browser preview, tests).
   */
  persistEnabled?: (id: string, enabled: boolean) => void;
  /**
   * Where grants are decided and kept (EXT-07: the native inventory, which returns the state
   * it then holds). Without it (the browser preview, tests), this window keeps them.
   */
  persistGrants?: (id: string, version: string, capabilities: string[]) => Promise<GrantState>;
}) {
  const storage = (() => {
    if (options.storage !== undefined) return options.storage;
    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  })();
  const disabled = new Set<string>(options.persistEnabled ? [] : readStoredDisabled(storage));
  const saveDisabled = (id: string, enabled: boolean) => {
    if (options.persistEnabled) return options.persistEnabled(id, enabled);
    try {
      storage?.setItem(DISABLED_KEY, JSON.stringify({ version: 1, ids: [...disabled].sort() }));
    } catch {
      /* Blocked or full: it holds for the window. */
    }
  };

  const extensions = new Map<string, RegisteredExtension>();
  /** Grant states by id, as last confirmed (kept across a re-registration of the same copy). */
  const grantStates = new Map<string, GrantState>();
  const signatureStates = new Map<string, NativeSignature | null>();
  const integrityStates = new Map<
    string,
    { integrity: NativeIntegrity | null; replaced: NativeReplaced | null }
  >();
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
    themes: [],
    snippets: [],
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
      themes: [...enabled]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .flatMap((one) =>
          one.manifest.contributes.themes.map((theme) => ({
            ...theme,
            extensionId: one.id,
            copy: copyOf(one),
          })),
        ),
      snippets: [...enabled]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .flatMap((one) =>
          one.manifest.contributes.snippets.map((snippet) => ({
            ...snippet,
            extensionId: one.id,
            copy: copyOf(one),
          })),
        ),
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

  const setSignature = (id: string, signature: NativeSignature | null) => {
    signatureStates.set(id, signature);
    const entry = extensions.get(id);
    if (!entry || entry.signature === signature) return;
    entry.signature = signature;
    publish();
  };

  const setIntegrity = (
    id: string,
    integrity: NativeIntegrity | null,
    replaced: NativeReplaced | null,
  ) => {
    integrityStates.set(id, { integrity, replaced });
    const entry = extensions.get(id);
    if (!entry) return;
    if (JSON.stringify([entry.integrity, entry.replaced]) === JSON.stringify([integrity, replaced]))
      return;
    entry.integrity = integrity;
    entry.replaced = replaced;
    publish();
  };

  const setGrants = (id: string, state: GrantState) => {
    grantStates.set(id, state);
    const entry = extensions.get(id);
    if (!entry) return;
    // In place: the extension's registration is the same; what it may do is not.
    entry.grants = state;
    publish();
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
      shadowed: readonly ShadowedCopy[] = [],
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
        shadowed,
        grants: grantStates.get(manifest.id) ?? NO_GRANTS,
        signature: signatureStates.get(manifest.id) ?? null,
        integrity: integrityStates.get(manifest.id)?.integrity ?? null,
        replaced: integrityStates.get(manifest.id)?.replaced ?? null,
      };
      extensions.set(manifest.id, entry);
      if (entry.enabled) applySettings(entry);
      publish();
      return entry;
    },
    /**
     * Replaces an installed extension by a new version of it (IDE-09: an update), in one step:
     * the new manifest is validated first, and if it is not valid -- or not the same extension --
     * nothing changes. Its enabled state is kept. The extension host sees a new entry and stops
     * the old version.
     */
    replace(
      id: string,
      raw: unknown,
      source: ExtensionSource,
      origin: string,
    ): RegisteredExtension | RejectedExtension {
      const previous = extensions.get(id);
      const result = readManifest(raw);
      const problems = !result.ok
        ? result.problems.filter((p) => p.severity === "error").map(describe)
        : result.manifest.id !== id
          ? [`It is ${result.manifest.id}, not ${id}.`]
          : [];
      if (!previous || problems.length || !result.ok)
        return { id, origin, problems: previous ? problems : [`"${id}" is not installed.`] };
      if (previous.enabled) removeSettings(previous);
      const entry: RegisteredExtension = {
        id,
        manifest: result.manifest,
        source,
        origin,
        enabled: !disabled.has(id),
        warnings: result.warnings.map(describe),
        shadowed: previous.shadowed,
        // A new copy has no grant: what the old one had is shown as such (the native rule).
        grants: {
          granted: [],
          previous: previous.grants.granted.length
            ? { version: previous.manifest.version, granted: previous.grants.granted }
            : previous.grants.previous,
        },
        // The new copy's is not the old one's: unknown until the inventory lists it.
        signature: null,
        integrity: null,
        replaced: null,
      };
      signatureStates.delete(id);
      integrityStates.delete(id);
      grantStates.set(id, entry.grants);
      extensions.set(id, entry);
      if (entry.enabled) applySettings(entry);
      publish();
      return entry;
    },
    /**
     * Forgets an extension (its contributions go with it). `forget`: it was uninstalled, so its
     * disabled state goes too (a reinstall starts enabled); the native inventory forgets it
     * itself, so only this window's storage is written here.
     */
    remove(id: string, { forget = false }: { forget?: boolean } = {}) {
      const entry = extensions.get(id);
      if (forget) grantStates.delete(id);
      if (forget) signatureStates.delete(id);
      if (forget) integrityStates.delete(id);
      if (forget && disabled.delete(id) && !options.persistEnabled) saveDisabled(id, true);
      if (!entry) return;
      if (entry.enabled) removeSettings(entry);
      extensions.delete(id);
      publish();
    },
    /** An extension's grants as the native inventory has them (discovery, a grant change). */
    setGrants,
    /** What an extension copy's signature was found to be, as the native inventory said. */
    setSignature,
    /** What is known of an extension copy's files, as the native inventory said (EXT-17). */
    setIntegrity,
    /**
     * Allows exactly `capabilities` (each one its manifest requests) and returns the state the
     * native side then holds -- shown only once it said so.
     */
    async grant(id: string, capabilities: readonly string[]): Promise<GrantState> {
      const entry = extensions.get(id);
      if (!entry)
        throw new ExtensionError("UnknownExtension", id, `There is no extension "${id}".`);
      const wanted = [...new Set(capabilities)].sort();
      const extra = wanted.find((one) => !entry.manifest.permissions.requested.includes(one));
      if (extra !== undefined)
        throw new ExtensionError(
          "NotRequested",
          id,
          `${entry.manifest.displayName} does not request "${extra}".`,
        );
      // The version the user saw: the native side refuses if another is installed meanwhile.
      const state = options.persistGrants
        ? await options.persistGrants(id, entry.manifest.version, wanted)
        : { granted: wanted, previous: wanted.length ? null : entry.grants.previous };
      setGrants(id, state);
      return state;
    },
    /** The disabled ids as the native inventory has them (discovery). */
    setDisabled(ids: readonly string[]) {
      disabled.clear();
      for (const id of ids) disabled.add(id);
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
      saveDisabled(id, enabled);
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
    /** A copy that is not loaded, and why -- named by its id when that is known (EXT-19). */
    reject(origin: string, problem: string, id: string | null = null) {
      rejected = [...rejected, { id, origin, problems: [problem] }];
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
