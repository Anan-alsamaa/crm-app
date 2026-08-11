import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, cn, ErrorState, Input, SelectMenu, Skeleton } from '@yiji/ui';
import {
  emptyComplaintFilters,
  useComplaintMetrics,
  type Breakdown,
  type ComplaintFilters,
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
 * His KPI card: one big number, a label, and a small line of context. The
 * accent is a left rule rather than a filled tile, so six of them in a row
 * stay readable instead of competing.
 */
function Kpi({
  value,
  label,
  sub,
  accent,
}: {
  value: string;
  label: string;
  sub?: string;
  accent: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl bg-card p-4 shadow-soft ring-1 ring-foreground/[0.06]">
      <span aria-hidden className={cn('absolute inset-y-0 start-0 w-1', accent)} />
      <div className="ps-2">
        <div className="text-3xl font-extrabold leading-none tabular-nums tracking-[-0.03em] text-foreground">
          {value}
        </div>
        <div className="mt-2 text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
          {label}
        </div>
        {/* Fixed height so a card with no context line does not sit shorter
            than its neighbours and break the row. */}
        <div className="mt-1 min-h-[1rem] text-2xs text-muted-foreground">{sub ?? ''}</div>
      </div>
    </div>
  );
}

function Card({
  title,
  hint,
  children,
  className,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn('rounded-2xl bg-card p-5 shadow-soft ring-1 ring-foreground/[0.06]', className)}
    >
      <h2 className="text-sm font-semibold tracking-tight text-foreground">{title}</h2>
      {hint && <p className="mt-0.5 text-2xs leading-relaxed text-muted-foreground">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/**
 * His bar breakdown: label, proportional track, then "count · share". The share
 * is what makes the list readable — 40 complaints means nothing until you know
 * it is a third of everything.
 */
function Bars({ rows, total, color }: { rows: Breakdown[]; total: number; color: string }) {
  const { t } = useTranslation();
  const max = Math.max(1, ...rows.map((r) => r.count));
  if (rows.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        {t('complaintDash.nothingInRange', { defaultValue: 'Nothing in this range.' })}
      </p>
    );
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.key} className="flex items-center gap-3">
          <span className="w-28 shrink-0 truncate text-xs text-foreground" title={r.label}>
            {r.label}
          </span>
          <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-secondary">
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
        </li>
      ))}
    </ul>
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
      <p className="mt-4 text-sm text-muted-foreground">
        {t('complaintDash.nothingInRange', { defaultValue: 'Nothing in this range.' })}
      </p>
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
      <p className="py-8 text-center text-sm text-muted-foreground">
        {t('complaintDash.nothingInRange', { defaultValue: 'Nothing in this range.' })}
      </p>
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
          <span aria-hidden className="h-0.5 w-4 rounded-full bg-warning" />
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
              stroke="var(--warning, #F2A900)"
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
                fill="var(--warning, #F2A900)"
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

