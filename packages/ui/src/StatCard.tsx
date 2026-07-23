import type { HTMLAttributes, JSX, ReactNode } from 'react';
import { cn } from './cn.js';

export interface StatCardProps extends HTMLAttributes<HTMLDivElement> {
  label: ReactNode;
  value: ReactNode;
  /** Optional small caption under the value (e.g. "vs last week"). */
  caption?: ReactNode;
  /** Optional leading icon, rendered in a tinted tile. */
  icon?: ReactNode;
  /** Tone of the label dot / accent treatment. */
  tone?: 'default' | 'primary' | 'success' | 'warning' | 'destructive' | 'pink';
}

const dotBg: Record<NonNullable<StatCardProps['tone']>, string> = {
  default: 'bg-muted-foreground/50',
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
  pink: 'bg-[oklch(0.65_0.20_0)]',
};

/**
 * Executive KPI card — a floating surface with an uppercase label (tone dot
 * carries semantics), a big tabular number, and an optional caption.
 * `tone="primary"` additionally tints the surface for the one metric that
 * deserves the accent.
 */
export function StatCard({
  label,
  value,
  caption,
  icon: _icon,
  tone = 'default',
  className,
  ...rest
}: StatCardProps): JSX.Element {
  const accent = tone === 'primary';
  return (
    <div
      className={cn(
        'flex flex-col gap-1 rounded-2xl px-5 py-4 shadow-soft',
        accent
          ? 'bg-primary-subtle/50 ring-1 ring-primary/25'
          : 'bg-card ring-1 ring-foreground/[0.06]',
        className,
      )}
      {...rest}
    >
      <div
        className={cn(
          'flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.14em]',
          accent ? 'text-primary/80' : 'text-muted-foreground',
        )}
      >
        {tone !== 'default' && !accent && (
          <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', dotBg[tone])} />
        )}
        <span>{label}</span>
      </div>
      <div
        className={cn(
          'text-3xl font-bold tabular-nums tracking-[-0.025em]',
          accent ? 'text-primary' : 'text-foreground',
        )}
      >
        {value}
      </div>
      {caption && (
        <div className={cn('text-xs', accent ? 'text-primary/70' : 'text-muted-foreground')}>
          {caption}
        </div>
      )}
    </div>
  );
}
