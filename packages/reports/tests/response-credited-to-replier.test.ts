import { describe, it, expect } from 'vitest';
import { agentPerformance, conversationTimestamps, type ChatTiming } from '../src/index.js';

/**
 * A FIRST RESPONSE BELONGS TO THE AGENT WHO SENT IT.
 *
 * The bug this fixes (owner-reported, 2026-09-30): "avg first response time and
 * replied within 5 minutes values are empty" on the Admin KPI agent summary.
 *
 * Not missing data — checked against live production first: `sender_type` is
 * exactly agent/customer, the internal-note filter matches 470 of 471 rows, and
 * all 20 conversations in a sample had a measurable first response. The cause was
 * arithmetic: the timings were computed only over chats the routing ladder had
 * NOT passed on, and on production the ladder broadcasts or escalates
 * EVERYTHING — `passedOn` was true for all 46 of 46 conversations, so the
 * population was always empty and `mean([])` is null.
 *
 * The fairness that exclusion protected is real and is kept: an agent must not
 * be charged for seconds an earlier agent spent not answering. It is now
 * delivered by crediting the ACTUAL SENDER rather than by discarding the chat.
 */

const chat = (over: Partial<ChatTiming> = {}): ChatTiming => ({
  conversationId: 'c1',
  agentId: 'a1',
  agentName: 'Sara',
  firstCustomerAt: '2026-08-13T10:00:00.000Z',
  firstAgentAt: '2026-08-13T10:01:00.000Z', // 60s
  solvedAt: null,
  ...over,
});

describe('first response is credited to whoever replied', () => {
  /* THE REGRESSION TEST FOR THE REPORTED BUG. Every chat passed on — the live
     production shape — must still produce a number. */
  it('still measures when EVERY chat was passed on', () => {
    const rows = agentPerformance([
      chat({ conversationId: 'c1', passedOn: true, firstAgentBy: 'a1' }),
      chat({ conversationId: 'c2', passedOn: true, firstAgentBy: 'a1' }),
    ]);
    const sara = rows.find((r) => r.agentId === 'a1')!;
    expect(sara.avgFirstResponseSec).toBe(60);
    expect(sara.answered).toBe(2);
  });

  /*
   * THE FAIRNESS, PRESERVED. a1 holds the chat but a2 answered it, so the wait
   * belongs to a2's measurement and a1 is charged nothing — which is exactly
   * what the old exclusion was protecting, achieved without dropping the row.
   */
  it('charges the replier, not the agent who merely holds the chat', () => {
    const rows = agentPerformance([
      chat({
        conversationId: 'c1',
        agentId: 'a1',
        agentName: 'Sara',
        passedOn: true,
        firstAgentBy: 'a2',
        firstAgentAt: '2026-08-13T10:30:00.000Z', // 1800s
      }),
    ]);
    const sara = rows.find((r) => r.agentId === 'a1')!;
    const omar = rows.find((r) => r.agentId === 'a2')!;
    expect(sara.avgFirstResponseSec).toBeNull();
    expect(omar.avgFirstResponseSec).toBe(1800);
  });

  /* An agent who answered a chat later handed to somebody else holds nothing in
     range, and must still appear — otherwise their work is invisible. */
  it('gives a row to an agent who replied but holds no chats', () => {
    const rows = agentPerformance([
      chat({ conversationId: 'c1', agentId: 'a1', firstAgentBy: 'a9', agentName: 'Sara' }),
    ]);
    const nine = rows.find((r) => r.agentId === 'a9');
    expect(nine).toBeDefined();
    expect(nine!.avgFirstResponseSec).toBe(60);
    // And it never renders as a blank name.
    expect(nine!.agentName.trim()).not.toBe('');
  });

  /*
   * NO MEASUREMENT MAY BE LOST. The whole family of bugs here is a filter that
   * matches nothing and reads as a plausible zero, so this asserts the
   * conservation law directly: every measurable response lands in exactly one
   * agent's total.
   */
  it('loses no response when replier and assignee differ', () => {
    const rows = agentPerformance([
      chat({ conversationId: 'c1', agentId: 'a1', firstAgentBy: 'a2' }),
      chat({ conversationId: 'c2', agentId: 'a2', firstAgentBy: 'a1' }),
      chat({ conversationId: 'c3', agentId: 'a3', firstAgentBy: 'a3' }),
    ]);
    const counted = rows.reduce((n, r) => n + r.answered, 0);
    expect(counted).toBe(3);
  });

  /* BACKWARD COMPATIBLE: a caller that reads neither `sender_user` nor routing
     events keeps the assignee attribution it always had. */
  it('falls back to the assignee when the sender is unknown', () => {
    const rows = agentPerformance([chat({ conversationId: 'c1', agentId: 'a1' })]);
    expect(rows[0]!.agentId).toBe('a1');
    expect(rows[0]!.avgFirstResponseSec).toBe(60);
  });

  /* `takenBy` is the middle rung of evidence: worse than the real sender, better
     than the assignee. It is what the routing history already knows. */
  it('uses takenBy when the sender is unknown but the history is not', () => {
    const rows = agentPerformance([
      chat({ conversationId: 'c1', agentId: 'a1', passedOn: true, takenBy: 'a2' }),
    ]);
    const omar = rows.find((r) => r.agentId === 'a2')!;
    expect(omar.avgFirstResponseSec).toBe(60);
    expect(rows.find((r) => r.agentId === 'a1')!.avgFirstResponseSec).toBeNull();
  });
});

