// Capture the widget in its agent-offline state.
// Assumes no agent socket is connected to the gateway (no agent-portal session).
//
// Run: node scripts/shot-widget-offline.mjs

import { chromium, devices } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, '.critique-shots');
await mkdir(outDir, { recursive: true });

const URL = 'http://localhost:5175/';
const browser = await chromium.launch();

for (const [name, ctxOpts] of [
  ['widget-offline-iphone-14', { ...devices['iPhone 14'] }],
  ['widget-offline-desktop', { viewport: { width: 1440, height: 900 } }],
]) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  // Give the gateway a moment to send agents:presence after socket connect.
  await page.waitForTimeout(1500);
  await page.locator('.yiji-launcher').first().click({ timeout: 4000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: resolve(outDir, `${name}.png`), fullPage: false });
  console.log(`✓ ${name}.png`);
  await ctx.close();
}
await browser.close();
console.log('done');
