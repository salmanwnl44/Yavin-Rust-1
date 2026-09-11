interface StatusBarProps {
  activeFile: string;
  onToggleTerminal: () => void;
}

export function StatusBar({ activeFile, onToggleTerminal }: StatusBarProps) {
  const language = activeFile.endsWith(".tsx")
    ? "TypeScript React"
    : activeFile.endsWith(".ts")
      ? "TypeScript"
      : activeFile.endsWith(".rs")
        ? "Rust"
        : "Plain text";
  return (
    <footer className="flex h-6 items-center justify-between border-t border-[#151515] bg-black px-3 text-[11px] text-zinc-400">
      <span className="truncate">{activeFile || "Yavin IDE"}</span>
      <div className="flex shrink-0 items-center gap-4">
        <span>UTF-8</span>
        <span>{language}</span>
        <button onClick={onToggleTerminal}>Terminal: unavailable</button>
      </div>
    </footer>
  );
}
