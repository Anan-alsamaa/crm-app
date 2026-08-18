/** The admin nav in both languages — proves the labels and the swap. */
import { chromium } from '@playwright/test';
const PORTAL = process.env.ADMIN_PORTAL ?? 'http://localhost:8092';
const browser = await chromium.launch();
for (const loc of ['en', 'ar']) {
  const page = await browser.newPage({ locale: loc });
  await page.goto(`${PORTAL}/login`, { waitUntil: 'networkidle' });
  await page.locator('#email').fill(process.env.DIRECTUS_ADMIN_EMAIL ?? 'e.habibi@anan.sa');
  await page.locator('#password').fill(process.env.DIRECTUS_ADMIN_PASSWORD ?? '123456');
  await page.getByRole('button', { name: /sign in|دخول|تسجيل/i }).first().click();
  await page.waitForURL((u) => !u.pathname.includes('login'), { timeout: 20000 });
  await page.waitForTimeout(1500);
  // The nav groups sit behind triggers, so open every one before reading it.
  for (const b of await page.getByRole('button').all()) {
    await b.click({ timeout: 1200 }).catch(() => {});
  }
  await page.waitForTimeout(600);
  const links = await page.evaluate(() =>
    [...document.querySelectorAll('a[href]')]
      .filter((a) => /compensation|coupon|report/.test(a.getAttribute('href') ?? ''))
      .map((a) => `${a.getAttribute('href')}  ->  ${(a.textContent ?? '').trim()}`),
  );
  console.log(`\n== ${loc} ==`);
  for (const l of [...new Set(links)]) console.log('  ', l);
  await page.close();
}
await browser.close();
