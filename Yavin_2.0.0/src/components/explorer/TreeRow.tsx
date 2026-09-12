import React from "react";
import type { FileNode } from "../../types";
import { ChevronIcon, FileIcon } from "../ui/FileIcons";

/** Every row in the tree is exactly this tall, which is what makes windowing possible. */
export const ROW_HEIGHT = 26;
const INDENT = 14;

/** Left padding for a row at `depth`, plus a faint guide line for each level above it. */
export function indentStyle(depth: number): React.CSSProperties {
  return {
    height: ROW_HEIGHT,
    paddingLeft: depth * INDENT + 10,
    background: depth
      ? `repeating-linear-gradient(to right, rgba(255,255,255,0.07) 0 1px, transparent 1px ${INDENT}px) 17px 0 / ${depth * INDENT}px 100% no-repeat`
      : undefined,
  };
}

// Git porcelain letters shown next to a name, plus the conflict marker.
const badgeStyles: Record<string, { label: string; badge: string; text: string }> = {
  M: {
    label: "Modified",
    badge: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    text: "text-amber-300",
  },
  U: {
    label: "Untracked",
    badge: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    text: "text-emerald-400",
  },
  A: {
    label: "Added",
    badge: "bg-cyan-500/15 text-cyan-400 border-cyan-500/30",
    text: "text-cyan-300",
  },
  D: {
    label: "Deleted",
    badge: "bg-rose-500/15 text-rose-400 border-rose-500/30",
    text: "text-rose-400 line-through",
  },
  R: {
    label: "Renamed",
    badge: "bg-sky-500/15 text-sky-400 border-sky-500/30",
    text: "text-sky-300",
  },
  C: {
    label: "Copied",
    badge: "bg-sky-500/15 text-sky-400 border-sky-500/30",
    text: "text-sky-300",
  },
  T: {
    label: "Type changed",
    badge: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    text: "text-amber-300",
  },
  "!": {
    label: "Conflict",
    badge: "bg-red-500/15 text-red-400 border-red-500/30",
    text: "text-red-400",
  },
};

/**
 * Row callbacks. The Sidebar keeps this object identity stable so rows stay memoized.
 * Keyboard handling lives on the tree container, not here, so there is one handler
 * for the whole list instead of one per row.
 */
export interface RowApi {
  click(event: React.MouseEvent, node: FileNode): void;
  toggle(node: FileNode): void;
  menu(x: number, y: number, node: FileNode): void;
  dragStart(event: React.DragEvent, node: FileNode): void;
  dragOver(event: React.DragEvent, node: FileNode): void;
  dragLeave(event: React.DragEvent): void;
  drop(event: React.DragEvent, node: FileNode): void;
  dragEnd(): void;
  renameChange(value: string): void;
  renameSubmit(): void;
  renameCancel(): void;
}

const INPUT_CLASS =
  "h-5 flex-1 rounded bg-[#161616] border border-indigo-500 px-1 text-[11.5px] text-white outline-none";

