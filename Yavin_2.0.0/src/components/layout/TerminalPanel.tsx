import React, { useState } from "react";

export function TerminalPanel({
  onClose,
  isMaximized,
  onToggleMaximize,
}: {
  onClose: () => void;
  isMaximized: boolean;
  onToggleMaximize: () => void;
}) {
  const [activeTab, setActiveTab] = useState("terminal");
  const [commandInput, setCommandInput] = useState("");
  const [history, setHistory] = useState<{ type: string; text: string; output?: string }[]>([
    { type: "system", text: "Terminal is not connected. Commands entered here are not executed." },
  ]);

  const handleCommandSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!commandInput.trim()) return;

    const cmd = commandInput.trim();
    let res = "";
    if (cmd === "clear") {
      setHistory([]);
      setCommandInput("");
      return;
    } else if (cmd === "help") {
      res = "Available commands: help, clear. A native terminal has not been implemented.";
    } else {
      res = "Command not executed: terminal integration is unavailable.";
    }

    setHistory((prev) => [...prev, { type: "prompt", text: cmd, output: res }]);
    setCommandInput("");
  };

  return (
    <div
      className={`flex flex-col border-t border-[#181818] bg-[#030303] select-none text-[12px] ${isMaximized ? "h-[85vh]" : "h-52"} transition-all duration-200 shrink-0`}
    >
      {/* Terminal Header */}
      <div className="flex h-8 items-center justify-between border-b border-[#141414] bg-[#050505] px-3">
        {/* Left Tabs */}
        <div className="flex items-center gap-4 text-[11px] font-medium">
          {[
            { id: "terminal", label: "TERMINAL (UNAVAILABLE)", badge: null },
            { id: "problems", label: "PROBLEMS", badge: "0" },
            { id: "output", label: "OUTPUT", badge: null },
            { id: "debug", label: "DEBUG CONSOLE", badge: null },
            { id: "ai", label: "AI LOGS", badge: null },
          ].map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 pb-1 relative transition-colors ${
                  isActive ? "text-white font-semibold" : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                <span>{tab.label}</span>
                {tab.badge && (
                  <span
                    className={`px-1 rounded text-[9px] font-mono ${
                      tab.badge === "Live"
                        ? "bg-emerald-950 text-emerald-400 border border-emerald-800/50"
                        : "bg-[#181818] text-zinc-400"
                    }`}
                  >
                    {tab.badge}
                  </span>
                )}
                {isActive && (
                  <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-indigo-500 rounded-full" />
                )}
              </button>
            );
          })}
        </div>

        {/* Right Terminal Action Icons */}
        <div className="flex items-center gap-1 text-zinc-500">
          <button
            className="p-1 rounded hover:bg-[#151515] hover:text-zinc-200 transition-colors"
            title="New Terminal (+)"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button
            className="p-1 rounded hover:bg-[#151515] hover:text-zinc-200 transition-colors"
            title="Split Terminal"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="12" y1="3" x2="12" y2="21" />
            </svg>
          </button>
          <button
            onClick={onToggleMaximize}
            className="p-1 rounded hover:bg-[#151515] hover:text-zinc-200 transition-colors"
            title={isMaximized ? "Restore Panel" : "Maximize Panel"}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              {isMaximized ? (
                <path d="M4 14h6v6M20 10h-6V4" />
              ) : (
                <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
              )}
            </svg>
          </button>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[#151515] hover:text-zinc-200 transition-colors"
            title="Close Panel"
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
      </div>

      {/* Terminal Body */}
      <div className="flex-1 overflow-y-auto p-3 font-mono text-[12px] leading-relaxed text-zinc-300 bg-[#000000]">
        {activeTab === "terminal" ? (
          <div className="flex flex-col gap-1.5">
            {history.map((item, i) => (
              <div key={i} className="flex flex-col">
                {item.type === "system" && <span className="text-zinc-500">{item.text}</span>}
                {item.type === "info" && <span className="text-indigo-400/90">{item.text}</span>}
                {item.type === "prompt" && (
                  <>
                    <div className="flex items-center gap-2">
                      <span className="text-emerald-400 font-bold">yavin-ide</span>
                      <span className="text-zinc-500 font-normal">on</span>
                      <span className="text-purple-400"> main</span>
                      <span className="text-zinc-400 font-bold">$</span>
                      <span className="text-white">{item.text}</span>
                    </div>
                    {item.output && (
                      <span className="text-zinc-400 pl-4 whitespace-pre-wrap">{item.output}</span>
                    )}
                  </>
                )}
              </div>
            ))}

            {/* Input Line */}
            <form onSubmit={handleCommandSubmit} className="flex items-center gap-2 mt-1">
              <span className="text-emerald-400 font-bold">yavin-ide</span>
              <span className="text-zinc-400 font-bold">$</span>
              <input
                type="text"
                value={commandInput}
                onChange={(e) => setCommandInput(e.target.value)}
                placeholder="help or clear (shell execution unavailable)"
                className="flex-1 bg-transparent text-white outline-none border-none font-mono text-[12px] placeholder:text-zinc-600"
                autoFocus
              />
            </form>
          </div>
        ) : activeTab === "problems" ? (
          <div className="flex flex-col items-center justify-center py-6 text-zinc-500 gap-2">
            <span>Workspace diagnostics are not connected.</span>
          </div>
        ) : activeTab === "ai" ? (
          <div className="flex flex-col gap-1 text-[11.5px] text-zinc-400">
            <span>No AI service is connected. No tasks have run.</span>
          </div>
        ) : (
          <div className="text-zinc-500">No output service is connected.</div>
        )}
      </div>
    </div>
  );
}
