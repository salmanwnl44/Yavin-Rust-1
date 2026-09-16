export interface Branch {
  name: string;
  upstream: string;
  ahead: number;
  behind: number;
}

export function parseBranch(output: string): Branch {
  const field = (name: string) =>
    output
      .split("\n")
      .find((l) => l.startsWith(`# branch.${name} `))
      ?.slice(name.length + 10) ?? "";
  const ab = field("ab").match(/\+(\d+) -(\d+)/);
  return {
    name: field("head"),
    upstream: field("upstream"),
    ahead: Number(ab?.[1] ?? 0),
    behind: Number(ab?.[2] ?? 0),
  };
}

/**
 * How the branch stands against its upstream. `diverged` is the case that needs a
 * decision from the user: a fast-forward pull cannot resolve it.
 */
export function divergence(
  branch: Branch,
): "unpublished" | "synced" | "ahead" | "behind" | "diverged" {
  if (!branch.upstream) return "unpublished";
  if (branch.ahead && branch.behind) return "diverged";
  if (branch.ahead) return "ahead";
  if (branch.behind) return "behind";
  return "synced";
}
