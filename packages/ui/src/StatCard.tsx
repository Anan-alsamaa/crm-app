import type { HTMLAttributes, JSX, ReactNode } from 'react';
import { cn } from './cn.js';

export interface StatCardProps extends HTMLAttributes<HTMLDivElement> {
  label: ReactNode;
  value: ReactNode;
  /** Optional small caption under the value (e.g. "vs last week"). */
  caption?: ReactNode;
  /** Optional leading icon (unused in the open style; kept for API compat). */
  icon?: ReactNode;
  /** Tone of the label dot / value accent. */
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
 * Open metric block — no box. A hero number with an uppercase label and a
 * tone dot, separated from its neighbours by whitespace alone. The modern
 * dashboard move: typography does the work, not card chrome.
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
    <div className={cn('flex flex-col gap-1.5', className)} {...rest}>
      <div className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {tone !== 'default' && (
          <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', dotBg[tone])} />
        )}
        <span>{label}</span>
      </div>
      <div
        className={cn(
          'text-4xl font-extrabold tabular-nums tracking-[-0.03em] leading-none',
          accent ? 'text-primary' : 'text-foreground',
        )}
      >
        {value}
      </div>
      {caption && <div className="text-xs text-muted-foreground">{caption}</div>}
    </div>
  );
}