describe('conversationTimestamps reports who replied', () => {
  it('names the sender of the first eligible reply', () => {
    const t = conversationTimestamps([
      { conversation: 'c1', sender_type: 'customer', date_created: '2026-08-13T10:00:00.000Z' },
      {
        conversation: 'c1',
        sender_type: 'agent',
        date_created: '2026-08-13T10:05:00.000Z',
        sender_user: 'a2',
      },
      {
        conversation: 'c1',
        sender_type: 'agent',
        date_created: '2026-08-13T10:09:00.000Z',
        sender_user: 'a3',
      },
    ]).get('c1')!;
    expect(t.firstAgentAt).toBe('2026-08-13T10:05:00.000Z');
    expect(t.firstAgentBy).toBe('a2');
  });

  /*
   * THE RULE THIS FILE'S SIBLING EXISTS FOR, now also about the sender: an agent
   * who greeted BEFORE the customer wrote did not respond to anything, so
   * neither their time nor their name may be taken as the response.
   */
  it('ignores an agent who wrote before the customer did', () => {
    const t = conversationTimestamps([
      {
        conversation: 'c1',
        sender_type: 'agent',
        date_created: '2026-08-13T09:00:00.000Z',
        sender_user: 'early',
      },
      { conversation: 'c1', sender_type: 'customer', date_created: '2026-08-13T10:00:00.000Z' },
      {
        conversation: 'c1',
        sender_type: 'agent',
        date_created: '2026-08-13T10:02:00.000Z',
        sender_user: 'real',
      },
    ]).get('c1')!;
    expect(t.firstAgentBy).toBe('real');
  });

  it('is null when nobody replied', () => {
    const t = conversationTimestamps([
      { conversation: 'c1', sender_type: 'customer', date_created: '2026-08-13T10:00:00.000Z' },
    ]).get('c1')!;
    expect(t.firstAgentBy).toBeNull();
  });

  /* A caller that does not request the field gets a null rather than a crash,
     and `agentPerformance` then falls back to the assignee. */
  it('is null when the caller did not ask for sender_user', () => {
    const t = conversationTimestamps([
      { conversation: 'c1', sender_type: 'customer', date_created: '2026-08-13T10:00:00.000Z' },
      { conversation: 'c1', sender_type: 'agent', date_created: '2026-08-13T10:01:00.000Z' },
    ]).get('c1')!;
    expect(t.firstAgentAt).toBe('2026-08-13T10:01:00.000Z');
    expect(t.firstAgentBy).toBeNull();
  });

  /* Sort order is not assumed anywhere else here, so it must not start being
     assumed now that a name travels with the time. */
  it('finds the earliest reply and its sender whatever the input order', () => {
    const t = conversationTimestamps([
      {
        conversation: 'c1',
        sender_type: 'agent',
        date_created: '2026-08-13T10:09:00.000Z',
        sender_user: 'late',
      },
      { conversation: 'c1', sender_type: 'customer', date_created: '2026-08-13T10:00:00.000Z' },
      {
        conversation: 'c1',
        sender_type: 'agent',
        date_created: '2026-08-13T10:03:00.000Z',
        sender_user: 'first',
      },
    ]).get('c1')!;
    expect(t.firstAgentBy).toBe('first');
  });
});
