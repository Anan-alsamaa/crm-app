/**
 * Walks every route in both portals and reports what is broken on it.
 *
 * Written because fixing one page kept surfacing a defect on another: there
 * was nothing that looked at all of them, so every regression was found by the
 * owner rather than by us. This is that missing check.
 *
 * It reports only things that are defects by construction — a raw i18n
 * placeholder, an unresolved binding, a crash, a failed request — never
 * matters of taste. Run it after any change that touches the portals:
 *
 *   node tools/ui-audit/index.mjs            # both portals
 *   PORTAL=agent node tools/ui-audit/index.mjs
 */
import { chromium } from '@playwright/test';

const AGENT = {
  name: 'agent',
  url: process.env.AGENT_URL ?? 'http://localhost:8090',
  email: process.env.AGENT_EMAIL ?? 'e2e.agent@example.com',
  pass: process.env.AGENT_PASSWORD ?? 'Agent12345!',
  routes: [
    '/', '/tickets', '/new-ticket', '/contacts', '/coupons',
    '/performance', '/compensation', '/preferences',
  ],
};
const ADMIN = {
  name: 'admin',
  url: process.env.ADMIN_URL ?? 'http://localhost:8092',
  email: process.env.ADMIN_EMAIL ?? 'e.habibi@anan.sa',
  pass: process.env.ADMIN_PASSWORD ?? '123456',
  routes: [
    '/dashboard', '/report-tickets', '/report-complaints', '/report-conversations',
    '/report-agents', '/report-exports', '/reports', '/agent-performance',
    '/sla', '/sla-reports', '/ticket-ops', '/coupon-approvals', '/coupon-report', '/users', '/teams',
    '/roles', '/lists', '/custom-fields', '/stores', '/brands', '/vendors',
    '/store-notifications', '/automation', '/imports', '/ai-config', '/backup',
  ],
};

/**
 * Routes that redirect deliberately: old URLs kept alive after a page moved,
 * so a bookmark still lands somewhere sensible. Landing anywhere ELSE is still
 * reported.
 */
const ALIASES = {
  '/report-complaints': '/report-tickets',
  '/report-exports': '/report-tickets',
  '/ticket-ops': '/dashboard',
  '/custom-fields': '/sla',
  '/automation': '/sla',
};

/** Text that is always a defect when it reaches the screen. */
const TEXT_DEFECTS = [
  [/\{\{\s*\w+\s*\}\}/, 'an unresolved i18n placeholder'],
  [/\bundefined\b/, 'the word "undefined"'],
  [/\bNaN\b/, 'NaN'],
  [/\[object Object\]/, '[object Object]'],
  [/\bInvalid Date\b/, 'Invalid Date'],
  [/Something went wrong/i, 'the error boundary'],
  [/Could not load|Failed to load/i, 'a load failure'],
  // A translation key that reached the screen instead of its translation.
  [/(^|\s)[a-z][a-zA-Z]+\.[a-z][a-zA-Z]{2,}(\s|$)/, 'what looks like a raw translation key'],
];

async function auditPortal(browser, p) {
  const findings = [];
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  await page.goto(`${p.url}/login`, { waitUntil: 'networkidle' });
  await page.fill('#email', p.email);
  await page.fill('#password', p.pass);
  await page.click('button[type=submit]');
  await page.waitForTimeout(3500);

  // If sign-in failed there is nothing to audit, and walking the routes anyway
  // produces one "redirected to /login" per page: fifteen findings describing
  // a single problem, none of them naming it. Say the real thing and stop.
  if (new URL(page.url()).pathname.startsWith('/login')) {
    await ctx.close();
    return [
      {
        route: '/login',
        kind: 'auth',
        detail:
          `could not sign in as ${p.email} — every other check was skipped. ` +
          'Reset the password or check the account is active.',
      },
    ];
  }

  for (const route of p.routes) {
    const consoleErrors = [];
    const netErrors = [];
    const onConsole = (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 180)); };
    const onPageError = (e) => consoleErrors.push('PAGEERROR ' + String(e).slice(0, 180));
    const onResponse = (r) => {
      // /auth/refresh 400 before a session exists is expected, not a defect.
      if (r.status() >= 400 && !r.url().includes('/auth/refresh')) {
        netErrors.push(`${r.status()} ${r.url().split('?')[0].slice(-70)}`);
      }
    };
    page.on('console', onConsole);
    page.on('pageerror', onPageError);
    page.on('response', onResponse);

    await page.goto(`${p.url}${route}`, { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(2500);

    const landed = new URL(page.url()).pathname;
    const expected = ALIASES[route];
    if (route !== '/' && landed !== route && landed !== expected) {
      findings.push({
        route,
        kind: 'route',
        detail: expected
          ? `redirected to ${landed}, expected ${expected}`
          : `redirected to ${landed}`,
      });
    }
    const body = await page.locator('body').innerText().catch(() => '');
    for (const [re, label] of TEXT_DEFECTS) {
      const m = body.match(re);
      if (m) findings.push({ route, kind: 'text', detail: `${label}: ${JSON.stringify(m[0].trim().slice(0, 60))}` });
    }
    for (const e of [...new Set(consoleErrors)]) findings.push({ route, kind: 'console', detail: e });
    for (const e of [...new Set(netErrors)]) findings.push({ route, kind: 'network', detail: e });

    page.off('console', onConsole);
    page.off('pageerror', onPageError);
    page.off('response', onResponse);
  }
  await ctx.close();
  return findings;
}

const only = process.env.PORTAL;
const portals = [AGENT, ADMIN].filter((p) => !only || p.name === only);
const browser = await chromium.launch();
let total = 0;
for (const p of portals) {
  const findings = await auditPortal(browser, p);
  total += findings.length;
  console.log(`\n===== ${p.name} portal — ${findings.length} finding(s) =====`);
  for (const f of findings) console.log(`  ${f.route.padEnd(24)} [${f.kind}] ${f.detail}`);
}
await browser.close();
console.log(`\nTOTAL: ${total}`);
process.exit(total > 0 ? 1 : 0);
