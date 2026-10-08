/**
 * A task's problem matching (IDE-04): its terminal output, as it arrives, turned into the lines
 * the terminal shows (`terminalText.ts` -- a terminal places lines with cursor moves and redraws
 * progress over itself, it does not only print line breaks) and read by the problem matchers it
 * names -- the same matchers the checkers use (`problemMatchers.ts`), multi-line formats
 * included -- and its findings resolved to the workspace's files (`problemLocations.ts`). It
 * holds what one execution found, nothing else; what is published, and when, is `TaskService`'s,
 * into the one Problems store.
 */
import { MATCHERS, MatcherSession, type Diagnostic } from "../panel/problemMatchers.ts";
import { resolveTaskDiagnostics } from "../panel/problemLocations.ts";
import { TerminalText } from "./terminalText.ts";

export class TaskOutputMatcher {
  private readonly decoder = new TextDecoder("utf-8");
  private readonly text = new TerminalText();
  private readonly found: Diagnostic[] = [];
  private readonly sessions: MatcherSession[];

  constructor(matcherIds: readonly string[]) {
    this.sessions = matcherIds.flatMap((id) =>
      MATCHERS[id] ? [new MatcherSession(MATCHERS[id])] : [],
    );
  }

  get active(): boolean {
    return this.sessions.length > 0;
  }

  /** Output bytes, in order, split anywhere. */
  push(bytes: Uint8Array): void {
    if (!this.active) return;
    this.read(this.text.push(this.decoder.decode(bytes, { stream: true })));
  }

  /** The output ended: the last line, if it had no line break, is read too. */
  finish(): Diagnostic[] {
    if (this.active) {
      const rest = this.decoder.decode();
      this.read([...this.text.push(rest), ...this.text.end()]);
    }
    return [...this.found];
  }

  private read(lines: readonly string[]): void {
    for (const line of lines)
      for (const session of this.sessions) this.found.push(...session.line(line));
  }
}

export { resolveTaskDiagnostics };
