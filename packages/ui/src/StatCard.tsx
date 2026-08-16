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

/*
 * The SURFACE carries the hue, not just the icon chip.
 *
 * A grid of white cards with one small coloured square each reads as a form;
 * the reference's KPIs are soft colour fields you can tell apart from across
 * the room. A very light tint (plus a slightly deeper hairline of the same
 * hue) does that without shouting — and the numeral takes the hue too, which
 * is what actually makes the card feel alive.
 */
const surface: Record<NonNullable<StatCardProps['tone']>, string> = {
  default: 'bg-card ring-foreground/[0.06]',
  primary: 'bg-gradient-to-br from-primary-tint/70 to-card ring-primary/15',
  success: 'bg-gradient-to-br from-success-tint/70 to-card ring-success/15',
  warning: 'bg-gradient-to-br from-warning-tint/70 to-card ring-warning/25',
  destructive: 'bg-gradient-to-br from-destructive-tint/70 to-card ring-destructive/15',
  pink: 'bg-gradient-to-br from-magenta/10 to-card ring-magenta/15',
};

/** Numeral ink per tone — deep enough to stay readable on its own tint. */
const numeral: Record<NonNullable<StatCardProps['tone']>, string> = {
  default: 'text-foreground',
  primary: 'text-primary',
  success: 'text-[oklch(0.45_0.13_155)]',
  warning: 'text-[oklch(0.5_0.13_75)]',
  destructive: 'text-destructive',
  pink: 'text-magenta',
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
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-2xl p-4 ring-1 shadow-soft',
        surface[tone],
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
              // The numeral takes the card's hue — that, more than the tint
              // behind it, is what makes a KPI read as alive rather than as a
              // form field with a big font.
              numeral[tone],
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
