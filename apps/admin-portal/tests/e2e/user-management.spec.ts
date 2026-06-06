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
}

test('admin signs in and sees Users management', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('heading', { name: /users/i })).toBeVisible({ timeout: 20_000 });
});

test('admin creates a team then a user assigned to it', async ({ page }) => {
  await login(page);
  const teamName = `QA Team ${Date.now()}`;

  await page.getByRole('link', { name: /teams/i }).click();
  await page.waitForURL(/\/teams/);
  // Open the create-team drawer, fill the name, submit (scoped to the dialog so
  // it doesn't collide with the toolbar opener that shares the label).
  await page
    .getByRole('button', { name: /create team/i })
    .first()
    .click();
  const teamDialog = page.getByRole('dialog');
  await teamDialog.getByLabel(/^name$/i).fill(teamName);
  await teamDialog.getByRole('button', { name: /create team/i }).click();
  await expect(page.getByText(teamName)).toBeVisible();

  await page.getByRole('link', { name: /users/i }).click();
  await page.waitForURL(/\/users/);
  const email = `agent.${Date.now()}@example.com`;
  await page
    .getByRole('button', { name: /create user/i })
    .first()
    .click();
  const userDialog = page.getByRole('dialog');
  await userDialog.getByLabel(/email/i).fill(email);
  await userDialog.getByLabel(/password/i).fill('password123');
  await userDialog.getByLabel(/role/i).selectOption({ label: 'Agent' });
  await userDialog.getByLabel(/team/i).selectOption({ label: teamName });
  await userDialog.getByRole('button', { name: /create user/i }).click();
  // Wait for the success notice, then for the row to appear in the refetched table.
  await expect(page.getByText(/user created/i)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(email)).toBeVisible({ timeout: 10_000 });
});
