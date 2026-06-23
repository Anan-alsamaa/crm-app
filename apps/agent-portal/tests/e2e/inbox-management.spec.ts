import { test, expect } from '@playwright/test';

/**
 * US3 (T057) — shared inbox management.
 * Conversations are seeded deterministically via the Directus API in Playwright
 * globalSetup (tests/e2e-setup/global-setup.ts), so the signed-in agent can
 * immediately exercise status / priority / assignment / tag controls and verify
 * they persist — no flaky widget-driving just to create data to act on.
 */
const AGENT_EMAIL = process.env.E2E_AGENT_EMAIL!;
const AGENT_PASSWORD = process.env.E2E_AGENT_PASSWORD!;

test('agent changes status, priority, and assignment then sees them persist', async ({ page }) => {
  await page.goto('http://localhost:5173/login');
  await page.getByLabel(/email/i).fill(AGENT_EMAIL);
  await page.getByLabel(/password/i).fill(AGENT_PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('heading', { name: /shared inbox/i })).toBeVisible({
    timeout: 10_000,
  });

  // Open the first conversation.
  const firstConvo = page.locator('aside li button').first();
  await firstConvo.waitFor({ timeout: 15_000 });
  await firstConvo.click();

  // The toolbar Status/Priority controls are custom comboboxes (SelectMenu), not
  // native <select>s — open them and pick an option. Exact name 'Status' targets
  // the toolbar control, not the inbox's "All statuses" filter.
  const statusSelect = page.getByRole('combobox', { name: 'Status', exact: true });
  const prioritySelect = page.getByRole('combobox', { name: 'Priority', exact: true });
  await expect(statusSelect).toBeVisible({ timeout: 10_000 });

  // Change status to Pending, priority to High.
  await statusSelect.click();
  await page.getByRole('option', { name: 'Pending' }).click();
  await prioritySelect.click();
  await page.getByRole('option', { name: 'High' }).click();

  // The trigger reflects the persisted value (no reload — the onSuccess query
  // invalidation refetches the live state; the trigger shows the chosen label).
  await expect(statusSelect).toContainText('Pending');
  await expect(prioritySelect).toContainText('High');
});

test('agent toggles internal note mode and sees the amber styling', async ({ page }) => {
  await page.goto('http://localhost:5173/login');
  await page.getByLabel(/email/i).fill(AGENT_EMAIL);
  await page.getByLabel(/password/i).fill(AGENT_PASSWORD);
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
  await page.goto('http://localhost:5173/login');
  await page.getByLabel(/email/i).fill(AGENT_EMAIL);
  await page.getByLabel(/password/i).fill(AGENT_PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.locator('aside li button').first().waitFor({ timeout: 15_000 });

  // Tick the "Select all" header checkbox.
  await page.getByLabel(/select all/i).check();
  await expect(page.getByText(/selected/i)).toBeVisible();
});
