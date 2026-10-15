import { useEffect, useRef, type ReactNode } from 'react';
import { animate, motion, useReducedMotion } from 'motion/react';
import { cn } from '@yiji/ui';

/*
 * DASHBOARD BUILDING BLOCKS (owner, 2026-10-15: "modern, sleek and dynamic
 * components", reference: a bento SaaS dashboard, in the brand indigo).
 *
 * One hero tile per row in a deep indigo gradient, white tiles beside it, pill
 * columns on a hatched track, a semicircle gauge, numbers that count up.
 * Motion comes from `motion` and ALWAYS honours reduced motion: the final state
 * renders immediately, nothing moves.
 */

/** The deep indigo hero surface, shared by the hero tile and the gauge accent. */
export const HERO_SURFACE =
  'bg-[radial-gradient(120%_120%_at_100%_0%,oklch(0.62_0.19_288/0.55),transparent_55%),linear-gradient(140deg,oklch(0.27_0.12_278),oklch(0.38_0.19_277)_55%,oklch(0.47_0.21_280))]';

/** The hatched track behind pill bars - the reference's striped "remaining". */
export const HATCH =
  'bg-[repeating-linear-gradient(135deg,oklch(var(--primary)/0.16)_0_2px,transparent_2px_8px)]';

/** A number that counts up from 0 once it scrolls into view. */
export function CountUp({
  value,
  decimals = 0,
  className,
}: {
  value: number;
  decimals?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotion();
  const fmt = (n: number) =>
    n.toLocaleString(undefined, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    /* No IntersectionObserver (jsdom, very old browsers) or reduced motion:
       the final number, at once. The rendered text is already the final
       value, so nothing is ever wrong - the count-up is decoration. */
    if (reduce || typeof IntersectionObserver === 'undefined') {
      el.textContent = fmt(value);
      return;
    }
    let controls: { stop: () => void } | undefined;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      controls = animate(0, value, {
        duration: Math.min(1.1, 0.5 + Math.log10(Math.max(1, value)) * 0.2),
        ease: [0.23, 1, 0.32, 1],
        onUpdate: (v) => {
          el.textContent = fmt(v);
        },
      });
    });
    io.observe(el);
    return () => {
      io.disconnect();
      controls?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fmt is pure on `decimals`
  }, [value, reduce, decimals]);
  return (
    <span ref={ref} className={cn('tabular-nums', className)}>
      {fmt(value)}
    </span>
  );
}

/** Staggered entrance for a grid of cards; a no-op under reduced motion. */
export function Rise({
  index = 0,
  className,
  children,
}: {
  index?: number;
  className?: string;
  children: ReactNode;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 260, damping: 26, delay: Math.min(index, 8) * 0.05 }}
    >
      {children}
    </motion.div>
  );
}

function ArrowGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" aria-hidden>
      <path
        d="M5 11 11 5M6 5h5v5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * A stat tile: title, round arrow button, big counting number, a footer line.
 * `hero` paints the deep indigo gradient with white ink (one per row).
 * The WHOLE tile is the target when `onOpen` is given - not just the arrow.
 */
