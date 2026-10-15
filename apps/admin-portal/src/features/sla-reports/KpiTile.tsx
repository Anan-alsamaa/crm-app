import type { ReactNode } from 'react';
import { cn, ProgressRing, type MetricTone } from '@yiji/ui';

/*
 * The Ticket deadlines report's own tile, shared by BOTH stat rows (owner,
 * 2026-10-14: "2 stats boxes one below the other looks bad"). The open-ticket
 * row used the generic ReportKpi in a narrower strip, the window row this
 * tile in a full-width grid - two sizes, two widths, nothing lined up.
 */
/* Vibrant tinted KPI card — matches the Ticket report / export reports. */
export type KpiTone = 'blue' | 'green' | 'amber' | 'crimson';
/* The state dot beside the label. */
const KPI_DOT: Record<KpiTone, string> = {
  blue: 'bg-sky',
  green: 'bg-success',
  amber: 'bg-warning',
  crimson: 'bg-destructive',
};
/* Colour as ACCENT, not surface. Solid saturated tiles read as a toy dashboard
 * (and here the numeral was the SAME colour as its fill — invisible). White
 * card + ink numeral is also the strongest contrast available (~19.5:1); the
 * tone survives as a state-indicator dot, which is what SLA green/amber/red
 * actually is. */
/* Icon chips take tint + hue token pairs, same anatomy as the export reports'
 * tiles; amber stays NEUTRAL — warning is a light token and a warning-tinted
 * chip fails contrast on the light theme. */
const KPI_CHIP: Record<KpiTone, string> = {
  blue: 'bg-sky-tint text-sky',
  green: 'bg-success-tint text-success',
  amber: 'bg-secondary text-muted-foreground',
  crimson: 'bg-destructive-tint text-destructive',
};
/** Green ≥90, amber ≥75, red below (no data → blue). */
export const pctKpiTone = (n: number | null): KpiTone =>
  n == null ? 'blue' : n >= 90 ? 'green' : n >= 75 ? 'amber' : 'crimson';
/* Ring accents for the % tiles. MetricTone deliberately has no warning/amber
 * (a light token), so the amber band falls back to jade. */
/* The SURFACE carries the hue, like every other report's tiles — this page
 * was the last one left showing four white boxes. */
const KPI_SURFACE: Record<KpiTone, string> = {
  blue: 'bg-gradient-to-br from-sky-tint/70 to-card',
  green: 'bg-gradient-to-br from-success-tint/70 to-card',
  amber: 'bg-gradient-to-br from-warning-tint/70 to-card',
  crimson: 'bg-gradient-to-br from-destructive-tint/70 to-card',
};
const KPI_NUMERAL: Record<KpiTone, string> = {
  blue: 'text-[oklch(0.48_0.16_264)]',
  green: 'text-[oklch(0.45_0.13_155)]',
  amber: 'text-[oklch(0.5_0.13_75)]',
  crimson: 'text-destructive',
};

export const RING_TONE: Record<KpiTone, MetricTone> = {
  blue: 'sky',
  green: 'success',
  amber: 'primary',
  crimson: 'destructive',
};

export function Kpi({
  label,
  value,
  tone = 'blue',
  icon,
  visual,
}: {
  label: string;
  value: string;
  tone?: KpiTone;
  /** Rendered in a tinted rounded-square chip at the start of the line. */
  icon?: ReactNode;
  /** End-aligned data accent — a `<ProgressRing>` for the % tiles. */
  visual?: ReactNode;
}) {
  return (
    <div
      className={cn(
        // ONE LINE, matching @yiji/ui's ReportKpi.
        //
        // These four opened this report at ~150px — a chip row, a 4xl numeral
        // and a label, stacked. With the toolbar, the description and a
        // two-row filter bar above them, the table began 560px down and
        // floored at its minimum on a 900px screen. This report keeps its OWN
        // tile rather than using the shared one because it needs a `crimson`
        // tone the shared vocabulary has no seat for, and red for a badly
        // missed SLA is the whole point of colouring these at all.
        'flex items-center gap-3 rounded-xl px-3.5 py-2.5',
        'shadow-[0_1px_2px_oklch(var(--shadow-color)/0.06),0_10px_26px_-14px_oklch(var(--shadow-color)/0.18)]',
        'transition-[box-shadow] duration-base ease-out',
        KPI_SURFACE[tone],
      )}
    >
      {icon && (
        <span
          aria-hidden
          className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg', KPI_CHIP[tone])}
        >
          {icon}
        </span>
      )}
      <div
        data-kpi-value
        className={cn(
          'shrink-0 text-2xl font-extrabold leading-none tabular-nums tracking-[-0.03em]',
          KPI_NUMERAL[tone],
        )}
      >
        {value}
      </div>
      <div
        data-kpi-label
        className="flex min-w-0 items-center gap-1.5 text-2xs font-semibold uppercase leading-tight tracking-[0.1em] text-muted-foreground"
      >
        <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', KPI_DOT[tone])} />
        <span className="min-w-0">{label}</span>
      </div>
      {visual && <div className="ms-auto shrink-0">{visual}</div>}
    </div>
  );
}

/*
 * ONE PANEL, FOUR FIGURES (owner, 2026-10-15: "the 2 cards and everything look
 * very weird ... needs to be beautiful"). The page's two stat groups sit side
 * by side as two calm panels instead of two stacked rows of tinted tiles with
 * a paragraph over each. The tone colours only the NUMBER and its dot.
 */
export interface StatCell {
  label: string;
  value: string;
  tone?: KpiTone;
  /** A small ring beside the number, for the % figures. */
  ring?: number | null;
}

export function StatPanel({
  id,
  title,
  note,
  aside,
  cells,
  loading,
}: {
  id: string;
  title: string;
  note: string;
  /** Right of the title: a date chip, an info hint. */
  aside?: ReactNode;
  cells: StatCell[];
  loading?: boolean;
}) {
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col rounded-2xl bg-card p-4 shadow-soft ring-1 ring-foreground/[0.06]"
    >
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <h2 id={id} className="text-sm font-semibold tracking-tight text-foreground">
            {title}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>
        </div>
        {aside && <div className="flex shrink-0 items-center gap-2">{aside}</div>}
      </header>
      <div className="mt-4 grid grid-cols-2 gap-y-4 sm:grid-cols-4 sm:divide-x sm:divide-border rtl:sm:divide-x-reverse">
        {cells.map((c) => (
          <div key={c.label} className="flex min-w-0 items-center gap-3 sm:px-4 sm:first:ps-0">
            <div className="min-w-0">
              <div
                data-kpi-value
                className={cn(
                  'text-2xl font-extrabold leading-none tabular-nums tracking-[-0.03em]',
                  loading ? 'text-muted-foreground/40' : KPI_NUMERAL[c.tone ?? 'blue'],
                )}
              >
                {loading ? '–' : c.value}
              </div>
              <div
                data-kpi-label
                className="mt-1.5 flex min-w-0 items-center gap-1.5 text-2xs font-medium text-muted-foreground"
              >
                <span
                  aria-hidden
                  className={cn('h-1.5 w-1.5 shrink-0 rounded-full', KPI_DOT[c.tone ?? 'blue'])}
                />
                <span className="truncate">{c.label}</span>
              </div>
            </div>
            {!loading && c.ring != null && (
              <ProgressRing
                className="ms-auto hidden xl:block"
                value={c.ring}
                size={36}
                stroke={4}
                tone={RING_TONE[c.tone ?? 'blue']}
              />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
