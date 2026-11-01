/**
 * Extension profiles (EXT-13), as the window shows and changes them. The native inventory owns
 * them (`extension_profiles.rs`): one active profile for the whole application, its enabled
 * set and its extensions' setting values. This keeps what the native side last said, and asks
 * it for every change -- shown only once it answered.
 */
import { native } from "../native.ts";

export interface ProfileEntry {
  id: string;
  name: string;
}

export interface ProfilesView {
  active: string;
  profiles: ProfileEntry[];
  /** The active profile's values, per extension: `{ "<id>": { "<id>.<key>": value } }`. */
  settings: Record<string, Record<string, unknown>>;
}

export interface ProfileSwitch {
  profiles: ProfilesView;
  /** Enabled extensions the profile leaves unable to load (a required dependency it disables). */
  unavailable: { id: string; reason: string }[];
}

/**
 * One change of a setting in a profile (EXT-18): `value` null removes the override; `expected`
 * is the value it replaces, as last read (null: not set) -- the native side refuses the change
 * if that is no longer so (`SettingChanged`).
 */
export interface ProfileSettingChange {
  key: string;
  value: unknown;
  expected: unknown;
}

export interface ProfileIo {
  list(): Promise<ProfilesView>;
  create(name: string): Promise<ProfilesView>;
  rename(id: string, name: string): Promise<ProfilesView>;
  remove(id: string): Promise<ProfilesView>;
  select(id: string): Promise<ProfileSwitch>;
  setSetting(id: string, key: string, value: unknown): Promise<ProfilesView>;
  /** All of `changes` to extension `id`'s settings in profile `profile`, or none (EXT-18). */
  saveSettings(
    id: string,
    profile: string,
    changes: readonly ProfileSettingChange[],
  ): Promise<ProfilesView>;
}

export const nativeProfiles: ProfileIo = {
  list: () => native("extensions_profiles", {}),
  create: (name) => native("extensions_profile_create", { name }),
  rename: (id, name) => native("extensions_profile_rename", { id, name }),
  remove: (id) => native("extensions_profile_delete", { id }),
  select: (id) => native("extensions_profile_select", { id }),
  setSetting: (id, key, value) =>
    native("extensions_profile_setting", { id, key, value: value === undefined ? null : value }),
  saveSettings: (id, profile, changes) =>
    native("extensions_profile_settings", {
      id,
      profile,
      changes: changes.map((change) => ({
        key: change.key,
        value: change.value === undefined ? null : change.value,
        expected: change.expected === undefined ? null : change.expected,
      })),
    }),
};

export function createProfileStore(io: ProfileIo = nativeProfiles) {
  let view: ProfilesView | null = null;
  const listeners = new Set<() => void>();
  const set = (next: ProfilesView) => {
    view = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    getSnapshot: () => view,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** What the native side listed (discovery). */
    set,
    /** The active profile's setting values (empty until listed). */
    settings: (): Readonly<Record<string, Readonly<Record<string, unknown>>>> =>
      view?.settings ?? {},
    create: async (name: string) => set(await io.create(name)),
    rename: async (id: string, name: string) => set(await io.rename(id, name)),
    remove: async (id: string) => set(await io.remove(id)),
    async select(id: string): Promise<ProfileSwitch> {
      const switched = await io.select(id);
      set(switched.profiles);
      return switched;
    },
    setSetting: async (id: string, key: string, value: unknown) =>
      set(await io.setSetting(id, key, value)),
    /** Saves `changes` in `profile` (EXT-18); what the native side then holds is shown. */
    saveSettings: async (id: string, profile: string, changes: readonly ProfileSettingChange[]) =>
      set(await io.saveSettings(id, profile, changes)),
    /** What the native side holds now (after another window changed it, say). */
    refresh: async () => set(await io.list()),
  };
}

export type ProfileStore = ReturnType<typeof createProfileStore>;

/** The window's profiles. */
export const profileStore = createProfileStore();
