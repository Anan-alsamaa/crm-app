import { useEffect, useId, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { cn } from './cn.js';

/*
 * Metric accents — the small data glyphs of the premium dashboard language:
 * a circular progress ring, a thin meter bar, a sparkline and a delta pill,
 * plus the SectionCard surface they usually sit on.
 *
 * All color comes from theme tokens. SVG geometry can't take Tailwind bg-*
 * classes for strokes/fills with gradients, so tones also resolve to
 * `oklch(var(--x))` strings — the same variables the preset reads, which is
 * what keeps these correct on both themes. The warning hue is deliberately
 * absent: it is a light token and fails contrast as an accent on light.
 */

export type MetricTone = 'primary' | 'success' | 'destructive' | 'sky' | 'violet';

/**
 * Animate a metric from 0 to its value on mount.
 *
 * Two frames, not one: a browser that paints the committed state before the
 * effect runs would show the final value with no transition at all, and
 * requestAnimationFrame twice guarantees the zero state was painted first.
 * Honours prefers-reduced-motion by jumping straight to the value.
 */
function useDrawIn(value: number): number {
  const [drawn, setDrawn] = useState(0);
  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ) {
      setDrawn(value);
      return;
    }
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setDrawn(value));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [value]);
  return drawn;
}

// Inline SVG strokes/fills — token variables, not literals.
const TONE_COLOR: Record<MetricTone, string> = {
  primary: 'oklch(var(--primary))',
  success: 'oklch(var(--success))',
  destructive: 'oklch(var(--destructive))',
  sky: 'oklch(var(--sky))',
  violet: 'oklch(var(--violet))',
};

// HTML fills for the same tones.
const TONE_BG: Record<MetricTone, string> = {
  primary: 'bg-primary',
  success: 'bg-success',
  destructive: 'bg-destructive',
  sky: 'bg-sky',
  violet: 'bg-violet',
};

export interface ProgressRingProps {
  /** 0-100. */
  value: number;
  /** Outer diameter in px. */
  size?: number;
  /** Arc thickness in px. */
  stroke?: number;
  tone?: MetricTone;
  /** Center content — usually the value as text. */
  label?: ReactNode;
  className?: string;
}

/**
 * Circular progress ring — an SVG donut with a faint track and a glowing
 * tone arc. The arc starts at 12 o'clock (the -90° rotation) and grows
 * clockwise; the center is a slot for the number it illustrates.
 */
