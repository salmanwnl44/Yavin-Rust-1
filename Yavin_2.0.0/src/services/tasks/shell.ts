/**
 * How a task's command line is handed to its shell (IDE-04): the shell is started to run that
 * one line and end, with the line as one structured argument -- the terminal passes arguments
 * to the process as they are (`terminal.rs`, portable-pty's Windows argv rules), so nothing is
 * spliced into a command line here except the task's own `args`, each quoted by the shell's own
 * rules. The shapes are proven against the real shells in `terminal_tests.rs`
 * (`a_task_line_reaches_bash_cmd_and_powershell_intact_with_its_exit_code`).
 *
 * | Shell                 | Started as                    | Each extra argument           |
 * | --------------------- | ----------------------------- | ----------------------------- |
 * | bash, zsh, sh         | `-c <line>`                   | `'…'`, a `'` written `'\''`   |
 * | fish                  | `-c <line>`                   | `'…'`, `\` and `'` escaped    |
 * | pwsh, Windows PowerShell | `-NoLogo -Command <line>`  | `'…'`, a `'` written `''`     |
 * | cmd                   | `/d /s /c <line>`             | plain tokens only (see below) |
 *
 * cmd reads its command line raw, not by argument rules, so a line or argument it would read
 * differently from how it was written is refused rather than guessed at: a `"` anywhere, and
 * any argument that is not a plain token. Such a task belongs in PowerShell, Git Bash or a
 * script.
 */
import type { ShellKind } from "../terminal.ts";
import { TaskError } from "./errors.ts";

const posix = (arg: string) => `'${arg.replace(/'/g, "'\\''")}'`;
const fish = (arg: string) => `'${arg.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const powershell = (arg: string) => `'${arg.replace(/'/g, "''")}'`;
/** What cmd reads as one plain word: no spaces, quotes or operators. */
const CMD_TOKEN = /^[A-Za-z0-9_\-.\\/:=@,+]+$/;

export function taskShellArgs(
  kind: ShellKind,
  shellName: string,
  command: string,
  args: readonly string[],
): string[] {
  const line = (quote: (arg: string) => string) => [command, ...args.map(quote)].join(" ");
  switch (kind) {
    case "bash":
    case "zsh":
    case "sh":
      return ["-c", line(posix)];
    case "fish":
      return ["-c", line(fish)];
    case "pwsh":
    case "powershell":
      return ["-NoLogo", "-Command", line(powershell)];
    case "cmd": {
      if (command.includes('"'))
        throw new TaskError(
          "UnsupportedShell",
          `The Command Prompt cannot be given a task line containing a quote ("). Run this task with PowerShell or Git Bash, or put it in a script.`,
        );
      const unsafe = args.find((arg) => !CMD_TOKEN.test(arg));
      if (unsafe !== undefined)
        throw new TaskError(
          "UnsupportedShell",
          `The Command Prompt cannot be given the argument ${JSON.stringify(unsafe)} safely: only plain words (no spaces, quotes or & | < > ^ % !) can be passed to it. Run this task with PowerShell or Git Bash.`,
        );
      return ["/d", "/s", "/c", [command, ...args].join(" ")];
    }
    case "other":
      throw new TaskError(
        "UnsupportedShell",
        `Yavin does not know how to run a command with ${shellName}. Choose a bash, zsh, fish, sh, PowerShell or Command Prompt profile for this task.`,
      );
  }
}
