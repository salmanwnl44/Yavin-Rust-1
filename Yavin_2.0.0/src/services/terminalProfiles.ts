/**
 * Terminal profiles (TERMINAL-05): how a terminal starts, apart from the terminals themselves.
 *
 * ```text
 * discovery (native terminal_shells)   what shells are there, found or not, which is the default
 *        |
 * ProfileRegistry (window)              built-in profiles (one per discovered shell, read-only)
 *        |                              user profiles, the user default
 * WorkspaceProfiles (per WorkspaceId)   + workspace profiles, the workspace default; resolve()
 *        |
 * TerminalUi.newTerminal -> TerminalService.open(profile) -> native open (T01)
 * ```
 *
 * A profile is configuration, not permission: its executable must be one of the shells discovery
 * found (the native allowlist refuses anything else), its arguments stay structured (never a
 * command line), and the native side still checks the folder, the arguments and the
 * environment at launch. A profile holds no session, process, output or view state.
 *
 * User and workspace profiles and defaults are kept across restarts by the terminal settings
 * (TERMINAL-07, `terminalSettings.ts`), which this registry reads and writes; built-in profiles
 * are never kept -- discovery makes them each time.
 */
import {
  TerminalError,
  validateProfile,
  type TerminalProfile,
  type WorkspaceId,
} from "./terminalProtocol.ts";
import type { Shell, ShellKind } from "./terminal.ts";
import type { StoredProfile, TerminalSettingsStore } from "./terminalSettings.ts";

export type ProfileScope = "builtin" | "user" | "workspace";

/** A profile as the registry offers it: the launch configuration, where it comes from, and
 * whether it can be launched on this machine (and if not, why). */
export interface ProfileEntry {
  readonly scope: ProfileScope;
  readonly profile: Readonly<TerminalProfile>;
  readonly kind: ShellKind;
  readonly available: boolean;
  readonly reason: string | null;
}

/** What a user writes to make or change a profile. */
export interface ProfileInput {
  name: string;
  /** One of the shells discovery found. */
  executable: string;
  args?: readonly string[];
  /** Absolute, or relative to the workspace root; `null` for the workspace root. */
  cwd?: string | null;
  /** Added to, or overriding, the inherited environment, in order. */
  env?: readonly (readonly [string, string])[];
  /** Start it as a login shell: only for shells that have such a mode. */
  login?: boolean;
}

export interface RegistrySnapshot {
  /** `null` until discovery has answered. */
  readonly shells: readonly Shell[] | null;
  /** Why discovery failed (the browser preview has no native side). */
  readonly error: string | null;
  readonly builtins: readonly ProfileEntry[];
  readonly users: readonly ProfileEntry[];
  readonly userDefault: string | null;
}

export interface WorkspaceProfilesSnapshot {
  readonly loaded: boolean;
  readonly error: string | null;
  /** Built-in, then user, then workspace profiles. */
  readonly profiles: readonly ProfileEntry[];
  readonly userDefault: string | null;
  readonly workspaceDefault: string | null;
  /** The profile a terminal starts with when none is asked for; `null` if none can. */
  readonly effectiveDefault: string | null;
}

export interface WorkspaceProfiles {
  readonly workspaceId: WorkspaceId;
  readonly registry: ProfileRegistry;
  load(): void;
  getSnapshot(): WorkspaceProfilesSnapshot;
  subscribe(listener: () => void): () => void;
  get(id: string): ProfileEntry | undefined;
  /**
   * The profile to launch: the one asked for, else the workspace default, the user default,
   * the platform default, the first available -- never an unavailable one. Throws a
   * `TerminalError` when none can launch.
   */
  resolve(requested?: string): ProfileEntry;
  addWorkspace(input: ProfileInput): ProfileEntry;
  updateWorkspace(id: string, input: ProfileInput): ProfileEntry;
  removeWorkspace(id: string): void;
  setWorkspaceDefault(id: string | null): void;
}

export interface ProfileRegistry {
  load(): Promise<void>;
  getSnapshot(): RegistrySnapshot;
  subscribe(listener: () => void): () => void;
  /** `null` when `input` is a valid profile; the reason otherwise. */
  validate(input: ProfileInput): TerminalError | null;
  addUser(input: ProfileInput): ProfileEntry;
  updateUser(id: string, input: ProfileInput): ProfileEntry;
  removeUser(id: string): void;
  setUserDefault(id: string | null): void;
  forWorkspace(id: WorkspaceId): WorkspaceProfiles;
}

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
const LOGIN_KINDS: readonly ShellKind[] = ["bash", "zsh", "fish", "sh"];
const ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Whether a shell of this kind has a login mode (the native side translates it). */
export const supportsLogin = (kind: ShellKind) => LOGIN_KINDS.includes(kind);

