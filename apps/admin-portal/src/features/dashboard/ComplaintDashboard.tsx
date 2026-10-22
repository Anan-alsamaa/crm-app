import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  cn,
  DateField,
  Drawer,
  ErrorState,
  CheckCircleIcon,
  ChartIcon,
  ClockIcon,
  InboxIcon,
  MeterBar,
  ProgressRing,
  SelectMenu,
  Skeleton,
  SparkleIcon,
  StoreIcon,
  TeamIcon,
  UsersIcon,
  ZapIcon,
} from '@yiji/ui';
import {
  emptyComplaintFilters,
  UNASSIGNED_AGENT,
  selectedYear,
  useComplaintMetrics,
  useComplaintYears,
  yearBounds,
  type Breakdown,
  type ComplaintFilters,
  type ComplaintRow,
  type Cut,
} from './complaints-api.js';
import { CouponSpend, useCouponSpend } from './CouponSpend.js';
import { couponWorth } from '@yiji/reports';
import { CustomerReach } from './CustomerReach.js';
import { useNavigate } from 'react-router-dom';
import {
  BentoCard,
  Gauge,
  HATCH,
  PillColumns,
  RankBars,
  StatCard,
  TrendPill,
  type Tone,
} from '../../components/dash/Dash.js';
import { ReportVendorFilter } from '../../lib/report-vendor.js';

/**
 * The operations manager's Dashboard, rebuilt on our data.
 *
 * Section for section it follows the app this replaces: filter bar, six KPIs,
 * complaints-per-month, agent performance, then the "By X" bar breakdowns. Two
 * KPIs measure something genuinely different here and say so on the card —
 * satisfaction comes from the customer's CSAT rather than a status an agent
 * picked, and we have no "Escalated" status, so the nearest real signal of a
 * complaint in trouble is a missed first-response SLA.
 */

const SAR = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' SAR';

/* ── KPI ──────────────────────────────────────────────────────────────────
 * The reference boards' KPI card: an icon in a tinted square chip, one big
 * number, a label, and a small line of context. Chips use the `--<hue>-tint`
 * fills (three-token rule); `--warning` is excluded — its glyph contrast on
 * the tint fails 3:1 in the light theme — so Compensation carries the brand
 * hue instead.
 */
const KPI_CHIPS = {
  neutral: 'bg-secondary text-foreground',
  sky: 'bg-sky-tint text-sky',
  violet: 'bg-violet-tint text-violet',
  success: 'bg-success-tint text-success',
  primary: 'bg-primary-tint text-primary',
  destructive: 'bg-destructive-tint text-destructive',
  // Amber. Added so eight cards can carry six distinct hues instead of five
  // with two repeats — see KPI_NUMERALS.
  amber: 'bg-[oklch(0.93_0.065_75)] text-[oklch(0.42_0.10_75)]',
} as const;

/*
 * ONE NEUTRAL CARD, and the colour spent only where it carries meaning.
 *
 * This board went through pastel fills, a saturated 4px top stripe, coloured
 * rings and tinted shadows — four ways of saying the same hue on one card. The
 * owner's verdict was "cartoonish, not enterprise", and that was right: a wall
 * of coloured rectangles with bunting along the top is a consumer convention.
 * Stripe, Linear, Datadog and Vercel all do the opposite — a plain card, a
 * hairline border, and colour reserved for the data itself.
 *
 * So the surface is now identical on every card. The hue survives in exactly
 * two places, both of which are information rather than decoration: the ICON
 * CHIP and the NUMERAL. That is still enough to tell eight cards apart at a
 * glance, because the eye lands on the number first anyway.
 *
 * A single flat token rather than a per-tone map, kept as a constant so the
 * next person changing it does not have to find eight copies.
 */
const KPI_CARD = cn(
  'bg-card ring-1 ring-foreground/[0.06]',
  /*
   * A THREE-LAYER shadow, which is what makes a surface read as lifted rather
   * than outlined.
   *
   * One blurry drop shadow flattens — the eye reads a grey smudge. Real depth
   * comes from stacking: a tight contact shadow where the card meets the page,
   * a mid layer for the body, and a wide soft layer for ambient occlusion. It
   * is the same trick as a physical card on a desk.
   *
   * Still neutral, still low opacity. The previous version was so faint
   * (0.04 / 0.14) that the cards read as flat rectangles — restraint had gone
   * past enterprise into lifeless.
   */
  'shadow-[0_1px_2px_oklch(var(--shadow-color)/0.06),0_4px_8px_-2px_oklch(var(--shadow-color)/0.08),0_16px_32px_-12px_oklch(var(--shadow-color)/0.14)]',
);

/* The numeral is the one place a hue is written as a literal instead of a
 * token. `--sky` and `--success` are tuned to fill a chip, and at that
 * lightness a 44px numeral on white misses 4.5:1 — so these are the same
 * hues darkened until they pass. Keep the HUE in step with the token when
 * the brand moves; only the lightness is meant to differ. */
/*
 * The numeral, one per tone, tuned to its own ground.
 *
 * Written as literals rather than tokens because `--primary` and friends are
 * chosen to fill a chip, and at that lightness a 40px numeral on a tint misses
 * 4.5:1. These are the same hues darkened until they pass — keep the HUE in
 * step with the tint when the palette moves; only the lightness should differ.
 *
 * Every pair below was measured on its actual ground: 6.5 to 7.8 against the
 * tints in index.css. Do not eyeball a replacement.
 */
const KPI_NUMERALS = {
  neutral: 'text-foreground',
  sky: 'text-[oklch(0.40_0.10_195)]',
  violet: 'text-[oklch(0.42_0.15_320)]',
  success: 'text-[oklch(0.40_0.11_155)]',
  primary: 'text-[oklch(0.40_0.16_277)]',
  destructive: 'text-[oklch(0.44_0.15_15)]',
  amber: 'text-[oklch(0.42_0.10_75)]',
} as const;

/**
 * Five stars with the mean filled in, the last one partially.
 *
 * A rating is the one number on this board people already have a mental image
 * for, and it is not a percentage — it is stars. Drawing them makes 3.3 legible
 * at a glance in a way "67%" never was, and it matches what the customer
 * actually saw in the chat widget when they gave the score.
 *
 * The partial star is a width-clipped overlay rather than a half-star glyph, so
 * 3.3 and 3.7 look different instead of both rounding to "three and a half".
 * `aria-label` carries the number itself: the stars are an illustration of a
 * value that is already printed beside them, so screen readers get the reading
 * rather than five separate star characters.
 */
function StarScore({ score }: { score: number }) {
  const pct = Math.max(0, Math.min(100, (score / 5) * 100));
  return (
    <div
      className="relative inline-block leading-none"
      role="img"
      aria-label={`${score.toFixed(1)} / 5`}
    >
      <span className="text-base tracking-tight text-muted-foreground/30" aria-hidden="true">
        ★★★★★
      </span>
      <span
        className="absolute inset-0 overflow-hidden text-base tracking-tight text-amber-500"
        style={{ width: `${pct}%` }}
        aria-hidden="true"
      >
        ★★★★★
      </span>
    </div>
  );
}

