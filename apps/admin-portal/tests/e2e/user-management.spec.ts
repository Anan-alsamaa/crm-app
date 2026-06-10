import { test, expect } from '@playwright/test';

/**
 * US1 — admin login + create team + create user (T026).
 * Requires the admin portal dev server (http://localhost:5174) and Directus.
 * Uses the project-owner admin creds by default (override via env).
 */
const BASE = process.env.E2E_ADMIN_URL ?? 'http://localhost:5174';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'e.habibi@anan.sa';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '123456';

async function login(page: import('@playwright/test').Page) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel(/email/i).fill(ADMIN_EMAIL);
  await page.getByLabel(/password/i).fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  // Wait for the post-login landing — the admin lands on the Dashboard
  // ("Overview" heading) — so callers can click nav links immediately without
  // racing the auth redirect / first paint.
  await expect(page.getByRole('heading', { name: /overview/i })).toBeVisible({ timeout: 20_000 });
}

test('admin signs in and reaches Users management', async ({ page }) => {
  await login(page);
  // Admin lands on the Dashboard; navigate to Users management.
  await page.getByRole('link', { name: /users/i }).click();
  await page.waitForURL(/\/users/);
  await expect(page.getByRole('heading', { name: /users/i })).toBeVisible({ timeout: 20_000 });
});

test('admin creates a team then a user assigned to it', async ({ page }) => {
  await login(page);
  const teamName = `QA Team ${Date.now()}`;

  await page.getByRole('link', { name: /teams/i }).click();
  await page.waitForURL(/\/teams/);
  // Create-team is a Drawer (role="dialog"); the toolbar/empty-state CTA opens
  // it. Scope the form + submit to the drawer (the trigger shares its label).
  await page
    .getByRole('button', { name: /create team/i })
    .first()
    .click();
  const teamDrawer = page.getByRole('dialog');
  // FormField doesn't wire label→input, so target RHF fields by name attribute.
  await teamDrawer.locator('input[name="name"]').fill(teamName);
  await teamDrawer.getByRole('button', { name: /create team/i }).click();
  await expect(page.getByText(teamName)).toBeVisible();

  await page.getByRole('link', { name: /users/i }).click();
  await page.waitForURL(/\/users/);
  const email = `agent.${Date.now()}@example.com`;
  await page
    .getByRole('button', { name: /create user/i })
    .first()
    .click();
  const userDrawer = page.getByRole('dialog');
  await userDrawer.locator('input[name="email"]').fill(email);
  await userDrawer.locator('input[name="password"]').fill('password123');
  await userDrawer.locator('select[name="role"]').selectOption({ label: 'Agent' });
  await userDrawer.locator('select[name="team"]').selectOption({ label: teamName });
  await userDrawer.getByRole('button', { name: /create user/i }).click();
  // Wait for the success notice, then for the row to appear in the refetched table.
  await expect(page.getByText(/user created/i)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(email)).toBeVisible({ timeout: 10_000 });
});
