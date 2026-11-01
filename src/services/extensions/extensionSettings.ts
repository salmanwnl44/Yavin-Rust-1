/**
 * An extension's settings as its Settings page shows and edits them (EXT-18). Nothing is kept
 * here: the user level is the settings registry's (IDE-03), the profile level the native
 * inventory's (EXT-13, `profiles.ts`). This resolves what each setting is, and where that
 * comes from -- this workspace, the active profile, the user, or its default (that order) --
 * and checks a value with the same rules as the window's settings and the native side
 * (`extension_profiles.rs`: `check_value`), so what is refused here would be refused there.
 */
import type { SettingContribution } from "./manifest.ts";
import type { SettingDefinition, SettingsRegistry } from "../settings/settings.ts";
import type { WorkspaceId } from "../terminalProtocol.ts";
import type { ProfileSettingChange } from "./profiles.ts";

/** Where a setting's value comes from, strongest first. */
export type SettingSource = "workspace" | "profile" | "user" | "default";

/** The level a change is made at: the active profile's, or the user's (every profile). */
export type SettingLayer = "profile" | "user";

export interface SettingRow {
  setting: SettingContribution;
  /** What the extension's setting resolves to now, and from where. */
  value: unknown;
  source: SettingSource;
  default: unknown;
  /** The user's value, when set and valid -- known only while the extension is enabled. */
  user: { set: boolean; value: unknown; known: boolean };
  /** This workspace's value, when set and valid (it wins over everything). */
  workspace: { set: boolean; value: unknown };
  /** The active profile's value, as stored -- `valid` false: kept, but never applied. */
  profile: { set: boolean; value: unknown; valid: boolean };
}

/** An edit not yet saved: a value as entered, or a reset to what is inherited. */
export type SettingDraft = { kind: "set"; raw: unknown } | { kind: "reset" };

const MAX_STRING = 1000;
const bounds = (setting: SettingContribution) => ({
  min: setting.minimum ?? -Number.MAX_SAFE_INTEGER,
  max: setting.maximum ?? Number.MAX_SAFE_INTEGER,
});

/** What is wrong with `value` for `setting`, or null if it is valid (the native rules). */
export function problemOf(setting: SettingContribution, value: unknown): string | null {
  switch (setting.type) {
    case "boolean":
      return typeof value === "boolean" ? null : "Must be on or off.";
    case "number": {
      const { min, max } = bounds(setting);
      return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
        ? null
        : setting.minimum !== null || setting.maximum !== null
          ? `Must be a number from ${min} to ${max}.`
          : "Must be a number.";
    }
    case "string":
      return typeof value === "string" &&
        value.trim().length > 0 &&
        value.length <= MAX_STRING &&
        !/[\u0000-\u001f\u007f]/.test(value)
        ? null
        : `Must be one line of text, not blank, of at most ${MAX_STRING} characters.`;
    case "enum":
      return typeof value === "string" && setting.values.includes(value)
        ? null
        : `Must be one of: ${setting.values.join(", ")}.`;
  }
}

/** A draft as a value (a number field's text read as a number), or what is wrong with it. */
export function readDraft(
  setting: SettingContribution,
  raw: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  let value = raw;
  if (setting.type === "number") {
    const text = String(raw ?? "").trim();
    value = text === "" ? Number.NaN : Number(text);
    if (Number.isNaN(value)) return { ok: false, error: "Enter a number." };
  }
  const problem = problemOf(setting, value);
  return problem ? { ok: false, error: problem } : { ok: true, value };
}

/** Each setting `settings` declares, resolved for `workspace` and the profile's `profiled`. */
export function rowsOf(
  settings: readonly SettingContribution[],
  registry: Pick<SettingsRegistry, "inspect">,
  definitionOf: (id: string) => SettingDefinition<unknown> | undefined,
  workspace: WorkspaceId | null,
  profiled: Readonly<Record<string, unknown>>,
): SettingRow[] {
  return settings.map((setting) => {
    const definition = definitionOf(setting.id);
    const seen = definition ? registry.inspect(definition, workspace) : null;
    const stored = Object.hasOwn(profiled, setting.id);
    const profile = {
      set: stored,
      value: stored ? profiled[setting.id] : undefined,
      valid: stored && problemOf(setting, profiled[setting.id]) === null,
    };
    const user = {
      set: seen?.user !== undefined,
      value: seen?.user,
      known: !!seen,
    };
    const workspaceValue = { set: seen?.workspace !== undefined, value: seen?.workspace };
    const [value, source]: [unknown, SettingSource] = workspaceValue.set
      ? [workspaceValue.value, "workspace"]
      : profile.valid
        ? [profile.value, "profile"]
        : user.set
          ? [user.value, "user"]
          : [setting.default, "default"];
    return {
      setting,
      value,
      source,
      default: setting.default,
      user,
      workspace: workspaceValue,
      profile,
    };
  });
}

/** What the row inherits at `layer` -- what applies once that layer's value is removed. */
export function inheritedAt(
  row: SettingRow,
  layer: SettingLayer,
): { value: unknown; from: SettingSource } {
  if (layer === "profile" && row.user.set) return { value: row.user.value, from: "user" };
  return { value: row.default, from: "default" };
}

/** Whether `layer` holds a value of its own for the row (one Reset can remove). */
export function overriddenAt(row: SettingRow, layer: SettingLayer): boolean {
  return layer === "profile" ? row.profile.set : row.user.set;
}

/** The value a layer's editor starts from: its own value, else what it inherits. */
export function shownAt(row: SettingRow, layer: SettingLayer): unknown {
  if (layer === "profile" && row.profile.set) return row.profile.value;
  if (layer === "user" && row.user.set) return row.user.value;
  return inheritedAt(row, layer).value;
}

/**
 * The drafts as changes of the profile (each against the value it replaces, as last read), or
 * the problems that keep them from being saved -- by setting id. Nothing is saved with a problem.
 */
export function profileChanges(
  rows: readonly SettingRow[],
  drafts: Readonly<Record<string, SettingDraft>>,
): { changes: ProfileSettingChange[]; problems: Record<string, string> } {
  const changes: ProfileSettingChange[] = [];
  const problems: Record<string, string> = {};
  for (const row of rows) {
    const draft = drafts[row.setting.id];
    if (!draft) continue;
    const expected = row.profile.set ? row.profile.value : null;
    if (draft.kind === "reset") {
      if (row.profile.set) changes.push({ key: row.setting.id, value: null, expected });
      continue;
    }
    const read = readDraft(row.setting, draft.raw);
    if (!read.ok) problems[row.setting.id] = read.error;
    else changes.push({ key: row.setting.id, value: read.value, expected });
  }
  return { changes, problems };
}

/** How a value reads in a sentence. */
export function shown(value: unknown): string {
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "string") return `"${value}"`;
  if (value === undefined || value === null) return "not set";
  return String(value);
}
