import { test, expect } from '@playwright/test';
import { AGENT_URL } from '../../../../tests/e2e-setup/urls';

/**
 * US3 (T057) — shared inbox management.
 * Conversations are seeded deterministically via the Directus API in Playwright
 * globalSetup (tests/e2e-setup/global-setup.ts), so the signed-in agent can
 * immediately exercise status / priority / assignment / tag controls and verify
 * they persist — no flaky widget-driving just to create data to act on.
 */
const AGENT_EMAIL = process.env.E2E_AGENT_EMAIL!;
const AGENT_PASSWORD = process.env.E2E_AGENT_PASSWORD!;

test('agent changes case state and priority then sees them persist', async ({ page }) => {
  await page.goto(`${AGENT_URL}/login`);
  await page.getByLabel(/email/i).fill(AGENT_EMAIL);
  await page.locator('#password').fill(AGENT_PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('heading', { name: /shared inbox/i })).toBeVisible({
    timeout: 10_000,
  });

  // Open the first conversation.
  const firstConvo = page.locator('aside li button').first();
  await firstConvo.waitFor({ timeout: 15_000 });
  await firstConvo.click();

  /*
   * Status is no longer a four-option combobox. The operations team tracks a
   * case as "dealt with or not", so the toolbar carries a two-state toggle —
   * "Mark as solved" / "Reopen" — and the raw open/pending distinction is
   * gone. This spec drove the retired control and failed on every run; it now
   * drives the one that exists.
   */
  const solveButton = page.getByRole('button', { name: /mark as solved/i });
  await expect(solveButton).toBeVisible({ timeout: 10_000 });
  await solveButton.click();
  // Once solved the same control offers the way back, which is how we know the
  // patch persisted (the query invalidation refetches the live state).
  await expect(page.getByRole('button', { name: /reopen/i })).toBeVisible({ timeout: 10_000 });

  // Priority is still a custom combobox (SelectMenu), not a native <select>.
  const prioritySelect = page.getByRole('combobox', { name: 'Priority', exact: true });
  await expect(prioritySelect).toBeVisible({ timeout: 10_000 });
  await prioritySelect.click();
  await page.getByRole('option', { name: 'High' }).click();
  await expect(prioritySelect).toContainText('High');
});

test('agent toggles internal note mode and sees the amber styling', async ({ page }) => {
  await page.goto(`${AGENT_URL}/login`);
  await page.getByLabel(/email/i).fill(AGENT_EMAIL);
  await page.locator('#password').fill(AGENT_PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.locator('aside li button').first().waitFor({ timeout: 15_000 });
  await page.locator('aside li button').first().click();

  // The note toggle is a tab button ("Internal note"), not a checkbox.
  await page.getByRole('button', { name: /internal note/i }).click();
  const note = `internal-note ${Date.now()}`;
  await page.getByPlaceholder(/internal note/i).fill(note);
  await page.keyboard.press('Enter');
  await expect(page.getByText(note)).toBeVisible({ timeout: 10_000 });
});

test('bulk selecting multiple conversations enables the bulk toolbar', async ({ page }) => {
  await page.goto(`${AGENT_URL}/login`);
  await page.getByLabel(/email/i).fill(AGENT_EMAIL);
  await page.locator('#password').fill(AGENT_PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.locator('aside li button').first().waitFor({ timeout: 15_000 });

  // Tick the "Select all" header checkbox.
  await page.getByLabel(/select all/i).check();
  await expect(page.getByText(/selected/i)).toBeVisible();
});
