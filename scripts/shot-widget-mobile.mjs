// Capture the chat-widget demo at iPhone 14 + iPad + desktop viewports
// to verify mobile responsiveness + the identity card.
// Run: node scripts/shot-widget-mobile.mjs

import { chromium, devices } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, '.critique-shots');
await mkdir(outDir, { recursive: true });

const URL = 'http://localhost:5175/';

const profiles = [
  { name: 'widget-mobile-iphone-14', device: devices['iPhone 14'] },
  { name: 'widget-mobile-iphone-14-open', device: devices['iPhone 14'], open: true },
  { name: 'widget-tablet-ipad', device: devices['iPad (gen 11)'] },
  { name: 'widget-desktop', device: null, viewport: { width: 1440, height: 900 } },
];

const browser = await chromium.launch();
for (const p of profiles) {
  const ctx = await browser.newContext(
    p.device ?? { viewport: p.viewport },
  );
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  if (p.open) {
    try {
      await page.locator('.yiji-launcher').first().click({ timeout: 4000 });
      await page.waitForTimeout(700);
    } catch (e) {
      console.warn('skip open:', e.message);
    }
  }
  await page.screenshot({ path: resolve(outDir, `${p.name}.png`), fullPage: false });
  console.log(`✓ ${p.name}.png`);
  await ctx.close();
}
await browser.close();
console.log('done');
