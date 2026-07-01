import { describe, it, expect } from 'vitest';
import {
  computeDueAt,
  computeDeadlines,
  warningAt,
  type BusinessHours,
} from '../src/lib/sla-clock.js';

const HOURS_24_7 = null;
const BIZ_9_5_MON_FRI: BusinessHours = {
  timezone: 'UTC',
  days: {
    '1': [['09:00', '17:00']],
    '2': [['09:00', '17:00']],
    '3': [['09:00', '17:00']],
    '4': [['09:00', '17:00']],
    '5': [['09:00', '17:00']],
  },
};

// Saudi work week: Sun–Thu, 09:00–17:00 LOCAL (Asia/Riyadh = UTC+3, no DST).
const BIZ_RIYADH_SUN_THU: BusinessHours = {
  timezone: 'Asia/Riyadh',
  days: {
    '0': [['09:00', '17:00']],
    '1': [['09:00', '17:00']],
    '2': [['09:00', '17:00']],
    '3': [['09:00', '17:00']],
    '4': [['09:00', '17:00']],
  },
};

describe('computeDueAt (T066)', () => {
  it('24/7: dueAt is start + minutes', () => {
    const start = new Date('2026-06-01T10:00:00Z');
    const due = computeDueAt(start, 120, HOURS_24_7);
    expect(due.toISOString()).toBe('2026-06-01T12:00:00.000Z');
  });

  it('business hours: started mid-window stays in window when minutes fit', () => {
    // Monday 10:00 UTC + 60 minutes → 11:00 UTC same day.
    const due = computeDueAt(new Date('2026-06-01T10:00:00Z'), 60, BIZ_9_5_MON_FRI);
    expect(due.toISOString()).toBe('2026-06-01T11:00:00.000Z');
  });

  it('business hours: spills into next business day when minutes exceed remaining', () => {
    // Monday 16:30 UTC + 60 minutes: 30 min until close, then resumes Tue 09:00 + 30.
    const due = computeDueAt(new Date('2026-06-01T16:30:00Z'), 60, BIZ_9_5_MON_FRI);
    expect(due.toISOString()).toBe('2026-06-02T09:30:00.000Z');
  });

  it('business hours: started outside window jumps forward to next open', () => {
    // Saturday 12:00 UTC + 30 min (no Sat/Sun windows) → Monday 09:30 UTC.
    const due = computeDueAt(new Date('2026-06-06T12:00:00Z'), 30, BIZ_9_5_MON_FRI);
    expect(due.toISOString()).toBe('2026-06-08T09:30:00.000Z');
  });

  it('business hours: full 8-hour SLA from Friday afternoon spans the weekend', () => {
    // Friday 13:00 + 480 min (8h): 4h to 17:00 Fri close, 4h on Mon → 13:00 Mon.
    const due = computeDueAt(new Date('2026-06-05T13:00:00Z'), 480, BIZ_9_5_MON_FRI);
    expect(due.toISOString()).toBe('2026-06-08T13:00:00.000Z');
  });

  it('throws when business_hours has no windows at all', () => {
    expect(() => computeDueAt(new Date(), 30, { timezone: 'UTC', days: {} })).toThrow(/no windows/);
  });
});

describe('computeDueAt — local timezone (Asia/Riyadh, UTC+3)', () => {
  it('windows are interpreted in local time, not UTC', () => {
    // 06:00Z = 09:00 Riyadh (Mon, at open) + 60 min → 10:00 Riyadh = 07:00Z.
    const due = computeDueAt(new Date('2026-06-01T06:00:00Z'), 60, BIZ_RIYADH_SUN_THU);
    expect(due.toISOString()).toBe('2026-06-01T07:00:00.000Z');
  });

  it('a ticket before LOCAL open jumps to local open (differs from a UTC reading)', () => {
    // 05:00Z = 08:00 Riyadh (before the 09:00 local open). Deadline = 09:30 Riyadh
    // = 06:30Z. A UTC reading of the same window would give 09:30Z — this asserts
    // the local-time behaviour (the bug that was fixed).
    const due = computeDueAt(new Date('2026-06-01T05:00:00Z'), 30, BIZ_RIYADH_SUN_THU);
    expect(due.toISOString()).toBe('2026-06-01T06:30:00.000Z');
  });

  it('spills across the Saudi weekend (Fri/Sat closed) to Sunday', () => {
    // Thu 16:30 Riyadh (13:30Z) + 60: 30 min to 17:00 Thu close, then Fri + Sat
    // are closed, resume Sun 09:00 Riyadh + 30 → 09:30 Riyadh = 06:30Z Sunday.
    const due = computeDueAt(new Date('2026-06-04T13:30:00Z'), 60, BIZ_RIYADH_SUN_THU);
    expect(due.toISOString()).toBe('2026-06-07T06:30:00.000Z');
  });
});

describe('computeDeadlines (T066)', () => {
  it('returns both first-response and resolution times', () => {
    const start = new Date('2026-06-01T10:00:00Z');
    const { firstResponseDueAt, resolutionDueAt } = computeDeadlines(start, 30, 240, HOURS_24_7);
    expect(firstResponseDueAt.toISOString()).toBe('2026-06-01T10:30:00.000Z');
    expect(resolutionDueAt.toISOString()).toBe('2026-06-01T14:00:00.000Z');
  });
});

describe('warningAt (T066)', () => {
  it('80% of the way to a 60-minute deadline = 48 minutes in', () => {
    const start = new Date('2026-06-01T10:00:00Z');
    const due = new Date('2026-06-01T11:00:00Z');
    expect(warningAt(start, due, 80).toISOString()).toBe('2026-06-01T10:48:00.000Z');
  });
});
