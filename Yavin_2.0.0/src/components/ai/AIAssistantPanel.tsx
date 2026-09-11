import React, { useState } from "react";

export function AIAssistantPanel({ onClose }: { onClose: () => void }) {
  const [messages, setMessages] = useState<
    { role: string; text: string; tasks?: { label: string; status: string }[]; thinking?: string }[]
  >([
    {
      role: "assistant",
      text: "AI assistance is not connected. No prompts are sent and no workspace tasks are performed.",
    },
  ]);
  const [inputPrompt, setInputPrompt] = useState("");

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputPrompt.trim()) return;

    const userText = inputPrompt;
    setInputPrompt("");

    setMessages((prev) => [
      ...prev,
      { role: "user", text: userText },
      {
        role: "assistant",
        text: "No AI provider is configured. This message has not been processed.",
      },
    ]);
  };

  return (
    <aside className="flex w-[320px] flex-col border-l border-[#181818] bg-[#050505] select-none text-[12px] shrink-0 z-10 animate-in slide-in-from-right duration-200">
      {/* AI Panel Header */}
      <div className="flex h-9 items-center justify-between border-b border-[#141414] bg-[#030303] px-3.5">
        <div className="flex items-center gap-2">
          <div className="flex size-4 items-center justify-center rounded bg-gradient-to-tr from-indigo-500 to-purple-500">
            <span className="text-[9px] text-white font-bold">✦</span>
          </div>
          <span className="text-[11.5px] font-semibold text-white tracking-wide">
            YAVIN AI ASSISTANT
          </span>
          <span className="rounded-full bg-emerald-950 border border-emerald-800/50 px-1.5 py-0.2 font-mono text-[9px] text-emerald-400">
            NOT CONNECTED
          </span>
        </div>

        <button
          onClick={onClose}
          className="p-1 rounded text-zinc-500 hover:bg-[#141414] hover:text-zinc-200 transition-colors"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Messages Feed */}
      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3.5">
        {messages.map((msg, idx) => (
          <div
            key={idx}
            className={`flex flex-col gap-1.5 ${msg.role === "user" ? "items-end" : "items-start"}`}
          >
            {/* Role Header */}
            <div className="flex items-center gap-1.5 text-[10.5px] text-zinc-500">
              {msg.role === "assistant" ? (
                <>
                  <span className="text-indigo-400 font-bold">✦ Yavin AI</span>
                  <span>•</span>
                  <span>Agent</span>
                </>
              ) : (
                <span className="text-zinc-400 font-medium">You</span>
              )}
            </div>

            {/* Message Bubble */}
            <div
              className={`rounded-xl p-3 text-[12px] leading-relaxed max-w-[95%] ${
                msg.role === "user"
                  ? "bg-indigo-950/40 border border-indigo-500/30 text-white"
                  : "bg-[#090909] border border-[#181818] text-zinc-200"
              }`}
            >
              <p>{msg.text}</p>

              {/* beautifului.dev inspired Thinking State */}
              {msg.thinking && (
                <div className="mt-2.5 flex items-center gap-2 rounded-lg bg-[#0e0e0e] border border-[#1c1c1c] px-2.5 py-1.5 text-[11px] text-zinc-400">
                  <div className="size-1.5 rounded-full bg-indigo-400 animate-ping" />
                  <span className="font-mono text-[10.5px] text-zinc-400">{msg.thinking}</span>
                </div>
              )}

              {/* beautifului.dev inspired Task Rows */}
              {msg.tasks && (
                <div className="mt-2.5 flex flex-col gap-1 border-t border-[#161616] pt-2">
                  {msg.tasks.map((t, i) => (
                    <div key={i} className="flex items-center justify-between text-[11px]">
                      <span className="text-zinc-400 flex items-center gap-1.5">
                        {t.status === "completed" ? (
                          <span className="text-emerald-400">✓</span>
                        ) : t.status === "running" ? (
                          <span className="size-1.5 rounded-full bg-amber-400 animate-pulse" />
                        ) : (
                          <span className="size-1.5 rounded-full bg-zinc-600" />
                        )}
                        <span>{t.label}</span>
                      </span>
                      <span
                        className={`text-[9.5px] font-mono capitalize ${
                          t.status === "completed"
                            ? "text-emerald-400"
                            : t.status === "running"
                              ? "text-amber-400"
                              : "text-zinc-600"
                        }`}
                      >
                        {t.status}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* beautifului.dev inspired Chat Composer Prompt Bar */}
      <div className="p-3 border-t border-[#141414] bg-[#030303]">
        <form
          onSubmit={handleSend}
          className="flex flex-col gap-1.5 rounded-xl border border-[#1a1a1a] bg-[#080808] p-2 focus-within:border-indigo-500/50 transition-all shadow-inner"
        >
          <textarea
            value={inputPrompt}
            onChange={(e) => setInputPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend(e);
              }
            }}
            placeholder="Ask Yavin AI to write, refactor, or explain code..."
            rows={2}
            className="w-full bg-transparent text-[12px] text-white outline-none border-none resize-none placeholder:text-zinc-600 font-sans"
          />
          <div className="flex items-center justify-between pt-1 border-t border-[#121212]">
            <div className="flex items-center gap-1 text-zinc-500 text-[10.5px]">
              <span className="rounded bg-[#121212] px-1 py-0.2 font-mono text-[9.5px]">
                @workspace
              </span>
              <span className="rounded bg-[#121212] px-1 py-0.2 font-mono text-[9.5px]">Rust</span>
            </div>
            <button
              type="submit"
              disabled={!inputPrompt.trim()}
              className="flex size-6.5 items-center justify-center rounded-lg bg-indigo-600 text-white disabled:opacity-30 hover:bg-indigo-500 transition-colors shadow-sm"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </div>
        </form>
      </div>
    </aside>
  );
}
