import { test, expect } from '@playwright/test';

/**
 * US2 (T042) — widget ↔ agent realtime round-trip.
 * Seeded agent (E2E_AGENT_EMAIL/PASSWORD) signs into the portal via the UI,
 * then a customer sends a message via the widget; the agent sees it in their
 * inbox and replies, and the customer widget receives the reply.
 */
const AGENT_EMAIL = process.env.E2E_AGENT_EMAIL!;
const AGENT_PASSWORD = process.env.E2E_AGENT_PASSWORD!;

test('customer message reaches the agent and the agent reply returns', async ({ browser }) => {
  // 1. Customer opens the widget demo (mints its own JWT) and sends a message.
  const customer = await browser.newPage();
  await customer.goto('http://localhost:5175/');
  // The demo host page mounts with `autoOpen: true`, so the panel is already
  // open. Do NOT click the launcher here — it is a toggle that stays mounted
  // while open, so clicking it would CLOSE the panel. That also detaches
  // `yiji-status`, making the wait below pass for the wrong reason and leaving
  // no message box to type into.
  // Wait until the widget has finished onboarding (status banner disappears).
  await customer.getByTestId('yiji-status').waitFor({ state: 'detached', timeout: 15_000 });
  const text = `Hello ${Date.now()}`;
  await customer.getByPlaceholder(/type a message/i).fill(text);
  await customer.keyboard.press('Enter');
  // Optimistic local insert means the customer sees their own message immediately.
  await expect(customer.getByText(text).first()).toBeVisible({ timeout: 10_000 });

  // 2. Agent signs into the portal via the UI (seeded by globalSetup).
  const agent = await browser.newPage();
  await agent.goto('http://localhost:5173/login');
  await agent.getByLabel(/email/i).fill(AGENT_EMAIL);
  await agent.getByLabel(/password/i).fill(AGENT_PASSWORD);
  await agent.getByRole('button', { name: /sign in/i }).click();
  await expect(agent.getByRole('heading', { name: /shared inbox/i })).toBeVisible({
    timeout: 10_000,
  });

  // 3. The conversation appears in the inbox; open it and see the customer's message.
  const firstConvo = agent.locator('aside li button').first();
  await firstConvo.waitFor({ timeout: 15_000 });
  await firstConvo.click();
  await expect(agent.getByText(text)).toBeVisible({ timeout: 15_000 });

  // 4. Agent replies and the customer widget receives it in realtime.
  const reply = `On it ${Date.now()}`;
  await agent.getByPlaceholder(/type a reply/i).fill(reply);
  await agent.keyboard.press('Enter');
  await expect(customer.getByText(reply)).toBeVisible({ timeout: 15_000 });
});
