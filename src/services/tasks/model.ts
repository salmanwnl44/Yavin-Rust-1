/**
 * Tasks (IDE-04): what a task is, as configured. Definitions are settings -- the user's and each
 * workspace's -- kept and validated by the settings registry (IDE-03) under `tasks.definitions`;
 * there is no tasks file and no other store. What a task does when it runs is `TaskService`'s
 * (`service.ts`), and running it is the terminal's.
 *
 * A task's command is a command line in its shell's own syntax (as typed at a prompt); its
 * `args` are further arguments, each quoted for that shell by Yavin (`shell.ts`). The command
 * runs in a terminal of its own: the chosen profile's shell (the default one when none is
 * named), started to run that line and end.
 */
import { MATCHERS } from "../panel/problemMatchers.ts";
import { structuredSetting, type SettingsRegistry } from "../settings/settings.ts";
import type { WorkspaceId } from "../terminalProtocol.ts";

export type TaskGroup = "build" | "test";

export interface TaskPresentation {
  /** `always`: shown when it starts; `silent`: shown only if it fails; `never`. */
  reveal: "always" | "silent" | "never";
  /** `dedicated`: one terminal for this task, reused run after run; `new`: one per run. */
  terminal: "dedicated" | "new";
  /** A reused terminal is cleared before the next run. */
  clear: boolean;
}

/** A task as configured: no runtime state. */
export interface TaskDefinition {
  /** Stable identity, unique within its scope: what `dependsOn` and commands name. */
  id: string;
  label: string;
  /** One line, in the shell's own syntax. */
  command: string;
  /** Further arguments, quoted for the shell. */
  args: string[];
  /** Relative to the workspace root (or absolute, inside the workspace); the root if absent. */
  cwd: string | null;
  /** Added to, or overriding, the environment (names in the order written). */
  env: Record<string, string>;
  /** A terminal profile id; the default profile when absent. */
  profile: string | null;
  /** Task ids run first, in this order; any failing stops the rest. */
  dependsOn: string[];
  group: TaskGroup | null;
  /** The default task of its group (Run Build Task / Run Test Task). */
  isDefault: boolean;
  /** Ids of the problem matchers that read its output (`problemMatchers.ts`). */
  problemMatcher: string[];
  presentation: TaskPresentation;
}

/** A task with where it comes from: a workspace task overrides the user's of the same id. */
export interface ResolvedTask extends TaskDefinition {
  scope: "user" | "workspace";
}

export const DEFAULT_PRESENTATION: TaskPresentation = Object.freeze({
  reveal: "always",
  terminal: "dedicated",
  clear: true,
});

