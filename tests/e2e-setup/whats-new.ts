import type { Page } from '@playwright/test';

/**
 * Close the "What's new" tour if it opens after sign-in (owner, 2026-10-25).
 *
 * It opens once per user per version for the Administrator and the WeCare
 * roles, ~600ms after the shell renders, and covers the page while it is up -
 * exactly what a real user sees. A spec that signs in and then clicks the
 * nav would otherwise time out behind it, so every sign-in helper closes it
 * the way a person does (Escape). Absent (another role, already seen): a
 * short wait and nothing else.
 */
export async function dismissWhatsNew(page: Page): Promise<void> {
  const tour = page.locator('[data-whats-new]');
  try {
    await tour.waitFor({ state: 'visible', timeout: 3_000 });
  } catch {
    return;
  }
  await page.keyboard.press('Escape');
  await tour.waitFor({ state: 'hidden', timeout: 5_000 });
}
