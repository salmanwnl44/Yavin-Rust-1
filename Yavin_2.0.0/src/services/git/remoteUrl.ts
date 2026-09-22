import { native } from "../native.ts";
import type { Repository } from "./repository.ts";

/** The web host a remote URL points at, and its display name for "Open on {label}". */
export interface RemoteWebLink {
  url: string;
  label: string;
}

const HOST_LABELS: Record<string, string> = {
  "github.com": "GitHub",
  "gitlab.com": "GitLab",
  "bitbucket.org": "Bitbucket",
};

/**
 * Converts a Git remote URL to the web page for that repository, or `null` when the URL
 * isn't one of the forms Git itself produces (so nothing is ever guessed at). Handles the
 * three shapes `git remote -v` actually reports:
 * - `https://host/owner/repo.git` (and without the `.git` suffix, and with basic-auth
 *   userinfo, which is stripped rather than carried into a browser URL);
 * - `git@host:owner/repo.git` (the scp-like SSH shorthand);
 * - `ssh://git@host[:port]/owner/repo.git`.
 * A host this app doesn't recognize still gets a generic label ("Open on host.example"),
 * since plenty of real remotes are self-hosted Git forges.
 */
export function remoteUrlToWeb(remoteUrl: string): RemoteWebLink | null {
  const url = remoteUrl.trim();
  // `ext::`/`fd::` remote helpers are never a web page; reject before the scp-like
  // shorthand's single-colon split could otherwise misparse one as a "host".
  if (!url || url.includes("::")) return null;
  let host: string;
  let path: string;

  const scpLike = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(url);
  const asUrl = (() => {
    try {
      return new URL(url);
    } catch {
      return null;
    }
  })();

  if (asUrl && (asUrl.protocol === "https:" || asUrl.protocol === "http:")) {
    host = asUrl.hostname;
    path = asUrl.pathname;
  } else if (asUrl && asUrl.protocol === "ssh:") {
    host = asUrl.hostname;
    path = asUrl.pathname;
  } else if (scpLike && !url.includes("://")) {
    // git@host:owner/repo.git -- not a URL by any parser's definition, Git's own shorthand.
    host = scpLike[1];
    path = "/" + scpLike[2];
  } else {
    return null;
  }

  path = path.replace(/\.git$/, "").replace(/^\/+/, "");
  if (!host || !path) return null;

  return { url: `https://${host}/${path}`, label: HOST_LABELS[host.toLowerCase()] ?? host };
}

/** Opens `link.url` (already converted by `remoteUrlToWeb`) in the OS's default browser. */
export function openExternalUrl(url: string): Promise<void> {
  return native("git_open_external_url", { url });
}

/**
 * The commit detail panel's "Open on GitHub"/etc: `origin` if the repository has one, else
 * its first remote, converted to a web link -- `null` when there is no remote, or its URL
 * isn't a form `remoteUrlToWeb` recognizes.
 */
export async function defaultRemoteWebLink(repository: Repository): Promise<RemoteWebLink | null> {
  const remotes = await repository.remotes();
  const preferred = remotes.includes("origin") ? "origin" : remotes[0];
  if (!preferred) return null;
  const url = await repository.remoteUrl(preferred).catch(() => "");
  return url ? remoteUrlToWeb(url) : null;
}
