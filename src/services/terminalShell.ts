/**
 * Shell integration (TERMINAL-05A): what a running shell says about itself, read once, by the
 * workspace's `TerminalService`.
 *
 * The native side finds the OSC 7 and OSC 133 sequences in a session's output (one scanner,
 * where the output enters the stream) and sends each as a `shell` message, in order with the
 * output. This module is what those messages mean: a pure reducer over a session's
 * `TerminalShellState`. Views never parse them; they read the service's state.
 *
 * - **Untrusted metadata.** A signal only ever changes this state. It never runs a command,
 *   opens or writes a file, changes a profile or the workspace, or calls Git or another app.
 * - **OSC 7, the shell's folder.** A `file://` URL. A URL whose host is not this machine is
 *   `remote` and never becomes a local path. A local one is read with the workspace's resource
 *   rules (`resource.ts`); Git Bash's MSYS paths (`/c/Users`) are mapped to their drive, and
 *   MSYS paths with no drive (`/tmp`) are `unmapped`. A URL that cannot be read changes nothing.
 * - **OSC 133, command boundaries.** `A` prompt, `B` input, `C` executing, `D[;status]`
 *   finished. The command state machine (`idle -> prompt -> input -> executing -> completed`)
 *   tolerates repeated, missing and out-of-order markers: a `D` with no command running is
 *   ignored, a new prompt ends a running command without a status, a repeated `C` is one
 *   command. No command text is ever read back from the screen.
 * - **Separate from the session's state.** A command's exit status is not the shell's; a
 *   session can be `Running` with its last command `completed` with status 1.
 */
import { fsPath, parseUri } from "./resource.ts";
import type { ShellKind } from "./terminal.ts";
import type { TerminalShellEvent } from "./terminalProtocol.ts";

/**
 * - `disabled`: integration is off for this terminal (a setting: TERMINAL-07); signals ignored.
 * - `available`: the shell can report (bash, zsh, fish, PowerShell) but has not yet.
 * - `active`: it has sent a valid signal this generation.
 * - `unsupported`: a shell with no integration (cmd, sh); it still works as a plain terminal.
 * - `error`: it sent only sequences that could not be read.
 */
export type ShellIntegration = "disabled" | "available" | "active" | "unsupported" | "error";

export type CommandState = "idle" | "prompt" | "input" | "executing" | "completed";

/** How a shell writes its paths: MSYS (Git Bash) writes `/c/...` for `C:\...`. */
export type PathStyle = "posix" | "windows" | "msys";

/** What a terminal's shell is expected to do, decided from its profile when it starts. */
export interface ShellIntegrationHint {
  integration: "available" | "unsupported" | "disabled";
  pathStyle: PathStyle;
}

/** The shell's folder, as its last readable OSC 7 said. */
export type ReportedCwd =
  | { kind: "local"; uri: string; path: string }
  | { kind: "remote"; uri: string; host: string }
  | { kind: "unmapped"; uri: string };

/** One command, between its `C` and its `D` (or the next prompt). Never its text. */
export interface ShellCommand {
  /** Counts up within the session, across generations. */
  readonly id: number;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  /** `null` while it runs, or when the shell gave no (valid) status. */
  readonly exitCode: number | null;
}

export interface TerminalShellState {
  readonly integration: ShellIntegration;
  readonly pathStyle: PathStyle;
  /** The last readable OSC 7; `null` until there is one. */
  readonly reported: ReportedCwd | null;
  readonly commandState: CommandState;
  /** The command running now (`executing`). */
  readonly current: ShellCommand | null;
  /** The last command that finished. */
  readonly last: ShellCommand | null;
  /** The next command's id. */
  readonly nextCommand: number;
  /** Sequences that could not be read, this generation. */
  readonly invalid: number;
}

const INTEGRATED: readonly ShellKind[] = ["bash", "zsh", "fish", "pwsh", "powershell"];

/** The hint for a profile's shell: its kind, and the executable (Git Bash runs MSYS paths). */
export function shellIntegrationHint(
  kind: ShellKind | null,
  executable: string | null,
): ShellIntegrationHint {
  const windows = !!executable && /^([A-Za-z]:[\\/]|\\\\|\/\/)/.test(executable);
  return {
    integration: kind && INTEGRATED.includes(kind) ? "available" : "unsupported",
    pathStyle: !windows
      ? "posix"
      : kind === "bash" || kind === "zsh" || kind === "sh"
        ? "msys"
        : "windows",
  };
}

export function initialShellState(
  hint: ShellIntegrationHint = { integration: "unsupported", pathStyle: "posix" },
  nextCommand = 1,
): TerminalShellState {
  return Object.freeze({
    integration: hint.integration,
    pathStyle: hint.pathStyle,
    reported: null,
    commandState: "idle",
    current: null,
    last: null,
    nextCommand,
    invalid: 0,
  });
}

/**
 * An MSYS (Git Bash) path's Windows spelling: `/c/x` and `/cygdrive/c/x` are `C:/x`. `null`
 * for any other MSYS path (`/tmp`, `/usr/bin`): it has no Windows path Yavin can name.
 */
