import { describe, it, expect } from 'vitest';
import { conversationTimestamps, firstResponseSec, type TimingMessage } from '../src/index.js';

const m = (
  conversation: string,
  sender_type: string,
  date_created: string | null,
): TimingMessage => ({ conversation, sender_type, date_created });

describe('conversationTimestamps', () => {
  it('ignores an agent message sent BEFORE the customer wrote', () => {
    // The bug this exists for: an agent greeting at 06:14, the customer writing
    // at 07:00, the real reply at 09:01. Taking the first agent message overall
    // gave a negative interval, which the duration guard discarded as null, and
    // the page rendered "No reply" for a chat with three agent replies in it.
    const t = conversationTimestamps([
      m('c1', 'agent', '2026-08-13T06:14:00.000Z'),
      m('c1', 'customer', '2026-08-13T07:00:00.000Z'),
      m('c1', 'agent', '2026-08-13T09:01:00.000Z'),
    ]).get('c1')!;
    expect(t.firstCustomerAt).toBe('2026-08-13T07:00:00.000Z');
    expect(t.firstAgentAt).toBe('2026-08-13T09:01:00.000Z');
    expect(
      firstResponseSec({
        conversationId: 'c1',
        agentId: null,
        agentName: '',
        solvedAt: null,
        ...t,
      }),
    ).toBe(7260); // 2h 1m, not null
  });

  it('still reports no reply when every agent message predates the customer', () => {
    const t = conversationTimestamps([
      m('c1', 'agent', '2026-08-13T06:14:00.000Z'),
      m('c1', 'customer', '2026-08-13T07:00:00.000Z'),
    ]).get('c1')!;
    // Nobody has answered what the customer actually said.
    expect(t.firstAgentAt).toBeNull();
  });

  it('takes an agent message at the same instant as the customer', () => {
    const at = '2026-08-13T07:00:00.000Z';
    expect(
      conversationTimestamps([m('c1', 'customer', at), m('c1', 'agent', at)]).get('c1')!
        .firstAgentAt,
    ).toBe(at);
  });

  it('keeps the agent message when the customer never wrote', () => {
    // An outreach chat. There is no interval to measure, but the chat is not
    // "unanswered" in the sense the report means.
    const t = conversationTimestamps([m('c1', 'agent', '2026-08-13T06:14:00.000Z')]).get('c1')!;
    expect(t.firstCustomerAt).toBeNull();
    expect(t.firstAgentAt).toBe('2026-08-13T06:14:00.000Z');
  });

  it('does not trust the caller to have sorted the messages', () => {
    // A caller that forgets `sort: ['date_created']` should get the right
    // answer, not a plausible wrong one.
    const t = conversationTimestamps([
      m('c1', 'agent', '2026-08-13T09:01:00.000Z'),
      m('c1', 'customer', '2026-08-13T08:00:00.000Z'),
      m('c1', 'agent', '2026-08-13T08:30:00.000Z'),
      m('c1', 'customer', '2026-08-13T07:00:00.000Z'),
    ]).get('c1')!;
    expect(t.firstCustomerAt).toBe('2026-08-13T07:00:00.000Z');
    expect(t.firstAgentAt).toBe('2026-08-13T08:30:00.000Z');
  });

  it('keeps conversations apart', () => {
    const all = conversationTimestamps([
      m('c1', 'customer', '2026-08-13T07:00:00.000Z'),
      m('c2', 'customer', '2026-08-13T07:30:00.000Z'),
      m('c2', 'agent', '2026-08-13T07:31:00.000Z'),
    ]);
    expect(all.get('c1')!.firstAgentAt).toBeNull();
    expect(all.get('c2')!.firstAgentAt).toBe('2026-08-13T07:31:00.000Z');
  });

  it('skips system messages and undated rows', () => {
    const t = conversationTimestamps([
      m('c1', 'system', '2026-08-13T06:00:00.000Z'),
      m('c1', 'customer', '2026-08-13T07:00:00.000Z'),
      m('c1', 'agent', null),
      m('c1', 'agent', '2026-08-13T07:05:00.000Z'),
    ]).get('c1')!;
    // A system line is not a reply, and a row with no timestamp cannot be one.
    expect(t.firstAgentAt).toBe('2026-08-13T07:05:00.000Z');
  });
});
