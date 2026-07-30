import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  cn,
  EmptyState,
  Pagination,
  Pill,
  SelectMenu,
  Skeleton,
  SortTh,
  Table,
  TableSurface,
  Td,
  Th,
  toast,
  Toolbar,
  ToolbarSpacer,
  Tr,
  useTableSort,
} from '@yiji/ui';
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
  TICKET_COLUMN_KEYS,
  TICKET_COLUMN_LABELS,
  type TicketColumnKey,
  type Translate,
} from './export.js';
import { downloadWorkbook } from './xlsx.js';

/** Which of the three exportable reports this page instance renders. */
export type ReportKind = 'tickets' | 'agents' | 'conversations';
const RANGE_DAYS = [7, 30, 90] as const;

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

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const STATUS_RANK: Record<string, number> = { new: 0, open: 1, pending: 2, resolved: 3, closed: 4 };
const PAGE_SIZE = 10;

const TICKET_SORT: Record<string, (r: TicketReportRow) => string | number | null | undefined> = {
  subject: (r) => r.subject.toLowerCase(),
  status: (r) => STATUS_RANK[r.status] ?? 99,
  priority: (r) => PRIORITY_RANK[r.priority] ?? 99,
  contact: (r) => (r.contactName || r.contactPhone || r.contactEmail || '').toLowerCase(),
  agent: (r) => r.agentName.toLowerCase(),
  firstResponse: (r) => r.firstResponseMinutes,
  resolution: (r) => r.resolutionMinutes,
};
const AGENT_SORT: Record<string, (r: AgentKpiRow) => string | number | null | undefined> = {
  agent: (r) => r.agentName.toLowerCase(),
  tickets: (r) => r.tickets,
  avgFirstResponse: (r) => r.avgFirstResponseMin,
  firstResponsePct: (r) => r.firstResponsePct,
  csatCount: (r) => r.csatCount,
  csatAvg: (r) => r.csatAvg,
};