export function StatCard({
  title,
  value,
  display,
  decimals,
  unit,
  sub,
  delta,
  visual,
  hero,
  onOpen,
  openLabel,
  index = 0,
}: {
  title: string;
  /** Numeric value to count up to. Omit and pass `display` for a phrase. */
  value?: number;
  /** Shown instead of a number ("No ratings yet"). */
  display?: string;
  decimals?: number;
  unit?: string;
  sub?: ReactNode;
  delta?: ReactNode;
  visual?: ReactNode;
  hero?: boolean;
  onOpen?: () => void;
  openLabel?: string;
  index?: number;
}) {
  const Root = onOpen ? 'button' : 'div';
  const phrase = value === undefined;
  return (
    <Rise index={index} className="h-full">
      <Root
        {...(onOpen
          ? { type: 'button' as const, onClick: onOpen, 'aria-label': openLabel ?? title }
          : {})}
        className={cn(
          'group relative flex h-full w-full flex-col overflow-hidden rounded-[1.4rem] p-5 text-start',
          'transition-[box-shadow,transform] duration-base ease-out',
          hero
            ? cn(HERO_SURFACE, 'text-white shadow-[0_18px_40px_-18px_oklch(0.35_0.19_277/0.7)]')
            : 'bg-card text-foreground shadow-soft ring-1 ring-foreground/[0.06] hover:shadow-[0_2px_4px_oklch(var(--shadow-color)/0.06),0_16px_36px_-16px_oklch(var(--shadow-color)/0.22)]',
          onOpen &&
            'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 motion-safe:hover:-translate-y-0.5',
        )}
      >
        {hero && (
          /* Soft rings in the corner, the reference hero's texture. */
          <svg
            aria-hidden
            className="pointer-events-none absolute -bottom-16 -end-10 h-48 w-48 text-white/[0.09]"
            viewBox="0 0 200 200"
            fill="none"
          >
            {[30, 50, 70, 90].map((r) => (
              <circle key={r} cx="100" cy="100" r={r} stroke="currentColor" strokeWidth="10" />
            ))}
          </svg>
        )}
        <div className="relative flex items-start justify-between gap-3">
          <span
            className={cn('text-sm font-semibold', hero ? 'text-white/90' : 'text-foreground/80')}
          >
            {title}
          </span>
          {onOpen && (
            <span
              aria-hidden
              className={cn(
                'grid h-8 w-8 shrink-0 place-items-center rounded-full ring-1 transition-transform duration-base ease-out',
                'motion-safe:group-hover:rotate-45',
                hero
                  ? 'bg-white text-[oklch(0.32_0.15_278)] ring-white'
                  : 'bg-card text-foreground ring-foreground/15',
              )}
            >
              <ArrowGlyph />
            </span>
          )}
        </div>
        <div className="relative mt-4 flex items-end justify-between gap-3">
          <div className="min-w-0">
            {phrase ? (
              <span
                className={cn(
                  'text-base font-semibold',
                  hero ? 'text-white/80' : 'text-muted-foreground',
                )}
              >
                {display}
              </span>
            ) : (
              <span className="text-[2.6rem] font-extrabold leading-none tracking-[-0.04em]">
                <CountUp value={value ?? 0} decimals={decimals} />
                {unit && (
                  <span
                    className={cn(
                      'ms-1.5 text-lg font-semibold tracking-normal',
                      hero ? 'text-white/75' : 'text-muted-foreground',
                    )}
                  >
                    {unit}
                  </span>
                )}
              </span>
            )}
          </div>
          {visual && <span className="shrink-0">{visual}</span>}
        </div>
        <div
          className={cn(
            'relative mt-auto pt-4 text-xs',
            hero ? 'text-white/80' : 'text-muted-foreground',
          )}
        >
          {delta && <div className="mb-1">{delta}</div>}
          <div className="min-h-[1rem] leading-relaxed">{sub}</div>
        </div>
      </Root>
    </Rise>
  );
}

/** Small pill under a number: "▲ 12% vs last month". `good` colours it. */
export function TrendPill({
  children,
  good,
  onHero,
}: {
  children: ReactNode;
  good: boolean;
  onHero?: boolean;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs font-semibold',
        onHero
          ? 'bg-white/15 text-white ring-1 ring-inset ring-white/25'
          : good
            ? 'bg-success-tint text-success'
            : 'bg-destructive-tint text-destructive',
      )}
    >
      {children}
    </span>
  );
}

export interface PillRow {
  key: string;
  label: string;
  count: number;
}

/**
 * Pill columns on a hatched track (the reference's weekly bars). The tallest
 * column is the solid hero colour with its value in a bubble; the rest are the
 * brand tint. Every column is a button when `onSelect` is given.
 */
