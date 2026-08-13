import { cn } from './cn.js';

/**
 * Small chart kit, hand-drawn in SVG.
 *
 * No charting dependency: everything here is a handful of rects and a polyline,
 * and a library would bring its own type scale, its own colour opinions and its
 * own tooltip chrome to argue with the design system. These read the same
 * tokens as the rest of the app, so a chart in a card looks like the card.
 *
 * Every value carries its formatted label ON the chart rather than only in a
 * tooltip. A bar you have to hover to read is a bar you cannot compare with the
 * one below it, and comparison is the entire job.
 */

export type ChartTone = 'primary' | 'violet' | 'success' | 'warning' | 'sky' | 'destructive';

const BAR_TONE: Record<ChartTone, string> = {
  primary: 'fill-primary',
  violet: 'fill-violet',
  success: 'fill-success',
  warning: 'fill-warning',
  sky: 'fill-sky',
  destructive: 'fill-destructive',
};

const DOT_TONE: Record<ChartTone, string> = {
  primary: 'bg-primary',
  violet: 'bg-violet',
  success: 'bg-success',
  warning: 'bg-warning',
  sky: 'bg-sky',
  destructive: 'bg-destructive',
};

export interface ChartSeries {
  key: string;
  label: string;
  tone: ChartTone;
}

export interface HBarRow {
  /** Row label — an agent name, a day, a category. */
  label: string;
  /** One value per series key. Null means "not measurable", drawn as a gap. */
  values: Record<string, number | null>;
  /** Optional quiet suffix after the label, e.g. a count. */
  note?: string;
  /** Marks the viewer's own row so they can find themselves instantly. */
  highlight?: boolean;
}

/**
 * Grouped horizontal bars — the shape for comparing named things.
 *
 * Horizontal because the labels are names: vertical bars force the names to be
 * rotated, truncated, or dropped, and a chart of nine unlabelled columns
 * compares nothing.
 */