/** Whether two paths name the same program, ignoring separator style and case. */
const samePath = (one: string, other: string) =>
  one.replaceAll("\\", "/").toLowerCase() === other.replaceAll("\\", "/").toLowerCase();

/**
 * Discovery's answer, read defensively: what an older native side (or a test) leaves out is
 * filled in -- found, of no particular kind, the first found being the default.
 */
export function parseShells(raw: unknown): Shell[] {
  if (!Array.isArray(raw)) return [];
  const shells = raw
    .filter(
      (one): one is Record<string, unknown> =>
        !!one &&
        typeof one === "object" &&
        typeof one.name === "string" &&
        typeof one.path === "string",
    )
    .map((one): Shell => ({
      name: one.name as string,
      path: one.path as string,
      kind: KINDS.includes(one.kind as ShellKind) ? (one.kind as ShellKind) : "other",
      platform: one.platform === "unix" ? "unix" : "windows",
      available: one.available !== false,
      reason: typeof one.reason === "string" ? one.reason : null,
      isDefault: one.isDefault === true,
    }));
  if (!shells.some((shell) => shell.isDefault)) {
    const first = shells.find((shell) => shell.available);
    if (first) first.isDefault = true;
  }
  return shells;
}

const freeze = (profile: TerminalProfile): Readonly<TerminalProfile> =>
  Object.freeze({
    ...profile,
    args: Object.freeze([...profile.args]) as string[],
    env: Object.freeze(profile.env.map(([k, v]) => Object.freeze([k, v]) as [string, string])) as [
      string,
      string,
    ][],
  });

/**
 * The window's profiles. With `settings` (TERMINAL-07) the user's and each workspace's own
 * profiles and defaults are read from it when first needed and written back on every change;
 * without, they last as long as the window. Either way a running terminal keeps the copy of
 * the profile it started with: changing or deleting a profile affects only later launches.
 */
