import assert from "node:assert/strict";
import test from "node:test";
import { parseSearch } from "./search.ts";

const match = JSON.stringify({
  type: "match",
  data: {
    path: { text: "./a.ts" },
    lines: { text: "a needle\n" },
    line_number: 1,
    submatches: [{ start: 2, end: 8 }],
  },
});
const summary = JSON.stringify({ type: "summary", data: {} });

test("search keeps partial results when some paths cannot be read", () => {
  const result = parseSearch(
    {
      stdout: `${match}\n${summary}\n`,
      stderr: "rg: locked.db: Access denied",
      code: 2,
      truncated: false,
    },
    "/work",
  );
  assert.deepEqual(result.hits, [
    { path: "/work/a.ts", line: 1, text: "a needle\n", start: 2, end: 8 },
  ]);
  assert.equal(result.truncated, true);
  assert.match(result.warning, /Access denied/);
});

test("search reports fatal errors such as an invalid regex", () => {
  assert.throws(
    () =>
      parseSearch(
        { stdout: "", stderr: "rg: regex parse error", code: 2, truncated: false },
        "/work",
      ),
    /regex parse error/,
  );
});
