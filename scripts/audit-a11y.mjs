// T116 — Automated a11y scan with axe-core via Playwright.
// Loads each primary route, runs axe, prints a summary table, exits non-zero
// if any "serious" or "critical" violations are found.
//
// Usage:
//   AGENT_EMAIL=... AGENT_PASSWORD=... node scripts/audit-a11y.mjs
//
// Defaults to the demo creds from .env.example so the local dev stack
// "just works".

import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, '.audit-output');
await mkdir(outDir, { recursive: true });

const AGENT_BASE = process.env.AGENT_BASE_URL ?? 'http://localhost:5173';
const ADMIN_BASE = process.env.ADMIN_BASE_URL ?? 'http://localhost:5174';
const WIDGET_BASE = process.env.WIDGET_BASE_URL ?? 'http://localhost:5175';
const EMAIL = process.env.AGENT_EMAIL ?? process.env.DIRECTUS_ADMIN_EMAIL ?? 'e.habibi@anan.sa';
const PASSWORD = process.env.AGENT_PASSWORD ?? process.env.DIRECTUS_ADMIN_PASSWORD ?? '123456';

const ROUTES = [
  { name: 'admin-login',    url: `${ADMIN_BASE}/login`,       auth: false },
  { name: 'agent-login',    url: `${AGENT_BASE}/login`,       auth: false },
  { name: 'widget-host',    url: `${WIDGET_BASE}/`,           auth: false },
  { name: 'admin-users',    url: `${ADMIN_BASE}/users`,       auth: 'admin' },
  { name: 'admin-teams',    url: `${ADMIN_BASE}/teams`,       auth: 'admin' },
  { name: 'admin-sla',      url: `${ADMIN_BASE}/sla`,         auth: 'admin' },
  { name: 'admin-vendors',  url: `${ADMIN_BASE}/vendors`,     auth: 'admin' },
  { name: 'admin-ai-config',url: `${ADMIN_BASE}/ai-config`,   auth: 'admin' },
  { name: 'agent-inbox',    url: `${AGENT_BASE}/`,            auth: 'agent' },
  { name: 'agent-tickets',  url: `${AGENT_BASE}/tickets`,     auth: 'agent' },
  { name: 'agent-contacts', url: `${AGENT_BASE}/contacts`,    auth: 'agent' },
  { name: 'agent-preferences', url: `${AGENT_BASE}/preferences`, auth: 'agent' },
];

const COLORS = {
  reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', yellow: '\x1b[33m',
  green: '\x1b[32m', cyan: '\x1b[36m', bold: '\x1b[1m',
};

function color(c, s) { return `${COLORS[c]}${s}${COLORS.reset}`; }

async function loginAs(page, base) {
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('#email').waitFor({ state: 'visible', timeout: 15_000 });
  await page.locator('#email').fill(EMAIL);
  await page.locator('#password').fill(PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !u.toString().includes('/login'), { timeout: 12_000 }).catch(() => {}),
    page.getByRole('button', { name: /sign in/i }).click(),
  ]);
  await page.waitForLoadState('networkidle');
}

const browser = await chromium.launch();
const allResults = [];
let serious = 0;
let critical = 0;
let totalViolations = 0;

// One context per portal — sign in once, reuse across every route in that
// portal. Avoids back-to-back logins flooding Directus.
const ctxBy = {
  none: await browser.newContext({ viewport: { width: 1440, height: 900 } }),
  admin: await browser.newContext({ viewport: { width: 1440, height: 900 } }),
  agent: await browser.newContext({ viewport: { width: 1440, height: 900 } }),
};
const loggedIn = { admin: false, agent: false };

for (const route of ROUTES) {
  const ctx = ctxBy[route.auth || 'none'];
  const page = await ctx.newPage();
  try {
    if (route.auth === 'admin' && !loggedIn.admin) {
      await loginAs(page, ADMIN_BASE);
      loggedIn.admin = true;
    }
    if (route.auth === 'agent' && !loggedIn.agent) {
      await loginAs(page, AGENT_BASE);
      loggedIn.agent = true;
    }
    await page.goto(route.url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
    for (const v of results.violations) counts[v.impact] = (counts[v.impact] ?? 0) + 1;
    serious += counts.serious;
    critical += counts.critical;
    totalViolations += results.violations.length;

    allResults.push({ route: route.name, url: route.url, counts, violations: results.violations });
    const ind =
      counts.critical ? color('red', '✗ CRIT')
      : counts.serious ? color('yellow', '! SER')
      : counts.moderate || counts.minor ? color('dim', '· info')
      : color('green', '✓ pass');
    console.log(
      `${ind}  ${route.name.padEnd(22)} crit:${counts.critical}  ser:${counts.serious}  mod:${counts.moderate}  min:${counts.minor}`,
    );
  } catch (err) {
    console.log(`${color('red', '✗ ERR')}  ${route.name.padEnd(22)} ${err.message}`);
    allResults.push({ route: route.name, url: route.url, error: err.message });
  } finally {
    await page.close();
  }
}

for (const c of Object.values(ctxBy)) await c.close();
await browser.close();

// Write the raw JSON for the record.
const jsonPath = resolve(outDir, `a11y-${new Date().toISOString().slice(0, 10)}.json`);
await writeFile(jsonPath, JSON.stringify(allResults, null, 2));

console.log('');
console.log(color('bold', `Total violations: ${totalViolations}  (critical: ${critical}, serious: ${serious})`));
console.log(`JSON: ${jsonPath}`);

if (critical > 0 || serious > 0) {
  console.log('');
  console.log(color('bold', 'Critical/serious findings:'));
  for (const r of allResults) {
    if (!r.violations) continue;
    for (const v of r.violations) {
      if (v.impact !== 'critical' && v.impact !== 'serious') continue;
      console.log(`  [${v.impact}] ${r.route} — ${v.id}: ${v.help}`);
      const nodes = v.nodes.slice(0, 2);
      for (const n of nodes) {
        console.log(`      ${color('dim', n.target.join(' '))}`);
      }
    }
  }
}

process.exit(critical > 0 || serious > 0 ? 1 : 0);
