import { describe, it, expect } from 'vitest';
import type { SlaBusinessHours } from '@yiji/shared-types';
import {
  agentInitiatedSummary,
  agentPerformance,
  comparisonRows,
  dailyTrend,
  firstResponseSec,
  metFirstResponse,
  performanceSummary,
  splitBySla,
  timeToSolveSec,
  type ChatTiming,
} from '../src/index.js';

/**
 * THE REPORTS COUNT WORKING TIME, like the SLA engine (owner, 2026-10-08).
 * Agents work 09:00-04:00 Riyadh; a wait outside that is not the agent's.
 */
const SHIFT = [
  ['00:00', '04:00'],
  ['09:00', '24:00'],
] as Array<[string, string]>;
const HOURS: SlaBusinessHours = {
  timezone: 'Asia/Riyadh',
  days: Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, SHIFT])),
};

/** Riyadh local 'YYYY-MM-DDTHH:MM' -> ISO UTC. */
const r = (local: string) => new Date(`${local}:00+03:00`).toISOString();

/** Customer at 05:35, reply at 08:52 (before the shift), solved 09:30. */
const early = (over: Partial<ChatTiming> = {}): ChatTiming => ({
  conversationId: 'early',
  agentId: 'a1',
  agentName: 'Sara',
  firstCustomerAt: r('2026-10-08T05:35'),
  firstAgentAt: r('2026-10-08T08:52'),
  solvedAt: r('2026-10-08T09:30'),
  ...over,
});
/** Customer 05:35, reply 09:30 = 30 working minutes. */
const late = (over: Partial<ChatTiming> = {}): ChatTiming =>
  early({
    conversationId: 'late',
    firstAgentAt: r('2026-10-08T09:30'),
    solvedAt: r('2026-10-08T10:00'),
    ...over,
  });

describe('working hours in the chat timings', () => {
  it('without hours nothing changes: the wall clock', () => {
    expect(firstResponseSec(early())).toBe(197 * 60);
    expect(timeToSolveSec(early())).toBe(235 * 60);
  });

  it('a reply before the shift is 0; a reply at 09:30 is 30 working minutes', () => {
    expect(firstResponseSec(early({ businessHours: HOURS }))).toBe(0);
    expect(firstResponseSec(late({ businessHours: HOURS }))).toBe(30 * 60);
    expect(timeToSolveSec(early({ businessHours: HOURS }))).toBe(30 * 60);
    // The explicit argument wins over the chat's own hours, both ways.
    expect(firstResponseSec(early(), HOURS)).toBe(0);
    expect(firstResponseSec(early({ businessHours: HOURS }), null)).toBe(197 * 60);
  });

  it('a negative interval is still no measurement', () => {
    expect(firstResponseSec(early({ firstAgentAt: r('2026-10-08T05:00') }), HOURS)).toBeNull();
  });

  it('meets a 5-minute target that the wall clock said was missed', () => {
    expect(metFirstResponse(early(), 300)).toBe(false);
    expect(metFirstResponse(early(), 300, HOURS)).toBe(true);
    const split = splitBySla([early(), late()], 300, HOURS);
    expect(split.met.map((c) => c.conversationId)).toEqual(['early']);
    expect(split.missed.map((c) => c.conversationId)).toEqual(['late']);
  });

  it('flows through the per-agent rows, the summary, the comparison and the trend', () => {
    const chats = [early(), late()];
    const row = agentPerformance(chats, HOURS)[0]!;
    expect(row.avgFirstResponseSec).toBe(15 * 60);
    expect(row.medianFirstResponseSec).toBe(15 * 60);
    expect(row.avgTimeToSolveSec).toBe(45 * 60); // 30 + 60 working minutes

    const s = performanceSummary(chats, 300, HOURS);
    expect(s.avgFirstResponseSec).toBe(15 * 60);
    expect(s.metPct).toBe(50);

    expect(comparisonRows(chats, (n) => `${n}`, HOURS)[0]!.values.first).toBe(15 * 60);
    expect(dailyTrend(chats, HOURS)[0]!.values.first).toBe(15 * 60);

    // The same chats without hours: the old numbers, untouched.
    expect(performanceSummary(chats, 300).avgFirstResponseSec).toBe(
      Math.round(((197 + 235) * 60) / 2),
    );
  });

  it('agent-started chats: handling time is working time; the customer reply stays wall clock', () => {
    const chat = early({
      initiatedBy: 'agent',
      firstOutreachAt: r('2026-10-08T03:00'),
    });
    const o = agentInitiatedSummary([chat], HOURS);
    expect(o.medianHandlingSec).toBe(30 * 60);
    // The CUSTOMER's speed is not bounded by the agents' shift.
    expect(o.medianCustomerReplySec).toBe(155 * 60);
  });
});
