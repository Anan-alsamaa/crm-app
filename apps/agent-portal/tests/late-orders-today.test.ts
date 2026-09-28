import { describe, it, expect } from 'vitest';
import { businessDay, businessDayRange, isLiveOrderStatus } from '@yiji/shared-types';

/**
 * TODAY MUST NOT LOSE AN ORDER WHEN IT FINISHES.
 *
 * The defect (owner, 2026-09-28): *"today had 1 record and suddenly became
 * empty. on searching from and to in date range the data is there, but it
 * shouldve been there on today"*.
 *
 * Today used to FILTER THE LIVE QUEUE. The live queue holds only orders whose
 * status is still running — which is correct for "Live only", and the owner
 * confirmed that behaviour is right — so every row deleted itself the moment
 * its order was delivered, and the day's list drained towards zero as the day
 * went on. Nothing failed; the number just got quietly smaller.
 *
 * The fix makes Today LOAD the business day instead, which puts the gateway
 * into register mode and keeps completed rows. These tests pin the two facts
 * that fix depends on, because the page itself has no mount test and this
 * button has now been wrong twice.
 */
describe('Today = the business day, not the live queue', () => {
  /*
   * THE HEART OF IT. A delivered order is NOT live — and must still be inside
   * the window Today asks for.
   */
  it('keeps a finished order inside the window it was placed in', () => {
    // Placed 14:00, delivered 14:40. Status 9 is not in the live set.
    const placed = '2026-09-28T14:00:00';
    expect(isLiveOrderStatus(9)).toBe(false);

    const day = businessDay(placed);
    expect(day).toBe('2026-09-28');

    const span = businessDayRange(day!);
    const placedDate = placed.slice(0, 10);
    expect(placedDate >= span.from && placedDate <= span.to).toBe(true);
  });

  /*
   * The live queue is status-filtered and Today is not. If these ever agree,
   * the fix has been reverted.
   */
  it('does not inherit the live status filter', () => {
    const liveOnly = [2, 3, 4, 5, 7, 8, 65].every((s) => isLiveOrderStatus(s));
    expect(liveOnly).toBe(true);
    // Finished and cancelled are excluded from LIVE...
    for (const finished of [9, 10, 11]) expect(isLiveOrderStatus(finished)).toBe(false);
    // ...but the business day of a finished order still resolves, which is what
    // lets Today show it.
    expect(businessDay('2026-09-28T14:40:00')).toBe('2026-09-28');
  });

  /*
   * A BUSINESS DAY CROSSES MIDNIGHT, so Today must ask for two calendar dates.
   * Asking for one loses the entire after-midnight half of a night's trading —
   * silently, because the evening rows are still there.
   */
  it('asks for both calendar dates the trading day touches', () => {
    const span = businessDayRange('2026-09-28');
    expect(span).toEqual({ from: '2026-09-28', to: '2026-09-29' });

    // An order at 01:00 belongs to the 28th's trading and is inside the window.
    const afterMidnight = '2026-09-29T01:00:00';
    expect(businessDay(afterMidnight)).toBe('2026-09-28');
    expect(afterMidnight.slice(0, 10) <= span.to).toBe(true);
  });

  /*
   * The window is WIDER than the business day on purpose — Yiji filters on
   * dates, not hours — so rows must still be narrowed per row. An order at
   * 05:00 on the 29th is inside the requested dates but belongs to the 29th's
   * own trading day, and must NOT show under the 28th.
   */
  it('still needs the per-row business-day filter, because the window is wider', () => {
    const span = businessDayRange('2026-09-28');
    /* 09:00 on the 29th: the 29th has OPENED, so this is the 29th's trading —
       but the date is still inside the window asked for on the 28th. Note it
       has to be after 08:00: the 04:00-08:00 hours belong to the day that just
       ended, which the test below covers. */
    const nextDayOpen = '2026-09-29T09:00:00';
    // Inside the dates asked for...
    expect(nextDayOpen.slice(0, 10) <= span.to).toBe(true);
    // ...but NOT the same business day, so the row filter excludes it.
    expect(businessDay(nextDayOpen)).toBe('2026-09-29');
  });

  /* The 04:00-08:00 tail belongs to the day that just ended (owner's rule), so
     it must fall inside that day's window too. */
  it('covers the pre-opening tail that belongs to the previous day', () => {
    const tail = '2026-09-29T06:00:00';
    expect(businessDay(tail)).toBe('2026-09-28');
    const span = businessDayRange('2026-09-28');
    expect(tail.slice(0, 10) <= span.to).toBe(true);
  });
});
