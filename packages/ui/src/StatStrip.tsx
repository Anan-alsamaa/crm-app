import type { JSX } from 'react';
import { cn } from './cn.js';

export type StatStripTone = 'blue' | 'violet' | 'green' | 'amber' | 'crimson' | 'neutral';

// Boxed mini KPI tiles — a uniform card box, with the tone carried by the
// numeral hue + dot (the board-style stat-tile pattern from the reference
// dashboards). Theme tokens only, so the light theme survives.
const NUM: Record<StatStripTone, string> = {
  blue: 'text-sky',
  violet: 'text-violet',
  green: 'text-success',
  // `--warning` is a light token (its ink flips per theme), so a warning-hued
  // numeral fails contrast on the card in one theme or the other. Keep the
  // number in foreground ink and let the dot carry the hue.
  amber: 'text-foreground',
  crimson: 'text-destructive',
  neutral: 'text-foreground',
};
const DOT: Record<StatStripTone, string> = {
  blue: 'bg-sky',
  violet: 'bg-violet',
  green: 'bg-success',
  amber: 'bg-warning',
  crimson: 'bg-destructive',
  neutral: 'bg-muted-foreground/50',
};

export interface StatStripItem {
  label: string;
  value: string | number;
  tone?: StatStripTone;
}

/**
 * A row of boxed stat tiles used at the top of list pages — the bold
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
            className="rounded-xl bg-card px-3 py-2 shadow-soft ring-1 ring-foreground/[0.06] transition-[box-shadow,transform] duration-base ease-out hover:shadow-float motion-safe:hover:-translate-y-0.5"
          >
            <div
              className={cn(
                'text-2xl font-extrabold leading-none tabular-nums tracking-[-0.03em]',
                NUM[tone],
              )}
            >
              {it.value}
            </div>
            <div className="mt-1 flex items-center gap-1.5">
              <span className={cn('h-1.5 w-1.5 rounded-full', DOT[tone])} aria-hidden />
              <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {it.label}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