export function PillColumns({
  rows,
  onSelect,
  emptyLabel,
  max: maxCols = 8,
}: {
  rows: PillRow[];
  onSelect?: (row: PillRow) => void;
  emptyLabel: ReactNode;
  max?: number;
}) {
  const reduce = useReducedMotion();
  const top = rows.slice(0, maxCols);
  if (top.length === 0) return <>{emptyLabel}</>;
  const peak = Math.max(1, ...top.map((r) => r.count));
  const peakIndex = top.findIndex((r) => r.count === peak);
  // Always at least 5 tracks, so one category still reads as a chart.
  const slots = Math.max(5, top.length);
  return (
    <div className="flex h-60 items-end gap-3 sm:gap-4" role="list">
      {Array.from({ length: slots }, (_, i) => {
        const r = top[i];
        const pct = r ? Math.max(8, (r.count / peak) * 100) : 0;
        const isPeak = i === peakIndex;
        const body = (
          <span
            className={cn(
              'relative flex w-full flex-1 items-end overflow-hidden rounded-full',
              HATCH,
            )}
          >
            {r && (
              <motion.span
                className={cn(
                  'relative w-full rounded-full',
                  isPeak
                    ? 'bg-[linear-gradient(180deg,oklch(0.45_0.2_278),oklch(0.3_0.13_278))]'
                    : 'bg-[linear-gradient(180deg,oklch(var(--primary)/0.55),oklch(var(--primary)/0.85))]',
                )}
                initial={reduce ? false : { height: '0%' }}
                animate={{ height: `${pct}%` }}
                transition={{ type: 'spring', stiffness: 120, damping: 20, delay: i * 0.06 }}
              />
            )}
          </span>
        );
        return (
          <div
            key={r?.key ?? `empty-${i}`}
            role="listitem"
            className="flex h-full min-w-0 flex-1 flex-col items-center"
          >
            <span
              className={cn(
                'mb-2 rounded-full px-2 py-0.5 text-2xs font-bold tabular-nums',
                !r
                  ? 'invisible'
                  : isPeak
                    ? 'bg-primary text-white shadow-sm'
                    : 'text-foreground/70',
              )}
            >
              {r?.count ?? 0}
            </span>
            {r && onSelect ? (
              <button
                type="button"
                onClick={() => onSelect(r)}
                aria-label={`${r.label}: ${r.count}`}
                className="flex min-h-0 w-full max-w-[3.25rem] flex-1 flex-col cursor-pointer rounded-full transition-opacity duration-fast hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              >
                {body}
              </button>
            ) : (
              <span className="flex min-h-0 w-full max-w-[3.25rem] flex-1 flex-col">{body}</span>
            )}
            <span
              title={r?.label}
              className="mt-2 block w-full truncate text-center text-2xs text-muted-foreground"
            >
              {r?.label ?? ' '}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Semicircle gauge: the share of the first segment, with a legend. The track
 * shows every segment in order; the unfilled remainder is hatched.
 */
export function Gauge({
  segments,
  centerLabel,
}: {
  segments: Array<{ label: string; value: number; tone: 'hero' | 'primary' | 'muted' }>;
  centerLabel: string;
}) {
  const reduce = useReducedMotion();
  const total = segments.reduce((s, x) => s + x.value, 0);
  const share = total > 0 ? Math.round((segments[0]!.value / total) * 100) : 0;
  const R = 80;
  const C = Math.PI * R; // half circumference
  const STROKE: Record<string, string> = {
    hero: 'oklch(0.32 0.14 278)',
    primary: 'oklch(var(--primary) / 0.75)',
    muted: 'oklch(var(--primary) / 0.22)',
  };
  let offset = 0;
  return (
    <div className="flex flex-col items-center">
      <div className="relative w-full max-w-[16rem]">
        <svg
          viewBox="0 0 200 112"
          className="w-full"
          role="img"
          aria-label={`${share}% ${centerLabel}`}
        >
          <defs>
            <pattern
              id="gauge-hatch"
              width="6"
              height="6"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <line
                x1="0"
                y1="0"
                x2="0"
                y2="6"
                stroke="oklch(0.55 0.15 278 / 0.35)"
                strokeWidth="2"
              />
            </pattern>
          </defs>
          <path
            d="M20 100 A80 80 0 0 1 180 100"
            fill="none"
            stroke="url(#gauge-hatch)"
            strokeWidth="22"
            strokeLinecap="round"
          />
          {total > 0 &&
            segments.map((s) => {
              const len = (s.value / total) * C;
              const el = (
                <motion.path
                  key={s.label}
                  d="M20 100 A80 80 0 0 1 180 100"
                  fill="none"
                  stroke={STROKE[s.tone]}
                  strokeWidth="22"
                  strokeLinecap="butt"
                  strokeDasharray={`${len} ${C}`}
                  initial={reduce ? false : { strokeDashoffset: -offset + len }}
                  animate={{ strokeDashoffset: -offset }}
                  transition={{ duration: 0.9, ease: [0.23, 1, 0.32, 1] }}
                />
              );
              offset += len;
              return s.value > 0 ? el : null;
            })}
        </svg>
        <div className="absolute inset-x-0 bottom-0 flex flex-col items-center">
          <span className="text-4xl font-extrabold leading-none tracking-[-0.04em] text-foreground">
            <CountUp value={share} />%
          </span>
          <span className="mt-1 text-xs text-muted-foreground">{centerLabel}</span>
        </div>
      </div>
      <ul className="mt-4 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="h-2.5 w-2.5 rounded-full"
              style={{ background: STROKE[s.tone] }}
            />
            {s.label}{' '}
            <strong className="font-semibold text-foreground tabular-nums">{s.value}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A white bento card with a title row and an optional action on the right. */
export function BentoCard({
  title,
  hint,
  action,
  className,
  index = 0,
  children,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  className?: string;
  index?: number;
  children: ReactNode;
}) {
  return (
    <Rise index={index} className={className}>
      <section className="flex h-full flex-col rounded-[1.4rem] bg-card p-5 shadow-soft ring-1 ring-foreground/[0.06]">
        <header className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold tracking-tight text-foreground">{title}</h2>
            {hint && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{hint}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </header>
        <div className="min-h-0 flex-1">{children}</div>
      </section>
    </Rise>
  );
}
