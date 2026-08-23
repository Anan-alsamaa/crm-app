import type { JSX, ReactNode } from 'react';
import { cn } from './cn.js';

/*
 * The headline tile a report puts above its table, and the strip that holds a
 * row of them.
 *
 * It lived inside one page and was copied — with drift — into the others, which
 * is how five reports ended up with four different ideas of what a summary
 * number looks like. One definition here, used by all of them.
 *
 * Colour is an ACCENT, not a fill: a solid saturated tile reads as a toy
 * dashboard, and a numeral the same colour as its own background is invisible.
 * The surface carries a faint wash, the chip carries the hue, and the numeral
 * stays ink — which is also the strongest contrast available.
 */

export type ReportKpiTone = 'blue' | 'violet' | 'green' | 'amber';

const DOT_TONE: Record<ReportKpiTone, string> = {
  blue: 'bg-sky',
  violet: 'bg-violet',
  green: 'bg-success',
  amber: 'bg-warning',
};
/* Icon chips take tint + hue token pairs; amber stays NEUTRAL — warning is a
 * light token and a warning-tinted chip fails contrast on the light theme. */
const CHIP_TONE: Record<ReportKpiTone, string> = {
  blue: 'bg-sky-tint text-sky',
  violet: 'bg-violet-tint text-violet',
  green: 'bg-success-tint text-success',
  amber: 'bg-secondary text-muted-foreground',
};
/* The SURFACE carries the hue too — a row of white boxes with one small
 * coloured square each reads as a form, not a dashboard. */
const SURFACE_TONE: Record<ReportKpiTone, string> = {
  blue: 'bg-gradient-to-br from-sky-tint/70 to-card',
  violet: 'bg-gradient-to-br from-violet-tint/70 to-card',
  green: 'bg-gradient-to-br from-success-tint/70 to-card',
  amber: 'bg-gradient-to-br from-warning-tint/70 to-card',
};
const NUMERAL_TONE: Record<ReportKpiTone, string> = {
  blue: 'text-[oklch(0.48_0.16_264)]',
  violet: 'text-[oklch(0.48_0.19_285)]',
  green: 'text-[oklch(0.45_0.13_155)]',
  amber: 'text-[oklch(0.5_0.13_75)]',
};

export interface ReportKpiProps {
  label: string;
  value: string;
  tone: ReportKpiTone;
  /** Rendered inside a tinted rounded-square chip above the numeral. */
  icon?: ReactNode;
  /**
   * A second line under the label — the WHEN or the SHARE behind a number,
   * where there is one. Deliberately BELOW the label, never between it and the
   * numeral: the KPI reader in the tests walks that pair as adjacent siblings.
   */
  hint?: string;
}

export function ReportKpi({ label, value, tone, icon, hint }: ReportKpiProps): JSX.Element {
  return (
    <div
      className={cn(
        'rounded-2xl p-5 shadow-[0_1px_2px_oklch(var(--shadow-color)/0.06),0_12px_32px_-12px_oklch(var(--shadow-color)/0.18)]',
        'transition-[box-shadow,transform] duration-base ease-out motion-safe:hover:-translate-y-1',
        'hover:shadow-[0_2px_4px_oklch(var(--shadow-color)/0.08),0_20px_44px_-16px_oklch(var(--shadow-color)/0.28)]',
        SURFACE_TONE[tone],
      )}
    >
      {icon && (
        <span
          aria-hidden
          className={cn('mb-3 grid h-9 w-9 place-items-center rounded-lg', CHIP_TONE[tone])}
        >
          {icon}
        </span>
      )}
      {/* Numeral first, label as its NEXT sibling — the KPI reader in the
          tests walks exactly this pair, so the anatomy is contractual. */}
      <div
        className={cn(
          'text-4xl font-extrabold tabular-nums leading-none tracking-[-0.03em]',
          NUMERAL_TONE[tone],
        )}
      >
        {value}
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', DOT_TONE[tone])} />
        {label}
      </div>
      {hint && <div className="mt-1 text-2xs tabular-nums text-muted-foreground">{hint}</div>}
    </div>
  );
}

/**
 * The strip of headline numbers above a report's table.
 *
 * Two across on a phone rather than four: four numerals at this size across
 * 360px is four numbers nobody can read, and the tile's whole job is being
 * readable at a glance.
 */
export function ReportKpiStrip({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return <div className={cn('grid grid-cols-2 gap-3 lg:grid-cols-4', className)}>{children}</div>;
}
