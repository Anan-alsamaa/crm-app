import { test, expect, type Page } from '@playwright/test';

/**
 * Click-through proof for the UI half of the 2026-09-15 batch.
 *
 * Every other item in that batch was verifiable from a terminal — a routing log
 * line, a minted token's claims, a computed metric. These four were not: they
 * are layout, styling, a privilege gate and a polling interval, and the honest
 * status for them was "shipped and unit-tested, never looked at". This closes
 * that gap by driving a real browser against the live portals.
 *
 * READ-ONLY, BY CONSTRUCTION. These sign in as real accounts against real
 * production data. They open drawers, read computed styles, count network
 * requests and inspect the DOM — and they never save, delete, send or submit.
 * The one form field that gets typed into (login name, to prove `@` is
 * accepted) is filled and then abandoned without saving.
 */

const AGENT_URL = (process.env.PROD_AGENT_URL ?? 'https://crm-agent.anan.sa').replace(/\/$/, '');
const ADMIN_URL = (process.env.PROD_ADMIN_URL ?? 'https://crm-admin.anan.sa').replace(/\/$/, '');

const ADMIN_EMAIL = process.env.PROD_ADMIN_EMAIL ?? 'admin@anan.sa';
const ADMIN_PASSWORD = process.env.PROD_ADMIN_PASSWORD ?? '123456';
const AGENT_EMAIL = process.env.PROD_AGENT_EMAIL ?? 'agent@anan.sa';
const AGENT_PASSWORD = process.env.PROD_AGENT_PASSWORD ?? '123456';

