/**
 * Output channels: append-only logs the app writes about its own work, shown one channel at
 * a time in the panel's Output view. The counterpart of VS Code's
 * `window.createOutputChannel`.
 *
 * A channel is owned by whichever subsystem writes it -- Git, the file watcher, a task runner
 * -- and nothing reads another's. That is the point of keying by channel rather than having
 * one log: clearing or filtering one leaves the rest alone.
 */

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

/** Ordered by severity, so a chosen level can include everything at or above it. */
export const LOG_LEVELS: readonly LogLevel[] = ["trace", "debug", "info", "warn", "error"];

export function atLeast(level: LogLevel, minimum: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(minimum);
}

export interface OutputLine {
  /** Monotonic within a channel, so React keys stay stable as old lines are dropped. */
  id: number;
  text: string;
  level: LogLevel;
  at: number;
}

/** Lines kept per channel. Beyond this the oldest are dropped, like a terminal's scrollback. */
const CAPACITY = 5000;

export interface OutputChannel {
  readonly id: string;
  readonly name: string;
  append(text: string, level?: LogLevel): void;
  /** Appends `text` followed by a line break; multi-line text becomes multiple lines. */
  appendLine(text: string, level?: LogLevel): void;
  clear(): void;
  lines(): readonly OutputLine[];
}

interface ChannelState {
  id: string;
  name: string;
  lines: OutputLine[];
  nextLineId: number;
  /** Rebuilt only when read after a change, so writes stay O(1) -- a build can be noisy. */
  cache: readonly OutputLine[];
  cacheStale: boolean;
}

const channels = new Map<string, ChannelState>();
const listeners = new Set<() => void>();
let registryVersion = 0;

function changed(state?: ChannelState): void {
  if (state) state.cacheStale = true;
  registryVersion += 1;
  for (const listener of listeners) listener();
}

/** Notified when any channel gains lines, is cleared, or is created. */
export function subscribeOutput(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Changes whenever anything about the channels changes, for `useSyncExternalStore`. */
export function outputVersion(): number {
  return registryVersion;
}

export function outputChannels(): { id: string; name: string }[] {
  return [...channels.values()]
    .map((state) => ({ id: state.id, name: state.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function channelLines(id: string): readonly OutputLine[] {
  const state = channels.get(id);
  if (!state) return [];
  if (state.cacheStale) {
    state.cache = state.lines.slice();
    state.cacheStale = false;
  }
  return state.cache;
}

/**
 * Creates the channel, or returns the one already registered under this name. Idempotent so a
 * subsystem can ask for its channel from wherever it happens to need it first, without
 * ordering rules between modules.
 */
export function createOutputChannel(name: string): OutputChannel {
  const id = name.toLowerCase();
  let state = channels.get(id);
  if (!state) {
    state = { id, name, lines: [], nextLineId: 1, cache: [], cacheStale: false };
    channels.set(id, state);
    changed();
  }
  const owned = state;

  const push = (text: string, level: LogLevel) => {
    owned.lines.push({ id: owned.nextLineId++, text, level, at: Date.now() });
    while (owned.lines.length > CAPACITY) owned.lines.shift();
    changed(owned);
  };

  return {
    id: owned.id,
    name: owned.name,
    append: (text, level = "info") => push(text, level),
    appendLine: (text, level = "info") => {
      // Split so one call carrying several lines is still several lines to filter and scroll.
      for (const line of text.split("\n")) push(line, level);
    },
    clear: () => {
      owned.lines = [];
      changed(owned);
    },
    lines: () => channelLines(owned.id),
  };
}

/** Test seam: forgets every channel. */
export function resetOutputChannels(): void {
  channels.clear();
  changed();
}
