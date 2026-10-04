/**
 * The Debug Adapter Protocol, as much of it as Yavin uses (IDE-05). Names and shapes are the
 * specification's (https://microsoft.github.io/debug-adapter-protocol/specification); nothing
 * here is invented. DAP is not JSON-RPC: every message has a `seq`, a `type` of `request`,
 * `response` or `event`, and a response names the request it answers by `request_seq`.
 */

export interface ProtocolMessage {
  seq: number;
  type: "request" | "response" | "event";
}

export interface Request extends ProtocolMessage {
  type: "request";
  command: string;
  arguments?: unknown;
}

export interface Response extends ProtocolMessage {
  type: "response";
  request_seq: number;
  success: boolean;
  command: string;
  /** On failure: a short, machine-readable reason ("cancelled", "notStopped") or a sentence. */
  message?: string;
  body?: unknown;
}

export interface Event extends ProtocolMessage {
  type: "event";
  event: string;
  body?: unknown;
}

/** An error response's detail (`ErrorResponse.body.error`). */
export interface Message {
  id: number;
  format: string;
  variables?: Record<string, string>;
  showUser?: boolean;
}

export interface Capabilities {
  supportsConfigurationDoneRequest?: boolean;
  supportsFunctionBreakpoints?: boolean;
  supportsConditionalBreakpoints?: boolean;
  supportsEvaluateForHovers?: boolean;
  supportsStepBack?: boolean;
  supportsSetVariable?: boolean;
  supportsRestartFrame?: boolean;
  supportsRestartRequest?: boolean;
  supportsTerminateRequest?: boolean;
  supportsCancelRequest?: boolean;
  supportsSingleThreadExecutionRequests?: boolean;
  supportTerminateDebuggee?: boolean;
  supportsSuspendDebuggee?: boolean;
  exceptionBreakpointFilters?: { filter: string; label: string; default?: boolean }[];
}

export interface InitializeRequestArguments {
  clientID?: string;
  clientName?: string;
  adapterID: string;
  locale?: string;
  linesStartAt1?: boolean;
  columnsStartAt1?: boolean;
  pathFormat?: "path" | "uri";
  supportsVariableType?: boolean;
  supportsVariablePaging?: boolean;
  supportsRunInTerminalRequest?: boolean;
  supportsProgressReporting?: boolean;
  supportsStartDebuggingRequest?: boolean;
}

export interface Source {
  name?: string;
  path?: string;
  sourceReference?: number;
  presentationHint?: "normal" | "emphasize" | "deemphasize";
}

export interface SourceBreakpoint {
  line: number;
  column?: number;
}

export interface Breakpoint {
  id?: number;
  verified: boolean;
  message?: string;
  source?: Source;
  line?: number;
  column?: number;
  /** Why it is not verified, when it is not (DAP 1.62+). */
  reason?: "pending" | "failed";
}

export interface Thread {
  id: number;
  name: string;
}

export interface StackFrame {
  id: number;
  name: string;
  source?: Source;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  moduleId?: number | string;
  presentationHint?: "normal" | "label" | "subtle";
}

export interface Scope {
  name: string;
  presentationHint?: string;
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
  expensive: boolean;
}

export interface Variable {
  name: string;
  value: string;
  type?: string;
  evaluateName?: string;
  /** Non-zero: the variable has children, fetched with `variables` by this reference. */
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
}

export interface StoppedEventBody {
  reason: string;
  description?: string;
  threadId?: number;
  allThreadsStopped?: boolean;
  text?: string;
  hitBreakpointIds?: number[];
}

export interface ContinuedEventBody {
  threadId: number;
  allThreadsContinued?: boolean;
}

export interface OutputEventBody {
  category?: "console" | "important" | "stdout" | "stderr" | "telemetry" | string;
  output: string;
}

export interface ThreadEventBody {
  reason: "started" | "exited" | string;
  threadId: number;
}

export interface BreakpointEventBody {
  reason: "changed" | "new" | "removed" | string;
  breakpoint: Breakpoint;
}

export interface ExitedEventBody {
  exitCode: number;
}

export interface TerminatedEventBody {
  restart?: unknown;
}

export interface EvaluateResponseBody {
  result: string;
  type?: string;
  variablesReference: number;
}
