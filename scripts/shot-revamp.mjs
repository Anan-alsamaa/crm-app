// One-off screenshot pass for the revamped surfaces (sidebar + stat strips +
// sectioned drawers + filter pills + grouped settings).
//
// Run: node scripts/shot-revamp.mjs
// Assumes admin (5174) + agent (5173) + directus (8055) are up locally.

import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, '.critique-shots');
await mkdir(outDir, { recursive: true });

const ADMIN_BASE = 'http://localhost:5174';
const AGENT_BASE = 'http://localhost:5173';
const WIDGET_BASE = 'http://localhost:5175';
const ADMIN_EMAIL = process.env.DIRECTUS_ADMIN_EMAIL || 'e.habibi@anan.sa';
const ADMIN_PASSWORD = process.env.DIRECTUS_ADMIN_PASSWORD || '123456';

async function login(page, base, email, password) {
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#email').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await Promise.all([
    page.waitForURL((u) => !u.toString().includes('/login'), { timeout: 10000 }).catch(() => {}),
    page.getByRole('button', { name: /sign in/i }).click(),
  ]);
  await page.waitForLoadState('networkidle');
}

async function shot(page, name) {
  const path = resolve(outDir, `${name}.png`);
  try {
    await page.screenshot({ path, fullPage: false });
    console.log(`✓ ${name}.png`);
  } catch (e) {
    console.warn(`✗ ${name}.png: ${e.message}`);
  }
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

// ── Login screens ───────────────────────────────────────────────
await page.goto(`${ADMIN_BASE}/login`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
await shot(page, 'admin-login-revamp');

await page.goto(`${AGENT_BASE}/login`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
await shot(page, 'agent-login-revamp');

// ── Admin portal ────────────────────────────────────────────────
await login(page, ADMIN_BASE, ADMIN_EMAIL, ADMIN_PASSWORD);

await page.goto(`${ADMIN_BASE}/users`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await shot(page, 'admin-users-revamp');

// Sidebar collapsed (storage write + reload)
try {
  await page.evaluate(() => {
    localStorage.setItem('yiji.admin.sidebarWidth', '72');
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await shot(page, 'admin-sidebar-collapsed');
  // Restore default and reload
  await page.evaluate(() => {
    localStorage.setItem('yiji.admin.sidebarWidth', '224');
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
} catch (e) {
  console.warn('skip sidebar collapsed:', e.message);
}

// Cmd+K palette
try {
  await page.evaluate(() => {
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: !isMac, metaKey: isMac, bubbles: true }));
  });
  await page.waitForTimeout(500);
  await shot(page, 'admin-cmdk-revamp');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
} catch (e) {
  console.warn('skip cmdk:', e.message);
}

await page.goto(`${ADMIN_BASE}/teams`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await shot(page, 'admin-teams-revamp');

// Open create-team drawer
try {
  await page.getByText('Create team', { exact: true }).first().click({ timeout: 4000 });
  await page.waitForTimeout(1200);
  await shot(page, 'admin-teams-drawer-revamp');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
} catch (e) {
  console.warn('skip teams drawer:', e.message);
}

await page.goto(`${ADMIN_BASE}/sla`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await shot(page, 'admin-sla-revamp');

try {
  await page.getByText('Create policy', { exact: true }).first().click({ timeout: 4000 });
  await page.waitForTimeout(1200);
  await shot(page, 'admin-sla-drawer-revamp');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
} catch (e) {
  console.warn('skip sla drawer:', e.message);
}

// ── Agent portal ────────────────────────────────────────────────
await ctx.clearCookies();
await login(page, AGENT_BASE, ADMIN_EMAIL, ADMIN_PASSWORD);

await page.goto(`${AGENT_BASE}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await shot(page, 'agent-inbox-revamp');

// Click first conversation if any
try {
  const firstConv = page.getByText('Demo Customer').first();
  await firstConv.click({ timeout: 5000 });
  await page.waitForTimeout(1200);
  await shot(page, 'agent-conversation-revamp');

  // Open create-ticket dialog from the conversation toolbar
  try {
    await page.locator('button:has-text("Create ticket")').first().click({ timeout: 3000 });
    await page.waitForTimeout(800);
    await shot(page, 'agent-create-ticket-revamp');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  } catch (e) {
    console.warn('skip create-ticket dialog:', e.message);
  }
} catch (e) {
  console.warn('skip conversation detail:', e.message);
}

await page.goto(`${AGENT_BASE}/tickets`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await shot(page, 'agent-tickets-revamp');

// Click first ticket to capture detail pane
try {
  const firstTicket = page.locator('button:has-text("From conv")').first();
  await firstTicket.click({ timeout: 3000 });
  await page.waitForTimeout(700);
  await shot(page, 'agent-ticket-detail-revamp');
} catch (e) {
  console.warn('skip ticket detail:', e.message);
}

await page.goto(`${AGENT_BASE}/preferences`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await shot(page, 'agent-preferences-revamp');

// ── Widget host page ────────────────────────────────────────────
try {
  await page.goto(WIDGET_BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await shot(page, 'widget-host-closed-revamp');

  // Open the panel
  try {
    await page.locator('.yiji-launcher').first().click({ timeout: 4000 });
    await page.waitForTimeout(1000);
    await shot(page, 'widget-panel-open-revamp');
  } catch (e) {
    console.warn('skip widget panel:', e.message);
  }
} catch (e) {
  console.warn('skip widget host:', e.message);
}

await browser.close();
console.log('done');
