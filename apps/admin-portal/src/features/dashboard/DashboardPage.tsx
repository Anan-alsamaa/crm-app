import type { ReactNode } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
const KPI_TILE: Record<KpiTone, string> = {
  blue: 'bg-sky-500 text-white',
  violet: 'bg-violet-500 text-white',
  green: 'bg-emerald-500 text-white',
  amber: 'bg-orange-400 text-white',
  crimson: 'bg-rose-500 text-white',
};

/** KPI card — label top-left, vivid icon chip top-right, big number, hint. */
function BentoStat({
  icon,
  tone,
  label,
  value,
  hint,
  className,
}: {
  icon: ReactNode;
  tone: KpiTone;
  label: string;
  value: string;
  hint?: string;
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
        {hint && <div className="mt-1.5 text-xs text-muted-foreground">{hint}</div>}
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

export function DashboardPage() {
  const { t } = useTranslation();
  const [days, setDays] = useState(30);
  const m = useDashboardMetrics(days);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t('dashboard.title', { defaultValue: 'Overview' })}
        </h1>
        <ToolbarSpacer />
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
      </Toolbar>

      <div className="flex-1 overflow-auto p-4 sm:p-6">
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
              <div className="col-span-2 row-span-2 flex flex-col justify-between rounded-3xl bg-card p-6 shadow-soft ring-1 ring-foreground/[0.08]">
                <div>
                  <h2 className="text-2xl font-extrabold tracking-[-0.03em] text-foreground">
                    {t('dashboard.heroTitle', { defaultValue: 'Workspace overview' })}
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t('dashboard.heroHint', {
                      defaultValue: 'Support performance across every channel.',
                    })}
                  </p>
                </div>
                <div className="flex items-end gap-8">
                  <div>
                    <div className="text-6xl font-extrabold leading-none tabular-nums tracking-[-0.05em] text-foreground">
                      {m.data.conversationVolume}
                    </div>
                    <div className="mt-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                      {t('dashboard.conversations', { defaultValue: 'Conversations' })}
                    </div>
                  </div>
                  <div>
                    <div className="text-4xl font-extrabold leading-none tabular-nums tracking-[-0.04em] text-foreground">
                      {m.data.ticketTotal}
                    </div>
                    <div className="mt-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                      {t('dashboard.ofTicketsShort', { defaultValue: 'Tickets' })}
                    </div>
                  </div>
                </div>
              </div>

              {/* Four metric tiles beside the feature (2x2 block of 1x1s). */}
              <BentoStat
                icon={<ClockIcon size={18} />}
                tone="violet"
                label={t('dashboard.avgResponse', { defaultValue: 'Avg response' })}
                value={fmtMinutes(m.data.avgResponseMinutes)}
                hint={t('dashboard.firstReply', { defaultValue: 'first reply' })}
              />
              <BentoStat
                icon={<ShieldIcon size={18} />}
                tone="green"
                label={t('dashboard.slaCompliance', { defaultValue: 'SLA compliance' })}
                value={fmtPct(m.data.slaCompliancePct)}
                hint={t('dashboard.onTime', { defaultValue: 'on-time' })}
              />
              <BentoStat
                icon={<ZapIcon size={18} />}
                tone="amber"
                label={t('dashboard.resolution', { defaultValue: 'Resolution' })}
                value={fmtPct(m.data.ticketResolutionPct)}
                hint={t('dashboard.ofTickets', {
                  count: m.data.ticketTotal,
                  defaultValue: `of ${m.data.ticketTotal} tickets`,
                })}
              />
              <BentoStat
                icon={<SparkleIcon size={18} />}
                tone="crimson"
                label={t('dashboard.csat', { defaultValue: 'CSAT' })}
                value={m.data.csatAvg === null ? '—' : `${m.data.csatAvg.toFixed(1)}`}
                hint={t('dashboard.responses', {
                  count: m.data.csatCount,
                  defaultValue: `${m.data.csatCount} responses`,
                })}
              />

              {/* Wide chart tile. */}
              <Panel
                title={t('dashboard.volume', { defaultValue: 'Conversation volume' })}
                className="col-span-2 row-span-2"
              >
                <VolumeBars series={m.data.volumeSeries} />
              </Panel>

              {/* Status breakdown tile. */}
              <Panel
                title={t('dashboard.byStatus', { defaultValue: 'By status' })}
                className="col-span-2 row-span-2"
              >
                <StatusBreakdown data={m.data.conversationsByStatus} />
              </Panel>

              {/* Two rank-list tiles. */}
              <Panel
                title={t('dashboard.topAgents', { defaultValue: 'Agent productivity' })}
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
                title={t('dashboard.topVendors', { defaultValue: 'Vendor activity' })}
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
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