export const TreeRow = React.memo(function TreeRow({
  node,
  path,
  depth,
  expanded,
  selected,
  active,
  cut,
  dragging,
  dropTarget,
  status,
  folderDirty,
  renameValue,
  tabIndex,
  api,
}: {
  node: FileNode;
  /** Cleaned path; also the `data-path` the container's keyboard handler reads. */
  path: string;
  depth: number;
  expanded: boolean;
  /** Part of the current Explorer selection. */
  selected: boolean;
  /** The file open in the editor. */
  active: boolean;
  cut: boolean;
  dragging: boolean;
  dropTarget: boolean;
  /** Git porcelain letter for this exact path, if any. */
  status?: string;
  /** A collapsed folder holding changes gets a dot instead of a letter. */
  folderDirty: boolean;
  /** Set only while this row is being renamed; `undefined` keeps every other row memoized. */
  renameValue?: string;
  /** Roving tabindex: exactly one row in the tree is tabbable. */
  tabIndex: number;
  api: RowApi;
}) {
  const style = status ? badgeStyles[status] : undefined;

  return (
    <div
      role="treeitem"
      data-path={path}
      tabIndex={tabIndex}
      aria-label={node.name}
      aria-selected={selected}
      aria-expanded={node.is_dir ? expanded : undefined}
      draggable={renameValue === undefined}
      onDragStart={(event) => api.dragStart(event, node)}
      onDragOver={(event) => api.dragOver(event, node)}
      onDragLeave={api.dragLeave}
      onDrop={(event) => api.drop(event, node)}
      onDragEnd={api.dragEnd}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        api.menu(event.clientX, event.clientY, node);
      }}
      onClick={(event) => api.click(event, node)}
      style={indentStyle(depth)}
      className={`flex items-center gap-1.5 pr-2 cursor-pointer transition-colors outline-none ${
        cut ? "opacity-40" : ""
      } ${active ? "border-l-2 border-indigo-500" : ""} ${
        dragging
          ? "opacity-30 bg-zinc-900 border-dashed border border-zinc-700"
          : dropTarget
            ? "bg-indigo-600/30 ring-1 ring-indigo-400 text-white font-medium rounded-sm"
            : selected
              ? "bg-[#16162a] text-white font-medium focus:ring-1 focus:ring-indigo-500"
              : "text-zinc-300 hover:bg-[#080808] hover:text-white focus:bg-[#101018]"
      }`}
    >
      <span
        onClick={(event) => {
          if (!node.is_dir) return;
          event.stopPropagation();
          api.toggle(node);
        }}
        className="flex size-3.5 items-center justify-center shrink-0"
      >
        {node.is_dir && <ChevronIcon isExpanded={expanded} />}
      </span>

      <FileIcon name={node.name} isDir={node.is_dir} isExpanded={expanded} />

      {renameValue === undefined ? (
        <span className={`truncate text-[12px] leading-tight ${style?.text ?? "text-zinc-300"}`}>
          {node.name}
        </span>
      ) : (
        <input
          autoFocus
          type="text"
          aria-label={`Rename ${node.name}`}
          value={renameValue}
          onChange={(event) => api.renameChange(event.target.value)}
          onBlur={api.renameSubmit}
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") api.renameSubmit();
            if (event.key === "Escape") api.renameCancel();
          }}
          onClick={(event) => event.stopPropagation()}
          className={INPUT_CLASS}
        />
      )}

      {style ? (
        <span
          title={style.label}
          aria-label={`Git: ${style.label}`}
          className={`ml-auto mr-1 shrink-0 rounded px-1 text-[8.5px] font-bold font-mono border ${style.badge}`}
        >
          {status}
        </span>
      ) : folderDirty ? (
        <span
          title="Folder contains changes"
          className="ml-auto mr-1.5 size-1.5 rounded-full bg-amber-400 shrink-0"
        />
      ) : null}
    </div>
  );
});

/** The inline new-file / new-folder input, rendered in place inside the tree. */
export function CreateRow({
  depth,
  type,
  value,
  invalid,
  inputRef,
  onChange,
  onSubmit,
  onCancel,
}: {
  depth: number;
  type: "file" | "folder";
  value: string;
  invalid: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onChange(value: string): void;
  onSubmit(): void;
  onCancel(): void;
}) {
  return (
    <div style={indentStyle(depth)} className="flex items-center gap-1.5 pr-2 bg-[#0c0c10]">
      <span className="size-3.5 shrink-0" />
      <FileIcon name={type === "folder" ? "dir" : "newfile.rs"} isDir={type === "folder"} />
      <input
        ref={inputRef}
        type="text"
        value={value}
        aria-invalid={invalid || undefined}
        placeholder={`new ${type}...`}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => (invalid ? onCancel() : onSubmit())}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") onSubmit();
          if (event.key === "Escape") onCancel();
        }}
        className={INPUT_CLASS}
      />
    </div>
  );
}

/** Placeholder under an expanded folder whose children have not arrived yet. */
export function StatusRow({
  depth,
  error,
  onRetry,
}: {
  depth: number;
  error?: string;
  onRetry(): void;
}) {
  return (
    <div
      style={indentStyle(depth)}
      className="flex items-center gap-2 pr-2 text-[11.5px] text-zinc-500"
    >
      {error ? (
        <>
          <span role="alert" className="truncate text-red-400" title={error}>
            {error}
          </span>
          <button className="shrink-0 underline" onClick={onRetry}>
            Retry
          </button>
        </>
      ) : (
        "Loading…"
      )}
    </div>
  );
}
