import { describe, it, expect } from 'vitest';
import {
  businessMsBetween,
  businessSecondsBetween,
  parseBusinessHours,
  slaHoursByGoverns,
  type SlaBusinessHours,
} from '../src/sla.js';
// The SLA engine of record. Its only import from shared-types is a TYPE, so it
// loads here without the worker's runtime.
import { computeDueAt } from '../../../services/workers/src/lib/sla-clock.js';

const MIN = 60_000;

/** The owner's shift (2026-10-08): 09:00-04:00 Riyadh, every day. */
const SHIFT = [
  ['00:00', '04:00'],
  ['09:00', '24:00'],
] as Array<[string, string]>;
const RIYADH: SlaBusinessHours = {
  timezone: 'Asia/Riyadh',
  days: { '0': SHIFT, '1': SHIFT, '2': SHIFT, '3': SHIFT, '4': SHIFT, '5': SHIFT, '6': SHIFT },
};

/** Riyadh is UTC+3 all year: a local 'YYYY-MM-DDTHH:MM' as a Date. */
const riyadh = (local: string) => new Date(`${local}:00+03:00`);
const between = (a: string, b: string, h: SlaBusinessHours | null = RIYADH) =>
  businessMsBetween(riyadh(a), riyadh(b), h);

describe('businessMsBetween — the owner’s 09:00-04:00 shift', () => {
  it('a reply before the shift opens is 0 working minutes (05:35 -> 08:52)', () => {
    expect(between('2026-10-08T05:35', '2026-10-08T08:52')).toBe(0);
  });

  it('counts only from the shift start (05:35 -> 09:30 = 30 min)', () => {
    expect(between('2026-10-08T05:35', '2026-10-08T09:30')).toBe(30 * MIN);
  });

  it('runs straight across midnight (23:50 -> 00:10 = 20 min)', () => {
    expect(between('2026-10-08T23:50', '2026-10-09T00:10')).toBe(20 * MIN);
  });

  it('pauses over the 04:00-09:00 gap (03:50 -> 09:10 = 20 min)', () => {
    expect(between('2026-10-08T03:50', '2026-10-08T09:10')).toBe(20 * MIN);
  });

  it('inside one window it is the plain difference, to the second', () => {
    expect(between('2026-10-08T10:00', '2026-10-08T10:07')).toBe(7 * MIN);
    expect(
      businessMsBetween(
        new Date('2026-10-08T07:00:00.000Z'),
        new Date('2026-10-08T07:00:42.500Z'),
        RIYADH,
      ),
    ).toBe(42_500);
  });

  it('a whole day is 19 working hours', () => {
    expect(between('2026-10-08T12:00', '2026-10-09T12:00')).toBe(19 * 60 * MIN);
  });

  it('a week is 7 x 19 hours, across a month boundary', () => {
    expect(between('2026-10-28T12:00', '2026-11-04T12:00')).toBe(7 * 19 * 60 * MIN);
  });

  it('a start and end both inside the gap is 0', () => {
    expect(between('2026-10-08T04:30', '2026-10-08T08:59')).toBe(0);
  });
});

describe('businessMsBetween — edges', () => {
  it('null / undefined hours is the plain wall clock', () => {
    expect(between('2026-10-08T05:35', '2026-10-08T08:52', null)).toBe(197 * MIN);
    expect(
      businessMsBetween(riyadh('2026-10-08T05:35'), riyadh('2026-10-08T08:52'), undefined),
    ).toBe(197 * MIN);
  });

  it('end before or equal to start is 0, never negative', () => {
    expect(between('2026-10-08T10:00', '2026-10-08T09:30')).toBe(0);
    expect(between('2026-10-08T10:00', '2026-10-08T09:30', null)).toBe(0);
    expect(between('2026-10-08T10:00', '2026-10-08T10:00')).toBe(0);
  });

  it('hours with no window anywhere fall back to the wall clock, not to zero', () => {
    expect(
      between('2026-10-08T10:00', '2026-10-08T11:00', { timezone: 'Asia/Riyadh', days: {} }),
    ).toBe(60 * MIN);
  });

  it('a closed weekday contributes nothing', () => {
    // 2026-10-09 is a Friday (5). Sun-Thu 09:00-17:00 only.
    const weekdays: SlaBusinessHours = {
      timezone: 'Asia/Riyadh',
      days: {
        '0': [['09:00', '17:00']],
        '1': [['09:00', '17:00']],
        '2': [['09:00', '17:00']],
        '3': [['09:00', '17:00']],
        '4': [['09:00', '17:00']],
      },
    };
    // Thu 16:00 -> Sun 10:00 = 1h Thu + 1h Sun.
    expect(between('2026-10-08T16:00', '2026-10-11T10:00', weekdays)).toBe(120 * MIN);
  });

  it('reads the windows in the policy zone, DST-aware (New York)', () => {
    const ny: SlaBusinessHours = {
      timezone: 'America/New_York',
      days: { '0': [['09:00', '17:00']] },
    };
    // Sunday 2026-11-01 is the fall-back day: 09:00 local is 14:00Z (EST).
    expect(
      businessMsBetween(new Date('2026-11-01T13:00:00Z'), new Date('2026-11-01T15:00:00Z'), ny),
    ).toBe(60 * MIN);
    // A summer Sunday: 09:00 local is 13:00Z (EDT).
    expect(
      businessMsBetween(new Date('2026-07-05T12:00:00Z'), new Date('2026-07-05T14:00:00Z'), ny),
    ).toBe(60 * MIN);
  });
});

