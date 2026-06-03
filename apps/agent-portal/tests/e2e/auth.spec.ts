import { test, expect } from '@playwright/test';

/**
 * US1 (T025) — agent login + role-scoped inbox access.
 * The agent user is seeded by Playwright globalSetup (no env required).
 */
const AGENT_EMAIL = process.env.E2E_AGENT_EMAIL!;
const AGENT_PASSWORD = process.env.E2E_AGENT_PASSWORD!;

test('unauthenticated visitor is redirected to login', async ({ page }) => {
  await page.goto('http://localhost:5173/');
  await expect(page.getByRole('heading')).toContainText(/sign in/i);
});

test('agent signs in and reaches the inbox', async ({ page }) => {
  await page.goto('http://localhost:5173/login');
  await page.getByLabel(/email/i).fill(AGENT_EMAIL);
  await page.getByLabel(/password/i).fill(AGENT_PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('heading', { name: /inbox/i })).toBeVisible({ timeout: 20_000 });
});