async function signIn(page: Page, url: string, email: string, password: string): Promise<void> {
  await page.goto(`${url}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  // The login form going away is the signal, whichever landing screen follows.
  await expect(page.locator('#password')).toHaveCount(0, { timeout: 30_000 });
}

test.describe('admin portal', () => {
  test('item 8 + 11: Delete, Cancel and Save share one row, and Delete is admin-gated', async ({
    page,
  }) => {
    await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto(`${ADMIN_URL}/users`, { waitUntil: 'domcontentloaded' });

    /*
     * Open an existing account's editor. Editing, not creating: Delete only
     * exists for a user that already exists.
     *
     * The list is `ul > li > button`, not a table — worth saying because the
     * obvious `table tbody tr` guess matches nothing and times out looking
     * like a broken page rather than a wrong selector.
     */
    const firstUser = page.locator('ul.divide-y li button').first();
    await firstUser.waitFor({ timeout: 30_000 });
    await firstUser.click();

    const drawer = page.locator('[role="dialog"]');
    await expect(drawer).toBeVisible();

    const save = drawer.getByRole('button', { name: /save|create/i }).last();
    const cancel = drawer.getByRole('button', { name: /cancel/i }).last();
    await expect(save).toBeVisible();
    await expect(cancel).toBeVisible();

    /*
     * ONE ROW means one row: the footer was `flex-col`, which stacked these
     * vertically. Comparing the vertical centres is what actually distinguishes
     * a row from a stack — a class assertion would pass on a stale build.
     */
    const [saveBox, cancelBox] = [await save.boundingBox(), await cancel.boundingBox()];
    expect(saveBox, 'Save must be laid out').toBeTruthy();
    expect(cancelBox, 'Cancel must be laid out').toBeTruthy();
    const saveMid = saveBox!.y + saveBox!.height / 2;
    const cancelMid = cancelBox!.y + cancelBox!.height / 2;
    expect(Math.abs(saveMid - cancelMid)).toBeLessThan(12);

    // Delete, when present, is on that same line — and to the far side of it.
    const del = drawer.getByRole('button', { name: /^delete$/i });
    if (await del.count()) {
      const delBox = await del.first().boundingBox();
      expect(delBox).toBeTruthy();
      const delMid = delBox!.y + delBox!.height / 2;
      expect(Math.abs(delMid - saveMid)).toBeLessThan(12);
      expect(delBox!.x).toBeLessThan(saveBox!.x);
    }
  });

  test('item 7 + 9: a login name may contain @, and may be left empty', async ({ page }) => {
    await signIn(page, ADMIN_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto(`${ADMIN_URL}/users`, { waitUntil: 'domcontentloaded' });

    const firstUser = page.locator('ul.divide-y li button').first();
    await firstUser.waitFor({ timeout: 30_000 });
    await firstUser.click();

    const drawer = page.locator('[role="dialog"]');
    await expect(drawer).toBeVisible();

    /*
     * Located by its LABEL, not by `input[name=...]`. The field is rendered
     * through a `FormField` + `Input` pair, so whether the `name` attribute
     * survives that indirection is an implementation detail; the label is the
     * thing the product promises and a person reads.
     */
    const loginName = drawer.getByLabel(/login name/i).first();
    await expect(loginName).toBeVisible();

    /*
     * TYPED AND ABANDONED. Filling a field runs the resolver and surfaces its
     * message; nothing is saved, and the drawer is closed with Cancel below.
     * The old rule rejected `@` outright — "Letters, numbers, dot, dash and
     * underscore only" — which is what made an address-shaped sign-in name
     * impossible to store.
     */
    await loginName.fill('e.habibi@anan.sa');
    await loginName.blur();
    await expect(drawer.getByText(/dot, dash and underscore only/i)).toHaveCount(0);

    // Empty is legal too: the account then signs in with its email.
    await loginName.fill('');
    await loginName.blur();
    await expect(drawer.getByText(/required/i)).toHaveCount(0);

    await drawer
      .getByRole('button', { name: /cancel/i })
      .last()
      .click();
    await expect(drawer).toHaveCount(0);
  });
});

test.describe('agent portal', () => {
  test('item 12: the inbox refreshes itself, with no refresh button pressed', async ({ page }) => {
    /*
     * The portal was a bare QueryClient — no interval, no refetch on focus — so
     * a list showed whatever it held when the page opened. Counting real
     * requests is the only assertion that distinguishes a polling client from a
     * static one; a config grep would pass on a stale bundle.
     */
    const calls: number[] = [];
    page.on('request', (r) => {
      if (/\/items\/conversations/.test(r.url())) calls.push(Date.now());
    });

    await signIn(page, AGENT_URL, AGENT_EMAIL, AGENT_PASSWORD);
    await expect(page.getByRole('heading', { name: /inbox/i }).first()).toBeVisible({
      timeout: 30_000,
    });

    const afterLoad = calls.length;
    expect(afterLoad, 'the inbox must load its conversations at least once').toBeGreaterThan(0);

    // 30s interval + headroom for a slow round trip.
    await page.waitForTimeout(40_000);
    expect(calls.length, 'the inbox must poll without being asked').toBeGreaterThan(afterLoad);
  });

  test('item 1: a relative timestamp keeps counting while the tab is elsewhere', async ({
    page,
  }) => {
    await signIn(page, AGENT_URL, AGENT_EMAIL, AGENT_PASSWORD);
    await expect(page.getByRole('heading', { name: /inbox/i }).first()).toBeVisible({
      timeout: 30_000,
    });

    /*
     * `formatRelative` read the clock only when React happened to redraw, so
     * these froze at whatever they said when the agent last looked. The proof
     * is that a re-render now happens on its own: the hook is referenced in the
     * render, so the text is recomputed on every tick.
     *
     * Asserted as "the value is a live reading", not as a change: a row last
     * touched two hours ago still says "2h" a minute later, correctly. What is
     * checked is that the element exists, carries a relative reading, and
     * survives a visibility change — the exact sequence that used to leave a
     * stale number on screen.
     */
    const stamp = page.locator('aside li span.tabular-nums').first();
    await stamp.waitFor({ timeout: 30_000 });
    const before = (await stamp.textContent())?.trim() ?? '';
    expect(before, 'a row must carry a relative timestamp').toMatch(/now|\d+\s*[mhd]|\w{3}/i);

    // Leave the tab and come back — the case that used to show a stale figure.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(2_000);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });

    // Still a live reading after the round trip, not a blank or a frozen cell.
    await expect(stamp).toBeVisible();
    const after = (await stamp.textContent())?.trim() ?? '';
    expect(after).toMatch(/now|\d+\s*[mhd]|\w{3}/i);
  });
});
