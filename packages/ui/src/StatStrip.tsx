import type { JSX } from 'react';
import { cn } from './cn.js';

export type StatStripTone = 'blue' | 'violet' | 'green' | 'amber' | 'crimson' | 'neutral';

// Vibrant tinted tiles — saturated wash + strong matching number per tone
// (the colorful stat-card pattern from the reference dashboards).
const TILE: Record<StatStripTone, string> = {
  blue: 'bg-sky-500/10 ring-sky-500/25',
  violet: 'bg-violet-500/10 ring-violet-500/25',
  green: 'bg-emerald-500/10 ring-emerald-500/25',
  amber: 'bg-orange-400/15 ring-orange-400/30',
  crimson: 'bg-rose-500/10 ring-rose-500/25',
  neutral: 'bg-card ring-foreground/[0.06]',
};
const NUM: Record<StatStripTone, string> = {
  blue: 'text-sky-600',
  violet: 'text-violet-600',
  green: 'text-emerald-600',
  amber: 'text-orange-500',
  crimson: 'text-rose-600',
  neutral: 'text-foreground',
};
const DOT: Record<StatStripTone, string> = {
  blue: 'bg-sky-500',
  violet: 'bg-violet-500',
  green: 'bg-emerald-500',
  amber: 'bg-orange-400',
  crimson: 'bg-rose-500',
  neutral: 'bg-muted-foreground/50',
};

export interface StatStripItem {
  label: string;
  value: string | number;
  tone?: StatStripTone;
}

/**
 * A row of colorful stat tiles used at the top of list pages — the bold
 * rebrand header that replaces thin "2 total · 2 active" toolbar text.
 * Auto-fits: tiles wrap responsively.
 */
export function StatStrip({
  items,
  className,
}: {
  items: StatStripItem[];
  className?: string;
}): JSX.Element {
  return (
    <div
      className={cn('grid grid-cols-2 gap-3 sm:grid-cols-4', className)}
      role="list"
      aria-label="Summary statistics"
    >
      {items.map((it, i) => {
        const tone = it.tone ?? 'neutral';
        return (
          <div
            key={i}
            role="listitem"
            className={cn(
              'rounded-2xl px-4 py-3 shadow-soft ring-1 transition-[box-shadow,transform] duration-base ease-out hover:shadow-float motion-safe:hover:-translate-y-0.5',
              TILE[tone],
            )}
          >
            <div className={cn('text-2xl font-extrabold leading-none tabular-nums', NUM[tone])}>
              {it.value}
            </div>
            <div className="mt-1 flex items-center gap-1.5">
              <span className={cn('h-1.5 w-1.5 rounded-full', DOT[tone])} aria-hidden />
              <span className="text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                {it.label}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
