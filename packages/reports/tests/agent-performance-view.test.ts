import { describe, it, expect } from 'vitest';
import { comparisonRows, dailyTrend, performanceSummary, type ChatTiming } from '../src/index.js';

/**
 * The arithmetic behind the performance page, tested where both portals share
 * it. The page tests then only have to prove the JSX renders what this returns.
 */
const chat = (over: Partial<ChatTiming> & { startedAt?: string | null } = {}) => ({
  conversationId: 'c1',
  agentId: 'a1',
  agentName: 'Sara',
  firstCustomerAt: '2026-08-13T10:00:00.000Z',
  firstAgentAt: '2026-08-13T10:01:00.000Z',
  solvedAt: '2026-08-13T10:30:00.000Z',
  ...over,
});

describe('performanceSummary', () => {
  it('keeps unanswered chats out of the averages but inside the totals', () => {
    const s = performanceSummary(
      [
        chat({ conversationId: 'a', firstAgentAt: '2026-08-13T10:01:00.000Z' }), // 60s
        chat({ conversationId: 'b', firstAgentAt: '2026-08-13T10:05:00.000Z' }), // 300s
        chat({ conversationId: 'c', firstAgentAt: null, solvedAt: null }),
      ],
      5 * 60,
    );
    expect(s.chats).toBe(3);
    expect(s.answered).toBe(2);
    expect(s.unanswered).toBe(1);
    // 180, not 120: folding the unanswered chat in as a 0 would flatter it.
    expect(s.avgFirstResponseSec).toBe(180);
  });

  it('counts a chat nobody answered as a MISS, not as undecided', () => {
    const s = performanceSummary(
      [
        chat({ conversationId: 'fast' }),
        chat({ conversationId: 'never', firstAgentAt: null, solvedAt: null }),
      ],
      5 * 60,
    );
    // 1 of 2. Scoring only the answered chats would report 100% on a day half
    // the customers were ignored — the single most misleading number this page
    // could show.
    expect(s.metPct).toBe(50);
  });

  it('reports no percentage at all rather than 0% when there is nothing to judge', () => {
    expect(performanceSummary([], 300).metPct).toBeNull();
    expect(performanceSummary([], 300).avgFirstResponseSec).toBeNull();
  });

  it('takes the median from the answered chats, so one outlier cannot own the page', () => {
    const s = performanceSummary(
      [
        chat({ conversationId: 'a', firstAgentAt: '2026-08-13T10:01:00.000Z' }), // 60s
        chat({ conversationId: 'b', firstAgentAt: '2026-08-13T10:02:00.000Z' }), // 120s
        chat({ conversationId: 'c', firstAgentAt: '2026-08-13T13:00:00.000Z' }), // 3h
      ],
      5 * 60,
    );
    expect(s.medianFirstResponseSec).toBe(120);
    expect(s.avgFirstResponseSec).toBeGreaterThan(3000);
  });
});

describe('comparisonRows', () => {
  it('carries the chat count beside every average', () => {
    const rows = comparisonRows(
      [
        chat({ conversationId: 'a' }),
        chat({ conversationId: 'b', agentId: 'a2', agentName: 'Omar' }),
      ],
      (n) => `${n} chats`,
    );
    // Without the count, one lucky chat reads exactly like a hundred good ones.
    expect(rows.every((r) => r.note === '1 chats')).toBe(true);
    expect(rows.map((r) => r.label).sort()).toEqual(['Omar', 'Sara']);
  });

  it('gives every row a volume, even when nothing about it was measurable', () => {
    const rows = comparisonRows(
      [chat({ firstAgentAt: null, solvedAt: null })],
      (n) => `${n} chats`,
    );
    // This is what keeps the charts from rendering as a blank card on a range
    // where nobody replied.
    expect(rows[0]!.values.chats).toBe(1);
    expect(rows[0]!.values.first).toBeNull();
    expect(rows[0]!.values.solve).toBeNull();
  });
});

describe('dailyTrend', () => {
  it('places a chat on the day the customer wrote, not the day it was solved', () => {
    const points = dailyTrend([
      chat({
        conversationId: 'monday',
        firstCustomerAt: '2026-08-10T09:00:00.000Z',
        firstAgentAt: '2026-08-10T09:02:00.000Z',
        solvedAt: '2026-08-13T09:00:00.000Z',
      }),
    ]);
    // A Monday complaint answered on Thursday is a Monday problem; filing it
    // under Thursday makes a bad Monday invisible.
    expect(points).toHaveLength(1);
    expect(points[0]!.day.endsWith('-08-10')).toBe(true);
  });

  it('returns days oldest first so the line reads left to right', () => {
    const points = dailyTrend([
      chat({ conversationId: 'b', firstCustomerAt: '2026-08-12T09:00:00.000Z' }),
      chat({ conversationId: 'a', firstCustomerAt: '2026-08-10T09:00:00.000Z' }),
    ]);
    expect(points.map((p) => p.label)).toEqual(['08-10', '08-12']);
  });

  it('leaves a day with no measurable timing as a gap, never as a zero', () => {
    const points = dailyTrend([
      chat({ conversationId: 'quiet', firstAgentAt: null, solvedAt: null }),
    ]);
    // A 0 here would draw as "answered instantly" on a day nobody replied.
    expect(points[0]!.values.first).toBeNull();
    expect(points[0]!.values.chats).toBe(1);
  });

  it('falls back to when the chat was created if the customer never wrote', () => {
    const points = dailyTrend([
      chat({
        conversationId: 'agent-initiated',
        firstCustomerAt: null,
        firstAgentAt: null,
        solvedAt: null,
        startedAt: '2026-08-11T09:00:00.000Z',
      }),
    ]);
    expect(points).toHaveLength(1);
    expect(points[0]!.day.endsWith('-08-11')).toBe(true);
  });

  it('drops a chat that has no usable date rather than inventing a day for it', () => {
    expect(
      dailyTrend([chat({ firstCustomerAt: null, firstAgentAt: null, startedAt: null })]),
    ).toEqual([]);
  });
});
