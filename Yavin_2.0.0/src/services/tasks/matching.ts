/**
 * A task's problem matching (IDE-04): its terminal output, as it arrives, read line by line by
 * the problem matchers it names -- the same matchers the checkers use (`problemMatchers.ts`) --
 * and its findings resolved to the workspace's files (`problemLocations.ts`). It holds what one
 * execution found, nothing else; what is published, and when, is `TaskService`'s, into the one
 * Problems store.
 */
import { MATCHERS, parseProblems, type Diagnostic } from "../panel/problemMatchers.ts";
import { resolveTaskDiagnostics } from "../panel/problemLocations.ts";

/** Terminal escape sequences (colours, cursor moves, titles): a matcher reads text. */
const ESCAPES = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
/** A line longer than this is not a diagnostic; it is cut, not kept growing. */
const MAX_LINE = 8192;

export class TaskOutputMatcher {
  private readonly decoder = new TextDecoder("utf-8");
  private partial = "";
  private readonly found: Diagnostic[] = [];
  private readonly matchers;

  constructor(matcherIds: readonly string[]) {
    this.matchers = matcherIds.flatMap((id) => (MATCHERS[id] ? [MATCHERS[id]] : []));
  }

  get active(): boolean {
    return this.matchers.length > 0;
  }

  /** Output bytes, in order, split anywhere. */
  push(bytes: Uint8Array): void {
    if (!this.active) return;
    const text = this.partial + this.decoder.decode(bytes, { stream: true });
    const lines = text.split(/\r?\n|\r(?!$)/);
    this.partial = (lines.pop() ?? "").slice(-MAX_LINE);
    for (const line of lines) this.read(line);
  }

  /** The output ended: the last line, if it had no newline, is read too. */
  finish(): Diagnostic[] {
    if (this.active) {
      const rest = this.partial + this.decoder.decode();
      this.partial = "";
      if (rest) this.read(rest);
    }
    return [...this.found];
  }

  private read(line: string): void {
    const clean = line.slice(0, MAX_LINE).replace(ESCAPES, "");
    for (const matcher of this.matchers) this.found.push(...parseProblems(matcher, clean));
  }
}

export { resolveTaskDiagnostics };