export function msysDrivePath(path: string): string | null {
  const drive = /^\/(?:cygdrive\/)?([A-Za-z])(\/.*)?$/.exec(path);
  return drive ? `${drive[1].toUpperCase()}:${drive[2] ?? "/"}` : null;
}

/**
 * What an OSC 7 URL means here; `null` when it cannot be read (the folder stays as it was).
 * `local` is the native side's verdict on the URL's host.
 */
export function cwdFromOsc7(uri: string, local: boolean, pathStyle: PathStyle): ReportedCwd | null {
  const match = /^file:\/\/([^/]*)(\/.*)?$/i.exec(uri);
  if (!match) return null;
  const [, host, raw = "/"] = match;
  if (!local) return host ? { kind: "remote", uri, host } : null;
  let path = raw;
  if (pathStyle === "msys") {
    const drive = msysDrivePath(raw);
    if (!drive) return { kind: "unmapped", uri };
    path = `/${drive}`;
  }
  let resolved: string;
  try {
    // The URL's host was this machine: read it as a host-less `file:` URL.
    resolved = fsPath(parseUri(`file://${path}`));
  } catch {
    return null;
  }
  // On Windows a path is a drive's or a share's; a bare `/x` names nothing there.
  if (pathStyle !== "posix" && !/^([A-Za-z]:\/|\/\/)/.test(resolved))
    return { kind: "unmapped", uri };
  return { kind: "local", uri, path: resolved };
}

const finish = (command: ShellCommand, exitCode: number | null, now: number): ShellCommand =>
  Object.freeze({ ...command, finishedAt: now, exitCode });

/**
 * The state after one signal of the current generation. Answers `state` itself when nothing
 * changed, so a listener can skip it.
 */
export function reduceShell(
  state: TerminalShellState,
  event: Pick<TerminalShellEvent, "signal" | "uri" | "local" | "exitCode">,
  now: number = Date.now(),
): TerminalShellState {
  if (state.integration === "disabled") return state;
  const next = (patch: Partial<TerminalShellState>): TerminalShellState =>
    Object.freeze({ ...state, ...patch });
  if (event.signal === "invalid") {
    return next({
      invalid: state.invalid + 1,
      integration: state.integration === "active" ? "active" : "error",
    });
  }
  const active: Partial<TerminalShellState> =
    state.integration === "active" ? {} : { integration: "active" };
  // A command still running when the next prompt (or input) begins ended without its `D`.
  const ended: Partial<TerminalShellState> = state.current
    ? { current: null, last: finish(state.current, null, now) }
    : {};
  switch (event.signal) {
    case "cwd": {
      const reported =
        event.uri === undefined || event.local === undefined
          ? null
          : cwdFromOsc7(event.uri, event.local, state.pathStyle);
      if (!reported)
        return next({
          invalid: state.invalid + 1,
          integration: state.integration === "active" ? "active" : "error",
        });
      return next({ ...active, reported });
    }
    case "prompt":
      return next({ ...active, ...ended, commandState: "prompt" });
    case "input":
      return next({ ...active, ...ended, commandState: "input" });
    case "executing":
      // A repeated `C` is the same command.
      if (state.current) return Object.keys(active).length ? next(active) : state;
      return next({
        ...active,
        commandState: "executing",
        current: Object.freeze({
          id: state.nextCommand,
          startedAt: now,
          finishedAt: null,
          exitCode: null,
        }),
        nextCommand: state.nextCommand + 1,
      });
    case "finished":
      // A `D` with no command running (a shell's first prompt, a repeat) ends nothing.
      if (!state.current) return Object.keys(active).length ? next(active) : state;
      return next({
        ...active,
        commandState: "completed",
        current: null,
        last: finish(state.current, event.exitCode ?? null, now),
      });
  }
  return state;
}

/**
 * The folder a terminal is in, as far as Yavin knows: the shell's own report when it gave a
 * local one, else where it was started. `null` when the shell reported a folder that is not
 * a local path (a remote host, an MSYS-only path): it is not where it started any more.
 */
export function terminalFolder(view: {
  cwd: string | null;
  shell: TerminalShellState;
}): string | null {
  const reported = view.shell.reported;
  if (!reported) return view.cwd;
  return reported.kind === "local" ? reported.path : null;
}

/** A short status for the status line; `""` when there is nothing worth saying. */
export function describeShell(shell: TerminalShellState): string {
  if (shell.integration === "error") return "Shell integration: unreadable sequences";
  if (shell.integration !== "active") return "";
  if (shell.commandState === "executing") return "Running a command";
  if (!shell.last) return "";
  return shell.last.exitCode === null
    ? "Last command finished"
    : `Last command exited with ${shell.last.exitCode}`;
}

/** The shell's reported folder, fit to show; `""` before it reported one. */
export function describeReportedCwd(shell: TerminalShellState): string {
  const reported = shell.reported;
  if (!reported) return "";
  if (reported.kind === "local") return reported.path;
  if (reported.kind === "remote") return `${reported.host} (remote)`;
  return "(a folder with no Windows path)";
}
