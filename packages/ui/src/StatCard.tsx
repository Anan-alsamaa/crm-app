import type { HTMLAttributes, JSX, ReactNode } from 'react';
import { cn } from './cn.js';

export interface StatCardProps extends HTMLAttributes<HTMLDivElement> {
  label: ReactNode;
  value: ReactNode;
  /** Optional small caption under the value (e.g. "vs last week"). */
  caption?: ReactNode;
  /** Optional leading icon, rendered in a tinted tile. */
  icon?: ReactNode;
  /** Tone of the icon tile. */
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
 * Borderless metric block — use inside a flex/grid strip. No card, no border.
 * Reads as a series of big numbers separated by whitespace; a tiny tone dot
 * carries any semantic colour rather than a tinted tile.
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
  return (
    <div className={cn('flex flex-col gap-1', className)} {...rest}>
      <div className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {tone !== 'default' && (
          <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', dotBg[tone])} />
        )}
        <span>{label}</span>
      </div>
      <div className="text-3xl font-semibold tabular-nums tracking-[-0.025em] text-foreground">
        {value}
      </div>
      {caption && <div className="text-xs text-muted-foreground">{caption}</div>}
    </div>
  );
}