const ID = /^[A-Za-z0-9._-]{1,64}$/;
/** One line: no control characters at all (no line breaks, no NUL). */
const ONE_LINE = /^[^\u0000-\u001f\u007f]*$/;

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** One task from configuration, or why it is not one. Missing optional fields take defaults. */
function readTask(raw: unknown, index: number): TaskDefinition | string {
  const t = record(raw);
  if (!t) return `Task ${index + 1} is not an object.`;
  const id = t.id;
  if (typeof id !== "string" || !ID.test(id))
    return `Task ${index + 1} needs an id of 1-64 letters, digits, ".", "_" or "-".`;
  const where = `Task "${id}"`;
  const label = t.label ?? id;
  if (typeof label !== "string" || !label.trim() || label.length > 100 || !ONE_LINE.test(label))
    return `${where}: its label must be one line of 1-100 characters.`;
  if (typeof t.command !== "string" || !t.command.trim() || t.command.length > 4000)
    return `${where}: it needs a command (one line, up to 4000 characters).`;
  if (!ONE_LINE.test(t.command)) return `${where}: its command must be one line.`;
  const strings = (value: unknown, what: string): string[] | string => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
      return `${where}: "${what}" must be a list of strings.`;
    return value as string[];
  };
  const args = strings(t.args, "args");
  if (typeof args === "string") return args;
  if (args.some((arg) => !ONE_LINE.test(arg)))
    return `${where}: an argument contains a line break.`;
  const dependsOn = strings(t.dependsOn, "dependsOn");
  if (typeof dependsOn === "string") return dependsOn;
  if (dependsOn.some((dep) => !ID.test(dep))) return `${where}: "dependsOn" must name task ids.`;
  if (new Set(dependsOn).size !== dependsOn.length)
    return `${where}: "dependsOn" names a task twice.`;
  if (dependsOn.includes(id)) return `${where}: a task cannot depend on itself.`;
  const problemMatcher = strings(t.problemMatcher, "problemMatcher");
  if (typeof problemMatcher === "string") return problemMatcher;
  const unknown = problemMatcher.find((matcher) => !(matcher in MATCHERS));
  if (unknown)
    return `${where}: there is no problem matcher "${unknown}" (there are: ${Object.keys(MATCHERS).join(", ")}).`;
  const cwd = t.cwd ?? null;
  if (cwd !== null && (typeof cwd !== "string" || !cwd.trim() || !ONE_LINE.test(cwd)))
    return `${where}: "cwd" must be a folder path.`;
  const profile = t.profile ?? null;
  if (profile !== null && (typeof profile !== "string" || !ID.test(profile)))
    return `${where}: "profile" must be a terminal profile id.`;
  // An object of names and values (ordered pairs are read too).
  const envRaw = t.env ?? {};
  const pairs: unknown[][] | null = Array.isArray(envRaw)
    ? envRaw.every((pair) => Array.isArray(pair) && pair.length === 2)
      ? (envRaw as unknown[][])
      : null
    : record(envRaw)
      ? Object.entries(envRaw as Record<string, unknown>)
      : null;
  if (!pairs) return `${where}: "env" must be an object of names and values.`;
  const env: Record<string, string> = {};
  for (const [name, value] of pairs as [string, unknown][]) {
    if (
      !name ||
      name.includes("=") ||
      !ONE_LINE.test(name) ||
      typeof value !== "string" ||
      !ONE_LINE.test(value)
    )
      return `${where}: environment variable "${name}" must be a name (no "=") with a one-line value.`;
    env[name] = value;
  }
  const group = t.group ?? null;
  if (group !== null && group !== "build" && group !== "test")
    return `${where}: "group" must be "build" or "test".`;
  const isDefault = t.isDefault ?? false;
  if (typeof isDefault !== "boolean") return `${where}: "isDefault" must be true or false.`;
  if (isDefault && group === null) return `${where}: only a task with a group can be its default.`;
  const p = record(t.presentation ?? {});
  if (!p) return `${where}: "presentation" must be an object.`;
  const reveal = p.reveal ?? DEFAULT_PRESENTATION.reveal;
  if (reveal !== "always" && reveal !== "silent" && reveal !== "never")
    return `${where}: "presentation.reveal" must be "always", "silent" or "never".`;
  const terminal = p.terminal ?? DEFAULT_PRESENTATION.terminal;
  if (terminal !== "dedicated" && terminal !== "new")
    return `${where}: "presentation.terminal" must be "dedicated" or "new".`;
  const clear = p.clear ?? DEFAULT_PRESENTATION.clear;
  if (typeof clear !== "boolean") return `${where}: "presentation.clear" must be true or false.`;
  return {
    id,
    label: label.trim(),
    command: t.command,
    args,
    cwd: cwd as string | null,
    env,
    profile: profile as string | null,
    dependsOn,
    group: group as TaskGroup | null,
    isDefault,
    problemMatcher,
    presentation: { reveal, terminal, clear },
  };
}

/** A whole configured list, or the first reason it is not valid. */
export function readTasks(value: unknown): TaskDefinition[] | string {
  if (!Array.isArray(value)) return "Tasks must be a list.";
  const tasks: TaskDefinition[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const task = readTask(raw, index);
    if (typeof task === "string") return task;
    if (ids.has(task.id)) return `Two tasks have the id "${task.id}".`;
    ids.add(task.id);
    tasks.push(task);
  }
  return tasks;
}

/** The setting holding a scope's tasks: the user's apply everywhere, a workspace's only there. */
export const TASK_DEFINITIONS = structuredSetting<TaskDefinition[]>({
  id: "tasks.definitions",
  title: "Tasks",
  description:
    "Commands run in a terminal from Run › Run Task. A workspace task replaces your task of the same id.",
  section: "Tasks",
  default: [],
  parse: (value) => {
    const tasks = readTasks(value);
    return typeof tasks === "string" ? undefined : tasks;
  },
  explain: (value) => {
    const tasks = readTasks(value);
    return typeof tasks === "string" ? tasks : undefined;
  },
  example: JSON.stringify(
    [
      {
        id: "build",
        label: "Build",
        command: "npm run build",
        group: "build",
        isDefault: true,
        problemMatcher: ["tsc"],
      },
    ],
    null,
    2,
  ),
});

/**
 * The tasks a workspace has: the user's and the workspace's, a workspace task replacing the
 * user's of the same id (workspace, then user, then none -- the registry's order, per task).
 */
export function configuredTasks(
  registry: SettingsRegistry,
  workspace: WorkspaceId | null,
): ResolvedTask[] {
  const state = registry.inspect(TASK_DEFINITIONS, workspace);
  const byId = new Map<string, ResolvedTask>();
  for (const task of state.user ?? []) byId.set(task.id, { ...task, scope: "user" });
  for (const task of state.workspace ?? []) byId.set(task.id, { ...task, scope: "workspace" });
  return [...byId.values()];
}
