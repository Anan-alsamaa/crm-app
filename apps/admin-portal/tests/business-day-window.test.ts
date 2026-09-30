import { describe, it, expect } from 'vitest';
import { businessDayWindow, todayBusinessDay } from '../src/lib/date-range.js';

/**
 * EVERY DATE RANGE IN THE APP MEANS BUSINESS DAYS (owner, 2026-09-30).
 *
 * A business day runs 08:00 to 04:00 the next morning. So `from=to=30/09` is
 * `30/09 08:00` through `01/10 04:00` — the owner's own example.
 *
 * Five reports hand-rolled their own version of this and each got it wrong at
 * both edges: `${from}T00:00:00` counted the early hours of the opening day,
 * which belong to the day BEFORE, and `${to}T23:59:59` cut off the night's tail
 * after midnight, which is the busiest part of a restaurant's evening. The
 * symptom is not an error — it is a total that is quietly short, which is the
 * failure shape this codebase keeps producing. See [[silent-empty-failures]].
 */
describe('businessDayWindow', () => {
  /* THE OWNER'S EXAMPLE, verbatim. */
  it('turns a single day into 08:00 -> 04:00 the next morning', () => {
    expect(businessDayWindow('2026-09-30', '2026-09-30')).toEqual({
      fromIso: '2026-09-30T08:00:00',
      toIso: '2026-10-01T04:00:00',
    });
  });

  it('spans a multi-day range from the first opening to the last close', () => {
    expect(businessDayWindow('2026-09-29', '2026-09-30')).toEqual({
      fromIso: '2026-09-29T08:00:00',
      toIso: '2026-10-01T04:00:00',
    });
  });

  /* Month and year ends are where naive date arithmetic breaks: the close of
     30/09's night is 01/10, not 31/09. */
  it('rolls over a month end', () => {
    expect(businessDayWindow('2026-09-30', '2026-09-30').toIso).toBe('2026-10-01T04:00:00');
  });

  it('rolls over a year end', () => {
    expect(businessDayWindow('2026-12-31', '2026-12-31').toIso).toBe('2027-01-01T04:00:00');
  });

  /* A leap year is the other arithmetic trap. */
  it('rolls over 28 February in a leap year', () => {
    expect(businessDayWindow('2028-02-28', '2028-02-28').toIso).toBe('2028-02-29T04:00:00');
  });

  /*
   * THE TWO EDGES THE OLD CODE GOT WRONG, stated as the boundary they imply.
   */
  it('starts at 08:00, so the opening day early hours are EXCLUDED', () => {
    const { fromIso } = businessDayWindow('2026-09-30', '2026-09-30');
    // 07:59 belongs to the night before and must fall outside.
    expect('2026-09-30T07:59:00' < fromIso).toBe(true);
    expect('2026-09-30T08:00:00' < fromIso).toBe(false);
  });

  it('ends at 04:00 next morning, so the night tail is INCLUDED', () => {
    const { toIso } = businessDayWindow('2026-09-30', '2026-09-30');
    // 01:00 after midnight is still this business day.
    expect('2026-10-01T01:00:00' <= toIso).toBe(true);
    // 08:00 opens the NEXT business day and must fall outside.
    expect('2026-10-01T08:00:00' <= toIso).toBe(false);
  });
});

describe('todayBusinessDay', () => {
  /* Both ends are the same day: "today" is ONE business day, and the window
     helper is what turns it into the 20-hour span. */
  it('returns one business day, not a span of dates', () => {
    const r = todayBusinessDay();
    expect(r.from).toBe(r.to);
    expect(r.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  /* Between midnight and 08:00 the business day is still YESTERDAY's date, so
     the default must never be simply "the calendar date". This asserts the
     shape holds rather than pinning a clock-dependent value. */
  it('feeds a valid window', () => {
    const { from, to } = todayBusinessDay();
    const w = businessDayWindow(from, to);
    expect(w.fromIso.endsWith('T08:00:00')).toBe(true);
    expect(w.toIso.endsWith('T04:00:00')).toBe(true);
    expect(w.fromIso < w.toIso).toBe(true);
  });
});
