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
  /**
   * ONE worker, sequential specs — deliberately not parallel.
   *
   * Every spec drives the SAME seeded shared inbox: "mark the first
   * conversation solved", "type a note into the first conversation", "the
   * widget's message appears first in the list". Run in parallel they mutate
   * each other's fixtures mid-assertion — a note lands in a conversation
   * another worker just solved out of the default filter — and the failures
   * look like product bugs. Serial costs ~1 minute; chasing phantom failures
   * cost afternoons.
   */
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Per-test cap (default is 30s but make it explicit) and a hard ceiling on
  // the whole run so a stuck spec/setup can't hang CI for hours.
  timeout: 30_000,
  expect: { timeout: 10_000 },
  globalTimeout: 12 * 60_000,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8090',
    trace: 'on-first-retry',
    /*
     * Run every spec as a reduced-motion user.
     *
     * The portals cascade cards, rings and bars in on mount. Playwright waits
     * for an element to be "stable" — unmoving between two animation frames —
     * before it will click, so an entrance animation makes the click retry
     * until the test times out. That is not a flake to chase per-spec: every
     * animated surface can produce it, and it lands hardest on a loaded CI
     * runner where the animations take longest.
     *
     * The app already honours prefers-reduced-motion everywhere (motion-safe:
     * on every animated class), so this switches all of it off at once and
     * tests the same DOM without the moving parts.
     */
    reducedMotion: 'reduce',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
