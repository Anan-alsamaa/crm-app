import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

for (const [name, url] of [['admin', 'http://localhost:5174/login'], ['agent', 'http://localhost:5173/login']]) {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const info = await page.evaluate(() => {
    const btn = document.querySelector('button[type="submit"]');
    if (!btn) return { found: false };
    const cs = getComputedStyle(btn);
    return {
      found: true,
      classes: btn.className,
      bg: cs.backgroundColor,
      color: cs.color,
      borderColor: cs.borderColor,
      borderWidth: cs.borderWidth,
    };
  });
  console.log(name, JSON.stringify(info, null, 2));
}

await browser.close();