export function ProgressRing({
  value,
  size = 44,
  stroke = 4,
  tone = 'primary',
  label,
  className,
}: ProgressRingProps): JSX.Element {
  const clamped = Math.min(100, Math.max(0, value));
  // The arc sweeps in from zero on mount — the ring reads as a measurement
  // being taken rather than a picture of one.
  const drawn = useDrawIn(clamped);
  const r = Math.max((size - stroke) / 2, 1);
  const circumference = 2 * Math.PI * r;
  // A string label doubles as the accessible name; otherwise the percentage.
  const ariaLabel = typeof label === 'string' ? label : `${Math.round(clamped)}%`;
  return (
    <div
      role="img"
      aria-label={ariaLabel}
      className={cn('relative inline-grid place-items-center', className)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="oklch(var(--foreground) / 0.1)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={TONE_COLOR[tone]}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - drawn / 100)}
          style={{ transition: 'stroke-dashoffset 900ms cubic-bezier(0.23, 1, 0.32, 1)' }}
        />
      </svg>
      {label != null && (
        <span className="absolute inset-0 grid place-items-center text-2xs font-semibold tabular-nums text-foreground">
          {label}
        </span>
      )}
    </div>
  );
}

export interface MeterBarProps {
  /** 0-100. */
  value: number;
  tone?: MetricTone;
  /** If set, renders that many equal blocks instead of a continuous fill. */
  segments?: number;
  className?: string;
}

/**
 * Thin meter bar — a hairline track with a tone fill. Segmented mode draws
 * equal blocks (filled count rounded from the value) for readings where the
 * steps matter more than the exact fraction.
 */
export function MeterBar({
  value,
  tone = 'primary',
  segments,
  className,
}: MeterBarProps): JSX.Element {
  const clamped = Math.min(100, Math.max(0, value));
  // Same draw-in as the ring: the fill grows to its reading on mount.
  const drawn = useDrawIn(clamped);
  if (segments && segments > 0) {
    const filled = Math.round((clamped / 100) * segments);
    const drawnFilled = Math.round((drawn / 100) * segments);
    return (
      <div className={cn('flex items-center gap-0.5', className)}>
        {Array.from({ length: segments }, (_, i) => (
          <span
            key={i}
            aria-hidden
            className={cn(
              'h-1.5 min-w-0 flex-1 rounded-full transition-colors duration-medium ease-out',
              i < drawnFilled ? TONE_BG[tone] : 'bg-foreground/[0.08]',
            )}
            // Blocks light up left-to-right rather than all at once.
            style={{ transitionDelay: `${Math.min(i, filled) * 45}ms` }}
          />
        ))}
      </div>
    );
  }
  return (
    <div className={cn('h-1.5 overflow-hidden rounded-full bg-foreground/[0.08]', className)}>
      {/* Block-level fill hugs the start edge, so RTL flips for free. */}
      <div
        className={cn('h-full rounded-full', TONE_BG[tone])}
        style={{
          width: `${drawn}%`,
          transition: 'width 900ms cubic-bezier(0.23, 1, 0.32, 1)',
        }}
      />
    </div>
  );
}

export interface SparklineProps {
  points: number[];
  tone?: MetricTone;
  /** Rendered width in px. */
  width?: number;
  /** Rendered height in px. */
  height?: number;
  className?: string;
}

/**
 * Tiny trend line — points normalized to the box, with a soft gradient wash
 * under the stroke. Purely a shape accent: the numbers it sketches belong to
 * the card beside it, so the SVG is hidden from assistive tech.
 */
export function Sparkline({
  points,
  tone = 'primary',
  width = 96,
  height = 28,
  className,
}: SparklineProps): JSX.Element | null {
  // Gradient ids must be unique per instance or fills bleed across charts.
  const gradientId = useId();
  if (points.length === 0) return null;

  const min = Math.min(...points);
  const max = Math.max(...points);
  // Inset by the stroke so the line's caps aren't clipped at the edges.
  const pad = 2;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const x = (i: number) =>
    points.length === 1 ? pad + innerW / 2 : pad + (i / (points.length - 1)) * innerW;
  // A flat series draws at mid-height rather than pinned to the top.
  const y = (v: number) => pad + (1 - (max === min ? 0.5 : (v - min) / (max - min))) * innerH;

  const line = points.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  const area = `${x(0)},${height - pad} ${line} ${x(points.length - 1)},${height - pad}`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
      className={cn('shrink-0', className)}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={TONE_COLOR[tone]} stopOpacity={0.2} />
          <stop offset="100%" stopColor={TONE_COLOR[tone]} stopOpacity={0} />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${gradientId})`} />
      <polyline
        points={line}
        fill="none"
        stroke={TONE_COLOR[tone]}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export interface DeltaBadgeProps {
  /** The formatted change, e.g. "+8.6%". */
  children: ReactNode;
  direction: 'up' | 'down' | 'flat';
  /** Whether up is the good direction (false for e.g. response times). */
  positiveIsGood?: boolean;
  className?: string;
}

const ARROWS: Record<DeltaBadgeProps['direction'], string> = {
  up: '▲',
  down: '▼',
  flat: '—',
};

/**
 * Delta pill — direction glyph plus the formatted change, tinted by goodness
 * rather than by direction: up is only green when up is good.
 */
export function DeltaBadge({
  children,
  direction,
  positiveIsGood = true,
  className,
}: DeltaBadgeProps): JSX.Element {
  const good = direction === 'flat' ? null : (direction === 'up') === positiveIsGood;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-2xs font-semibold tabular-nums',
        good == null && 'bg-secondary text-muted-foreground',
        good === true && 'bg-success/15 text-success',
        good === false && 'bg-destructive/15 text-destructive',
        className,
      )}
    >
      <span aria-hidden className="text-[0.55rem] leading-none">
        {ARROWS[direction]}
      </span>
      {children}
    </span>
  );
}

export interface SectionCardProps {
  title: ReactNode;
  /** Quiet explainer under the title. */
  hint?: ReactNode;
  /** End-aligned header slot — a filter, a total, a link. */
  aside?: ReactNode;
  /**
   * Position in a group of cards. Sets the entrance delay so a dashboard
   * cascades in instead of appearing all at once (capped so a long page
   * never makes the reader wait).
   */
  index?: number;
  /** Hue of the title accent bar. Defaults to the brand. */
  tone?: MetricTone;
  className?: string;
  children: ReactNode;
}

/**
 * Dashboard section surface — the elevated card a chart or table lives in,
 * with the title row built in so every section carries the same header
 * anatomy: compact title, quiet hint, end-aligned aside.
 */
export function SectionCard({
  title,
  hint,
  aside,
  index = 0,
  tone = 'primary',
  className,
  children,
}: SectionCardProps): JSX.Element {
  return (
    <section
      style={{ animationDelay: `${Math.min(index, 8) * 60}ms` }}
      className={cn(
        // Matches the KPI cards above it: squarer corner, a hairline border
        // rather than shadow alone, and a shadow light enough to read as depth
        // instead of decoration. A board where the panels and the tiles use
        // different radii looks assembled from two products.
        'rounded-xl bg-card p-6 ring-1 ring-foreground/[0.07] shadow-[0_1px_2px_oklch(var(--shadow-color)/0.04),0_8px_24px_-16px_oklch(var(--shadow-color)/0.14)]',
        // Settles up into place on mount, and lifts a hair under the cursor.
        'motion-safe:animate-rise-in',
        /* No lift. A SectionCard is a content panel, not a control — nothing
           happens when you click it, so animating it under the cursor promises
           an interaction that does not exist. The shadow alone acknowledges the
           pointer. */
        'transition-shadow duration-base ease-out hover:shadow-[0_2px_4px_oklch(var(--shadow-color)/0.06),0_14px_32px_-18px_oklch(var(--shadow-color)/0.20)]',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 gap-2.5">
          {/* A short hue bar beside the title: the cheapest way to give a wall
              of white cards individual identity without tinting the surface. */}
          <span aria-hidden className={cn('mt-0.5 h-4 w-1 shrink-0 rounded-full', TONE_BG[tone])} />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold tracking-tight text-foreground">{title}</h3>
            {hint && (
              <p className="mt-0.5 text-2xs leading-relaxed text-muted-foreground">{hint}</p>
            )}
          </div>
        </div>
        {aside && <div className="shrink-0 text-2xs text-muted-foreground">{aside}</div>}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}
