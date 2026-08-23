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
        // ONE LINE, not a stacked card.
        //
        // These four tiles opened every report at 140px. With the tab strip,
        // the toolbar, the description, the filter card and a band holding a
        // single Export button, the table started 585px down — and a laptop at
        // 150% display scaling has 620 CSS pixels in total, so a 25-row page
        // showed four rows with no way to scroll to the rest. Four numbers are
        // worth a glance, not a third of the screen; laid along a line they
        // read just as fast and cost 50px instead of 140.
        'flex items-center gap-3 rounded-xl px-3.5 py-2.5',
        'shadow-[0_1px_2px_oklch(var(--shadow-color)/0.06),0_10px_26px_-14px_oklch(var(--shadow-color)/0.18)]',
        'transition-[box-shadow] duration-base ease-out',
        SURFACE_TONE[tone],
      )}
    >
      {icon && (
        <span
          aria-hidden
          className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg', CHIP_TONE[tone])}
        >
          {icon}
        </span>
      )}
      {/* Numeral, then label. Marked with data attributes rather than left to
          be found by font size: the test helper used to look for `.text-4xl`,
          so restyling the tile from a stacked card to a line silently emptied
          every KPI assertion on four reports. A test that keys on a Tailwind
          size is testing the stylesheet. This pair is the contract. */}
      <div
        data-kpi-value
        className={cn(
          'shrink-0 text-2xl font-extrabold tabular-nums leading-none tracking-[-0.03em]',
          NUMERAL_TONE[tone],
        )}
      >
        {value}
      </div>
      <div
        data-kpi-label
        className="flex min-w-0 items-center gap-1.5 text-2xs font-semibold uppercase leading-tight tracking-[0.1em] text-muted-foreground"
      >
        <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', DOT_TONE[tone])} />
        <span className="min-w-0">{label}</span>
      </div>
      {hint && (
        <div className="ms-auto shrink-0 text-2xs tabular-nums text-muted-foreground">{hint}</div>
      )}
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
  // Capped even when the page around it is not. The TABLE wants the whole
  // monitor; four numerals stretched across 2560px are four numerals with a
  // metre of white between them.
  return (
    <div className={cn('grid max-w-6xl grid-cols-2 gap-2 lg:grid-cols-4', className)}>
      {children}
    </div>
  );
}
