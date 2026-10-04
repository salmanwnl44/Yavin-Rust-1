/**
 * A debug adapter for tests (IDE-05): speaks DAP over an in-memory channel and debugs a
 * pretend program -- a file whose lines run one after another, with one thread, two frames, a
 * scope and an expandable variable. It answers as debugpy does (`initialized` after `launch`,
 * `launch` answered after `configurationDone`) unless told otherwise, and can be made to fail,
 * crash, hold back an answer, or speak something that is not DAP.
 */
import type { AdapterChannel, AdapterTransport, ConnectionEnd } from "./connection.ts";
import type * as P from "./protocol.ts";

export interface FakeAdapterOptions {
  /** The program's file and how many lines run. */
  file?: string;
  lines?: number;
  capabilities?: P.Capabilities;
  /** `initialized` right after `initialize` (most adapters) instead of after `launch` (debugpy). */
  initializedEarly?: boolean;
  /** Refuse `initialize` / `launch` with this message. */
  failInitialize?: string;
  failLaunch?: string;
  /** `start` fails as the native side would (`Code: message`). */
  failStart?: string;
  /** Past its last breakpoint the program keeps running (until paused or stopped). */
  runsForever?: boolean;
  /** Each message arrives in a task of its own, as over the native pipe (not all at once). */
  separateTasks?: boolean;
  /** Lines the adapter refuses breakpoints on (not verified). */
  unverifiable?: number[];
}

/** One file however its path is spelled (case, separators). */
const key = (path: string) => path.replace(/\\/g, "/").toLowerCase();

export class FakeAdapter implements AdapterTransport {
  readonly sent: P.Request[] = [];
  readonly starts: { adapter: string; root: string; python: string | null }[] = [];
  private messageListener: ((message: string) => void) | null = null;
  private closeListener: ((end: ConnectionEnd) => void) | null = null;
  private seq = 1;
  private line = 0;
  private breakpoints = new Map<string, number[]>();
  private configured = false;
  private launchSeq: number | null = null;
  private stopEpoch = 0;
  private held = new Map<string, (() => void)[]>();
  private holding = new Set<string>();
  closed = false;
  stopped = 0;

  private readonly options: FakeAdapterOptions;

  constructor(options: FakeAdapterOptions = {}) {
    this.options = options;
  }

  get file() {
    return this.options.file ?? "C:\\work\\main.py";
  }

  async start(adapter: string, root: string, python: string | null): Promise<AdapterChannel> {
    this.starts.push({ adapter, root, python });
    if (this.options.failStart) throw new Error(this.options.failStart);
    const channel: AdapterChannel = {
      program: "fake-adapter",
      send: (message) => {
        if (this.closed) throw new Error("SessionTerminated: The debug adapter has stopped.");
        queueMicrotask(() => this.receive(JSON.parse(message) as P.Request | P.Response));
      },
      onMessage: (listener) => {
        this.messageListener = listener;
        return () => (this.messageListener = null);
      },
      onClose: (listener) => {
        this.closeListener = listener;
        return () => (this.closeListener = null);
      },
      stop: async () => {
        this.stopped++;
        this.exit({ reason: "The debug adapter was stopped.", error: false });
      },
    };
    return channel;
  }

  /** Requests of `command`, as sent. */
  requests(command: string) {
    return this.sent.filter((request) => request.command === command);
  }

  /** Answers to `command` are held until `release(command)`. */
  hold(command: string) {
    this.holding.add(command);
  }
  release(command: string) {
    this.holding.delete(command);
    for (const answer of this.held.get(command)?.splice(0) ?? []) answer();
  }

  /** The adapter's process dies. */
  crash(reason = "The debug adapter exited with code 3.") {
    this.exit({ reason, error: true });
  }

  /** The adapter speaks something raw. */
  raw(text: string) {
    this.messageListener?.(text);
  }

  event(event: string, body?: unknown) {
    const message: P.Event = { seq: this.seq++, type: "event", event, body };
    this.post(message);
  }

  private exit(end: ConnectionEnd) {
    if (this.closed) return;
    this.closed = true;
    this.closeListener?.(end);
  }

  private post(message: P.Event | P.Response) {
    if (this.closed) return;
    const text = JSON.stringify(message);
    if (this.options.separateTasks)
      setTimeout(() => {
        if (!this.closed) this.messageListener?.(text);
      }, 0);
    else this.messageListener?.(text);
  }

  private respond(request: P.Request, body?: unknown, failure?: string) {
    const answer = () =>
      this.post({
        seq: this.seq++,
        type: "response",
        request_seq: request.seq,
        command: request.command,
        success: failure === undefined,
        message: failure,
        body: failure === undefined ? body : { error: { id: 1, format: failure } },
      } satisfies P.Response);
    if (this.holding.has(request.command)) {
      const list = this.held.get(request.command) ?? [];
      list.push(answer);
      this.held.set(request.command, list);
    } else answer();
  }

  private frames(): P.StackFrame[] {
    const source = { path: this.file, name: this.file.split(/[\\/]/).pop() };
    return [
      { id: this.stopEpoch * 10 + 1, name: "work", source, line: this.line, column: 1 },
      { id: this.stopEpoch * 10 + 2, name: "<module>", source, line: 1, column: 1 },
      { id: this.stopEpoch * 10 + 3, name: "runner", line: 0, column: 0 },
    ];
  }

