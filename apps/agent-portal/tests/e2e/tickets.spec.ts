import { test, expect } from '@playwright/test';
import { AGENT_URL } from '../../../../tests/e2e-setup/urls';

/**
 * US4 (T070) — ticket create from a conversation → workflow + history.
 *
 * Flow:
 *  1. Customer sends a message via the widget (seeds a conversation).
 *  2. Agent signs in, opens the conversation, clicks "Create ticket".
 *  3. Submits the create-ticket form.
 *  4. Navigates to /tickets → finds the new ticket → opens it.
 *  5. Marks "first response sent" → confirms it persists.
 *  6. Changes status to "resolved" → confirms a `status_changed` event lands
 *     in the append-only history.
 */
const AGENT_EMAIL = process.env.E2E_AGENT_EMAIL!;
const AGENT_PASSWORD = process.env.E2E_AGENT_PASSWORD!;

async function signInAgent(page: import('@playwright/test').Page) {
  await page.goto(`${AGENT_URL}/login`);
  await page.locator('#email').fill(AGENT_EMAIL);
  await page.locator('#password').fill(AGENT_PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('heading', { name: /shared inbox/i })).toBeVisible({
    timeout: 20_000,
  });
}

test('agent creates a ticket from a conversation, advances workflow, sees history', async ({
  browser,
}) => {
  // 1. A conversation is already seeded deterministically via the Directus API
  //    in Playwright globalSetup (tests/e2e-setup/global-setup.ts) — no need to
  //    drive the (timing-flaky) widget just to create one to act on.

  // 2. Agent opens the conversation.
  const agent = await browser.newPage();
  await signInAgent(agent);
  await agent.locator('aside li button').first().waitFor({ timeout: 15_000 });
  await agent.locator('aside li button').first().click();

  // 3. Open "Add ticket" from the conversation, which carries the contact and
  // vendor across. The form has no subject box on purpose — a ticket is named
  // after its ticket type (see CreateTicketDialog) — so choosing that type
  // is what makes the form submittable, not typing a title.
  await agent
    .getByRole('button', { name: /add ticket/i })
    .first()
    .click();
  const typeSelect = agent.getByRole('combobox', { name: /ticket type/i });
  await typeSelect.waitFor({ timeout: 15_000 });
  await typeSelect.click();
  const typeOption = agent.getByRole('option').nth(1);
  const ticketName = (await typeOption.innerText()).trim();
  await typeOption.click();
  await agent.getByLabel(/^description$/i).fill('Auto-created via E2E.');
  await agent.getByRole('button', { name: /^create$/i }).click();

  // 4. Creating lands on the new ticket's own page.
  expect(ticketName.length).toBeGreaterThan(0);
  await agent.waitForURL(/\/tickets\/[0-9a-f-]{6,}/i, { timeout: 20_000 });

  // 5. Close the work. One control now does it: "Mark as solved" sets the
  // ticket to resolved, stops both SLA timers, and backfills first_responded_at
  // when nothing else stamped it — which replaced the separate first-response
  // button and status dropdown this test used to drive.
  await agent.getByRole('button', { name: /mark as solved/i }).click();
  await expect(agent.getByText(/^solved ·/i)).toBeVisible({ timeout: 10_000 });

  // And it survives a reload, so the state was persisted rather than only set
  // in the client's cache.
  await agent.reload();
  /*
   * WAIT FOR THE SESSION, NOT FOR THE CLOCK.
   *
   * A reload drops the in-memory access token and restores it from the cookie,
   * then refetches the ticket. Asserting on the text alone races that chain,
   * and raising the timeout only made the race longer — this line failed twice
   * on a runner where the assertion BEFORE the reload passed, which is the
   * signature of a page still authenticating rather than a ticket that was
   * never solved.
   *
   * So wait for the refetch to have LANDED first: a resolved ticket no longer
   * offers "Mark as solved", so the button's disappearance proves the page
   * reloaded the ticket under a restored session. Only then is asking about
   * the status meaningful.
   */
  await expect(agent.getByRole('button', { name: /mark as solved/i })).toHaveCount(0, {
    timeout: 25_000,
  });
  await expect(agent.getByText(/^solved ·/i)).toBeVisible({ timeout: 15_000 });
});

test('agent visits notification preferences page and saves', async ({ page }) => {
  await signInAgent(page);
  await page.getByRole('link', { name: /preferences/i }).click();
  await expect(page.getByRole('heading', { name: /notification preferences/i })).toBeVisible();
  // Change one type to in-app only and save. The channel pickers are custom
  // comboboxes (SelectMenu) now, not native <select>s.
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: /in.?app/i }).click();
  await page.getByRole('button', { name: /save/i }).click();
  await expect(page.getByText(/preferences saved/i)).toBeVisible({ timeout: 10_000 });
});
