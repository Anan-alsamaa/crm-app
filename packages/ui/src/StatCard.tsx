import type { HTMLAttributes, JSX, ReactNode } from 'react';
import { cn } from './cn.js';

export interface StatCardProps extends HTMLAttributes<HTMLDivElement> {
  label: ReactNode;
  value: ReactNode;
  /** Optional small caption under the label (e.g. "vs last week"). */
  caption?: ReactNode;
  /** Optional leading icon — rendered inside a tinted rounded-square chip. */
  icon?: ReactNode;
  /** Tone of the icon chip / label dot / value accent. */
  tone?: 'default' | 'primary' | 'success' | 'warning' | 'destructive' | 'pink';
  /** Tiny raised unit beside the value (e.g. "MW", "%", "SAR"). */
  unit?: ReactNode;
  /** Optional delta pill after the value — pass a `<DeltaBadge>`. */
  delta?: ReactNode;
  /** Optional data accent at the end — a `<ProgressRing>` or `<Sparkline>`. */
  visual?: ReactNode;
}

// Icon chip fills — tint + hue token pairs so both themes hold.
const chipTone: Record<NonNullable<StatCardProps['tone']>, string> = {
  default: 'bg-secondary text-muted-foreground',
  primary: 'bg-primary-tint text-primary',
  success: 'bg-success-tint text-success',
  // Warning is a light token: a warning-tinted chip fails contrast on the
  // light theme, so the warning tone keeps the neutral chip (its label dot
  // still carries the hue).
  warning: 'bg-secondary text-muted-foreground',
  destructive: 'bg-destructive-tint text-destructive',
  pink: 'bg-magenta/15 text-magenta',
};

const dotBg: Record<NonNullable<StatCardProps['tone']>, string> = {
  default: 'bg-muted-foreground/50',
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
  pink: 'bg-magenta',
};

/**
 * Boxed board-style KPI card — elevated surface, hairline ring, hero numeral
 * with a tiny raised unit, uppercase micro-label underneath. Optional anatomy:
 * a tinted icon chip at the start, a delta pill beside the value, and a data
 * accent (ring / sparkline) at the end. The premium dashboard move: one card
 * per number, typography does the ranking.
 */
export function StatCard({
  label,
  value,
  caption,
  icon,
  tone = 'default',
  unit,
  delta,
  visual,
  className,
  ...rest
}: StatCardProps): JSX.Element {
  const accent = tone === 'primary';
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-2xl bg-card p-4 ring-1 ring-foreground/[0.06] shadow-soft',
        className,
      )}
      {...rest}
    >
      {icon && (
        <span
          aria-hidden
          className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg', chipTone[tone])}
        >
          {icon}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
          <span
            className={cn(
              'text-3xl font-extrabold tabular-nums tracking-[-0.03em] leading-none',
              // OBSIDIAN + JADE: the accent numeral is solid jade — the
              // gradient clip-text was the last survivor of the aurora look.
              accent ? 'text-primary' : 'text-foreground',
            )}
          >
            {value}
          </span>
          {unit != null && (
            <span className="text-2xs font-semibold text-muted-foreground">{unit}</span>
          )}
          {delta}
        </div>
        <div className="mt-1.5 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          {tone !== 'default' && !icon && (
            <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dotBg[tone])} />
          )}
          <span className="truncate">{label}</span>
        </div>
        {caption && <div className="mt-1 text-xs text-muted-foreground">{caption}</div>}
      </div>
      {visual && <div className="shrink-0 self-center">{visual}</div>}
    </div>
  );
}
