import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { DebugService } from "../../../services/debug/service";
import { EmptyView } from "./EmptyView";

const KIND_STYLE = {
  input: "text-sky-300",
  result: "text-zinc-100",
  error: "text-red-400",
  stdout: "text-zinc-300",
  stderr: "text-amber-300",
  console: "text-zinc-500",
} as const;

/**
 * The Debug Console (IDE-05): the debug session's output -- the program's stdout and stderr and
 * the adapter's messages, as DAP `output` events -- and expressions evaluated in the paused
 * program's selected frame (DAP `evaluate`). It is not a terminal: nothing is typed to a shell.
 */
export function DebugConsoleView({ service }: { service?: DebugService }) {
  if (!service)
    return (
      <EmptyView
        label="Debug Console"
        message="Open a folder and start debugging (Run › Start Debugging) to see a session's output here."
      />
    );
  return <Console service={service} />;
}

function Console({ service }: { service: DebugService }) {
  const snapshot = useSyncExternalStore(
    service.subscribe,
    service.getSnapshot,
    service.getSnapshot,
  );
  const canEvaluate = service.controls().evaluate;
  const [input, setInput] = useState("");
  const end = useRef<HTMLDivElement>(null);
  // A block, not an expression: scrollIntoView returns a promise in newer engines, and an
  // effect may return only a cleanup function.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [snapshot.console.length]);

  const submit = () => {
    const expression = input.trim();
    if (!expression || !canEvaluate) return;
    setInput("");
    // A failure is already in the console, as the adapter put it.
    void service.evaluate(expression).catch(() => {});
  };

  return (
    <section
      aria-label="Debug Console"
      className="flex h-full min-h-0 flex-col bg-black font-mono text-[12px]"
    >
      <div
        role="log"
        aria-label="Debug Console output"
        className="min-h-0 flex-1 overflow-y-auto px-3 py-1"
      >
        {!snapshot.session && (
          <p className="text-zinc-600">No debug session. Run › Start Debugging starts one.</p>
        )}
        {snapshot.console.map((entry) => (
          <div
            key={entry.id}
            data-kind={entry.kind}
            className={`whitespace-pre-wrap ${KIND_STYLE[entry.kind]}`}
          >
            {entry.kind === "input" ? `> ${entry.text}` : entry.text}
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="flex items-center gap-2 border-t border-[#161616] px-3 py-1">
        <span className="text-zinc-600">&gt;</span>
        <input
          aria-label="Evaluate expression"
          value={input}
          disabled={!canEvaluate}
          placeholder={
            canEvaluate
              ? "Evaluate in the selected frame"
              : "Expressions are evaluated while the program is paused"
          }
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
          className="min-w-0 flex-1 bg-transparent text-zinc-200 outline-none placeholder:text-zinc-600 disabled:cursor-not-allowed"
        />
        <button
          onClick={() => service.clearConsole()}
          className="text-[11px] text-zinc-600 hover:text-zinc-300"
        >
          Clear
        </button>
      </div>
    </section>
  );
}
