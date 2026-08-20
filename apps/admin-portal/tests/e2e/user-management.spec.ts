import { test, expect, type Page } from '@playwright/test';
import { ADMIN_URL } from '../../../../tests/e2e-setup/urls';

/**
 * US1 — admin login + create team + create user (T026).
 * Requires the admin portal (see tests/e2e-setup/urls.ts) and Directus.
 * Uses the project-owner admin creds by default (override via env).
 */
const BASE = ADMIN_URL;
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'e.habibi@anan.sa';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '123456';

const DIRECTUS = process.env.E2E_DIRECTUS_URL ?? 'http://127.0.0.1:8055';

/**
 * Remove the agents this spec creates.
 *
 * It makes one real-looking user per run and used to leave every one behind: a
 * Users page carrying six abandoned accounts, all with a working password and a
 * live Agent role. That is residue in a list an operator is supposed to trust,
 * and on a shared environment it is six real logins nobody meant to issue.
 *
 * Sweeps the whole `zz-` prefix rather than only this run's address, so the
 * accounts already stranded by earlier runs go too. Best-effort: a cleanup that
 * fails must not turn a passing test red — it reports and moves on.
 */
async function removeTestAgents(): Promise<void> {
  try {
    const auth = await fetch(`${DIRECTUS}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    if (!auth.ok) return;
    const token = ((await auth.json()) as { data: { access_token: string } }).data.access_token;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const found = await fetch(
      `${DIRECTUS}/users?filter[login_name][_starts_with]=zz-e2e-agent.&fields=id&limit=-1`,
      { headers },
    );
    if (!found.ok) return;
    const ids = ((await found.json()) as { data: Array<{ id: string }> }).data.map((u) => u.id);
    if (ids.length === 0) return;
    await fetch(`${DIRECTUS}/users`, { method: 'DELETE', headers, body: JSON.stringify(ids) });
    console.log(`cleaned up ${ids.length} zz-e2e-agent user(s)`);
  } catch (err) {
    console.warn('could not clean up test agents:', err);
  }
}

test.afterAll(removeTestAgents);

async function login(page: import('@playwright/test').Page) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel(/email/i).fill(ADMIN_EMAIL);
  await page.locator('#password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  // Wait for the post-login landing — the admin lands on the Dashboard, whose
  // h1 is "Overview" (level:1 disambiguates it from the "Overview" section
  // sub-heading) — so callers can click nav links without racing the redirect.
  await expect(page.getByRole('heading', { name: /overview/i, level: 1 })).toBeVisible({
    timeout: 20_000,
  });
}

/**
 * Reach a Workspace destination.
 *
 * The admin masthead groups fourteen destinations into six controls, so Users
 * and Teams are NOT top-level links any more — they live behind the
 * "Workspace" menu button. These specs still clicked a top-level link and
 * timed out on every run.
 */
async function gotoWorkspace(page: Page, name: RegExp, url: RegExp): Promise<void> {
  await page.getByRole('button', { name: /workspace/i }).click();
  await page.getByRole('menuitem', { name }).click();
  await page.waitForURL(url);
}

test('admin signs in and reaches Users management', async ({ page }) => {
  await login(page);
  // Admin lands on the Dashboard; navigate to Users management.
  await gotoWorkspace(page, /^users$/i, /\/users/);
  // Match the AppShell's page title (h1) specifically: the Users page also has
  // its own <h2>Users</h2>, and an unqualified heading query resolves to both,
  // which Playwright strict mode rejects. `login()` above already scopes by
  // level for the same reason.
  await expect(page.getByRole('heading', { name: /users/i, level: 1 })).toBeVisible({
    timeout: 20_000,
  });
});

test('admin creates a team then a user assigned to it', async ({ page }) => {
  await login(page);
  const teamName = `QA Team ${Date.now()}`;

  await gotoWorkspace(page, /^teams$/i, /\/teams/);
  // Create-team is a Drawer (role="dialog"); the toolbar/empty-state CTA opens
  // it. Scope the form + submit to the drawer (the trigger shares its label).
  await page
    .getByRole('button', { name: /create team/i })
    .first()
    .click();
  const teamDrawer = page.getByRole('dialog');
  // FormField doesn't wire label→input, so target RHF fields by name attribute.
  await teamDrawer.locator('input[name="name"]').fill(teamName);
  await teamDrawer.getByRole('button', { name: /create team/i }).click();
  await expect(page.getByText(teamName)).toBeVisible();

  await gotoWorkspace(page, /^users$/i, /\/users/);
  // Prefixed so `removeTestAgents` above can find every one of these, including
  // any left behind by a run that was interrupted before its cleanup.
  // A LOGIN NAME now, not an email: staff sign in with an employee id and the
  // Directus identity is minted from it. Still prefixed so `removeTestAgents`
  // finds every one of these, including any a killed run left behind.
  const loginName = `zz-e2e-agent.${Date.now()}`;
  await page
    .getByRole('button', { name: /create user/i })
    .first()
    .click();
  const userDrawer = page.getByRole('dialog');
  await userDrawer.locator('input[name="login_name"]').fill(loginName);
  await userDrawer.locator('input[name="password"]').fill('password123');
  // Role/Team are custom comboboxes (SelectMenu), not native <select>s. Open the
  // combobox (scoped to the drawer) and click the option (rendered in a portal
  // on document.body, so query options at the page level).
  await userDrawer.getByRole('combobox', { name: /role/i }).click();
  await page.getByRole('option', { name: 'Agent', exact: true }).click();
  await userDrawer.getByRole('combobox', { name: /team/i }).click();
  await page.getByRole('option', { name: teamName }).click();
  await userDrawer.getByRole('button', { name: /create user/i }).click();
  // Wait for the success notice, then for the row to appear in the refetched table.
  await expect(page.getByText(/user created/i)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(loginName)).toBeVisible({ timeout: 10_000 });
});
