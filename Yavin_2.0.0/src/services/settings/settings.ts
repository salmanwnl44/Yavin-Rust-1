/**
 * Settings (IDE-03): the generic framework for user and workspace preferences. It knows how to
 * describe, validate, keep, resolve and announce a setting; it knows nothing of what any
 * setting does. Each subsystem defines its own settings (`editor/editorSettings.ts`) and
 * applies them itself, subscribing for changes.
 *
 * ```text
 * SettingDefinition<T> (owned by a subsystem: id, default, validation, scopes)
 *        │
 * SettingsRegistry ── user values ──────── yavin.settings.user
 *        │        └─ workspace values ──── yavin.settings.workspace:<WorkspaceId>
 *        │  resolve(definition, workspace): workspace value ?? user value ?? default
 *        ▼
 * subscribe(workspace, listener) ── typed change: id, previous, value, source
 *        ▼
 * the owning subsystem applies it (the editor updates its options; nothing is reloaded)
 * ```
 *
 * - **Preferences only.** Session and runtime state (tabs, terminals, Git, diagnostics) are not
 *   settings; neither are subsystems' own records (`terminalSettings.ts` keeps the terminal's).
 * - **Never trusted.** Stored values are validated by their definitions when read. A value that
 *   is not valid is ignored -- the next scope or the default applies -- reported once, and kept
 *   in the record untouched, never silently deleted; a value for a setting this version does
 *   not know is kept too. A record that cannot be read at all is copied to `<key>.corrupt`
 *   before anything is written over it; one written by a newer Yavin is not read and never
 *   written over (T07's rules).
 * - **No bus.** Listeners subscribe for one workspace (or for user-level values) and hear only
 *   the changes that move what that workspace resolves to.
 */
import type { WorkspaceId } from "../terminalProtocol.ts";

export type SettingScope = "user" | "workspace";

export interface SettingDefinition<T> {
  /** Stable, dotted: `editor.fontSize`. Never reused for another meaning. */
  readonly id: string;
  /** For the Settings view. */
  readonly title: string;
  readonly description: string;
  readonly section: string;
  readonly default: T;
  /** Where a value may be set; a workspace value overrides the user's. */
  readonly scopes: readonly SettingScope[];
  /** The value, if `value` is a valid one; `undefined` otherwise. Never trusts its input. */
  parse(value: unknown): T | undefined;
  /** Why `value` is not valid, for a structured setting whose reasons are worth saying. */
  explain?(value: unknown): string | undefined;
  /** How the Settings view edits it. */
  readonly control:
    | { kind: "boolean" }
    | { kind: "number"; min: number; max: number; step: number }
    | { kind: "string"; maxLength: number }
    | { kind: "enum"; options: readonly { value: T; label: string }[] }
    /** A structured value (a list of records), edited as JSON. */
    | { kind: "json"; example: string };
}

/** A setting's state in one workspace, for the Settings view. */
export interface SettingInspection<T> {
  readonly value: T;
  readonly source: "default" | SettingScope;
  readonly default: T;
  readonly user?: T;
  readonly workspace?: T;
}

/** A change in what one workspace (or the user level, `null`) resolves a setting to. */
export interface SettingChange {
  readonly id: string;
  readonly workspace: WorkspaceId | null;
  readonly previous: unknown;
  readonly value: unknown;
  readonly source: "default" | SettingScope;
}

export class SettingsError extends Error {}

// --- Definitions --------------------------------------------------------------------------------

type Described = Pick<SettingDefinition<unknown>, "id" | "title" | "description" | "section"> & {
  scopes?: readonly SettingScope[];
};
const BOTH: readonly SettingScope[] = ["user", "workspace"];

export function booleanSetting(spec: Described & { default: boolean }): SettingDefinition<boolean> {
  return Object.freeze({
    scopes: BOTH,
    ...spec,
    parse: (value: unknown) => (typeof value === "boolean" ? value : undefined),
    control: { kind: "boolean" as const },
  });
}

export function numberSetting(
  spec: Described & { default: number; min: number; max: number; step?: number; integer?: boolean },
): SettingDefinition<number> {
  const { min, max, integer = false, step = integer ? 1 : 0.1 } = spec;
  return Object.freeze({
    scopes: BOTH,
    ...spec,
    parse: (value: unknown) =>
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= min &&
      value <= max &&
      (!integer || Number.isInteger(value))
        ? value
        : undefined,
    control: { kind: "number" as const, min, max, step },
  });
}

export function stringSetting(
  spec: Described & { default: string; maxLength: number },
): SettingDefinition<string> {
  return Object.freeze({
    scopes: BOTH,
    ...spec,
    parse: (value: unknown) =>
      typeof value === "string" &&
      value.trim().length > 0 &&
      value.length <= spec.maxLength &&
      // One line, no control characters.
      !/[\u0000-\u001f\u007f]/.test(value)
        ? value
        : undefined,
    control: { kind: "string" as const, maxLength: spec.maxLength },
  });
}

