import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  ChartIcon,
  ClockIcon,
  cn,
  Drawer,
  ErrorState,
  InboxIcon,
  Input,
  MeterBar,
  ProgressRing,
  SectionCard,
  SelectMenu,
  Skeleton,
  SparkleIcon,
  TicketIcon,
  UsersIcon,
} from '@yiji/ui';
import {
  emptyComplaintFilters,
  useComplaintMetrics,
  type Breakdown,
  type ComplaintFilters,
  type ComplaintRow,
  type Cut,
  type MonthPoint,
} from './complaints-api.js';

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

/** `2026-07` → `Jul 26`, matching his compact month captions. */
function monthLabel(ym: string): string {
  const [y, m] = ym.split('-');
  const names = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `${names[Number(m) - 1] ?? m} ${(y ?? '').slice(2)}`;
}

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

function Kpi({
  value,
  label,
  sub,
  tone,
  icon,
  visual,
  meter,
}: {
  value: string;
  label: string;
  sub?: string;
  tone: keyof typeof KPI_CHIPS;
  icon: React.ReactNode;
  /** End-side data accent — a ProgressRing on the KPIs that are a share. */
  visual?: React.ReactNode;
  /** Thin meter under the text — the boards' load reading, for the counts-of-a-whole. */
  meter?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl bg-card p-4 shadow-soft ring-1 ring-foreground/[0.06]">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-xl', KPI_CHIPS[tone])}
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-3xl font-extrabold leading-none tabular-nums tracking-[-0.03em] text-foreground">
            {value}
          </div>
          <div className="mt-2 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {label}
          </div>
          {/* Fixed height so a card with no context line does not sit shorter
              than its neighbours and break the row. */}
          <div className="mt-1 min-h-[1rem] text-2xs text-muted-foreground">{sub ?? ''}</div>
        </div>
        {/* Decorative: it re-draws a share the card already states in text. */}
        {visual && (
          <span aria-hidden className="shrink-0 self-center">
            {visual}
          </span>
        )}
      </div>
      {meter && <div className="mt-3">{meter}</div>}
    </div>
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
      {rows.map((r) => {
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
                  'block h-full rounded-full transition-[width] duration-slow ease-out',
                  color,
                )}
                style={{ width: `${Math.max(2, (r.count / max) * 100)}%` }}
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
                title={t('complaintDash.drillHint', { defaultValue: 'Show these complaints' })}
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

/**
 * His donut: a ring with the total in the middle and a legend of count · share.
 *
 * It answers a different question from the bar list beside it — the bars rank,
 * the ring shows how the whole divides — which is why he draws both from the
 * same numbers and why the categorical palette is fixed and shared, so a colour
 * means the same thing in every ring on the page.
 *
 * Drawn with stroke-dasharray on one circle per slice rather than arc paths:
 * no trigonometry to get wrong, and it degrades to a plain ring at any size.
 */
/* The design tokens are raw OKLCH COMPONENTS ("0.536 0.132 194"), not finished
 * colours, so they only work wrapped in oklch(). Passing `var(--primary)`
 * straight to `stroke` yields `stroke: 0.536 0.132 194`, which is invalid — the
 * browser drops the declaration and the slice paints nothing, leaving a donut
 * that is present in the DOM and invisible on screen. (Same trap the KPI chips
 * hit with `bg-violet` earlier in this feature.) */
/* No `--warning` slice: it is a LIGHT token, and a pale-yellow wedge on the
 * light theme's white card is a slice you cannot see. Magenta fills its seat
 * in the categorical order. */
const SLICE = [
  'oklch(var(--primary))',
  'oklch(var(--magenta))',
  'oklch(var(--success))',
  'oklch(var(--violet))',
  'oklch(var(--sky))',
  'oklch(var(--destructive))',
];

function Donut({ rows, onSelect }: { rows: Breakdown[]; onSelect?: (row: Breakdown) => void }) {
  const { t } = useTranslation();
  const total = rows.reduce((s, r) => s + r.count, 0);
  if (total === 0)
    return (
      <CardEmpty
        label={t('complaintDash.nothingInRange', { defaultValue: 'Nothing in this range.' })}
      />
    );

  const R = 54;
  const C = 2 * Math.PI * R;
  let offset = 0;

  return (
    <div className="flex flex-wrap items-center gap-5">
      <svg
        width="140"
        height="140"
        viewBox="0 0 140 140"
        role="img"
        aria-hidden
        className="shrink-0"
      >
        {rows.map((r, i) => {
          const len = (r.count / total) * C;
          const seg = (
            <circle
              key={r.key}
              r={R}
              cx="70"
              cy="70"
              fill="none"
              stroke={SLICE[i % SLICE.length]}
              strokeWidth="22"
              strokeDasharray={`${len} ${C - len}`}
              strokeDashoffset={-offset}
              transform="rotate(-90 70 70)"
            />
          );
          offset += len;
          return seg;
        })}
        {/* Punch the middle out with the card colour, then print the total —
            the number every reader looks for first. */}
        <circle r="43" cx="70" cy="70" className="fill-card" />
        <text
          x="70"
          y="67"
          textAnchor="middle"
          className="fill-foreground text-xl font-extrabold tabular-nums tracking-[-0.03em]"
        >
          {total}
        </text>
        <text
          x="70"
          y="84"
          textAnchor="middle"
          className="fill-muted-foreground text-[9px] font-semibold uppercase tracking-[0.12em]"
        >
          {t('complaintDash.donutTotal', { defaultValue: 'total' })}
        </text>
      </svg>
      {/* Hairline separators, table-style: the counts are end-aligned across
          the card's whole half, and without a rule per row the eye loses which
          label a number belongs to over the gap. */}
      <ul className="min-w-0 flex-1 divide-y divide-border/60">
        {rows.map((r, i) => {
          const body = (
            <>
              <span
                aria-hidden
                className="h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ background: SLICE[i % SLICE.length] }}
              />
              <span className="min-w-0 flex-1 truncate text-start text-foreground" title={r.label}>
                {r.label}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                <strong className="font-semibold text-foreground">{r.count}</strong> ·{' '}
                {Math.round((r.count / total) * 100)}%
              </span>
            </>
          );
          return (
            <li key={r.key}>
              {onSelect ? (
                <button
                  type="button"
                  onClick={() => onSelect(r)}
                  className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 -mx-1 text-xs transition-colors duration-fast hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  {body}
                </button>
              ) : (
                <span className="flex items-center gap-2 py-1.5 text-xs">{body}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * His split bar: one strip showing how a whole divides, with a key underneath.
 * Zero-value segments are dropped rather than rendered as slivers you cannot
 * read or tell apart.
 */
function Composition({
  segments,
}: {
  segments: Array<{ key: string; label: string; value: number; className: string }>;
}) {
  const { t } = useTranslation();
  const shown = segments.filter((s) => s.value > 0);
  const total = shown.reduce((sum, s) => sum + s.value, 0);
  if (total === 0)
    return (
      <CardEmpty
        label={t('complaintDash.nothingInRange', { defaultValue: 'Nothing in this range.' })}
      />
    );
  return (
    <div className="mt-4">
      <div className="flex h-3 overflow-hidden rounded-full bg-secondary">
        {shown.map((s) => (
          <span
            key={s.key}
            className={s.className}
            style={{ width: `${(s.value / total) * 100}%` }}
            title={`${s.label}: ${s.value}`}
          />
        ))}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {shown.map((s) => (
          <li
            key={s.key}
            className="inline-flex items-center gap-1.5 text-2xs text-muted-foreground"
          >
            <span aria-hidden className={cn('h-2 w-2 shrink-0 rounded-sm', s.className)} />
            {s.label}
            <strong className="font-semibold tabular-nums text-foreground">{s.value}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Complaints per month as columns with compensation overlaid as a line — his
 * chart, and the one that answers the question the volume bars cannot: whether
 * what we pay out is tracking volume or running ahead of it.
 *
 * The two series have unrelated units, so each is scaled to its own maximum.
 * That is only honest if the reader can see it, hence the two axis captions.
 */
function TrendChart({ months }: { months: MonthPoint[] }) {
  const { t } = useTranslation();
  if (months.length === 0)
    return (
      <CardEmpty
        label={t('complaintDash.nothingInRange', { defaultValue: 'Nothing in this range.' })}
      />
    );

  const maxCount = Math.max(1, ...months.map((m) => m.count));
  const maxMoney = Math.max(1, ...months.map((m) => m.compensation));
  const H = 160;
  const W = Math.max(months.length * 56, 280);
  const step = W / months.length;
  const x = (i: number) => step * i + step / 2;
  const y = (v: number) => H - (v / maxMoney) * (H - 16);
  const linePoints = months.map((m, i) => `${x(i)},${y(m.compensation)}`).join(' ');
  const busiest = months.reduce((a, b) => (b.count > a.count ? b : a));
  const avg = months.reduce((s, m) => s + m.count, 0) / months.length;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-2xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-2 w-2 rounded-sm bg-primary" />
          {t('complaintDash.complaintsAxis', { defaultValue: 'Complaints' })}
          <span className="tabular-nums">(max {maxCount})</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          {/* Violet, not warning: `--warning` is a light token and the line
              would vanish against the light theme's card. */}
          <span aria-hidden className="h-0.5 w-4 rounded-full bg-violet" />
          {t('complaintDash.compensationAxis', { defaultValue: 'Compensation' })}
          <span className="tabular-nums">(max {SAR(maxMoney)})</span>
        </span>
      </div>

      <div className="overflow-x-auto">
        <div className="relative" style={{ minWidth: W }}>
          {/* Columns */}
          <div className="flex items-end gap-1" style={{ height: H }}>
            {months.map((m) => (
              <div
                key={m.month}
                className="group relative flex h-full flex-1 flex-col justify-end"
                title={`${monthLabel(m.month)} · ${m.count} · ${SAR(m.compensation)}`}
              >
                <span className="mb-1 text-center text-[10px] font-semibold tabular-nums text-foreground">
                  {m.count}
                </span>
                <div
                  className="w-full rounded-t-md bg-primary transition-[filter] duration-fast group-hover:brightness-110"
                  style={{ height: `${Math.max(2, (m.count / maxCount) * (H - 24))}px` }}
                />
              </div>
            ))}
          </div>
          {/* Compensation line, drawn over the columns on its own scale. */}
          <svg
            className="pointer-events-none absolute inset-x-0 top-0"
            width={W}
            height={H}
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            aria-hidden
          >
            <polyline
              points={linePoints}
              fill="none"
              stroke="oklch(var(--violet))"
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {months.map((m, i) => (
              <circle
                key={m.month}
                cx={x(i)}
                cy={y(m.compensation)}
                r="3"
                fill="oklch(var(--violet))"
              />
            ))}
          </svg>
        </div>
        <div className="mt-1.5 flex gap-1" style={{ minWidth: W }}>
          {months.map((m) => (
            <span
              key={m.month}
              className="flex-1 truncate text-center text-[10px] tabular-nums text-muted-foreground"
            >
              {monthLabel(m.month)}
            </span>
          ))}
        </div>
      </div>

      <p className="mt-3 text-2xs text-muted-foreground">
        {t('complaintDash.trendCaption', {
          defaultValue: 'Busiest month {{month}} with {{peak}}. Average {{avg}} per month.',
          month: monthLabel(busiest.month),
          peak: busiest.count,
          avg: avg.toFixed(1),
        })}
      </p>
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
        defaultValue: '{{n}} complaint(s) · {{money}} compensation',
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

export function ComplaintDashboard() {
  const { t } = useTranslation();
  // Draft vs applied: his bar only re-runs the dashboard on Apply, which matters
  // when a filter change means refetching every ticket.
  const [draft, setDraft] = useState<ComplaintFilters>(emptyComplaintFilters);
  const [applied, setApplied] = useState<ComplaintFilters>(emptyComplaintFilters);
  const m = useComplaintMetrics(applied);
  const d = m.data;

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
  const drillInto =
    (title: string, keyOf: (r: ComplaintRow) => string, extra?: (r: ComplaintRow) => boolean) =>
    (row: Breakdown) =>
      setDrill({
        title: `${title}: ${row.label}`,
        rows: (d?.rows ?? []).filter((r) => keyOf(r) === row.key && (extra ? extra(r) : true)),
      });

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

  // Footer aggregate bands for the two tables — the reference boards close
  // every table with the whole-team row. Sums for the additive columns only;
  // the blended solve rate is recomputed from the sums (averaging the
  // per-agent percentages would weight a one-ticket agent like a fifty-ticket
  // one), and the duration means cannot be blended from means at all.
  const agentTotals = useMemo(() => {
    const s = {
      logged: 0,
      open: 0,
      replies: 0,
      solved: 0,
      chatsOpen: 0,
      chatsSolved: 0,
      compensation: 0,
    };
    for (const a of d?.agents ?? []) {
      s.logged += a.logged;
      s.open += a.open;
      s.replies += a.replies;
      s.solved += a.solved;
      s.chatsOpen += a.chatsOpen;
      s.chatsSolved += a.chatsSolved;
      s.compensation += a.compensation;
    }
    return s;
  }, [d?.agents]);
  const chatTotals = useMemo(() => {
    const s = { messages: 0, chatsHandled: 0, chatsSolved: 0, offered: 0, answered: 0, missed: 0 };
    for (const a of d?.chatAgents ?? []) {
      s.messages += a.messages;
      s.chatsHandled += a.chatsHandled;
      s.chatsSolved += a.chatsSolved;
      s.offered += a.offered;
      s.answered += a.answered;
      s.missed += a.missed;
    }
    return s;
  }, [d?.chatAgents]);

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      {/* ── Filter bar ─────────────────────────────────────────────────
          Same surface as every SectionCard on the page; the fields inside
          carry the shared Input/SelectMenu styling on their own. */}
      <div className="flex flex-wrap items-end gap-x-3 gap-y-3 rounded-2xl bg-card p-4 shadow-soft ring-1 ring-foreground/[0.06]">
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {t('complaintDash.from', { defaultValue: 'From' })}
          </span>
          <Input
            type="date"
            className="h-9 w-[9.5rem]"
            value={draft.from}
            onChange={(e) => setDraft((f) => ({ ...f, from: e.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {t('complaintDash.to', { defaultValue: 'To' })}
          </span>
          <Input
            type="date"
            className="h-9 w-[9.5rem]"
            value={draft.to}
            onChange={(e) => setDraft((f) => ({ ...f, to: e.target.value }))}
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
        <div className="flex items-center gap-2 pb-px">
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
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-28 rounded-2xl" />
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
                  defaultValue:
                    'Showing {{n}} complaints from {{from}} to {{to}} · {{money}} compensation',
                  n: d.total.toLocaleString(),
                  from: d.firstDate ?? '—',
                  to: d.lastDate ?? '—',
                  money: SAR(d.compensation),
                })
              : t('complaintDash.noMatch', {
                  defaultValue: 'No complaints match these filters.',
                })}
          </p>

          {/* ── Six KPIs ─────────────────────────────────────────────────
              The share-of-a-whole cards carry the boards' data accents: a ring
              beside the two percentages, a thin meter under the two counts
              that are really fractions of a known total. Tones match the icon
              chip so the accent reads as the same signal, louder. */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Kpi
              tone="neutral"
              icon={<TicketIcon size={17} />}
              value={d.total.toLocaleString()}
              label={t('complaintDash.kpiTotal', { defaultValue: 'Complaints' })}
              sub={
                d.monthsCovered
                  ? t('complaintDash.months', {
                      defaultValue: '{{n}} month(s)',
                      n: d.monthsCovered,
                    })
                  : ''
              }
            />
            <Kpi
              tone="sky"
              icon={<InboxIcon size={17} />}
              value={String(d.open)}
              label={t('complaintDash.kpiOpen', { defaultValue: 'Open / in progress' })}
              sub={
                d.total
                  ? t('complaintDash.ofTotal', {
                      defaultValue: '{{p}}% of total',
                      p: Math.round((d.open / d.total) * 100),
                    })
                  : ''
              }
              visual={<ProgressRing value={d.total ? (d.open / d.total) * 100 : 0} tone="sky" />}
            />
            <Kpi
              tone="violet"
              icon={<ClockIcon size={17} />}
              value={String(d.overdue)}
              label={t('complaintDash.kpiOverdue', { defaultValue: 'Overdue' })}
              // His "Escalated" has no equivalent status here, so this counts
              // the real thing a supervisor would chase instead.
              sub={t('complaintDash.overdueHint', { defaultValue: 'past first-reply SLA' })}
              meter={<MeterBar value={d.total ? (d.overdue / d.total) * 100 : 0} tone="violet" />}
            />
            <Kpi
              tone="success"
              icon={<SparkleIcon size={17} />}
              value={d.satisfiedPct === null ? '—' : `${Math.round(d.satisfiedPct)}%`}
              label={t('complaintDash.kpiSatisfied', { defaultValue: 'Rated satisfied' })}
              sub={t('complaintDash.ratedOf', {
                defaultValue: '{{sat}} of {{rated}} rated',
                sat: d.satisfied,
                rated: d.rated,
              })}
              visual={<ProgressRing value={d.satisfiedPct ?? 0} tone="success" />}
            />
            <Kpi
              tone="primary"
              icon={<ChartIcon size={17} />}
              value={d.compensation.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              label={t('complaintDash.kpiCompensation', { defaultValue: 'Compensation SAR' })}
              sub={
                d.total
                  ? t('complaintDash.compensatedCount', {
                      defaultValue: '{{n}} compensated · {{v}} avg each',
                      n: d.compensated,
                      v: (d.avgCompensation ?? 0).toFixed(1),
                    })
                  : ''
              }
            />
            <Kpi
              tone="destructive"
              icon={<UsersIcon size={17} />}
              value={String(d.chatsWaiting)}
              label={t('complaintDash.kpiChats', { defaultValue: 'Chats waiting' })}
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
          </div>

          {/* Say what the satisfaction number is actually over. A percentage
              whose denominator is invisible is the easiest number to misread. */}
          {d.closed > d.rated && (
            <p className="px-1 text-2xs leading-relaxed text-muted-foreground">
              {t('complaintDash.satBasis', {
                defaultValue:
                  'Satisfaction is the customer’s own CSAT rating on the linked chat, so it covers {{rated}} of {{closed}} closed complaints — the rest were never rated (or were not raised from a chat).',
                rated: d.rated,
                closed: d.closed,
              })}
            </p>
          )}

          {/* ── The two rings ────────────────────────────────────────────
              Same numbers as the By-status and By-brand bars further down, read
              a different way: the bars rank, these show the split. He keeps
              both, and on a page people scan rather than study, that is the
              point rather than a duplication. */}
          <div className="grid gap-4 md:grid-cols-2">
            <SectionCard
              title={t('complaintDash.statusMix', { defaultValue: 'Complaint status mix' })}
            >
              <Donut
                rows={d.byStatus.rows.map((r) => ({
                  ...r,
                  label: t(`status.${r.key}`, { ns: 'common', defaultValue: r.key }),
                }))}
                onSelect={drillInto(
                  t('complaintDash.statusMix', { defaultValue: 'Complaint status mix' }),
                  (r) => r.status,
                )}
              />
            </SectionCard>
            <SectionCard
              title={t('complaintDash.brandMix', { defaultValue: 'Where complaints come from' })}
            >
              <Donut
                rows={d.byBrand.rows}
                onSelect={drillInto(
                  t('complaintDash.byBrand', { defaultValue: 'By brand' }),
                  (r) => r.brandName,
                )}
              />
            </SectionCard>
          </div>

          {/* ── Service health ───────────────────────────────────────────
              His gauge + composition strip: one glance at whether the work is
              finishing well, and whether chats are being picked up. */}
          <div className="grid gap-4 md:grid-cols-2">
            <SectionCard
              title={t('complaintDash.health', { defaultValue: 'Service health' })}
              hint={t('complaintDash.healthHint', {
                defaultValue: 'Where every complaint in this range currently stands.',
              })}
            >
              <div className="flex items-baseline gap-3">
                <span
                  className={cn(
                    'text-4xl font-extrabold tabular-nums tracking-[-0.03em]',
                    d.satisfiedPct === null
                      ? 'text-muted-foreground'
                      : d.satisfiedPct >= 80
                        ? 'text-success'
                        : d.satisfiedPct >= 50
                          ? 'text-warning-foreground'
                          : 'text-destructive',
                  )}
                >
                  {d.satisfiedPct === null ? '—' : `${Math.round(d.satisfiedPct)}%`}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t('complaintDash.healthGauge', {
                    defaultValue: 'of rated complaints ended satisfied',
                  })}
                </span>
              </div>
              <Composition
                segments={[
                  {
                    key: 'sat',
                    label: t('complaintDash.segSatisfied', { defaultValue: 'Closed satisfied' }),
                    value: d.health.closedSatisfied,
                    className: 'bg-success',
                  },
                  {
                    key: 'unsat',
                    label: t('complaintDash.segUnsatisfied', {
                      defaultValue: 'Closed unsatisfied',
                    }),
                    value: d.health.closedUnsatisfied,
                    className: 'bg-destructive',
                  },
                  {
                    key: 'unrated',
                    label: t('complaintDash.segUnrated', { defaultValue: 'Closed, not rated' }),
                    value: d.health.closedUnrated,
                    className: 'bg-muted-foreground/40',
                  },
                  {
                    key: 'open',
                    label: t('complaintDash.segOpen', { defaultValue: 'Still open' }),
                    value: d.health.openNotOverdue,
                    className: 'bg-sky',
                  },
                  {
                    key: 'overdue',
                    label: t('complaintDash.segOverdue', { defaultValue: 'Overdue' }),
                    value: d.health.overdue,
                    className: 'bg-violet',
                  },
                ]}
              />
            </SectionCard>

            <SectionCard
              title={t('complaintDash.chatHealth', { defaultValue: 'Chat responsiveness' })}
              hint={t('complaintDash.chatHealthHint', {
                defaultValue: 'Whether conversations are being picked up, and how fast.',
              })}
            >
              <div className="flex items-baseline gap-3">
                <span className="text-4xl font-extrabold tabular-nums tracking-[-0.03em] text-foreground">
                  {d.health.avgChatWaitMinutes === null
                    ? '—'
                    : `${d.health.avgChatWaitMinutes.toFixed(1)}m`}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t('complaintDash.avgWait', { defaultValue: 'average customer wait' })}
                </span>
              </div>
              <Composition
                segments={[
                  {
                    key: 'answered',
                    label: t('complaintDash.segAnswered', { defaultValue: 'Answered' }),
                    value: d.health.chatsAnswered,
                    className: 'bg-success',
                  },
                  {
                    key: 'waiting',
                    label: t('complaintDash.segWaiting', { defaultValue: 'Still waiting' }),
                    value: d.health.chatsWaiting,
                    // Destructive, not warning (a light token that dies on the
                    // light theme) — and it matches the Chats-waiting KPI chip.
                    className: 'bg-destructive',
                  },
                ]}
              />
            </SectionCard>
          </div>

          {/* ── Trend ────────────────────────────────────────────────────── */}
          <SectionCard
            title={t('complaintDash.perMonth', { defaultValue: 'Complaints per month' })}
            hint={t('complaintDash.perMonthHint', {
              defaultValue: 'Volume as columns, compensation paid overlaid as a line.',
            })}
          >
            <TrendChart months={d.months} />
          </SectionCard>

          {/* ── Agent performance ────────────────────────────────────────── */}
          <SectionCard
            title={t('complaintDash.agentPerf', { defaultValue: 'Agent performance' })}
            hint={t('complaintDash.agentPerfHint', {
              defaultValue: 'Complaints handled, how many are finished, and what they cost.',
            })}
          >
            {d.agents.length === 0 ? (
              <CardEmpty
                label={t('complaintDash.nothingInRange', {
                  defaultValue: 'Nothing in this range.',
                })}
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-2xs uppercase tracking-[0.12em] text-muted-foreground">
                      <th className="py-2 text-start font-semibold">
                        {t('complaintDash.colAgent', { defaultValue: 'Agent' })}
                      </th>
                      <th className="py-2 text-end font-semibold">
                        {t('complaintDash.colLogged', { defaultValue: 'Complaints' })}
                      </th>
                      <th className="py-2 text-end font-semibold">
                        {t('complaintDash.colOpen', { defaultValue: 'Still open' })}
                      </th>
                      <th className="py-2 text-end font-semibold">
                        {t('complaintDash.colReplies', { defaultValue: 'CRM replies' })}
                      </th>
                      <th className="py-2 text-end font-semibold">
                        {t('complaintDash.colSolved', { defaultValue: 'Solved' })}
                      </th>
                      <th className="py-2 text-end font-semibold">
                        {t('complaintDash.colSolvedPct', { defaultValue: 'Solved %' })}
                      </th>
                      <th className="py-2 text-end font-semibold">
                        {t('complaintDash.colHours', { defaultValue: 'Avg hrs to close' })}
                      </th>
                      <th className="py-2 text-end font-semibold">
                        {t('complaintDash.colChatsOpen', { defaultValue: 'Chats open' })}
                      </th>
                      <th className="py-2 text-end font-semibold">
                        {t('complaintDash.colChatsSolved', { defaultValue: 'Chats solved' })}
                      </th>
                      <th className="py-2 text-end font-semibold">
                        {t('complaintDash.colMoney', { defaultValue: 'Compensation' })}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {d.agents.map((a) => (
                      <tr
                        key={a.id || 'unassigned'}
                        onClick={() =>
                          setDrill({
                            title: `${t('complaintDash.agentPerf', { defaultValue: 'Agent performance' })}: ${a.name}`,
                            rows: (d.rows ?? []).filter((r) => r.agentId === a.id),
                          })
                        }
                        className="cursor-pointer transition-colors duration-fast hover:bg-secondary/60"
                      >
                        <td className="py-2 font-medium text-foreground">{a.name}</td>
                        <td className="py-2 text-end tabular-nums">{a.logged}</td>
                        <td
                          className={cn(
                            'py-2 text-end tabular-nums',
                            a.open > 0 && 'font-semibold text-warning-foreground',
                          )}
                        >
                          {a.open}
                        </td>
                        <td className="py-2 text-end tabular-nums">{a.replies}</td>
                        <td className="py-2 text-end tabular-nums">{a.solved}</td>
                        <td className="py-2 text-end tabular-nums">
                          {a.solvedPct === null ? '—' : `${Math.round(a.solvedPct)}%`}
                        </td>
                        <td className="py-2 text-end tabular-nums">
                          {a.avgHoursToClose === null ? '—' : a.avgHoursToClose.toFixed(1)}
                        </td>
                        <td className="py-2 text-end tabular-nums">{a.chatsOpen}</td>
                        <td className="py-2 text-end tabular-nums">{a.chatsSolved}</td>
                        <td className="py-2 text-end tabular-nums">
                          {a.compensation.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-border bg-secondary/40 font-semibold text-foreground">
                      <td className="py-2 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                        {t('complaintDash.tableTotal', { defaultValue: 'Total' })}
                      </td>
                      <td className="py-2 text-end tabular-nums">{agentTotals.logged}</td>
                      <td className="py-2 text-end tabular-nums">{agentTotals.open}</td>
                      <td className="py-2 text-end tabular-nums">{agentTotals.replies}</td>
                      <td className="py-2 text-end tabular-nums">{agentTotals.solved}</td>
                      <td className="py-2 text-end tabular-nums">
                        {agentTotals.logged
                          ? `${Math.round((agentTotals.solved / agentTotals.logged) * 100)}%`
                          : '—'}
                      </td>
                      {/* A mean of per-agent means is not the team's mean. */}
                      <td className="py-2 text-end tabular-nums">—</td>
                      <td className="py-2 text-end tabular-nums">{agentTotals.chatsOpen}</td>
                      <td className="py-2 text-end tabular-nums">{agentTotals.chatsSolved}</td>
                      <td className="py-2 text-end tabular-nums">
                        {agentTotals.compensation.toLocaleString(undefined, {
                          maximumFractionDigits: 0,
                        })}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </SectionCard>

          {/* ── Agent performance: chat ──────────────────────────────────
              His second table. Complaint counts say nothing about who is
              picking conversations up, which is the other half of the day. */}
          <SectionCard
            title={t('complaintDash.chatPerf', { defaultValue: 'Agent performance — chat' })}
            hint={t('complaintDash.chatPerfHint', {
              defaultValue:
                'Conversations routing offered them, who answered, how long the customer waited, and who let one time out.',
            })}
          >
            {d.chatAgents.length === 0 ? (
              <CardEmpty
                label={t('complaintDash.noChatActivity', { defaultValue: 'No chat activity yet.' })}
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-2xs uppercase tracking-[0.12em] text-muted-foreground">
                      <th className="py-2 text-start font-semibold">
                        {t('complaintDash.colAgent', { defaultValue: 'Agent' })}
                      </th>
                      <th className="py-2 text-end font-semibold">
                        {t('complaintDash.colMessages', { defaultValue: 'Replies sent' })}
                      </th>
                      <th className="py-2 text-end font-semibold">
                        {t('complaintDash.colHandled', { defaultValue: 'Chats handled' })}
                      </th>
                      <th className="py-2 text-end font-semibold">
                        {t('complaintDash.colChatSolved', { defaultValue: 'Chats solved' })}
                      </th>
                      <th className="py-2 text-end font-semibold">
                        {t('complaintDash.colOffered', { defaultValue: 'Offered' })}
                      </th>
                      <th className="py-2 text-end font-semibold">
                        {t('complaintDash.colAnswered', { defaultValue: 'Answered' })}
                      </th>
                      <th className="py-2 text-end font-semibold">
                        {t('complaintDash.colMissed', { defaultValue: 'Timed out' })}
                      </th>
                      <th className="py-2 text-end font-semibold">
                        {t('complaintDash.colWait', { defaultValue: 'Avg wait' })}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {d.chatAgents.map((a) => (
                      <tr key={a.id}>
                        <td className="py-2 font-medium text-foreground">{a.name}</td>
                        <td className="py-2 text-end tabular-nums">{a.messages}</td>
                        <td className="py-2 text-end tabular-nums">{a.chatsHandled}</td>
                        <td className="py-2 text-end tabular-nums">{a.chatsSolved}</td>
                        <td className="py-2 text-end tabular-nums">{a.offered}</td>
                        <td className="py-2 text-end tabular-nums">{a.answered}</td>
                        {/* Called out: a conversation nobody picked up in time is
                            the failure this table exists to surface. */}
                        <td
                          className={cn(
                            'py-2 text-end tabular-nums',
                            a.missed > 0 && 'font-semibold text-destructive',
                          )}
                        >
                          {a.missed}
                        </td>
                        <td className="py-2 text-end tabular-nums">
                          {a.avgWaitMinutes === null ? '—' : `${a.avgWaitMinutes.toFixed(1)}m`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-border bg-secondary/40 font-semibold text-foreground">
                      <td className="py-2 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                        {t('complaintDash.tableTotal', { defaultValue: 'Total' })}
                      </td>
                      <td className="py-2 text-end tabular-nums">{chatTotals.messages}</td>
                      <td className="py-2 text-end tabular-nums">{chatTotals.chatsHandled}</td>
                      <td className="py-2 text-end tabular-nums">{chatTotals.chatsSolved}</td>
                      <td className="py-2 text-end tabular-nums">{chatTotals.offered}</td>
                      <td className="py-2 text-end tabular-nums">{chatTotals.answered}</td>
                      <td
                        className={cn(
                          'py-2 text-end tabular-nums',
                          chatTotals.missed > 0 && 'text-destructive',
                        )}
                      >
                        {chatTotals.missed}
                      </td>
                      {/* A mean of per-agent means is not the team's mean. */}
                      <td className="py-2 text-end tabular-nums">—</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </SectionCard>

          {/* ── Breakdowns ───────────────────────────────────────────────── */}
          <div className="grid gap-4 md:grid-cols-2">
            {/* Leads the grid, as it does on his page. Not the same cut as "By
                agent": that ranks who logged the most, this ranks who is still
                holding unfinished work — a heavy logger with nothing
                outstanding is the opposite of a problem. */}
            <SectionCard
              title={t('complaintDash.unsolvedByAgent', {
                defaultValue: 'Unsolved complaints by agent',
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
                    defaultValue: 'Nothing outstanding — every complaint in this range is closed.',
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
                      defaultValue: 'Unsolved complaints by agent',
                    }),
                    (r) => r.agentId,
                    // His click lands on the UNSOLVED ones only, not everything
                    // that agent has ever logged.
                    (r) => r.isOpen,
                  )}
                />
              )}
            </SectionCard>
            <CutCard
              title={t('complaintDash.topRestaurants', { defaultValue: 'Top restaurants' })}
              hint={
                d.unattributed > 0
                  ? t('complaintDash.unattributed', {
                      defaultValue:
                        '{{n}} complaint(s) have no branch recorded and are missing from this cut.',
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
            <CutCard
              title={t('complaintDash.byType', { defaultValue: 'By complaint type' })}
              cut={d.byType}
              total={d.total}
              color="bg-violet"
              onSelect={drillInto(
                t('complaintDash.byType', { defaultValue: 'By complaint type' }),
                (r) => r.complaintType,
              )}
            />
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
            <CutCard
              title={t('complaintDash.byArea', { defaultValue: 'By area' })}
              hint={t('complaintDash.byAreaHint', {
                defaultValue: 'The area manager responsible for the branch.',
              })}
              cut={d.byArea}
              total={d.total}
              color="bg-primary"
              onSelect={drillInto(
                t('complaintDash.byArea', { defaultValue: 'By area' }),
                (r) => r.area,
              )}
            />
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
            {/* Retitled off his wording deliberately: he uses "Where complaints
                come from" for the BRAND ring above. Two cards under one title
                showing different things is worse than losing his phrasing. */}
            <CutCard
              title={t('complaintDash.bySource', { defaultValue: 'How complaints reach us' })}
              className="md:col-span-2"
              cut={d.bySource}
              total={d.total}
              color="bg-destructive"
              onSelect={drillInto(
                t('complaintDash.bySource', { defaultValue: 'How complaints reach us' }),
                (r) => r.source,
              )}
            />
          </div>
        </>
      )}

      {drill && <DrillDown title={drill.title} rows={drill.rows} onClose={() => setDrill(null)} />}
    </div>
  );
}
