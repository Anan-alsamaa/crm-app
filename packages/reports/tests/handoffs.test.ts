import { describe, it, expect } from 'vitest';
import {
  agentPerformance,
  chatHandoffs,
  missedOffers,
  performanceSummary,
  type ChatTiming,
  type RoutingEvent,
} from '../src/index.js';

const ev = (
  conversation: string,
  agent: string | null,
  outcome: string,
  stage: string,
): RoutingEvent => ({ conversation, agent, outcome, stage });

describe('chatHandoffs', () => {
  it('a chat answered by the first agent was never passed on', () => {
    const h = chatHandoffs([ev('c1', 'a1', 'answered', 'assign')]).get('c1')!;
    expect(h.passedOn).toBe(false);
    expect(h.takenBy).toBeNull();
  });

  it('credits the agent who picked up a chat the first one let go', () => {
    // a1 was offered it and did not answer; a2 got it at the escalate rung and
    // did. That is a common chat, and it belongs to a2.
    const h = chatHandoffs([
      ev('c1', 'a1', 'missed', 'assign'),
      ev('c1', 'a2', 'answered', 'escalate'),
    ]).get('c1')!;
    expect(h.passedOn).toBe(true);
    expect(h.takenBy).toBe('a2');
  });

  it('marks a chat as passed on even while nobody has taken it', () => {
    const h = chatHandoffs([
      ev('c1', 'a1', 'missed', 'assign'),
      ev('c1', 'a2', 'missed', 'escalate'),
    ]).get('c1')!;
    // It must leave the SLA population immediately — not only once somebody
    // finally answers — or the agent holding it is scored on the wait the
    // previous two caused.
    expect(h.passedOn).toBe(true);
    expect(h.takenBy).toBeNull();
  });

  it('credits the LAST agent to answer after a chat went the full ladder', () => {
    const h = chatHandoffs([
      ev('c1', 'a1', 'missed', 'assign'),
      ev('c1', 'a2', 'missed', 'escalate'),
      ev('c1', 'a3', 'answered', 'broadcast'),
    ]).get('c1')!;
    expect(h.takenBy).toBe('a3');
  });

  it('does not depend on the order events arrive in', () => {
    const shuffled = chatHandoffs([
      ev('c1', 'a3', 'answered', 'broadcast'),
      ev('c1', 'a1', 'missed', 'assign'),
      ev('c1', 'a2', 'missed', 'escalate'),
    ]).get('c1')!;
    expect(shuffled).toEqual({ passedOn: true, takenBy: 'a3' });
  });

  it('keeps conversations apart', () => {
    const all = chatHandoffs([
      ev('c1', 'a1', 'answered', 'assign'),
      ev('c2', 'a1', 'missed', 'assign'),
      ev('c2', 'a2', 'answered', 'escalate'),
    ]);
    expect(all.get('c1')!.passedOn).toBe(false);
    expect(all.get('c2')!.takenBy).toBe('a2');
  });

  it('ignores an event whose agent account has been deleted', () => {
    const h = chatHandoffs([ev('c1', null, 'answered', 'escalate')]).get('c1')!;
    expect(h.passedOn).toBe(true);
    expect(h.takenBy).toBeNull();
  });
});

describe('missedOffers', () => {
  it('counts every offer an agent let expire, at any rung', () => {
    const m = missedOffers([
      ev('c1', 'a1', 'missed', 'assign'),
      ev('c2', 'a1', 'missed', 'escalate'),
      ev('c3', 'a1', 'answered', 'assign'),
      ev('c1', 'a2', 'missed', 'escalate'),
    ]);
    // Shown beside the common-chat count on purpose: work you let go and work
    // you picked up are one story, and only publishing the flattering half is
    // how a leaderboard loses people's trust.
    expect(m.get('a1')).toBe(2);
    expect(m.get('a2')).toBe(1);
  });
});

