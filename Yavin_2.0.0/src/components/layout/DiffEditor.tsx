import { useState } from "react";
export interface DiffDocument { path: string; title: string; text: string }
export function DiffEditor({ document, onClose, onOpen }: { document: DiffDocument; onClose: () => void; onOpen: () => void }) {
  const [page, setPage] = useState(0);
  const lines = document.text.split("\n");
  return <section aria-label="Git diff" className="flex-1 min-h-0 flex flex-col text-xs text-zinc-300">
    <header className="flex items-center gap-3 border-b border-zinc-800 px-4 py-3"><span className="flex-1 truncate" title={document.path}>{document.title} — {document.path}</span><button onClick={onOpen}>Open file</button><button onClick={onClose}>Close diff</button></header>
    <div className="flex-1 overflow-auto font-mono select-text py-2">{lines.slice(page * 500, (page + 1) * 500).map((line, i) => <pre key={i} className={`px-4 min-h-5 ${line.startsWith("+") ? "bg-green-950/50 text-green-300" : line.startsWith("-") ? "bg-red-950/50 text-red-300" : line.startsWith("@@") ? "bg-indigo-950/50 text-indigo-300" : ""}`}>{line || " "}</pre>)}</div>
    {lines.length > 500 && <footer className="p-2 flex gap-4"><button disabled={!page} onClick={() => setPage(p => p - 1)}>Previous lines</button><span>{page * 500 + 1}–{Math.min((page + 1) * 500, lines.length)} / {lines.length}</span><button disabled={(page + 1) * 500 >= lines.length} onClick={() => setPage(p => p + 1)}>Next lines</button></footer>}
  </section>;
}
