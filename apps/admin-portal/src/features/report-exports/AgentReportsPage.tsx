import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, cn, EmptyState, Pill, SelectMenu, Skeleton, Spinner, toast } from '@yiji/ui';
import {
  useAgentReportData,
  useTicketOrders,
  type AgentKpiRow,
  type ConversationStatusReport,
  type SlaOutcome,
  type TicketReportRow,
} from './api.js';
import {
  buildAgentKpiSheets,
  buildConversationSheets,
  buildTicketsSheets,
  fmtDateTime,
  reportFilename,
  type Translate,
} from './export.js';
import { downloadWorkbook } from './xlsx.js';

type ReportTab = 'tickets' | 'agents' | 'conversations';
const RANGE_DAYS = [7, 30, 90] as const;
/** Rows rendered in the on-screen preview; the export always covers everything. */
const PREVIEW_ROWS = 50;

const PRIORITY_TONE: Record<string, 'muted' | 'neutral' | 'warning' | 'destructive'> = {
  low: 'muted',
  medium: 'neutral',
  high: 'warning',
  urgent: 'destructive',
};
const STATUS_TONE: Record<string, 'primary' | 'success' | 'warning' | 'muted' | 'neutral'> = {
  new: 'primary',
  open: 'success',
  pending: 'warning',
  resolved: 'primary',
  closed: 'muted',
};
const SLA_TONE: Record<SlaOutcome, 'success' | 'destructive' | 'warning' | 'muted'> = {
  met: 'success',
  breached: 'destructive',
  pending: 'warning',
  na: 'muted',
};

const fmtMins = (n: number | null) =>
  n == null ? '—' : n < 60 ? `${Math.round(n)}m` : `${(n / 60).toFixed(1)}h`;
const fmtPct = (n: number | null) => (n == null ? '—' : `${Math.round(n)}%`);
const fmtScore = (n: number | null) => (n == null ? '—' : n.toFixed(2));

/* ── Small presentational atoms ───────────────────────────────────────── */

function Kpi({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-2xl bg-card px-4 py-3 ring-1 ring-border shadow-soft">
      <div className="text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </div>
      <div className={cn('mt-1 text-2xl font-bold tracking-tight tabular-nums', tone)}>{value}</div>
    </div>
  );
}

function HeadCell({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        'whitespace-nowrap px-3 py-2 text-start text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground',
        className,
      )}
    >
      {children}
    </th>
  );
}

function StatusPill({ value }: { value: string }) {
  const { t } = useTranslation();
  return (
    <Pill tone={STATUS_TONE[value] ?? 'neutral'} size="sm">
      {t(`status.${value}`, { ns: 'common', defaultValue: value })}
    </Pill>
  );
}
function PriorityPill({ value }: { value: string }) {
  const { t } = useTranslation();
  return (
    <Pill tone={PRIORITY_TONE[value] ?? 'neutral'} size="sm">
      {t(`priority.${value}`, { ns: 'common', defaultValue: value })}
    </Pill>
  );
}
function SlaPill({ state }: { state: SlaOutcome }) {
  const { t } = useTranslation();
  if (state === 'na') return <span className="text-muted-foreground">—</span>;
  return (
    <Pill tone={SLA_TONE[state]} size="sm">
      {t(`agentReports.sla.${state}`, { defaultValue: state })}
    </Pill>
  );
}

/* ── Report 1: Tickets + order data ───────────────────────────────────── */

