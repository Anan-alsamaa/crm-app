import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  ChartIcon,
  CheckCircleIcon,
  cn,
  DateField,
  DeltaBadge,
  Drawer,
  ErrorState,
  InboxIcon,
  MeterBar,
  ProgressRing,
  SectionCard,
  SelectMenu,
  Skeleton,
  SparkleIcon,
  StoreIcon,
  TicketIcon,
  UsersIcon,
  ZapIcon,
} from '@yiji/ui';
import {
  emptyComplaintFilters,
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
} as const;

/* The card surface carries the hue — see StatCard for the reasoning. */
const KPI_SURFACES = {
  neutral: 'bg-gradient-to-br from-secondary/60 to-card ring-foreground/[0.06]',
  sky: 'bg-gradient-to-br from-sky-tint/70 to-card ring-sky/15',
  violet: 'bg-gradient-to-br from-violet-tint/70 to-card ring-violet/15',
  success: 'bg-gradient-to-br from-success-tint/70 to-card ring-success/15',
  primary: 'bg-gradient-to-br from-primary-tint/70 to-card ring-primary/15',
  destructive: 'bg-gradient-to-br from-destructive-tint/70 to-card ring-destructive/15',
} as const;

/* The numeral is the one place a hue is written as a literal instead of a
 * token. `--sky` and `--success` are tuned to fill a chip, and at that
 * lightness a 44px numeral on white misses 4.5:1 — so these are the same
 * hues darkened until they pass. Keep the HUE in step with the token when
 * the brand moves; only the lightness is meant to differ. */
const KPI_NUMERALS = {
  neutral: 'text-foreground',
  sky: 'text-[oklch(0.48_0.16_264)]',
  violet: 'text-[oklch(0.48_0.19_285)]',
  success: 'text-[oklch(0.45_0.13_155)]',
  primary: 'text-primary',
  destructive: 'text-destructive',
} as const;

function Kpi({
  value,
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
        'group flex flex-col rounded-2xl p-5 shadow-soft ring-1',
        KPI_SURFACES[tone],
        'motion-safe:animate-rise-in',
        'transition-[box-shadow,transform,border-color] duration-base ease-out',
        'hover:shadow-float hover:ring-foreground/[0.12] motion-safe:hover:-translate-y-1',
        onOpen &&
          'w-full cursor-pointer text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
      )}
    >
      {/* Label above the numeral and the icon chip at the END — the reference
          card's anatomy, which gives the number the whole width instead of
          squeezing it beside a chip. */}
      <div className="flex items-start justify-between gap-3">
        <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          {label}
        </span>
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
 * His bar breakdown: label, proportional track, then "count · share". The share
 * is what makes the list readable — 40 complaints means nothing until you know
 * it is a third of everything.
 */
