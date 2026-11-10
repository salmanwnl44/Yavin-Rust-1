import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/ui",
  fullyParallel: false,
  workers: 1,
  // On CI the single-worker UI suite shares one busy Windows runner; a few tests (terminal
  // grammar render, menu-open) occasionally exceed their timeout under load. Retry on CI only --
  // a deterministic failure still fails all attempts, so this rescues flakes, not real breaks.
  retries: process.env.CI ? 2 : 0,
  // The development server hands Monaco over as hundreds of separate modules, so the first
  // editor in a fresh browser can take several seconds to load on a busy machine.
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://127.0.0.1:1420",
    channel:
      process.env.PLAYWRIGHT_CHANNEL || (process.platform === "win32" ? "msedge" : undefined),
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: false,
  },
});
