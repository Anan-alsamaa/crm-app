import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/* Same harness as directus.test.ts: canned rows in call order, so the real
   resume-or-create logic runs rather than a restatement of it. */
const request = vi.fn();
vi.mock('@yiji/shared-config', () => ({
  createServiceClient: () => ({ request }),
}));

import { GatewayDirectus } from '../src/directus.js';
import { AgentInitiateRequest, normalizePhone } from '@yiji/shared-types';

const gateway = () => new GatewayDirectus('http://localhost:8055', 'svc-token');

beforeEach(() => request.mockReset());

/**
 * What a recorded call WOULD have sent.
 *
 * A Directus SDK command is a function, not a payload — `JSON.stringify` on
 * the recorded argument yields `[null]` and an assertion against it passes or
 * fails for reasons unrelated to the code. Invoking it gives the real body.
 * Same helper as directus.test.ts.
 */
async function bodyOf(call: number): Promise<Record<string, unknown>> {
  const cmd = request.mock.calls[call]![0] as (c: unknown) => Promise<{ body?: string }>;
  const out = await cmd({ globals: {} });
  return out.body ? (JSON.parse(out.body) as Record<string, unknown>) : {};
}

/**
 * AN AGENT OPENS A CHAT WITH SOMEBODY WHO HAS NOT WRITTEN TO US.
 *
 * Every path before this one assumed the customer speaks first. This is the
 * other direction — a complaint taken by phone, a promised callback, a check
 * on a late order — and the two risks it carries are both about identity:
 * creating a SECOND contact for a customer who already exists, and forking a
 * SECOND conversation for a customer who already has one.
 */
describe('startConversationWithCustomer', () => {
  /*
   * THE DUPLICATE-CONTACT RISK. An agent types whatever is in front of them —
   * `+966 50 123 4567` off a complaint form, `0501234567` off a report. Every
   * stored number is canonical `05XXXXXXXX`, so an unnormalised lookup finds
   * nothing and creates a second row for a customer who is already there.
   * That took a 70-row migration to clean up the last time it happened.
   */
  it.each([
    ['+966501234567', '0501234567'],
    ['00966501234567', '0501234567'],
    ['966501234567', '0501234567'],
    ['0501234567', '0501234567'],
    ['501234567', '0501234567'],
  ])('resolves %s to the one canonical contact %s', async (typed, canonical) => {
    expect(normalizePhone(typed)).toBe(canonical);
  });

  it('reuses the contact that already holds that number', async () => {
    request
      // upsertContact -> findExisting
      .mockResolvedValueOnce([
        { id: 'contact-1', name: 'Noura', phone: '0501234567', external_customer_id: 'yiji-9' },
      ])
      // findOrCreateConversation -> no live thread
      .mockResolvedValueOnce([])
      // ...so it creates one
      .mockResolvedValueOnce({ id: 'convo-new' });

    const r = await gateway().startConversationWithCustomer('vendor-uuid', '0501234567');

    expect(r.contactId).toBe('contact-1');
    expect(r.contactIsNew).toBe(false);
    expect(r.name).toBe('Noura');
  });

  /*
   * THE FORKED-CONVERSATION RISK, AND IT IS WORSE HERE.
   *
   * A customer who writes in can at least see their own history. An agent
   * typing a phone number CANNOT see that this person already has a live
   * thread, so a fork here splits a conversation nobody knows is split.
   */
  it('joins an existing thread instead of forking a second one', async () => {
    request
      .mockResolvedValueOnce([
        { id: 'contact-1', name: null, phone: '0501234567', external_customer_id: null },
      ])
      .mockResolvedValueOnce([{ id: 'convo-live' }]);

    const r = await gateway().startConversationWithCustomer('vendor-uuid', '0501234567');

    expect(r.conversationId).toBe('convo-live');
    expect(r.created).toBe(false);
    /* Nothing was created: the third call never happened. */
    expect(request).toHaveBeenCalledTimes(2);
  });

  /*
   * `initiated_by` IS ONLY STAMPED ON A CHAT THIS CALL CREATES.
   *
   * Joining a customer's own thread must leave it theirs. They are owed a
   * first response on it, and marking it agent-initiated would remove it from
   * the SLA sweep — cancelling a promise the customer is still waiting on.
   */
  it('stamps a chat it creates as agent-initiated', async () => {
    request
      .mockResolvedValueOnce([
        { id: 'contact-1', name: null, phone: '0501234567', external_customer_id: null },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ id: 'convo-new' });

    await gateway().startConversationWithCustomer('vendor-uuid', '0501234567');

    expect(await bodyOf(2)).toMatchObject({ initiated_by: 'agent' });
  });

  /* The other half of the same rule, stated against the write itself. */
  it('leaves a joined thread marked as the customer’s', async () => {
    request
      .mockResolvedValueOnce([
        { id: 'contact-1', name: null, phone: '0501234567', external_customer_id: null },
      ])
      .mockResolvedValueOnce([{ id: 'convo-live' }]);

    await gateway().startConversationWithCustomer('vendor-uuid', '0501234567');
    /* Two reads, no write — there is no conversation payload to stamp. */
    expect(request).toHaveBeenCalledTimes(2);
  });

  /*
   * A TYPED NUMBER IS NOT A PROVEN YIJI ACCOUNT.
   *
   * `external_customer_id` is sent to Yiji as a real `userId` by the coupon
   * push. A phone-derived handle written there would address a grant to a
   * customer that does not exist on their side — which is why the upsert mints
   * `cust-<digits>` as the SESSION id and leaves the Yiji column null.
   */
  it('never invents a Yiji id for a number an agent typed', async () => {
    request
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ id: 'contact-new' })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ id: 'convo-new' });

    const r = await gateway().startConversationWithCustomer('vendor-uuid', '0501234567');

    expect(r.contactIsNew).toBe(true);
    /* NULL, not the minted `cust-<digits>` handle: that column is sent to Yiji
       as a real `userId` by the coupon push, and a fabricated value there
       addresses a grant to a customer that does not exist on their side. */
    expect(await bodyOf(1)).toMatchObject({ external_customer_id: null });
  });
});

