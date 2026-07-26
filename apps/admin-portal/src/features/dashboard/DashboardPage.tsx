import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn, ErrorState, SelectMenu, Skeleton, StatCard, Toolbar, ToolbarSpacer } from '@yiji/ui';
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

function Stat({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <StatCard label={label} value={value} caption={hint} tone={accent ? 'primary' : 'default'} />
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
                s.count > 0 ? 'bg-gradient-to-t from-primary to-violet' : 'bg-secondary',
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
      {rows.map((r) => (
        <li key={r.id} className="flex items-center gap-3">
          <span className="w-28 shrink-0 truncate text-sm text-foreground">{r.name}</span>
          <span className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
            <span
              className="block h-full rounded-full bg-gradient-to-r from-primary to-violet shadow-sm shadow-primary/20"
              style={{ width: `${(r.value / max) * 100}%` }}
            />
          </span>
          <span className="w-16 shrink-0 text-end text-xs tabular-nums text-muted-foreground">
            {r.value} {unit}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl bg-card p-5 shadow-soft">
      <h2 className="mb-4 text-sm font-semibold tracking-tight text-foreground">{title}</h2>
      {children}
    </section>
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

      <div className="flex-1 overflow-auto p-5 sm:p-6">
        <div className="mx-auto max-w-6xl space-y-8">
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
            <div className="grid grid-cols-2 gap-x-8 gap-y-6 lg:grid-cols-5">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-24 rounded-2xl" />
              ))}
            </div>
          ) : (
            <>
              {/* Hero header — the workspace's morning glance. */}
              <div>
                <h2 className="text-3xl font-extrabold tracking-[-0.03em] text-display">
                  {t('dashboard.heroTitle', { defaultValue: 'Workspace overview' })}
                </h2>
                <p className="mt-1 max-w-prose text-sm text-muted-foreground">
                  {t('dashboard.heroHint', {
                    defaultValue: 'How support is performing across every channel, at a glance.',
                  })}
                </p>
              </div>

              {/* Key stats */}
              <div className="grid grid-cols-2 gap-x-8 gap-y-6 lg:grid-cols-5">
                <Stat
                  label={t('dashboard.conversations', { defaultValue: 'Conversations' })}
                  value={String(m.data.conversationVolume)}
                  hint={t('dashboard.inRange', { defaultValue: 'in range' })}
                />
                <Stat
                  label={t('dashboard.avgResponse', { defaultValue: 'Avg response' })}
                  value={fmtMinutes(m.data.avgResponseMinutes)}
                  hint={t('dashboard.firstReply', { defaultValue: 'first reply' })}
                />
                <Stat
                  label={t('dashboard.slaCompliance', { defaultValue: 'SLA compliance' })}
                  value={fmtPct(m.data.slaCompliancePct)}
                  accent
                  hint={t('dashboard.onTime', { defaultValue: 'on-time first reply' })}
                />
                <Stat
                  label={t('dashboard.resolution', { defaultValue: 'Resolution rate' })}
                  value={fmtPct(m.data.ticketResolutionPct)}
                  hint={t('dashboard.ofTickets', {
                    count: m.data.ticketTotal,
                    defaultValue: `of ${m.data.ticketTotal} tickets`,
                  })}
                />
                <Stat
                  label={t('dashboard.csat', { defaultValue: 'CSAT' })}
                  value={m.data.csatAvg === null ? '—' : `${m.data.csatAvg.toFixed(1)}/5`}
                  accent
                  hint={t('dashboard.responses', {
                    count: m.data.csatCount,
                    defaultValue: `${m.data.csatCount} responses`,
                  })}
                />
              </div>

              {/* Volume + status */}
              <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
                <Card title={t('dashboard.volume', { defaultValue: 'Conversation volume' })}>
                  <VolumeBars series={m.data.volumeSeries} />
                </Card>
                <Card title={t('dashboard.byStatus', { defaultValue: 'Conversations by status' })}>
                  {(() => {
                    const entries = Object.entries(m.data.conversationsByStatus).sort(
                      ([, a], [, b]) => b - a,
                    );
                    const totalConvs = entries.reduce((acc, [, n]) => acc + n, 0);
                    if (entries.length === 0)
                      return (
                        <p className="text-sm text-muted-foreground">
                          {t('dashboard.noConversations', {
                            defaultValue: 'No conversations in range.',
                          })}
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
                                <span className="ms-1 text-2xs">
                                  ({Math.round((count / totalConvs) * 100)}%)
                                </span>
                              </span>
                            </div>
                            <div className="h-2 overflow-hidden rounded-full bg-secondary">
                              <div
                                className={cn(
                                  'h-full rounded-full transition-[width] duration-slow ease-out',
                                  STATUS_TONE[status] ?? 'bg-muted-foreground/40',
                                )}
                                style={{ width: `${(count / totalConvs) * 100}%` }}
                              />
                            </div>
                          </li>
                        ))}
                      </ul>
                    );
                  })()}
                </Card>
              </div>

              {/* Agent productivity + vendor activity */}
              <div className="grid gap-5 lg:grid-cols-2">
                <Card title={t('dashboard.topAgents', { defaultValue: 'Agent productivity' })}>
                  <RankList
                    rows={m.data.topAgents.map((a) => ({
                      id: a.id,
                      name: a.name,
                      value: a.resolved,
                    }))}
                    unit={t('dashboard.resolvedUnit', { defaultValue: 'resolved' })}
                  />
                </Card>
                <Card title={t('dashboard.topVendors', { defaultValue: 'Vendor activity' })}>
                  <RankList
                    rows={m.data.topVendors.map((v) => ({
                      id: v.id,
                      name: v.name,
                      value: v.conversations,
                    }))}
                    unit={t('dashboard.convsUnit', { defaultValue: 'convos' })}
                  />
                </Card>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