const chat = (over: Partial<ChatTiming> = {}): ChatTiming => ({
  conversationId: 'c1',
  agentId: 'a1',
  agentName: 'Sara',
  firstCustomerAt: '2026-08-13T10:00:00.000Z',
  firstAgentAt: '2026-08-13T10:01:00.000Z',
  solvedAt: null,
  ...over,
});

describe('a passed-on chat leaves the personal SLA population', () => {
  it('does not drag the first-response average of whoever ended up with it', () => {
    const s = performanceSummary(
      [
        chat({ conversationId: 'clean', firstAgentAt: '2026-08-13T10:01:00.000Z' }), // 60s
        // Answered 30 minutes in, but only because two agents sat on it first.
        chat({
          conversationId: 'passed',
          firstAgentAt: '2026-08-13T10:30:00.000Z',
          passedOn: true,
          takenBy: 'a1',
        }),
      ],
      5 * 60,
    );
    // 60s, not 930s: the ladder's delay is not this agent's response time.
    expect(s.avgFirstResponseSec).toBe(60);
    // And the clean chat met the target, so this is 100% rather than 50%.
    expect(s.metPct).toBe(100);
    // The passed-on chat is still counted — as a common chat, not a failure.
    expect(s.chats).toBe(2);
    expect(s.commonChats).toBe(1);
  });

  it('still reports a chat nobody has answered as unanswered', () => {
    const s = performanceSummary([chat({ conversationId: 'never', firstAgentAt: null })], 5 * 60);
    expect(s.unanswered).toBe(1);
    expect(s.metPct).toBe(0);
  });

  it('never lets a passed-on chat nobody answered disappear', () => {
    /**
     * The worst outcome in the system: it went round the whole ladder and the
     * customer is still waiting. Scoping "no reply yet" the same way as the
     * timings made it vanish from BOTH counts — not in the unanswered figure
     * because it was passed on, and not in the common-chat figure because
     * nobody took it. A number that hides its worst case is worse than no
     * number.
     */
    const s = performanceSummary(
      [chat({ conversationId: 'lost', firstAgentAt: null, passedOn: true, takenBy: null })],
      5 * 60,
    );
    expect(s.unanswered).toBe(1);
    expect(s.commonChats).toBe(0);
    // ...and it is still out of the response-time judgement, which is the part
    // that would be unfair.
    expect(s.metPct).toBeNull();
    expect(s.avgFirstResponseSec).toBeNull();
  });

  it('reports no percentage when every chat in range was passed on', () => {
    // Nothing left to judge this agent's own responsiveness by. Null says that;
    // 0% would accuse them of something the data cannot support.
    const s = performanceSummary([chat({ passedOn: true, takenBy: 'a1' })], 5 * 60);
    expect(s.metPct).toBeNull();
    expect(s.commonChats).toBe(1);
  });
});

describe('agentPerformance with handoffs', () => {
  it('credits a common chat to whoever took it, not to whoever holds it now', () => {
    const rows = agentPerformance([
      // Currently assigned to a1, but a2 is the one who answered it after it
      // had been passed on — and the ladder may move it again afterwards.
      chat({ conversationId: 'c1', agentId: 'a1', passedOn: true, takenBy: 'a2' }),
      chat({ conversationId: 'c2', agentId: 'a2', agentName: 'Omar' }),
    ]);
    const omar = rows.find((r) => r.agentId === 'a2')!;
    const sara = rows.find((r) => r.agentId === 'a1')!;
    expect(omar.commonChats).toBe(1);
    expect(sara.commonChats).toBe(0);
    // Sara still holds the chat, so it counts in her volume...
    expect(sara.chats).toBe(1);
    // ...but not in the population her response time is judged on.
    expect(sara.ownChats).toBe(0);
  });

  it('leaves an ordinary chat entirely in the own-chats population', () => {
    const rows = agentPerformance([chat({ conversationId: 'c1' })]);
    expect(rows[0]!.ownChats).toBe(1);
    expect(rows[0]!.commonChats).toBe(0);
    expect(rows[0]!.answered).toBe(1);
  });
});
