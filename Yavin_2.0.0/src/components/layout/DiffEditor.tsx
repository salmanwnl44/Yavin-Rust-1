import { useMemo, useRef, useState } from "react";
import { FileIcon } from "../ui/FileIcons";
import { ArrowDownIcon, ArrowUpIcon, CloseIcon, DiffIcon, PlusIcon, UndoIcon } from "../ui/Icons";
import { parseUnifiedDiff } from "../../services/git/diffHunks";
import { diffWords, type WordSegment } from "../../services/git/wordDiff";

export interface DiffDocument {
  path: string;
  title: string;
  text: string;
  /** Present for a real Git diff (absent for the untracked-file plain-content view). */
  repoId?: string;
  /** "unstaged": working tree vs index. "staged": index vs HEAD. */
  kind?: "unstaged" | "staged";
}

interface ParsedDiffLine {
  type: "header" | "hunk" | "add" | "delete" | "context";
  oldLineNumber?: number;
  newLineNumber?: number;
  text: string;
  hunkIndex?: number;
  /** Set only for a delete/add pair recognized as one line's replacement. */
  segments?: WordSegment[];
}

/**
 * Pairs each maximal run of consecutive deletions with the maximal run of
 * additions immediately following it (this is how a line edit shows up in a
 * unified diff) and attaches a word-level diff to each pair, up to however many
 * lines the shorter run has. Extra lines beyond that -- a real add or delete, not
 * a replacement -- are left without `segments` and render as whole lines.
 */
function attachWordDiffs(parsed: ParsedDiffLine[]): void {
  let index = 0;
  while (index < parsed.length) {
    if (parsed[index].type !== "delete") {
      index++;
      continue;
    }
    let deleteEnd = index;
    while (deleteEnd + 1 < parsed.length && parsed[deleteEnd + 1].type === "delete") deleteEnd++;
    const addStart = deleteEnd + 1;
    let addEnd = addStart;
    while (addEnd < parsed.length && parsed[addEnd].type === "add") addEnd++;

    const pairs = Math.min(deleteEnd - index + 1, addEnd - addStart);
    for (let offset = 0; offset < pairs; offset++) {
      const deleted = parsed[index + offset];
      const added = parsed[addStart + offset];
      const words = diffWords(deleted.text, added.text);
      deleted.segments = words.old;
      added.segments = words.new;
    }
    index = Math.max(addEnd, deleteEnd + 1);
  }
}

