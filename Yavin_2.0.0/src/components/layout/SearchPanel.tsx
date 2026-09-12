import { useEffect, useMemo, useRef, useState } from "react";
import { replaceHits, searchWorkspace } from "../../services/search";
import type { SearchHit, SearchResult } from "../../services/search";
import type { SearchOptions } from "../../services/native";
import { ChevronIcon, FileIcon } from "../ui/FileIcons";
import { CollapseIcon, RefreshIcon, SearchIcon, ReplaceIcon, CloseIcon } from "../ui/Icons";

export interface Replacement {
  path: string;
  before: string;
  after: string;
}

const hitId = (h: SearchHit) => `${h.path}\0${h.line}:${h.start}`;

export function SearchPanel({
  workspace,
  buffers,
  visible,
  focusRequest,
  onOpen,
  read,
  apply,
}: {
  workspace: string;
  buffers: Record<string, string>;
  visible: boolean;
  focusRequest: number;
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
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const [scopeOpen, setScopeOpen] = useState(false);

  const controller = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);

  // Read open buffers when a search starts; editing them must not re-run the search.
  const latestBuffers = useRef(buffers);
  latestBuffers.current = buffers;

  useEffect(() => {
    if (visible) input.current?.focus();
  }, [visible, focusRequest]);

  useEffect(() => {
    if (!workspace || !query) {
      setResult({ hits: [], warning: "", truncated: false });
      setStatus("");
      setBusy(false);
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setPreview([]);
    setSelected(new Set());
    setPage(0);
    const timer = setTimeout(() => {
      const options: SearchOptions = {
        query,
        caseSensitive,
        wholeWord,
        regex,
        hidden,
        ignored,
        include: include
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        exclude: exclude
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        folder:
          scope === "folder" && folder ? `${workspace}/${folder.replace(/^\/+/, "")}` : workspace,
        buffer: null,
        filesOnly: false,
      };
      setStatus("Searching…");
      void searchWorkspace(
        workspace,
        options,
        latestBuffers.current,
        scope === "open",
        abort.signal,
      )
        .then((next) => {
          if (abort.signal.aborted) return;
          setResult(next);
          setSelected(new Set(next.hits.map(hitId)));
          setStatus(
            next.hits.length
              ? `${next.hits.length} matches in ${new Set(next.hits.map((h) => h.path)).size} files${next.truncated ? " (incomplete)" : ""}`
              : "No matches",
          );
        })
        .catch((error) => {
          if (!abort.signal.aborted) {
            setStatus(String(error));
            setResult({ hits: [], warning: "", truncated: false });
          }
        })
        .finally(() => {
          if (!abort.signal.aborted) setBusy(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [
    workspace,
    query,
    caseSensitive,
    wholeWord,
    regex,
    hidden,
    ignored,
    include,
    exclude,
    scope,
    folder,
    revision,
  ]);

  const toggle = (id: string) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleFileCollapse = (filePath: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  };

  const toggleCollapseAll = () => {
    if (collapsedFiles.size > 0) {
      setCollapsedFiles(new Set());
    } else {
      const allPaths = new Set(result.hits.map((h) => h.path));
      setCollapsedFiles(allPaths);
    }
  };

  const clearSearch = () => {
    setQuery("");
    setReplacement("");
    setResult({ hits: [], warning: "", truncated: false });
    setStatus("");
    setPreview([]);
    input.current?.focus();
  };

  const makePreview = async () => {
    setWriting(true);
    try {
      const chosen = result.hits.filter((h) => selected.has(hitId(h)));
      const changes: Replacement[] = [];
      let bytes = 0;
      for (const path of new Set(chosen.map((h) => h.path))) {
        const before = await read(path);
        const after = replaceHits(
          before,
          chosen.filter((h) => h.path === path),
          replacement,
        );
        bytes += (before.length + after.length) * 2;
        if (bytes > 20 * 1024 * 1024)
          throw new Error("Replacement recovery exceeds 20 MB. Select fewer files.");
        if (before !== after) changes.push({ path, before, after });
      }
      setPreview(changes);
      setStatus(
        changes.length
          ? `Review replacement in ${changes.length} files. Replacement text is literal.`
          : "No changes to apply",
      );
    } catch (error) {
      setStatus(String(error));
    } finally {
      setWriting(false);
    }
  };

  const write = async (changes: Replacement[], recovering = false) => {
    setWriting(true);
    try {
      const outcome = await apply(changes);
      setUndo(
        recovering
          ? outcome.errors.length
            ? undo.filter((item) => !outcome.applied.some((done) => done.path === item.path))
            : []
          : outcome.applied,
      );
      setPreview([]);
      setStatus(
        `${outcome.applied.length} files ${recovering ? "restored" : "updated"}. ${outcome.errors.join(" ")}`,
      );
      setResult({ hits: [], warning: "Search again to refresh results.", truncated: false });
    } catch (error) {
      setStatus(String(error));
    } finally {
      setWriting(false);
    }
  };

  // Group current page hits by file path
  const hits = result.hits.slice(page * 100, (page + 1) * 100);
  const groupedHits = useMemo(() => {
    const groups: { path: string; hits: SearchHit[] }[] = [];
    let currentPath = "";
    for (const hit of hits) {
      if (hit.path !== currentPath) {
        currentPath = hit.path;
        groups.push({ path: hit.path, hits: [hit] });
      } else {
        groups[groups.length - 1].hits.push(hit);
      }
    }
    return groups;
  }, [hits]);

  return (
    <aside
      hidden={!visible}
      aria-label="Workspace search"
      className="flex flex-col h-full w-[300px] shrink-0 border-r border-[#141414] bg-black select-none text-[12px] font-sans"
    >
      {/* Panel Header */}
      <div className="flex h-9 items-center justify-between px-3 border-b border-[#141414] text-zinc-300 shrink-0">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
          Search
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setReplace(!replace)}
            title={replace ? "Hide Replace" : "Toggle Replace"}
            aria-expanded={replace}
            className={`p-1 rounded transition-colors ${
              replace
                ? "text-indigo-400 bg-indigo-950/60"
                : "text-zinc-500 hover:text-zinc-200 hover:bg-[#121212]"
            }`}
          >
            <ReplaceIcon size={13} />
          </button>
          <button
            onClick={() => setRevision((r) => r + 1)}
            disabled={!query || writing}
            title="Refresh Search"
            className="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-[#121212] transition-colors disabled:opacity-30"
          >
            <RefreshIcon size={13} />
          </button>
          <button
            onClick={toggleCollapseAll}
            disabled={!result.hits.length}
            title={collapsedFiles.size > 0 ? "Expand All" : "Collapse All"}
            className="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-[#121212] transition-colors disabled:opacity-30"
          >
            <CollapseIcon size={13} />
          </button>
          {query && (
            <button
              onClick={clearSearch}
              title="Clear Search"
              className="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-[#121212] transition-colors"
            >
              <CloseIcon size={13} />
            </button>
          )}
        </div>
      </div>

      {/* Query & Controls Container (Pinned at top) */}
      <div className="p-3 space-y-2 border-b border-[#141414] shrink-0 bg-black">
        {!workspace && (
          <p className="text-zinc-500 text-[11px]">
            Open a workspace in the desktop application to search files.
          </p>
        )}

        {/* Search Input Box with Inline Toggles */}
        <div className="relative flex items-center bg-[#0a0a0a] border border-[#222222] focus-within:border-indigo-500 rounded transition-colors">
          <button
            type="button"
            onClick={() => setReplace(!replace)}
            title="Toggle Replace"
            className="pl-2 pr-1 text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <ChevronIcon isExpanded={replace} className="size-3" />
          </button>
          <input
            ref={input}
            aria-label="Search workspace"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search files…"
            className="w-full bg-transparent px-1.5 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none min-w-0"
          />
          <div className="flex items-center gap-0.5 pr-1.5">
            <button
              type="button"
              onClick={() => setCase(!caseSensitive)}
              title="Match Case (Alt+C)"
              aria-label="Match case"
              className={`px-1 py-0.5 text-[10.5px] font-mono font-medium rounded transition-colors ${
                caseSensitive
                  ? "bg-indigo-600/30 text-indigo-300 border border-indigo-500/50"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-[#181818]"
              }`}
            >
              Aa
            </button>
            <button
              type="button"
              onClick={() => setWord(!wholeWord)}
              title="Match Whole Word (Alt+W)"
              aria-label="Whole word"
              className={`px-1 py-0.5 text-[10.5px] font-mono font-medium rounded transition-colors ${
                wholeWord
                  ? "bg-indigo-600/30 text-indigo-300 border border-indigo-500/50"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-[#181818]"
              }`}
            >
              \b
            </button>
            <button
              type="button"
              onClick={() => setRegex(!regex)}
              title="Use Regular Expression (Alt+R)"
              aria-label="Regex"
              className={`px-1 py-0.5 text-[10.5px] font-mono font-medium rounded transition-colors ${
                regex
                  ? "bg-indigo-600/30 text-indigo-300 border border-indigo-500/50"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-[#181818]"
              }`}
            >
              .*
            </button>
          </div>
        </div>

        {/* Replace Input Box (when replace active) */}
        {replace && (
          <div className="space-y-1.5 pt-0.5">
            <div className="flex items-center bg-[#0a0a0a] border border-[#222222] focus-within:border-indigo-500 rounded transition-colors pl-6 pr-1.5">
              <input
                aria-label="Workspace replacement"
                value={replacement}
                onChange={(e) => {
                  setReplacement(e.target.value);
                  setPreview([]);
                }}
                placeholder="Replace with (literal)…"
                className="w-full bg-transparent py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none min-w-0"
              />
            </div>
            <button
              disabled={busy || writing || !selected.size}
              onClick={() => void makePreview()}
              className="w-full rounded bg-indigo-600 hover:bg-indigo-500 py-1.5 text-[11px] font-medium text-white transition-colors disabled:opacity-40 disabled:hover:bg-indigo-600"
            >
              Preview selected replacements ({selected.size})
            </button>
          </div>
        )}

        {/* Files & Scope Accordion */}
        <div className="pt-0.5">
          <button
            type="button"
            onClick={() => setScopeOpen(!scopeOpen)}
            className="flex items-center gap-1.5 text-[11px] text-zinc-400 hover:text-zinc-200 transition-colors w-full text-left"
          >
            <ChevronIcon isExpanded={scopeOpen} className="size-3" />
            <span className="font-medium">Files to include / exclude &amp; scope</span>
          </button>
          {scopeOpen && (
            <div className="space-y-2 pt-2 pl-4">
              <input
                className="w-full rounded border border-[#222222] bg-[#0a0a0a] px-2 py-1 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
                aria-label="Files to include"
                placeholder="Include: src/**, *.ts"
                value={include}
                onChange={(e) => setInclude(e.target.value)}
              />
              <input
                className="w-full rounded border border-[#222222] bg-[#0a0a0a] px-2 py-1 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
                aria-label="Files to exclude"
                placeholder="Exclude: **/*.test.ts"
                value={exclude}
                onChange={(e) => setExclude(e.target.value)}
              />
              <select
                className="w-full rounded border border-[#222222] bg-[#0a0a0a] px-2 py-1 text-xs text-zinc-300 focus:border-indigo-500 focus:outline-none"
                aria-label="Search scope"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
              >
                <option value="workspace">Entire Workspace</option>
                <option value="folder">Specific Folder</option>
                <option value="open">Open Files Only</option>
              </select>
              {scope === "folder" && (
                <input
                  className="w-full rounded border border-[#222222] bg-[#0a0a0a] px-2 py-1 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
                  aria-label="Search folder"
                  placeholder="Relative folder, e.g. src"
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                />
              )}
              <div className="flex flex-col gap-1.5 pt-1 text-[11px] text-zinc-400">
                <label className="flex items-center gap-2 cursor-pointer hover:text-zinc-200">
                  <input
                    type="checkbox"
                    checked={hidden}
                    onChange={(e) => setHidden(e.target.checked)}
                    className="accent-indigo-600 rounded"
                  />
                  <span>Include hidden files</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer hover:text-zinc-200">
                  <input
                    type="checkbox"
                    checked={ignored}
                    onChange={(e) => setIgnored(e.target.checked)}
                    className="accent-indigo-600 rounded"
                  />
                  <span>Include ignored files</span>
                </label>
              </div>
              <p className="text-[10px] text-zinc-600 leading-tight">
                UTF-8 text up to 10 MB. Git metadata and linked directories are excluded.
              </p>
            </div>
          )}
        </div>

        {/* Status / Live Bar */}
        {(status || busy) && (
          <div className="flex items-center justify-between text-[11px] pt-1">
            <div
              role="status"
              aria-live="polite"
              className={`truncate ${busy ? "text-indigo-400 animate-pulse" : "text-zinc-400"}`}
            >
              {status}
            </div>
            {busy && (
              <button
                onClick={() => {
                  controller.current?.abort();
                  setBusy(false);
                  setStatus("Cancelled");
                }}
                className="text-[10.5px] text-zinc-400 hover:text-zinc-200 ml-2 shrink-0 underline"
              >
                Cancel
              </button>
            )}
          </div>
        )}

        {result.warning && (
          <p className="text-amber-400 text-[11px] bg-amber-500/10 border border-amber-500/20 rounded p-1.5">
            {result.warning}
          </p>
        )}

        {undo.length > 0 && (
          <button
            disabled={writing}
            onClick={() =>
              void write(
                undo.map((c) => ({ path: c.path, before: c.after, after: c.before })),
                true,
              )
            }
            className="w-full rounded bg-zinc-800 hover:bg-zinc-700 py-1 text-[11px] text-zinc-200 transition-colors"
          >
            Undo replacement ({undo.length} files)
          </button>
        )}

        {/* Replacement Preview Panel */}
        {preview.length > 0 && (
          <section
            aria-label="Replacement preview"
            className="space-y-2 border border-indigo-500/40 bg-indigo-950/20 rounded p-2.5"
          >
            <div className="flex items-center justify-between">
              <span className="font-semibold text-indigo-300 text-[11.5px]">
                Replacement Preview ({preview.length} files)
              </span>
              <button
                className="text-zinc-400 hover:text-zinc-200 text-[11px]"
                onClick={() => setPreview([])}
              >
                Cancel
              </button>
            </div>
            <div className="max-h-48 overflow-y-auto space-y-2 pr-1">
              {preview.map((change) => {
                const relativePath = change.path.slice(workspace.length + 1);
                const fileName = relativePath.split("/").pop() || relativePath;
                return (
                  <details
                    key={change.path}
                    className="bg-[#0a0a0a] border border-[#222222] rounded overflow-hidden"
                  >
                    <summary className="px-2 py-1 cursor-pointer font-medium text-zinc-300 hover:bg-[#141414] text-[11px]">
                      {fileName}
                    </summary>
                    <div className="p-2 space-y-1 text-[10.5px]">
                      <p className="text-red-400 font-semibold">Before:</p>
                      <pre className="overflow-auto max-h-24 whitespace-pre-wrap bg-red-950/20 text-red-300 p-1.5 rounded font-mono">
                        {change.before.slice(0, 3000)}
                      </pre>
                      <p className="text-emerald-400 font-semibold pt-1">After:</p>
                      <pre className="overflow-auto max-h-24 whitespace-pre-wrap bg-emerald-950/20 text-emerald-300 p-1.5 rounded font-mono">
                        {change.after.slice(0, 3000)}
                      </pre>
                    </div>
                  </details>
                );
              })}
            </div>
            <button
              disabled={writing || busy}
              onClick={() => void write(preview)}
              className="w-full rounded bg-indigo-600 hover:bg-indigo-500 py-1.5 text-[11px] font-medium text-white transition-colors"
            >
              Apply {preview.length} reviewed files
            </button>
          </section>
        )}
      </div>

      {/* Search Results Area (Scrollable) */}
      <div
        aria-label="Search results"
        className="flex-1 overflow-y-auto min-h-0 py-1 divide-y divide-[#101010]"
      >
        {result.hits.length === 0 && !busy && query && (
          <div className="flex flex-col items-center justify-center p-8 text-center text-zinc-500 gap-2">
            <SearchIcon size={24} className="text-zinc-600" />
            <p className="text-xs">No results found for &ldquo;{query}&rdquo;</p>
          </div>
        )}

        {result.hits.length === 0 && !query && (
          <div className="flex flex-col items-center justify-center p-8 text-center text-zinc-600 gap-2">
            <SearchIcon size={24} className="text-zinc-700" />
            <p className="text-xs">Search across files in workspace</p>
          </div>
        )}

        {groupedHits.map((group) => {
          const relativePath = group.path.startsWith(workspace)
            ? group.path.slice(workspace.length + 1)
            : group.path;
          const parts = relativePath.split(/[/\\]/);
          const fileName = parts.pop() || relativePath;
          const dirPath = parts.join("/");
          const isCollapsed = collapsedFiles.has(group.path);

          return (
            <div key={group.path} className="text-xs">
              {/* File Group Header */}
              <div
                onClick={() => toggleFileCollapse(group.path)}
                className="flex items-center justify-between px-2.5 py-1.5 bg-[#080808] hover:bg-[#121212] cursor-pointer transition-colors"
              >
                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                  <ChevronIcon isExpanded={!isCollapsed} className="size-3 shrink-0" />
                  <FileIcon name={fileName} isDir={false} className="size-3.5 shrink-0" />
                  <span className="text-zinc-200 font-medium text-[11.5px] truncate">
                    {fileName}
                  </span>
                  {dirPath && (
                    <span className="text-zinc-500 text-[10.5px] truncate">{dirPath}</span>
                  )}
                </div>
                <span className="ml-2 px-1.5 py-0.2 rounded-full text-[10px] bg-zinc-800 text-zinc-400 font-mono shrink-0">
                  {group.hits.length}
                </span>
              </div>

              {/* Hit Rows for File */}
              {!isCollapsed && (
                <div className="pl-4 divide-y divide-[#0c0c0c]">
                  {group.hits.map((hit) => {
                    const id = hitId(hit);
                    return (
                      <div
                        key={id}
                        className="flex items-center gap-1.5 px-2 py-1 hover:bg-[#141414] group transition-colors"
                      >
                        {replace && (
                          <input
                            aria-label={`Select ${hit.path}:${hit.line}:${hit.start + 1}`}
                            type="checkbox"
                            checked={selected.has(id)}
                            onChange={() => {
                              toggle(id);
                              setPreview([]);
                            }}
                            className="accent-indigo-600 rounded shrink-0 cursor-pointer"
                          />
                        )}
                        <button
                          disabled={busy}
                          title={`${hit.path}:${hit.line}\n${hit.text}`}
                          onClick={() => onOpen(hit)}
                          className="flex items-baseline min-w-0 flex-1 text-left font-mono text-[11px] truncate cursor-pointer"
                        >
                          <span className="text-zinc-500 text-[10.5px] w-6 shrink-0 text-right pr-2 select-none group-hover:text-zinc-400">
                            {hit.line}
                          </span>
                          <span className="text-zinc-400 truncate">
                            {hit.text.slice(Math.max(0, hit.start - 35), hit.start)}
                            <mark className="bg-amber-500/25 text-amber-200 border border-amber-500/40 rounded-xs px-0.5 font-semibold">
                              {hit.text.slice(hit.start, hit.end) || "│"}
                            </mark>
                            {hit.text.slice(hit.end, hit.end + 100)}
                          </span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Pagination Footer */}
      {result.hits.length > 100 && (
        <div className="p-2 border-t border-[#141414] flex items-center justify-between text-[11px] text-zinc-400 shrink-0 bg-black">
          <button
            disabled={!page}
            onClick={() => setPage((p) => p - 1)}
            className="px-2 py-1 rounded bg-[#121212] hover:bg-[#1a1a1a] disabled:opacity-30 transition-colors"
          >
            Previous
          </button>
          <span>
            Page {page + 1} of {Math.ceil(result.hits.length / 100)}
          </span>
          <button
            disabled={(page + 1) * 100 >= result.hits.length}
            onClick={() => setPage((p) => p + 1)}
            className="px-2 py-1 rounded bg-[#121212] hover:bg-[#1a1a1a] disabled:opacity-30 transition-colors"
          >
            Next
          </button>
        </div>
      )}
    </aside>
  );
}