export function ComplaintDashboard() {
  const { t } = useTranslation();
  // Draft vs applied: his bar only re-runs the dashboard on Apply, which matters
  // when a filter change means refetching every ticket.
  const [draft, setDraft] = useState<ComplaintFilters>(emptyComplaintFilters);
  const [applied, setApplied] = useState<ComplaintFilters>(emptyComplaintFilters);
  const m = useComplaintMetrics(applied);
  const d = m.data;

  const storeChoices = useMemo(
    () => [
      { value: '', label: t('complaintDash.allRestaurants', { defaultValue: 'All restaurants' }) },
      ...(d?.storeOptions ?? []).map((s) => ({ value: s.id, label: s.name })),
    ],
    [d?.storeOptions, t],
  );

  const dirty = JSON.stringify(draft) !== JSON.stringify(applied);
  const anyFilter = Object.values(applied).some(Boolean);

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      {/* ── Filter bar ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end gap-2 rounded-2xl bg-card p-3 shadow-soft ring-1 ring-foreground/[0.06]">
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
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
          <span className="text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
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
          <span className="text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
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
          <span className="text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
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
          <span className="text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
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
          <span className="text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            {t('complaintDash.restaurant', { defaultValue: 'Restaurant' })}
          </span>
          <SelectMenu
            size="sm"
            value={draft.store}
            onChange={(v) => setDraft((f) => ({ ...f, store: v }))}
            aria-label={t('complaintDash.restaurant', { defaultValue: 'Restaurant' })}
            options={storeChoices}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            {t('complaintDash.mobile', { defaultValue: 'Customer mobile' })}
          </span>
          {/* Partial match, like his: typing 41059 finds any number containing
              those digits, which is how the team pull up one caller's history. */}
          <Input
            className="h-9 w-[10rem]"
            inputMode="numeric"
            autoComplete="off"
            placeholder={t('complaintDash.mobileHint', { defaultValue: 'e.g. 41059' })}
            value={draft.phone}
            onChange={(e) => setDraft((f) => ({ ...f, phone: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setApplied(draft);
            }}
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
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
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
                  defaultValue: '{{n}} complaints · {{money}} compensation',
                  n: d.total.toLocaleString(),
                  money: SAR(d.compensation),
                })
              : t('complaintDash.noMatch', {
                  defaultValue: 'No complaints match these filters.',
                })}
          </p>

          {/* ── Six KPIs ─────────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
            <Kpi
              accent="bg-foreground"
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
              accent="bg-sky"
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
            />
            <Kpi
              accent="bg-violet"
              value={String(d.overdue)}
              label={t('complaintDash.kpiOverdue', { defaultValue: 'Overdue' })}
              // His "Escalated" has no equivalent status here, so this counts
              // the real thing a supervisor would chase instead.
              sub={t('complaintDash.overdueHint', { defaultValue: 'past first-reply SLA' })}
            />
            <Kpi
              accent="bg-success"
              value={d.satisfiedPct === null ? '—' : `${Math.round(d.satisfiedPct)}%`}
              label={t('complaintDash.kpiSatisfied', { defaultValue: 'Rated satisfied' })}
              sub={t('complaintDash.ratedOf', {
                defaultValue: '{{sat}} of {{rated}} rated',
                sat: d.satisfied,
                rated: d.rated,
              })}
            />
            <Kpi
              accent="bg-warning"
              value={d.compensation.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              label={t('complaintDash.kpiCompensation', { defaultValue: 'Compensation SAR' })}
              sub={
                d.avgCompensation === null
                  ? ''
                  : t('complaintDash.avgEach', {
                      defaultValue: '{{v}} avg each',
                      v: d.avgCompensation.toFixed(1),
                    })
              }
            />
            <Kpi
              accent="bg-destructive"
              value={String(d.chatsWaiting)}
              label={t('complaintDash.kpiChats', { defaultValue: 'Chats waiting' })}
              sub={t('complaintDash.ofChats', {
                defaultValue: '{{n}} total',
                n: d.chatsTotal,
              })}
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

          {/* ── Service health ───────────────────────────────────────────
              His gauge + composition strip: one glance at whether the work is
              finishing well, and whether chats are being picked up. */}
          <div className="grid gap-4 md:grid-cols-2">
            <Card
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
            </Card>

            <Card
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
                    className: 'bg-warning',
                  },
                ]}
              />
            </Card>
          </div>

          {/* ── Trend ────────────────────────────────────────────────────── */}
          <Card
            title={t('complaintDash.perMonth', { defaultValue: 'Complaints per month' })}
            hint={t('complaintDash.perMonthHint', {
              defaultValue: 'Volume as columns, compensation paid overlaid as a line.',
            })}
          >
            <TrendChart months={d.months} />
          </Card>

          {/* ── Agent performance ────────────────────────────────────────── */}
          <Card
            title={t('complaintDash.agentPerf', { defaultValue: 'Agent performance' })}
            hint={t('complaintDash.agentPerfHint', {
              defaultValue: 'Complaints handled, how many are finished, and what they cost.',
            })}
          >
            {d.agents.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('complaintDash.nothingInRange', { defaultValue: 'Nothing in this range.' })}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-2xs uppercase tracking-[0.08em] text-muted-foreground">
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
                      <tr key={a.id || 'unassigned'}>
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
                </table>
              </div>
            )}
          </Card>

          {/* ── Agent performance: chat ──────────────────────────────────
              His second table. Complaint counts say nothing about who is
              picking conversations up, which is the other half of the day. */}
          <Card
            title={t('complaintDash.chatPerf', { defaultValue: 'Agent performance — chat' })}
            hint={t('complaintDash.chatPerfHint', {
              defaultValue:
                'Conversations routing offered them, who answered, how long the customer waited, and who let one time out.',
            })}
          >
            {d.chatAgents.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('complaintDash.noChatActivity', { defaultValue: 'No chat activity yet.' })}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-2xs uppercase tracking-[0.08em] text-muted-foreground">
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
                </table>
              </div>
            )}
          </Card>

          {/* ── Breakdowns ───────────────────────────────────────────────── */}
          <div className="grid gap-4 md:grid-cols-2">
            <Card
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
            >
              <Bars rows={d.byRestaurant} total={d.total} color="bg-foreground" />
            </Card>
            <Card title={t('complaintDash.byType', { defaultValue: 'By complaint type' })}>
              <Bars rows={d.byType} total={d.total} color="bg-violet" />
            </Card>
            <Card title={t('complaintDash.byBrand', { defaultValue: 'By brand' })}>
              <Bars rows={d.byBrand} total={d.total} color="bg-warning" />
            </Card>
            <Card
              title={t('complaintDash.byArea', { defaultValue: 'By area' })}
              hint={t('complaintDash.byAreaHint', {
                defaultValue: 'The area manager responsible for the branch.',
              })}
            >
              <Bars rows={d.byArea} total={d.total} color="bg-warning" />
            </Card>
            <Card title={t('complaintDash.byCity', { defaultValue: 'By city' })}>
              <Bars rows={d.byCity} total={d.total} color="bg-sky" />
            </Card>
            <Card title={t('complaintDash.byAgent', { defaultValue: 'By agent' })}>
              <Bars rows={d.byAgent} total={d.total} color="bg-violet" />
            </Card>
            <Card title={t('complaintDash.byStatus', { defaultValue: 'By status' })}>
              <Bars
                rows={d.byStatus.map((r) => ({
                  ...r,
                  label: t(`status.${r.key}`, { ns: 'common', defaultValue: r.key }),
                }))}
                total={d.total}
                color="bg-success"
              />
            </Card>
            <Card title={t('complaintDash.byServiceType', { defaultValue: 'By service type' })}>
              <Bars rows={d.byServiceType} total={d.total} color="bg-primary" />
            </Card>
            <Card
              title={t('complaintDash.bySource', { defaultValue: 'Where complaints come from' })}
              className="md:col-span-2"
            >
              <Bars rows={d.bySource} total={d.total} color="bg-destructive" />
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
