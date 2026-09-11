import { useEffect, useRef, useState } from "react";
import { replaceHits, searchWorkspace } from "../../services/search";
import type { SearchHit, SearchResult } from "../../services/search";
import type { SearchOptions } from "../../services/native";

export interface Replacement { path: string; before: string; after: string }
const hitId = (h: SearchHit) => `${h.path}\0${h.line}:${h.start}`;
const inputClass = "w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100 focus:outline-indigo-400";

export function SearchPanel({ workspace, buffers, visible, focusRequest, onOpen, read, apply }: {
  workspace: string; buffers: Record<string, string>; visible: boolean; focusRequest: number;
  onOpen: (hit: SearchHit) => void;
  read: (path: string) => Promise<string>;
  apply: (changes: Replacement[]) => Promise<{ applied: Replacement[]; errors: string[] }>;
}) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [replace, setReplace] = useState(false);
  const [caseSensitive, setCase] = useState(false);
  const [wholeWord, setWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [ignored, setIgnored] = useState(false);
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [scope, setScope] = useState("workspace");
  const [folder, setFolder] = useState("");
  const [result, setResult] = useState<SearchResult>({ hits: [], warning: "", truncated: false });
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [writing, setWriting] = useState(false);
  const [selected, setSelected] = useState(new Set<string>());
  const [preview, setPreview] = useState<Replacement[]>([]);
  const [undo, setUndo] = useState<Replacement[]>([]);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // Read open buffers when a search starts; editing them must not re-run the search.
  const latestBuffers = useRef(buffers); latestBuffers.current = buffers;
  useEffect(() => { if (visible) input.current?.focus(); }, [visible, focusRequest]);
  useEffect(() => {
    if (!workspace || !query) { setResult({ hits: [], warning: "", truncated: false }); setStatus(""); setBusy(false); return; }
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setPreview([]); setSelected(new Set()); setPage(0);
    const timer = setTimeout(() => {
      const options: SearchOptions = { query, caseSensitive, wholeWord, regex, hidden, ignored,
        include: include.split(",").map(s => s.trim()).filter(Boolean), exclude: exclude.split(",").map(s => s.trim()).filter(Boolean),
        folder: scope === "folder" && folder ? `${workspace}/${folder.replace(/^\/+/, "")}` : workspace,
        buffer: null, filesOnly: false };
      setStatus("Searching…");
      void searchWorkspace(workspace, options, latestBuffers.current, scope === "open", abort.signal).then(next => {
        if (abort.signal.aborted) return;
        setResult(next); setSelected(new Set(next.hits.map(hitId)));
        setStatus(next.hits.length ? `${next.hits.length} matches in ${new Set(next.hits.map(h => h.path)).size} files${next.truncated ? " (incomplete)" : ""}` : "No matches");
      }).catch(error => { if (!abort.signal.aborted) { setStatus(String(error)); setResult({ hits: [], warning: "", truncated: false }); } })
        .finally(() => { if (!abort.signal.aborted) setBusy(false); });
    }, 200);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [workspace, query, caseSensitive, wholeWord, regex, hidden, ignored, include, exclude, scope, folder, revision]);
  const toggle = (id: string) => setSelected(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const makePreview = async () => {
    setWriting(true);
    try {
      const chosen = result.hits.filter(h => selected.has(hitId(h)));
      const changes: Replacement[] = [];
      let bytes = 0;
      for (const path of new Set(chosen.map(h => h.path))) {
        const before = await read(path);
        const after = replaceHits(before, chosen.filter(h => h.path === path), replacement);
        bytes += (before.length + after.length) * 2;
        if (bytes > 20 * 1024 * 1024) throw new Error("Replacement recovery exceeds 20 MB. Select fewer files.");
        if (before !== after) changes.push({ path, before, after });
      }
      setPreview(changes); setStatus(changes.length ? `Review replacement in ${changes.length} files. Replacement text is literal.` : "No changes to apply");
    } catch (error) { setStatus(String(error)); }
    finally { setWriting(false); }
  };
  const write = async (changes: Replacement[], recovering = false) => {
    setWriting(true);
    try {
      const outcome = await apply(changes);
      setUndo(recovering ? outcome.errors.length ? undo.filter(item => !outcome.applied.some(done => done.path === item.path)) : [] : outcome.applied);
      setPreview([]);
      setStatus(`${outcome.applied.length} files ${recovering ? "restored" : "updated"}. ${outcome.errors.join(" ")}`);
      setResult({ hits: [], warning: "Search again to refresh results.", truncated: false });
    } catch (error) { setStatus(String(error)); }
    finally { setWriting(false); }
  };
  const hits = result.hits.slice(page * 100, (page + 1) * 100);
  return <aside hidden={!visible} aria-label="Workspace search" className="w-[310px] shrink-0 border-r border-zinc-800 bg-[#050505] text-xs text-zinc-300 overflow-y-auto">
    <div className="p-3 space-y-2">
      <div className="flex justify-between"><h2 className="font-semibold">SEARCH</h2><button aria-expanded={replace} onClick={() => setReplace(!replace)}>Replace</button></div>
      {!workspace && <p>Open a workspace in the desktop application to search files.</p>}
      <input ref={input} className={inputClass} aria-label="Search workspace" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search files…" />
      <div className="flex gap-3">{[["Match case", caseSensitive, setCase], ["Whole word", wholeWord, setWord], ["Regex", regex, setRegex]].map(([label, value, setter]) => <label key={String(label)}><input type="checkbox" checked={Boolean(value)} onChange={e => (setter as (v: boolean) => void)(e.target.checked)} /> {String(label)}</label>)}</div>
      {replace && <><input className={inputClass} aria-label="Workspace replacement" value={replacement} onChange={e => { setReplacement(e.target.value); setPreview([]); }} placeholder="Replace with (literal)…" /><button disabled={busy || writing || !selected.size} className="rounded bg-indigo-700 px-2 py-1 disabled:opacity-40" onClick={() => void makePreview()}>Preview selected replacements</button></>}
      <details><summary className="cursor-pointer">Files and scope</summary><div className="space-y-2 pt-2">
        <input className={inputClass} aria-label="Files to include" placeholder="Include: src/**, *.ts" value={include} onChange={e => setInclude(e.target.value)} />
        <input className={inputClass} aria-label="Files to exclude" placeholder="Exclude: **/*.test.ts" value={exclude} onChange={e => setExclude(e.target.value)} />
        <select className={inputClass} aria-label="Search scope" value={scope} onChange={e => setScope(e.target.value)}><option value="workspace">Workspace</option><option value="folder">Folder</option><option value="open">Open files</option></select>
        {scope === "folder" && <input className={inputClass} aria-label="Search folder" placeholder="Relative folder, e.g. src" value={folder} onChange={e => setFolder(e.target.value)} />}
        <label className="block"><input type="checkbox" checked={hidden} onChange={e => setHidden(e.target.checked)} /> Include hidden files</label>
        <label className="block"><input type="checkbox" checked={ignored} onChange={e => setIgnored(e.target.checked)} /> Include ignored files</label>
        <p className="text-zinc-500">UTF-8 text up to 10 MB. Git metadata and linked directories are excluded.</p>
      </div></details>
      <div role="status" aria-live="polite">{status}</div>
      {result.warning && <p className="text-amber-300">{result.warning}</p>}
      <div className="flex gap-3"><button onClick={() => setRevision(r => r + 1)} disabled={!query || writing}>Search again</button>{busy && <button onClick={() => { controller.current?.abort(); setBusy(false); setStatus("Cancelled"); }}>Cancel</button>}{undo.length > 0 && <button disabled={writing} onClick={() => void write(undo.map(c => ({ path: c.path, before: c.after, after: c.before })), true)}>Undo replacement</button>}</div>
      {preview.length > 0 && <section aria-label="Replacement preview" className="space-y-2 border border-indigo-500 p-2">
        {preview.map(change => <details key={change.path}><summary>{change.path.slice(workspace.length + 1)}</summary><p>Before</p><pre className="overflow-auto max-h-36 whitespace-pre-wrap text-red-300">{change.before.slice(0, 3000)}</pre><p>After</p><pre className="overflow-auto max-h-36 whitespace-pre-wrap text-green-300">{change.after.slice(0, 3000)}</pre><p>Preview shows first 3,000 characters; open the file for full context.</p></details>)}
        <button disabled={writing || busy} onClick={() => void write(preview)}>Apply {preview.length} reviewed files</button><button className="ml-3" onClick={() => setPreview([])}>Cancel preview</button>
      </section>}
    </div>
    <div aria-label="Search results">{hits.map((hit, index) => <div key={hitId(hit)}>
      {(index === 0 || hits[index - 1].path !== hit.path) && <div className="bg-zinc-900 px-3 py-2 break-all font-medium">{hit.path.slice(workspace.length + 1)}</div>}
      <div className="flex items-start gap-1 px-2 py-1 hover:bg-zinc-900">
        {replace && <input aria-label={`Select ${hit.path}:${hit.line}:${hit.start + 1}`} type="checkbox" checked={selected.has(hitId(hit))} onChange={() => { toggle(hitId(hit)); setPreview([]); }} />}
        <button className="text-left min-w-0 flex-1 font-mono truncate" disabled={busy} title={`${hit.path}:${hit.line}\n${hit.text}`} onClick={() => onOpen(hit)}><span className="text-zinc-500 mr-2">{hit.line}</span>{hit.text.slice(Math.max(0, hit.start - 35), hit.start)}<mark className="bg-amber-800 text-white">{hit.text.slice(hit.start, hit.end) || "│"}</mark>{hit.text.slice(hit.end, hit.end + 100)}</button>
      </div>
    </div>)}</div>
    {result.hits.length > 100 && <div className="p-3 flex justify-between"><button disabled={!page} onClick={() => setPage(p => p - 1)}>Previous</button><span>Page {page + 1} / {Math.ceil(result.hits.length / 100)}</span><button disabled={(page + 1) * 100 >= result.hits.length} onClick={() => setPage(p => p + 1)}>Next</button></div>}
  </aside>;
}
