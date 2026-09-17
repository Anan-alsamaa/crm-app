import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRememberedRange, isoDay } from '../src/lib/date-range.js';

/*
 * A REMEMBERED RANGE MUST NOT SILENTLY STOP AT THE DAY IT WAS STORED.
 *
 * "The last month up to today" is saved as a literal `to` date, so once
 * stored it means "up to the 13th" for ever. Every ticket raised after that
 * day then falls outside the report with nothing saying so — Ticket breakdown
 * showed ONE old row and a KPI of 1, which reads as lost data rather than a
 * date filter (owner, 2026-09-17).
 */
const KEY = 'test.range';
const DAY = 86_400_000;
const day = (offset: number) => isoDay(new Date(Date.now() + offset * DAY));

beforeEach(() => localStorage.clear());
afterEach(() => vi.useRealTimers());

function stored(from: string, to: string) {
  localStorage.setItem(KEY, JSON.stringify({ from, to }));
  return renderHook(() => useRememberedRange(KEY)).result.current;
}

describe('a remembered range', () => {
  it('rolls an "up to today" range forward, keeping its span', () => {
    // Saved four days ago as a 30-day window; today it must still reach today.
    const r = stored(day(-34), day(-4));
    expect(r.to).toBe(day(0));
    expect(Date.parse(r.to) - Date.parse(r.from)).toBe(30 * DAY);
  });

  it('rolls forward from yesterday — the ordinary overnight case', () => {
    const r = stored(day(-31), day(-1));
    expect(r.to).toBe(day(0));
  });

  it('leaves a range that already reaches today alone', () => {
    const r = stored(day(-30), day(0));
    expect(r.from).toBe(day(-30));
    expect(r.to).toBe(day(0));
  });

  /* Somebody looking at August means August. Only the "up to now" case moves —
     a deliberately historical range must not be dragged to the present. The
     test is whether the range sits further behind today than its own span. */
  it('leaves a deliberately historical range untouched', () => {
    // A 30-day window ending 90 days ago: stale by far more than it covers.
    const r = stored(day(-120), day(-90));
    expect(r.from).toBe(day(-120));
    expect(r.to).toBe(day(-90));
  });

  it('rolls forward a window stale by less than its own span', () => {
    // 30 days wide, 4 days behind — the reported case.
    const r = stored(day(-34), day(-4));
    expect(r.to).toBe(day(0));
  });

  it('falls back to the last month when nothing is stored', () => {
    const r = renderHook(() => useRememberedRange(KEY)).result.current;
    expect(r.to).toBe(day(0));
  });
});
