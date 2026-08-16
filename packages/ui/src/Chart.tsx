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
  // A third case belongs here too: every value present but ZERO. That drew a
  // column of empty tracks each labelled 0 — again the shape of a chart with
  // no information in it, which reads as broken rendering rather than as
  // "none of this happened in this range".
  const allZero = values.length > 0 && (values as number[]).every((v) => v === 0);
  if (rows.length === 0 || values.length === 0 || allZero) {
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

  // Catmull-Rom → cubic bézier: the reference boards draw trends as calm
  // curves, and a two-segment polyline over sparse days reads as a glitch.
  const smoothPath = (pts: Array<[number, number]>): string => {
    if (pts.length < 3) return pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px},${py}`).join(' ');
    // The clamped indices below are always in bounds — assert away the
    // noUncheckedIndexedAccess undefineds.
    let d = `M${pts[0]![0]},${pts[0]![1]}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)]!;
      const p1 = pts[i]!;
      const p2 = pts[i + 1]!;
      const p3 = pts[Math.min(pts.length - 1, i + 2)]!;
      d += ` C${p1[0] + (p2[0] - p0[0]) / 6},${p1[1] + (p2[1] - p0[1]) / 6} ${
        p2[0] - (p3[0] - p1[0]) / 6
      },${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]},${p2[1]}`;
    }
    return d;
  };

  // Per-series runs (a null is a real gap), computed once and shared by the
  // SVG lines and the HTML dot layer below.
  const seriesRuns = series.map((s) => {
    const runs: Array<Array<[number, number, number]>> = [];
    let run: Array<[number, number, number]> = [];
    points.forEach((p, i) => {
      const v = p.values[s.key];
      if (v == null) {
        if (run.length) runs.push(run);
        run = [];
        return;
      }
      run.push([x(i), y(v), v]);
    });
    if (run.length) runs.push(run);
    return { s, runs };
  });

  return (
    <div className={className}>
      <Legend series={series} />
      <div className="mt-2 flex gap-2">
        <div
          className="flex shrink-0 flex-col justify-between text-2xs tabular-nums text-muted-foreground"
          style={{ height }}
        >
          <span>{format(safeMax)}</span>
          <span>{format(safeMax / 2)}</span>
          <span>0</span>
        </div>
        {/* The SVG stretches (preserveAspectRatio none) so lines fill the box;
            dots and value labels live in an HTML layer on top, because a
            circle inside a stretched SVG renders as an ellipse. */}
        <div className="relative min-w-0 flex-1" style={{ height }}>
          <svg
            viewBox={`0 0 ${W} 100`}
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full overflow-visible"
            role="img"
          >
            {/* Dashed quarter gridlines — the reference boards' quiet ruling. */}
            {[0, 25, 50, 75, 100].map((gy) => (
              <line
                key={gy}
                x1={0}
                x2={W}
                y1={gy}
                y2={gy}
                stroke="oklch(var(--foreground) / 0.07)"
                strokeWidth={1}
                strokeDasharray={gy === 100 ? undefined : '3 4'}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {seriesRuns.map(({ s, runs }) => (
              <g key={s.key}>
                {runs.map((r, ri) => {
                  const line = r.map(([px, py]) => [px, py] as [number, number]);
                  return (
                    <g key={ri}>
                      {/* Soft area fill under the curve grounds it — a bare
                          line over empty dark reads unfinished. */}
                      {line.length > 1 && (
                        <path
                          d={`${smoothPath(line)} L${line[line.length - 1]![0]},100 L${line[0]![0]},100 Z`}
                          fill={`oklch(var(--${s.tone}) / 0.10)`}
                          stroke="none"
                        />
                      )}
                      <path
                        d={smoothPath(line)}
                        fill="none"
                        strokeWidth={2}
                        vectorEffect="non-scaling-stroke"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className={cn('stroke-current', TEXT_TONE[s.tone])}
                      />
                    </g>
                  );
                })}
              </g>
            ))}
          </svg>
          {/* Crisp round markers + a value label on isolated points, so a
              single measured day reads as a deliberate data point instead of
              a floating smudge. */}
          {seriesRuns.map(({ s, runs }) =>
            runs.map((r, ri) =>
              r.map(([px, py, v], pi) => (
                <span
                  key={`${s.key}-${ri}-${pi}`}
                  className="absolute"
                  style={{ left: `${px}%`, top: `${py}%` }}
                >
                  <span
                    className={cn(
                      'absolute -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card',
                      'h-2 w-2',
                      DOT_TONE[s.tone],
                    )}
                  />
                  {r.length === 1 && (
                    <span className="absolute -translate-x-1/2 -translate-y-[calc(100%+8px)] whitespace-nowrap rounded-md bg-secondary px-1.5 py-0.5 text-2xs font-semibold tabular-nums text-foreground">
                      {format(v)}
                    </span>
                  )}
                </span>
              )),
            ),
          )}
        </div>
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
