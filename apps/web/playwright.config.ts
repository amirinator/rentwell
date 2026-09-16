import { defineConfig, devices } from '@playwright/test';

/**
 * Browser test configuration.
 *
 * The web servers are started by Playwright so `pnpm test:e2e` works from a
 * clean checkout with only the database, Redis and MinIO already running. The
 * worker is started too, because half of what these tests assert — an import
 * finishing, suggestions appearing — only happens when a worker is consuming.
 *
 * Retries are enabled in CI only. Locally a flake should be investigated, not
 * papered over.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // These tests share one database and reconcile the same payments, so running
  // them in parallel would have them fighting over the same records.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : [['list']],

  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: [
    {
      command: 'node ../api/dist/main.js',
      url: 'http://localhost:4000/healthz',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'node ../worker/dist/main.js',
      // No `url`. The worker exposes no HTTP port, and pointing this entry at
      // the API's /healthz made it unusable: Playwright starts these entries in
      // order, so by the time it reached this one the API was already serving
      // that URL. It then treated the worker as "already running" and skipped
      // the command entirely with reuseExistingServer:true, or — in CI, where
      // that flag is false — failed the run with "is already used".
      //
      // With no url Playwright launches the process and moves on without
      // polling, which is what a port-less process needs; it is still torn down
      // with the rest. Readiness is not waited on, so the tests that depend on
      // the worker poll the UI for its effects.
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'pnpm vite --port 5173 --strictPort',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
