/*
 * Compact relative time for list rows. "5m", "2h", "Mon", "Mar 14".
 * Always uses the agent's locale for day-of-week / date fallback.
 */
import { useEffect, useState } from 'react';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * A clock that ticks, so a relative timestamp stays honest.
 *
 * `formatRelative` reads `Date.now()` when it is CALLED, and nothing calls it
 * again unless React happens to re-render that row. A background tab does not
 * re-render at all, so an agent working in another tab came back to an inbox
 * still showing the age the row had when they left: the chat said "1m" when the
 * customer had been waiting five (owner, 2026-09-15). Pressing refresh produced
 * the real figure, which is what made it look like the assignment logic itself
 * was stalled.
 *
 * It never was — the escalation ladder runs on the server, on its own timers,
 * and had been counting the whole time. This only fixes what the SCREEN said.
 *
 * One interval per component, unref'd by React on unmount. 30s rather than 1s:
 * the shortest unit rendered is a minute, so a faster tick would burn renders
 * to produce identical text.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    /*
     * Catch up the moment the tab is looked at again. A hidden tab has its
     * timers throttled hard by the browser — to once a minute or less — so the
     * interval alone can leave the first paint after a return showing a stale
     * figure, which is the exact symptom being fixed.
     */
    const onVisible = () => {
      if (document.visibilityState === 'visible') setNow(Date.now());
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [intervalMs]);
  return now;
}

export function formatRelative(
  iso: string | null | undefined,
  locale = 'en',
  /**
   * The moment to measure from. Defaults to "right now", which is correct for
   * a one-off render.
   *
   * A list that must keep counting passes `useNow()` here instead. That does
   * two things at once: it pins every row in one render to the same instant,
   * and — because the value is an argument — the render genuinely DEPENDS on
   * the clock, so React redraws the row when it ticks. Reading `Date.now()`
   * internally could never do that: nothing re-rendered, so the text froze at
   * whatever it said when the agent last looked (owner, 2026-09-15).
   */
  nowMs?: number,
): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!t) return '';
  const now = nowMs ?? Date.now();
  const diff = now - t;

  if (diff < MINUTE) return 'now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  if (diff < WEEK) {
    return new Date(t).toLocaleDateString(locale, { weekday: 'short' });
  }
  // Older — show "Mar 14" / "14 mar".
  return new Date(t).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

/**
 * The product's one date format: dd/mm/yyyy.
 *
 * Fixed rather than locale-derived, and deliberately so. These dates are read
 * by one operations team, quoted back in emails, and pasted into spreadsheets;
 * a browser that decides to render 3/4 as April 3rd in one place and March 4th
 * in another turns a date into a guess.
 *
 * Both parts are zero-padded. Beyond looking tidy it makes the strings sort
 * and align as text, which is what a column of dates in a table needs — and it
 * removes the last case where 3/4/2026 could be read either way round.
 *
 * Latin digits always — an Arabic locale would otherwise render ٣/٠٤/٢٠٢٦,
 * which is correct Arabic and unsearchable next to the same date typed by
 * anyone else.
 */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

/** `formatDate` plus 24-hour time — for anything that has to be tracked, not just dated. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${formatDate(iso)} ${hh}:${mm}`;
}
