/**
 * Presenting a commit's author.
 *
 * Yavin fetches no images anywhere, and a hover card is the last place to start: resting the
 * pointer on a graph would fire a request to a third party for every commit passed over, and
 * leak which repository is being read. The avatar is drawn from initials instead.
 */

/** The author's initials, for the avatar circle. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const letters = parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[1][0];
  return letters.toUpperCase();
}

/** The local part of the email address, shown beside the name as a handle. */
export function handleFor(email: string): string {
  const trimmed = email.trim();
  if (!trimmed) return "";
  const at = trimmed.indexOf("@");
  return at > 0 ? `@${trimmed.slice(0, at)}` : `@${trimmed}`;
}
