import { useEffect, useMemo, useRef, useState } from "react";
import { replaceHits, searchWorkspace } from "../../services/search";
import type { SearchHit, SearchResult } from "../../services/search";
import type { SearchOptions } from "../../services/native";
import { ChevronIcon, FileIcon } from "../ui/FileIcons";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CloseIcon,
  CollapseIcon,
  FilterIcon,
  RefreshIcon,
  ReplaceAllIcon,
  ReplaceIcon,
  SearchIcon,
  UndoIcon,
} from "../ui/Icons";

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
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const [activeHitId, setActiveHitId] = useState<string | null>(null);

  const controller = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const scopeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!scopeMenuOpen) return;
    const handleOutside = (e: MouseEvent) => {
      if (scopeRef.current && !scopeRef.current.contains(e.target as Node)) {
        setScopeMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [scopeMenuOpen]);

  const scopeLabels: Record<string, string> = {
    workspace: "Entire Workspace",
    folder: "Specific Folder",
    open: "Open Files Only",
  };

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
      setActiveHitId(null);
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
          setActiveHitId(next.hits[0] ? hitId(next.hits[0]) : null);
          const fileCount = new Set(next.hits.map((h) => h.path)).size;
          setStatus(
            next.hits.length
              ? `${next.hits.length} matches in ${fileCount} files${next.truncated ? " (capped at 10,000)" : ""}`
              : "No matches found",
          );
        })
        .catch((error) => {
          if (!abort.signal.aborted) {
            setStatus(String(error));
            setResult({ hits: [], warning: "", truncated: false });
            setActiveHitId(null);
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

  const toggleSelectAll = () => {
    if (selected.size === result.hits.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(result.hits.map(hitId)));
    }
    setPreview([]);
  };

  const toggleSelectFile = (filePath: string) => {
    const fileHitIds = result.hits.filter((h) => h.path === filePath).map(hitId);
    const allSelected = fileHitIds.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of fileHitIds) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
    setPreview([]);
  };

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
    setActiveHitId(null);
    input.current?.focus();
  };

  // Jump sequentially between search hits across the entire workspace
  const jumpMatch = (direction: "next" | "prev") => {
    if (!result.hits.length) return;
    const currentIndex = activeHitId ? result.hits.findIndex((h) => hitId(h) === activeHitId) : -1;
    let nextIndex = 0;
    if (direction === "next") {
      nextIndex = currentIndex >= 0 && currentIndex < result.hits.length - 1 ? currentIndex + 1 : 0;
    } else {
      nextIndex = currentIndex > 0 ? currentIndex - 1 : result.hits.length - 1;
    }

    const hit = result.hits[nextIndex];
    if (!hit) return;
    const id = hitId(hit);
    setActiveHitId(id);

    // Expand file if collapsed
    if (collapsedFiles.has(hit.path)) {
      setCollapsedFiles((prev) => {
        const next = new Set(prev);
        next.delete(hit.path);
        return next;
      });
    }

    // Switch page if necessary
    const targetPage = Math.floor(nextIndex / 100);
    if (targetPage !== page) {
      setPage(targetPage);
    }

    onOpen(hit);
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

  const replaceAllDirectly = async () => {
    const chosen = result.hits.filter((h) => selected.has(hitId(h)));
    if (!chosen.length) return;
    const fileCount = new Set(chosen.map((h) => h.path)).size;
    if (
      !window.confirm(
        `Replace ${chosen.length} occurrences across ${fileCount} files with "${replacement}"?`,
      )
    )
      return;

    setWriting(true);
    try {
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
          throw new Error("Replacement exceeds 20 MB. Select fewer files.");
        if (before !== after) changes.push({ path, before, after });
      }
      await write(changes);
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

  const hasActiveFilters = Boolean(
    include || exclude || scope !== "workspace" || hidden || ignored,
  );

  return (
    <aside
      hidden={!visible}
      aria-label="Workspace search"
      className="flex flex-col h-full w-[310px] shrink-0 border-r border-[#141414] bg-black select-none text-[12px] font-sans"
    >
      {/* Panel Header */}
      <div className="flex h-9 items-center justify-between px-3 border-b border-[#141414] text-zinc-300 shrink-0 bg-[#050505]">
        <div className="flex items-center gap-1.5">
          <SearchIcon size={14} className="text-zinc-400" />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
            Search
          </span>
        </div>

        <div className="flex items-center gap-0.5">
          {/* Match Navigation (Prev / Next) */}
          {result.hits.length > 0 && (
            <div className="flex items-center gap-0.5 mr-1 bg-[#101010] border border-[#222222] rounded p-0.5">
              <button
                onClick={() => jumpMatch("prev")}
                title="Previous Match"
                className="p-1 rounded text-zinc-400 hover:text-white hover:bg-[#1a1a1a] transition-colors"
              >
                <ArrowUpIcon size={12} />
              </button>
              <button
                onClick={() => jumpMatch("next")}
                title="Next Match"
                className="p-1 rounded text-zinc-400 hover:text-white hover:bg-[#1a1a1a] transition-colors"
              >
                <ArrowDownIcon size={12} />
              </button>
            </div>
          )}

          {/* Toggle Replace */}
          <button
            onClick={() => setReplace(!replace)}
            title={replace ? "Hide Replace" : "Toggle Replace (Ctrl+Shift+H)"}
            aria-expanded={replace}
            className={`p-1 rounded transition-colors ${
              replace
                ? "text-indigo-400 bg-indigo-950/60 border border-indigo-500/40"
                : "text-zinc-500 hover:text-zinc-200 hover:bg-[#121212]"
            }`}
          >
            <ReplaceIcon size={13} />
          </button>

          {/* Refresh Search */}
          <button
            onClick={() => setRevision((r) => r + 1)}
            disabled={!query || writing}
            title="Refresh Search"
            className="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-[#121212] transition-colors disabled:opacity-30"
          >
            <RefreshIcon size={13} className={busy ? "animate-spin text-indigo-400" : ""} />
          </button>

          {/* Collapse/Expand All */}
          <button
            onClick={toggleCollapseAll}
            disabled={!result.hits.length}
            title={collapsedFiles.size > 0 ? "Expand All Files" : "Collapse All Files"}
            className="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-[#121212] transition-colors disabled:opacity-30"
          >
            <CollapseIcon size={13} />
          </button>

          {/* Clear Search */}
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

      {/* Animated Top Progress Bar */}
      <div className="h-[2px] w-full bg-transparent overflow-hidden">
        {busy && (
          <div className="h-full w-full bg-gradient-to-r from-transparent via-indigo-500 to-transparent animate-pulse" />
        )}
      </div>

      {/* Query & Controls Container (Pinned at top) */}
      <div className="p-3 space-y-2.5 border-b border-[#141414] shrink-0 bg-black">
        {!workspace && (
          <p className="text-zinc-500 text-[11px]">
            Open a workspace in the desktop application to search files.
          </p>
        )}

        {/* Search Input Box with Toggle Chevron & Inline Modifiers */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setReplace(!replace)}
              title={replace ? "Hide Replace" : "Toggle Replace"}
              className="text-zinc-500 hover:text-zinc-200 p-0.5 rounded transition-transform"
            >
              <ChevronIcon isExpanded={replace} className="size-3.5" />
            </button>

            <div className="relative flex-1 flex items-center bg-[#0a0a0a] border border-[#222222] focus-within:border-indigo-500 rounded transition-colors pr-1">
              <input
                ref={input}
                aria-label="Search workspace"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search files…"
                className="w-full bg-transparent px-2 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none min-w-0"
              />

              {query && (
                <button
                  type="button"
                  onClick={clearSearch}
                  title="Clear input"
                  className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  <CloseIcon size={11} />
                </button>
              )}

              {/* Inline Search Modifier Toggles */}
              <div className="flex items-center gap-0.5 pl-1 border-l border-[#1a1a1a]">
                <button
                  type="button"
                  onClick={() => setCase(!caseSensitive)}
                  title="Match Case (Alt+C)"
                  aria-label="Match case"
                  className={`px-1.5 py-0.5 text-[10px] font-mono font-bold rounded transition-colors ${
                    caseSensitive
                      ? "bg-indigo-600/30 text-indigo-300 border border-indigo-500/50 shadow-[0_0_8px_rgba(99,102,241,0.25)]"
                      : "text-zinc-500 hover:text-zinc-200 hover:bg-[#181818]"
                  }`}
                >
                  Aa
                </button>
                <button
                  type="button"
                  onClick={() => setWord(!wholeWord)}
                  title="Match Whole Word (Alt+W)"
                  aria-label="Whole word"
                  className={`px-1.5 py-0.5 text-[10px] font-mono font-bold rounded transition-colors ${
                    wholeWord
                      ? "bg-indigo-600/30 text-indigo-300 border border-indigo-500/50 shadow-[0_0_8px_rgba(99,102,241,0.25)]"
                      : "text-zinc-500 hover:text-zinc-200 hover:bg-[#181818]"
                  }`}
                >
                  \b
                </button>
                <button
                  type="button"
                  onClick={() => setRegex(!regex)}
                  title="Use Regular Expression (Alt+R)"
                  aria-label="Regex"
                  className={`px-1.5 py-0.5 text-[10px] font-mono font-bold rounded transition-colors ${
                    regex
                      ? "bg-indigo-600/30 text-indigo-300 border border-indigo-500/50 shadow-[0_0_8px_rgba(99,102,241,0.25)]"
                      : "text-zinc-500 hover:text-zinc-200 hover:bg-[#181818]"
                  }`}
                >
                  .*
                </button>
              </div>
            </div>
          </div>

          {/* Replace Input Row (when replace active) */}
          {replace && (
            <div className="flex items-center gap-1.5 pl-5">
              <div className="relative flex-1 flex items-center bg-[#0a0a0a] border border-[#222222] focus-within:border-indigo-500 rounded transition-colors">
                <input
                  ref={replaceInput}
                  aria-label="Workspace replacement"
                  value={replacement}
                  onChange={(e) => {
                    setReplacement(e.target.value);
                    setPreview([]);
                  }}
                  placeholder="Replace with (literal)…"
                  className="w-full bg-transparent px-2 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none min-w-0"
                />
              </div>

              {/* Replace Action Buttons */}
              <button
                disabled={busy || writing || !selected.size}
                onClick={() => void makePreview()}
                title="Preview Replacements"
                className="px-2 py-1.5 rounded bg-[#161616] hover:bg-[#222222] border border-[#262626] text-[11px] font-medium text-zinc-200 hover:text-white transition-colors disabled:opacity-40"
              >
                Preview ({selected.size})
              </button>

              <button
                disabled={busy || writing || !selected.size}
                onClick={() => void replaceAllDirectly()}
                title="Replace All in Selection"
                className="p-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-40 shadow-sm"
              >
                <ReplaceAllIcon size={13} />
              </button>
            </div>
          )}
        </div>

        {/* Files & Scope Details Expander */}
        <div className="pt-0.5">
          <button
            type="button"
            onClick={() => setScopeOpen(!scopeOpen)}
            className="flex items-center justify-between text-[11px] text-zinc-400 hover:text-zinc-200 transition-colors w-full text-left py-0.5"
          >
            <div className="flex items-center gap-1.5">
              <ChevronIcon isExpanded={scopeOpen} className="size-3" />
              <FilterIcon size={12} className={hasActiveFilters ? "text-indigo-400" : ""} />
              <span className="font-medium">Files to include / exclude &amp; scope</span>
            </div>
            {hasActiveFilters && (
              <span className="size-1.5 rounded-full bg-indigo-500" title="Active filters" />
            )}
          </button>

          {scopeOpen && (
            <div className="space-y-2 pt-2 pl-4">
              <div>
                <label className="text-[10px] text-zinc-500 font-medium block mb-0.5">
                  Files to include
                </label>
                <input
                  className="w-full rounded border border-[#222222] bg-[#0a0a0a] px-2 py-1 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
                  aria-label="Files to include"
                  placeholder="e.g. src/**, *.ts"
                  value={include}
                  onChange={(e) => setInclude(e.target.value)}
                />
              </div>

              <div>
                <label className="text-[10px] text-zinc-500 font-medium block mb-0.5">
                  Files to exclude
                </label>
                <input
                  className="w-full rounded border border-[#222222] bg-[#0a0a0a] px-2 py-1 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
                  aria-label="Files to exclude"
                  placeholder="e.g. **/*.test.ts, dist/**"
                  value={exclude}
                  onChange={(e) => setExclude(e.target.value)}
                />
              </div>

              <div ref={scopeRef} className="relative">
                <label className="text-[10px] text-zinc-500 font-medium block mb-0.5">Scope</label>
                <button
                  type="button"
                  onClick={() => setScopeMenuOpen(!scopeMenuOpen)}
                  className="w-full flex items-center justify-between rounded border border-[#222222] bg-[#0a0a0a] hover:border-[#333333] px-2.5 py-1.5 text-xs text-zinc-200 transition-colors focus:border-indigo-500 focus:outline-none"
                >
                  <span className="font-medium text-[11.5px]">
                    {scopeLabels[scope] || "Entire Workspace"}
                  </span>
                  <ChevronIcon isExpanded={scopeMenuOpen} className="size-3 text-zinc-400" />
                </button>

                {/* Accessible hidden select for screen readers / tests */}
                <select
                  className="sr-only"
                  aria-label="Search scope"
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                  tabIndex={-1}
                >
                  <option value="workspace">Entire Workspace</option>
                  <option value="folder">Specific Folder</option>
                  <option value="open">Open Files Only</option>
                </select>

                {/* Custom OLED Popover Menu */}
                {scopeMenuOpen && (
                  <div className="absolute top-full left-0 right-0 mt-1 z-40 rounded-md border border-[#262626] bg-[#0c0c0c] shadow-2xl py-1 space-y-0.5 backdrop-blur-md">
                    {[
                      { id: "workspace", label: "Entire Workspace" },
                      { id: "folder", label: "Specific Folder" },
                      { id: "open", label: "Open Files Only" },
                    ].map((opt) => (
                      <div
                        key={opt.id}
                        onClick={() => {
                          setScope(opt.id);
                          setScopeMenuOpen(false);
                        }}
                        className={`px-2.5 py-1.5 text-xs flex items-center justify-between cursor-pointer rounded mx-1 transition-colors ${
                          scope === opt.id
                            ? "bg-indigo-600/20 text-indigo-300 font-medium"
                            : "text-zinc-300 hover:bg-[#181818] hover:text-white"
                        }`}
                      >
                        <span>{opt.label}</span>
                        {scope === opt.id && (
                          <span className="text-indigo-400 text-xs font-bold">✓</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {scope === "folder" && (
                <input
                  className="w-full rounded border border-[#222222] bg-[#0a0a0a] px-2 py-1 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
                  aria-label="Search folder"
                  placeholder="Relative folder, e.g. src"
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                />
              )}

              {/* Interactive Scope Toggle Chips */}
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setHidden(!hidden)}
                  className={`px-2 py-1 rounded text-[10.5px] font-medium transition-colors border ${
                    hidden
                      ? "bg-indigo-600/25 border-indigo-500/50 text-indigo-300"
                      : "bg-[#0d0d0d] border-[#222222] text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {hidden ? "✓ Hidden files" : "+ Hidden files"}
                </button>
                <button
                  type="button"
                  onClick={() => setIgnored(!ignored)}
                  className={`px-2 py-1 rounded text-[10.5px] font-medium transition-colors border ${
                    ignored
                      ? "bg-indigo-600/25 border-indigo-500/50 text-indigo-300"
                      : "bg-[#0d0d0d] border-[#222222] text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {ignored ? "✓ Ignored files" : "+ Ignored files"}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Live Status Pill & Batch Actions */}
        {(status || busy || result.hits.length > 0) && (
          <div className="flex items-center justify-between text-[11px] pt-1">
            <div
              role="status"
              aria-live="polite"
              className={`truncate font-medium ${
                busy
                  ? "text-indigo-400 animate-pulse"
                  : result.hits.length
                    ? "text-zinc-300"
                    : "text-zinc-500"
              }`}
            >
              {status}
            </div>

            <div className="flex items-center gap-1.5 shrink-0 ml-2">
              {replace && result.hits.length > 0 && (
                <button
                  type="button"
                  onClick={toggleSelectAll}
                  className="text-[10px] text-zinc-400 hover:text-white underline cursor-pointer"
                >
                  {selected.size === result.hits.length ? "Deselect All" : "Select All"}
                </button>
              )}

              {busy && (
                <button
                  onClick={() => {
                    controller.current?.abort();
                    setBusy(false);
                    setStatus("Cancelled");
                  }}
                  className="text-[10px] text-rose-400 hover:text-rose-300 underline"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        )}

        {/* Warning Banner */}
        {result.warning && (
          <div className="text-amber-300 text-[11px] bg-amber-500/10 border border-amber-500/20 rounded p-2 flex items-start gap-1.5">
            <span className="text-amber-400 font-bold shrink-0">⚠</span>
            <p className="leading-tight">{result.warning}</p>
          </div>
        )}

        {/* Undo Replacements Banner */}
        {undo.length > 0 && (
          <button
            disabled={writing}
            onClick={() =>
              void write(
                undo.map((c) => ({ path: c.path, before: c.after, after: c.before })),
                true,
              )
            }
            className="w-full rounded bg-zinc-800 hover:bg-zinc-700 py-1.5 text-[11px] text-zinc-200 hover:text-white transition-colors flex items-center justify-center gap-1.5 border border-zinc-700"
          >
            <UndoIcon size={12} />
            <span>Undo last replacement ({undo.length} files)</span>
          </button>
        )}

        {/* Replacement Preview Drawer */}
        {preview.length > 0 && (
          <section
            aria-label="Replacement preview"
            className="space-y-2 border border-indigo-500/40 bg-indigo-950/20 rounded-lg p-2.5 shadow-lg"
          >
            <div className="flex items-center justify-between">
              <span className="font-semibold text-indigo-300 text-[11.5px]">
                Replacement Preview ({preview.length} files)
              </span>
              <button
                className="text-zinc-400 hover:text-white text-[11px] underline"
                onClick={() => setPreview([])}
              >
                Dismiss
              </button>
            </div>
            <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1">
              {preview.map((change) => {
                const relativePath = change.path.slice(workspace.length + 1);
                const fileName = relativePath.split("/").pop() || relativePath;
                return (
                  <details
                    key={change.path}
                    className="bg-[#0a0a0a] border border-[#222222] rounded overflow-hidden"
                  >
                    <summary className="px-2 py-1 cursor-pointer font-medium text-zinc-300 hover:bg-[#141414] text-[11px] flex items-center justify-between">
                      <span>{fileName}</span>
                      <span className="text-[10px] text-zinc-500">expand diff</span>
                    </summary>
                    <div className="p-2 space-y-1 text-[10.5px]">
                      <p className="text-rose-400 font-semibold text-[10px]">BEFORE:</p>
                      <pre className="overflow-auto max-h-24 whitespace-pre-wrap bg-rose-950/20 text-rose-300 p-1.5 rounded font-mono text-[10px]">
                        {change.before.slice(0, 2000)}
                      </pre>
                      <p className="text-emerald-400 font-semibold text-[10px] pt-1">AFTER:</p>
                      <pre className="overflow-auto max-h-24 whitespace-pre-wrap bg-emerald-950/20 text-emerald-300 p-1.5 rounded font-mono text-[10px]">
                        {change.after.slice(0, 2000)}
                      </pre>
                    </div>
                  </details>
                );
              })}
            </div>
            <button
              disabled={writing || busy}
              onClick={() => void write(preview)}
              className="w-full rounded bg-indigo-600 hover:bg-indigo-500 py-1.5 text-xs font-medium text-white transition-colors shadow-md"
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
            <SearchIcon size={28} className="text-zinc-600" />
            <p className="text-xs font-medium text-zinc-400">No results found</p>
            <p className="text-[11px] text-zinc-600">
              No occurrences of &ldquo;{query}&rdquo; found in scope.
            </p>
          </div>
        )}

        {result.hits.length === 0 && !query && (
          <div className="flex flex-col items-center justify-center p-8 text-center text-zinc-600 gap-2">
            <SearchIcon size={28} className="text-zinc-700" />
            <p className="text-xs font-medium text-zinc-500">Search Workspace</p>
            <p className="text-[11px] text-zinc-600">
              Type to find text across all files with ripgrep speed.
            </p>
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
                className="flex items-center justify-between px-2.5 py-1.5 bg-[#080808] hover:bg-[#121212] cursor-pointer transition-colors group/header"
              >
                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                  <ChevronIcon isExpanded={!isCollapsed} className="size-3 shrink-0" />
                  <FileIcon name={fileName} isDir={false} className="size-3.5 shrink-0" />
                  <span className="text-zinc-100 font-semibold text-[11.5px] truncate">
                    {fileName}
                  </span>
                  {dirPath && (
                    <span className="text-zinc-500 text-[10.5px] truncate max-w-[120px]">
                      {dirPath}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  {replace && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleSelectFile(group.path);
                      }}
                      title="Toggle selection for all matches in file"
                      className="text-[10px] text-zinc-500 hover:text-zinc-200 px-1 py-0.2 rounded hover:bg-[#1a1a1a] opacity-0 group-hover/header:opacity-100 transition-opacity"
                    >
                      toggle all
                    </button>
                  )}
                  <span className="ml-1 px-1.5 py-0.2 rounded-full text-[10px] bg-zinc-800 text-zinc-300 font-mono font-medium">
                    {group.hits.length}
                  </span>
                </div>
              </div>

              {/* Hit Rows for File */}
              {!isCollapsed && (
                <div className="divide-y divide-[#0a0a0a]">
                  {group.hits.map((hit) => {
                    const id = hitId(hit);
                    const isActive = activeHitId === id;

                    return (
                      <div
                        key={id}
                        className={`flex items-center gap-1.5 px-2 py-0.5 transition-colors group cursor-pointer ${
                          isActive
                            ? "bg-indigo-950/30 border-l-2 border-indigo-500"
                            : "hover:bg-[#121212] border-l-2 border-transparent"
                        }`}
                        onClick={() => {
                          setActiveHitId(id);
                          onOpen(hit);
                        }}
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
                            onClick={(e) => e.stopPropagation()}
                            className="size-3.5 rounded bg-[#101010] border border-[#2a2a2a] text-indigo-500 focus:ring-0 focus:ring-offset-0 shrink-0 cursor-pointer my-auto ml-1 mr-0.5"
                          />
                        )}

                        <div className="flex items-center min-w-0 flex-1 overflow-hidden">
                          {/* Line Number Gutter */}
                          <span className="text-zinc-500 text-[10.5px] min-w-[38px] w-[38px] shrink-0 text-right pr-2 select-none group-hover:text-zinc-300 font-mono tabular-nums border-r border-[#1a1a1a]">
                            {hit.line}
                          </span>

                          {/* Code Snippet with Highlight */}
                          <button
                            disabled={busy}
                            title={`${hit.path}:${hit.line}\n${hit.text}`}
                            className="flex items-baseline min-w-0 flex-1 text-left font-mono text-[11px] truncate cursor-pointer pl-2 py-0.5"
                          >
                            <span className="text-zinc-300 truncate">
                              {hit.text.slice(Math.max(0, hit.start - 35), hit.start)}
                              <mark className="inline-block bg-amber-400/25 text-amber-200 border border-amber-400/40 rounded px-0.5 font-bold leading-tight align-baseline">
                                {hit.text.slice(hit.start, hit.end) || "│"}
                              </mark>
                              {hit.text.slice(hit.end, hit.end + 100)}
                            </span>
                          </button>
                        </div>
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
          <span className="font-mono text-[10.5px]">
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