export function DiffEditor({
  document,
  onClose,
  onOpen,
  onStageHunk,
  onUnstageHunk,
  onDiscardHunk,
}: {
  document: DiffDocument;
  onClose: () => void;
  onOpen: () => void;
  /** Present only when hunk-level staging is available (a real, non-untracked diff). */
  onStageHunk?: (hunkIndex: number) => void;
  onUnstageHunk?: (hunkIndex: number) => void;
  onDiscardHunk?: (hunkIndex: number) => void;
}) {
  const [page, setPage] = useState(0);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const PAGE_SIZE = 600;

  const fileName = document.path.split(/[/\\]/).pop() || document.path;
  const dirPath = document.path.split(/[/\\]/).slice(0, -1).join("/");

  // Parse lines, line numbers, and stats using the same hunk boundaries that
  // `stageHunks`/`unstageHunks`/`discardHunks` (services/git/repository.ts) apply
  // patches by, so a hunk clicked here is always the hunk actually acted on.
  const { lines, stats, hunkIndices } = useMemo(() => {
    const { headerLines, hunks } = parseUnifiedDiff(document.text);
    const parsed: ParsedDiffLine[] = [];
    let additions = 0;
    let deletions = 0;
    const hunkPositions: number[] = [];

    for (const line of headerLines) {
      if (
        line.startsWith("diff --git") ||
        line.startsWith("index ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ")
      ) {
        parsed.push({ type: "header", text: line });
      }
    }

    hunks.forEach((hunk, hunkIndex) => {
      // Hunk header format: @@ -oldStart,oldLen +newStart,newLen @@
      const match = hunk.header.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      let oldNum = match ? parseInt(match[1], 10) : 0;
      let newNum = match ? parseInt(match[2], 10) : 0;

      hunkPositions.push(parsed.length);
      parsed.push({ type: "hunk", text: hunk.header, hunkIndex: hunkIndex + 1 });

      for (const line of hunk.lines) {
        if (line.startsWith("+")) {
          additions++;
          parsed.push({
            type: "add",
            newLineNumber: newNum++,
            text: line.slice(1),
          });
        } else if (line.startsWith("-")) {
          deletions++;
          parsed.push({
            type: "delete",
            oldLineNumber: oldNum++,
            text: line.slice(1),
          });
        } else {
          parsed.push({
            type: "context",
            oldLineNumber: oldNum > 0 ? oldNum++ : undefined,
            newLineNumber: newNum > 0 ? newNum++ : undefined,
            text: line.startsWith(" ") ? line.slice(1) : line,
          });
        }
      }
    });

    attachWordDiffs(parsed);

    return {
      lines: parsed,
      stats: { additions, deletions },
      hunkIndices: hunkPositions,
    };
  }, [document.text]);

  const [activeHunk, setActiveHunk] = useState(0);

  const jumpToHunk = (direction: "next" | "prev") => {
    if (!hunkIndices.length) return;
    let nextIndex = direction === "next" ? activeHunk + 1 : activeHunk - 1;
    if (nextIndex < 0) nextIndex = hunkIndices.length - 1;
    if (nextIndex >= hunkIndices.length) nextIndex = 0;
    setActiveHunk(nextIndex);

    const lineIndex = hunkIndices[nextIndex];
    // Jump to correct page if needed
    const targetPage = Math.floor(lineIndex / PAGE_SIZE);
    if (targetPage !== page) {
      setPage(targetPage);
    }

    setTimeout(() => {
      const element = scrollContainerRef.current?.querySelector(`[data-hunk="${nextIndex + 1}"]`);
      if (element) {
        element.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 50);
  };

  const paginatedLines = lines.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(lines.length / PAGE_SIZE);

  return (
    <section
      aria-label="Git diff editor"
      className="flex-1 min-h-0 flex flex-col bg-[#000000] text-zinc-300 font-sans select-none overflow-hidden"
    >
      {/* Tab & Action Toolbar */}
      <header className="flex h-9 items-center justify-between border-b border-[#181818] bg-[#050505] px-3 gap-2 shrink-0">
        {/* Left: Tab Pill with File Icon, Name, and Status */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-t bg-[#0c0c0c] border-t border-x border-[#222222] text-xs max-w-full">
            <FileIcon name={fileName} isDir={false} className="size-3.5 shrink-0" />
            <span className="font-medium text-white truncate text-[12px]">{fileName}</span>
            {dirPath && (
              <span className="text-zinc-500 text-[10.5px] truncate max-w-[180px] hidden sm:inline">
                {dirPath}
              </span>
            )}
            <span className="px-1.5 py-0.2 rounded text-[9.5px] font-medium bg-zinc-800 text-zinc-300 border border-zinc-700 shrink-0 ml-1">
              {document.title}
            </span>
          </div>

          {/* Stats Badges */}
          {(stats.additions > 0 || stats.deletions > 0) && (
            <div className="flex items-center gap-1 text-[11px] font-mono shrink-0 ml-1">
              {stats.additions > 0 && (
                <span className="px-1.5 py-0.2 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 font-semibold">
                  +{stats.additions}
                </span>
              )}
              {stats.deletions > 0 && (
                <span className="px-1.5 py-0.2 rounded bg-rose-500/15 text-rose-400 border border-rose-500/30 font-semibold">
                  -{stats.deletions}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Right Toolbar Actions */}
        <div className="flex items-center gap-1 shrink-0">
          {hunkIndices.length > 1 && (
            <div className="flex items-center gap-0.5 mr-2 bg-[#101010] border border-[#222222] rounded p-0.5">
              <button
                onClick={() => jumpToHunk("prev")}
                title="Previous Change"
                className="p-1 rounded text-zinc-400 hover:text-white hover:bg-[#1c1c1c] transition-colors"
              >
                <ArrowUpIcon size={12} />
              </button>
              <span className="text-[10px] font-mono px-1 text-zinc-400">
                {activeHunk + 1}/{hunkIndices.length}
              </span>
              <button
                onClick={() => jumpToHunk("next")}
                title="Next Change"
                className="p-1 rounded text-zinc-400 hover:text-white hover:bg-[#1c1c1c] transition-colors"
              >
                <ArrowDownIcon size={12} />
              </button>
            </div>
          )}

          <button
            onClick={onOpen}
            className="px-2 py-1 rounded bg-[#141414] hover:bg-[#202020] border border-[#262626] text-zinc-200 text-[11px] font-medium transition-colors hover:text-white"
          >
            Open in Editor
          </button>

          <button
            onClick={onClose}
            title="Close Diff (Escape)"
            className="p-1 rounded text-zinc-400 hover:text-white hover:bg-[#1a1a1a] transition-colors ml-1"
          >
            <CloseIcon size={14} />
          </button>
        </div>
      </header>

      {/* Main Diff Content with Line Numbers Gutter */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-auto font-mono text-[12px] leading-[20px] select-text bg-[#000000]"
      >
        {lines.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full p-8 text-center text-zinc-500 gap-2">
            <DiffIcon size={28} className="text-zinc-600" />
            <p className="text-sm font-medium text-zinc-400">No textual differences</p>
            <p className="text-xs text-zinc-600">The file change may be metadata or binary only.</p>
          </div>
        ) : (
          <div className="min-w-full inline-block py-1">
            {paginatedLines.map((line, idx) => {
              if (line.type === "hunk") {
                const hunkIndex = (line.hunkIndex ?? 1) - 1;
                return (
                  <div
                    key={idx}
                    data-hunk={line.hunkIndex}
                    className="flex items-center gap-2 bg-[#0d131f] text-indigo-300 font-semibold border-y border-indigo-950/60 py-0.5 px-2 my-1 select-none text-[11px]"
                  >
                    <span className="w-16 shrink-0 text-center text-indigo-400/80 font-bold">
                      @@
                    </span>
                    <span className="truncate flex-1">{line.text}</span>
                    {(onStageHunk || onUnstageHunk || onDiscardHunk) && (
                      <div className="flex items-center gap-1 shrink-0">
                        {onStageHunk && (
                          <button
                            onClick={() => onStageHunk(hunkIndex)}
                            title="Stage Hunk"
                            className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#141414] hover:bg-[#202020] text-zinc-300 hover:text-white transition-colors text-[10.5px] font-normal"
                          >
                            <PlusIcon size={10} />
                            Stage Hunk
                          </button>
                        )}
                        {onUnstageHunk && (
                          <button
                            onClick={() => onUnstageHunk(hunkIndex)}
                            title="Unstage This Hunk"
                            className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#141414] hover:bg-[#202020] text-zinc-300 hover:text-white transition-colors text-[10.5px] font-normal"
                          >
                            <UndoIcon size={10} />
                            Unstage This Hunk
                          </button>
                        )}
                        {onDiscardHunk && (
                          <button
                            onClick={() => {
                              if (window.confirm("Discard this hunk? This cannot be undone."))
                                onDiscardHunk(hunkIndex);
                            }}
                            title="Discard Hunk"
                            className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#141414] hover:bg-[#2a1414] text-zinc-300 hover:text-rose-300 transition-colors text-[10.5px] font-normal"
                          >
                            <UndoIcon size={10} />
                            Discard Hunk
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              }

              if (line.type === "header") {
                return (
                  <div
                    key={idx}
                    className="flex items-center text-zinc-600 text-[11px] py-0.2 px-2 select-none"
                  >
                    <span className="w-24 shrink-0 text-right pr-4 font-mono">---</span>
                    <span className="truncate">{line.text}</span>
                  </div>
                );
              }

              const isAdd = line.type === "add";
              const isDelete = line.type === "delete";

              return (
                <div
                  key={idx}
                  className={`flex items-stretch min-w-full hover:bg-white/[0.02] transition-colors ${
                    isAdd
                      ? "bg-emerald-950/20 text-emerald-200"
                      : isDelete
                        ? "bg-rose-950/20 text-rose-200"
                        : "text-zinc-300"
                  }`}
                >
                  {/* Left Gutter: Old Line Number */}
                  <span
                    className={`w-12 shrink-0 text-right pr-2 text-[11px] select-none ${
                      isDelete ? "text-rose-400/70 font-semibold bg-rose-950/30" : "text-zinc-600"
                    }`}
                  >
                    {line.oldLineNumber ?? ""}
                  </span>

                  {/* Right Gutter: New Line Number */}
                  <span
                    className={`w-12 shrink-0 text-right pr-2 text-[11px] select-none border-r border-[#1a1a1a] ${
                      isAdd
                        ? "text-emerald-400/70 font-semibold bg-emerald-950/30"
                        : "text-zinc-600"
                    }`}
                  >
                    {line.newLineNumber ?? ""}
                  </span>

                  {/* Marker Indicator (+, -, or blank) */}
                  <span
                    className={`w-6 shrink-0 text-center select-none font-bold text-xs ${
                      isAdd
                        ? "text-emerald-400 bg-emerald-500/10"
                        : isDelete
                          ? "text-rose-400 bg-rose-500/10"
                          : "text-transparent"
                    }`}
                  >
                    {isAdd ? "+" : isDelete ? "-" : " "}
                  </span>

                  {/* Code Line Content */}
                  <pre className="flex-1 pl-2 pr-4 font-mono text-[12px] leading-[20px] whitespace-pre overflow-x-visible">
                    {line.segments ? (
                      line.segments.map((segment, segmentIndex) => (
                        <span
                          key={segmentIndex}
                          className={
                            segment.type === "del"
                              ? "rounded-[2px] bg-rose-500/30"
                              : segment.type === "add"
                                ? "rounded-[2px] bg-emerald-500/30"
                                : undefined
                          }
                        >
                          {segment.text}
                        </span>
                      ))
                    ) : (
                      <>{line.text || " "}</>
                    )}
                  </pre>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Pagination Footer (when diff exceeds single page) */}
      {totalPages > 1 && (
        <footer className="h-8 border-t border-[#181818] bg-[#050505] px-3 flex items-center justify-between text-xs text-zinc-400 shrink-0">
          <button
            disabled={!page}
            onClick={() => setPage((p) => p - 1)}
            className="px-2 py-0.5 rounded bg-[#141414] hover:bg-[#202020] disabled:opacity-30 transition-colors text-[11px]"
          >
            Previous lines
          </button>
          <span className="text-[11px] font-mono text-zinc-500">
            Lines {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, lines.length)} of{" "}
            {lines.length}
          </span>
          <button
            disabled={page >= totalPages - 1}
            onClick={() => setPage((p) => p + 1)}
            className="px-2 py-0.5 rounded bg-[#141414] hover:bg-[#202020] disabled:opacity-30 transition-colors text-[11px]"
          >
            Next lines
          </button>
        </footer>
      )}
    </section>
  );
}