function Kpi({
  value,
  unit,
  label,
  sub,
  tone,
  icon,
  visual,
  meter,
  delta,
  order = 0,
  onOpen,
}: {
  value: string;
  /**
   * A unit rendered beside the numeral — "SAR", not part of the label.
   *
   * It used to live in the label ("Compensation approved (SAR)"), which put the
   * currency in the quietest text on the card and left the hero numeral
   * unitless: "255" reads as a count, not money. A unit belongs to the number
   * it qualifies.
   */
  unit?: string;
  label: string;
  sub?: string;
  tone: keyof typeof KPI_CHIPS;
  icon: React.ReactNode;
  /** End-side data accent — a ProgressRing on the KPIs that are a share. */
  visual?: React.ReactNode;
  /** Thin meter in the footer — the boards' load reading, for counts-of-a-whole. */
  meter?: React.ReactNode;
  /** Month-over-month badge under the numeral — the reference cards' +12%. */
  delta?: React.ReactNode;
  /** Position in the KPI row — drives the entrance cascade. */
  order?: number;
  /**
   * Makes the WHOLE card open its rows.
   *
   * Not a button parked on the card: a card carrying a control has two targets,
   * and the number itself is what people point at.
   */
  onOpen?: () => void;
}) {
  // An unmeasurable KPI used to render at hero size, which reads as a broken
  // card rather than as "nothing to measure yet". Anything without a digit in
  // it is a phrase standing in for a measurement, not a measurement.
  const empty = !/\d/.test(value);
  const Root = onOpen ? 'button' : 'div';
  return (
    <Root
      {...(onOpen ? { type: 'button', onClick: onOpen } : {})}
      style={{ animationDelay: `${Math.min(order, 6) * 55}ms` }}
      className={cn(
        // `rounded-xl`, not `2xl`: a softer corner is friendlier and reads
        // consumer. Enterprise surfaces are closer to square.
        'group relative flex flex-col rounded-xl p-5',
        KPI_CARD,
        'motion-safe:animate-rise-in',
        /*
         * The card lifts under the cursor — 2px, not the 16px it once did.
         *
         * A full-rem jump is a fidget on a board somebody reads all day; no
         * movement at all makes the surface feel painted on. Two pixels plus a
         * deepening shadow is the amount that reads as "this is a thing on a
         * page" without asking to be noticed.
         *
         * Under `motion-safe`, so anyone who has asked their system for reduced
         * motion gets the shadow change and no movement.
         */
        'transition-[box-shadow,transform] duration-base ease-out',
        'hover:shadow-[0_2px_4px_oklch(var(--shadow-color)/0.07),0_8px_16px_-4px_oklch(var(--shadow-color)/0.10),0_24px_48px_-16px_oklch(var(--shadow-color)/0.20)]',
        'hover:ring-foreground/[0.10] motion-safe:hover:-translate-y-0.5',
        onOpen &&
          'w-full cursor-pointer text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
      )}
    >
      {/* Label above the numeral and the icon chip at the END — the reference
          card's anatomy, which gives the number the whole width instead of
          squeezing it beside a chip. */}
      <div className="flex items-start justify-between gap-3">
        <span className="text-xs font-semibold text-muted-foreground">{label}</span>
        <span
          aria-hidden
          className={cn(
            'grid h-10 w-10 shrink-0 place-items-center rounded-xl transition-transform duration-base ease-out',
            'motion-safe:group-hover:scale-110',
            KPI_CHIPS[tone],
          )}
        >
          {icon}
        </span>
      </div>

      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div
            className={cn(
              'font-extrabold leading-none tabular-nums tracking-[-0.035em]',
              empty
                ? 'text-base font-semibold text-muted-foreground'
                : `text-[2.5rem] ${KPI_NUMERALS[tone]}`,
            )}
          >
            {value}
            {/* Smaller and quieter than the numeral, and NOT tabular — a unit is
                a word, so it should not be forced onto digit-width columns.
                Hidden when the value is a phrase ("No ratings yet"), where a
                trailing "SAR" would be nonsense. */}
            {unit && !empty && (
              <span className="ms-1.5 align-baseline text-lg font-semibold tracking-normal text-muted-foreground">
                {unit}
              </span>
            )}
          </div>
          {delta && <div className="mt-2">{delta}</div>}
        </div>
        {visual && (
          <span aria-hidden className="shrink-0">
            {visual}
          </span>
        )}
      </div>

      {/* Footer rule + context line, so every card ends on the same baseline
          however much its middle carries. */}
      <div className="mt-4 border-t border-foreground/[0.07] pt-3">
        {meter && <div className="mb-2">{meter}</div>}
        <div className="min-h-[1rem] text-2xs leading-relaxed text-muted-foreground">
          {sub ?? ''}
        </div>
      </div>
    </Root>
  );
}

/* Section surfaces are the shared SectionCard: identical title/hint/aside
 * anatomy to the local helper it replaced, but now literally the same card
 * every board in the app draws — the aside slot still carries "top 10 of 24". */

/**
 * The in-card empty: an icon dot over the sentence. Every chart on this page
 * used to fall back to one bare grey line adrift in a card, which reads as a
 * rendering failure rather than as "the range is empty" — this is the composed
 * version, compact enough for the smallest CutCard.
 */