describe('businessMsBetween is the inverse of the engine’s computeDueAt', () => {
  const starts = [
    '2026-10-08T05:35', // in the gap
    '2026-10-08T09:00', // on the opening edge
    '2026-10-08T03:59', // a minute before the gap
    '2026-10-08T23:58', // across midnight
    '2026-10-10T13:17', // mid-window
    '2026-12-31T22:00', // across the year
  ];
  const minutes = [1, 5, 30, 61, 240, 19 * 60, 3 * 24 * 60];
  for (const s of starts) {
    for (const n of minutes) {
      it(`${s} + ${n} working min`, () => {
        const start = riyadh(s);
        const due = computeDueAt(start, n, RIYADH);
        expect(businessMsBetween(start, due, RIYADH)).toBe(n * MIN);
      });
    }
  }

  it('also for a weekday-only UTC policy and a DST zone', () => {
    const utc: SlaBusinessHours = {
      timezone: 'UTC',
      days: { '1': [['09:00', '17:00']], '2': [['09:00', '17:00']], '3': [['09:00', '17:00']] },
    };
    const ny: SlaBusinessHours = {
      timezone: 'America/New_York',
      days: Object.fromEntries(
        ['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, [['09:00', '17:00']]]),
      ),
    } as SlaBusinessHours;
    for (const h of [utc, ny]) {
      for (const iso of ['2026-10-30T20:00:00Z', '2026-03-07T22:00:00Z', '2026-11-02T10:30:00Z']) {
        for (const n of [15, 480, 1000]) {
          const start = new Date(iso);
          expect(businessMsBetween(start, computeDueAt(start, n, h), h)).toBe(n * MIN);
        }
      }
    }
  });
});

describe('businessSecondsBetween', () => {
  it('measures ISO strings in seconds', () => {
    expect(businessSecondsBetween('2026-10-08T02:35:00Z', '2026-10-08T06:30:00Z', RIYADH)).toBe(
      30 * 60,
    );
  });
  it('is null for missing, unparsable or backwards input', () => {
    expect(businessSecondsBetween(null, '2026-10-08T06:30:00Z', RIYADH)).toBeNull();
    expect(businessSecondsBetween('nope', '2026-10-08T06:30:00Z', RIYADH)).toBeNull();
    expect(
      businessSecondsBetween('2026-10-08T06:30:00Z', '2026-10-08T06:00:00Z', RIYADH),
    ).toBeNull();
  });
});

describe('parseBusinessHours / slaHoursByGoverns', () => {
  it('parses the column whether it arrives as JSON or as a string', () => {
    expect(parseBusinessHours(RIYADH)).toEqual(RIYADH);
    expect(parseBusinessHours(JSON.stringify(RIYADH))).toEqual(RIYADH);
    expect(parseBusinessHours(null)).toBeNull();
    expect(parseBusinessHours('{bad')).toBeNull();
    expect(parseBusinessHours({ timezone: 'UTC' })).toBeNull();
  });

  it('picks the active policy per clock; inactive and hour-less ones are skipped', () => {
    const other: SlaBusinessHours = { timezone: 'UTC', days: { '1': [['08:00', '16:00']] } };
    const got = slaHoursByGoverns([
      {
        id: '1',
        name: 'Chat first response',
        governs: 'chat',
        active: true,
        business_hours: RIYADH,
      },
      { id: '2', name: 'Aaa old chat', governs: 'chat', active: false, business_hours: other },
      { id: '3', name: 'Ticket resolution', governs: 'ticket', active: true, business_hours: null },
      { id: '4', name: 'Ticket zz', governs: null, active: true, business_hours: other },
    ]);
    expect(got.chat).toEqual(RIYADH);
    // `governs` absent means ticket, exactly as the engine reads it.
    expect(got.ticket).toEqual(other);
  });

  it('is null for both when no policy carries hours', () => {
    expect(slaHoursByGoverns([])).toEqual({ chat: null, ticket: null });
  });
});