/* ── KPI card — vibrant tinted card, colored number (reference style) ───── */
type Tone = 'blue' | 'violet' | 'green' | 'amber';
const TILE_TONE: Record<Tone, string> = {
  blue: 'bg-sky/18 ring-sky/45',
  violet: 'bg-violet/18 ring-violet/45',
  green: 'bg-success/18 ring-success/45',
  amber: 'bg-warning/22 ring-warning/50',
};
const NUM_TONE: Record<Tone, string> = {
  blue: 'text-sky',
  violet: 'text-violet',
  green: 'text-success',
  amber: 'text-warning',
};
function KpiTile({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div
      className={cn(
        'rounded-2xl px-4 py-3.5 shadow-soft ring-1 transition-[box-shadow,transform] duration-base ease-out hover:shadow-float motion-safe:hover:-translate-y-0.5',
        TILE_TONE[tone],
      )}
    >
      <div
        className={cn(
          'text-3xl font-black tabular-nums leading-none tracking-[-0.04em]',
          NUM_TONE[tone],
        )}
      >
        {value}
      </div>
      <div className="mt-2 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </div>
    </div>
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
  const [cols, setCols] = useState<Set<TicketColumnKey>>(() => new Set(TICKET_COLUMN_KEYS));
  const [showCols, setShowCols] = useState(false);

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
    // Full dataset, only the chosen columns (in canonical order).
    const chosen = TICKET_COLUMN_KEYS.filter((k) => cols.has(k));
    downloadWorkbook(
      reportFilename('reports-tickets', days),
      buildTicketsSheets(merged, tr, chosen),
    );
    toast.success(
      t('agentReports.exported', {
        count: merged.length,
        defaultValue: 'Exported {{count}} rows.',
      }),
    );
  };

  const toggleCol = (k: TicketColumnKey) =>
    setCols((prev) => {
      const next = new Set(prev);
      if (next.has(k)) {
        if (next.size > 1) next.delete(k); // keep at least one column
      } else {
        next.add(k);
      }
      return next;
    });

  const [page, setPage] = useState(1);
  const { sorted, sort, toggle } = useTableSort(merged, TICKET_SORT);
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const current = Math.min(page, pageCount);
  const pageRows = sorted.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const onSort = (key: string) => {
    toggle(key);
    setPage(1);
  };
  const sortProps = (key: string, align?: 'start' | 'end') => ({
    active: sort?.key === key,
    dir: sort?.dir ?? ('asc' as const),
    onSort: () => onSort(key),
    align,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-full bg-secondary/60 px-3 py-1.5 text-sm text-foreground ring-1 ring-border">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-border text-primary focus:ring-primary/60"
            checked={includeOrders}
            onChange={(e) => setIncludeOrders(e.currentTarget.checked)}
          />
          {t('agentReports.includeOrders', { defaultValue: 'Include order data' })}
        </label>
        {includeOrders && (
          <span className="text-2xs text-muted-foreground">
            {t('agentReports.ordersHint', {
              defaultValue: 'Fetches each customer’s latest order from Yiji (best-effort).',
            })}
          </span>
        )}
        <div className="relative ms-auto flex items-center gap-2">
          {/* Column picker — which columns land in the .xlsx (all by default). */}
          <button
            type="button"
            onClick={() => setShowCols((v) => !v)}
            aria-expanded={showCols}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium text-muted-foreground ring-1 ring-border transition-colors duration-fast hover:bg-secondary hover:text-foreground"
          >
            {t('agentReports.columns', { defaultValue: 'Columns' })}
            <span className="tabular-nums opacity-70">
              {cols.size}/{TICKET_COLUMN_KEYS.length}
            </span>
          </button>
          {showCols && (
            <>
              <button
                type="button"
                aria-hidden
                tabIndex={-1}
                className="fixed inset-0 z-30 cursor-default"
                onClick={() => setShowCols(false)}
              />
              <div className="absolute end-0 top-9 z-40 max-h-80 w-64 overflow-auto rounded-xl bg-card p-2 shadow-float ring-1 ring-foreground/10">
                <div className="flex items-center justify-between px-1.5 pb-1.5">
                  <span className="text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                    {t('agentReports.exportColumns', { defaultValue: 'Export columns' })}
                  </span>
                  <button
                    type="button"
                    className="text-2xs font-medium text-primary hover:underline"
                    onClick={() => setCols(new Set(TICKET_COLUMN_KEYS))}
                  >
                    {t('agentReports.selectAll', { defaultValue: 'All' })}
                  </button>
                </div>
                <ul className="space-y-0.5">
                  {TICKET_COLUMN_KEYS.map((k) => (
                    <li key={k}>
                      <label className="flex cursor-pointer items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-xs text-foreground hover:bg-secondary/60">
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 rounded border-border text-primary focus:ring-primary/60"
                          checked={cols.has(k)}
                          onChange={() => toggleCol(k)}
                        />
                        {t(TICKET_COLUMN_LABELS[k].key, {
                          defaultValue: TICKET_COLUMN_LABELS[k].def,
                        })}
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
          <Button size="sm" onClick={onExport}>
            {t('agentReports.exportExcel', { defaultValue: 'Export to Excel' })}
          </Button>
        </div>
      </div>

      <TableSurface>
        <Table>
          <thead>
            <tr>
              <SortTh {...sortProps('subject')}>
                {tr('agentReports.col.subject', { defaultValue: 'Subject' })}
              </SortTh>
              <SortTh {...sortProps('status')}>
                {tr('agentReports.col.status', { defaultValue: 'Status' })}
              </SortTh>
              <SortTh {...sortProps('priority')}>
                {tr('agentReports.col.priority', { defaultValue: 'Priority' })}
              </SortTh>
              <SortTh {...sortProps('contact')}>
                {tr('agentReports.col.contact', { defaultValue: 'Contact' })}
              </SortTh>
              <SortTh {...sortProps('agent')}>
                {tr('agentReports.col.agent', { defaultValue: 'Agent' })}
              </SortTh>
              <SortTh {...sortProps('firstResponse', 'end')}>
                {tr('agentReports.col.firstResponse', { defaultValue: 'First response' })}
              </SortTh>
              <Th>
                {tr('agentReports.col.firstResponseSla', { defaultValue: 'First response SLA' })}
              </Th>
              <SortTh {...sortProps('resolution', 'end')}>
                {tr('agentReports.col.resolutionMin', { defaultValue: 'Resolution (min)' })}
              </SortTh>
              {includeOrders && (
                <Th>{tr('agentReports.col.restaurant', { defaultValue: 'Restaurant' })}</Th>
              )}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((r) => (
              <Tr key={r.id}>
                <Td className="max-w-[16rem] truncate font-medium" title={r.subject}>
                  {r.subject}
                </Td>
                <Td>
                  <StatusPill value={r.status} />
                </Td>
                <Td>
                  <PriorityPill value={r.priority} />
                </Td>
                <Td className="max-w-[12rem] truncate text-muted-foreground">
                  {r.contactName || r.contactPhone || r.contactEmail || '—'}
                </Td>
                <Td className="text-muted-foreground">{r.agentName}</Td>
                <Td className="text-end tabular-nums text-muted-foreground">
                  {fmtMins(r.firstResponseMinutes)}
                </Td>
                <Td>
                  <SlaPill state={r.firstResponseState} />
                </Td>
                <Td className="text-end tabular-nums text-muted-foreground">
                  {r.resolutionMinutes == null ? '—' : Math.round(r.resolutionMinutes)}
                </Td>
                {includeOrders && (
                  <Td
                    className="max-w-[12rem] truncate text-muted-foreground"
                    title={r.order?.restaurant ?? ''}
                  >
                    {orders.isFetching && !r.order ? (
                      <span className="text-2xs opacity-60">…</span>
                    ) : (
                      (r.order?.restaurant ?? '—')
                    )}
                  </Td>
                )}
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableSurface>
      <Pagination
        page={current}
        pageCount={pageCount}
        onPage={setPage}
        prevLabel={t('agentReports.prev', { defaultValue: 'Previous' })}
        nextLabel={t('agentReports.next', { defaultValue: 'Next' })}
      />
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
  const { sorted, sort, toggle } = useTableSort(agents, AGENT_SORT);
  const sp = (key: string, align?: 'start' | 'end') => ({
    active: sort?.key === key,
    dir: sort?.dir ?? ('asc' as const),
    onSort: () => toggle(key),
    align,
  });

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
      <TableSurface>
        <Table>
          <thead>
            <tr>
              <SortTh {...sp('agent')}>
                {tr('agentReports.col.agent', { defaultValue: 'Agent' })}
              </SortTh>
              <SortTh {...sp('tickets', 'end')}>
                {tr('agentReports.col.tickets', { defaultValue: 'Tickets' })}
              </SortTh>
              <SortTh {...sp('avgFirstResponse', 'end')}>
                {tr('agentReports.col.avgFirstResponse', { defaultValue: 'Avg first response' })}
              </SortTh>
              <SortTh {...sp('firstResponsePct', 'end')}>
                {tr('agentReports.col.firstResponsePct', { defaultValue: 'First response SLA %' })}
              </SortTh>
              <SortTh {...sp('csatCount', 'end')}>
                {tr('agentReports.col.csatCount', { defaultValue: 'CSAT responses' })}
              </SortTh>
              <SortTh {...sp('csatAvg', 'end')}>
                {tr('agentReports.col.csatAvg', { defaultValue: 'CSAT avg (1–5)' })}
              </SortTh>
            </tr>
          </thead>
          <tbody>
            {sorted.map((a) => (
              <Tr key={a.agentId ?? '__unassigned__'}>
                <Td className="font-medium">{a.agentName}</Td>
                <Td className="text-end tabular-nums text-muted-foreground">{a.tickets}</Td>
                <Td className="text-end tabular-nums text-muted-foreground">
                  {fmtMins(a.avgFirstResponseMin)}
                </Td>
                <Td className="text-end tabular-nums text-muted-foreground">
                  {fmtPct(a.firstResponsePct)}
                </Td>
                <Td className="text-end tabular-nums text-muted-foreground">{a.csatCount}</Td>
                <Td className="text-end tabular-nums font-semibold">{fmtScore(a.csatAvg)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableSurface>
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
      t('agentReports.exported', { count: report.total, defaultValue: 'Exported {{count}} rows.' }),
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
        <div className="rounded-2xl bg-card p-5 ring-1 ring-foreground/[0.05] shadow-soft">
          <h3 className="mb-3 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {t('agentReports.byStatus', { defaultValue: 'By status' })}
          </h3>
          <ul className="space-y-2">
            {report.byStatus.map((s) => (
              <li key={s.key} className="flex items-center justify-between gap-2 text-sm">
                <StatusPill value={s.key} />
                <span className="tabular-nums font-semibold text-foreground">{s.count}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-2xl bg-card p-5 ring-1 ring-foreground/[0.05] shadow-soft">
          <h3 className="mb-3 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {t('agentReports.byPriority', { defaultValue: 'By priority' })}
          </h3>
          <ul className="space-y-2">
            {report.byPriority.map((p) => (
              <li key={p.key} className="flex items-center justify-between gap-2 text-sm">
                <PriorityPill value={p.key} />
                <span className="tabular-nums font-semibold text-foreground">{p.count}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <TableSurface>
        <Table>
          <thead>
            <tr>
              <Th>{tr('agentReports.col.date', { defaultValue: 'Date' })}</Th>
              <Th className="text-end">
                {tr('agentReports.col.total', { defaultValue: 'Total' })}
              </Th>
              {report.statuses.map((s) => (
                <Th key={s} className="text-end">
                  {tr(`status.${s}`, { ns: 'common', defaultValue: s })}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.map((d) => (
              <Tr key={d.day}>
                <Td className="tabular-nums text-muted-foreground">{d.day}</Td>
                <Td className="text-end tabular-nums font-semibold">{d.total}</Td>
                {report.statuses.map((s) => (
                  <Td key={s} className="text-end tabular-nums text-muted-foreground">
                    {d.byStatus[s] ?? 0}
                  </Td>
                ))}
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableSurface>
      <PreviewNote shown={preview.length} total={report.byDay.length} unit="days" />
    </div>
  );
}

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

/* ── Page — one instance per individual report (no tabs) ─────────────────── */

const META: Record<
  ReportKind,
  { titleKey: string; titleDefault: string; subKey: string; subDefault: string }
> = {
  tickets: {
    titleKey: 'agentReports.ticketsTitle',
    titleDefault: 'Tickets & orders',
    subKey: 'agentReports.ticketsSubtitle',
    subDefault: 'Every ticket with SLA timings and the linked customer order — export to Excel.',
  },
  agents: {
    titleKey: 'agentReports.agentsTitle',
    titleDefault: 'Agent KPI',
    subKey: 'agentReports.agentsSubtitle',
    subDefault: 'Per-agent first-response time, SLA compliance and CSAT — export to Excel.',
  },
  conversations: {
    titleKey: 'agentReports.conversationsTitle',
    titleDefault: 'Conversation status',
    subKey: 'agentReports.conversationsSubtitle',
    subDefault: 'Conversations by status, priority and day — export to Excel.',
  },
};

export function AgentReportsPage({ report: which }: { report: ReportKind }) {
  const { t } = useTranslation();
  const [days, setDays] = useState(30);
  const report = useAgentReportData(days, {
    unassigned: t('agentReports.unassigned', { defaultValue: 'Unassigned' }),
    noSubject: t('agentReports.noSubject', { defaultValue: '(no subject)' }),
  });
  const tr: Translate = (key, opts) => String(t(key, opts));
  const data = report.data;
  const meta = META[which];

  const isEmpty =
    which === 'tickets'
      ? !!data && data.tickets.length === 0
      : which === 'agents'
        ? !!data && data.agents.length === 0
        : !!data && data.conversations.total === 0;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t(meta.titleKey, { defaultValue: meta.titleDefault })}
        </h1>
        <ToolbarSpacer />
        <div className="w-32">
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
      </Toolbar>

      <div className="flex-1 overflow-auto px-5 py-4">
        <div className="mx-auto max-w-5xl space-y-5">
          {/* Clean editorial header — no gradient banner. */}
          <div className="border-b border-foreground/10 pb-5">
            <h2 className="text-2xl font-bold tracking-[-0.02em] text-foreground">
              {t(meta.titleKey, { defaultValue: meta.titleDefault })}
            </h2>
            <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {t(meta.subKey, { defaultValue: meta.subDefault })}
            </p>
          </div>

          {report.isLoading ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-20 rounded-2xl" />
                ))}
              </div>
              <Skeleton className="h-64 w-full rounded-2xl" />
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
                defaultValue:
                  'Widen the date range, or wait for tickets and conversations to land.',
              })}
            />
          ) : (
            <>
              {/* KPI strip — colored, report-relevant. */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <KpiTile
                  label={t('agentReports.kpiTickets', { defaultValue: 'Tickets' })}
                  value={String(data.tickets.length)}
                  tone="blue"
                />
                <KpiTile
                  label={t('agentReports.kpiConversations', { defaultValue: 'Conversations' })}
                  value={String(data.conversations.total)}
                  tone="violet"
                />
                <KpiTile
                  label={t('agentReports.kpiAgents', { defaultValue: 'Agents' })}
                  value={String(data.agents.filter((a) => a.agentId).length)}
                  tone="amber"
                />
                <KpiTile
                  label={t('agentReports.kpiCsat', { defaultValue: 'CSAT avg' })}
                  value={fmtScore(data.csatOverall.avg)}
                  tone="green"
                />
              </div>

              {which === 'tickets' && <TicketsReport rows={data.tickets} tr={tr} days={days} />}
              {which === 'agents' && <AgentKpiReport agents={data.agents} tr={tr} days={days} />}
              {which === 'conversations' && (
                <ConversationReport report={data.conversations} tr={tr} days={days} />
              )}

              <p className="pt-1 text-2xs text-muted-foreground">
                {t('agentReports.generatedAt', {
                  at: fmtDateTime(data.generatedAt),
                  defaultValue: 'Generated {{at}}',
                })}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
