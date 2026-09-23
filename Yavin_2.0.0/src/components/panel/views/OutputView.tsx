import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  atLeast,
  channelLines,
  createOutputChannel,
  outputChannels,
  outputVersion,
  subscribeOutput,
  LOG_LEVELS,
} from "../../../services/panel/output";
import type { LogLevel } from "../../../services/panel/output";
import { EmptyView } from "./EmptyView";

const LEVEL_STYLE: Record<LogLevel, string> = {
  trace: "text-zinc-600",
  debug: "text-zinc-500",
  info: "text-zinc-300",
  warn: "text-amber-400",
  error: "text-red-400",
};

/**
 * Append-only logs from the app's own subsystems, one channel at a time -- the counterpart of
 * VS Code's Output view. Read-only by design: a channel is written by whoever owns it.
 */
export function OutputView({ initialChannel }: { initialChannel?: string }) {
  useSyncExternalStore(subscribeOutput, outputVersion, outputVersion);
  const channels = outputChannels();

  const [selected, setSelected] = useState(initialChannel ?? "");
  const [level, setLevel] = useState<LogLevel>("info");
  const [wrap, setWrap] = useState(true);
  /** Off means the view stops following new lines, so a result can be read while it scrolls. */
  const [follow, setFollow] = useState(true);
  const [copied, setCopied] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  // Follow the requested channel, and fall back to the first one as channels appear.
  useEffect(() => {
    if (initialChannel) setSelected(initialChannel);
  }, [initialChannel]);
  const active = channels.some((channel) => channel.id === selected)
    ? selected
    : (channels[0]?.id ?? "");

  const lines = channelLines(active);
  const shown = useMemo(() => lines.filter((line) => atLeast(line.level, level)), [lines, level]);

  useEffect(() => {
    // Scrolls this container only. `scrollIntoView` walks up and can scroll every scrollable
    // ancestor with it, which jerks the whole panel when output is streaming.
    if (!follow || !scroller.current) return;
    scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [shown, follow]);

  if (!channels.length)
    return (
      <EmptyView
        label="Output"
        message="No output channels yet. Channels appear as the app's subsystems do work — running a Git command fills the Git channel."
      />
    );

  const copyAll = () => {
    navigator.clipboard.writeText(shown.map((line) => line.text).join("\n")).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      // Refused outside a secure context; say so rather than appearing to have copied.
      () => setCopied(false),
    );
  };

  return (
    <section aria-label="Output" className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[#141414] px-3 py-1">
        <label className="sr-only" htmlFor="output-channel">
          Output channel
        </label>
        <select
          id="output-channel"
          aria-label="Output channel"
          value={active}
          onChange={(event) => setSelected(event.target.value)}
          className="rounded border border-[#222222] bg-[#0a0a0a] px-2 py-0.5 text-[11px] text-zinc-200"
        >
          {channels.map((channel) => (
            <option key={channel.id} value={channel.id}>
              {channel.name}
            </option>
          ))}
        </select>

        <label className="sr-only" htmlFor="output-level">
          Minimum log level
        </label>
        <select
          id="output-level"
          aria-label="Minimum log level"
          value={level}
          onChange={(event) => setLevel(event.target.value as LogLevel)}
          className="rounded border border-[#222222] bg-[#0a0a0a] px-2 py-0.5 text-[11px] text-zinc-400"
        >
          {LOG_LEVELS.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>

        <span className="text-[11px] text-zinc-600">
          {shown.length} line{shown.length === 1 ? "" : "s"}
        </span>

        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setFollow((on) => !on)}
            aria-pressed={follow}
            title={follow ? "Stop following new output" : "Follow new output"}
            className={`rounded px-2 py-0.5 text-[11px] ${
              follow ? "bg-indigo-950/60 text-indigo-300" : "text-zinc-500 hover:text-zinc-200"
            }`}
          >
            Auto-scroll
          </button>
          <button
            onClick={() => setWrap((on) => !on)}
            aria-pressed={wrap}
            title="Wrap long lines"
            className={`rounded px-2 py-0.5 text-[11px] ${
              wrap ? "bg-indigo-950/60 text-indigo-300" : "text-zinc-500 hover:text-zinc-200"
            }`}
          >
            Wrap
          </button>
          <button
            onClick={copyAll}
            title="Copy the shown output"
            className="rounded px-2 py-0.5 text-[11px] text-zinc-500 hover:text-zinc-200"
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            onClick={() => createOutputChannel(channels.find((c) => c.id === active)!.name).clear()}
            title="Clear this channel"
            className="rounded px-2 py-0.5 text-[11px] text-zinc-500 hover:text-zinc-200"
          >
            Clear
          </button>
        </div>
      </div>

      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-auto px-3 py-1 font-mono text-[11px] leading-relaxed"
      >
        {shown.length === 0 ? (
          <p className="py-2 text-zinc-600">
            {lines.length ? "Nothing at this level." : "This channel has produced no output yet."}
          </p>
        ) : (
          <ul>
            {shown.map((line) => (
              <li
                key={line.id}
                className={`${LEVEL_STYLE[line.level]} ${
                  wrap ? "break-words whitespace-pre-wrap" : "truncate whitespace-pre"
                }`}
              >
                {line.text}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
