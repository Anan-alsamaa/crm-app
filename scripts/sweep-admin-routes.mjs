/**
 * sweep-admin-routes.mjs — drive every admin route on a DEPLOYED environment.
 *
 *   node scripts/sweep-admin-routes.mjs
 *   ADMIN=https://... ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/sweep-admin-routes.mjs
 *
 * WHY THIS EXISTS
 *
 * `pnpm verify` and curl both passed while the admin ticket breakdown rendered
 * "Could not load report data" against staging. Neither could catch it: the
 * failing request was one the PAGE builds from another request's results, and
 * only a real browser session issues it. (It was an HTTP 414 — a few hundred
 * ids in a query string; see docs/STAGING-TEST-FINDINGS.md.)
 *
 * So this drives each route in a real browser and reports, per route: console
 * errors, failed and 4xx/5xx requests, and whether the page rendered an error
 * or empty state instead of content.
 *
 * Read-only. It signs in and navigates; it writes nothing.
 */
import { chromium } from '@playwright/test';

const ADMIN = process.env.ADMIN ?? 'https://d1evkiaehtmzr0.cloudfront.net';
const EMAIL = process.env.ADMIN_EMAIL ?? '';
const PASS = process.env.ADMIN_PASSWORD ?? '';

// No credential defaults in a committed script: a default password is one that
// gets tried against whatever ADMIN happens to point at, production included.
if (!EMAIL || !PASS) {
  console.error('set ADMIN_EMAIL and ADMIN_PASSWORD (and ADMIN for a non-staging target)');
  process.exit(2);
}

const ROUTES = [
  ['Dashboard', '/dashboard'],
  ['Agent KPI — Agent summary', '/reports/agent-kpi/tickets'],
  ['Agent KPI — Ticket deadlines', '/reports/agent-kpi/sla'],
  ['Agent KPI — Chat status', '/reports/agent-kpi/conversations'],
  ['Agent KPI — Compensation (MOVED)', '/reports/agent-kpi/compensation'],
  ['Ops KPI — Ticket breakdown', '/reports/operational-kpi/tickets'],
  ['REDIRECT old compensation', '/reports/operational-kpi/compensation'],
  ['REDIRECT legacy /compensation', '/compensation'],
  ['Coupon approvals', '/coupon-approvals'],
  ['Coupon report', '/coupon-report'],
  ['Agent performance', '/agent-performance'],
  ['SLA policies', '/sla'],
  ['Users', '/users'],
  ['Roles', '/roles'],
  ['Teams', '/teams'],
  ['Stores', '/stores'],
  ['Brands', '/brands'],
  ['Vendors', '/vendors'],
  ['Lists', '/lists'],
  ['Store notifications', '/store-notifications'],
  ['AI config', '/ai-config'],
  ['Backup', '/backup'],
];

// Noise that is not a defect: an aborted navigation, a favicon, extension chatter.
const IGNORE = [/favicon/i, /net::ERR_ABORTED/i, /ResizeObserver loop/i];
const noise = (s) => IGNORE.some((r) => r.test(s));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const problems = [];
let current = 'login';
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const text = m.text();
  // The browser echoes every failed request as a console error too, with no URL
  // attached — so a response we deliberately allowed (the pre-login session
  // probe) cannot be filtered by path here. Counting it would mean this sweep
  // never reports a clean zero, which is how a real finding gets ignored.
  if (current === 'login' && /Failed to load resource/i.test(text)) return;
  if (!noise(text)) problems.push({ route: current, kind: 'console', detail: text.slice(0, 220) });
});
page.on('requestfailed', (r) => {
  const detail = `${r.method()} ${r.url()} — ${r.failure()?.errorText ?? 'failed'}`;
  if (!noise(detail))
    problems.push({ route: current, kind: 'request', detail: detail.slice(0, 220) });
});
page.on('response', (r) => {
  if (r.status() < 400) return;
  // Expected before sign-in: the app probes for an existing session on a cold
  // browser that has no cookie yet. Directus answers 400 ("refresh token is
  // required") or 401. Neither is a defect.
  if ((r.status() === 400 || r.status() === 401) && /\/auth\/refresh/.test(r.url())) return;
  problems.push({
    route: current,
    kind: 'http',
    detail: `${r.status()} ${r.request().method()} ${r.url()}`.slice(0, 220),
  });
});

console.log(`signing in to ${ADMIN} as ${EMAIL}`);
await page.goto(`${ADMIN}/login`, { waitUntil: 'domcontentloaded' });
await page.locator('input[type="email"], input[name="email"]').first().fill(EMAIL);
await page.locator('input[type="password"]').first().fill(PASS);
await page.locator('button[type="submit"]').first().click();
await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 30000 });
console.log(`signed in -> ${new URL(page.url()).pathname}\n`);

const results = [];
for (const [name, path] of ROUTES) {
  current = name;
  const before = problems.length;
  await page.goto(`${ADMIN}${path}`, { waitUntil: 'domcontentloaded' });
  // Reports fan out several dependent queries; wait for the network to settle
  // rather than a fixed delay, so a slow chunked read is not read as a pass.
  await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});

  const body = await page
    .locator('body')
    .innerText()
    .catch(() => '');
  const landed = new URL(page.url()).pathname;
  const errText = /could not load|failed to load|something went wrong|unexpected error/i.exec(body);
  const empty = /no data in this window|nothing to show/i.exec(body);

  results.push({
    name,
    path,
    landed,
    chars: body.trim().length,
    error: errText?.[0] ?? null,
    empty: empty?.[0] ?? null,
    newProblems: problems.length - before,
  });
}

await browser.close();

console.log('ROUTE RESULTS');
console.log('='.repeat(100));
let bad = 0;
for (const r of results) {
  const redirected = r.landed !== r.path && !(r.path === '/' && r.landed === '/');
  const flags = [];
  if (r.error) {
    flags.push(`ERROR STATE: "${r.error}"`);
    bad++;
  }
  if (r.empty) flags.push(`empty: "${r.empty}"`);
  // Deliberately NOT a byte threshold: Vendors legitimately holds one row and
  // tripped a 400-char rule. A page is thin only if it rendered essentially
  // nothing at all.
  if (r.chars < 120) {
    flags.push(`THIN PAGE (${r.chars} chars)`);
    bad++;
  }
  if (r.newProblems) {
    flags.push(`${r.newProblems} console/network problem(s)`);
    bad++;
  }
  const status = flags.length ? `\x1b[31m${flags.join(' | ')}\x1b[0m` : '\x1b[32mok\x1b[0m';
  console.log(
    `${r.name.padEnd(38)} ${redirected ? `-> ${r.landed}`.padEnd(38) : ''.padEnd(38)} ${status}`,
  );
}

if (problems.length) {
  console.log('\nPROBLEM DETAIL');
  console.log('='.repeat(100));
  for (const p of problems) console.log(`[${p.route}] (${p.kind}) ${p.detail}`);
}

console.log(
  `\n${results.length} routes, ${bad} with findings, ${problems.length} console/network problems`,
);
process.exit(bad || problems.length ? 1 : 0);
