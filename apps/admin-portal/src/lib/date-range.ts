import { useCallback, useEffect, useState } from 'react';
import { businessDay } from '@yiji/shared-types';

/**
 * A from/to range that remembers what you last looked at.
 *
 * Every report opened on its own idea of "recently" and forgot the moment you
 * left, so anyone working a month-end across four reports typed the same two
 * dates four times, then typed them again after a refresh.
 *
 * Rules, in order:
 *   1. whatever this browser last had — that is the range you were working in;
 *   2. failing that, the last month up to today.
 *
 * Stored per key so a report can keep its own range where that makes sense,
 * and shared by passing the same key where it does not. localStorage rather
 * than the URL because it should survive a fresh visit, not just a reload; and
 * every access is guarded, because a browser with site data blocked throws on
 * read as well as write.
 */

const DAY = 86_400_000;

/** `yyyy-mm-dd` in LOCAL time — the same day the date input shows. */
export function isoDay(d: Date): string {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

export interface DateRange {
  from: string;
  to: string;
}

/** The fallback: one month back, up to today. */
export function lastMonth(): DateRange {
  const now = new Date();
  return { from: isoDay(new Date(now.getTime() - 30 * DAY)), to: isoDay(now) };
}

/**
 * TODAY'S BUSINESS DAY — the default every dated report opens on
 * (owner, 2026-09-30).
 *
 * A business day runs 08:00 to 04:00 the next morning and is NAMED after the
 * day it opened, so between midnight and 08:00 the answer is still YESTERDAY's
 * date. A report defaulting to the calendar date would, at 01:00, open on a day
 * that has barely started while the night's work sat under yesterday — and the
 * reader would see an almost empty table with nothing saying why.
 *
 * `businessDay` is the shared rule (`@yiji/shared-types`), evaluated in Riyadh's
 * zone because the boundary is a wall-clock hour in the branch's own day, never
 * the container's. Both ends are the same day: one business day, which is what
 * "today" means here.
 */
/**
 * The BUSINESS-DAY window a From/To pair really means, as ISO stamps.
 *
 * `from=to=2026-09-30` is `2026-09-30T08:00:00` through `2026-10-01T04:00:00`
 * (owner, 2026-09-30). One rule, one helper: every report that hand-rolled
 * `${from}T00:00:00` / `${to}T23:59:59` was answering a different question at
 * both edges — losing the night's work after midnight, and counting the early
 * hours of the opening day that belong to the day before.
 *
 * Local stamps without a zone, matching how the rest of this app filters and
 * how Yiji writes its own timestamps.
 */
export function businessDayWindow(from: string, to: string): { fromIso: string; toIso: string } {
  const close = new Date(`${to}T00:00:00Z`);
  close.setUTCDate(close.getUTCDate() + 1);
  return {
    fromIso: `${from}T08:00:00`,
    toIso: `${close.toISOString().slice(0, 10)}T04:00:00`,
  };
}

export function todayBusinessDay(): DateRange {
  const day = businessDay(new Date().toISOString()) ?? isoDay(new Date());
  return { from: day, to: day };
}

/**
 * A REMEMBERED RANGE MUST NOT SILENTLY STOP AT THE DAY IT WAS STORED.
 *
 * The stored value is a literal `to` date, so "the last month up to today",
 * saved once, means "up to the 13th" for ever. Every ticket raised after that
 * day then falls outside the report with nothing on screen saying so — the
 * table simply shows one old row and the KPI agrees with it, which reads as
 * lost data rather than a date filter (owner, 2026-09-17; reproduced exactly
 * by seeding a range ending four days ago).
 *
 * So an end date in the PAST is carried forward to today, keeping the span the
 * user chose.
 *
 * WHICH RANGES MOVE. Only ones that look like "up to now" — those whose stored
 * end was the day they were saved, which is every default and every quick
 * range. There is no timestamp to prove that, so the test is whether the range
 * ENDS AT OR AFTER the span it covers: a rolling window always does, while a
 * deliberately historical one (1–31 August, looked at in September) does not
 * and is left exactly as it is. Somebody looking at August means August.
 *
 * A first attempt only rolled ranges ending yesterday or today, which failed
 * the very case it was written for: the report that prompted this was FOUR
 * days stale. A window is stale by however long you were away.
 */
function rollForward(r: DateRange): DateRange {
  const today = isoDay(new Date());
  if (r.to >= today) return r;
  const span = Date.parse(r.to) - Date.parse(r.from);
  if (!Number.isFinite(span) || span < 0) return r;
  /* How far behind today the stored end sits. A rolling window is stale by at
     most the time since it was last opened; a historical one is stale for ever
     and sits further back than its own span. */
  const behind = Date.parse(today) - Date.parse(r.to);
  if (behind > span) return r;
  return { from: isoDay(new Date(Date.parse(today) - span)), to: today };
}

function read(key: string): DateRange | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DateRange>;
    // Both halves or neither: half a remembered range is worse than none,
    // because it silently answers a different question than the one stored.
    if (typeof parsed.from !== 'string' || typeof parsed.to !== 'string') return null;
    return { from: parsed.from, to: parsed.to };
  } catch {
    return null;
  }
}

export function useRememberedRange(
  key: string,
  /**
   * What the range opens on when nothing is stored.
   *
   * A PARAMETER rather than one global default, because the two honest answers
   * differ by report (owner, 2026-09-30): an operational queue opens on TODAY's
   * business day, while a manager's KPI report opens on the last 30 days — one
   * day of KPIs is not a measure of anything. Both interpret their From/To as
   * business days; only the opening window differs.
   */
  fallback: () => DateRange = todayBusinessDay,
): {
  from: string;
  to: string;
  setFrom: (v: string) => void;
  setTo: (v: string) => void;
  setRange: (r: DateRange) => void;
  /** Back to the caller's default, and forget what was stored. */
  reset: () => void;
} {
  const [range, setRangeState] = useState<DateRange>(() => {
    const stored = read(key);
    /* The caller's default. A stored range still wins — a reader who chose a
       window keeps it. */
    return stored ? rollForward(stored) : fallback();
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(range));
    } catch {
      // A browser refusing to store it is not a reason to refuse to show it.
    }
  }, [key, range]);

  const setFrom = useCallback((from: string) => setRangeState((r) => ({ ...r, from })), []);
  const setTo = useCallback((to: string) => setRangeState((r) => ({ ...r, to })), []);
  const setRange = useCallback((r: DateRange) => setRangeState(r), []);
  const reset = useCallback(() => {
    /* The CALLER'S default, not a hardcoded month. Clear promises to put the
       page back the way it opened, and returning a queue that opens on today to
       a 30-day window would be a different page than the one the reader
       started on. */
    setRangeState(fallback());
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* nothing to undo */
    }
    // `fallback` is a stable module function at every call site; listing it
    // keeps the hook honest if that ever stops being true.
  }, [key, fallback]);

  return { from: range.from, to: range.to, setFrom, setTo, setRange, reset };
}
