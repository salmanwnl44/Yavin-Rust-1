import { useCallback, useEffect, useRef, useState } from "react";
import { native } from "../../services/native";
import { parseBranch, parseGitEntries } from "../../services/git";
import type { GitEntry } from "../../services/git";
import type { DiffDocument } from "./DiffEditor";
import type { Replacement } from "./SearchPanel";

export function SourceControlPanel({ workspace, visible, buffers, dirty, revision, onDiff, onChanged, onEntries, apply }: {
  workspace: string; visible: boolean; buffers: Record<string, string>; dirty: boolean; revision: number;
  onDiff: (diff: DiffDocument | null) => void; onChanged: () => Promise<void>;
  onEntries: (entries: GitEntry[]) => void;
  apply: (changes: Replacement[]) => Promise<{ applied: Replacement[]; errors: string[] }>;
}) {
  const [root, setRoot] = useState<string | null>(null);
  const [entries, setEntries] = useState<GitEntry[]>([]);
  const [branch, setBranch] = useState<ReturnType<typeof parseBranch>>({ name: "", upstream: "", ahead: 0, behind: 0 });
  const [branches, setBranches] = useState<string[]>([]);
  const [message, setMessage] = useState(() => localStorage.getItem(`yavin.commit:${workspace}`) ?? "");
  const [newBranch, setNewBranch] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [recovery, setRecovery] = useState<Replacement | null>(null);
  const alive = useRef(true);
  const generation = useRef(0);
  const operation = useRef(false);
  const callbacks = useRef({ onEntries, onChanged }); callbacks.current = { onEntries, onChanged };
  const git = useCallback((action: string, path?: string, value?: string) => native("git_workbench", { workspace, action, path, value }), [workspace]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  useEffect(() => { try { localStorage.setItem(`yavin.commit:${workspace}`, message); } catch { /* Draft remains in memory when storage is unavailable. */ } }, [workspace, message]);
  const refresh = useCallback(async () => {
    if (!workspace) return;
    const current = ++generation.current;
    setLoading(true);
    try {
      const found = await git("discover");
      if (!alive.current || generation.current !== current) return;
      setRoot(found);
      if (!found) { setEntries([]); callbacks.current.onEntries([]); setNotice("This folder is not a Git repository."); return; }
      const output = await git("status");
      const info = await git("branchInfo");
      const names = await git("branches");
      if (!alive.current || generation.current !== current) return;
      const next = parseGitEntries(output, found);
      setEntries(next); callbacks.current.onEntries(next); setBranch(parseBranch(info)); setBranches(names.trim().split("\n").filter(Boolean));
    } catch (error) { if (alive.current && generation.current === current) setNotice(String(error)); }
    finally { if (alive.current && generation.current === current) setLoading(false); }
  }, [git, workspace]);
  useEffect(() => { void refresh(); }, [refresh, revision]);
  useEffect(() => {
    if (!visible) return;
    const update = () => { if (!operation.current) void refresh(); };
    window.addEventListener("focus", update);
    const timer = setInterval(() => { if (document.visibilityState === "visible") update(); }, 5000);
    return () => { window.removeEventListener("focus", update); clearInterval(timer); };
  }, [visible, refresh]);
  const act = async (action: string, path?: string, value?: string) => {
    if (operation.current) return;
    operation.current = true; setBusy(true); setNotice(""); generation.current++;
    try {
      if (["switch", "branch", "pull"].includes(action) && dirty) throw new Error("Save or close unsaved editors before changing the working tree.");
      const output = await git(action, path, value);
      if (!alive.current) return;
      if (action === "commit") setMessage("");
      if (action === "branch") setNewBranch("");
      onDiff(null);
      await callbacks.current.onChanged();
      setNotice(output.trim() || "Operation completed.");
    } catch (error) { if (alive.current) setNotice(String(error)); }
    finally { operation.current = false; if (alive.current) { setBusy(false); await refresh(); } }
  };
  const showDiff = async (entry: GitEntry, staged: boolean) => {
    const current = ++generation.current;
    try {
      const text = entry.untracked ? await native("read_file_content", { path: entry.path }) : await git(staged ? "stagedDiff" : "diff", entry.path);
      if (!alive.current || current !== generation.current) return;
      onDiff({ path: entry.path, title: entry.untracked ? "Untracked file" : staged ? "HEAD → Index" : "Index → Saved file", text: (buffers[entry.path] !== undefined ? "Open editor may have unsaved edits. This view shows saved Git content.\n\n" : "") + (text || "No textual differences. The change may be metadata-only.") });
    } catch (error) { if (alive.current) setNotice(String(error)); }
  };
  const discard = async (entry: GitEntry) => {
    if (!window.confirm(`Discard saved changes in ${entry.path}? A recovery copy will be kept until the next discard or workspace close.`)) return;
    if (dirty) { setNotice("Save or close unsaved editors before discarding saved changes."); return; }
    setBusy(true);
    try {
      const before = await native("read_file_content", { path: entry.path });
      const after = await git("indexContent", entry.path);
      const change = { path: entry.path, before, after };
      const outcome = await apply([change]);
      if (outcome.errors.length) throw new Error(outcome.errors.join(" "));
      setRecovery(change); await callbacks.current.onChanged(); await refresh();
    } catch (error) { setNotice(String(error)); } finally { setBusy(false); }
  };
  const groups = [
    { name: "Conflicts", entries: entries.filter(e => e.conflict), staged: false },
    { name: "Staged Changes", entries: entries.filter(e => !e.conflict && !e.untracked && e.index !== " "), staged: true },
    { name: "Changes", entries: entries.filter(e => !e.conflict && !e.untracked && e.worktree !== " "), staged: false },
    { name: "Untracked", entries: entries.filter(e => e.untracked), staged: false },
  ];
  const rootOpen = root === workspace;
  return <aside hidden={!visible} aria-label="Source control" className="w-[310px] shrink-0 border-r border-zinc-800 bg-[#050505] text-xs text-zinc-300 overflow-y-auto">
    <div className="p-3 space-y-3"><div className="flex justify-between"><h2 className="font-semibold">SOURCE CONTROL</h2><button disabled={busy || loading} onClick={() => void refresh()}>Refresh</button></div>
      {!workspace ? <p>Open a workspace in the desktop application.</p> : root === null ? <p>Discovering repository…</p> : root && <>
        <p className="break-all text-zinc-500">{root}</p><p>{branch.name} {branch.upstream && `→ ${branch.upstream}`} <span title="Ahead / behind">↑{branch.ahead} ↓{branch.behind}</span></p>
        {!rootOpen && <p className="text-amber-300">Open the repository root to commit, switch branches, or use remotes. This list covers the opened folder.</p>}
        <fieldset disabled={busy || loading} className="space-y-2 disabled:opacity-60">
          <textarea aria-label="Commit message" placeholder="Commit message" className="w-full border border-zinc-700 rounded bg-zinc-950 p-2" value={message} onChange={e => setMessage(e.target.value)} rows={3} />
          <button className="w-full rounded bg-indigo-700 py-2 disabled:opacity-40" disabled={!rootOpen || !message.trim() || !groups[1].entries.length || !!groups[0].entries.length} onClick={() => void act("commit", undefined, message)}>Commit Staged ({groups[1].entries.length})</button>
          <details><summary className="cursor-pointer">Branches and remotes</summary><div className="space-y-2 pt-2">
            <select aria-label="Switch branch" className="w-full bg-zinc-900 p-2" value={branches.includes(branch.name) ? branch.name : ""} disabled={!rootOpen || dirty} onChange={e => void act("switch", undefined, e.target.value)}><option value="" disabled>Choose branch</option>{branches.map(name => <option key={name}>{name}</option>)}</select>
            <input aria-label="New branch name" placeholder="New branch name" className="w-full bg-zinc-900 p-2" value={newBranch} onChange={e => setNewBranch(e.target.value)} />
            <button disabled={!rootOpen || dirty || !newBranch.trim()} onClick={() => void act("branch", undefined, newBranch)}>Create and switch</button>
            <div className="flex gap-3"><button disabled={!rootOpen} onClick={() => void act("fetch")}>Fetch</button><button disabled={!rootOpen || dirty} onClick={() => void act("pull")}>Pull (fast-forward)</button><button disabled={!rootOpen} onClick={() => void act("push")}>Push</button></div>
            <p className="text-zinc-500">Uses Git’s configured remotes and credential helpers.</p>
          </div></details>
        </fieldset>
      </>}
      <p role="status" aria-live="polite" className="whitespace-pre-wrap break-words">{busy ? "Running Git operation…" : loading ? "Refreshing…" : notice || (root && !entries.length ? "Working tree clean" : "")}</p>
      {recovery && <button disabled={busy} onClick={() => { const change = recovery; setBusy(true); void apply([{ path: change.path, before: change.after, after: change.before }]).then(async outcome => { if (outcome.errors.length) setNotice(outcome.errors.join(" ")); else { setRecovery(null); await callbacks.current.onChanged(); await refresh(); } }).catch(e => setNotice(String(e))).finally(() => setBusy(false)); }}>Undo last discard</button>}
    </div>
    {root && groups.map(group => <section key={group.name} aria-label={group.name}><h3 className="px-3 py-2 font-medium bg-zinc-900">{group.name} ({group.entries.length})</h3>{group.entries.map(entry => <div key={entry.path} className="flex items-center gap-2 px-3 py-2 hover:bg-zinc-900">
      <span title={`Index ${entry.index}, working tree ${entry.worktree}`} className={entry.conflict ? "text-red-400" : "text-amber-300"}>{entry.conflict ? "!" : entry.untracked ? "U" : group.staged ? entry.index : entry.worktree}</span>
      <button title={entry.originalPath ? `${entry.originalPath} → ${entry.path}` : entry.path} className="truncate text-left flex-1" disabled={busy} onClick={() => void showDiff(entry, group.staged)}>{entry.path.slice(workspace.length + 1)}</button>
      <button disabled={busy || loading} aria-label={`${group.staged ? "Unstage" : "Stage"} ${entry.path}`} onClick={() => { if (entry.conflict && !window.confirm("Stage this file as resolved? Review and remove conflict markers first.")) return; void act(group.staged ? "unstage" : "stage", entry.path); }}>{group.staged ? "−" : "+"}</button>
      {!group.staged && entry.worktree === "M" && !entry.conflict && <button disabled={busy || loading} aria-label={`Discard ${entry.path}`} onClick={() => void discard(entry)}>↶</button>}
    </div>)}</section>)}
  </aside>;
}
