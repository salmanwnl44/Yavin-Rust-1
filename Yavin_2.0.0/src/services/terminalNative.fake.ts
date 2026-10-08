/**
 * A stand-in for the native terminal runtime, for tests: per generation, the service's
 * lifecycle channel and each view's output channel, a view attaching later replayed what the
 * generation produced, opens that can be held, closes and kills that end and release.
 */
import type { TerminalNative } from "./terminalService.ts";

type Receive = (message: unknown) => void;

/**
 * The native side as the contract describes it: per generation, a lifecycle channel (the
 * service) and output channels (views), each new view replayed what the generation produced.
 */
export class FakeNative implements TerminalNative {
  calls: { command: string; args: unknown }[] = [];
  failOpen: string | null = null;
  /** When set, opens wait until `release()`. */
  hold = false;
  private held: (() => void)[] = [];
  /**
   * When set, what views (output channels) are sent waits until `flushViews()`, while the
   * lifecycle channel is sent at once -- as natively, where the lifecycle subscriber is never
   * held back by output and each channel is its own transport (`terminal_stream.rs`). Off by
   * default: views are sent in step with the lifecycle.
   */
  lagViews = false;
  private lagged: { receive: Receive; message: unknown }[] = [];
  sessions = new Map<
    string,
    {
      lifecycle: Receive;
      views: Map<string, Receive>;
      replay: unknown[];
      seq: number;
      ended: boolean;
      released: boolean;
    }
  >();

  channel(receive: Receive) {
    return { receive };
  }
  release() {
    for (const go of this.held.splice(0)) go();
  }
  /** Sends the views what `lagViews` held back, in order. */
  flushViews() {
    for (const { receive, message } of this.lagged.splice(0)) receive(message);
  }
  private toView(receive: Receive, message: unknown) {
    if (this.lagViews) this.lagged.push({ receive, message });
    else receive(message);
  }
  private key(sessionId: string, generation: number) {
    return `${sessionId}:${generation}`;
  }
  async open(args: { request: { sessionId: string; generation: number }; events: unknown }) {
    this.calls.push({ command: "open", args: args.request });
    if (this.hold) await new Promise<void>((resolve) => this.held.push(resolve));
    if (this.failOpen) throw this.failOpen;
    const { sessionId, generation } = args.request;
    const lifecycle = (args.events as { receive: Receive }).receive;
    this.sessions.set(this.key(sessionId, generation), {
      lifecycle,
      views: new Map(),
      replay: [],
      seq: 0,
      ended: false,
      released: false,
    });
    this.lifecycle(sessionId, generation, { kind: "state", state: "Running", pid: 42 });
    return { sessionId, generation, state: "Running", pid: 42 };
  }
  async subscribe(args: {
    request: { subscriptionId: string; sessionId: string; generation: number };
    events: unknown;
  }) {
    this.calls.push({ command: "subscribe", args: args.request });
    const session = this.sessions.get(this.key(args.request.sessionId, args.request.generation));
    if (!session || session.released) throw "InvalidSession: That terminal is no longer running.";
    const receive = (args.events as { receive: Receive }).receive;
    for (const message of session.replay) this.toView(receive, message);
    if (!session.ended) session.views.set(args.request.subscriptionId, receive);
  }
  async unsubscribe(request: unknown) {
    this.calls.push({ command: "unsubscribe", args: request });
    const { subscriptionId } = request as { subscriptionId: string };
    for (const session of this.sessions.values()) session.views.delete(subscriptionId);
  }
  async ack(request: unknown) {
    this.calls.push({ command: "ack", args: request });
  }
  async write(request: unknown) {
    this.calls.push({ command: "write", args: request });
  }
  async resize(request: unknown) {
    this.calls.push({ command: "resize", args: request });
  }
  async close(request: { sessionId: string; generation: number }) {
    this.calls.push({ command: "close", args: request });
    this.end(request.sessionId, request.generation, 0, true);
  }
  async kill(request: { sessionId: string; generation: number }) {
    this.calls.push({ command: "kill", args: request });
    this.end(request.sessionId, request.generation, 1, true);
  }
  async closeAll() {
    this.calls.push({ command: "closeAll", args: null });
  }

  /** What the shell does. */
  lifecycle(sessionId: string, generation: number, fields: Record<string, unknown>) {
    const session = this.sessions.get(this.key(sessionId, generation));
    const message = { sessionId, generation, ...fields };
    session?.replay.push(message);
    session?.lifecycle(message);
    for (const view of session?.views.values() ?? []) this.toView(view, message);
  }
  /** A shell-integration signal (TERMINAL-05A): delivered live, never replayed, as natively. */
  shell(sessionId: string, generation: number, fields: Record<string, unknown>) {
    const session = this.sessions.get(this.key(sessionId, generation));
    const message = { kind: "shell", sessionId, generation, ...fields };
    session?.lifecycle(message);
    for (const view of session?.views.values() ?? []) view(message);
  }
  output(sessionId: string, generation: number, text: string) {
    const session = this.sessions.get(this.key(sessionId, generation))!;
    const message = {
      kind: "output",
      sessionId,
      generation,
      seq: session.seq++,
      bytes: Buffer.from(text, "utf8").toString("base64"),
    };
    session.replay.push(message);
    for (const view of session.views.values()) this.toView(view, message);
    return message;
  }
  end(sessionId: string, generation: number, exitCode: number, release = false) {
    const session = this.sessions.get(this.key(sessionId, generation));
    if (!session) return;
    if (!session.ended) {
      this.lifecycle(sessionId, generation, { kind: "state", state: "Exiting" });
      this.lifecycle(sessionId, generation, {
        kind: "exit",
        exitCode,
        lastSeq: session.seq ? session.seq - 1 : null,
      });
      session.ended = true;
      session.views.clear();
    }
    if (release) session.released = true;
  }
  count(command: string) {
    return this.calls.filter((call) => call.command === command).length;
  }
}
