import type { JSX } from 'react';
import { cn } from './cn.js';

export type StatStripTone = 'blue' | 'violet' | 'green' | 'amber' | 'crimson' | 'neutral';

const TILE: Record<StatStripTone, string> = {
  blue: 'bg-primary/[0.07] ring-primary/12',
  violet: 'bg-violet/[0.08] ring-violet/12',
  green: 'bg-success/10 ring-success/15',
  amber: 'bg-warning/12 ring-warning/18',
  crimson: 'bg-magenta/[0.07] ring-magenta/12',
  neutral: 'bg-card ring-foreground/[0.05]',
};
const NUM: Record<StatStripTone, string> = {
  blue: 'text-primary',
  violet: 'text-violet',
  green: 'text-success',
  amber: 'text-[oklch(0.5_0.15_70)]',
  crimson: 'text-magenta',
  neutral: 'text-foreground',
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
            <div className="mt-1 text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              {it.label}
            </div>
          </div>
        );
      })}
    </div>
  );
}
