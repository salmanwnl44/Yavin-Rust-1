import { useEffect, useState } from "react";
import type { Repository } from "../../services/git/repository";
import type { CommitDetailedInfo, RawCommit } from "../../services/git/parsers/log";
import { parseCommitDetails } from "../../services/git/parsers/log";
import { defaultRemoteWebLink, openExternalUrl } from "../../services/git/remoteUrl";
import { handleFor, initials } from "../../services/git/author";
import { clampToViewport } from "../../services/panel/menuPosition";
import { CopyIcon, ExternalLinkIcon } from "../ui/Icons";

/** How long the pointer must rest on a row before the card appears. */
export const HOVER_DELAY = 450;
/** Its width, which the placement needs before the card exists. */
export const CARD_WIDTH = 340;

interface CardData {
  body: string;
  detail: CommitDetailedInfo | null;
  remote: { url: string; label: string } | null;
}

/**
 * What has already been fetched, keyed by commit.
 *
 * A hover card that ran three Git processes every time the pointer crossed a row would make
 * scrolling the graph cost more than reading it. A commit's own details never change, so
 * they are worth keeping; the map is bounded because a long scroll would otherwise remember
 * every commit it passed.
 */
const cache = new Map<string, Promise<CardData>>();
const CACHE_LIMIT = 100;

function load(repository: Repository, fullHash: string): Promise<CardData> {
  const known = cache.get(fullHash);
  if (known) return known;
  const pending = Promise.all([
    repository.commitDetails(fullHash).catch(() => ""),
    repository.commitBody(fullHash).catch(() => ""),
    defaultRemoteWebLink(repository).catch(() => null),
  ]).then(([details, fullBody, remote]) => {
    // Everything after the first blank line: `%s` collapses whitespace, so the subject's
    // length cannot be used to slice the raw `%B`.
    const blankLine = fullBody.search(/\n\s*\n/);
    return {
      body: blankLine === -1 ? "" : fullBody.slice(blankLine).trim(),
      detail: details ? parseCommitDetails(details) : null,
      remote,
    };
  });
  cache.set(fullHash, pending);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return pending;
}

/** Test seam: forgets what has been fetched. */
export function resetHoverCardCache(): void {
  cache.clear();
}

/**
 * The card shown when the pointer rests on a commit in either graph.
 *
 * It answers "what is this commit" without opening it: who, when, the whole message rather
 * than the truncated subject, how much it touched, where its refs are, and a way out to the
 * hosting site. Everything here is read-only except the two buttons, and it closes on
 * Escape, so it never traps anyone who reaches it.
 */
export function CommitHoverCard({
  commit,
  repository,
  anchor,
  onClose,
  onPointerEnter,
  onPointerLeave,
}: {
  commit: RawCommit;
  repository: Repository;
  /** Where the row is on screen; the card is placed beside it and kept on screen. */
  anchor: { x: number; y: number };
  onClose: () => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}) {
  const [data, setData] = useState<CardData | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    load(repository, commit.fullHash).then(
      (loaded) => !cancelled && setData(loaded),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [repository, commit.fullHash]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Roughly how tall the card gets with a body and a file count, in rows of ~22px.
  const placed = clampToViewport(anchor, 14, undefined, { width: CARD_WIDTH, rowHeight: 22 });

  return (
    <aside
      role="dialog"
      aria-label={`Commit ${commit.hash}`}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
      style={placed}
      className="fixed z-50 w-[340px] rounded-lg border border-border bg-surface p-3 text-[11.5px] shadow-xl"
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent/20 text-[10px] font-semibold text-accent"
        >
          {initials(commit.authorName)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-ink">{commit.authorName}</span>
          <span className="block truncate text-[10.5px] text-ink-3">
            {handleFor(commit.authorEmail)}
          </span>
        </span>
      </div>

      <p className="mt-2 font-semibold text-ink">{commit.subject}</p>
      <p className="text-[10.5px] text-ink-3">
        {commit.relativeTime} · {commit.date}
      </p>

      {data?.body && (
        <p className="mt-1.5 max-h-28 overflow-y-auto whitespace-pre-wrap text-ink-2">
          {data.body}
        </p>
      )}

      {data?.detail && (
        <p className="mt-1.5 text-ink-3">
          {data.detail.filesChanged} file{data.detail.filesChanged === 1 ? "" : "s"} changed
          {data.detail.insertions > 0 && (
            <span className="text-green"> +{data.detail.insertions}</span>
          )}
          {data.detail.deletions > 0 && <span className="text-red"> −{data.detail.deletions}</span>}
        </p>
      )}

      {commit.refs.length > 0 && (
        <ul className="mt-1.5 flex flex-wrap gap-1">
          {commit.refs.map((ref) => (
            <li
              key={`${ref.kind}:${ref.name}`}
              className={`rounded px-1.5 py-0.5 text-[10px] ${
                ref.kind === "tag"
                  ? "bg-yellow/15 text-yellow"
                  : ref.kind === "remote"
                    ? "bg-orange/15 text-orange"
                    : "bg-accent/15 text-accent"
              }`}
            >
              {ref.name}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 flex items-center gap-1.5 border-t border-border pt-1.5 text-ink-3">
        <span className="font-mono text-[10.5px]">{commit.hash}</span>
        <button
          title="Copy the full commit hash"
          aria-label="Copy commit hash"
          onClick={() =>
            navigator.clipboard.writeText(commit.fullHash).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              },
              () => setError("Could not copy the hash to the clipboard."),
            )
          }
          className="rounded p-0.5 hover:bg-surface-hover hover:text-ink"
        >
          <CopyIcon size={10} />
        </button>
        {copied && <span className="text-green">Copied</span>}
        {data?.remote && (
          <button
            title={`Open this commit on ${data.remote.label}`}
            onClick={() => void openExternalUrl(`${data.remote!.url}/commit/${commit.fullHash}`)}
            className="ml-auto flex items-center gap-1 text-accent hover:text-accent-hover"
          >
            <ExternalLinkIcon size={9} />
            Open on {data.remote.label}
          </button>
        )}
      </div>
      {error && <p className="text-red">{error}</p>}
    </aside>
  );
}
