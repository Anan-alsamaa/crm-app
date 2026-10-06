import { describe, it, expect, vi, beforeEach } from 'vitest';

const request = vi.fn();
vi.mock('@yiji/shared-config', () => ({
  createServiceClient: () => ({ request }),
}));

import { GatewayDirectus } from '../src/directus.js';

/**
 * THE AUTOMATIC WELCOME IS NOT AN ANSWER (owner, 2026-10-06) — at the write.
 *
 * `persistMessage` is the single funnel that stamps `first_responded_at` and
 * clears the agent's unread count on an agent message. The welcome is
 * agent-styled but sent by nobody, so it must do neither: the customer is still
 * waiting for a person, the SLA clock must keep running, and the chat must stay
 * unread in the inbox.
 */
const gateway = () => new GatewayDirectus('http://localhost:8055', 'svc-token');
beforeEach(() => request.mockReset());

async function bodyOf(call: number): Promise<Record<string, unknown>> {
  const cmd = request.mock.calls[call]![0] as (c: unknown) => Promise<{ body?: string }>;
  const out = await cmd({ globals: {} });
  return out.body ? (JSON.parse(out.body) as Record<string, unknown>) : {};
}
function paramsOf(call: number): Record<string, unknown> {
  const cmd = request.mock.calls[call]![0] as () => { params?: Record<string, unknown> };
  return cmd().params ?? {};
}

describe('persisting the automatic welcome', () => {
  it('neither stamps first_responded_at nor clears the unread count', async () => {
    request
      .mockResolvedValueOnce({ id: 'msg-w' }) // create message
      .mockResolvedValueOnce(undefined); // patch conversation
    await gateway().persistMessage({
      conversationId: 'conv-1',
      senderType: 'agent',
      content: 'Welcome',
    });
    // Exactly two calls: no "is it still unanswered?" read in between.
    expect(request).toHaveBeenCalledTimes(2);
    expect(await bodyOf(0)).toMatchObject({ sender_type: 'agent', sender_user: null });
    const patch = await bodyOf(1);
    expect(patch).toHaveProperty('last_message_at');
    expect(patch).not.toHaveProperty('first_responded_at');
    expect(patch).not.toHaveProperty('unread_count_agent');
  });

  /* The control: a PERSON's reply still stops the clock. */
  it('a human reply still stamps the first response', async () => {
    request
      .mockResolvedValueOnce({ id: 'msg-h' })
      .mockResolvedValueOnce([{ id: 'conv-1' }])
      .mockResolvedValueOnce(undefined);
    await gateway().persistMessage({
      conversationId: 'conv-1',
      senderType: 'agent',
      senderUser: 'agent-7',
      content: 'Hi, checking now',
    });
    expect(await bodyOf(2)).toMatchObject({ unread_count_agent: 0 });
    expect(await bodyOf(2)).toHaveProperty('first_responded_at');
  });
});

describe('a reopen is a new session that is owed the welcome', () => {
  const reopen = (initiated_by: string | null) =>
    request
      .mockResolvedValueOnce({ id: 'msg-c' })
      .mockResolvedValueOnce([{ unread_count_agent: 0, status: 'solved', initiated_by }])
      .mockResolvedValueOnce(undefined);

  it('reports sessionStarted for a customer-started chat', async () => {
    reopen(null);
    const r = await gateway().persistMessage({
      conversationId: 'conv-1',
      senderType: 'customer',
      content: 'hello again',
    });
    expect(r.sessionStarted).toBe(true);
    expect(paramsOf(1).fields).toContain('initiated_by');
  });

  /* An agent-initiated chat is never greeted (owner, 2026-10-05). */
  it('does NOT for an agent-initiated chat', async () => {
    reopen('agent');
    const r = await gateway().persistMessage({
      conversationId: 'conv-1',
      senderType: 'customer',
      content: 'hello again',
    });
    expect(r.sessionStarted).toBeUndefined();
  });

  it('does NOT for a message into a chat that is already open', async () => {
    request
      .mockResolvedValueOnce({ id: 'msg-c' })
      .mockResolvedValueOnce([{ unread_count_agent: 1, status: 'open', initiated_by: null }])
      .mockResolvedValueOnce(undefined);
    const r = await gateway().persistMessage({
      conversationId: 'conv-1',
      senderType: 'customer',
      content: 'still there?',
    });
    expect(r.sessionStarted).toBeUndefined();
  });
});

describe('idle-close reads past the welcome', () => {
  /* Otherwise the welcome is the "agent's last word" and idle-close would shut
     the chat five minutes later with the customer still waiting. */
  it('lastSenderType skips the automatic welcome', async () => {
    request.mockResolvedValueOnce([
      { sender_type: 'agent', sender_user: null },
      { sender_type: 'customer', sender_user: null },
    ]);
    expect(await gateway().lastSenderType('conv-1')).toBe('customer');
    expect(paramsOf(0).fields).toContain('sender_user');
  });

  it('still reports a real agent reply as the last word', async () => {
    request.mockResolvedValueOnce([
      { sender_type: 'agent', sender_user: 'agent-7' },
      { sender_type: 'agent', sender_user: null },
    ]);
    expect(await gateway().lastSenderType('conv-1')).toBe('agent');
  });
});

describe('history marks the welcome for the widget', () => {
  /* So the widget never takes it as proof an agent is present. */
  it('flags automated on a null-sender agent row', async () => {
    request
      .mockResolvedValueOnce([
        {
          id: 'm2',
          sender_type: 'agent',
          sender_user: null,
          content: 'Welcome',
          date_created: '2026-10-06T09:00:01Z',
        },
        {
          id: 'm1',
          sender_type: 'customer',
          sender_user: null,
          content: 'hi',
          date_created: '2026-10-06T09:00:00Z',
        },
      ])
      .mockResolvedValueOnce([]);
    const h = await gateway().loadConversationMessages('conv-1');
    expect(h.map((m) => [m.id, m.automated ?? false])).toEqual([
      ['m1', false],
      ['m2', true],
    ]);
  });
});
