/**
 * What the inbox AI actually does when the portal is in Arabic.
 *
 * Written because three rounds of code reading disagreed with what the owner
 * sees on screen. This drives the deployed portal and reports the request the
 * panel sent, the reply that came back, and the label of every button the agent
 * can click — so the answer comes from the running product, not from the source.
 *
 *   node tools/ar-inbox-probe.mjs
 */
import { chromium } from '@playwright/test';

const PORTAL = process.env.PORTAL ?? 'http://localhost:8090';
const EMAIL = process.env.AGENT_EMAIL ?? 'e2e.agent@example.com';
const PASSWORD = process.env.AGENT_PASSWORD ?? 'Agent12345!';
const AR = /[\u0600-\u06FF]/u;

/** Share of the LETTERS that are Arabic — digits and names must not sway it. */
function arShare(s) {
  const letters = [...(s ?? '')].filter((c) => /\p{L}/u.test(c));
  if (!letters.length) return 0;
  return Math.round((letters.filter((c) => AR.test(c)).length / letters.length) * 100);
}
const tag = (s) => (arShare(s) > 50 ? 'AR' : 'EN');
const show = (title, labels) => {
  console.log(`\n== ${title} ==`);
  for (const l of [...new Set(labels)]) console.log(`  ${tag(l)}  ${l.replace(/\s+/g, ' ')}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ locale: 'ar' });
const sent = [];
page.on('request', (r) => {
  if (r.method() === 'POST' && /suggest|summar|help|assist/.test(r.url())) {
    sent.push(`SENT ${r.url().replace(/^https?:\/\/[^/]+/, '')}  ${r.postData() ?? ''}`);
  }
});
page.on('response', async (r) => {
  if (r.request().method() === 'POST' && /suggest|summar|help|assist/.test(r.url())) {
    const body = await r.text().catch(() => '');
    sent.push(`GOT  ${r.status()}  ${arShare(body)}% arabic  ${body.slice(0, 300)}`);
  }
});

await page.goto(`${PORTAL}/login`, { waitUntil: 'networkidle' });
await page.locator('#email').fill(EMAIL);
await page.locator('#password').fill(PASSWORD);
await page.getByRole('button', { name: /sign in|دخول|تسجيل/i }).first().click();
await page.waitForURL((u) => !u.pathname.includes('login'), { timeout: 20000 });

const arBtn = page.getByRole('button', { name: /^(ar|العربية)$/i }).first();
if (await arBtn.count()) await arBtn.click();
await page.waitForTimeout(800);
console.log('dir =', await page.evaluate(() => document.documentElement.dir));
console.log('lang =', await page.evaluate(() => document.documentElement.lang));

await page.goto(`${PORTAL}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.getByRole('button', { name: /Saad Al-Harbi/ }).first().click();
await page.waitForTimeout(2500);

const buttons = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('button')]
      .map((b) => (b.textContent ?? '').trim())
      .filter((s) => s && s.length < 45),
  );
show('BUTTONS IN THE OPEN CONVERSATION', await buttons());

const trigger = page.getByRole('button', { name: /^(ai|المساعدة|مساعد)/i }).first();
if (await trigger.count()) {
  await trigger.click();
  await page.waitForTimeout(1200);
  show('BUTTONS AFTER OPENING THE AI PANEL', await buttons());
} else {
  console.log('\n(no AI trigger found)');
}

const suggest = page.getByRole('button', { name: /suggest reply|اقتراح/i }).first();
if (await suggest.count()) {
  await suggest.click();
  await page.waitForTimeout(12000);
}

console.log('\n== REQUESTS THE PANEL SENT ==');
for (const s of sent) console.log('  ', s);

const draft = await page.evaluate(() => {
  const areas = [...document.querySelectorAll('textarea')].map((t) => t.value ?? '');
  return areas.sort((a, b) => b.length - a.length)[0] ?? '';
});
console.log(`\n== COMPOSER DRAFT == ${arShare(draft)}% arabic`);
console.log('  ', draft.replace(/\s+/g, ' ').slice(0, 300));
await page.screenshot({ path: 'tools/ar-inbox.png' });
await browser.close();
