import { describe, it, expect } from 'vitest';
import {
  agentPerformance,
  firstResponseSec,
  formatDuration,
  metFirstResponse,
  splitBySla,
  timeToSolveSec,
  type ChatTiming,
} from '../src/agent-performance.js';

const chat = (over: Partial<ChatTiming> = {}): ChatTiming => ({
  conversationId: 'c1',
  agentId: 'a1',
  agentName: 'Sara',
  firstCustomerAt: '2026-08-13T10:00:00.000Z',
  firstAgentAt: '2026-08-13T10:01:00.000Z',
  solvedAt: '2026-08-13T10:30:00.000Z',
  ...over,
});

describe('firstResponseSec', () => {
  it('measures from the customer, not from when the row was created', () => {
    expect(firstResponseSec(chat())).toBe(60);
  });

  it('is null when nobody answered', () => {
    // Not zero. A zero here would make the worst chat look like the best one.
    expect(firstResponseSec(chat({ firstAgentAt: null }))).toBeNull();
  });

  it('is null when the customer never wrote', () => {
    expect(firstResponseSec(chat({ firstCustomerAt: null }))).toBeNull();
  });

  it('discards a reply that predates the message rather than reporting 0s', () => {
    // Clock skew or a repaired row. Clamping to zero would be a lie in the
    // flattering direction.
    expect(firstResponseSec(chat({ firstAgentAt: '2026-08-13T09:59:00.000Z' }))).toBeNull();
  });
});

describe('timeToSolveSec', () => {
  it('runs from the first message to the solve', () => {
    expect(timeToSolveSec(chat())).toBe(1800);
  });

  it('is null while the chat is still open', () => {
    expect(timeToSolveSec(chat({ solvedAt: null }))).toBeNull();
  });
});

describe('metFirstResponse', () => {
  it('counts a reply inside the target as met, including exactly on it', () => {
    expect(metFirstResponse(chat(), 60)).toBe(true);
    expect(metFirstResponse(chat(), 120)).toBe(true);
  });

  it('counts a slow reply as missed', () => {
    expect(metFirstResponse(chat(), 30)).toBe(false);
  });

  it('counts a chat nobody answered as MISSED, not as unknown', () => {
    // The whole point of tracking it. Leaving these out of both populations
    // would let the worst cases quietly improve the met-rate.
    expect(metFirstResponse(chat({ firstAgentAt: null }), 3600)).toBe(false);
  });
});

describe('agentPerformance', () => {
  it('reports unanswered chats separately instead of averaging them in', () => {
    const [row] = agentPerformance([
      chat({ conversationId: 'c1' }),
      chat({ conversationId: 'c2', firstAgentAt: null, solvedAt: null }),
    ]);
    expect(row).toMatchObject({ chats: 2, answered: 1, unanswered: 1 });
    // The average describes the one answered chat, and `unanswered` is what
    // says the average does not describe everything.
    expect(row!.avgFirstResponseSec).toBe(60);
  });

  it('carries the count each average came from', () => {
    const [row] = agentPerformance([chat(), chat({ conversationId: 'c2' })]);
    expect(row!.answered).toBe(2);
    expect(row!.solved).toBe(2);
  });

  it('reports a median as well, which one very old chat cannot drag', () => {
    const rows = agentPerformance([
      chat({ conversationId: 'c1', firstAgentAt: '2026-08-13T10:00:10.000Z' }),
      chat({ conversationId: 'c2', firstAgentAt: '2026-08-13T10:00:20.000Z' }),
      chat({ conversationId: 'c3', firstAgentAt: '2026-08-13T13:00:00.000Z' }),
    ]);
    expect(rows[0]!.medianFirstResponseSec).toBe(20);
    expect(rows[0]!.avgFirstResponseSec).toBeGreaterThan(3000);
  });

  it('gives unassigned chats their own row rather than dropping them', () => {
    // Work nobody picked up is exactly what a supervisor is looking for.
    const rows = agentPerformance([
      chat({ agentId: null, agentName: 'Unassigned', firstAgentAt: null }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agentId: null, chats: 1, unanswered: 1 });
  });

  it('groups by agent, busiest first', () => {
    const rows = agentPerformance([
      chat({ agentId: 'a1', agentName: 'Sara' }),
      chat({ agentId: 'a2', agentName: 'Ali', conversationId: 'c2' }),
      chat({ agentId: 'a2', agentName: 'Ali', conversationId: 'c3' }),
    ]);
    expect(rows.map((r) => r.agentName)).toEqual(['Ali', 'Sara']);
  });

  it('returns nothing for no chats, rather than a row of zeros', () => {
    expect(agentPerformance([])).toEqual([]);
  });
});

describe('splitBySla', () => {
  it('puts every chat in exactly one population', () => {
    const chats = [
      chat({ conversationId: 'fast' }),
      chat({ conversationId: 'slow', firstAgentAt: '2026-08-13T11:00:00.000Z' }),
      chat({ conversationId: 'never', firstAgentAt: null }),
    ];
    const { met, missed } = splitBySla(chats, 60);
    expect(met.map((c) => c.conversationId)).toEqual(['fast']);
    expect(missed.map((c) => c.conversationId)).toEqual(['slow', 'never']);
    expect(met.length + missed.length).toBe(chats.length);
  });
});

describe('formatDuration', () => {
  it('reads as a duration at every scale', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(92)).toBe('1m 32s');
    expect(formatDuration(3661)).toBe('1h 1m');
    expect(formatDuration(90000)).toBe('1d 1h');
  });

  it('returns null for "not measurable" so the caller cannot print 0s', () => {
    expect(formatDuration(null)).toBeNull();
  });
});
