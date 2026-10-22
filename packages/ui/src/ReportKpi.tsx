import type { JSX, ReactNode } from 'react';
import { cn } from './cn.js';
import { CountUp, isEmptyMetric, useMetricMotion } from './CountUp.js';

/*
 * The headline tile a report puts above its table, and the strip that holds a
 * row of them.
 *
 * It lived inside one page and was copied — with drift — into the others, which
 * is how five reports ended up with four different ideas of what a summary
 * number looks like. One definition here, used by all of them.
 *
 * A METRIC CARD (owner, 2026-10-22: the one-line tiles "look very badly
 * designed"). The Dashboard's tile language: the label on top where the eye
 * starts, a round icon chip opposite it, the numeral large underneath, and one
 * quiet supporting line at the foot — the share, the day, or, when there is
 * nothing to show, a short reason instead of a lone dash. Every tile in a strip
 * is the same height whether or not it has a hint.
 *
 * Colour is an ACCENT, not a fill: the chip carries the hue and the numeral
 * stays ink, which is also the strongest contrast available.
 *
 * Only the admin console renders this. Its stylesheet adds the hover lift and
 * the entrance; the component itself carries no motion beyond the count-up,
 * which is off unless the portal opts in (see CountUp).
 */

export type ReportKpiTone = 'blue' | 'violet' | 'green' | 'amber';

/* Tint + hue token pairs. The icon is a graphic, so it needs 3:1 against its
   chip — every pair here clears it on the light theme. */
const CHIP_TONE: Record<ReportKpiTone, string> = {
  blue: 'bg-sky-tint text-[oklch(0.5_0.16_264)]',
  violet: 'bg-violet-tint text-violet',
  green: 'bg-success-tint text-[oklch(0.5_0.13_155)]',
  amber: 'bg-warning-tint text-warning',
};

export interface ReportKpiProps {
  label: string;
  value: string;
  tone: ReportKpiTone;
  /** Rendered inside a tinted round chip opposite the label. */
  icon?: ReactNode;
  /**
   * The supporting line at the foot of the tile — the WHEN or the SHARE behind
   * a number, where there is one. Rendered AFTER the label in the DOM: the KPI
   * reader in the tests walks value → label as adjacent siblings.
   */
  hint?: string;
}

export function ReportKpi({ label, value, tone, icon, hint }: ReportKpiProps): JSX.Element {
  const { emptyHint } = useMetricMotion();
  const empty = isEmptyMetric(value);
  const foot = hint ?? (empty ? emptyHint : undefined);
  return (
    <div
      /* Hooks for a portal's own stylesheet; they carry no styling themselves. */
      data-report-kpi=""
      data-tone={tone}
      data-empty={empty ? '' : undefined}
      className={cn(
        // Label | chip on the first row, the numeral across the second, the
        // supporting line across the third. The DOM order is chip, value,
        // label, foot (see `hint`); the grid puts each in its place.
        // Compact on a phone, where the strip is one card per row.
        'relative grid min-h-[6.75rem] grid-cols-[minmax(0,1fr)_auto] grid-rows-[auto_1fr_auto] gap-x-3 min-[30rem]:min-h-[8.25rem]',
        'rounded-[1.375rem] bg-card p-4 ring-1 ring-foreground/[0.06] shadow-soft sm:p-5',
      )}
    >
      {icon && (
        <span
          aria-hidden
          className={cn(
            'col-start-2 row-start-1 grid h-10 w-10 place-items-center rounded-full',
            CHIP_TONE[tone],
          )}
        >
          {icon}
        </span>
      )}
      <div
        /* Numeral, then label: marked with data attributes rather than left to
           be found by font size. A test that keys on a Tailwind size is
           testing the stylesheet. This pair is the contract. */
        data-kpi-value
        className={cn(
          'col-span-2 row-start-2 mt-2 self-end truncate text-[1.875rem] font-semibold leading-none tabular-nums tracking-[-0.035em] min-[30rem]:mt-3 sm:text-[2.375rem]',
          empty ? 'text-muted-foreground/70' : 'text-foreground',
        )}
      >
        <CountUp value={value} />
      </div>
      <div
        data-kpi-label
        className="col-start-1 row-start-1 min-w-0 self-center text-[0.9375rem] font-semibold leading-snug text-foreground/80"
      >
        <span className="line-clamp-2">{label}</span>
      </div>
      <div className="col-span-2 row-start-3 mt-2 min-h-[1rem] truncate text-xs tabular-nums text-muted-foreground">
        {foot}
      </div>
    </div>
  );
}

/**
 * The strip of headline numbers above a report's table: four across on a
 * desktop, two on a tablet, one on a phone — at a phone's width two of these
 * side by side leave the numeral no room.
 */
export function ReportKpiStrip({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    /* `sticky start-0` pins it against a horizontal page scroll: a report in
       flow mode lets the page scroll sideways for the table's far columns, and
       without this the summary rides off the screen with it. Only ever as wide
       as the viewport, so sticking it costs nothing vertically. */
    <div
      /* A hook for a portal's own stylesheet; carries no styling itself. */
      data-report-kpi-strip=""
      className={cn(
        'sticky start-0 grid w-[var(--pin-w,100%)] grid-cols-1 gap-3 min-[30rem]:grid-cols-2 xl:grid-cols-4',
        className,
      )}
    >
      {children}
    </div>
  );
}
