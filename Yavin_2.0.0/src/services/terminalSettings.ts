/**
 * What the terminal keeps across restarts (TERMINAL-07): its configuration and its layout,
 * never its sessions.
 *
 * ```text
 * user     yavin.terminal.user                     profiles, default, integration, layout
 * workspace yavin.terminal.workspace:<WorkspaceId>  profiles, default, integration override, layout
 * ```
 *
 * | Kept                                   | Never kept                                        |
 * | -------------------------------------- | ------------------------------------------------- |
 * | user and workspace profiles, defaults  | sessions, processes, pids, generations            |
 * | shell integration on/off (and override)| output, scrollback, the replay buffer             |
 * | font size, split ratio, panel height   | the shell's folder, its command, any exit status  |
 * | the format's version                   | xterm instances, focus, find, bells, notices      |
 *
 * Like the minimap's preferences these belong to this installation, not to a project: they
 * live in the webview's storage, keyed per workspace the way Git's repositories are, and are
 * never written into the workspace.
 *
 * **Never trusted.** Storage can be missing, blocked, hand-edited or written by another
 * version. Every read is validated field by field and profile by profile:
 * - unreadable (not JSON, not an object) or partly unreadable (a bad field or profile, which is
 *   dropped): what can be read is used, and the stored text is first copied to `<key>.corrupt`,
 *   so nothing is lost when the repaired settings are written back;
 * - written by a newer Yavin (`version` above ours): nothing is read, and nothing is ever
 *   written over it -- the defaults apply until the window closes;
 * - storage unavailable or full: the settings still apply, for this window only.
 * What happened is reported (`problems`) for the window to show once.
 */
import { validateProfile, type TerminalProfile, type WorkspaceId } from "./terminalProtocol.ts";
import { DEFAULT_FONT_SIZE, type ShellKind } from "./terminal.ts";

export const TERMINAL_SETTINGS_VERSION = 1;

export const USER_KEY = "yavin.terminal.user";
export const workspaceKey = (id: WorkspaceId) => `yavin.terminal.workspace:${id}`;

/** A profile as kept: the launch configuration and the kind of shell it was made for. */
export interface StoredProfile extends TerminalProfile {
  kind: ShellKind;
}

/** How the terminal is laid out. */
export interface TerminalLayout {
  fontSize: number;
  splitRatio: number;
  panelHeight: number;
}

export interface UserTerminalSettings {
  profiles: StoredProfile[];
  defaultProfile: string | null;
  /** Whether shells' integration (OSC 7/133) is read; on unless turned off. */
  shellIntegration: boolean;
  /** The layout last used anywhere: what a workspace with none of its own starts with. */
  layout: TerminalLayout | null;
}

export interface WorkspaceTerminalSettings {
  profiles: StoredProfile[];
  defaultProfile: string | null;
  /** `null`: as the user setting says. */
  shellIntegration: boolean | null;
  layout: TerminalLayout | null;
}

export const DEFAULT_LAYOUT: TerminalLayout = {
  fontSize: DEFAULT_FONT_SIZE,
  splitRatio: 0.5,
  panelHeight: 260,
};
export const LAYOUT_LIMITS = {
  fontSize: [6, 32],
  splitRatio: [0.2, 0.8],
  panelHeight: [120, 4000],
} as const;

const EMPTY_USER: UserTerminalSettings = {
  profiles: [],
  defaultProfile: null,
  shellIntegration: true,
  layout: null,
};
const EMPTY_WORKSPACE: WorkspaceTerminalSettings = {
  profiles: [],
  defaultProfile: null,
  shellIntegration: null,
  layout: null,
};

const KINDS: readonly ShellKind[] = [
  "cmd",
  "powershell",
  "pwsh",
  "bash",
  "zsh",
  "fish",
  "sh",
  "other",
];
const ID = /^[A-Za-z0-9._-]{1,64}$/;