function CardEmpty({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-6 text-center">
      <span
        aria-hidden
        className="grid h-8 w-8 place-items-center rounded-lg bg-secondary text-muted-foreground"
      >
        <InboxIcon size={15} />
      </span>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

/**
 * Weekly activity heatmap — the reference dashboard's grid: the last six ISO
 * weeks as rows, weekdays as columns, cell intensity = complaints that day.
 * Reads load patterns (weekend spikes, a bad Tuesday) that totals hide.
 */
function Heatmap({ rows, locale }: { rows: ComplaintRow[]; locale: string }) {
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const day = (r.date ?? '').slice(0, 10);
    if (day) byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  // 6 rows × 7 columns ending today, weeks starting Monday.
  const today = new Date();
  const dow = (today.getDay() + 6) % 7; // 0 = Monday
  const weeks: Array<Array<{ iso: string; count: number }>> = [];
  for (let w = 5; w >= 0; w--) {
    const week: Array<{ iso: string; count: number }> = [];
    for (let d = 0; d < 7; d++) {
      const dt = new Date(today);
      dt.setDate(today.getDate() - dow - w * 7 + d);
      const iso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(
        dt.getDate(),
      ).padStart(2, '0')}`;
      week.push({ iso, count: byDay.get(iso) ?? 0 });
    }
    weeks.push(week);
  }
  const max = Math.max(1, ...weeks.flat().map((c) => c.count));
  const weekdayNames = weeks[0]!.map((c) =>
    new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(new Date(`${c.iso}T12:00:00`)),
  );
  return (
    <div>
      <div className="mb-1.5 flex gap-1.5">
        {weekdayNames.map((n, i) => (
          <span
            key={i}
            className="flex-1 text-center text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground"
          >
            {n}
          </span>
        ))}
      </div>
      <div className="space-y-1.5">
        {weeks.map((week, wi) => (
          <div key={wi} className="flex gap-1.5">
            {week.map((c, di) => (
              <span
                key={c.iso}
                title={`${c.iso} · ${c.count}`}
                className={cn(
                  'h-7 flex-1 rounded-full transition-transform duration-fast ease-out hover:scale-[1.06] motion-safe:animate-fade-in',
                  // An empty day is the hatched track, as in the pill charts.
                  c.count === 0 && HATCH,
                )}
                style={{
                  ...(c.count === 0
                    ? {}
                    : {
                        backgroundColor: `oklch(var(--primary) / ${0.2 + 0.75 * (c.count / max)})`,
                      }),
                  animationDelay: `${(wi * 7 + di) * 12}ms`,
                }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/* The old gradient Columns chart is replaced by PillColumns (components/dash),
 * the reference board's pill bars on a hatched track (owner, 2026-10-15). */

// `Funnel` went with the card it drew: logged -> closed -> rated -> satisfied
// is the KPI strip again, in four bars.

/**
 * One breakdown card: title, his "top N of M" note when the list is capped, and
 * the bars. Wrapping it keeps that note impossible to forget on a new card —
 * the previous version capped every list and admitted it on none.
 */
function CutCard({
  title,
  hint,
  cut,
  total,
  tone,
  icon,
  initials,
  className,
  index,
  onSelect,
  emptyLabel,
}: {
  title: string;
  hint?: string;
  cut: Cut;
  total: number;
  tone: Tone;
  icon: React.ReactNode;
  /** People lists show an initials disc instead of a rank number. */
  initials?: boolean;
  className?: string;
  index?: number;
  onSelect?: (row: Breakdown) => void;
  emptyLabel?: string;
}) {
  const { t } = useTranslation();
  const hidden = cut.distinct > cut.rows.length;
  return (
    <BentoCard
      title={title}
      hint={hint}
      tone={tone}
      icon={icon}
      index={index}
      className={className}
      action={
        hidden ? (
          <span className="rounded-full bg-card/80 px-2.5 py-1 text-2xs font-medium text-muted-foreground ring-1 ring-foreground/[0.06]">
            {t('complaintDash.topNofM', {
              defaultValue: 'top {{n}} of {{m}}',
              n: cut.rows.length,
              m: cut.distinct,
            })}
          </span>
        ) : undefined
      }
    >
      <RankBars
        rows={cut.rows}
        total={total}
        tone={tone}
        initials={initials}
        onSelect={onSelect ? (row) => onSelect(row as Breakdown) : undefined}
        emptyLabel={
          <CardEmpty
            label={
              emptyLabel ??
              t('complaintDash.nothingInRange', { defaultValue: 'Nothing in this range.' })
            }
          />
        }
      />
    </BentoCard>
  );
}

/* The DONUT is gone, with the "Where tickets come from" card it drew.
 *
 * It ranked brands as arcs directly above a "By brand" panel ranking the same
 * numbers as bars with the counts written on — the same answer twice, and the
 * slower of the two to read. Comparing arc lengths is a thing people are bad
 * at; reading "37" is not.
 *
 * SLICE went with it. It was the only palette naming six hues at full chroma,
 * and nothing else on this dashboard draws in them.
 */

// `Composition` lived here for the Service health card, which is gone: it was
// a fourth reading of numbers the KPI strip already carries.

// TrendChart went with the "Tickets per month" card it drew — two readings on
// one chart, each with its own scale, is a picture you have to be told how to
// read.

/**
 * Tickets per month, as bars.
 *
 * Bars rather than a line: months are discrete buckets, and a curve drawn
 * between them implies readings in between that were never taken. Six months of
 * data is also too few points for a curve to be anything but decoration.
 *
 * The tallest month sets the scale, so the shape is a comparison BETWEEN the
 * months shown rather than against an absolute nobody has. The last bar is
 * emphasised because it is the one still being written — a partial month at
 * full weight reads as a real drop.
 */
export function MonthBars({ months }: { months: readonly { month: string; count: number }[] }) {
  const { t, i18n } = useTranslation();
  /* `i18n?.language` and not `i18n.language`: a locale is a nicety here — the
     month name falls back to the runtime default — and a chart must not throw
     because the i18n instance is absent. It is, in the render tests. */
  const locale = i18n?.language || undefined;
  // At most twelve, most recent last: beyond that the bars are too thin to
  // compare and the older half is not what anyone is acting on.
  const shown = months.slice(-12);
  const peak = Math.max(...shown.map((m) => m.count), 1);

  const label = (ym: string) => {
    const [y, mo] = ym.split('-').map(Number);
    if (!y || !mo) return ym;
    // Month name in the reader's language; the year only on January, so a
    // twelve-month run does not repeat it under every bar.
    const d = new Date(Date.UTC(y, mo - 1, 1));
    const name = d.toLocaleDateString(locale, {
      month: 'short',
      timeZone: 'UTC',
    });
    return mo === 1 ? `${name} ${String(y).slice(2)}` : name;
  };

  return (
    /* `max-w-[4.5rem]` per bar and a left-aligned row, NOT `flex-1`.
       Distributing the width meant two months drew as two enormous slabs and
       ONE month drew as a full-width rule that read like a divider. A bar has a
       natural width; the row fills from the start and stops. */
    <div className="flex h-44 items-end gap-2" dir="ltr">
      {shown.map((m, i) => {
        const last = i === shown.length - 1;
        const pct = (m.count / peak) * 100;
        return (
          <div
            key={m.month}
            className="flex min-w-0 max-w-[4.5rem] flex-1 flex-col items-center gap-1.5"
          >
            <span className="text-2xs font-semibold tabular-nums text-foreground">{m.count}</span>
            <div className="flex w-full flex-1 items-end">
              <div
                className={cn(
                  'w-full rounded-t-md transition-[height] duration-slow ease-out',
                  last ? 'bg-sky' : 'bg-sky/45',
                )}
                /* `minHeight` so a month with one ticket is still a visible
                   bar — a sliver of nothing reads as zero, and zero and one
                   are different answers. */
                style={{ height: `${pct}%`, minHeight: m.count > 0 ? 4 : 0 }}
                title={`${label(m.month)} — ${m.count}`}
              />
            </div>
            <span className="w-full truncate text-center text-2xs text-muted-foreground">
              {label(m.month)}
            </span>
          </div>
        );
      })}
      <span className="sr-only">
        {t('complaintDash.opsTrendSr', {
          defaultValue: 'Tickets per month for the current selection.',
        })}
      </span>
    </div>
  );
}

/**
 * The complaints behind one number.
 *
 * A dashboard that only aggregates asks the reader to trust it; "12 late orders
 * in Khobar" is useless until you can see which twelve. His app answered this
 * by jumping to the All Complaints screen with filters applied — we have no
 * such screen in the admin portal, and a drawer is better anyway: the filters,
 * scroll position and the chart you clicked are all still there behind it.
 */
function DrillDown({
  title,
  rows,
  onClose,
}: {
  title: string;
  rows: ComplaintRow[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const money = rows.reduce((s, r) => s + r.couponValue, 0);
  return (
    <Drawer
      open
      onClose={onClose}
      width="lg"
      title={title}
      description={t('complaintDash.drillCount', {
        defaultValue: '{{n}} ticket(s) · {{money}} compensation',
        n: rows.length,
        money: SAR(money),
      })}
    >
      {rows.length === 0 ? (
        <CardEmpty
          label={t('complaintDash.nothingInRange', { defaultValue: 'Nothing in this range.' })}
        />
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((r) => (
            <li key={r.id} className="py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-sm font-medium text-foreground">
                  {r.subject || t('complaintDash.untitled', { defaultValue: '(no subject)' })}
                </span>
                <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
                  {r.date}
                </span>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted-foreground">
                <span className={cn(r.isOpen ? 'font-semibold text-warning-foreground' : '')}>
                  {t(`status.${r.status}`, { ns: 'common', defaultValue: r.status })}
                </span>
                {[r.restaurantName, r.complaintType, r.serviceType, r.agentName]
                  .filter(Boolean)
                  .map((bit, i) => (
                    <span key={i}>
                      <span aria-hidden className="me-2">
                        ·
                      </span>
                      {bit}
                    </span>
                  ))}
                {r.couponValue > 0 && (
                  <span className="tabular-nums">
                    <span aria-hidden className="me-2">
                      ·
                    </span>
                    {SAR(r.couponValue)}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  );
}

/**
 * One dashboard component, two views.
 *
 * **agent** is the support desk — the tickets, chats and compensation the team
 * is holding, with its charts. **operations** is the TEAM around the branches:
 * chain managers own brands, area managers own territories, branch managers own
 * restaurants, so it cuts the same filtered set by brand, area, city and branch.
 *
 * Shared, because both answer questions about the same rows: the filter bar, the
 * KPI strip and the ops snapshot. Split past that, because the two audiences
 * have nothing else in common.
 */
export function ComplaintDashboard({
  view = 'agent',
}: {
  view?: 'agent' | 'operations';
} = {}) {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  // Draft vs applied: his bar only re-runs the dashboard on Apply, which matters
  // when a filter change means refetching every ticket.
  /*
   * OPENS WITH NO FILTER, for every user (owner, 2026-10-15).
   *
   * The reports open on yesterday -> today; the DASHBOARD is the one page that
   * does not - it shows the whole picture, and the filters are there to narrow
   * it. (2026-10-05 had it on the last month for load time; the owner chose
   * the full view.)
   */
  const [opening] = useState<ComplaintFilters>(() => ({ ...emptyComplaintFilters }));
  const [draft, setDraft] = useState<ComplaintFilters>(opening);
  const [applied, setApplied] = useState<ComplaintFilters>(opening);
  const m = useComplaintMetrics(applied);
  const d = m.data;
  const years = useComplaintYears();
  /** Which year pill is lit — null when the range is not exactly one year. */
  const activeYear = selectedYear(applied);

  // Which slice of the numbers the reader clicked into.
  const [drill, setDrill] = useState<{ title: string; rows: ComplaintRow[] } | null>(null);

  /**
   * Open the complaints behind one breakdown row.
   *
   * Matching is on the breakdown's KEY, not its label: agent rows are keyed by
   * user id and labelled by name, and status rows are keyed by the raw value
   * while the label is translated. Comparing labels would work in English and
   * quietly return nothing in Arabic.
   */
  /**
   * Coupons, for the tiles. Shares CouponSpend's query key, so the tile and the
   * card below it are one request and can never disagree.
   */
  const couponFacts = useCouponSpend(applied.from, applied.to, view === 'agent');
  const coupons = useMemo(() => couponWorth(couponFacts.data ?? []), [couponFacts.data]);

  const drillInto =
    (title: string, keyOf: (r: ComplaintRow) => string, extra?: (r: ComplaintRow) => boolean) =>
    (row: Breakdown) =>
      setDrill({
        title: `${title}: ${row.label}`,
        rows: (d?.rows ?? []).filter((r) => keyOf(r) === row.key && (extra ? extra(r) : true)),
      });

  /**
   * What the team around the BRANCHES needs at a glance.
   *
   * SIX READINGS WERE REJECTED HERE, and they had one thing in common: every
   * one COUNTED something — tickets in range, tickets still open, branches
   * with a ticket, the busiest branch, tickets with no branch, the share
   * coming from the top five branches.
   *
   * The objection that killed the first is the one that kills them all. These
   * rows are complaints, not orders; nothing records how much business a
   * branch did, so a count cannot become a rate and a branch with more
   * complaints may simply be bigger. And a bare count tells an area manager
   * nothing to do on Monday — the ranked panels below already carry the
   * distribution for anyone who wants to read it properly.
   *
   * What is left names a PROBLEM instead of counting a thing: what customers
   * are complaining about, and where in the operation it happens. Both are
   * shares of the complaints themselves, which the data does support, and both
   * point at something a branch, area or chain manager can go and fix.
   */
  const ops = useMemo(
    () => ({
      topProblem: d?.byType.rows[0] ?? null,
      topService: d?.byServiceType.rows[0] ?? null,
    }),
    [d],
  );

  // Picking a brand narrows the restaurants to that brand's branches. There
  // are 132 of them across four brands, and a list that ignores the brand you
  // just chose is a list you have to read rather than pick from.
  const storeChoices = useMemo(
    () => [
      { value: '', label: t('complaintDash.allRestaurants', { defaultValue: 'All restaurants' }) },
      ...(d?.storeOptions ?? [])
        .filter((s) => !draft.brand || s.brandId === draft.brand)
        .map((s) => ({ value: s.id, label: s.name })),
    ],
    [d?.storeOptions, draft.brand, t],
  );

  // A restaurant left selected after switching brand is a filter that is set
  // but no longer visible in its own dropdown, which silently returns nothing.
  useEffect(() => {
    if (!draft.store) return;
    const stillListed = storeChoices.some((c) => c.value === draft.store);
    if (!stillListed) {
      setDraft((f) => ({ ...f, store: '' }));
      /* ...and clear it from what is APPLIED too, now that choosing a brand
         takes effect on its own. Clearing only the draft would leave the old
         restaurant still narrowing the results while its dropdown showed
         "All" — a filter that is on, invisible, and returns nothing. */
      setApplied((f) => (f.store ? { ...f, store: '' } : f));
    }
  }, [draft.brand, draft.store, storeChoices]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(applied);

  /**
   * Choose a value from a dropdown and have it TAKE EFFECT (owner, 2026-09-17).
   *
   * Picking from a menu is one deliberate act with a settled value, so making
   * somebody then find Apply added a click and bought nothing. Typing is the
   * case the draft exists for — a half-typed date re-querying on every
   * keystroke moves the table under the hands of somebody still deciding — so
   * the date fields still wait for Apply.
   *
   * Both states are written from the same object, so anything typed but not
   * yet applied rides along instead of being silently dropped.
   */
  const pick = (patch: Partial<ComplaintFilters>) => {
    setDraft((f) => {
      const next = { ...f, ...patch };
      setApplied(next);
      return next;
    });
  };
  /* "Anything to clear" now means "anything other than how the page opened":
     the opening window is itself a filter, and Clear returning to it must not
     count as having something to clear. */
  const anyFilter = JSON.stringify(applied) !== JSON.stringify(opening);

  // The two footer-total memos that lived here went with the agent tables
  // they summed — see the note further down.

  return (
    <div className="mx-auto w-full min-w-0 max-w-[110rem] space-y-4">
      {/* ── Filter bar ─────────────────────────────────────────────────
          Same surface as every SectionCard on the page; the fields inside
          carry the shared Input/SelectMenu styling on their own. */}
      <div className="flex flex-wrap items-end gap-x-3 gap-y-3 rounded-2xl bg-card p-[1.125rem] shadow-soft">
        {/* Year first, because it is the filter people actually reach for.
            Typing two dates to see "last year" is four interactions for a
            question asked constantly; this is one. The list comes from the
            data, so a second year of history adds its own button and nothing
            here needs changing when it does. It APPLIES immediately rather
            than filling the draft — a year is a whole answer, not the start of
            one, and the dates below stay in step so the two never disagree. */}
        <div className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-muted-foreground">
            {t('complaintDash.year', { defaultValue: 'Year' })}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                const next = { ...applied, from: '', to: '' };
                setDraft(next);
                setApplied(next);
              }}
              className={cn(
                'h-9 rounded-full px-3 text-xs font-semibold transition',
                !applied.from && !applied.to
                  ? 'bg-primary text-primary-foreground shadow-soft'
                  : 'bg-foreground/[0.04] text-muted-foreground hover:bg-foreground/[0.08]',
              )}
            >
              {t('complaintDash.allYears', { defaultValue: 'All' })}
            </button>
            {(years.data ?? []).map((y) => (
              <button
                key={y}
                type="button"
                onClick={() => {
                  const next = { ...applied, ...yearBounds(y) };
                  setDraft(next);
                  setApplied(next);
                }}
                className={cn(
                  'h-9 rounded-full px-3 text-xs font-semibold tabular-nums transition',
                  activeYear === y
                    ? 'bg-primary text-primary-foreground shadow-soft'
                    : 'bg-foreground/[0.04] text-muted-foreground hover:bg-foreground/[0.08]',
                )}
              >
                {y}
              </button>
            ))}
          </div>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-muted-foreground">
            {t('complaintDash.from', { defaultValue: 'From' })}
          </span>
          <DateField
            size="md"
            className="w-[9.5rem]"
            value={draft.from}
            onChange={(v) => setDraft((f) => ({ ...f, from: v }))}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-muted-foreground">
            {t('complaintDash.to', { defaultValue: 'To' })}
          </span>
          <DateField
            size="md"
            className="w-[9.5rem]"
            value={draft.to}
            onChange={(v) => setDraft((f) => ({ ...f, to: v }))}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-muted-foreground">
            {t('complaintDash.brand', { defaultValue: 'Brand' })}
          </span>
          <SelectMenu
            size="sm"
            searchable
            value={draft.brand}
            onChange={(v) => pick({ brand: v })}
            aria-label={t('complaintDash.brand', { defaultValue: 'Brand' })}
            options={[
              { value: '', label: t('complaintDash.allBrands', { defaultValue: 'All brands' }) },
              ...(d?.brandOptions ?? []).map((b) => ({ value: b.id, label: b.name })),
            ]}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-muted-foreground">
            {t('complaintDash.area', { defaultValue: 'Area' })}
          </span>
          <SelectMenu
            size="sm"
            searchable
            value={draft.area}
            onChange={(v) => pick({ area: v })}
            aria-label={t('complaintDash.area', { defaultValue: 'Area' })}
            options={[
              { value: '', label: t('complaintDash.allAreas', { defaultValue: 'All areas' }) },
              ...(d?.areaOptions ?? []).map((a) => ({ value: a, label: a })),
            ]}
          />
        </label>
        {/* Chain sits beside Area because it is the level ABOVE it — a chain
            spans several areas, so "everything under this chain manager" is a
            question Area cannot answer by itself. */}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-muted-foreground">
            {t('complaintDash.chain', { defaultValue: 'Chain' })}
          </span>
          <SelectMenu
            size="sm"
            searchable
            value={draft.chain}
            onChange={(v) => pick({ chain: v })}
            aria-label={t('complaintDash.chain', { defaultValue: 'Chain' })}
            options={[
              {
                value: '',
                label: t('complaintDash.allChains', { defaultValue: 'All chain managers' }),
              },
              ...(d?.chainOptions ?? []).map((c) => ({ value: c, label: c })),
            ]}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-muted-foreground">
            {t('complaintDash.city', { defaultValue: 'City' })}
          </span>
          <SelectMenu
            size="sm"
            searchable
            value={draft.city}
            onChange={(v) => pick({ city: v })}
            aria-label={t('complaintDash.city', { defaultValue: 'City' })}
            options={[
              { value: '', label: t('complaintDash.allCities', { defaultValue: 'All cities' }) },
              ...(d?.cityOptions ?? []).map((c) => ({ value: c, label: c })),
            ]}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-muted-foreground">
            {t('complaintDash.restaurant', { defaultValue: 'Restaurant' })}
          </span>
          <SelectMenu
            size="sm"
            // The longest list on the bar — 130-odd branches — so it needs the
            // search box most. Names run to "LCP-053 Othaim Mall Khurais Road"
            // and the memorable word is in the MIDDLE, which is why the match
            // is a substring rather than a prefix.
            searchable
            // At the default width they all truncated to the store code.
            className="w-[16rem]"
            value={draft.store}
            onChange={(v) => pick({ store: v })}
            aria-label={t('complaintDash.restaurant', { defaultValue: 'Restaurant' })}
            options={storeChoices}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-muted-foreground">
            {t('complaintDash.agent', { defaultValue: 'Agent' })}
          </span>
          {/*
           * WHOSE TICKETS (owner, 2026-09-16).
           *
           * Every other control on this bar narrows by WHERE the complaint came
           * from. This one narrows by who owns it, which is the question a
           * supervisor arrives with when they are reviewing one person rather
           * than one region — and it composes with the rest, so "this agent, in
           * this city, last month" is one query.
           *
           * "Unassigned" is its own option rather than part of "All agents":
           * work nobody has picked up is a real thing to go looking for, and
           * folding it into the default would hide it behind a word that reads
           * like it includes everything.
           */}
          <SelectMenu
            size="sm"
            searchable
            className="w-[13rem]"
            value={draft.agent}
            onChange={(v) => pick({ agent: v })}
            aria-label={t('complaintDash.agent', { defaultValue: 'Agent' })}
            options={[
              { value: '', label: t('complaintDash.allAgents', { defaultValue: 'All agents' }) },
              {
                value: UNASSIGNED_AGENT,
                label: t('complaintDash.unassigned', { defaultValue: 'Unassigned' }),
              },
              ...(d?.agentOptions ?? []).map((a) => ({ value: a.id, label: a.name })),
            ]}
          />
        </label>
        {/* Vendor (MV-4) — only with 2+ vendors active; applies at once. */}
        <ReportVendorFilter />
        {/* `ms-auto` pins the actions to the END of the filter row rather than
            letting them wrap to a new line at the start. They read as what you
            do TO the filters, so they belong beside them, not under them. */}
        <div className="ms-auto flex items-center gap-2 pb-px">
          {/* Only when something is genuinely waiting — which, now that the
              dropdowns apply themselves, means a half-typed date. A permanently
              disabled Apply beside a table that already reflects the filters
              reads as "this has not taken effect yet", and says so wrongly. */}
          {dirty && (
            <Button type="button" size="sm" onClick={() => setApplied(draft)}>
              {t('complaintDash.apply', { defaultValue: 'Apply' })}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!anyFilter && !dirty}
            onClick={() => {
              // Back to how the page opened — the last 30 days — not to "every
              // ticket ever", which is what an empty filter set fetches.
              setDraft(opening);
              setApplied(opening);
            }}
          >
            {t('complaintDash.clear', { defaultValue: 'Clear' })}
          </Button>
        </div>
      </div>

      {m.isError ? (
        <ErrorState
          title={t('complaintDash.loadError', { defaultValue: 'Could not load the dashboard' })}
          message={t('dashboard.loadErrorHint', {
            defaultValue: 'Check your connection and try again.',
          })}
          retryLabel={t('actions.retry', { ns: 'common', defaultValue: 'Retry' })}
          onRetry={() => void m.refetch()}
        />
      ) : m.isLoading || !d ? (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-40 rounded-2xl" />
            ))}
          </div>
          <Skeleton className="h-64 rounded-2xl" />
          <Skeleton className="h-56 rounded-2xl" />
        </div>
      ) : (
        <>
          {/* Headline, exactly as his subtitle reads. */}
          <p className="px-1 text-xs text-muted-foreground">
            {d.total > 0
              ? t('complaintDash.summary', {
                  // The span is the range the DATA covers, which is not the
                  // range you filtered on — "last 90 days" over three
                  // complaints logged in one week should say so.
                  // No money here any more. It was the ticket-side sum,
                  // which counted refused and un-approved amounts; the KPI tile
                  // carries the approved figure, and one number in one place is
                  // the whole point of removing the other.
                  defaultValue: 'Showing {{n}} tickets from {{from}} to {{to}}',
                  n: d.total.toLocaleString(),
                  from: d.firstDate ?? '—',
                  to: d.lastDate ?? '—',
                })
              : t('complaintDash.noMatch', {
                  defaultValue: 'No tickets match these filters.',
                })}
          </p>

          {/* WHAT THE OPERATIONS STRIP IS NOT.
              Six readings have been proposed here and rejected, and they had
              one thing in common: every one of them COUNTED something — tickets
              in the range, tickets still open, branches with a ticket, the
              busiest branch, tickets with no branch, the share coming from the
              top five branches.

              The objection that killed the first of them is the one that kills
              them all: these rows are complaints, not orders. Nothing here
              records how much business a branch did, so a count cannot be
              turned into a rate, and a branch with more complaints may simply
              be bigger. A count on its own tells an area manager nothing they
              can act on, and the ranked panels below already carry the
              distribution for anyone who wants to read it properly.

              What survives is the reading that names a PROBLEM rather than
              counting a thing: what customers are actually complaining about,
              which is what a branch, area or chain manager goes and fixes. */}
          {view === 'operations' && (
            <div className="grid gap-3 sm:grid-cols-2">
              {/* The thing to go and FIX. Named, because "66" is a number to
                  look up and "66 — Cleanness" is this week's job. */}
              {/* destructive, not primary: this names the thing going WRONG most
                  often, and it should read as a problem. It also has to be
                  told apart from the tile beside it — `primary` (hue 277) and
                  `violet` (285) are eight degrees apart, so the two cards were
                  the same lilac and the row read as one block. */}
              <Kpi
                tone="destructive"
                icon={<ZapIcon size={17} />}
                order={0}
                value={ops.topProblem ? String(ops.topProblem.count) : '—'}
                label={t('complaintDash.opsTopProblem', { defaultValue: 'Most common problem' })}
                sub={
                  ops.topProblem?.label ??
                  String(t('complaintDash.notMeasured', { defaultValue: 'Not measured yet' }))
                }
                onOpen={
                  ops.topProblem
                    ? () =>
                        drillInto(
                          String(t('complaintDash.byType', { defaultValue: 'By ticket type' })),
                          (r) => r.complaintType,
                        )(ops.topProblem!)
                    : undefined
                }
              />
              {/* WHERE IN THE OPERATION it breaks — delivery, dine-in, pickup.
                  Same family as the tile beside it: it names a thing to look
                  at rather than counting tickets or ranking branches, and the
                  answer changes who you talk to on Monday. */}
              <Kpi
                tone="sky"
                icon={<StoreIcon size={17} />}
                order={1}
                value={ops.topService ? String(ops.topService.count) : '—'}
                label={t('complaintDash.opsTopService', {
                  defaultValue: 'Most affected service type',
                })}
                sub={
                  ops.topService?.label ??
                  String(t('complaintDash.notMeasured', { defaultValue: 'Not measured yet' }))
                }
                onOpen={
                  ops.topService
                    ? () =>
                        drillInto(
                          String(
                            t('complaintDash.byServiceType', { defaultValue: 'By service type' }),
                          ),
                          (r) => r.serviceType,
                        )(ops.topService!)
                    : undefined
                }
              />
            </div>
          )}

          {/* The KPI strip is AGENT only. Tickets, chats, compensation and
              coupons are the support desk's numbers; the team around the
              branches asked not to be shown them, and a dashboard that opens
              with six numbers you have no use for is a dashboard people learn
              to scroll past. */}
          {view === 'agent' && (
            <>
              {/* ── KPIs (owner, 2026-10-15: the reference board's tiles) ──
                  One deep-indigo HERO tile, the rest white; a round arrow on
                  each opens the report behind the number; numbers count up.
                  Row one is the TICKET's life, row two the CHATS and what the
                  desk paid out - the same eight readings as before. */}
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <StatCard
                  hero
                  index={0}
                  title={t('complaintDash.kpiTotal', { defaultValue: 'Tickets' })}
                  value={d.total}
                  onOpen={() => navigate('/reports/operational-kpi/tickets')}
                  delta={(() => {
                    // Month-over-month, only when two full-ish months exist.
                    // For a ticket count, DOWN is the good direction.
                    const cur = d.months[d.months.length - 1]?.count;
                    const prev = d.months[d.months.length - 2]?.count;
                    if (cur == null || prev == null || prev === 0) return undefined;
                    const pct = Math.round(((cur - prev) / prev) * 100);
                    if (pct === 0 || Math.abs(pct) > 200) return undefined;
                    return (
                      <TrendPill good={pct < 0} onHero>
                        {pct > 0 ? `▲ ${pct}%` : `▼ ${Math.abs(pct)}%`}{' '}
                        {t('complaintDash.vsLastMonth', { defaultValue: 'vs last month' })}
                      </TrendPill>
                    );
                  })()}
                  sub={
                    d.monthsCovered
                      ? t('complaintDash.months', {
                          defaultValue_one: 'Past month',
                          defaultValue_other: 'Past {{count}} months',
                          count: d.monthsCovered,
                        })
                      : ''
                  }
                />
                <StatCard
                  index={1}
                  title={t('complaintDash.kpiOpen', { defaultValue: 'Open tickets' })}
                  value={d.open}
                  onOpen={() => navigate('/reports/operational-kpi/tickets')}
                  visual={
                    <ProgressRing value={d.total ? (d.open / d.total) * 100 : 0} tone="sky" />
                  }
                  sub={
                    d.total
                      ? t('complaintDash.ofTotal', {
                          defaultValue: '{{p}}% of total',
                          p: Math.round((d.open / d.total) * 100),
                        })
                      : ''
                  }
                />
                <StatCard
                  index={2}
                  title={t('complaintDash.kpiSolved', { defaultValue: 'Solved tickets' })}
                  value={d.closed}
                  onOpen={() => navigate('/reports/operational-kpi/tickets')}
                  visual={
                    <ProgressRing value={d.total ? (d.closed / d.total) * 100 : 0} tone="success" />
                  }
                  sub={
                    d.total
                      ? t('complaintDash.ofTotal', {
                          defaultValue: '{{p}}% of total',
                          p: Math.round((d.closed / d.total) * 100),
                        })
                      : ''
                  }
                />
                <StatCard
                  index={3}
                  title={t('complaintDash.kpiSatisfied', { defaultValue: 'Customer ratings' })}
                  /* The average, not the share: "3.3 / 5" is actionable, "67%"
                     of an invisible denominator is not. */
                  {...(d.avgScore === null
                    ? {
                        display: t('complaintDash.notRatedYet', { defaultValue: 'No ratings yet' }),
                      }
                    : {
                        value: d.avgScore,
                        decimals: 1,
                        unit: t('complaintDash.outOfFive', { defaultValue: '/ 5' }),
                      })}
                  onOpen={() => navigate('/agent-performance')}
                  visual={d.avgScore === null ? undefined : <StarScore score={d.avgScore} />}
                  sub={
                    d.rated
                      ? t('complaintDash.avgBasis', {
                          defaultValue: '{{rated}} ratings · {{pct}}% rated 4 or 5',
                          rated: d.rated,
                          pct: Math.round(d.satisfiedPct ?? 0),
                        })
                      : t('complaintDash.ratedNone', {
                          defaultValue: 'Customers have not rated these yet',
                        })
                  }
                />
                <StatCard
                  index={4}
                  title={t('complaintDash.kpiChatsTotal', { defaultValue: 'Total chats' })}
                  value={d.chatsTotal}
                  onOpen={() => navigate('/reports/agent-kpi/conversations')}
                />
                <StatCard
                  index={5}
                  title={t('complaintDash.kpiChats', { defaultValue: 'Open chats' })}
                  value={d.chatsWaiting}
                  onOpen={() => navigate('/reports/agent-kpi/conversations')}
                  sub={
                    <>
                      <MeterBar
                        value={d.chatsTotal ? (d.chatsWaiting / d.chatsTotal) * 100 : 0}
                        tone="destructive"
                      />
                      <span className="mt-1.5 block">
                        {t('complaintDash.ofChats', {
                          defaultValue: '{{n}} total',
                          n: d.chatsTotal,
                        })}
                      </span>
                    </>
                  }
                />
                {/* What the business gave away is what it APPROVED - the
                    approval queue's own total, shared with CouponSpend. */}
                <StatCard
                  index={6}
                  title={t('complaintDash.kpiCompensationShort', {
                    defaultValue: 'Compensation approved',
                  })}
                  value={Math.round(coupons.sar)}
                  unit={t('common.sar', { defaultValue: 'SAR' })}
                  onOpen={() => navigate('/reports/agent-kpi/compensation')}
                  sub={
                    coupons.count > 0
                      ? t('complaintDash.compensationApproved', {
                          defaultValue: 'across {{n}} approved coupons',
                          n: coupons.count,
                        })
                      : ''
                  }
                />
                <StatCard
                  index={7}
                  title={t('complaintDash.kpiCoupons', { defaultValue: 'Coupons issued' })}
                  value={coupons.count}
                  onOpen={() => navigate('/coupon-approvals')}
                  sub={
                    coupons.pendingCount > 0 ? (
                      <TrendPill good={false}>
                        {t('complaintDash.couponsPending', {
                          defaultValue: '{{n}} awaiting a decision',
                          n: coupons.pendingCount,
                        })}
                      </TrendPill>
                    ) : (
                      ''
                    )
                  }
                />
              </div>
            </>
          )}

          {/* Say what the satisfaction number is actually over. A percentage
              whose denominator is invisible is the easiest number to misread. */}
          {view === 'agent' && d.chatsTotal > d.rated && (
            <p className="px-1 text-2xs leading-relaxed text-muted-foreground">
              {t('complaintDash.satBasis', {
                defaultValue:
                  'Satisfaction is the customer’s own CSAT rating at the end of a chat, so it covers {{rated}} of {{chats}} chats — the rest were never rated.',
                rated: d.rated,
                chats: d.chatsTotal,
              })}
            </p>
          )}

          {/* What compensation is costing, for the roles allowed to see it.
              Sits above the ops snapshot because it is the one number on this
              page with money attached. */}
          {/* Money and reach side by side, each in its own soft hue (owner,
              2026-10-15). Either card renders nothing for a role without it,
              and the other then takes the row. */}
          {view === 'agent' && (
            <div className="grid gap-4 lg:grid-cols-3 lg:[&>*:only-child]:col-span-3">
              <CouponSpend from={applied.from} to={applied.to} className="lg:col-span-2" />
              <CustomerReach />
            </div>
          )}

          {/* The Ops snapshot band is gone — every chip on it repeated a number
              from the KPI strip directly above it. */}

          {/* ── Bento (owner, 2026-10-15) ─────────────────────────────────
              What customers complain about, as pill columns, beside how much
              of the range is solved - then WHEN the desk is busy. Same
              records and the same drill as before. */}
          {view === 'agent' && (
            <div className="grid gap-4 lg:grid-cols-3">
              <BentoCard
                index={8}
                className="lg:col-span-2"
                title={t('complaintDash.byType', { defaultValue: 'By ticket type' })}
                hint={t('complaintDash.byTypeHint', {
                  defaultValue: 'What customers are actually complaining about, biggest first.',
                })}
                action={
                  d.byType.distinct > 8 ? (
                    <span className="rounded-full bg-secondary px-2.5 py-1 text-2xs font-medium text-muted-foreground">
                      {t('complaintDash.topOf', {
                        defaultValue: 'top {{n}} of {{m}}',
                        n: 8,
                        m: d.byType.distinct,
                      })}
                    </span>
                  ) : undefined
                }
              >
                <PillColumns
                  rows={d.byType.rows}
                  emptyLabel={
                    <CardEmpty
                      label={t('complaintDash.nothingInRange', {
                        defaultValue: 'Nothing in this range.',
                      })}
                    />
                  }
                  onSelect={(row) =>
                    drillInto(
                      t('complaintDash.byType', { defaultValue: 'By ticket type' }),
                      (r) => r.complaintType,
                    )?.(row as Breakdown)
                  }
                />
              </BentoCard>
              <BentoCard
                index={9}
                title={t('complaintDash.progress', { defaultValue: 'Ticket progress' })}
                hint={t('complaintDash.progressHint', {
                  defaultValue: 'Solved and still open, in the selected range.',
                })}
              >
                <Gauge
                  centerLabel={t('complaintDash.progressSolved', { defaultValue: 'solved' })}
                  segments={[
                    {
                      label: t('complaintDash.legendSolved', { defaultValue: 'Solved' }),
                      value: d.closed,
                      tone: 'hero',
                    },
                    {
                      label: t('complaintDash.legendOpen', { defaultValue: 'Open' }),
                      value: d.open,
                      tone: 'primary',
                    },
                  ]}
                />
              </BentoCard>
              <BentoCard
                index={10}
                className="lg:col-span-3"
                title={t('complaintDash.heatmap', { defaultValue: 'Weekly activity' })}
                hint={t('complaintDash.heatmapHint', {
                  defaultValue: 'Last six weeks. A darker cell is a busier day.',
                })}
              >
                <Heatmap rows={d.rows ?? []} locale={i18n?.language ?? 'en'} />
              </BentoCard>
            </div>
          )}

          {/* "Agent performance", "Agent performance — chat" and "Chat
              responsiveness" used to sit here.

              They are AGENT numbers on a BRANCH dashboard, and by the time the
              Agent dashboard arrived beside this one they were the FOURTH place
              to read them — the Agent performance page and the Agent summary
              report answer the same question with the same arithmetic. Four
              copies of a number is three chances for them to disagree, and this
              page's job is branches. */}

          {/* ── Breakdowns ───────────────────────────────────────────────── */}
          <div className="grid gap-4 md:grid-cols-2">
            {/* Leads the grid, as it does on his page. Not the same cut as "By
                agent": that ranks who logged the most, this ranks who is still
                holding unfinished work — a heavy logger with nothing
                outstanding is the opposite of a problem. */}
            {view === 'agent' && (
              <CutCard
                title={t('complaintDash.unsolvedByAgent', {
                  defaultValue: 'Unsolved tickets by agent',
                })}
                hint={
                  d.byOpenAgent.rows.length > 0
                    ? t('complaintDash.unsolvedHint', {
                        defaultValue: '{{n}} still open across the filtered range.',
                        n: d.open,
                      })
                    : undefined
                }
                className="md:col-span-2"
                index={11}
                tone="rose"
                icon={<ClockIcon size={17} />}
                initials
                cut={d.byOpenAgent}
                // Shares are OF THE OPEN PILE, not of every complaint: "40% of
                // what is still open" is the question being asked here.
                total={d.open}
                emptyLabel={t('complaintDash.nothingOutstanding', {
                  defaultValue: 'Nothing outstanding — every ticket in this range is closed.',
                })}
                onSelect={drillInto(
                  t('complaintDash.unsolvedByAgent', {
                    defaultValue: 'Unsolved tickets by agent',
                  }),
                  (r) => r.agentId,
                  // His click lands on the UNSOLVED ones only, not everything
                  // that agent has ever logged.
                  (r) => r.isOpen,
                )}
              />
            )}
            {view === 'operations' && (
              <CutCard
                title={t('complaintDash.topRestaurants', { defaultValue: 'Top restaurants' })}
                hint={
                  d.unattributed > 0
                    ? t('complaintDash.unattributed', {
                        defaultValue:
                          '{{n}} ticket(s) have no branch recorded and are missing from this cut.',
                        n: d.unattributed,
                      })
                    : undefined
                }
                cut={d.byRestaurant}
                total={d.total}
                tone="indigo"
                icon={<StoreIcon size={17} />}
                index={12}
                onSelect={drillInto(
                  t('complaintDash.topRestaurants', { defaultValue: 'Top restaurants' }),
                  (r) => r.restaurantName,
                )}
              />
            )}
            {view === 'operations' && (
              <CutCard
                title={t('complaintDash.byBrand', { defaultValue: 'By brand' })}
                cut={d.byBrand}
                total={d.total}
                // Magenta, not warning: `--warning` is a light token whose bars
                // wash out on the light theme.
                tone="rose"
                icon={<SparkleIcon size={17} />}
                index={13}
                onSelect={drillInto(
                  t('complaintDash.byBrand', { defaultValue: 'By brand' }),
                  (r) => r.brandName,
                )}
              />
            )}
            {view === 'operations' && (
              <CutCard
                /* "By area" for a column that has always held a PERSON. The
                   hint underneath said "the area manager responsible for the
                   branch" while the title said area, so the one thing an
                   operations reader wants — who do I talk to — was the one
                   thing the heading hid. */
                title={t('complaintDash.byArea', { defaultValue: 'By area manager' })}
                hint={t('complaintDash.byAreaHint', {
                  defaultValue: 'Who is responsible for the branch the ticket came from.',
                })}
                cut={d.byArea}
                total={d.total}
                tone="violet"
                icon={<UsersIcon size={17} />}
                index={14}
                onSelect={drillInto(
                  t('complaintDash.byArea', { defaultValue: 'By area manager' }),
                  (r) => r.area,
                )}
              />
            )}
            {view === 'operations' && (
              <CutCard
                /* The line above the area manager. An area manager fixes a
                   branch; a chain manager is who you go to when the same thing
                   is happening across several areas. */
                title={t('complaintDash.byChain', { defaultValue: 'By chain manager' })}
                hint={t('complaintDash.byChainHint', {
                  defaultValue: 'The manager above the area — for problems that span areas.',
                })}
                cut={d.byChain}
                total={d.total}
                /* A THEME TOKEN, never a Tailwind shade (owner, 2026-10-12: the
                   bars were blank). The preset replaces the `violet` family with
                   one token, so `bg-violet-500` generated no CSS at all. Green,
                   not violet: violet is the hue of the area-manager bars beside it. */
                tone="mint"
                icon={<TeamIcon size={17} />}
                index={15}
                onSelect={drillInto(
                  t('complaintDash.byChain', { defaultValue: 'By chain manager' }),
                  (r) => r.chain,
                )}
              />
            )}
            {view === 'operations' && (
              <CutCard
                title={t('complaintDash.byCity', { defaultValue: 'By city' })}
                cut={d.byCity}
                total={d.total}
                tone="sky"
                icon={<ChartIcon size={17} />}
                index={16}
                onSelect={drillInto(
                  t('complaintDash.byCity', { defaultValue: 'By city' }),
                  (r) => r.city,
                )}
              />
            )}
            {view === 'agent' && (
              <CutCard
                title={t('complaintDash.byAgent', { defaultValue: 'By agent' })}
                cut={d.byAgent}
                total={d.total}
                tone="violet"
                icon={<UsersIcon size={17} />}
                initials
                index={12}
                onSelect={drillInto(
                  t('complaintDash.byAgent', { defaultValue: 'By agent' }),
                  (r) => r.agentId,
                )}
              />
            )}
            {view === 'agent' && (
              <CutCard
                title={t('complaintDash.byStatus', { defaultValue: 'By status' })}
                cut={{
                  ...d.byStatus,
                  rows: d.byStatus.rows.map((r) => ({
                    ...r,
                    label: t(`status.${r.key}`, { ns: 'common', defaultValue: r.key }),
                  })),
                }}
                total={d.total}
                tone="mint"
                icon={<CheckCircleIcon size={17} />}
                index={13}
                onSelect={drillInto(
                  t('complaintDash.byStatus', { defaultValue: 'By status' }),
                  (r) => r.status,
                )}
              />
            )}
            {view === 'agent' && (
              <CutCard
                title={t('complaintDash.byServiceType', { defaultValue: 'By service type' })}
                cut={d.byServiceType}
                total={d.total}
                tone="amber"
                icon={<ZapIcon size={17} />}
                index={14}
                onSelect={drillInto(
                  t('complaintDash.byServiceType', { defaultValue: 'By service type' }),
                  (r) => r.serviceType,
                )}
              />
            )}
            {/* Retitled off his wording deliberately: he uses "Where complaints
                come from" for the BRAND ring above. Two cards under one title
                showing different things is worse than losing his phrasing. */}
            {view === 'agent' && (
              <CutCard
                title={t('complaintDash.bySource', { defaultValue: 'How tickets reach us' })}
                /* Beside "By service type", not on a full-width row of its own.
                   The col-span made it the one card that broke the two-column
                   rhythm, and it earned that width by having the most rows —
                   which is a reason to let it scroll, not a reason to give it
                   the whole page and leave the card above it half empty. */
                cut={d.bySource}
                total={d.total}
                tone="teal"
                icon={<InboxIcon size={17} />}
                index={15}
                onSelect={drillInto(
                  t('complaintDash.bySource', { defaultValue: 'How tickets reach us' }),
                  (r) => r.source,
                )}
              />
            )}
          </div>
        </>
      )}

      {drill && <DrillDown title={drill.title} rows={drill.rows} onClose={() => setDrill(null)} />}
    </div>
  );
}
