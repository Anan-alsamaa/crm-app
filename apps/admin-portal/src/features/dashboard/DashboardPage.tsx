import type { ReactNode } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
// Absorbed from the retired standalone Ticket report: the Overview is now the
// single dashboard, so its status/priority mix and lifecycle timing live here.
import { TicketAnalytics } from '../ticket-ops/TicketOpsPage.js';
import { useTicketOps } from '../ticket-ops/api.js';
import {
  ClockIcon,
  cn,
  ErrorState,
  SelectMenu,
  ShieldIcon,
  Skeleton,
  SparkleIcon,
  Toolbar,
  ToolbarSpacer,
  ZapIcon,
} from '@yiji/ui';
import { useDashboardMetrics, type DashboardMetrics } from './api.js';
import { ComplaintDashboard } from './ComplaintDashboard.js';

const RANGES = [7, 30, 90];

const STATUS_TONE: Record<string, string> = {
  open: 'bg-success',
  pending: 'bg-warning',
  resolved: 'bg-primary',
  closed: 'bg-muted-foreground/40',
};

function fmtMinutes(m: number | null): string {
  if (m === null) return '—';
  if (m < 60) return `${Math.round(m)}m`;
  if (m < 1440) return `${(m / 60).toFixed(1)}h`;
  return `${Math.round(m / 1440)}d`;
}
const fmtPct = (p: number | null) => (p === null ? '—' : `${Math.round(p)}%`);

type KpiTone = 'blue' | 'violet' | 'green' | 'amber' | 'crimson';
// Vivid solid icon chips (Sara Connect style) — a categorical color per card,
// used ONLY on the small icon chip; the card itself stays white.
/* Design tokens, not raw Tailwind shades. The preset overrides `violet` as a
 * FLAT token, so `bg-violet` was invalid and rendered an empty chip — which
 * is exactly why the Avg-response card showed no icon background while the others
 * (sky/emerald/orange/rose from Tailwind's default palette) worked. `warning`
 * takes dark ink because it is a light hue. */
const KPI_TILE: Record<KpiTone, string> = {
  blue: 'bg-sky text-white',
  violet: 'bg-violet text-white',
  green: 'bg-success text-white',
  amber: 'bg-warning text-warning-foreground',
  crimson: 'bg-destructive text-white',
};