/**
 * WHO MAY START A CHAT (owner, 2026-10-03): every WeCare role, plus the agents
 * and admins already trusted with the other staff endpoints.
 *
 * Asserted against the SOURCE because `requireRole` is wired to a live
 * Directus token check. What matters is the SPELLING: the gateway compares a
 * string to the role name Directus holds, so "Wecare Agent" is not a visible
 * error — it is a 403 for somebody who should have been allowed, which reads
 * to them as the feature being broken rather than as a permission problem.
 *
 * These six were read off the live production role list, not guessed.
 */
describe('who may open a chat', () => {
  const INDEX = readFileSync(resolve(import.meta.dirname, '..', 'src/index.ts'), 'utf8');

  /*
   * BY THE `start_chats` PERMISSION since 2026-10-06 (owner): the Roles page
   * decides it. Its default reproduces the old role list exactly — every
   * WeCare role plus Admin, Administrator and Agent — which is asserted in
   * packages/shared-types/tests/privileges-mirror.test.ts.
   */
  it('gates the endpoint on the permission, not a role name', () => {
    expect(INDEX).toMatch(/requirePrivilege\(req, reply, 'start_chats'\)/);
    expect(INDEX).not.toMatch(/CHAT_INITIATE_ROLES/);
  });

  /*
   * STAFF_ROLES ITSELF MUST NOT BE WIDENED. It guards other endpoints, and
   * granting those to three more roles as a side effect of adding a feature is
   * exactly the kind of change that passes review unnoticed.
   */
  it('does not widen the shared staff role set', () => {
    expect(INDEX).toMatch(/const STAFF_ROLES = new Set\(\[\.\.\.ADMIN_ROLES, 'Agent'\]\)/);
  });
});

/**
 * THE REQUEST CONTRACT.
 *
 * No message field: this endpoint does not send one. The agent's socket sends
 * through the ordinary path, which already persists, broadcasts and enqueues
 * the customer push — and that push is the half the whole feature depends on.
 */
describe('AgentInitiateRequest', () => {
  it('takes a phone and a vendor', () => {
    expect(AgentInitiateRequest.safeParse({ phone: '0501234567', vendorId: 'yiji' }).success).toBe(
      true,
    );
  });

  it.each([
    ['no vendor', { phone: '0501234567' }],
    ['no phone', { vendorId: 'yiji' }],
    ['an empty phone', { phone: '', vendorId: 'yiji' }],
  ])('refuses a request with %s', (_label, body) => {
    expect(AgentInitiateRequest.safeParse(body).success).toBe(false);
  });

  /* Deliberately absent, so the two send paths cannot drift apart. */
  it('carries no message', () => {
    const parsed = AgentInitiateRequest.safeParse({
      phone: '0501234567',
      vendorId: 'yiji',
      message: 'hello',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'message' in parsed.data).toBe(false);
  });
});
