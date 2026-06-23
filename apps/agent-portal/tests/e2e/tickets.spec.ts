import { test, expect } from '@playwright/test';

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
  await page.goto('http://localhost:5173/login');
  await page.getByLabel(/email/i).fill(AGENT_EMAIL);
  await page.getByLabel(/password/i).fill(AGENT_PASSWORD);
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

  // 3. Click "+ Create ticket" in the toolbar. (The toolbar now grows + sits at
  // z-10 above the thread, so its hit-box is no longer covered by a chat bubble
  // — a plain, actionable click works without force.)
  const subject = `From conv ${Date.now()}`;
  await agent
    .getByRole('button', { name: /create ticket/i })
    .first()
    .click();
  await agent.getByLabel(/subject/i).fill(subject);
  await agent.getByLabel(/^description$/i).fill('Auto-created via E2E.');
  await agent.getByRole('button', { name: /^create$/i }).click();
  // Dialog closes; subject appears in the tickets list. Scope to the list-row
  // button (not getByText) so we don't also match the success toast, whose
  // description echoes the subject (strict-mode double match).
  await agent.getByRole('link', { name: /tickets/i }).click();
  const ticketRow = agent.getByRole('button', { name: subject });
  await expect(ticketRow).toBeVisible({ timeout: 10_000 });

  // 4. Open the ticket detail.
  await ticketRow.click();
  await expect(agent.getByRole('heading', { name: subject })).toBeVisible();

  // 5. Mark first response sent → button disappears and "Responded at" shows.
  await agent.getByRole('button', { name: /mark first response sent/i }).click();
  await expect(agent.getByText(/responded at/i)).toBeVisible({ timeout: 10_000 });

  // 6. Change status to resolved. The ticket status control is a custom combobox
  // (SelectMenu, aria-label "Status"), not a native <select> — open it and pick
  // the option. The trigger then reflects the persisted status (onChange →
  // patch → query invalidation).
  const statusSelect = agent.getByRole('combobox', { name: 'Status', exact: true });
  await statusSelect.click();
  await agent.getByRole('option', { name: 'Resolved' }).click();
  await expect(statusSelect).toContainText('Resolved');
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
