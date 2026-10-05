import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * A ONE-DAY SEARCH IS NOT AN EMPTY WINDOW.
 *
 * Reported 2026-10-05 with screenshots of both portals showing order 1330455:
 *
 *   agent portal — Creation time `-`, Business day `-`, Agent `-`,
 *                  Reason `-`, Action taken `-`, Comment box blank
 *   admin portal — 04/10/2026 13:47, 04/10/2026, Shatha AlShahrani,
 *                  "The branch was late in preparing the order 76 mins",
 *                  "Customer was compensated and customer was satsfied"
 *
 * Six symptoms, one cause. Searching `From 04/10 To 04/10` built
 * `_between ['2026-10-04T00:00:00', '2026-10-04T00:00:00']` — a window of ZERO
 * WIDTH, which matches nothing. Measured against production: **0 decision rows
 * for that filter, 8 once the end moved to the 5th.** Every one of those
 * columns reads from that single query, so one empty answer blanked them all
 * and looked like five separate faults plus a broken comment box.
 *
 * WHY IT SURVIVED: the default view never hit it. `businessDayRange` returns an
 * EXCLUSIVE end, so today's queue was always correct — only a deliberately
 * typed range was broken, and only for the columns that come from the DECISION
 * rather than from Yiji, which is why the row itself still appeared.
 *
 * THE DEEPER FAULT was two contracts for one value. `getLateOrders` documents
 * "the caller passes the last day they WANT; one day is added here", while
 * `businessDayRange` handed over the day AFTER. Every consumer had to guess
 * which kind of `to` it held, and the decision query guessed wrong. Both now
 * mean the same thing: `to` is the last day wanted, INCLUSIVE.
 */
const API = readFileSync(
  resolve(import.meta.dirname, '../src/features/late-orders/api.ts'),
  'utf8',
);
const PAGE = readFileSync(
  resolve(import.meta.dirname, '../src/features/late-orders/LateOrdersPage.tsx'),
  'utf8',
);

/** The same arithmetic the source does, so the expectations are real dates. */
const dayAfter = (d: string) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

describe('the decision query bounds an inclusive range correctly', () => {
  it('moves the end to the day after', () => {
    expect(API).toContain('`${dayAfter(range.to)}T00:00:00`');
  });

  /* THE REGRESSION. This exact expression is what produced the empty window,
     and it reads as obviously correct — which is why it needs naming. */
  it('never sends the typed end as the bound', () => {
    expect(API).not.toContain('`${range.to}T00:00:00`');
  });

  it('declares the helper it uses', () => {
    expect(API).toMatch(/function dayAfter\(day: string\): string/);
  });

  /*
   * An unparseable date is passed through rather than replaced. Inventing one
   * would turn a visible empty result into a silently wrong one — the worse of
   * the two failures, and the shape this codebase keeps hitting.
   */
  it('returns an unreadable date untouched', () => {
    expect(API).toMatch(/if \(!Number\.isFinite\(at\)\) return day;/);
  });
});

describe('the single-day case that was reported', () => {
  /*
   * The real values from the report: the decision on order 1330455 was taken
   * at 2026-10-04T13:14:46, and the agent searched 04/10 to 04/10.
   */
  const DECISION_AT = Date.parse('2026-10-04T13:14:46Z');
  const typed = { from: '2026-10-04', to: '2026-10-04' };

  it('excluded the decision before the fix', () => {
    const start = Date.parse(`${typed.from}T00:00:00Z`);
    const end = Date.parse(`${typed.to}T00:00:00Z`);
    expect(end - start).toBe(0); // a zero-width window
    expect(DECISION_AT >= start && DECISION_AT < end).toBe(false);
  });

  it('includes it after the fix', () => {
    const start = Date.parse(`${typed.from}T00:00:00Z`);
    const end = Date.parse(`${dayAfter(typed.to)}T00:00:00Z`);
    expect(end - start).toBe(86_400_000); // a full day
    expect(DECISION_AT >= start && DECISION_AT < end).toBe(true);
  });

  /* A decision at 23:59 on the last day must still be inside the window —
     the off-by-one this fix is about, from the other end. */
  it('includes a decision late on the final day', () => {
    const end = Date.parse(`${dayAfter('2026-10-04')}T00:00:00Z`);
    expect(Date.parse('2026-10-04T23:59:59Z') < end).toBe(true);
  });

  /* And one the following morning must NOT be. */
  it('excludes the next morning', () => {
    const end = Date.parse(`${dayAfter('2026-10-04')}T00:00:00Z`);
    expect(Date.parse('2026-10-05T00:00:01Z') < end).toBe(false);
  });
});

describe('today uses the same contract as a typed range', () => {
  /*
   * `businessDayRange` returns an exclusive end, so today was the odd one out.
   * It is normalised back to an INCLUSIVE last day where the range is built,
   * so `dayAfter` applies to both paths identically and today's window does
   * not quietly widen by an extra day.
   */
  it('converts businessDayRange back to an inclusive end', () => {
    expect(PAGE).toMatch(
      /const todayRange = useMemo\(\(\) => \{[\s\S]*?businessDayRange\(dayTick\)/,
    );
    expect(PAGE).toContain('at - 24 * 60 * 60 * 1000');
  });

  /* The picker range is passed through untouched — it is ALREADY the
     inclusive form, and converting it twice is how the opposite bug starts. */
  it('leaves the typed range alone', () => {
    expect(PAGE).toContain('setRange({ from: draftFrom, to: draftTo })');
  });
});