/**
 * A structured setting -- a list of records, say -- whose definition validates the whole value
 * (`parse`) and says what is wrong with an invalid one (`explain`).
 */
export function structuredSetting<T>(
  spec: Described & {
    default: T;
    parse(value: unknown): T | undefined;
    explain(value: unknown): string | undefined;
    example: string;
  },
): SettingDefinition<T> {
  const { example, ...rest } = spec;
  return Object.freeze({
    scopes: BOTH,
    ...rest,
    control: { kind: "json" as const, example },
  });
}

export function enumSetting<T extends string>(
  spec: Described & { default: T; options: readonly { value: T; label: string }[] },
): SettingDefinition<T> {
  return Object.freeze({
    scopes: BOTH,
    ...spec,
    parse: (value: unknown) =>
      spec.options.some((option) => option.value === value) ? (value as T) : undefined,
    control: { kind: "enum" as const, options: spec.options },
  });
}

// --- Persistence --------------------------------------------------------------------------------

export const SETTINGS_VERSION = 1;
export const USER_SETTINGS_KEY = "yavin.settings.user";
export const workspaceSettingsKey = (id: WorkspaceId) => `yavin.settings.workspace:${id}`;

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

const defaultStorage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/** One stored record: every value as stored (valid or not), and whether it may be written. */
interface Layer {
  key: string;
  values: Map<string, unknown>;
  /** Written by a newer Yavin: not read, never written over. */
  frozen: boolean;
}

export interface SettingsRegistry {
  /** The definitions, in the order they were given. */
  readonly definitions: readonly SettingDefinition<unknown>[];
  /** What `workspace` resolves the setting to (`null`: the user level only). */
  get<T>(definition: SettingDefinition<T>, workspace: WorkspaceId | null): T;
  inspect<T>(definition: SettingDefinition<T>, workspace: WorkspaceId | null): SettingInspection<T>;
  /** Validated first: an invalid value throws `SettingsError` and changes nothing. */
  set<T>(
    definition: SettingDefinition<T>,
    scope: SettingScope,
    value: T,
    workspace?: WorkspaceId | null,
  ): void;
  /** Removes that scope's value: the next scope's value, or the default, applies again. */
  reset(
    definition: SettingDefinition<unknown>,
    scope: SettingScope,
    workspace?: WorkspaceId | null,
  ): void;
  /**
   * Hears every change in what `workspace` (or the user level, `null`) resolves a setting to --
   * never another workspace's. Returns the unsubscribe.
   */
  subscribe(workspace: WorkspaceId | null, listener: (change: SettingChange) => void): () => void;
  /** What went wrong reading or writing, since last asked: for the window to say once. */
  takeProblems(): string[];
  /** Hears that problems are waiting. */
  onProblems(listener: () => void): () => void;
}

