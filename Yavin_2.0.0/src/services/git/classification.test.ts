import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * Ties `Repository`'s Git usage to the Rust allow-list and lock scopes mechanically, so a new
 * Repository method that runs a subcommand nobody classified fails here instead of being
 * discovered at runtime as "not permitted" (or, worse, silently getting the default scope).
 *
 * Both sides are read as source text: `repository.ts` for every subcommand it can issue,
 * `src-tauri/src/git.rs` for `rules_for` (what may run at all) and `operation_scope` (which
 * lock it takes). The table below is the one thing written by hand; the tests compare it to
 * both sides.
 */

const repositorySource = readFileSync(new URL("./repository.ts", import.meta.url), "utf8");
const rustSource = readFileSync(new URL("../../../src-tauri/src/git.rs", import.meta.url), "utf8");

type Scope = "read" | "local" | "network" | "stash";

/** Every subcommand `Repository` issues, and the lock scope it must take. */
const CLASSIFIED: Record<string, Scope> = {
  status: "read",
  "rev-parse": "read",
  "cat-file": "read",
  diff: "read",
  show: "read",
  log: "read",
  "for-each-ref": "read",
  "check-ref-format": "read",
  "symbolic-ref": "local", // reads HEAD but is not in the Rust read list; takes the local lock
  add: "local",
  restore: "local",
  rm: "local",
  commit: "local",
  switch: "local",
  branch: "local",
  apply: "local",
  tag: "local",
  rebase: "local",
  merge: "local",
  "cherry-pick": "local",
  revert: "local",
  remote: "read", // only the bare listing; any verb is not read (see `operation_scope`)
  worktree: "read", // only `worktree list`
  fetch: "network",
  pull: "network",
  push: "network",
  stash: "stash", // push/apply/pop/drop; `stash list` is a read (see `operation_scope`)
};

/** Subcommands whose scope depends on a following verb, so the Rust match is conditional. */
const CONDITIONAL = new Set(["remote", "worktree", "stash"]);

function subcommandsUsedByRepository(): Set<string> {
  const used = new Set<string>();
  const patterns = [
    /\b(?:run|ok|runWithInput)\(\s*\[\s*"([a-z][a-z-]*)"/g,
    /\bgitExec\(\s*this\.repoId,\s*\[\s*"([a-z][a-z-]*)"/g,
    /\bargs\s*=\s*\[\s*"([a-z][a-z-]*)"/g,
  ];
  for (const pattern of patterns)
    for (const match of repositorySource.matchAll(pattern)) used.add(match[1]);
  // `abortOrContinue`/`skip` build `[op, flag]` where `op` is whatever operation is in progress.
  if (/\brun\(\s*\[\s*op\s*,/.test(repositorySource))
    for (const op of ["merge", "rebase", "cherry-pick", "revert"]) used.add(op);
  return used;
}

function rustFunctionBody(name: string): string {
  const start = rustSource.indexOf(`fn ${name}(`);
  assert.notEqual(start, -1, `git.rs has no fn ${name}`);
  const end = rustSource.indexOf("\n}\n", start);
  return rustSource.slice(start, end);
}

function allowListedSubcommands(): Set<string> {
  const body = rustFunctionBody("rules_for");
  return new Set([...body.matchAll(/^\s*"([a-z][a-z-]*)"\s*=>/gm)].map((m) => m[1]));
}

/** Names on the `=> Scope::<scope>` arms of `operation_scope` that are unconditional. */
function scopeArm(scope: "Read" | "Network"): Set<string> {
  const body = rustFunctionBody("operation_scope");
  const arm = new RegExp(`((?:\\s*\\|?\\s*"[a-z][a-z-]*")+)\\s*=>\\s*Scope::${scope}`, "g");
  const names = new Set<string>();
  for (const match of body.matchAll(arm))
    for (const name of match[1].matchAll(/"([a-z][a-z-]*)"/g)) names.add(name[1]);
  return names;
}

test("every Git subcommand Repository issues is in the hand-written classification", () => {
  const used = subcommandsUsedByRepository();
  const unclassified = [...used].filter((s) => !(s in CLASSIFIED));
  assert.deepEqual(
    unclassified,
    [],
    "a Repository method uses a subcommand with no entry in CLASSIFIED: decide its lock scope",
  );
  const unused = Object.keys(CLASSIFIED).filter((s) => !used.has(s));
  assert.deepEqual(unused, [], "CLASSIFIED lists a subcommand Repository no longer issues");
});

test("every subcommand Repository issues is allowed by the Rust allow-list, and nothing else is", () => {
  const used = subcommandsUsedByRepository();
  const allowed = allowListedSubcommands();
  assert.deepEqual(
    [...used].filter((s) => !allowed.has(s)).sort(),
    [],
    "Repository issues a subcommand `rules_for` would refuse",
  );
  assert.deepEqual(
    [...allowed].filter((s) => !used.has(s)).sort(),
    [],
    "`rules_for` allows a subcommand Repository never issues (least privilege)",
  );
});

test("the classification matches Rust's operation_scope for every subcommand", () => {
  const reads = scopeArm("Read");
  const network = scopeArm("Network");
  for (const [subcommand, scope] of Object.entries(CLASSIFIED)) {
    if (CONDITIONAL.has(subcommand)) continue; // covered by the explicit checks below
    assert.equal(reads.has(subcommand), scope === "read", `${subcommand}: read-scope mismatch`);
    assert.equal(
      network.has(subcommand),
      scope === "network",
      `${subcommand}: network-scope mismatch`,
    );
  }
  // The conditional ones: their read form is recognised by verb, their other verbs are not reads.
  const body = rustFunctionBody("operation_scope");
  assert.match(body, /"remote"\s+if\s+rest\.is_empty\(\)\s*=>\s*Scope::Read/);
  assert.match(body, /"worktree"\s+if\s+rest\.first\(\)[^>]*"list"[^>]*=>\s*Scope::Read/);
  assert.match(body, /"stash"\s*=>/);
});