  private stopAt(line: number, reason: string) {
    this.line = line;
    this.stopEpoch++;
    this.event("stopped", { reason, threadId: 1, allThreadsStopped: true });
  }

  /** Runs on to the next breakpoint after the current line, or to the end. */
  private run(from: number) {
    const lines = this.options.lines ?? 10;
    const set = this.breakpoints.get(key(this.file)) ?? [];
    const next = set.filter((line) => line > from).sort((a, b) => a - b)[0];
    if (next !== undefined && next <= lines) this.stopAt(next, "breakpoint");
    else if (this.options.runsForever)
      return; // still running where it was
    else {
      this.event("output", { category: "stdout", output: "done\n" });
      this.event("exited", { exitCode: 0 });
      this.event("terminated");
    }
  }

  private receive(message: P.Request | P.Response) {
    if (message.type !== "request") return;
    const request = message;
    this.sent.push(request);
    const args = (request.arguments ?? {}) as Record<string, unknown>;
    switch (request.command) {
      case "initialize":
        if (this.options.failInitialize)
          return this.respond(request, undefined, this.options.failInitialize);
        this.respond(request, {
          supportsConfigurationDoneRequest: true,
          supportsTerminateRequest: true,
          exceptionBreakpointFilters: [{ filter: "uncaught", label: "Uncaught", default: true }],
          ...this.options.capabilities,
        });
        if (this.options.initializedEarly) this.event("initialized");
        return;
      case "launch":
      case "attach":
        if (this.options.failLaunch)
          return this.respond(request, undefined, this.options.failLaunch);
        this.launchSeq = request.seq;
        if (!this.options.initializedEarly) this.event("initialized");
        if (this.configured) this.respond(request);
        return;
      case "setBreakpoints": {
        const source = args.source as P.Source;
        const lines = (args.breakpoints as P.SourceBreakpoint[]).map((bp) => bp.line);
        const refused = new Set(this.options.unverifiable ?? []);
        this.breakpoints.set(
          key(source.path ?? ""),
          lines.filter((line) => !refused.has(line)),
        );
        return this.respond(request, {
          breakpoints: lines.map((line, index) =>
            refused.has(line)
              ? { verified: false, message: "No code on this line." }
              : { id: 100 + index, verified: true, line },
          ),
        });
      }
      case "setExceptionBreakpoints":
        return this.respond(request, {});
      case "configurationDone": {
        this.configured = true;
        this.respond(request);
        if (this.launchSeq !== null)
          this.respond({ ...request, seq: this.launchSeq, command: "launch" });
        const stopOnEntry = (
          this.sent.find((r) => r.command === "launch")?.arguments as {
            stopOnEntry?: boolean;
          }
        )?.stopOnEntry;
        if (stopOnEntry) this.stopAt(1, "entry");
        else this.run(0);
        return;
      }
      case "threads":
        return this.respond(request, { threads: [{ id: 1, name: "MainThread" }] });
      case "stackTrace":
        return this.respond(request, { stackFrames: this.frames(), totalFrames: 3 });
      case "scopes":
        return this.respond(request, {
          scopes: [{ name: "Locals", variablesReference: 1000 + this.stopEpoch, expensive: false }],
        });
      case "variables": {
        const reference = args.variablesReference as number;
        if (reference >= 2000)
          return this.respond(request, {
            variables: [
              { name: "0", value: "1", variablesReference: 0 },
              { name: "1", value: "2", variablesReference: 0 },
            ],
          });
        return this.respond(request, {
          variables: [
            { name: "line", value: String(this.line), type: "int", variablesReference: 0 },
            {
              name: "items",
              value: "[1, 2]",
              type: "list",
              variablesReference: 2000 + this.stopEpoch,
            },
          ],
        });
      }
      case "continue":
        this.respond(request, { allThreadsContinued: true });
        return this.run(this.line);
      case "next":
      case "stepIn":
        this.respond(request);
        if (this.line + 1 > (this.options.lines ?? 10)) return this.run(this.line);
        return this.stopAt(this.line + 1, "step");
      case "stepOut":
        this.respond(request);
        return this.stopAt(this.line + 2, "step");
      case "pause":
        this.respond(request);
        return this.stopAt(this.line || 1, "pause");
      case "restart":
        this.respond(request);
        this.line = 0;
        return this.run(0);
      case "evaluate": {
        const expression = String(args.expression);
        if (expression === "boom")
          return this.respond(request, undefined, "NameError: name 'boom' is not defined");
        return this.respond(request, {
          result: `${expression} = ${this.line}`,
          variablesReference: 0,
        });
      }
      case "terminate":
        this.respond(request);
        this.event("terminated");
        return;
      case "disconnect":
        this.respond(request);
        queueMicrotask(() =>
          this.exit({ reason: "The debug adapter exited with code 0.", error: false }),
        );
        return;
      case "cancel":
        return this.respond(request);
      default:
        return this.respond(request, undefined, `Unknown request ${request.command}`);
    }
  }
}