/** What reading one stored record found. */
export interface Decoded<T> {
  value: T;
  /**
   * - `empty`: nothing stored;
   * - `ok`: read as written;
   * - `repaired`: some of it could not be read and was dropped;
   * - `corrupt`: none of it could be read;
   * - `newer`: written by a newer version, not read, and not to be overwritten.
   */
  status: "empty" | "ok" | "repaired" | "corrupt" | "newer";
  problems: string[];
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** One stored profile, or why it cannot be used. */
function readProfile(raw: unknown): StoredProfile | string {
  const p = record(raw);
  if (!p) return "a profile that is not an object";
  const { id, name, executable, args, cwd, env, login, kind } = p;
  if (typeof id !== "string" || !ID.test(id) || id.startsWith("builtin."))
    return "a profile with an invalid id";
  const label = `profile ${id}`;
  if (typeof name !== "string" || !name.trim() || name.trim().length > 64)
    return `${label}: an invalid name`;
  if (typeof executable !== "string") return `${label}: an invalid shell`;
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string"))
    return `${label}: invalid arguments`;
  if (cwd !== null && typeof cwd !== "string") return `${label}: an invalid folder`;
  if (
    !Array.isArray(env) ||
    !env.every(
      (pair) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        typeof pair[0] === "string" &&
        typeof pair[1] === "string",
    )
  )
    return `${label}: an invalid environment`;
  if (login !== undefined && typeof login !== "boolean") return `${label}: an invalid login flag`;
  if (!KINDS.includes(kind as ShellKind)) return `${label}: an unknown kind of shell`;
  const profile: StoredProfile = {
    id,
    name: name.trim(),
    executable,
    args: [...(args as string[])],
    cwd: (cwd as string | null) || null,
    env: (env as [string, string][]).map(([k, v]) => [k, v]),
    ...(login ? { login: true } : {}),
    kind: kind as ShellKind,
  };
  // The same rules a launch is held to (T05): a profile that could never start is not kept.
  const problem = validateProfile(profile);
  if (problem) return `${label}: ${problem.message}`;
  return profile;
}

function readProfiles(raw: unknown, problems: string[]) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    problems.push("The profiles could not be read.");
    return [];
  }
  const seen = new Set<string>();
  const profiles: StoredProfile[] = [];
  for (const entry of raw) {
    const profile = readProfile(entry);
    if (typeof profile === "string") problems.push(`Skipped ${profile}.`);
    else if (seen.has(profile.id)) problems.push(`Skipped a second profile ${profile.id}.`);
    else {
      seen.add(profile.id);
      profiles.push(profile);
    }
  }
  return profiles;
}

const within = (value: unknown, [min, max]: readonly [number, number]) =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

function readLayout(raw: unknown, problems: string[]): TerminalLayout | null {
  if (raw === undefined || raw === null) return null;
  const l = record(raw);
  if (!l) {
    problems.push("The layout could not be read.");
    return null;
  }
  // Field by field: one bad value falls back to its default, the rest is kept.
  const layout = { ...DEFAULT_LAYOUT };
  for (const key of ["fontSize", "splitRatio", "panelHeight"] as const) {
    if (l[key] === undefined) continue;
    if (within(l[key], LAYOUT_LIMITS[key]))
      layout[key] = key === "splitRatio" ? (l[key] as number) : Math.round(l[key] as number);
    else problems.push(`The layout's ${key} could not be read.`);
  }
  return layout;
}

function readDefault(raw: unknown, problems: string[]): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string" && ID.test(raw)) return raw;
  problems.push("The default profile could not be read.");
  return null;
}

/** The envelope: JSON, an object, a version this Yavin reads. */
function open(text: string | null): { body: Record<string, unknown> } | Decoded<null> {
  if (text === null) return { value: null, status: "empty", problems: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      value: null,
      status: "corrupt",
      problems: ["The terminal settings are not valid JSON."],
    };
  }
  const body = record(parsed);
  if (!body || !Number.isSafeInteger(body.version) || (body.version as number) < 1)
    return {
      value: null,
      status: "corrupt",
      problems: ["The terminal settings could not be read."],
    };
  if ((body.version as number) > TERMINAL_SETTINGS_VERSION)
    return {
      value: null,
      status: "newer",
      problems: [
        "The terminal settings were saved by a newer version of Yavin; they are left as they are and not used.",
      ],
    };
  return { body };
}

export function decodeUserSettings(text: string | null): Decoded<UserTerminalSettings> {
  const opened = open(text);
  if (!("body" in opened)) return { ...opened, value: structuredClone(EMPTY_USER) };
  const { body } = opened;
  const problems: string[] = [];
  let shellIntegration = true;
  if (body.shellIntegration !== undefined) {
    if (typeof body.shellIntegration === "boolean") shellIntegration = body.shellIntegration;
    else problems.push("The shell integration setting could not be read.");
  }
  const value: UserTerminalSettings = {
    profiles: readProfiles(body.profiles, problems),
    defaultProfile: readDefault(body.defaultProfile, problems),
    shellIntegration,
    layout: readLayout(body.layout, problems),
  };
  return { value, status: problems.length ? "repaired" : "ok", problems };
}

export function decodeWorkspaceSettings(text: string | null): Decoded<WorkspaceTerminalSettings> {
  const opened = open(text);
  if (!("body" in opened)) return { ...opened, value: structuredClone(EMPTY_WORKSPACE) };
  const { body } = opened;
  const problems: string[] = [];
  let shellIntegration: boolean | null = null;
  if (body.shellIntegration !== undefined && body.shellIntegration !== null) {
    if (typeof body.shellIntegration === "boolean") shellIntegration = body.shellIntegration;
    else problems.push("The workspace's shell integration setting could not be read.");
  }
  const value: WorkspaceTerminalSettings = {
    profiles: readProfiles(body.profiles, problems),
    defaultProfile: readDefault(body.defaultProfile, problems),
    shellIntegration,
    layout: readLayout(body.layout, problems),
  };
  return { value, status: problems.length ? "repaired" : "ok", problems };
}

