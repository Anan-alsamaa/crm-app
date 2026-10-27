import { describe, it, expect } from 'vitest';
import {
  aiSummary,
  chatSummary,
  countsBy,
  couponSummary,
  dayKeyOf,
  lateOrderSummary,
  ticketSummary,
  toNum,
  totalOf,
  windowDays,
  yijiDailyTrend,
  yijiOperations,
  yijiUsageTotals,
} from '../src/features/admin-kpi/admin-kpi.js';

/** The Admin KPI page's arithmetic over Directus aggregate rows (owner, 2026-10-21). */

describe('aggregate rows', () => {
  it('reads string and number counts; junk is 0', () => {
    expect(toNum('12')).toBe(12);
    expect(toNum(3)).toBe(3);
    expect(toNum(null)).toBe(0);
    expect(toNum('x')).toBe(0);
    expect(totalOf([{ count: '2' }, { count: 3 }])).toBe(5);
    expect(totalOf(undefined)).toBe(0);
  });
  it('keys a grouped count, null as ""', () => {
    expect(
      countsBy(
        [
          { status: 'open', count: '2' },
          { status: null, count: 1 },
          { status: 'open', count: 1 },
        ],
        'status',
      ),
    ).toEqual({ open: 3, '': 1 });
  });
});

describe('chats', () => {
  it('counts by status and averages the first response, ignoring impossible stamps', () => {
    const s = chatSummary(
      [
        { status: 'open', count: '2' },
        { status: 'solved', count: '5' },
      ],
      [
        { date_created: '2026-10-20T10:00:00Z', first_responded_at: '2026-10-20T10:01:00Z' },
        { date_created: '2026-10-20T10:00:00Z', first_responded_at: '2026-10-20T10:03:00Z' },
        { date_created: '2026-10-20T10:00:00Z', first_responded_at: '2026-10-20T09:00:00Z' },
      ],
    );
    expect(s).toEqual({ total: 7, open: 2, closed: 5, responded: 2, avgFirstResponseSec: 120 });
    expect(chatSummary([], []).avgFirstResponseSec).toBeNull();
  });
});

describe('tickets', () => {
  it('splits compensation; Initial and blank are undecided', () => {
    const s = ticketSummary(
      [
        { status: 'pending', count: 4 },
        { status: 'solved', count: 6 },
      ],
      [
        { compensation: 'Compensated', count: 3 },
        { compensation: 'Not Compensated', count: 2 },
        { compensation: 'Initial', count: 4 },
        { compensation: null, count: 1 },
      ],
    );
    expect(s.created).toBe(10);
    expect(s.byStatus.solved).toBe(6);
    expect(s).toMatchObject({ compensated: 3, notCompensated: 2, undecided: 5 });
  });
});

describe('coupons', () => {
  it('counts every approval status as approved (approved + edited + assigned)', () => {
    const s = couponSummary({
      byStatus: [
        { status: 'approved', count: 1 },
        { status: 'edited', count: 2 },
        { status: 'assigned', count: 3 },
        { status: 'rejected', count: 4 },
        { status: 'pending', count: 5 },
      ],
      pushed: [{ count: 3 }],
      pushFailures: [{ count: 1 }],
      withheld: [{ count: '2' }],
      byRemoval: [
        { removal_status: 'removed', count: 1 },
        { removal_status: 'failed', count: 2 },
        { removal_status: null, count: 9 },
      ],
    });
    expect(s).toEqual({
      requested: 15,
      approved: 6,
      rejected: 4,
      pending: 5,
      pushed: 3,
      pushFailures: 1,
      withheld: 2,
      removal: { removed: 1, failed: 2 },
      replaced: 0,
    });
  });

  it('leaves EDITED coupons out once: the replaced row and an abandoned edit (owner, 2026-10-27)', () => {
    const s = couponSummary({
      byStatus: [
        { status: 'assigned', count: 5 },
        { status: 'approved', count: 2 },
        { status: 'rejected', count: 3 },
      ],
      pushed: [],
      pushFailures: [],
      withheld: [],
      byRemoval: [],
      // 2 delivered coupons were edited (replaced), 1 edit was not applied.
      superseded: [
        { status: 'assigned', count: 2 },
        { status: 'rejected', count: 1 },
      ],
    });
    expect(s).toMatchObject({ requested: 7, approved: 5, rejected: 2, pending: 0, replaced: 2 });
  });

  it('without the fields applied (null), every figure is as before', () => {
    const s = couponSummary({
      byStatus: [{ status: 'assigned', count: 4 }],
      pushed: [],
      pushFailures: [],
      withheld: [],
      byRemoval: [],
      superseded: null,
    });
    expect(s).toMatchObject({ requested: 4, approved: 4, replaced: 0 });
  });
});

