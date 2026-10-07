import { describe, it, expect } from 'vitest';
import {
  agentInitiatedSummary,
  agentPerformance,
  awaitingCustomer,
  firstResponseSec,
  splitBySla,
  timeToSolveSec,
  type ChatTiming,
} from '../src/agent-performance.js';
import { performanceSummary } from '../src/agent-performance-view.js';
import { conversationTimestamps } from '../src/chat-timings.js';

/**
 * AGENT-STARTED CHATS (owner, 2026-10-07). Shatha closed an agent-started chat
 * (#1330242) the same afternoon, yet "Chat by chat" showed "No reply yet" and
 * "Still open": every measure started from the customer's first message, and
 * the customer never wrote. Such a chat has nothing to respond to; it is not
 * unanswered, not late, and — once closed — not open.
 */

const chat = (over: Partial<ChatTiming>): ChatTiming => ({
  conversationId: 'c',
  agentId: 'shatha',
  agentName: 'Shatha',
  firstCustomerAt: null,
  firstAgentAt: null,
  solvedAt: null,
  ...over,
});

// The real one: outreach at 12:25, never answered, closed at 13:35 UTC.
const SHATHA = chat({
  conversationId: 'e32eac0b',
  initiatedBy: 'agent',
  firstOutreachAt: '2026-10-06T12:25:33Z',
  firstAgentAt: '2026-10-06T12:25:33Z',
  solvedAt: '2026-10-06T13:35:18Z',
});

describe('an agent-started chat the customer never answered', () => {
  it('is awaiting the customer, not unanswered', () => {
    expect(awaitingCustomer(SHATHA)).toBe(true);
    expect(agentPerformance([SHATHA])[0]!.unanswered).toBe(0);
    expect(performanceSummary([SHATHA], 300).unanswered).toBe(0);
  });

  it('is neither in time nor late', () => {
    const { met, missed } = splitBySla([SHATHA], 300);
    expect(met).toEqual([]);
    expect(missed).toEqual([]);
    expect(performanceSummary([SHATHA], 300).metPct).toBeNull();
  });

  it('is counted as closed without a customer reply', () => {
    expect(agentInitiatedSummary([SHATHA])).toMatchObject({
      started: 1,
      customerReplied: 0,
      replyRatePct: 0,
      closedWithoutReply: 1,
    });
  });
});

describe('an agent-started chat the customer answered', () => {
  const ANSWERED = chat({
    initiatedBy: 'agent',
    firstOutreachAt: '2026-10-06T10:00:00Z',
    firstCustomerAt: '2026-10-07T09:00:00Z', // the next morning
    firstAgentAt: '2026-10-07T09:02:00Z',
    solvedAt: '2026-10-07T09:30:00Z',
  });

  it('measures the agent from the customer’s reply, not from the outreach', () => {
    expect(firstResponseSec(ANSWERED)).toBe(120);
    expect(timeToSolveSec(ANSWERED)).toBe(30 * 60);
  });

  it('reports how fast the customer answered, separately', () => {
    expect(agentInitiatedSummary([ANSWERED])).toMatchObject({
      started: 1,
      customerReplied: 1,
      replyRatePct: 100,
      medianCustomerReplySec: 23 * 3600,
      medianHandlingSec: 30 * 60,
      closedWithoutReply: 0,
    });
  });
});

describe('customer-started chats are unchanged', () => {
  it('still count an unanswered chat as unanswered and missed', () => {
    const silent = chat({ firstCustomerAt: '2026-10-06T10:00:00Z' });
    expect(awaitingCustomer(silent)).toBe(false);
    expect(performanceSummary([silent], 300).unanswered).toBe(1);
    expect(splitBySla([silent], 300).missed).toHaveLength(1);
  });
});

describe('conversationTimestamps', () => {
  it('reports the outreach time of an agent-started chat', () => {
    const t = conversationTimestamps([
      {
        conversation: 'c',
        sender_type: 'agent',
        date_created: '2026-10-06T12:25:33Z',
        sender_user: 'shatha',
      },
    ]).get('c')!;
    expect(t.firstAgentAnyAt).toBe('2026-10-06T12:25:33Z');
    expect(t.firstCustomerAt).toBeNull();
  });
});
