import { defineConfig, devices } from '@playwright/test';

/**
 * A SEPARATE config for driving the LIVE portals, deliberately not the root one.
 *
 * The root `playwright.config.ts` runs `tests/e2e-setup/global-setup.ts`, which
 * seeds a Directus and — critically — PATCHes `E2E_AGENT_PASSWORD` onto a user
 * on every run. Pointed at production that would rotate a real person's
 * credential as a side effect of running a test. So this config has NO
 * globalSetup and no webServer: it assumes the portals are already up, because
 * they are.
 *
 * Everything under `tests/prod-ui/` must stay READ-ONLY. These specs sign in as
 * real accounts against real data, so they look and assert and nothing else: no
 * saves, no deletes, no messages sent, no tickets raised. Anyone extending them
 * inherits that constraint — a browser test that writes to production is not a
 * test, it is an incident with a report attached.
 */
export default defineConfig({
  testDir: './tests/prod-ui',
  testMatch: ['**/*.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: 'list',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Same reasoning as the root config: entrance animations make Playwright
    // wait for stability that never comes, and the app honours this everywhere.
    reducedMotion: 'reduce',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
