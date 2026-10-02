import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const request = vi.fn();
vi.mock('@yiji/shared-config', () => ({
  createServiceClient: () => ({ request }),
}));

import { GatewayDirectus } from '../src/directus.js';

const gateway = () => new GatewayDirectus('http://localhost:8055', 'svc-token');
const read = (rel: string) => readFileSync(resolve(import.meta.dirname, '..', rel), 'utf8');

beforeEach(() => request.mockReset());

/** What a recorded Directus SDK call would really have sent. */
async function bodyOf(call: number): Promise<Record<string, unknown>> {
  const cmd = request.mock.calls[call]![0] as (c: unknown) => Promise<{ body?: string }>;
  const out = await cmd({ globals: {} });
  return out.body ? (JSON.parse(out.body) as Record<string, unknown>) : {};
}

/**
 * A RETURNING CUSTOMER GETS THE SAME THREAD AND A NEW PROMISE.
 *
 * The owner's model, restated (2026-10-03): one conversation per contact,
 * never forked — but a customer who writes again days later is starting a NEW
 * session, not resuming the old one, and no agent should have to press
 * "Reopen" for that to be true.
 *
 * The reopen itself already worked. What did not was the SLA, and it was
 * invisible. MEASURED ON PRODUCTION, conversation `63c22abf`:
 *
 *     29 Sep 17:50  customer wrote
 *     29 Sep 17:52  agent replied          -> first_responded_at stamped
 *      2 Oct 10:17  solved
 *      2 Oct 10:16  customer wrote AGAIN
 *      2 Oct 11:39  agent replied          -> 83 MINUTES later
 *
 * The chat still reports a two-minute first response and no breach, because
 * `first_responded_at` was never cleared — and the sweep skips any chat that
 * already carries one (`sla.ts:451`). Every session after the first was
 * unmeasurable: the [[silent-empty-failures]] shape again, a promise that
 * cannot be broken because nothing is watching.
 */
describe('a customer writing into a solved chat', () => {
  /** persistMessage reads the conversation, then patches it. */
  const solvedThen = (status: string) => {
    request
      .mockResolvedValueOnce({ id: 'msg-1', date_created: '2026-10-03T09:00:00.000Z' })
      .mockResolvedValueOnce([{ unread_count_agent: 2, status }])
      .mockResolvedValueOnce(undefined);
  };

  it.each(['solved', 'resolved', 'closed'])('reopens a %s chat with no agent click', async (s) => {
    solvedThen(s);
    await gateway().persistMessage({
      conversationId: 'convo-1',
      senderType: 'customer',
      content: 'any update?',
    } as never);
    const patch = await bodyOf(2);
    expect(patch).toMatchObject({ status: 'open', solved_at: null });
  });

  /*
   * THE REGRESSION ITSELF. Leaving these three set is what made the 83-minute
   * wait above invisible.
   */
  it('starts the first-response promise again', async () => {
    solvedThen('solved');
    await gateway().persistMessage({
      conversationId: 'convo-1',
      senderType: 'customer',
      content: 'hello again',
    } as never);
    expect(await bodyOf(2)).toMatchObject({
      first_responded_at: null,
      first_response_due_at: null,
      first_response_breached_at: null,
    });
  });

  /*
   * AND IT RECORDS WHEN THE NEW SESSION BEGAN.
   *
   * Without this the sweep measures from `date_created` — the original
   * message, possibly weeks old — so the recomputed deadline is already past
   * and the chat breaches on sight, paging an agent for being slow to a
   * message that arrived seconds ago.
   */
  it('stamps when this session started', async () => {
    solvedThen('solved');
    await gateway().persistMessage({
      conversationId: 'convo-1',
      senderType: 'customer',
      content: 'hello again',
    } as never);
    const patch = await bodyOf(2);
    expect(typeof patch.session_started_at).toBe('string');
    expect(Number.isNaN(Date.parse(patch.session_started_at as string))).toBe(false);
  });

  /*
   * A LIVE CHAT IS NOT REOPENED, AND ITS CLOCK IS NOT RESTARTED.
   *
   * A customer who sends three messages while waiting must not push their own
   * deadline further away each time — that would make the promise
   * unbreakable, which is the same failure wearing the opposite mask.
   */
  it.each(['open', 'pending'])('leaves a %s chat’s clock alone', async (s) => {
    solvedThen(s);
    await gateway().persistMessage({
      conversationId: 'convo-1',
      senderType: 'customer',
      content: 'still waiting',
    } as never);
    const patch = await bodyOf(2);
    expect(patch).not.toHaveProperty('first_responded_at');
    expect(patch).not.toHaveProperty('session_started_at');
    expect(patch).not.toHaveProperty('status');
  });

  /* The thread is still the SAME one — resumption of identity, not of the
     promise. The fork bug must not come back while fixing the clock. */
  it('never creates a second conversation', async () => {
    request.mockResolvedValueOnce([{ id: 'convo-live' }]);
    const r = await gateway().findOrCreateConversation('vendor-1', 'contact-1');
    expect(r).toEqual({ id: 'convo-live', created: false });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

/**
 * The sweep is the other half: it must measure from the session, and it must
 * SELECT the field it measures from.
 */
describe('the first-response sweep', () => {
  const SLA = read('../workers/src/processors/sla.ts');
  const REPOS = read('../workers/src/processors/directus-repos.ts');

  it('measures from the session start, falling back to creation', () => {
    expect(SLA).toMatch(/c\.session_started_at \?\? c\.date_created/);
  });

  /*
   * A FIELD READ BUT NEVER SELECTED IS ALWAYS UNDEFINED. It would fall back to
   * `date_created` silently and breach every reopened chat on sight — the
   * fix's own failure mode, and one that would have looked like the fix
   * working.
   */
  it('selects that field', () => {
    expect(REPOS).toContain("'session_started_at'");
  });

  /* The policy cutoff must use the same clock, or a chat whose THREAD predates
     the policy is excused for ever, however many new sessions it has. */
  it('applies the policy cutoff to the session too', () => {
    expect(SLA).toMatch(/predatesPolicy\(c\.session_started_at \?\? c\.date_created/);
  });
});