export function createProfileRegistry(
  discover: () => Promise<unknown>,
  settings?: TerminalSettingsStore,
): ProfileRegistry {
  const listeners = new Set<() => void>();
  let shells: Shell[] | null = null;
  let error: string | null = null;
  let loading: Promise<void> | null = null;
  const users = new Map<string, ProfileEntry>();
  let userDefault: string | null = null;
  let created = 0;
  const workspaceViews = new Map<WorkspaceId, WorkspaceProfilesImpl>();
  let snapshot: RegistrySnapshot;

  const changed = () => {
    snapshot = Object.freeze({
      shells,
      error,
      builtins: builtins(),
      users: [...users.values()].map(refresh),
      userDefault,
    });
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* One listener's failure is not the others'. */
      }
    }
    for (const view of workspaceViews.values()) view.changed();
  };

  const shellFor = (executable: string) =>
    shells?.find((shell) => shell.available && samePath(shell.path, executable));

  /**
   * A kept profile, as it was saved: already validated as configuration when it was read. It
   * is not checked against discovery here -- the shell may be missing now, or not known yet --
   * but, like any user profile, it can only launch while discovery finds its shell (`refresh`).
   */
  const restore = (scope: "user" | "workspace", stored: StoredProfile): ProfileEntry => {
    const { kind, ...profile } = stored;
    return refresh(
      Object.freeze({ scope, profile: freeze(profile), kind, available: false, reason: null }),
    );
  };
  const toStored = (entry: ProfileEntry): StoredProfile => ({
    ...entry.profile,
    args: [...entry.profile.args],
    env: entry.profile.env.map(([k, v]) => [k, v] as [string, string]),
    kind: entry.kind,
  });
  const saveUser = () =>
    settings?.updateUser({
      profiles: [...users.values()].map(toStored),
      defaultProfile: userDefault,
    });

  /** A profile's availability, from what discovery found now. */
  const refresh = (entry: ProfileEntry): ProfileEntry => {
    if (entry.scope === "builtin") return entry;
    const shell = shellFor(entry.profile.executable);
    return Object.freeze({
      ...entry,
      kind: shell?.kind ?? entry.kind,
      available: !!shell,
      reason: shell ? null : `${entry.profile.executable} is not one of the shells found here.`,
    });
  };

  let builtinCache: { from: Shell[] | null; entries: readonly ProfileEntry[] } = {
    from: null,
    entries: [],
  };
  /** One read-only profile per discovered shell, found or not, with a stable id per kind. */
  function builtins(): readonly ProfileEntry[] {
    if (builtinCache.from === shells) return builtinCache.entries;
    const seen = new Map<string, number>();
    const entries = (shells ?? []).map((shell) => {
      const base = `builtin.${shell.kind === "other" ? shell.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") : shell.kind}`;
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      return Object.freeze({
        scope: "builtin" as const,
        profile: freeze({
          id: count === 1 ? base : `${base}-${count}`,
          name: shell.name,
          executable: shell.path,
          args: [],
          cwd: null,
          env: [],
        }),
        kind: shell.kind,
        available: shell.available,
        reason: shell.available ? null : shell.reason,
      });
    });
    builtinCache = { from: shells, entries: Object.freeze(entries) };
    return builtinCache.entries;
  }

  const invalid = (message: string) => new TerminalError("ProtocolError", message);

  function validate(input: ProfileInput): TerminalError | null {
    const name = input.name.trim();
    if (!name || name.length > 64) return invalid("A profile needs a name of 1 to 64 characters.");
    if (!input.executable.trim()) return invalid("A profile needs a shell to start.");
    if (shells === null)
      return new TerminalError("ShellUnavailable", "The shells on this machine are not known yet.");
    const shell = shellFor(input.executable);
    // Configuration, not permission: only a shell discovery found can be a profile's.
    if (!shell)
      return new TerminalError(
        "ShellUnavailable",
        `${input.executable} is not one of the shells found on this machine.`,
      );
    if (input.login && !supportsLogin(shell.kind))
      return invalid(`${shell.name} has no login mode.`);
    return validateProfile({
      id: "candidate",
      name,
      executable: shell.path,
      args: [...(input.args ?? [])],
      cwd: input.cwd ?? null,
      env: (input.env ?? []).map(([k, v]) => [k, v]),
    });
  }

  /** A validated profile in `scope`, under `id`. */
  const make = (scope: ProfileScope, id: string, input: ProfileInput): ProfileEntry => {
    const problem = validate(input);
    if (problem) throw problem;
    if (!ID.test(id)) throw invalid("That is not a valid profile id.");
    const shell = shellFor(input.executable)!;
    return refresh(
      Object.freeze({
        scope,
        profile: freeze({
          id,
          name: input.name.trim(),
          executable: shell.path,
          args: [...(input.args ?? [])],
          cwd: input.cwd || null,
          env: (input.env ?? []).map(([k, v]) => [k, v] as [string, string]),
          ...(input.login ? { login: true } : {}),
        }),
        kind: shell.kind,
        available: true,
        reason: null,
      }),
    );
  };

  /** Ids are unique across every scope, so no profile can stand in for another. */
  const idTaken = (id: string) =>
    builtins().some((entry) => entry.profile.id === id) ||
    users.has(id) ||
    [...workspaceViews.values()].some((view) => view.has(id));

  const nextId = (scope: "user" | "workspace") => {
    let id: string;
    do id = `${scope}-${++created}`;
    while (idTaken(id));
    return id;
  };

  const refuseBuiltin = (id: string) => {
    if (builtins().some((entry) => entry.profile.id === id))
      throw invalid("Built-in profiles cannot be changed; make a profile of your own instead.");
  };

  class WorkspaceProfilesImpl implements WorkspaceProfiles {
    readonly registry: ProfileRegistry = registry;
    private readonly own = new Map<string, ProfileEntry>();
    private workspaceDefault: string | null = null;
    private readonly listeners = new Set<() => void>();
    private snapshot!: WorkspaceProfilesSnapshot;

    readonly workspaceId: WorkspaceId;

    constructor(workspaceId: WorkspaceId) {
      this.workspaceId = workspaceId;
      if (settings) {
        const kept = settings.workspace(workspaceId);
        for (const stored of kept.profiles)
          // Ids are unique across scopes; a hand-edited clash is not let in.
          if (!idTaken(stored.id)) this.own.set(stored.id, restore("workspace", stored));
        this.workspaceDefault = kept.defaultProfile;
      }
      this.snapshot = this.compute();
    }

    private save() {
      settings?.updateWorkspace(this.workspaceId, {
        profiles: [...this.own.values()].map(toStored),
        defaultProfile: this.workspaceDefault,
      });
    }

    has(id: string) {
      return this.own.has(id);
    }

    changed() {
      this.snapshot = this.compute();
      for (const listener of [...this.listeners]) {
        try {
          listener();
        } catch {
          /* One listener's failure is not the others'. */
        }
      }
    }

    private compute(): WorkspaceProfilesSnapshot {
      const profiles = Object.freeze([
        ...builtins(),
        ...[...users.values()].map(refresh),
        ...[...this.own.values()].map(refresh),
      ]);
      let effectiveDefault: string | null = null;
      try {
        effectiveDefault = shells === null ? null : this.pick(profiles).profile.id;
      } catch {
        effectiveDefault = null;
      }
      return Object.freeze({
        loaded: shells !== null || error !== null,
        error,
        profiles,
        userDefault,
        workspaceDefault: this.workspaceDefault,
        effectiveDefault,
      });
    }

    load() {
      void registry.load();
    }
    getSnapshot = () => this.snapshot;
    subscribe = (listener: () => void) => {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    };
    get(id: string) {
      return this.snapshot.profiles.find((entry) => entry.profile.id === id);
    }

    /** The default chain, over `profiles`, skipping anything unavailable. */
    private pick(profiles: readonly ProfileEntry[]): ProfileEntry {
      const usable = (id: string | null) =>
        id === null
          ? undefined
          : profiles.find((entry) => entry.profile.id === id && entry.available);
      const platform = profiles.find(
        (entry) =>
          entry.scope === "builtin" &&
          entry.available &&
          shells?.some(
            (shell) => shell.isDefault && samePath(shell.path, entry.profile.executable),
          ),
      );
      const found =
        usable(this.workspaceDefault) ??
        usable(userDefault) ??
        platform ??
        profiles.find((entry) => entry.available);
      if (!found)
        throw new TerminalError("ShellUnavailable", "No shell could be found on this machine.");
      return found;
    }

    resolve(requested?: string): ProfileEntry {
      if (error !== null) throw new TerminalError("ShellUnavailable", error);
      if (shells === null)
        throw new TerminalError(
          "ShellUnavailable",
          "The shells on this machine are not known yet.",
        );
      if (requested === undefined) return this.pick(this.snapshot.profiles);
      const entry = this.get(requested);
      if (!entry) throw invalid("There is no such terminal profile.");
      // Asked for by name: never silently swapped for another shell.
      if (!entry.available)
        throw new TerminalError(
          "ShellUnavailable",
          entry.reason ?? `${entry.profile.name} cannot be started on this machine.`,
        );
      return entry;
    }

    addWorkspace(input: ProfileInput) {
      const entry = make("workspace", nextId("workspace"), input);
      this.own.set(entry.profile.id, entry);
      this.save();
      this.changed();
      return entry;
    }
    updateWorkspace(id: string, input: ProfileInput) {
      refuseBuiltin(id);
      if (!this.own.has(id)) throw invalid("That is not one of this workspace's profiles.");
      const entry = make("workspace", id, input);
      this.own.set(id, entry);
      this.save();
      this.changed();
      return entry;
    }
    removeWorkspace(id: string) {
      refuseBuiltin(id);
      if (!this.own.delete(id)) throw invalid("That is not one of this workspace's profiles.");
      if (this.workspaceDefault === id) this.workspaceDefault = null;
      this.save();
      this.changed();
    }
    setWorkspaceDefault(id: string | null) {
      if (id !== null && !this.get(id)) throw invalid("There is no such terminal profile.");
      this.workspaceDefault = id;
      this.save();
      this.changed();
    }
  }

  const registry: ProfileRegistry = {
    load() {
      loading ??= discover().then(
        (raw) => {
          shells = parseShells(raw);
          error = null;
          changed();
        },
        (reason) => {
          shells = [];
          error = String(reason);
          changed();
        },
      );
      return loading;
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    validate,
    addUser(input) {
      const entry = make("user", nextId("user"), input);
      users.set(entry.profile.id, entry);
      saveUser();
      changed();
      return entry;
    },
    updateUser(id, input) {
      refuseBuiltin(id);
      if (!users.has(id)) throw invalid("That is not one of your profiles.");
      const entry = make("user", id, input);
      users.set(id, entry);
      saveUser();
      changed();
      return entry;
    },
    removeUser(id) {
      refuseBuiltin(id);
      if (!users.delete(id)) throw invalid("That is not one of your profiles.");
      if (userDefault === id) userDefault = null;
      saveUser();
      changed();
    },
    setUserDefault(id) {
      if (id !== null && !builtins().some((e) => e.profile.id === id) && !users.has(id))
        throw invalid("A user default must be a built-in or user profile.");
      userDefault = id;
      saveUser();
      changed();
    },
    forWorkspace(id) {
      let view = workspaceViews.get(id);
      if (!view) {
        view = new WorkspaceProfilesImpl(id);
        workspaceViews.set(id, view);
      }
      return view;
    },
  };
  if (settings) {
    const kept = settings.user();
    for (const stored of kept.profiles) users.set(stored.id, restore("user", stored));
    userDefault = kept.defaultProfile;
  }
  snapshot = Object.freeze({
    shells,
    error,
    builtins: [],
    users: [...users.values()].map(refresh),
    userDefault,
  });
  return registry;
}
