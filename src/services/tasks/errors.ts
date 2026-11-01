/** Why a task could not run (IDE-04): typed, with a sentence fit to show. */
export type TaskErrorCode =
  | "NoWorkspace"
  | "UnknownTask"
  | "NoDefaultTask"
  | "AmbiguousDefault"
  | "InvalidConfiguration"
  | "InvalidDependency"
  | "DependencyCycle"
  | "DependencyFailed"
  | "AlreadyRunning"
  | "TrustDenied"
  | "ShellUnavailable"
  | "UnsupportedShell"
  | "InvalidCwd"
  | "TerminalFailed"
  | "Cancelled";

export class TaskError extends Error {
  readonly code: TaskErrorCode;
  constructor(code: TaskErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "TaskError";
  }
}