export function createSettingsRegistry(
  definitions: readonly SettingDefinition<unknown>[],
  storage: Storage | null = defaultStorage(),
): SettingsRegistry {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  if (byId.size !== definitions.length) throw new SettingsError("Two settings share an id.");
  const listeners = new Map<WorkspaceId | null, Set<(change: SettingChange) => void>>();
  const problemListeners = new Set<() => void>();
  let problems: string[] = [];
  let user: Layer | null = null;
  const workspaces = new Map<WorkspaceId, Layer>();

  const report = (found: string[]) => {
    if (!found.length) return;
    problems.push(...found);
    for (const listener of [...problemListeners])
      try {
        listener();
      } catch {
        /* A listener's failure is not the registry's. */
      }
  };

  const load = (key: string, where: string): Layer => {
    const layer: Layer = { key, values: new Map(), frozen: false };
    let text: string | null = null;
    try {
      text = storage?.getItem(key) ?? null;
    } catch {
      report([`${where}: they could not be read from storage; defaults apply.`]);
      return layer;
    }
    if (text === null) return layer;
    let body: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(text);
      body =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
    } catch {
      body = null;
    }
    const values =
      body && body.values && typeof body.values === "object" && !Array.isArray(body.values)
        ? (body.values as Record<string, unknown>)
        : null;
    if (!body || !Number.isSafeInteger(body.version) || (body.version as number) < 1 || !values) {
      // Unreadable: kept aside before anything is written over it.
      let kept = "";
      try {
        storage?.setItem(`${key}.corrupt`, text);
        kept = ` What was there was kept in ${key}.corrupt.`;
      } catch {
        /* Storage full: still reported. */
      }
      report([`${where} could not be read; defaults apply.${kept}`]);
      return layer;
    }
    if ((body.version as number) > SETTINGS_VERSION) {
      layer.frozen = true;
      report([
        `${where} were saved by a newer version of Yavin; they are left as they are and not used.`,
      ]);
      return layer;
    }
    const found: string[] = [];
    for (const [id, value] of Object.entries(values)) {
      // Kept as stored, whatever it is: an unknown or invalid value is ignored, never deleted.
      layer.values.set(id, value);
      const definition = byId.get(id);
      if (definition && definition.parse(value) === undefined)
        found.push(
          `${where}: "${id}" has a value that is not valid (${JSON.stringify(value)}); its default applies.`,
        );
    }
    report(found);
    return layer;
  };

  const userLayer = () => (user ??= load(USER_SETTINGS_KEY, "Your settings"));
  const workspaceLayer = (id: WorkspaceId) => {
    let layer = workspaces.get(id);
    if (!layer) {
      layer = load(workspaceSettingsKey(id), "This workspace's settings");
      workspaces.set(id, layer);
    }
    return layer;
  };

  const save = (layer: Layer) => {
    if (layer.frozen || !storage) return;
    try {
      storage.setItem(
        layer.key,
        JSON.stringify({ version: SETTINGS_VERSION, values: Object.fromEntries(layer.values) }),
      );
    } catch {
      report(["Settings could not be saved; they apply until the window closes."]);
    }
  };

  const valid = <T>(definition: SettingDefinition<T>, layer: Layer): T | undefined =>
    layer.values.has(definition.id) ? definition.parse(layer.values.get(definition.id)) : undefined;

  const inspect = <T>(
    definition: SettingDefinition<T>,
    workspace: WorkspaceId | null,
  ): SettingInspection<T> => {
    const fromUser = definition.scopes.includes("user")
      ? valid(definition, userLayer())
      : undefined;
    const fromWorkspace =
      workspace !== null && definition.scopes.includes("workspace")
        ? valid(definition, workspaceLayer(workspace))
        : undefined;
    const source =
      fromWorkspace !== undefined ? "workspace" : fromUser !== undefined ? "user" : "default";
    return {
      value: fromWorkspace ?? fromUser ?? definition.default,
      source,
      default: definition.default,
      ...(fromUser !== undefined ? { user: fromUser } : {}),
      ...(fromWorkspace !== undefined ? { workspace: fromWorkspace } : {}),
    };
  };

  const known = (definition: SettingDefinition<unknown>) => {
    if (byId.get(definition.id) !== definition)
      throw new SettingsError(`There is no setting "${definition.id}".`);
  };

  /** Applies `mutate` to `scope`'s layer, then tells every listener whose resolution moved. */
  const change = (
    definition: SettingDefinition<unknown>,
    scope: SettingScope,
    workspace: WorkspaceId | null,
    mutate: (layer: Layer) => void,
  ) => {
    if (!definition.scopes.includes(scope))
      throw new SettingsError(`"${definition.id}" cannot be set for a ${scope}.`);
    if (scope === "workspace" && workspace === null)
      throw new SettingsError("A workspace setting needs a workspace.");
    // Who might see a different value: a user change, everyone; a workspace change, that one.
    const audience: (WorkspaceId | null)[] =
      scope === "user" ? [...listeners.keys()] : listeners.has(workspace) ? [workspace] : [];
    const before = new Map(audience.map((who) => [who, inspect(definition, who)]));
    const layer = scope === "user" ? userLayer() : workspaceLayer(workspace!);
    mutate(layer);
    save(layer);
    for (const who of audience) {
      const previous = before.get(who)!;
      const now = inspect(definition, who);
      if (Object.is(previous.value, now.value) && previous.source === now.source) continue;
      const event: SettingChange = {
        id: definition.id,
        workspace: who,
        previous: previous.value,
        value: now.value,
        source: now.source,
      };
      for (const listener of [...(listeners.get(who) ?? [])])
        try {
          listener(event);
        } catch {
          /* One listener's failure is not the others'. */
        }
    }
  };

  return {
    definitions,
    get: (definition, workspace) => inspect(definition, workspace).value,
    inspect,
    set(definition, scope, value, workspace = null) {
      known(definition as SettingDefinition<unknown>);
      const parsed = definition.parse(value);
      if (parsed === undefined)
        throw new SettingsError(
          definition.explain?.(value) ??
            `${JSON.stringify(value)} is not a valid value for "${definition.id}".`,
        );
      change(definition as SettingDefinition<unknown>, scope, workspace, (layer) =>
        layer.values.set(definition.id, parsed),
      );
    },
    reset(definition, scope, workspace = null) {
      known(definition);
      change(definition, scope, workspace, (layer) => layer.values.delete(definition.id));
    },
    subscribe(workspace, listener) {
      let set = listeners.get(workspace);
      if (!set) listeners.set(workspace, (set = new Set()));
      set.add(listener);
      return () => {
        const current = listeners.get(workspace);
        current?.delete(listener);
        // No listener left: nothing is kept for that workspace's sake.
        if (current && !current.size) listeners.delete(workspace);
      };
    },
    takeProblems() {
      const taken = problems;
      problems = [];
      return taken;
    },
    onProblems(listener) {
      problemListeners.add(listener);
      return () => {
        problemListeners.delete(listener);
      };
    },
  };
}