function TicketsReport({
  rows,
  tr,
  days,
}: {
  rows: TicketReportRow[];
  tr: Translate;
  days: number;
}) {
  const { t } = useTranslation();
  const [includeOrders, setIncludeOrders] = useState(false);

  const contactIds = useMemo(
    () => rows.map((r) => r.contactId).filter((id): id is string => !!id),
    [rows],
  );
  const orders = useTicketOrders(contactIds, includeOrders, days);
  const ordersMap = orders.data;

  const merged = useMemo<TicketReportRow[]>(() => {
    if (!ordersMap) return rows;
    return rows.map((r) => ({
      ...r,
      order: r.contactId ? (ordersMap.get(r.contactId) ?? undefined) : undefined,
    }));
  }, [rows, ordersMap]);

  const onExport = () => {
    if (merged.length === 0) {
      toast.error(t('agentReports.nothingToExport', { defaultValue: 'Nothing to export.' }));
      return;
    }
    downloadWorkbook(reportFilename('reports-tickets', days), buildTicketsSheets(merged, tr));
    toast.success(
      t('agentReports.exported', {
        count: merged.length,
        defaultValue: 'Exported {{count}} rows.',
      }),
    );
  };

  const preview = merged.slice(0, PREVIEW_ROWS);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-border text-primary focus:ring-primary/60"
            checked={includeOrders}
            onChange={(e) => setIncludeOrders(e.currentTarget.checked)}
          />
          {t('agentReports.includeOrders', { defaultValue: 'Include order data' })}
          {includeOrders && orders.isFetching && (
            <Spinner size={14} label={t('actions.loading', { ns: 'common' })} />
          )}
        </label>
        {includeOrders && (
          <span className="text-2xs text-muted-foreground">
            {t('agentReports.ordersHint', {
              defaultValue: 'Fetches each customer’s latest order from Yiji (best-effort).',
            })}
          </span>
        )}
        <div className="ms-auto">
          <Button size="sm" onClick={onExport}>
            {t('agentReports.exportExcel', { defaultValue: 'Export to Excel' })}
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl bg-card ring-1 ring-border shadow-soft">
        <table className="w-full text-sm">
          <thead className="border-b border-border">
            <tr>
              <HeadCell>{tr('agentReports.col.subject', { defaultValue: 'Subject' })}</HeadCell>
              <HeadCell>{tr('agentReports.col.status', { defaultValue: 'Status' })}</HeadCell>
              <HeadCell>{tr('agentReports.col.priority', { defaultValue: 'Priority' })}</HeadCell>
              <HeadCell>{tr('agentReports.col.contact', { defaultValue: 'Contact' })}</HeadCell>
              <HeadCell>{tr('agentReports.col.agent', { defaultValue: 'Agent' })}</HeadCell>
              <HeadCell className="text-end">
                {tr('agentReports.col.firstResponse', { defaultValue: 'First response' })}
              </HeadCell>
              <HeadCell>
                {tr('agentReports.col.firstResponseSla', { defaultValue: 'First response SLA' })}
              </HeadCell>
              <HeadCell className="text-end">
                {tr('agentReports.col.resolutionMin', { defaultValue: 'Resolution (min)' })}
              </HeadCell>
              {includeOrders && (
                <HeadCell>
                  {tr('agentReports.col.restaurant', { defaultValue: 'Restaurant' })}
                </HeadCell>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/40">
            {preview.map((r) => (
              <tr key={r.id} className="transition-colors duration-fast hover:bg-secondary/40">
                <td
                  className="max-w-[16rem] truncate px-3 py-2.5 font-medium text-foreground"
                  title={r.subject}
                >
                  {r.subject}
                </td>
                <td className="px-3 py-2.5">
                  <StatusPill value={r.status} />
                </td>
                <td className="px-3 py-2.5">
                  <PriorityPill value={r.priority} />
                </td>
                <td className="max-w-[12rem] truncate px-3 py-2.5 text-muted-foreground">
                  {r.contactName || r.contactPhone || r.contactEmail || '—'}
                </td>
                <td className="px-3 py-2.5 text-muted-foreground">{r.agentName}</td>
                <td className="px-3 py-2.5 text-end tabular-nums text-muted-foreground">
                  {fmtMins(r.firstResponseMinutes)}
                </td>
                <td className="px-3 py-2.5">
                  <SlaPill state={r.firstResponseState} />
                </td>
                <td className="px-3 py-2.5 text-end tabular-nums text-muted-foreground">
                  {r.resolutionMinutes == null ? '—' : Math.round(r.resolutionMinutes)}
                </td>
                {includeOrders && (
                  <td
                    className="max-w-[12rem] truncate px-3 py-2.5 text-muted-foreground"
                    title={r.order?.restaurant ?? ''}
                  >
                    {orders.isFetching && !r.order ? (
                      <span className="text-2xs opacity-60">…</span>
                    ) : (
                      (r.order?.restaurant ?? '—')
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <PreviewNote shown={preview.length} total={merged.length} />
    </div>
  );
}

/* ── Report 2: Agent KPI ──────────────────────────────────────────────── */

function AgentKpiReport({
  agents,
  tr,
  days,
}: {
  agents: AgentKpiRow[];
  tr: Translate;
  days: number;
}) {
  const { t } = useTranslation();

  const onExport = () => {
    if (agents.length === 0) {
      toast.error(t('agentReports.nothingToExport', { defaultValue: 'Nothing to export.' }));
      return;
    }
    downloadWorkbook(reportFilename('reports-agent-kpi', days), buildAgentKpiSheets(agents, tr));
    toast.success(
      t('agentReports.exported', {
        count: agents.length,
        defaultValue: 'Exported {{count}} rows.',
      }),
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center">
        <div className="ms-auto">
          <Button size="sm" onClick={onExport}>
            {t('agentReports.exportExcel', { defaultValue: 'Export to Excel' })}
          </Button>
        </div>
      </div>
      <div className="overflow-x-auto rounded-2xl bg-card ring-1 ring-border shadow-soft">
        <table className="w-full text-sm">
          <thead className="border-b border-border">
            <tr>
              <HeadCell>{tr('agentReports.col.agent', { defaultValue: 'Agent' })}</HeadCell>
              <HeadCell className="text-end">
                {tr('agentReports.col.tickets', { defaultValue: 'Tickets' })}
              </HeadCell>
              <HeadCell className="text-end">
                {tr('agentReports.col.avgFirstResponse', { defaultValue: 'Avg first response' })}
              </HeadCell>
              <HeadCell className="text-end">
                {tr('agentReports.col.firstResponsePct', { defaultValue: 'First response SLA %' })}
              </HeadCell>
              <HeadCell className="text-end">
                {tr('agentReports.col.csatCount', { defaultValue: 'CSAT responses' })}
              </HeadCell>
              <HeadCell className="text-end">
                {tr('agentReports.col.csatAvg', { defaultValue: 'CSAT avg (1–5)' })}
              </HeadCell>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/40">
            {agents.map((a) => (
              <tr
                key={a.agentId ?? '__unassigned__'}
                className="transition-colors duration-fast hover:bg-secondary/40"
              >
                <td className="px-3 py-2.5 font-medium text-foreground">{a.agentName}</td>
                <td className="px-3 py-2.5 text-end tabular-nums text-muted-foreground">
                  {a.tickets}
                </td>
                <td className="px-3 py-2.5 text-end tabular-nums text-muted-foreground">
                  {fmtMins(a.avgFirstResponseMin)}
                </td>
                <td className="px-3 py-2.5 text-end tabular-nums text-muted-foreground">
                  {fmtPct(a.firstResponsePct)}
                </td>
                <td className="px-3 py-2.5 text-end tabular-nums text-muted-foreground">
                  {a.csatCount}
                </td>
                <td className="px-3 py-2.5 text-end tabular-nums font-medium text-foreground">
                  {fmtScore(a.csatAvg)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── Report 3: Conversation status ────────────────────────────────────── */

function ConversationReport({
  report,
  tr,
  days,
}: {
  report: ConversationStatusReport;
  tr: Translate;
  days: number;
}) {
  const { t } = useTranslation();

  const onExport = () => {
    if (report.total === 0) {
      toast.error(t('agentReports.nothingToExport', { defaultValue: 'Nothing to export.' }));
      return;
    }
    downloadWorkbook(
      reportFilename('reports-conversations', days),
      buildConversationSheets(report, tr),
    );
    toast.success(
      t('agentReports.exported', {
        count: report.total,
        defaultValue: 'Exported {{count}} rows.',
      }),
    );
  };

  const preview = report.byDay.slice(-14);

  return (
    <div className="space-y-4">
      <div className="flex items-center">
        <div className="ms-auto">
          <Button size="sm" onClick={onExport}>
            {t('agentReports.exportExcel', { defaultValue: 'Export to Excel' })}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* By status */}
        <div className="rounded-2xl bg-card ring-1 ring-border shadow-soft p-4">
          <h3 className="mb-2 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {t('agentReports.byStatus', { defaultValue: 'By status' })}
          </h3>
          <ul className="space-y-1.5">
            {report.byStatus.map((s) => (
              <li key={s.key} className="flex items-center justify-between gap-2 text-sm">
                <StatusPill value={s.key} />
                <span className="tabular-nums font-medium text-foreground">{s.count}</span>
              </li>
            ))}
          </ul>
        </div>
        {/* By priority */}
        <div className="rounded-2xl bg-card ring-1 ring-border shadow-soft p-4">
          <h3 className="mb-2 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {t('agentReports.byPriority', { defaultValue: 'By priority' })}
          </h3>
          <ul className="space-y-1.5">
            {report.byPriority.map((p) => (
              <li key={p.key} className="flex items-center justify-between gap-2 text-sm">
                <PriorityPill value={p.key} />
                <span className="tabular-nums font-medium text-foreground">{p.count}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* By day */}
      <div className="overflow-x-auto rounded-2xl bg-card ring-1 ring-border shadow-soft">
        <table className="w-full text-sm">
          <thead className="border-b border-border">
            <tr>
              <HeadCell>{tr('agentReports.col.date', { defaultValue: 'Date' })}</HeadCell>
              <HeadCell className="text-end">
                {tr('agentReports.col.total', { defaultValue: 'Total' })}
              </HeadCell>
              {report.statuses.map((s) => (
                <HeadCell key={s} className="text-end">
                  {tr(`status.${s}`, { ns: 'common', defaultValue: s })}
                </HeadCell>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/40">
            {preview.map((d) => (
              <tr key={d.day} className="transition-colors duration-fast hover:bg-secondary/40">
                <td className="px-3 py-2.5 tabular-nums text-muted-foreground">{d.day}</td>
                <td className="px-3 py-2.5 text-end tabular-nums font-medium text-foreground">
                  {d.total}
                </td>
                {report.statuses.map((s) => (
                  <td key={s} className="px-3 py-2.5 text-end tabular-nums text-muted-foreground">
                    {d.byStatus[s] ?? 0}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <PreviewNote shown={preview.length} total={report.byDay.length} unit="days" />
    </div>
  );
}

/* ── Shared bits ──────────────────────────────────────────────────────── */

function PreviewNote({ shown, total, unit }: { shown: number; total: number; unit?: string }) {
  const { t } = useTranslation();
  if (shown >= total) return null;
  return (
    <p className="text-2xs text-muted-foreground">
      {unit === 'days'
        ? t('agentReports.previewDays', {
            shown,
            total,
            defaultValue: 'Showing the last {{shown}} of {{total}} days — the export covers all.',
          })
        : t('agentReports.previewRows', {
            shown,
            total,
            defaultValue: 'Showing {{shown}} of {{total}} rows — the export covers all.',
          })}
    </p>
  );
}

/* ── Page ─────────────────────────────────────────────────────────────── */

export function AgentReportsPage() {
  const { t } = useTranslation();
  const [days, setDays] = useState(30);
  const [tab, setTab] = useState<ReportTab>('tickets');
  // Labels baked into the report data (agent names / subjects) must be
  // translated here — the .xlsx export runs outside React and can't call i18n.
  const report = useAgentReportData(days, {
    unassigned: t('agentReports.unassigned', { defaultValue: 'Unassigned' }),
    noSubject: t('agentReports.noSubject', { defaultValue: '(no subject)' }),
  });

  // A thin wrapper so the pure export builders can call i18next without taking a
  // dependency on its full TFunction type.
  const tr: Translate = (key, opts) => String(t(key, opts));

  const data = report.data;
  const isEmpty =
    !!data &&
    data.tickets.length === 0 &&
    data.conversations.total === 0 &&
    data.agents.length === 0;

  const tabs: { key: ReportTab; label: string }[] = [
    { key: 'tickets', label: t('agentReports.tabTickets', { defaultValue: 'Tickets + orders' }) },
    { key: 'agents', label: t('agentReports.tabAgents', { defaultValue: 'Agent KPI' }) },
    {
      key: 'conversations',
      label: t('agentReports.tabConversations', { defaultValue: 'Conversation status' }),
    },
  ];

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col overflow-y-auto px-4 py-6 sm:px-6">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            {t('agentReports.title', { defaultValue: 'Reports' })}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('agentReports.subtitle', {
              defaultValue: 'Ticket, agent and conversation analytics — exportable to Excel.',
            })}
          </p>
        </div>
        <div className="w-40">
          <SelectMenu
            fullWidth
            value={String(days)}
            onChange={(v) => setDays(Number(v))}
            aria-label={t('agentReports.range', { defaultValue: 'Date range' })}
            options={RANGE_DAYS.map((d) => ({
              value: String(d),
              label: t('agentReports.lastDays', {
                count: d,
                days: d,
                defaultValue: 'Last {{days}} days',
              }),
            }))}
          />
        </div>
      </header>

      {/* Tabs */}
      <div className="mb-4 inline-flex w-fit rounded-lg bg-secondary/60 p-0.5 text-xs">
        {tabs.map((tb) => (
          <button
            key={tb.key}
            type="button"
            onClick={() => setTab(tb.key)}
            className={cn(
              'rounded-md px-3 py-1.5 font-medium transition-colors duration-fast',
              tab === tb.key
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {tb.label}
          </button>
        ))}
      </div>

      {report.isLoading ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Skeleton className="h-20 rounded-xl" />
            <Skeleton className="h-20 rounded-xl" />
            <Skeleton className="h-20 rounded-xl" />
            <Skeleton className="h-20 rounded-xl" />
          </div>
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      ) : report.isError ? (
        <EmptyState
          title={t('agentReports.loadError', { defaultValue: 'Could not load report data' })}
          description={t('agentReports.loadErrorHint', {
            defaultValue: 'Check your connection and try again.',
          })}
        />
      ) : !data || isEmpty ? (
        <EmptyState
          title={t('agentReports.empty', { defaultValue: 'No data in this window' })}
          description={t('agentReports.emptyHint', {
            defaultValue: 'Widen the date range, or wait for tickets and conversations to land.',
          })}
        />
      ) : (
        <div className="space-y-5">
          {/* KPI strip */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Kpi
              label={t('agentReports.kpiTickets', { defaultValue: 'Tickets' })}
              value={String(data.tickets.length)}
            />
            <Kpi
              label={t('agentReports.kpiConversations', { defaultValue: 'Conversations' })}
              value={String(data.conversations.total)}
            />
            <Kpi
              label={t('agentReports.kpiAgents', { defaultValue: 'Agents' })}
              value={String(data.agents.filter((a) => a.agentId).length)}
            />
            <Kpi
              label={t('agentReports.kpiCsat', { defaultValue: 'CSAT avg' })}
              value={fmtScore(data.csatOverall.avg)}
              tone={data.csatOverall.avg == null ? undefined : 'text-success'}
            />
          </div>

          {tab === 'tickets' && <TicketsReport rows={data.tickets} tr={tr} days={days} />}
          {tab === 'agents' && <AgentKpiReport agents={data.agents} tr={tr} days={days} />}
          {tab === 'conversations' && (
            <ConversationReport report={data.conversations} tr={tr} days={days} />
          )}
          <p className="pt-1 text-2xs text-muted-foreground">
            {t('agentReports.generatedAt', {
              at: fmtDateTime(data.generatedAt),
              defaultValue: 'Generated {{at}}',
            })}
          </p>
        </div>
      )}
    </div>
  );
}
