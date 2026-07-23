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
  return (
    <div className="flex h-28 items-end gap-1">
      {series.map((s) => (
        <div key={s.day} className="group relative flex-1" title={`${s.day}: ${s.count}`}>
          <div
            className="w-full rounded-t-md bg-gradient-to-t from-primary/70 to-primary shadow-sm shadow-primary/20 transition-[filter,opacity] duration-fast ease-out group-hover:brightness-110"
            style={{ height: `${Math.max(4, (s.count / max) * 100)}%` }}
          />
        </div>
      ))}
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
              className="block h-full rounded-full bg-gradient-to-r from-primary/75 to-primary shadow-sm shadow-primary/20"
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
    <section className="rounded-2xl bg-card p-5 shadow-soft ring-1 ring-border">
      <h2 className="mb-4 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {title}
      </h2>
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
        <div className="mx-auto max-w-6xl space-y-5">
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
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-24 rounded-2xl" />
              ))}
            </div>
          ) : (
            <>
              {/* Key stats */}
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
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
                  <ul className="space-y-2.5">
                    {Object.entries(m.data.conversationsByStatus).length === 0 && (
                      <p className="text-sm text-muted-foreground">
                        {t('dashboard.noConversations', {
                          defaultValue: 'No conversations in range.',
                        })}
                      </p>
                    )}
                    {Object.entries(m.data.conversationsByStatus)
                      .sort(([, a], [, b]) => b - a)
                      .map(([status, count]) => (
                        <li key={status} className="flex items-center gap-2.5">
                          <span
                            className={cn(
                              'h-2 w-2 shrink-0 rounded-full',
                              STATUS_TONE[status] ?? 'bg-muted-foreground/40',
                            )}
                          />
                          <span className="flex-1 text-sm capitalize text-foreground">
                            {t(`status.${status}`, { ns: 'common', defaultValue: status })}
                          </span>
                          <span className="text-sm tabular-nums text-muted-foreground">
                            {count}
                          </span>
                        </li>
                      ))}
                  </ul>
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
