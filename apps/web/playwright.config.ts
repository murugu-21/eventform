import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for eventform web smoke tests.
 *
 * Prerequisites before running:
 *   1. docker compose up -d --wait  (postgres, kafka, debezium server; auto-streams)
 *   2. PORT=3001 node apps/api/dist/main.js  (API)
 *   3. node apps/worker/dist/main.js         (worker)
 *   4. The web dev server is started automatically by webServer below.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: "list",
  timeout: 90_000,
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "pnpm dev",
    port: 5173,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
