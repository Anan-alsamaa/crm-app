import { defineConfig, devices } from '@playwright/test';

/**
 * Root Playwright config for E2E across agent-portal, admin-portal, and the
 * chat-widget demo page. Test specs live under each app's tests/e2e/.
 * Web servers are started per-project as those apps come online (Phase 3+).
 */
export default defineConfig({
  testDir: '.',
  testMatch: ['apps/**/tests/e2e/**/*.spec.ts'],
  globalSetup: './tests/e2e-setup/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Per-test cap (default is 30s but make it explicit) and a hard ceiling on
  // the whole run so a stuck spec/setup can't hang CI for hours.
  timeout: 30_000,
  expect: { timeout: 10_000 },
  globalTimeout: 12 * 60_000,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
