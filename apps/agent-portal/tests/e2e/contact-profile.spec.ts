import { test, expect } from '@playwright/test';
import { AGENT_URL } from '../../../../tests/e2e-setup/urls';

/**
 * US6 (T094) — contact profile + commerce side panel.
 *
 * Verifies that:
 *   - the contacts list renders the demo contact
 *   - opening the profile shows identity + timeline placeholder + commerce panel
 *   - the commerce panel uses MockYijiClient (default) and renders the demo
 *     customer's seeded lifetime value + at least one order with payment info
 *   - export CSV downloads a file
 *
 * The agent user is seeded by Playwright globalSetup; the demo contact is
 * created by the chat widget demo (run during E2E_FULL_STACK). We also
 * exercise a graceful unavailable state by clicking a contact whose vendor
 * has no upstream Yiji data (covered by mocking — the panel shows the
 * "Commerce data unavailable" notice).
 */

const AGENT_EMAIL = process.env.E2E_AGENT_EMAIL!;
const AGENT_PASSWORD = process.env.E2E_AGENT_PASSWORD!;
const FULL_STACK = process.env.E2E_FULL_STACK === '1';
/*
 * Separate from FULL_STACK: this file has one test that asserts on fixture
 * ORDERS (`O-5921`), which only exist when the ai-gateway falls back to
 * MockYijiClient — i.e. when YIJI_API_URL is unset. Any environment configured
 * against a real commerce API serves that customer's real orders instead, and
 * the assertion is meaningless there rather than merely failing. Opt in with
 * E2E_COMMERCE=1 where the mock is known to be in use.
 */
const COMMERCE_FIXTURES = process.env.E2E_COMMERCE === '1';

async function signIn(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`${AGENT_URL}/login`);
  await page.locator('#email').fill(AGENT_EMAIL);
  await page.locator('#password').fill(AGENT_PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  // Inbox is the post-login landing
  await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
}

test.describe('US6 — contact profile + commerce panel', () => {
  test('contact list page shows demo contact and exports CSV', async ({ page }) => {
    test.skip(!FULL_STACK, 'requires E2E_FULL_STACK=1 (needs a seeded demo contact)');
    await signIn(page);
    // Navigate via the in-app Contacts link (client-side route) — a full
    // page.goto() reloads, dropping the in-memory access token and forcing a
    // cookie-restore round-trip (post-H-2) that races page render.
    await page.getByRole('link', { name: /contacts/i }).click();
    await expect(page).toHaveURL(/\/contacts$/, { timeout: 20_000 });

    await expect(page.getByRole('heading', { name: /contacts/i }).first()).toBeVisible({
      timeout: 20_000,
    });
    const card = page.getByText(/demo customer/i).first();
    await expect(card).toBeVisible({ timeout: 10_000 });

    // CSV export downloads a file
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /export csv/i }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^Sara CRM - Contacts - \d{4}-\d{2}-\d{2}\.csv$/);
  });

  test('profile shows identity + commerce panel with seeded order data', async ({ page }) => {
    test.skip(!FULL_STACK, 'requires E2E_FULL_STACK=1');
    test.skip(!COMMERCE_FIXTURES, 'requires E2E_COMMERCE=1 (asserts MockYijiClient fixtures)');
    await signIn(page);
    // Navigate via the in-app Contacts link (client-side route) rather than a
    // full page.goto() — post-H-2, a hard reload drops the in-memory access token
    // and forces a cookie-restore round-trip, which races the click below.
    await page.getByRole('link', { name: /contacts/i }).click();
    await expect(page).toHaveURL(/\/contacts$/, { timeout: 20_000 });
    await page
      .getByText(/demo customer/i)
      .first()
      .click();

    // URL navigates to /contacts/<id>
    await expect(page).toHaveURL(/\/contacts\/[0-9a-f-]+$/i, { timeout: 10_000 });

    // Identity card. The name renders in both an h1 (page title) and an h2
    // (identity card), so scope to the first to avoid a strict-mode double match.
    await expect(page.getByRole('heading', { name: /demo customer/i }).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/demo\.customer@example\.com/i)).toBeVisible({ timeout: 15_000 });

    // Commerce panel (default MockYijiClient): seeded lifetime activity + an order
    await expect(page.getByText(/lifetime activity/i)).toBeVisible();
    await expect(page.getByText('O-5921')).toBeVisible({ timeout: 10_000 });
    // Order rows render collapsed and fetch their detail on expand, so the
    // payment pill only mounts once the row is opened. Yiji's PaymentStatus
    // enum is not_paid/paid — there is no "captured" state.
    await page.getByText('O-5921').click();
    await expect(page.getByText(/paid/i).first()).toBeVisible({ timeout: 10_000 });
  });

  test('commerce panel degrades gracefully when there is no external link', async ({ page }) => {
    test.skip(!FULL_STACK, 'requires E2E_FULL_STACK=1');
    await signIn(page);

    // Hit the profile route directly with an id that has no external_customer_id
    // (the smoke approach: navigate to /contacts and pick the first non-linked
    // contact, if seed includes one — otherwise mock the response).
    await page.route('**/items/contacts/**', async (route, request) => {
      if (request.method() !== 'GET') return route.continue();
      const body = {
        data: {
          id: '00000000-0000-0000-0000-000000000001',
          name: 'Unlinked Customer',
          email: 'unlinked@example.com',
          phone: null,
          external_customer_id: null,
          metadata: null,
          date_created: '2026-06-01T00:00:00Z',
          vendor: null,
        },
      };
      // The portal (:5173) calls Directus (:8055) cross-origin with
      // `credentials: 'include'`. Credentialed CORS requires an exact-origin
      // allow header plus allow-credentials, or the browser discards the
      // response and useContact() rejects — leaving no name heading to assert.
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: {
          'access-control-allow-origin': AGENT_URL,
          'access-control-allow-credentials': 'true',
        },
        body: JSON.stringify(body),
      });
    });
    await page.goto(`${AGENT_URL}/contacts/00000000-0000-0000-0000-000000000001`);
    // A hard navigation drops the in-memory access token; the app restores it
    // from the refresh cookie and only then renders. Landing back on /login
    // means that restore lost the race, so wait it out rather than asserting
    // into a login form.
    await expect(page).not.toHaveURL(/\/login/, { timeout: 20_000 });

    await expect(page.getByRole('heading', { name: /unlinked customer/i }).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/no yiji customer linked/i)).toBeVisible();
  });
});
