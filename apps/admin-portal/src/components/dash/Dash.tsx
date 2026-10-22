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

/**
 * The ACCENT card surface (Rapport skin, 2026-10-22): a solid near-black on
 * the brand hue - the reference's dark accent card, in our ink - with one
 * faint indigo glow in the far corner so it reads as ours, not as black.
 * White text on it measures ~16:1.
 */
export const HERO_SURFACE =
  'bg-[radial-gradient(90%_80%_at_100%_0%,oklch(0.477_0.223_278/0.55),transparent_60%),linear-gradient(160deg,oklch(0.25_0.04_278),oklch(0.19_0.03_278))]';

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
          'group relative flex h-full w-full flex-col overflow-hidden rounded-[1.625rem] p-[1.125rem] text-start',
          'transition-[box-shadow,transform] duration-base ease-out',
          hero
            ? cn(HERO_SURFACE, 'text-white shadow-[0_24px_48px_-24px_oklch(0.2_0.05_278/0.8)]')
            : 'bg-card text-foreground shadow-soft ring-1 ring-inset ring-glass/80 hover:shadow-float',
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
            className={cn(
              'text-[0.9375rem] font-semibold',
              hero ? 'text-white/90' : 'text-foreground',
            )}
          >
            {title}
          </span>
          {onOpen && (
            <span
              aria-hidden
              className={cn(
                'grid h-9 w-9 shrink-0 place-items-center rounded-full ring-1 transition-transform duration-base ease-out',
                'motion-safe:group-hover:rotate-45',
                hero
                  ? 'bg-white/[0.12] text-white ring-white/25'
                  : 'bg-glass/70 text-foreground ring-glass',
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
              <span className="text-[2.625rem] font-semibold leading-none tracking-[-0.03em]">
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
            strokeLinecap="butt"
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
          <span className="text-4xl font-semibold leading-none tracking-[-0.03em] text-foreground">
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

/*
 * CARD TONES (owner, 2026-10-15: "light shades of other colours too, not only
 * the brand colour"). Each breakdown card gets its own soft hue: a faint wash
 * across the top of the card, an icon chip, and bars in that hue. Literal
 * class strings so Tailwind generates every one of them.
 */
export type Tone = 'indigo' | 'violet' | 'sky' | 'mint' | 'rose' | 'amber' | 'teal';

export const TONES: Record<
  Tone,
  { wash: string; chip: string; bar: string; track: string; ink: string; dot: string }
> = {
  indigo: {
    wash: 'bg-[linear-gradient(180deg,oklch(0.95_0.035_277),transparent_5.5rem)]',
    chip: 'bg-[oklch(0.93_0.045_277)] text-[oklch(0.42_0.19_277)]',
    bar: 'bg-[linear-gradient(90deg,oklch(0.62_0.17_277),oklch(0.48_0.2_277))]',
    track: 'bg-[oklch(0.95_0.02_277)]',
    ink: 'text-[oklch(0.42_0.19_277)]',
    dot: 'oklch(0.52 0.2 277)',
  },
  violet: {
    wash: 'bg-[linear-gradient(180deg,oklch(0.95_0.035_305),transparent_5.5rem)]',
    chip: 'bg-[oklch(0.93_0.05_305)] text-[oklch(0.45_0.17_305)]',
    bar: 'bg-[linear-gradient(90deg,oklch(0.7_0.14_305),oklch(0.55_0.18_305))]',
    track: 'bg-[oklch(0.955_0.02_305)]',
    ink: 'text-[oklch(0.45_0.17_305)]',
    dot: 'oklch(0.58 0.18 305)',
  },
  sky: {
    wash: 'bg-[linear-gradient(180deg,oklch(0.955_0.03_235),transparent_5.5rem)]',
    chip: 'bg-[oklch(0.93_0.045_235)] text-[oklch(0.45_0.13_240)]',
    bar: 'bg-[linear-gradient(90deg,oklch(0.76_0.11_230),oklch(0.6_0.14_240))]',
    track: 'bg-[oklch(0.96_0.018_235)]',
    ink: 'text-[oklch(0.45_0.13_240)]',
    dot: 'oklch(0.62 0.14 238)',
  },
  mint: {
    wash: 'bg-[linear-gradient(180deg,oklch(0.96_0.035_160),transparent_5.5rem)]',
    chip: 'bg-[oklch(0.93_0.055_160)] text-[oklch(0.45_0.12_160)]',
    bar: 'bg-[linear-gradient(90deg,oklch(0.8_0.12_160),oklch(0.62_0.14_160))]',
    track: 'bg-[oklch(0.96_0.02_160)]',
    ink: 'text-[oklch(0.45_0.12_160)]',
    dot: 'oklch(0.64 0.14 160)',
  },
  rose: {
    wash: 'bg-[linear-gradient(180deg,oklch(0.96_0.03_15),transparent_5.5rem)]',
    chip: 'bg-[oklch(0.94_0.04_15)] text-[oklch(0.5_0.17_20)]',
    bar: 'bg-[linear-gradient(90deg,oklch(0.75_0.13_15),oklch(0.6_0.18_20))]',
    track: 'bg-[oklch(0.965_0.016_15)]',
    ink: 'text-[oklch(0.5_0.17_20)]',
    dot: 'oklch(0.62 0.18 20)',
  },
  amber: {
    wash: 'bg-[linear-gradient(180deg,oklch(0.965_0.04_80),transparent_5.5rem)]',
    chip: 'bg-[oklch(0.94_0.06_80)] text-[oklch(0.5_0.11_65)]',
    bar: 'bg-[linear-gradient(90deg,oklch(0.85_0.12_85),oklch(0.72_0.15_65))]',
    track: 'bg-[oklch(0.965_0.022_80)]',
    ink: 'text-[oklch(0.5_0.11_65)]',
    dot: 'oklch(0.74 0.15 70)',
  },
  teal: {
    wash: 'bg-[linear-gradient(180deg,oklch(0.96_0.03_195),transparent_5.5rem)]',
    chip: 'bg-[oklch(0.93_0.045_195)] text-[oklch(0.45_0.09_200)]',
    bar: 'bg-[linear-gradient(90deg,oklch(0.8_0.09_195),oklch(0.6_0.1_205))]',
    track: 'bg-[oklch(0.96_0.016_195)]',
    ink: 'text-[oklch(0.45_0.09_200)]',
    dot: 'oklch(0.6 0.1 203)',
  },
};

/**
 * A ranked list on capsule bars (the bento breakdowns). The top three carry a
 * filled rank badge in the card's tone; the rest are quiet numerals. Each row
 * is a button when `onSelect` is given, so the drill-down still works.
 */
export function RankBars({
  rows,
  total,
  tone,
  onSelect,
  emptyLabel,
  initials,
}: {
  rows: PillRow[];
  /** Shares are of this; omit to hide the share. */
  total?: number;
  tone: Tone;
  onSelect?: (row: PillRow) => void;
  emptyLabel: ReactNode;
  /** Show an initials disc instead of the rank number (people lists). */
  initials?: boolean;
}) {
  const reduce = useReducedMotion();
  if (rows.length === 0) return <>{emptyLabel}</>;
  const t = TONES[tone];
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <ul className="space-y-1">
      {rows.map((r, i) => {
        const pct = Math.max(3, (r.count / max) * 100);
        const share = total && total > 0 ? Math.round((r.count / total) * 100) : null;
        const badge = initials
          ? r.label
              .split(/\s+/)
              .filter(Boolean)
              .slice(0, 2)
              .map((w) => w[0]!.toUpperCase())
              .join('') || '?'
          : String(i + 1);
        const body = (
          <>
            <span
              aria-hidden
              className={cn(
                'grid h-7 w-7 shrink-0 place-items-center text-2xs font-bold tabular-nums',
                initials ? 'rounded-full' : 'rounded-[0.6rem]',
                i < 3 || initials ? t.chip : 'bg-secondary text-muted-foreground',
              )}
            >
              {badge}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-3">
                <span
                  className="truncate text-start text-xs font-medium text-foreground"
                  title={r.label}
                >
                  {r.label}
                </span>
                <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
                  <strong className="text-xs font-semibold text-foreground">{r.count}</strong>
                  {share !== null && <span className="ms-1.5">{share}%</span>}
                </span>
              </span>
              <span className={cn('mt-1.5 block h-2 overflow-hidden rounded-full', t.track)}>
                <motion.span
                  className={cn('block h-full rounded-full', t.bar)}
                  initial={reduce ? false : { width: '0%' }}
                  animate={{ width: `${pct}%` }}
                  transition={{
                    duration: 0.7,
                    ease: [0.23, 1, 0.32, 1],
                    delay: Math.min(i, 10) * 0.04,
                  }}
                />
              </span>
            </span>
          </>
        );
        return (
          <li key={r.key}>
            {onSelect ? (
              <button
                type="button"
                onClick={() => onSelect(r)}
                className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-2 py-1.5 transition-colors duration-fast hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                {body}
              </button>
            ) : (
              <span className="flex items-center gap-3 px-2 py-1.5">{body}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** A white bento card with a title row and an optional action on the right. */
export function BentoCard({
  title,
  hint,
  action,
  className,
  index = 0,
  tone,
  icon,
  children,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  className?: string;
  index?: number;
  /** A soft hue for the card: a wash across the top and the icon chip. */
  tone?: Tone;
  icon?: ReactNode;
  children: ReactNode;
}) {
  const t = tone ? TONES[tone] : undefined;
  return (
    <Rise index={index} className={className}>
      <section
        /* Marks the pastel wash so the dark theme can drop it (index.css). */
        data-tone-wash={t ? '' : undefined}
        className={cn(
          'flex h-full flex-col rounded-[1.625rem] bg-card p-[1.125rem] shadow-soft ring-1 ring-inset ring-glass/80',
          t?.wash,
        )}
      >
        <header className="mb-4 flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            {icon && (
              <span
                aria-hidden
                className={cn(
                  'grid h-9 w-9 shrink-0 place-items-center rounded-full',
                  t?.chip ?? 'bg-secondary text-muted-foreground',
                )}
              >
                {icon}
              </span>
            )}
            <div className="min-w-0">
              <h2 className="text-[0.9375rem] font-semibold tracking-tight text-foreground">
                {title}
              </h2>
              {hint && (
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{hint}</p>
              )}
            </div>
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </header>
        <div className="min-h-0 flex-1">{children}</div>
      </section>
    </Rise>
  );
}

/**
 * One reading in the page header's stat strip (Rapport skin): a round icon
 * chip, the value, an optional badge pill and a one-line caption. Sits beside
 * the big page title.
 */
export function HeaderStat({
  icon,
  value,
  badge,
  caption,
}: {
  icon: ReactNode;
  value: ReactNode;
  badge?: ReactNode;
  caption: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span
        aria-hidden
        className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-glass/70 text-foreground shadow-[inset_0_0_0_1px_oklch(var(--glass)/0.85),0_10px_24px_-16px_oklch(var(--shadow-color)/0.5)]"
      >
        {icon}
      </span>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-lg font-semibold leading-tight tracking-[-0.01em] text-foreground tabular-nums">
            {value}
          </span>
          {badge}
        </div>
        <div className="max-w-[13rem] text-xs leading-snug text-muted-foreground">{caption}</div>
      </div>
    </div>
  );
}

/** The small pill beside a header stat ("+5% vs last month"). */
export function HeaderBadge({
  children,
  variant = 'ink',
}: {
  children: ReactNode;
  /* `variant`, not `tone`: `tone=` on the dashboard is reserved for the card
     tone table, and a test holds every `tone=` there to that table. */
  variant?: 'ink' | 'highlight' | 'plain';
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-2xs font-bold',
        variant === 'ink' && 'bg-ink text-ink-foreground',
        variant === 'highlight' && 'bg-highlight text-highlight-foreground',
        variant === 'plain' && 'bg-glass/80 text-foreground ring-1 ring-inset ring-foreground/10',
      )}
    >
      {children}
    </span>
  );
}
