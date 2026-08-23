import { useCallback, useEffect, useState } from 'react';

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

export function useRememberedRange(key: string): {
  from: string;
  to: string;
  setFrom: (v: string) => void;
  setTo: (v: string) => void;
  setRange: (r: DateRange) => void;
  /** Back to the last month, and forget what was stored. */
  reset: () => void;
} {
  const [range, setRangeState] = useState<DateRange>(() => read(key) ?? lastMonth());

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
    setRangeState(lastMonth());
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* nothing to undo */
    }
  }, [key]);

  return { from: range.from, to: range.to, setFrom, setTo, setRange, reset };
}
