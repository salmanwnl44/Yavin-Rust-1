/** Why debugging did not do what was asked (IDE-05). Each code has a message for the user. */
export type DebugErrorCode =
  | "NoWorkspace"
  | "AdapterUnavailable"
  | "AdapterFailedToStart"
  | "MalformedMessage"
  | "InitializeFailed"
  | "LaunchFailed"
  | "AttachFailed"
  | "UnsupportedCapability"
  | "InvalidConfiguration"
  | "TrustDenied"
  | "SessionTerminated"
  | "EvaluateFailed"
  | "StaleSession"
  | "AlreadyRunning"
  | "NotStopped"
  | "PreLaunchTaskFailed"
  | "RequestFailed"
  | "Cancelled"
  | "Timeout";

export class DebugError extends Error {
  readonly code: DebugErrorCode;
  constructor(code: DebugErrorCode, message: string) {
    super(message);
    this.name = "DebugError";
    this.code = code;
  }
}

const NATIVE_CODES = new Set<DebugErrorCode>([
  "AdapterUnavailable",
  "AdapterFailedToStart",
  "InvalidConfiguration",
  "TrustDenied",
  "SessionTerminated",
]);

/** A native `Code: message` error (`src-tauri/src/dap.rs`) as a typed one. */
export function nativeDebugError(error: unknown, fallback: DebugErrorCode): DebugError {
  if (error instanceof DebugError) return error;
  const text = error instanceof Error ? error.message : String(error);
  const match = /^([A-Za-z]+): ([\s\S]*)$/.exec(text);
  if (match && NATIVE_CODES.has(match[1] as DebugErrorCode))
    return new DebugError(match[1] as DebugErrorCode, match[2]);
  return new DebugError(fallback, text);
}
