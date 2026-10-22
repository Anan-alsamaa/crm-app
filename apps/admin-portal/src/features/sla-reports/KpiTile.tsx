import type { CSSProperties, ReactNode } from 'react';
import {
  cn,
  CountUp,
  isEmptyMetric,
  ProgressRing,
  useMetricMotion,
  type MetricTone,
} from '@yiji/ui';

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
/* Rapport skin (owner, 2026-10-22): the Dashboard's tile language - a
 * frosted card and an INK numeral, the tone carried by the dot and the round
 * chip. The pastel washes read as a different family from the Dashboard.
 * Crimson keeps its red numeral: a breached deadline is the one figure here
 * whose colour is the message (DESIGN.md: overdue is red AND bold). */
const KPI_NUMERAL: Record<KpiTone, string> = {
  blue: 'text-foreground',
  green: 'text-foreground',
  amber: 'text-foreground',
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
        'flex items-center gap-3 rounded-[1.125rem] bg-card px-3.5 py-2.5',
        'shadow-soft ring-1 ring-foreground/[0.06]',
      )}
    >
      {icon && (
        <span
          aria-hidden
          className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-full', KPI_CHIP[tone])}
        >
          {icon}
        </span>
      )}
      <div
        data-kpi-value
        className={cn(
          'shrink-0 text-2xl font-semibold leading-none tabular-nums tracking-[-0.03em]',
          KPI_NUMERAL[tone],
        )}
      >
        {value}
      </div>
      <div
        data-kpi-label
        className="flex min-w-0 items-center gap-1.5 text-xs font-medium leading-tight text-muted-foreground"
      >
        <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', KPI_DOT[tone])} />
        <span className="min-w-0">{label}</span>
      </div>
      {visual && <div className="ms-auto shrink-0">{visual}</div>}
    </div>
  );
}

/*
 * ONE GROUP, FOUR FIGURES (owner, 2026-10-15: "the 2 cards and everything look
 * very weird ... needs to be beautiful"). The page's stat groups sit side by
 * side, each a heading over its own figures.
 *
 * Rapport metric cards (owner, 2026-10-22: the one-line tiles "look very
 * badly designed"): each figure is the same card as a report's headline tile
 * (`ReportKpi`) - the label on top with its state dot, the numeral large under
 * it, a supporting line at the foot - so every report opens on one card
 * language. The group is a heading over the cards rather than a card holding
 * them: a card inside a card is the one nesting the design bans.
 *
 * The cards are laid out by the GROUP's width, not the screen's (a container
 * query in index.css): four across when the group has the room, two when it
 * sits in half a laptop screen, one on a phone.
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
  const { emptyHint } = useMetricMotion();
  return (
    <section aria-labelledby={id} data-stat-panel="" className="flex min-w-0 flex-col gap-3">
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 px-1">
        <div className="min-w-0">
          <h2 id={id} className="text-base font-semibold tracking-tight text-foreground">
            {title}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>
        </div>
        {aside && <div className="flex shrink-0 items-center gap-2">{aside}</div>}
      </header>
      {/* At most four across; a longer group wraps into rows of four. */}
      <div data-stat-grid="" style={{ '--cells': Math.min(cells.length, 4) } as CSSProperties}>
        {cells.map((c) => {
          const tone = c.tone ?? 'blue';
          const empty = !loading && isEmptyMetric(c.value);
          return (
            <div
              key={c.label}
              data-report-kpi=""
              data-tone={tone}
              data-empty={loading || empty ? '' : undefined}
              className="relative grid min-h-[8.25rem] min-w-0 grid-cols-[minmax(0,1fr)_auto] grid-rows-[auto_1fr_auto] gap-x-2 rounded-[1.375rem] bg-card p-4 ring-1 ring-foreground/[0.06] shadow-soft"
            >
              {!loading && c.ring != null && (
                <ProgressRing
                  className="col-start-2 row-start-1"
                  value={c.ring}
                  size={34}
                  stroke={4}
                  tone={RING_TONE[tone]}
                />
              )}
              {/* Numeral, then label: the pair the tests read as siblings. */}
              <div
                data-kpi-value
                className={cn(
                  'col-span-2 row-start-2 mt-3 self-end truncate text-[2rem] font-semibold leading-none tabular-nums tracking-[-0.035em]',
                  loading || empty ? 'text-muted-foreground/70' : KPI_NUMERAL[tone],
                )}
              >
                {loading ? '–' : <CountUp value={c.value} />}
              </div>
              <div
                data-kpi-label
                /* Two lines reserved, so a card whose label wraps is the same
                   height as its neighbours. */
                className="col-start-1 row-start-1 flex min-h-[2.5rem] min-w-0 items-start gap-2 text-sm font-semibold leading-snug text-foreground/80"
              >
                <span
                  aria-hidden
                  className={cn('mt-[0.4rem] h-2 w-2 shrink-0 rounded-full', KPI_DOT[tone])}
                />
                <span className="line-clamp-2 min-w-0">{c.label}</span>
              </div>
              <div className="col-span-2 row-start-3 mt-2 min-h-[1rem] truncate text-xs text-muted-foreground">
                {empty ? emptyHint : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
