/**
 * Inline Git blame (WS9) — the pure parser, the current-line lookup, the annotation text, and the
 * token-keyed cache with correct invalidation. Deterministic fixtures; no process or native access.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  blameAt,
  blameToken,
  createBlameCache,
  describeBlameLine,
  parseBlamePorcelain,
  relativeTime,
  type BlameLine,
} from "./blame.ts";

const SHA1 = "a".repeat(40);
const SHA2 = "b".repeat(40);
const ZERO = "0".repeat(40);

const PORCELAIN = [
  `${SHA1} 1 1 2`,
  "author Alice",
  "author-mail <alice@example.com>",
  "author-time 1700000000",
  "author-tz +0000",
  "committer Alice",
  "summary first commit",
  "filename a.txt",
  "\tline one",
  `${SHA1} 2 2`, // same commit, metadata already seen (cached)
  "\tline two",
  `${SHA2} 3 3 1`,
  "author Bob",
  "author-mail <bob@example.com>",
  "author-time 1700100000",
  "summary second commit",
  "filename a.txt",
  "\tline three",
  `${ZERO} 4 4 1`,
  "author Not Committed Yet",
  "author-mail <not.committed.yet>",
  "author-time 1700200000",
  "summary Version of a.txt",
  "filename a.txt",
  "\tline four",
].join("\n");

test("parseBlamePorcelain maps each line to its commit, caching metadata across groups", () => {
  const lines = parseBlamePorcelain(PORCELAIN);
  assert.deepEqual(
    lines.map((l) => [l.line, l.sha, l.author, l.summary, l.uncommitted]),
    [
      [1, SHA1, "Alice", "first commit", false],
      [2, SHA1, "Alice", "first commit", false], // metadata reused from the first group
      [3, SHA2, "Bob", "second commit", false],
      [4, ZERO, "Not Committed Yet", "Version of a.txt", true],
    ],
  );
  assert.equal(lines[0]!.authorMail, "alice@example.com", "mail stripped of <>");
  assert.equal(lines[0]!.authorTime, 1700000000);
  assert.deepEqual(parseBlamePorcelain(""), [], "empty output → no lines");
});

test("blameAt finds the current line (fast index path and fallback)", () => {
  const lines = parseBlamePorcelain(PORCELAIN);
  assert.equal(blameAt(lines, 3)?.author, "Bob");
  assert.equal(blameAt(lines, 99), undefined);
  // Fallback when lines are not 1..n contiguous (e.g. a sparse list).
  const sparse: BlameLine[] = [
    {
      line: 10,
      sha: SHA1,
      author: "Al",
      authorMail: "",
      authorTime: 0,
      summary: "s",
      uncommitted: false,
    },
  ];
  assert.equal(blameAt(sparse, 10)?.author, "Al");
});

test("describeBlameLine renders author · when · summary, and the uncommitted case", () => {
  const now = 1700000000000 + 3 * 86_400 * 1000; // 3 days after SHA1's author time
  const [first] = parseBlamePorcelain(PORCELAIN);
  assert.equal(describeBlameLine(first, now), "Alice, 3 days ago • first commit");
  const uncommitted = parseBlamePorcelain(PORCELAIN).at(-1)!;
  assert.equal(describeBlameLine(uncommitted, now), "You · Uncommitted changes");
  assert.equal(describeBlameLine(undefined, now), "You · Uncommitted changes");
});

test("relativeTime buckets into the largest sensible unit", () => {
  const now = 2_000_000_000_000;
  assert.equal(relativeTime(now, now), "just now");
  assert.equal(relativeTime(now - 90_000_000, now), "1 day ago");
  assert.equal(relativeTime(now - 5 * 3600_000, now), "5 hours ago");
  assert.equal(relativeTime(now - 2 * 2_592_000_000, now), "2 months ago");
});

test("the cache fetches once per token and reuses it across cursor moves", async () => {
  let fetches = 0;
  const cache = createBlameCache(async (path) => {
    fetches++;
    return `${SHA1} 1 1 1\nauthor A\nauthor-time 1\nsummary s\n\t${path}`;
  });
  const token = blameToken(1, 1);
  await cache.get("a.txt", token);
  await cache.get("a.txt", token); // a cursor move — same token
  await cache.get("a.txt", token);
  assert.equal(fetches, 1, "one Git call for many look-ups at the same revision/version");

  // A new token (a commit, HEAD move, save or edit) refetches.
  await cache.get("a.txt", blameToken(2, 1));
  assert.equal(fetches, 2);
});

test("a failed blame is not cached — the next look-up retries", async () => {
  let attempt = 0;
  const cache = createBlameCache(async () => {
    attempt++;
    if (attempt === 1) throw new Error("git failed");
    return `${SHA1} 1 1 1\nauthor A\nauthor-time 1\nsummary s\n\tx`;
  });
  await assert.rejects(cache.get("a.txt", blameToken(1, 1)));
  const lines = await cache.get("a.txt", blameToken(1, 1)); // same token, but the failure wasn't kept
  assert.equal(lines[0]!.author, "A");
  assert.equal(attempt, 2);
});

test("the cache is bounded (LRU eviction) so a long session cannot grow it without limit", async () => {
  const cache = createBlameCache(
    async () => `${SHA1} 1 1 1\nauthor A\nauthor-time 1\nsummary s\n\tx`,
    {
      max: 2,
    },
  );
  await cache.get("a", blameToken(1, 1));
  await cache.get("b", blameToken(1, 1));
  await cache.get("c", blameToken(1, 1)); // evicts "a"
  assert.equal(cache.size(), 2);
  cache.invalidate();
  assert.equal(cache.size(), 0);
});