export function HBarChart({
  rows,
  series,
  format,
  max,
  emptyLabel,
  className,
}: {
  rows: readonly HBarRow[];
  series: readonly ChartSeries[];
  /** Turns a raw value into the label drawn beside its bar. */
  format: (v: number) => string;
  /** Shared scale. Defaults to the largest value present. */
  max?: number;
  emptyLabel?: string;
  className?: string;
}) {
  const values = rows.flatMap((r) => series.map((s) => r.values[s.key]).filter((v) => v != null));
  const scaleMax = max ?? Math.max(...(values.length ? (values as number[]) : [1]));
  // A zero scale would divide by zero and draw every bar full-width.
  const safeMax = scaleMax > 0 ? scaleMax : 1;

  // Nothing to draw covers TWO cases: no rows at all, and rows whose every
  // charted value is missing. The second used to render as a column of empty
  // tracks and em dashes — the shape of a chart, carrying no information, which
  // reads as a rendering failure rather than as "this was never measured".
  if (rows.length === 0 || values.length === 0) {
    return (
      <p className={cn('py-8 text-center text-sm text-muted-foreground', className)}>
        {emptyLabel ?? 'Nothing to chart yet.'}
      </p>
    );
  }

  return (
    <div className={className}>
      <Legend series={series} />
      <div className="mt-3 space-y-3">
        {rows.map((row) => (
          <div key={row.label}>
            <div className="mb-1 flex items-baseline gap-2">
              <span
                className={cn(
                  'truncate text-xs',
                  row.highlight ? 'font-semibold text-foreground' : 'text-foreground/80',
                )}
              >
                {row.label}
              </span>
              {row.note && (
                <span className="shrink-0 text-2xs text-muted-foreground">{row.note}</span>
              )}
            </div>
            <div className="space-y-1">
              {series.map((s) => {
                const v = row.values[s.key];
                return (
                  <div key={s.key} className="flex items-center gap-2">
                    <div className="h-3 min-w-0 flex-1 overflow-hidden rounded-full bg-secondary">
                      {v != null && (
                        <div
                          className={cn('h-full rounded-full', DOT_TONE[s.tone])}
                          style={{ width: `${Math.max((v / safeMax) * 100, 1.5)}%` }}
                        />
                      )}
                    </div>
                    <span className="w-16 shrink-0 text-end text-2xs tabular-nums text-muted-foreground">
                      {v == null ? '—' : format(v)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Shared legend: a dot and a name per series. */
function Legend({ series }: { series: readonly ChartSeries[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {series.map((s) => (
        <span
          key={s.key}
          className="inline-flex items-center gap-1.5 text-2xs text-muted-foreground"
        >
          <span aria-hidden className={cn('h-2 w-2 rounded-full', DOT_TONE[s.tone])} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

export interface TrendPoint {
  label: string;
  values: Record<string, number | null>;
}

/**
 * A line per series over an ordered set of points.
 *
 * Gaps are gaps: a day with no measurable value breaks the line rather than
 * being drawn as zero, because a zero here would read as "answered instantly"
 * on a day nobody worked.
 */
export function TrendChart({
  points,
  series,
  format,
  height = 140,
  emptyLabel,
  className,
}: {
  points: readonly TrendPoint[];
  series: readonly ChartSeries[];
  format: (v: number) => string;
  height?: number;
  emptyLabel?: string;
  className?: string;
}) {
  const all = points.flatMap((p) => series.map((s) => p.values[s.key]).filter((v) => v != null));
  const max = Math.max(...(all.length ? (all as number[]) : [1]));
  const safeMax = max > 0 ? max : 1;
  const W = 100; // viewBox units — the SVG scales to its container.

  if (points.length === 0 || all.length === 0) {
    return (
      <p className={cn('py-8 text-center text-sm text-muted-foreground', className)}>
        {emptyLabel ?? 'Nothing to chart yet.'}
      </p>
    );
  }

  const x = (i: number) => (points.length === 1 ? W / 2 : (i / (points.length - 1)) * W);
  const y = (v: number) => 100 - (v / safeMax) * 100;

  return (
    <div className={className}>
      <Legend series={series} />
      <div className="mt-2 flex gap-2">
        {/* Axis: just the top and bottom of the scale. A full gridline set on a
            chart this size is more ink than information. */}
        <div
          className="flex shrink-0 flex-col justify-between text-2xs tabular-nums text-muted-foreground"
          style={{ height }}
        >
          <span>{format(safeMax)}</span>
          <span>0</span>
        </div>
        <svg
          viewBox={`0 0 ${W} 100`}
          preserveAspectRatio="none"
          style={{ height }}
          className="min-w-0 flex-1 overflow-visible"
          role="img"
        >
          {series.map((s) => {
            // Split into unbroken runs so a null leaves a real gap.
            const runs: Array<Array<[number, number]>> = [];
            let run: Array<[number, number]> = [];
            points.forEach((p, i) => {
              const v = p.values[s.key];
              if (v == null) {
                if (run.length) runs.push(run);
                run = [];
                return;
              }
              run.push([x(i), y(v)]);
            });
            if (run.length) runs.push(run);

            return (
              <g key={s.key}>
                {runs.map((r, ri) => (
                  <polyline
                    key={ri}
                    points={r.map(([px, py]) => `${px},${py}`).join(' ')}
                    fill="none"
                    strokeWidth={2}
                    vectorEffect="non-scaling-stroke"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={cn('stroke-current', TEXT_TONE[s.tone])}
                  />
                ))}
                {runs.flat().map(([px, py], i) => (
                  <circle
                    key={i}
                    cx={px}
                    cy={py}
                    r={2}
                    vectorEffect="non-scaling-stroke"
                    className={cn(BAR_TONE[s.tone])}
                  />
                ))}
              </g>
            );
          })}
        </svg>
      </div>
      {/* First, middle and last label only — every date on a narrow chart is an
          unreadable smear. */}
      <div className="mt-1 flex justify-between ps-10 text-2xs text-muted-foreground">
        <span>{points[0]?.label}</span>
        {points.length > 2 && <span>{points[Math.floor(points.length / 2)]?.label}</span>}
        {points.length > 1 && <span>{points[points.length - 1]?.label}</span>}
      </div>
    </div>
  );
}

const TEXT_TONE: Record<ChartTone, string> = {
  primary: 'text-primary',
  violet: 'text-violet',
  success: 'text-success',
  warning: 'text-warning',
  sky: 'text-sky',
  destructive: 'text-destructive',
};

/**
 * One horizontal bar split into parts — met vs missed, open vs solved.
 *
 * Shows the split as a proportion AND as counts. A percentage alone hides
 * whether it came from four chats or four hundred.
 */
export function SplitBar({
  parts,
  className,
}: {
  parts: ReadonlyArray<{ label: string; value: number; tone: ChartTone }>;
  className?: string;
}) {
  const total = parts.reduce((sum, p) => sum + p.value, 0);
  if (total === 0) return null;
  return (
    <div className={className}>
      <div className="flex h-3 overflow-hidden rounded-full bg-secondary">
        {parts.map((p) =>
          p.value === 0 ? null : (
            <div
              key={p.label}
              className={cn('h-full', DOT_TONE[p.tone])}
              style={{ width: `${(p.value / total) * 100}%` }}
            />
          ),
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
        {parts.map((p) => (
          <span key={p.label} className="inline-flex items-center gap-1.5 text-2xs">
            <span aria-hidden className={cn('h-2 w-2 rounded-full', DOT_TONE[p.tone])} />
            <span className="text-muted-foreground">{p.label}</span>
            <span className="font-semibold tabular-nums text-foreground">{p.value}</span>
            <span className="text-muted-foreground">({Math.round((p.value / total) * 100)}%)</span>
          </span>
        ))}
      </div>
    </div>
  );
}