export function encodeSettings(value: UserTerminalSettings | WorkspaceTerminalSettings): string {
  return JSON.stringify({ version: TERMINAL_SETTINGS_VERSION, ...value });
}

// --- The store --------------------------------------------------------------------------------

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

const defaultStorage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export interface TerminalSettingsStore {
  user(): UserTerminalSettings;
  updateUser(patch: Partial<UserTerminalSettings>): void;
  workspace(id: WorkspaceId): WorkspaceTerminalSettings;
  updateWorkspace(id: WorkspaceId, patch: Partial<WorkspaceTerminalSettings>): void;
  /** Whether a workspace's shells read their integration: its override, else the user's. */
  shellIntegration(id: WorkspaceId): boolean;
  /** What went wrong reading or writing, since last asked: for the window to show once. */
  takeProblems(): string[];
  /** Any change: a setting updated, or a problem found. */
  subscribe(listener: () => void): () => void;
  /** Writes what is waiting now (layout changes are written a moment after they settle). */
  flush(): void;
}

/** How long a layout change waits before it is written: a drag moves it many times a second. */
const LAYOUT_DELAY = 300;

export function createTerminalSettings(
  storage: Storage | null = defaultStorage(),
  options: { delay?: number } = {},
): TerminalSettingsStore {
  const delay = options.delay ?? LAYOUT_DELAY;
  const listeners = new Set<() => void>();
  let problems: string[] = [];
  /** Keys written by a newer Yavin: read-only for this window. */
  const frozen = new Set<string>();
  const pending = new Map<string, () => string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const changed = () => {
    for (const listener of [...listeners])
      try {
        listener();
      } catch {
        /* One listener's failure is not the store's. */
      }
  };
  const note = (where: string, found: string[]) => {
    for (const problem of found) problems.push(`${where}: ${problem}`);
    if (found.length) changed();
  };

  const read = <T>(key: string, where: string, decode: (text: string | null) => Decoded<T>) => {
    let text: string | null = null;
    try {
      text = storage?.getItem(key) ?? null;
    } catch {
      note(where, ["The terminal settings could not be read from storage; defaults apply."]);
    }
    const decoded = decode(text);
    if (decoded.status === "newer") frozen.add(key);
    if ((decoded.status === "corrupt" || decoded.status === "repaired") && text !== null) {
      // Kept aside before anything is written back, so a repair never loses what was there.
      try {
        storage?.setItem(`${key}.corrupt`, text);
        decoded.problems.push(`What could not be read was kept in ${key}.corrupt.`);
      } catch {
        /* Storage full: the problem is still reported. */
      }
    }
    note(where, decoded.problems);
    return decoded.value;
  };

  const write = (key: string, encode: () => string) => {
    if (frozen.has(key) || !storage) return;
    try {
      storage.setItem(key, encode());
    } catch {
      note("Terminal settings", ["They could not be saved; they apply until the window closes."]);
    }
  };

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const writes = [...pending];
    pending.clear();
    for (const [key, encode] of writes) write(key, encode);
  };

  const schedule = (key: string, encode: () => string, later: boolean) => {
    if (!later) {
      pending.delete(key);
      write(key, encode);
      return;
    }
    pending.set(key, encode);
    if (!timer) timer = setTimeout(flush, delay);
  };

  let user: UserTerminalSettings | null = null;
  const workspaces = new Map<WorkspaceId, WorkspaceTerminalSettings>();

  const store: TerminalSettingsStore = {
    user() {
      user ??= read(USER_KEY, "Terminal settings", decodeUserSettings);
      return user;
    },
    updateUser(patch) {
      user = { ...store.user(), ...patch };
      const current = user;
      // Only a layout change waits: the configuration is written at once.
      const onlyLayout = Object.keys(patch).every((key) => key === "layout");
      schedule(USER_KEY, () => encodeSettings(current), onlyLayout);
      changed();
    },
    workspace(id) {
      let settings = workspaces.get(id);
      if (!settings) {
        settings = read(
          workspaceKey(id),
          "This workspace's terminal settings",
          decodeWorkspaceSettings,
        );
        workspaces.set(id, settings);
      }
      return settings;
    },
    updateWorkspace(id, patch) {
      const next = { ...store.workspace(id), ...patch };
      workspaces.set(id, next);
      const onlyLayout = Object.keys(patch).every((key) => key === "layout");
      schedule(workspaceKey(id), () => encodeSettings(next), onlyLayout);
      changed();
    },
    shellIntegration(id) {
      return store.workspace(id).shellIntegration ?? store.user().shellIntegration;
    },
    takeProblems() {
      const taken = problems;
      problems = [];
      return taken;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    flush,
  };
  return store;
}
