import { defineConfig } from "@playwright/test";

/**
 * The packaged application with its real extension host (`tests/real`), run by
 * `scripts/e2e-real-host.mjs` -- no development server, no mocks.
 */
export default defineConfig({
  testDir: "./tests/real",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  use: { trace: "retain-on-failure" },
});
