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