describe('late orders', () => {
  it('counts each order once, by its NEWEST decision', () => {
    const s = lateOrderSummary([
      { order_id: 'A', action: 'ignored', date_created: '2026-10-20T10:00:00Z' },
      { order_id: 'A', action: 'compensated', date_created: '2026-10-20T11:00:00Z' },
      { order_id: 'B', action: 'ignored', date_created: '2026-10-20T10:00:00Z' },
      { order_id: '', action: 'ignored', date_created: '2026-10-20T10:00:00Z' },
    ]);
    expect(s).toEqual({ decisions: 4, orders: 2, commented: 1, compensated: 1 });
  });
});

describe('AI calls', () => {
  it('sums cost and tokens, weights latency by calls', () => {
    const s = aiSummary([
      {
        status: 'ok',
        count: '3',
        sum: {
          est_cost_usd: '0.5',
          input_tokens: '100',
          output_tokens: '50',
          thinking_tokens: null,
        },
        avg: { latency_ms: '1000' },
      },
      { status: 'error', count: 1, sum: { est_cost_usd: null }, avg: { latency_ms: 2000 } },
    ]);
    expect(s).toEqual({ calls: 4, errors: 1, costUsd: 0.5, tokens: 150, avgLatencyMs: 1250 });
  });
});

describe('Yiji API usage', () => {
  const groups = [
    { account: 'crm', outcome: 'ok', count: '90' },
    { account: 'crm', outcome: 'refused', count: '4' },
    { account: 'backup', outcome: 'ok', count: '4' },
    { account: 'crm', outcome: 'error', count: '2' },
  ];

  it('splits by account and outcome, with the backup share', () => {
    expect(yijiUsageTotals(groups)).toEqual({
      total: 100,
      crm: 96,
      backup: 4,
      ok: 94,
      refused: 4,
      error: 2,
      backupPct: 4,
    });
    expect(yijiUsageTotals([]).backupPct).toBeNull();
  });

  it('per operation, busiest first', () => {
    const ops = yijiOperations([
      { operation: 'coupon.remove', account: 'crm', outcome: 'refused', count: 2 },
      { operation: 'coupon.remove', account: 'backup', outcome: 'ok', count: 2 },
      { operation: 'order.late_poll', account: 'crm', outcome: 'ok', count: 50 },
    ]);
    expect(ops.map((o) => o.operation)).toEqual(['order.late_poll', 'coupon.remove']);
    expect(ops[1]).toEqual({
      operation: 'coupon.remove',
      total: 4,
      crm: 2,
      backup: 2,
      refused: 2,
      error: 0,
    });
  });

  it('reads the day from either function-column spelling', () => {
    expect(dayKeyOf({ date_created_year: 2026, date_created_month: 10, date_created_day: 3 })).toBe(
      '2026-10-03',
    );
    expect(
      dayKeyOf({
        'year(date_created)': '2026',
        'month(date_created)': '9',
        'day(date_created)': '30',
      }),
    ).toBe('2026-09-30');
    expect(dayKeyOf({})).toBeNull();
  });

  it('a zero-filled daily trend over the window', () => {
    const trend = yijiDailyTrend(
      [
        {
          date_created_year: 2026,
          date_created_month: 10,
          date_created_day: 20,
          account: 'crm',
          outcome: 'ok',
          count: 5,
        },
        {
          date_created_year: 2026,
          date_created_month: 10,
          date_created_day: 20,
          account: 'backup',
          outcome: 'refused',
          count: 1,
        },
        {
          date_created_year: 2026,
          date_created_month: 9,
          date_created_day: 1,
          account: 'crm',
          outcome: 'ok',
          count: 9,
        },
      ],
      '2026-10-19',
      '2026-10-21',
    );
    expect(trend).toEqual([
      { day: '2026-10-19', crm: 0, backup: 0, failed: 0 },
      { day: '2026-10-20', crm: 5, backup: 1, failed: 1 },
      { day: '2026-10-21', crm: 0, backup: 0, failed: 0 },
    ]);
    expect(yijiDailyTrend([], '2026-01-01', '2026-12-31', 30)).toHaveLength(30);
  });

  it('the calendar days of a business-day window', () => {
    expect(windowDays('2026-10-20T08:00:00', '2026-10-22T04:00:00')).toEqual({
      from: '2026-10-20',
      to: '2026-10-22',
    });
  });
});
