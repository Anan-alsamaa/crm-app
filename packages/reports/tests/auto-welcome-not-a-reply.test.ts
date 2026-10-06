import { describe, it, expect } from 'vitest';
import { conversationTimestamps, firstResponseSec, type TimingMessage } from '../src/index.js';

/**
 * THE AUTOMATIC WELCOME IS NOT A FIRST RESPONSE (owner, 2026-10-06).
 *
 * It is stored as `sender_type 'agent'` with `sender_user` null and lands a
 * second after the customer's first message. Counted, every chat would report
 * a ~1-second first response and a 100% "replied within 5 minutes", credited
 * to nobody — the KPI meaning nothing while looking excellent.
 */
const at = (min: number) => new Date(Date.UTC(2026, 9, 6, 9, min)).toISOString();
const row = (
  sender_type: string,
  minute: number,
  sender_user: string | null | undefined,
): TimingMessage => ({
  conversation: 'c1',
  sender_type,
  date_created: at(minute),
  ...(sender_user === undefined ? {} : { sender_user }),
});

describe('conversationTimestamps and the automatic welcome', () => {
  it('skips the welcome and measures to the first HUMAN reply', () => {
    const t = conversationTimestamps([
      row('customer', 0, null),
      row('agent', 0, null), // the automatic welcome
      row('agent', 12, 'agent-7'),
    ]).get('c1')!;
    expect(t.firstAgentAt).toBe(at(12));
    expect(t.firstAgentBy).toBe('agent-7');
    expect(
      firstResponseSec({
        conversationId: 'c1',
        agentId: null,
        agentName: '',
        solvedAt: null,
        ...t,
      }),
    ).toBe(12 * 60);
  });

  it('a chat answered ONLY by the welcome is still awaiting a reply', () => {
    const t = conversationTimestamps([row('customer', 0, null), row('agent', 0, null)]).get('c1')!;
    expect(t.firstCustomerAt).toBe(at(0));
    expect(t.firstAgentAt).toBeNull();
  });

  /* A caller that never SELECTED `sender_user` must not lose every reply: an
     absent field is unknown, not "automated". */
  it('keeps the old behaviour when sender_user was not requested', () => {
    const t = conversationTimestamps([
      row('customer', 0, undefined),
      row('agent', 3, undefined),
    ]).get('c1')!;
    expect(t.firstAgentAt).toBe(at(3));
  });
});
