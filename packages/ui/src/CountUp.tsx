import { createContext, useContext, useLayoutEffect, useRef, useState } from 'react';
import type { JSX, ReactNode } from 'react';

/*
 * Counting numerals for the headline tiles, OPT-IN per portal.
 *
 * The context defaults to OFF, so a portal that never mounts the provider (the
 * agent portal) renders every value exactly as it did before: the plain string,
 * no effect, no frame loop. The admin console turns it on in its shell.
 *
 * What it animates, and what it deliberately does not:
 *   - only a value that PARSES as one number with an optional prefix/suffix
 *     ("128", "1,204", "87%", "SAR 12.5"); "12m 30s", "—" or a date stay as
 *     written, because there is no honest in-between for them;
 *   - only when the value CHANGES — the first number after a dash (data
 *     arriving) or a new number after a refresh. A poll that returns the same
 *     figure re-renders and does nothing;
 *   - never under `prefers-reduced-motion`, and never where `matchMedia` is
 *     missing (jsdom), so tests always read the final value.
 *
 * Plain requestAnimationFrame and a state update per frame: a report has at
 * most eight tiles and the run lasts 650ms, so no library is worth its bytes.
 */

export interface MetricMotion {
  /** Count numerals up when they change. */
  animate: boolean;
  /** Short line shown under an EMPTY tile ("No data in range"). */
  emptyHint?: string;
}

const MetricMotionContext = createContext<MetricMotion>({ animate: false });

export function MetricMotionProvider({
  value,
  children,
}: {
  value: MetricMotion;
  children: ReactNode;
}): JSX.Element {
  return <MetricMotionContext.Provider value={value}>{children}</MetricMotionContext.Provider>;
}

export function useMetricMotion(): MetricMotion {
  return useContext(MetricMotionContext);
}

/** The values a tile shows when it has nothing to say. */
export function isEmptyMetric(value: unknown): boolean {
  return value == null || value === '' || value === '—' || value === '–' || value === '-';
}

interface Parsed {
  prefix: string;
  n: number;
  suffix: string;
  decimals: number;
  grouped: boolean;
}

/* One number, optionally signed, optionally grouped with commas, optionally
   with decimals; anything else around it must be digit-free. */
const NUMBER = /^([^\d-]*?)(-?\d{1,3}(?:,\d{3})+|-?\d+)(\.\d+)?([^\d]*)$/;

function parse(value: string): Parsed | null {
  const m = NUMBER.exec(value.trim());
  if (!m) return null;
  const whole = m[2]!;
  const frac = m[3] ?? '';
  const n = Number(whole.replace(/,/g, '') + frac);
  if (!Number.isFinite(n)) return null;
  return {
    prefix: m[1] ?? '',
    n,
    suffix: m[4] ?? '',
    decimals: frac ? frac.length - 1 : 0,
    grouped: whole.includes(','),
  };
}

function format(p: Parsed, n: number): string {
  const fixed = n.toFixed(p.decimals);
  if (!p.grouped) return `${p.prefix}${fixed}${p.suffix}`;
  const [i, f] = fixed.split('.');
  const grouped = (i ?? '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${p.prefix}${grouped}${f ? `.${f}` : ''}${p.suffix}`;
}

function motionAllowed(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  if (typeof window.requestAnimationFrame !== 'function') return false;
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const DURATION = 650;
/* ease-out-quart: fast off the mark, settles softly — no overshoot, so the
   number never shows a value larger than the real one. */
const easeOut = (t: number) => 1 - (1 - t) ** 4;

/**
 * Renders `value`, counting up to it when it changes. Non-string values and
 * values that are not a single number render untouched.
 */
export function CountUp({ value }: { value: ReactNode }): JSX.Element {
  const { animate } = useMetricMotion();
  const text = typeof value === 'string' || typeof value === 'number' ? String(value) : null;
  const [shown, setShown] = useState<string | null>(null);
  /* The number currently ON SCREEN — where the next run starts. Null until a
     number has been shown, so data arriving counts up from zero. Tracked per
     frame (not just at the end) so a run cut short by a new value, or by
     StrictMode's mount-unmount-mount, resumes from what the reader saw. */
  const current = useRef<number | null>(null);

  /* A layout effect so the first frame of a run replaces the final value
     before paint — otherwise the tile flashes the answer, then drops to 0. */
  useLayoutEffect(() => {
    if (!animate || text == null) return;
    const target = parse(text);
    if (!target) {
      current.current = null;
      return;
    }
    const from = current.current ?? 0;
    if (from === target.n || !motionAllowed()) {
      current.current = target.n;
      setShown(null);
      return;
    }
    let raf = 0;
    let start = 0;
    const step = (now: number) => {
      if (!start) start = now;
      const t = Math.min(1, (now - start) / DURATION);
      if (t >= 1) {
        current.current = target.n;
        setShown(null);
        return;
      }
      const n = from + (target.n - from) * easeOut(t);
      current.current = n;
      setShown(format(target, n));
      raf = window.requestAnimationFrame(step);
    };
    current.current = from;
    setShown(format(target, from));
    raf = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(raf);
  }, [animate, text]);

  if (text == null) return <>{value}</>;
  return <>{animate && shown != null ? shown : text}</>;
}
