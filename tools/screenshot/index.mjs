/**
 * Puppeteer screenshot tool for the Yiji CRM — captures the portals (logged in)
 * and the widget so Claude/devs can see the rendered UI without a manual session.
 *
 * Run from tools/screenshot (after `npm install`):
 *   node index.mjs                 # all surfaces
 *   ONLY=agent node index.mjs      # just the agent portal
 *   ONLY=admin|widget node index.mjs
 *
 * Output: ./shots/*.png. Uses 127.0.0.1 (IPv4) to dodge the localhost/::1 issue.
 */
import puppeteer from 'puppeteer';
import { mkdir } from 'node:fs/promises';

const OUT = process.env.OUT_DIR ?? './shots';
const ONLY = process.env.ONLY ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const AGENT = {
  url: 'http://127.0.0.1:5173',
  email: 'e2e.agent@example.com',
  pass: 'E2eAgentPass1!',
  routes: [
    ['agent-inbox', '/'],
    ['agent-tickets', '/tickets'],
    ['agent-contacts', '/contacts'],
  ],
};
const ADMIN = {
  url: 'http://127.0.0.1:5174',
  email: 'e.habibi@anan.sa',
  pass: '123456',
  routes: [
    ['admin-dashboard', '/dashboard'],
    ['admin-users', '/users'],
    ['admin-sla', '/sla'],
    ['admin-ai-config', '/ai-config'],
  ],
};
const WIDGET = 'http://127.0.0.1:5175';

async function shoot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('  ✓ saved', name + '.png');
}

async function portal(browser, p, label) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  try {
    await page.goto(`${p.url}/login`, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.type('#email', p.email);
    await page.type('#password', p.pass);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {}),
      page.click('button[type=submit]'),
    ]);
    await sleep(2500);
    for (const [name, path] of p.routes) {
      await page.goto(`${p.url}${path}`, { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
      await sleep(1500);
      await shoot(page, name);
    }
  } catch (e) {
    console.log(`  ✗ ${label}: ${e.message}`);
  } finally {
    await page.close();
  }
}

(async () => {
  await mkdir(OUT, { recursive: true });
  console.log(`Screenshots → ${OUT}`);
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    if (!ONLY || ONLY === 'widget') {
      const w = await browser.newPage();
      await w.setViewport({ width: 420, height: 760 });
      await w.goto(WIDGET, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
      await sleep(2000);
      await shoot(w, 'widget-closed');
      // open the chat panel if a launcher is present
      const launcher = await w.$('[class*="launcher"], [aria-label*="chat" i], button');
      if (launcher) {
        await launcher.click().catch(() => {});
        await sleep(1500);
        await shoot(w, 'widget-open');
      }
      await w.close();
    }
    if (!ONLY || ONLY === 'agent') await portal(browser, AGENT, 'agent');
    if (!ONLY || ONLY === 'admin') await portal(browser, ADMIN, 'admin');
  } finally {
    await browser.close();
  }
  console.log('done');
})().catch((e) => {
  console.error('screenshot tool failed:', e.message);
  process.exit(1);
});