function Bars({
  rows,
  total,
  color,
  onSelect,
}: {
  rows: Breakdown[];
  total: number;
  color: string;
  /** Given, each row becomes a button that opens the complaints behind it. */
  onSelect?: (row: Breakdown) => void;
}) {
  const { t } = useTranslation();
  const max = Math.max(1, ...rows.map((r) => r.count));
  if (rows.length === 0)
    return (
      <CardEmpty
        label={t('complaintDash.nothingInRange', { defaultValue: 'Nothing in this range.' })}
      />
    );
  return (
    <ul className="space-y-2">
      {rows.map((r, idx) => {
        const body = (
          <>
            <span
              className="w-28 shrink-0 truncate text-start text-xs text-foreground"
              title={r.label}
            >
              {r.label}
            </span>
            {/* Hairline track, same as the shared MeterBar — the tone fill is
                what reads, not the rail. */}
            <span className="h-2 flex-1 overflow-hidden rounded-full bg-foreground/[0.08]">
              <span
                className={cn(
                  'block h-full origin-left rounded-full rtl:origin-right',
                  'transition-[width] duration-slow ease-out motion-safe:animate-grow-x',
                  color,
                )}
                style={{
                  width: `${Math.max(2, (r.count / max) * 100)}%`,
                  animationDelay: `${Math.min(idx, 10) * 45}ms`,
                }}
              />
            </span>
            <span className="w-20 shrink-0 text-end text-2xs tabular-nums text-muted-foreground">
              <strong className="font-semibold text-foreground">{r.count}</strong>
              {total > 0 && ` · ${Math.round((r.count / total) * 100)}%`}
            </span>
          </>
        );
        return (
          <li key={r.key}>
            {onSelect ? (
              <button
                type="button"
                onClick={() => onSelect(r)}
                title={t('complaintDash.drillHint', { defaultValue: 'Show these tickets' })}
                className="flex w-full items-center gap-3 rounded-lg px-1 py-0.5 -mx-1 transition-colors duration-fast hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                {body}
              </button>
            ) : (
              <span className="flex items-center gap-3">{body}</span>
            )}
          </li>
        );
      })}
    </ul>
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
                className="h-6 flex-1 rounded-md ring-1 ring-inset ring-foreground/[0.04] transition-transform duration-fast ease-out hover:scale-[1.06] motion-safe:animate-fade-in"
                style={{
                  backgroundColor: `oklch(var(--primary) / ${
                    c.count === 0 ? 0.05 : 0.15 + 0.75 * (c.count / max)
                  })`,
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

/**
 * Vertical column chart — the reference dashboard's signature panel (its
 * "by department" bars): one rounded, gradient column per category, its hue
 * rotating through the palette so the row reads as a set rather than as one
 * colour repeated.
 *
 * Columns are buttons when a drill is available: the same records the ranked
 * list opens, reached from the shape instead of the row.
 */
const COLUMN_TONES = [
  'from-sky/50 to-sky',
  'from-violet/50 to-violet',
  'from-primary/50 to-primary',
  'from-success/50 to-success',
  'from-magenta/50 to-magenta',
  'from-destructive/50 to-destructive',
] as const;

function Columns({
  rows,
  onSelect,
  emptyLabel,
}: {
  rows: Breakdown[];
  onSelect?: (row: Breakdown) => void;
  emptyLabel: string;
}) {
  const top = rows.slice(0, 8);
  const max = Math.max(1, ...top.map((r) => r.count));
  if (top.length === 0) return <CardEmpty label={emptyLabel} />;
  return (
    <div className="flex h-56 items-end gap-3 sm:gap-4">
      {top.map((r, i) => {
        const pct = Math.max(4, (r.count / max) * 100);
        const body = (
          <>
            <span className="mb-2 text-sm font-bold tabular-nums text-foreground">{r.count}</span>
            <span
              className={cn(
                'mx-auto w-full max-w-[72px] origin-bottom rounded-t-xl bg-gradient-to-t motion-safe:animate-grow-y',
                COLUMN_TONES[i % COLUMN_TONES.length],
              )}
              style={{ height: `${pct}%`, animationDelay: `${i * 70}ms` }}
            />
          </>
        );
        return (
          <div key={r.key} className="flex h-full min-w-0 flex-1 flex-col">
            {onSelect ? (
              <button
                type="button"
                onClick={() => onSelect(r)}
                aria-label={`${r.label} — ${r.count}`}
                className="flex h-full w-full flex-col justify-end rounded-lg transition-opacity duration-fast hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                {body}
              </button>
            ) : (
              <span className="flex h-full w-full flex-col justify-end">{body}</span>
            )}
            <span
              title={r.label}
              className="mt-2 block truncate text-center text-2xs text-muted-foreground"
            >
              {r.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

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
  color,
  className,
  onSelect,
}: {
  title: string;
  hint?: string;
  cut: Cut;
  total: number;
  color: string;
  className?: string;
  onSelect?: (row: Breakdown) => void;
}) {
  const { t } = useTranslation();
  const hidden = cut.distinct > cut.rows.length;
  return (
    <SectionCard
      title={title}
      hint={hint}
      className={className}
      aside={
        hidden
          ? t('complaintDash.topNofM', {
              defaultValue: 'top {{n}} of {{m}}',
              n: cut.rows.length,
              m: cut.distinct,
            })
          : undefined
      }
    >
      <Bars rows={cut.rows} total={total} color={color} onSelect={onSelect} />
    </SectionCard>
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
export function ComplaintDashboard({ view = 'agent' }: { view?: 'agent' | 'operations' } = {}) {
  const { t, i18n } = useTranslation();
  // Draft vs applied: his bar only re-runs the dashboard on Apply, which matters
  // when a filter change means refetching every ticket.
  const [draft, setDraft] = useState<ComplaintFilters>(emptyComplaintFilters);
  const [applied, setApplied] = useState<ComplaintFilters>(emptyComplaintFilters);
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
   * Coupons, for the strip. Shares CouponSpend's query key, so the tile and the
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
    if (!stillListed) setDraft((f) => ({ ...f, store: '' }));
  }, [draft.brand, draft.store, storeChoices]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(applied);
  const anyFilter = Object.values(applied).some(Boolean);

  // The two footer-total memos that lived here went with the agent tables
  // they summed — see the note further down.

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      {/* ── Filter bar ─────────────────────────────────────────────────
          Same surface as every SectionCard on the page; the fields inside
          carry the shared Input/SelectMenu styling on their own. */}
      <div className="flex flex-wrap items-end gap-x-3 gap-y-3 rounded-2xl bg-card p-4 shadow-soft ring-1 ring-foreground/[0.06]">
        {/* Year first, because it is the filter people actually reach for.
            Typing two dates to see "last year" is four interactions for a
            question asked constantly; this is one. The list comes from the
            data, so a second year of history adds its own button and nothing
            here needs changing when it does. It APPLIES immediately rather
            than filling the draft — a year is a whole answer, not the start of
            one, and the dates below stay in step so the two never disagree. */}
        <div className="flex flex-col gap-1">
          <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
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
          <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
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
          <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
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
          <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {t('complaintDash.brand', { defaultValue: 'Brand' })}
          </span>
          <SelectMenu
            size="sm"
            value={draft.brand}
            onChange={(v) => setDraft((f) => ({ ...f, brand: v }))}
            aria-label={t('complaintDash.brand', { defaultValue: 'Brand' })}
            options={[
              { value: '', label: t('complaintDash.allBrands', { defaultValue: 'All brands' }) },
              ...(d?.brandOptions ?? []).map((b) => ({ value: b.id, label: b.name })),
            ]}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {t('complaintDash.area', { defaultValue: 'Area' })}
          </span>
          <SelectMenu
            size="sm"
            value={draft.area}
            onChange={(v) => setDraft((f) => ({ ...f, area: v }))}
            aria-label={t('complaintDash.area', { defaultValue: 'Area' })}
            options={[
              { value: '', label: t('complaintDash.allAreas', { defaultValue: 'All areas' }) },
              ...(d?.areaOptions ?? []).map((a) => ({ value: a, label: a })),
            ]}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {t('complaintDash.city', { defaultValue: 'City' })}
          </span>
          <SelectMenu
            size="sm"
            value={draft.city}
            onChange={(v) => setDraft((f) => ({ ...f, city: v }))}
            aria-label={t('complaintDash.city', { defaultValue: 'City' })}
            options={[
              { value: '', label: t('complaintDash.allCities', { defaultValue: 'All cities' }) },
              ...(d?.cityOptions ?? []).map((c) => ({ value: c, label: c })),
            ]}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {t('complaintDash.restaurant', { defaultValue: 'Restaurant' })}
          </span>
          <SelectMenu
            size="sm"
            // Branch names run to "LCP-053 Othaim Mall Khurais Road"; at the
            // default width they all truncated to the store code.
            className="w-[16rem]"
            value={draft.store}
            onChange={(v) => setDraft((f) => ({ ...f, store: v }))}
            aria-label={t('complaintDash.restaurant', { defaultValue: 'Restaurant' })}
            options={storeChoices}
          />
        </label>
        {/* `ms-auto` pins the actions to the END of the filter row rather than
            letting them wrap to a new line at the start. They read as what you
            do TO the filters, so they belong beside them, not under them. */}
        <div className="ms-auto flex items-center gap-2 pb-px">
          <Button type="button" size="sm" disabled={!dirty} onClick={() => setApplied(draft)}>
            {t('complaintDash.apply', { defaultValue: 'Apply' })}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!anyFilter && !dirty}
            onClick={() => {
              setDraft(emptyComplaintFilters);
              setApplied(emptyComplaintFilters);
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
            <div className="grid gap-3 sm:grid-cols-3">
              {/* The thing to go and FIX. Named, because "66" is a number to
                  look up and "66 — Cleanness" is this week's job. */}
              <Kpi
                tone="primary"
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
                tone="violet"
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
              {/* WHOSE ESTATE, and how much of it.
                  Branches, not tickets — deliberately. Nothing in this data
                  records how much business a branch did, so a ticket count says
                  a big branch is worse than a small one, which is the objection
                  that retired every count this strip used to carry. "11 of 18
                  branches" survives it: spread is a statement an area manager
                  can act on, and it names the person to act. */}
              <Kpi
                tone="sky"
                icon={<UsersIcon size={17} />}
                order={2}
                /* "3 of 18" only when the estate is genuinely known. A manager
                   whose name is not in the branch master has no estate to
                   divide by, and "22/—" reads as a broken number rather than a
                   missing one. */
                value={
                  d.widestArea
                    ? d.widestArea.estate > 0
                      ? `${d.widestArea.branches}/${d.widestArea.estate}`
                      : String(d.widestArea.branches)
                    : '—'
                }
                label={t('complaintDash.opsWidestArea', {
                  defaultValue: 'Area manager most affected',
                })}
                sub={
                  d.widestArea
                    ? d.widestArea.estate > 0
                      ? `${d.widestArea.manager} · ${t('complaintDash.opsOfBranches', {
                          count: d.widestArea.estate,
                          defaultValue: 'of {{count}} branches',
                        })}`
                      : d.widestArea.manager
                    : String(t('complaintDash.notMeasured', { defaultValue: 'Not measured yet' }))
                }
                onOpen={(() => {
                  // Narrowed once, outside the callback: the drill needs a
                  // Breakdown, and `key` is what the filter matches on.
                  const w = d.widestArea;
                  if (!w) return undefined;
                  return () =>
                    drillInto(
                      String(t('complaintDash.byArea', { defaultValue: 'By area manager' })),
                      (r) => r.area,
                    )({ key: w.manager, label: w.manager, count: w.branches });
                })()}
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
              {/* ── KPIs ─────────────────────────────────────────────────────
              The share-of-a-whole cards carry the boards' data accents: a ring
              beside the two percentages, a thin meter under the two counts
              that are really fractions of a known total. Tones match the icon
              chip so the accent reads as the same signal, louder. */}
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {/* SEQUENCED, not just listed.
                    The seven tiles ran total, open, ratings, compensation,
                    open chats, total chats, coupons — three across, so the
                    last sat alone on a row of its own and the two chat numbers
                    were split by a row break with a money figure wedged
                    between them.
                    Eight now, four across: two clean rows, each one subject.
                    The TICKET's life on top — raised, still open, solved, and
                    what the customer made of it — and below it the CHATS and
                    what the desk paid out to settle things. */}
                <Kpi
                  tone="neutral"
                  icon={<TicketIcon size={17} />}
                  order={0}
                  value={d.total.toLocaleString()}
                  label={t('complaintDash.kpiTotal', { defaultValue: 'Tickets' })}
                  sub={
                    d.monthsCovered
                      ? t('complaintDash.months', {
                          defaultValue_one: 'Past month',
                          defaultValue_other: 'Past {{count}} months',
                          count: d.monthsCovered,
                        })
                      : ''
                  }
                  delta={(() => {
                    // Month-over-month, only when two full-ish months exist. For a
                    // ticket count, DOWN is the good direction.
                    const cur = d.months[d.months.length - 1]?.count;
                    const prev = d.months[d.months.length - 2]?.count;
                    if (cur == null || prev == null || prev === 0) return undefined;
                    const pct = Math.round(((cur - prev) / prev) * 100);
                    // A partial month against a full one produces four-digit
                    // swings that read as noise, not signal — show nothing.
                    if (pct === 0 || Math.abs(pct) > 200) return undefined;
                    return (
                      <DeltaBadge direction={pct > 0 ? 'up' : 'down'} positiveIsGood={false}>
                        {pct > 0 ? `+${pct}%` : `${pct}%`}
                      </DeltaBadge>
                    );
                  })()}
                />
                <Kpi
                  tone="sky"
                  icon={<InboxIcon size={17} />}
                  order={1}
                  value={String(d.open)}
                  label={t('complaintDash.kpiOpen', { defaultValue: 'Open tickets' })}
                  sub={
                    d.total
                      ? t('complaintDash.ofTotal', {
                          defaultValue: '{{p}}% of total',
                          p: Math.round((d.open / d.total) * 100),
                        })
                      : ''
                  }
                  visual={
                    <ProgressRing value={d.total ? (d.open / d.total) * 100 : 0} tone="sky" />
                  }
                />
                {/* No "Overdue" tile: an overdue ticket is an OPEN ticket, so it
                    was the same work counted twice, one card apart.
                    SOLVED is the other half of Open, and it was the number
                    missing from the row — "121 raised, 6 open" leaves the
                    reader to do the subtraction and hope nothing else happened
                    to the other 115. */}
                <Kpi
                  tone="success"
                  icon={<CheckCircleIcon size={17} />}
                  order={2}
                  value={String(d.closed)}
                  label={t('complaintDash.kpiSolved', { defaultValue: 'Solved tickets' })}
                  sub={
                    d.total
                      ? t('complaintDash.ofTotal', {
                          defaultValue: '{{p}}% of total',
                          p: Math.round((d.closed / d.total) * 100),
                        })
                      : ''
                  }
                  visual={
                    <ProgressRing value={d.total ? (d.closed / d.total) * 100 : 0} tone="success" />
                  }
                />
                <Kpi
                  tone="success"
                  icon={<SparkleIcon size={17} />}
                  order={3}
                  value={
                    d.satisfiedPct === null
                      ? t('complaintDash.notRatedYet', { defaultValue: 'No ratings yet' })
                      : `${Math.round(d.satisfiedPct)}%`
                  }
                  label={t('complaintDash.kpiSatisfied', { defaultValue: 'Customer ratings' })}
                  sub={
                    d.rated
                      ? t('complaintDash.ratedOf', {
                          defaultValue: '{{sat}} of {{rated}} rated',
                          sat: d.satisfied,
                          rated: d.rated,
                        })
                      : t('complaintDash.ratedNone', {
                          defaultValue: 'Customers have not rated these yet',
                        })
                  }
                  visual={
                    d.satisfiedPct === null ? undefined : (
                      <ProgressRing value={d.satisfiedPct} tone="success" />
                    )
                  }
                />
                {/* Row two: the CHATS, and what the desk paid out. The two chat
                    numbers sit side by side — one is the denominator of the
                    other, and a row break between them made that invisible. */}
                <Kpi
                  tone="primary"
                  icon={<InboxIcon size={17} />}
                  order={4}
                  value={String(d.chatsTotal)}
                  label={t('complaintDash.kpiChatsTotal', { defaultValue: 'Total chats' })}
                />
                <Kpi
                  tone="destructive"
                  icon={<UsersIcon size={17} />}
                  order={5}
                  value={String(d.chatsWaiting)}
                  label={t('complaintDash.kpiChats', { defaultValue: 'Open chats' })}
                  sub={t('complaintDash.ofChats', {
                    defaultValue: '{{n}} total',
                    n: d.chatsTotal,
                  })}
                  meter={
                    <MeterBar
                      value={d.chatsTotal ? (d.chatsWaiting / d.chatsTotal) * 100 : 0}
                      tone="destructive"
                    />
                  }
                />
                {/* THE MONEY IS WHAT WAS APPROVED.
                    This used to total `tickets.coupon_value` — every riyal ever
                    typed into that column, including amounts on coupons that
                    were refused, amounts still awaiting a decision, and amounts
                    nobody ever raised an approval for. It read 779 against the
                    254 actually approved, which is not a number anybody can use
                    and was two figures on one dashboard that looked like they
                    should agree.
                    What the business gave away is what it APPROVED, so this is
                    the approval queue's own total. It shares CouponSpend's
                    query key with the card below, so the tile and the card are
                    one request and cannot disagree. */}
                <Kpi
                  tone="primary"
                  icon={<ChartIcon size={17} />}
                  order={6}
                  value={coupons.sar.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  label={t('complaintDash.kpiCompensation', {
                    defaultValue: 'Compensation approved (SAR)',
                  })}
                  sub={
                    coupons.count > 0
                      ? t('complaintDash.compensationApproved', {
                          defaultValue: 'across {{n}} approved coupons',
                          n: coupons.count,
                        })
                      : ''
                  }
                />
                <Kpi
                  tone="violet"
                  icon={<SparkleIcon size={17} />}
                  order={7}
                  value={String(coupons.count)}
                  label={t('complaintDash.kpiCoupons', { defaultValue: 'Coupons issued' })}
                  sub={
                    coupons.pendingCount > 0
                      ? t('complaintDash.couponsPending', {
                          defaultValue: '{{n}} awaiting a decision',
                          n: coupons.pendingCount,
                        })
                      : ''
                  }
                />
              </div>
            </>
          )}

          {/* Say what the satisfaction number is actually over. A percentage
              whose denominator is invisible is the easiest number to misread. */}
          {view === 'agent' && d.closed > d.rated && (
            <p className="px-1 text-2xs leading-relaxed text-muted-foreground">
              {t('complaintDash.satBasis', {
                defaultValue:
                  'Satisfaction is the customer’s own CSAT rating on the linked chat, so it covers {{rated}} of {{closed}} closed tickets — the rest were never rated (or were not raised from a chat).',
                rated: d.rated,
                closed: d.closed,
              })}
            </p>
          )}

          {/* What compensation is costing, for the roles allowed to see it.
              Sits above the ops snapshot because it is the one number on this
              page with money attached. */}
          {view === 'agent' && <CouponSpend from={applied.from} to={applied.to} />}

          {/* How much of the customer base the app actually reaches —
              the difference between a lookup that resolves itself and one
              an agent has to do by hand. */}
          {view === 'agent' && <CustomerReach />}

          {/* The Ops snapshot band is gone — every chip on it repeated a number
              from the KPI strip directly above it. */}

          {/* ── Complaints by type ───────────────────────────────────────
              The reference board's column panel. It replaces the ranked
              "By complaint type" list further down — same records, same
              drill, read as a shape instead of a table. */}
          {view === 'agent' && (
            <SectionCard
              title={t('complaintDash.byType', { defaultValue: 'By ticket type' })}
              hint={t('complaintDash.byTypeHint', {
                defaultValue: 'What customers are actually complaining about, biggest first.',
              })}
              aside={
                d.byType.distinct > 8
                  ? t('complaintDash.topOf', {
                      defaultValue: 'top {{n}} of {{m}}',
                      n: 8,
                      m: d.byType.distinct,
                    })
                  : undefined
              }
            >
              <Columns
                rows={d.byType.rows}
                emptyLabel={t('complaintDash.nothingInRange', {
                  defaultValue: 'Nothing in this range.',
                })}
                onSelect={drillInto(
                  t('complaintDash.byType', { defaultValue: 'By ticket type' }),
                  (r) => r.complaintType,
                )}
              />
            </SectionCard>
          )}

          {/* ── The two rings ────────────────────────────────────────────
              Same numbers as the By-status and By-brand bars further down, read
              a different way: the bars rank, these show the split. He keeps
              both, and on a page people scan rather than study, that is the
              point rather than a duplication. */}
          {/* "Where tickets come from" is gone. It was a doughnut of the brand
              split, and the "By brand" panel directly below it ranks the same
              numbers with the counts written on. A ring you have to compare
              arc lengths in, sitting above a table of the same figures, is the
              same answer twice — and the slower of the two. */}

          {/* ── Trend ────────────────────────────────────────────────────── */}
          {/* "Complaints per month" is gone: two readings on one chart, each
              with its own scale, is a picture you have to be told how to read. */}

          {/* The funnel is gone: logged -> closed -> rated -> satisfied is the
              KPI strip again, drawn as four bars. Weekly activity stays on the
              AGENT view — WHEN the desk is busy is a staffing question, and the
              team around the branches has no use for it. */}
          {view === 'agent' && (
            <SectionCard
              title={t('complaintDash.heatmap', { defaultValue: 'Weekly activity' })}
              hint={t('complaintDash.heatmapHint', {
                defaultValue: 'Last six weeks — a darker cell is a busier day.',
              })}
            >
              <Heatmap rows={d.rows ?? []} locale={i18n?.language ?? 'en'} />
            </SectionCard>
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
              <SectionCard
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
              >
                {d.byOpenAgent.rows.length === 0 ? (
                  <CardEmpty
                    label={t('complaintDash.nothingOutstanding', {
                      defaultValue: 'Nothing outstanding — every ticket in this range is closed.',
                    })}
                  />
                ) : (
                  // Shares are OF THE OPEN PILE, not of every complaint: "40% of
                  // what is still open" is the question being asked here.
                  <Bars
                    rows={d.byOpenAgent.rows}
                    total={d.open}
                    color="bg-destructive"
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
              </SectionCard>
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
                color="bg-foreground"
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
                color="bg-magenta"
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
                color="bg-primary"
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
                color="bg-violet-500"
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
                color="bg-sky"
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
                color="bg-violet"
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
                color="bg-success"
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
                color="bg-primary"
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
                color="bg-destructive"
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
