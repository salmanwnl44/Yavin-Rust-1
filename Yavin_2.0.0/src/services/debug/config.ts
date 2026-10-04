/**
 * Debug configurations (IDE-05): what to debug, adapter-neutral. They are settings -- the
 * user's and each workspace's -- kept and validated by the settings registry (IDE-03) under
 * `debug.configurations`, as tasks are; there is no `launch.json` and no `.yavin/` file. How a
 * configuration becomes an adapter's `launch` / `attach` arguments is `adapters.ts`'s.
 */
import { stringSetting, structuredSetting, type SettingsRegistry } from "../settings/settings.ts";
import type { WorkspaceId } from "../terminalProtocol.ts";
import { DEBUG_ADAPTERS } from "./adapters.ts";

export interface DebugConfiguration {
  /** Stable identity: what Start Debugging names. */
  id: string;
  name: string;
  /** An adapter of the allow-list (`adapters.ts`, `dap.rs`). */
  adapter: string;
  request: "launch" | "attach";
  /** `launch`: the program, relative to the workspace root or absolute inside it. */
  program: string | null;
  /** Where it runs: relative to the root (or absolute inside it); the root when absent. */
  cwd: string | null;
  env: Record<string, string>;
  args: string[];
  /** Stop at the program's first line. */
  stopOnEntry: boolean;
  /** `attach`: the port a debuggee on this machine listens on. */
  port: number | null;
  /** A task (IDE-04) that must succeed first. */
  preLaunchTask: string | null;
}

export interface ResolvedDebugConfiguration extends DebugConfiguration {
  scope: "user" | "workspace";
}

const ID = /^[A-Za-z0-9._-]{1,64}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const oneLine = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(value);

/** One entry of the list, or why it is not one. */
export function readConfiguration(raw: unknown, index = 0): DebugConfiguration | string {
  const where = `Configuration ${index + 1}`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return `${where} is not an object.`;
  const value = raw as Record<string, unknown>;
  const known = new Set([
    "id",
    "name",
    "adapter",
    "request",
    "program",
    "cwd",
    "env",
    "args",
    "stopOnEntry",
    "port",
    "preLaunchTask",
  ]);
  const unknown = Object.keys(value).find((key) => !known.has(key));
  if (unknown) return `${where} has "${unknown}", which is not a debug configuration field.`;
  if (typeof value.id !== "string" || !ID.test(value.id))
    return `${where} needs an "id" of letters, digits, ".", "_" or "-" (at most 64).`;
  const id = value.id;
  const named = `Configuration "${id}"`;
  const name = value.name ?? id;
  if (!oneLine(name, 100)) return `${named}: "name" must be one line of at most 100 characters.`;
  if (typeof value.adapter !== "string" || !DEBUG_ADAPTERS.some((a) => a.id === value.adapter))
    return `${named}: "adapter" must be one of ${DEBUG_ADAPTERS.map((a) => `"${a.id}"`).join(", ")}.`;
  const request = value.request ?? "launch";
  if (request !== "launch" && request !== "attach")
    return `${named}: "request" must be "launch" or "attach".`;
  const program = value.program ?? null;
  if (program !== null && !oneLine(program, 1000))
    return `${named}: "program" must be one line (a path).`;
  if (request === "launch" && program === null) return `${named}: a launch needs a "program".`;
  const cwd = value.cwd ?? null;
  if (cwd !== null && !oneLine(cwd, 1000)) return `${named}: "cwd" must be one line (a path).`;
  const args = value.args ?? [];
  if (
    !Array.isArray(args) ||
    args.length > 200 ||
    args.some((arg) => typeof arg !== "string" || arg.length > 4000 || /[\u0000]/.test(arg))
  )
    return `${named}: "args" must be a list of strings.`;
  const rawEnv = value.env ?? {};
  if (!rawEnv || typeof rawEnv !== "object" || Array.isArray(rawEnv))
    return `${named}: "env" must be an object of names to strings.`;
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(rawEnv as Record<string, unknown>)) {
    if (!ENV_NAME.test(key) || typeof entry !== "string" || entry.includes("\u0000"))
      return `${named}: "env" must map names (letters, digits, "_") to strings.`;
    env[key] = entry;
  }
  const stopOnEntry = value.stopOnEntry ?? false;
  if (typeof stopOnEntry !== "boolean") return `${named}: "stopOnEntry" must be true or false.`;
  const port = value.port ?? null;
  if (
    port !== null &&
    (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535)
  )
    return `${named}: "port" must be a port number (1-65535).`;
  if (request === "attach" && port === null)
    return `${named}: an attach needs the "port" the program listens on (on this machine).`;
  const preLaunchTask = value.preLaunchTask ?? null;
  if (preLaunchTask !== null && (typeof preLaunchTask !== "string" || !ID.test(preLaunchTask)))
    return `${named}: "preLaunchTask" must be a task id.`;
  return {
    id,
    name,
    adapter: value.adapter,
    request,
    program,
    cwd,
    env,
    args: args as string[],
    stopOnEntry,
    port: port as number | null,
    preLaunchTask: preLaunchTask as string | null,
  };
}

export function readConfigurations(value: unknown): DebugConfiguration[] | string {
  if (!Array.isArray(value)) return "Debug configurations must be a list.";
  const out: DebugConfiguration[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const config = readConfiguration(raw, index);
    if (typeof config === "string") return config;
    if (ids.has(config.id)) return `Two debug configurations have the id "${config.id}".`;
    ids.add(config.id);
    out.push(config);
  }
  return out;
}

export const DEBUG_CONFIGURATIONS = structuredSetting<DebugConfiguration[]>({
  id: "debug.configurations",
  title: "Debug configurations",
  description:
    "What Run › Start Debugging can debug. A workspace configuration replaces your configuration of the same id.",
  section: "Debug",
  default: [],
  parse: (value) => {
    const configs = readConfigurations(value);
    return typeof configs === "string" ? undefined : configs;
  },
  explain: (value) => {
    const configs = readConfigurations(value);
    return typeof configs === "string" ? configs : undefined;
  },
  example: JSON.stringify(
    [{ id: "main", name: "Python: main.py", adapter: "debugpy", program: "main.py" }],
    null,
    2,
  ),
});

export const DEBUG_PYTHON = stringSetting({
  id: "debug.python",
  title: "Python for debugging",
  description:
    "The full path of the Python interpreter that runs debugpy and the program (it needs debugpy installed). Empty: python on PATH.",
  section: "Debug",
  default: "",
  maxLength: 1000,
});

export const DEBUG_SETTING_LIST = [DEBUG_CONFIGURATIONS, DEBUG_PYTHON] as const;

/** The configurations a workspace has: the user's, a workspace one replacing the same id. */
export function configuredDebugConfigurations(
  registry: SettingsRegistry,
  workspace: WorkspaceId | null,
): ResolvedDebugConfiguration[] {
  const state = registry.inspect(DEBUG_CONFIGURATIONS, workspace);
  const byId = new Map<string, ResolvedDebugConfiguration>();
  for (const config of state.user ?? []) byId.set(config.id, { ...config, scope: "user" });
  for (const config of state.workspace ?? [])
    byId.set(config.id, { ...config, scope: "workspace" });
  return [...byId.values()];
}