/** KPI card — label top-left, vivid icon chip top-right, big number, hint. */
function BentoStat({
  icon,
  tone,
  label,
  value,
  hint,
  delta,
  deltaGood,
  className,
}: {
  icon: ReactNode;
  tone: KpiTone;
  label: string;
  value: string;
  hint?: string;
  /** Period-over-period change, already formatted (e.g. "+12%"). */
  delta?: string;
  /** Whether the change is an improvement — a FALLING response time is good, a
   *  falling CSAT is not, so direction alone cannot decide the colour. */
  deltaGood?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col justify-between rounded-3xl bg-card p-5 shadow-soft ring-1 ring-foreground/[0.06]',
        'transition-[box-shadow,transform] duration-base ease-out hover:shadow-float motion-safe:hover:-translate-y-0.5',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="pt-1 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          {label}
        </span>
        <span
          className={cn(
            'grid h-9 w-9 shrink-0 place-items-center rounded-xl shadow-sm',
            KPI_TILE[tone],
          )}
        >
          {icon}
        </span>
      </div>
      <div>
        <div className="text-[2.5rem] font-extrabold leading-none tabular-nums tracking-[-0.04em] text-foreground">
          {value}
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          {delta && (
            <span
              className={cn(
                'inline-flex items-center rounded-full px-1.5 py-0.5 text-2xs font-semibold tabular-nums',
                deltaGood ? 'bg-success/12 text-success' : 'bg-destructive/12 text-destructive',
              )}
            >
              {delta}
            </span>
          )}
          {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
        </div>
      </div>
    </div>
  );
}

/** A titled bento panel (charts, lists). */
function Panel({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        'flex flex-col overflow-hidden rounded-3xl bg-card p-5 shadow-soft ring-1 ring-foreground/[0.06]',
        className,
      )}
    >
      <h2 className="mb-4 text-sm font-semibold tracking-tight text-foreground">{title}</h2>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

function VolumeBars({ series }: { series: DashboardMetrics['volumeSeries'] }) {
  const { t } = useTranslation();
  const max = Math.max(1, ...series.map((s) => s.count));
  if (series.length === 0)
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {t('dashboard.noActivity', { defaultValue: 'No activity in range.' })}
      </p>
    );
  const labelEvery = Math.max(1, Math.ceil(series.length / 6));
  return (
    <div>
      {/* Peak annotation gives the y-axis meaning without axis chrome. */}
      <div className="mb-2 flex items-baseline justify-between text-2xs text-muted-foreground">
        <span>
          {t('dashboard.peak', { defaultValue: 'Peak day' })}{' '}
          <strong className="font-semibold tabular-nums text-foreground">{max}</strong>
        </span>
        <span className="tabular-nums">
          {series.length} {t('dashboard.daysUnit', { defaultValue: 'days' })}
        </span>
      </div>
      <div className="flex h-40 items-end gap-1 border-b border-border pb-px">
        {series.map((s) => (
          <div
            key={s.day}
            className="group relative flex h-full flex-1 flex-col justify-end"
            title={`${s.day}: ${s.count}`}
          >
            {s.count > 0 && (
              <span className="pointer-events-none absolute -top-5 start-1/2 -translate-x-1/2 rounded-md bg-foreground px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-background opacity-0 shadow-md transition-opacity duration-fast group-hover:opacity-100 rtl:translate-x-1/2">
                {s.count}
              </span>
            )}
            <div
              className={cn(
                'w-full rounded-t-md transition-[filter] duration-fast ease-out group-hover:brightness-110',
                s.count > 0 ? 'bg-primary' : 'bg-secondary',
              )}
              style={{ height: `${Math.max(3, (s.count / max) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      {/* Sparse date ticks under the baseline. */}
      <div className="mt-1.5 flex gap-1">
        {series.map((s, i) => (
          <span
            key={s.day}
            className="flex-1 truncate text-center text-[9px] tabular-nums text-muted-foreground"
          >
            {i % labelEvery === 0 ? s.day.slice(5) : ''}
          </span>
        ))}
      </div>
    </div>
  );
}

function RankList({
  rows,
  unit,
}: {
  rows: Array<{ id: string; name: string; value: number }>;
  unit: string;
}) {
  const { t } = useTranslation();
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (rows.length === 0)
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        {t('dashboard.noData', { defaultValue: 'No data yet.' })}
      </p>
    );
  return (
    <ul className="space-y-2.5">
      {rows.map((r, i) => (
        <li key={r.id} className="flex items-center gap-3">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-primary-subtle text-2xs font-bold text-primary">
            {i + 1}
          </span>
          <span className="w-24 shrink-0 truncate text-sm font-medium text-foreground">
            {r.name}
          </span>
          <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-secondary">
            <span
              className="block h-full rounded-full bg-primary transition-[width] duration-slow ease-out"
              style={{ width: `${(r.value / max) * 100}%` }}
            />
          </span>
          <span className="w-16 shrink-0 text-end text-xs tabular-nums font-semibold text-foreground">
            {r.value} <span className="font-normal text-muted-foreground">{unit}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function StatusBreakdown({ data }: { data: DashboardMetrics['conversationsByStatus'] }) {
  const { t } = useTranslation();
  const entries = Object.entries(data).sort(([, a], [, b]) => b - a);
  const total = entries.reduce((acc, [, n]) => acc + n, 0);
  if (entries.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        {t('dashboard.noConversations', { defaultValue: 'No conversations in range.' })}
      </p>
    );
  return (
    <ul className="space-y-3">
      {entries.map(([status, count]) => (
        <li key={status} className="space-y-1">
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="capitalize text-foreground">
              {t(`status.${status}`, { ns: 'common', defaultValue: status })}
            </span>
            <span className="tabular-nums text-muted-foreground">
              {count}
              <span className="ms-1 text-2xs">({Math.round((count / total) * 100)}%)</span>
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-secondary">
            <div
              className={cn(
                'h-full rounded-full transition-[width] duration-slow ease-out',
                STATUS_TONE[status] ?? 'bg-muted-foreground/40',
              )}
              style={{ width: `${(count / total) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

type Tab = 'complaints' | 'support';

export function DashboardPage() {
  const { t } = useTranslation();
  // Complaints first: it is the reporting the operations team run the business
  // on. The support view keeps the conversation/SLA/CSAT metrics, which measure
  // how we work rather than what customers complained about — two different
  // questions that were previously crammed into one grid.
  const [tab, setTab] = useState<Tab>('complaints');
  const [days, setDays] = useState(30);

  const TABS: Array<{ id: Tab; label: string }> = [
    { id: 'complaints', label: t('dashboard.tabComplaints', { defaultValue: 'Complaints' }) },
    { id: 'support', label: t('dashboard.tabSupport', { defaultValue: 'Support activity' }) },
  ];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t('dashboard.title', { defaultValue: 'Overview' })}
        </h1>
        <span className="hidden text-xs opacity-30 sm:inline">·</span>
        <div className="flex items-center gap-x-4 text-xs">
          {TABS.map((tb) => (
            <button
              key={tb.id}
              type="button"
              onClick={() => setTab(tb.id)}
              className={cn(
                'relative inline-flex h-12 items-center font-medium transition-colors duration-fast ease-out focus-visible:outline-none',
                tab === tb.id ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {tb.label}
              {tab === tb.id && (
                <span
                  aria-hidden
                  className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-primary"
                />
              )}
            </button>
          ))}
        </div>
        <ToolbarSpacer />
        {/* The complaints view carries its own from/to filter bar, so the rolling
            range picker would be a second, conflicting control there. */}
        {tab === 'support' && (
          <SelectMenu
            size="sm"
            value={String(days)}
            onChange={(v) => setDays(Number(v))}
            aria-label={t('dashboard.range', { defaultValue: 'Date range' })}
            options={RANGES.map((d) => ({
              value: String(d),
              label: t('dashboard.lastDays', { count: d, defaultValue: `Last ${d} days` }),
            }))}
          />
        )}
      </Toolbar>

      <div className="flex-1 overflow-auto p-4 sm:p-6">
        {tab === 'complaints' ? <ComplaintDashboard /> : <SupportOverview days={days} />}
      </div>
    </div>
  );
}

/**
 * The original support overview — conversation volume, SLA, CSAT and ticket
 * lifecycle. Split into its own component so its queries only run when the tab
 * is actually shown, rather than on every visit to the complaints view.
 */
function SupportOverview({ days }: { days: number }) {
  const { t } = useTranslation();
  const m = useDashboardMetrics(days);
  // Ticket lifecycle analytics, absorbed from the retired Ticket report so the
  // Overview is genuinely the ONE dashboard rather than half of two.
  const ops = useTicketOps(days);

  return (
    <div className="mx-auto max-w-6xl">
      {m.isError ? (
        <ErrorState
          title={t('dashboard.loadError', { defaultValue: 'Could not load metrics' })}
          message={t('dashboard.loadErrorHint', {
            defaultValue: 'Check your connection and try again.',
          })}
          retryLabel={t('actions.retry', { ns: 'common', defaultValue: 'Retry' })}
          onRetry={() => void m.refetch()}
        />
      ) : m.isLoading || !m.data ? (
        <div className="grid auto-rows-[150px] grid-cols-2 gap-4 lg:grid-cols-4">
          <Skeleton className="col-span-2 row-span-2 rounded-3xl" />
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="rounded-3xl" />
          ))}
          <Skeleton className="col-span-2 row-span-2 rounded-3xl" />
          <Skeleton className="col-span-2 row-span-2 rounded-3xl" />
        </div>
      ) : (
        /* BENTO grid — mixed tile sizes, oversized numbers, color blocks. */
        <div className="grid auto-rows-[150px] grid-cols-2 gap-4 lg:grid-cols-4">
          {/* Feature tile — flat surface, the two headline numbers. */}
          {/* FEATURE tile — the one saturated surface on the page. Exactly one
                  card earns a gradient; a grid where everything shouts has no
                  hierarchy at all, which is why the reference dashboards colour a
                  single hero and leave the rest white. */}
          <div className="relative col-span-2 row-span-2 flex flex-col justify-between overflow-hidden rounded-3xl bg-gradient-to-br from-primary via-primary to-sky p-6 shadow-float ring-1 ring-foreground/[0.08]">
            {/* Soft light-form, echoing the reference hero cards. Pure decoration,
                    so it is aria-hidden and sits behind the content. */}
            <div
              aria-hidden
              className="pointer-events-none absolute -right-16 -top-20 h-64 w-64 rounded-full bg-white/15 blur-2xl"
            />
            <div
              aria-hidden
              className="pointer-events-none absolute -bottom-24 -left-10 h-56 w-56 rounded-full bg-white/10 blur-2xl"
            />
            <div className="relative">
              <h2 className="text-2xl font-bold tracking-[-0.03em] text-white">
                {t('dashboard.heroTitle', { defaultValue: 'Workspace overview' })}
              </h2>
              <p className="mt-1 text-sm text-white/75">
                {t('dashboard.heroHint', {
                  defaultValue: 'Support performance across every channel.',
                })}
              </p>
            </div>
            <div className="relative flex items-end gap-8">
              <div>
                <div className="text-6xl font-bold leading-none tabular-nums tracking-[-0.05em] text-white">
                  {m.data.conversationVolume}
                </div>
                <div className="mt-2 text-2xs font-semibold uppercase tracking-[0.12em] text-white/75">
                  {t('dashboard.conversations', { defaultValue: 'Conversations' })}
                </div>
              </div>
              <div>
                <div className="text-4xl font-bold leading-none tabular-nums tracking-[-0.04em] text-white">
                  {m.data.ticketTotal}
                </div>
                <div className="mt-2 text-2xs font-semibold uppercase tracking-[0.12em] text-white/75">
                  {t('dashboard.ofTicketsShort', { defaultValue: 'Tickets' })}
                </div>
              </div>
            </div>
          </div>

          {/* Four metric tiles beside the feature (2x2 block of 1x1s). */}
          <BentoStat
            icon={<ClockIcon size={18} />}
            tone="violet"
            label={t('dashboard.avgResponse', { defaultValue: 'First reply time' })}
            value={fmtMinutes(m.data.avgResponseMinutes)}
            hint={t('dashboard.firstReply', { defaultValue: 'how fast we answer' })}
          />
          <BentoStat
            icon={<ShieldIcon size={18} />}
            tone="green"
            label={t('dashboard.slaCompliance', { defaultValue: 'Answered on time' })}
            value={fmtPct(m.data.slaCompliancePct)}
            hint={t('dashboard.onTime', { defaultValue: 'on-time' })}
          />
          <BentoStat
            icon={<ZapIcon size={18} />}
            tone="amber"
            label={t('dashboard.resolution', { defaultValue: 'Tickets solved' })}
            value={fmtPct(m.data.ticketResolutionPct)}
            hint={t('dashboard.ofTickets', {
              count: m.data.ticketTotal,
              defaultValue: `of ${m.data.ticketTotal} tickets`,
            })}
          />
          <BentoStat
            icon={<SparkleIcon size={18} />}
            tone="crimson"
            label={t('dashboard.csat', { defaultValue: 'Customer rating' })}
            value={m.data.csatAvg === null ? '—' : `${m.data.csatAvg.toFixed(1)}`}
            hint={t('dashboard.responses', {
              count: m.data.csatCount,
              defaultValue: `${m.data.csatCount} responses`,
            })}
          />

          {/* Wide chart tile. */}
          <Panel
            title={t('dashboard.volume', { defaultValue: 'Conversations per day' })}
            className="col-span-2 row-span-2"
          >
            <VolumeBars series={m.data.volumeSeries} />
          </Panel>

          {/* Status breakdown tile. */}
          <Panel
            title={t('dashboard.byStatus', { defaultValue: 'Where conversations stand' })}
            className="col-span-2 row-span-2"
          >
            <StatusBreakdown data={m.data.conversationsByStatus} />
          </Panel>

          {/* Ticket lifecycle — status/priority mix and timing, formerly its own
                  page. Full-width below the bento so it reads as a second band
                  rather than competing with the headline tiles. */}
          {ops.data && (
            <div className="col-span-2 lg:col-span-4" style={{ gridRow: 'span 3' }}>
              <TicketAnalytics data={ops.data} />
            </div>
          )}

          {/* Two rank-list tiles. */}
          <Panel
            title={t('dashboard.topAgents', { defaultValue: 'Busiest agents' })}
            className="col-span-2 row-span-2"
          >
            <RankList
              rows={m.data.topAgents.map((a) => ({
                id: a.id,
                name: a.name,
                value: a.resolved,
              }))}
              unit={t('dashboard.resolvedUnit', { defaultValue: 'resolved' })}
            />
          </Panel>
          <Panel
            title={t('dashboard.topVendors', { defaultValue: 'Busiest vendors' })}
            className="col-span-2 row-span-2"
          >
            <RankList
              rows={m.data.topVendors.map((v) => ({
                id: v.id,
                name: v.name,
                value: v.conversations,
              }))}
              unit={t('dashboard.convsUnit', { defaultValue: 'convos' })}
            />
          </Panel>

          {/* Where the tickets are actually coming from — by branch and by
                  brand. Both are counted from each ticket's own order snapshot
                  joined onto Restaurants → Stores. */}
          <Panel
            title={t('dashboard.topStores', { defaultValue: 'Most tickets by store' })}
            className="col-span-2 row-span-2"
          >
            <RankList
              // `?? []` guards a cached result from a previous deploy that
              // predates these fields — react-query will happily hand back
              // the old shape, and a crashed dashboard is a worse failure
              // than an empty panel.
              rows={(m.data.topStores ?? []).map((s) => ({
                id: s.id,
                name: s.name,
                value: s.tickets,
              }))}
              unit={t('dashboard.ticketsUnit', { defaultValue: 'tickets' })}
            />
            {/* State the denominator. Only tickets that captured an order
                    snapshot can be attributed to a branch, so this count is
                    legitimately lower than the ticket total — saying so stops it
                    reading as a bug. */}
            <p className="mt-3 text-2xs leading-relaxed text-muted-foreground">
              {t('dashboard.storeBasis', {
                defaultValue: 'From {{total}} of {{all}} tickets that have a linked order.',
                total: m.data.ticketsWithOrder ?? 0,
                all: m.data.ticketTotal,
              })}
            </p>
            {(m.data.unmappedStoreTickets ?? 0) > 0 && (
              <p className="mt-1.5 text-2xs leading-relaxed text-warning-foreground">
                {t('dashboard.unmappedStores', {
                  defaultValue:
                    '{{n}} of those could not be matched to a store. Add the missing branches under Restaurants → Stores so this ranking is complete.',
                  n: m.data.unmappedStoreTickets,
                })}
              </p>
            )}
          </Panel>
          <Panel
            title={t('dashboard.topBrands', { defaultValue: 'Most tickets by brand' })}
            className="col-span-2 row-span-2"
          >
            <RankList
              rows={(m.data.topBrands ?? []).map((b) => ({
                id: b.id,
                name: b.name,
                value: b.tickets,
              }))}
              unit={t('dashboard.ticketsUnit', { defaultValue: 'tickets' })}
            />
          </Panel>

          {/* Compensation issued — DEFINED ONLY, by request. No query, no
              numbers, and deliberately not a row of zeros: a zero here would
              read as "nothing was compensated", which is a claim about the
              business rather than an admission that nothing is wired up yet.
              The data exists (tickets.coupon_value / compensation) whenever
              the reporting rules for it are settled. */}
          <Panel
            title={t('dashboard.compensationIssued', { defaultValue: 'Compensation issued' })}
            className="col-span-2"
          >
            <div className="flex h-full min-h-[7rem] flex-col items-center justify-center gap-1.5 text-center">
              <span className="rounded-full bg-secondary px-2 py-0.5 text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                {t('dashboard.notWiredYet', { defaultValue: 'Not reporting yet' })}
              </span>
              <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
                {t('dashboard.compensationIssuedHint', {
                  defaultValue:
                    'Coupon value and compensation are already recorded on every ticket. This panel starts reporting once the rules for it are agreed.',
                })}
              </p>
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}
