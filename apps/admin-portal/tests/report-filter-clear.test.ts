import { describe, it, expect } from 'vitest';
import { businessDay } from '@yiji/shared-types';

/**
 * TWO FILTER RULES THE REPORTS GOT WRONG (owner, 2026-09-30).
 *
 * 1. CLEAR MUST INCLUDE THE DATE RANGE. Every report computed its own
 *    `filtering` flag from its own selects and forgot the range — which lives in
 *    `ReportFilterBar` itself, not on the page. So a reader who changed only the
 *    dates got no Clear button at all: the one filter always on screen was the
 *    one that could not be cleared. The bar now decides this, so no page can
 *    forget it again.
 *
 * 2. THE RANGE MEANS BUSINESS DAYS. from=to=30/09 means 30/09 08:00 through
 *    01/10 04:00. The fetch already widened its window to cover whole nights at
 *    both edges; without a matching business-day filter that widening LEAKS rows
 *    belonging to the neighbouring day into a report claiming to cover only this
 *    one.
 */

/** The bar's own rule, kept here so the intent is pinned even as it moves. */
const rangeNarrowing = (from: string, to: string, def: { from: string; to: string }): boolean =>
  from !== def.from || to !== def.to;

const DEFAULT = { from: '2026-08-31', to: '2026-09-30' };

describe('Clear appears when the date range is narrowing', () => {
  it('does NOT offer Clear for an untouched range', () => {
    expect(rangeNarrowing(DEFAULT.from, DEFAULT.to, DEFAULT)).toBe(false);
  });

  /* THE REPORTED BUG: only the dates changed, so every page's own `filtering`
     said false and Clear stayed hidden. */
  it.each([
    ['only the start moved', '2026-09-01', DEFAULT.to],
    ['only the end moved', DEFAULT.from, '2026-09-29'],
    ['both moved', '2026-09-10', '2026-09-20'],
    ['cleared to empty', '', ''],
  ])('offers Clear when %s', (_label, from, to) => {
    expect(rangeNarrowing(from, to, DEFAULT)).toBe(true);
  });
});

/**
 * The report's own row filter, as the page applies it: a row belongs to the
 * window when its BUSINESS day falls inside it.
 */
const inWindow = (dateCreated: string, from: string, to: string): boolean => {
  const day = businessDay(dateCreated);
  if (!day) return true; // No date to judge — keep it rather than hide work.
  return day >= from && day <= to;
};

describe('the range filters by business day, not calendar date', () => {
  const FROM = '2026-09-30';
  const TO = '2026-09-30';

  /* The trading day opens at 08:00 and runs to 04:00 the next morning, so all
     three of these are the SAME business day (30/09) and must all be kept. */
  it.each([
    ['08:00, the day opening', '2026-09-30T08:00:00'],
    ['midday', '2026-09-30T13:30:00'],
    ['23:50, before midnight', '2026-09-30T23:50:00'],
    ['00:10, after midnight', '2026-10-01T00:10:00'],
    ['03:59, the last minute', '2026-10-01T03:59:00'],
  ])('keeps %s', (_label, at) => {
    expect(inWindow(at, FROM, TO)).toBe(true);
  });

  /*
   * THE LEAK THIS CLOSES. Both of these were FETCHED — the query widens its
   * window to `to + 1 day T04:00` to catch the closing night — but neither
   * belongs to 30/09, and without this filter they appeared in a report claiming
   * to cover it.
   */
  it('drops 07:59 on the opening day, which is the night BEFORE', () => {
    expect(inWindow('2026-09-30T07:59:00', FROM, TO)).toBe(false);
  });

  it('drops 06:00 the next morning, which is the previous day tail... ', () => {
    // 04:00-08:00 on 01/10 still belongs to 30/09 by the rule, so it is KEPT.
    expect(inWindow('2026-10-01T06:00:00', FROM, TO)).toBe(true);
    // 08:00 on 01/10 opens the next day and must be dropped.
    expect(inWindow('2026-10-01T08:00:00', FROM, TO)).toBe(false);
  });

  it('keeps a multi-day range inclusive at both ends', () => {
    expect(inWindow('2026-09-28T09:00:00', '2026-09-28', '2026-09-30')).toBe(true);
    expect(inWindow('2026-10-01T02:00:00', '2026-09-28', '2026-09-30')).toBe(true);
    expect(inWindow('2026-09-27T23:00:00', '2026-09-28', '2026-09-30')).toBe(false);
  });

  /* A row with no date cannot be judged, and hiding it would lose real work
     rather than filter it. */
  it('keeps a row whose date cannot be read', () => {
    expect(inWindow('', FROM, TO)).toBe(true);
    expect(inWindow('not-a-date', FROM, TO)).toBe(true);
  });
});
