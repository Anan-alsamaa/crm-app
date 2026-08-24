import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deleteItem, readUsers } from '@directus/sdk';
import { useTranslation } from 'react-i18next';
// Moved here when the Ticket report page was retired: the register belongs with
// the Tickets report, the workload table with Agent KPI.
import {
  Avatar,
  Button,
  cn,
  ConfirmDialog,
  DateField,
  Drawer,
  EmptyState,
  ExportButtons,
  InboxIcon,
  Input,
  MeterBar,
  Pagination,
  Pill,
  SelectMenu,
  Skeleton,
  SortTh,
  SparkleIcon,
  Table,
  TableFooterBar,
  TableSurface,
  Td,
  Th,
  TicketIcon,
  toast,
  Tr,
  type MetricTone,
  pageCountOf,
  ReportKpi,
  ReportKpiStrip,
  TablePager,
  UsersIcon,
  useTableSort,
  ZapIcon,
} from '@yiji/ui';
import { matchStore, isUnmappedStore, resolveStoreAttribution } from '@yiji/shared-types';
import {
  useAgentReportData,
  useTicketOrders,
  type AgentKpiRow,
  type ComplaintReportRow,
  type ConversationRow,
  type ConversationStatusReport,
  type SlaOutcome,
  type TicketReportRow,
} from './api.js';
import { useStoreIndex } from '../restaurants/api.js';
import { directus } from '../../lib/directus.js';
import { usePinnedWidth } from '../../lib/pinned-width.js';
import { ColumnScroller } from '../../components/ColumnScroller.js';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { useRememberedRange, isoDay } from '../../lib/date-range.js';
import { ReportFilterBar } from '../../components/ReportFilterBar.js';
import { ViewSwitch } from '../../components/ViewSwitch.js';
import { formatDuration } from '@yiji/reports';
import { TicketHistoryDrawer } from './TicketHistoryDrawer.js';
import {
  buildTicketsSheets,
  COMPLAINT_COLUMN_KEYS,
  COMPLAINT_COLUMN_LABELS,
  COMPLAINT_COLUMN_LAYOUT,
  fmtDateTime,
  reportFilename,
  TICKET_COLUMN_KEYS,
  TICKET_COLUMN_LABELS,
  type ComplaintColumnKey,
  type TicketColumnKey,
  type Translate,
} from './export.js';
import {
  complaintCell,
  countUnmappedComplaints,
  loadColumnOrder,
  saveColumnOrder,
  TICKET_REPORT_ORDER_KEY,
  downloadWorkbook,
  joinComplaintStores,
  distinctValues,
  exportCsv,
  filterTickets,
  isCompensated,
  isEmptyFilter,
  moveColumn,
  reconcileColumnOrder,
  type CsvColumn,
  type TicketFilterCriteria,
} from '@yiji/reports';

/** Which of the four exportable reports this page instance renders. */
export type ReportKind = 'tickets' | 'agents' | 'conversations' | 'complaints';
const RANGE_DAYS = [7, 30, 90] as const;

/** The remembered range, handed down so each report's filter bar can drive it. */
interface RangeProps {
  range: {
    from: string;
    to: string;
    setFrom: (v: string) => void;
    setTo: (v: string) => void;
    /** Both ends at once — what the quick-range shortcut writes. */
    setRange: (r: { from: string; to: string }) => void;
    reset: () => void;
  };
}

/**
 * "Last 7 / 30 / 90 days", rendered inside the filter bar beside the dates.
 *
 * A shortcut, not a second source of truth: picking a preset WRITES the two
 * dates next to it, so the shortcut and the fields can never disagree about
 * which period is on screen. It sat in a toolbar of its own until the toolbar
 * turned out to be 60px of screen saying what the tab strip above it already
 * said.
 */
function RangePreset({ range }: RangeProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <SelectMenu
      fullWidth
      value=""
      onChange={(v) => {
        const n = Number(v);
        const now = new Date();
        range.setRange({
          from: isoDay(new Date(now.getTime() - n * 86_400_000)),
          to: isoDay(now),
        });
      }}
      aria-label={t('agentReports.range', { defaultValue: 'Date range' })}
      options={[
        { value: '', label: t('agentReports.presets', { defaultValue: 'Quick range' }) },
        ...RANGE_DAYS.map((d) => ({
          value: String(d),
          label: t('agentReports.lastDays', {
            count: d,
            days: d,
            defaultValue: 'Last {{days}} days',
          }),
        })),
      ]}
    />
  );
}

const PRIORITY_TONE: Record<string, 'muted' | 'neutral' | 'warning' | 'destructive'> = {
  low: 'muted',
  medium: 'neutral',
  high: 'warning',
  urgent: 'destructive',
};
/* Board mapping: open reads sky, resolved jade, closed neutral. 'warning'
 * keeps the darkened-treatment pill (warning is a light token on its own). */
const STATUS_TONE: Record<
  string,
  'primary' | 'success' | 'warning' | 'muted' | 'neutral' | 'blue'
> = {
  new: 'primary',
  open: 'blue',
  pending: 'warning',
  resolved: 'success',
  closed: 'neutral',
};
const SLA_TONE: Record<SlaOutcome, 'success' | 'destructive' | 'warning' | 'muted'> = {
  met: 'success',
  breached: 'destructive',
  pending: 'warning',
  na: 'muted',
};
/* Meter accents for the breakdown cards. MetricTone deliberately has no
 * warning/amber (a light token), so mid tones fall back to jade/sky. */
const STATUS_METER: Record<string, MetricTone> = { open: 'sky', resolved: 'success' };
const PRIORITY_METER: Record<string, MetricTone> = { urgent: 'destructive', high: 'violet' };

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
  chats: (r) => r.chats,
  noReply: (r) => r.noReply,
  inTimePct: (r) => r.inTimePct,
  avgFirstResponseSec: (r) => r.avgFirstResponseSec,
  avgTimeToSolveSec: (r) => r.avgTimeToSolveSec,
  commonTaken: (r) => r.commonTaken,
  tickets: (r) => r.tickets,
  csatAvg: (r) => r.csatAvg,
};

/** Page + size state, with the clamping every paged table needs. */
function usePaged<T>(rows: T[], initialSize = 25) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialSize);
  const pageCount = pageCountOf(rows.length, pageSize);
  // Clamped rather than stored: filtering down while sitting on page 9 must
  // not strand the reader on a page that no longer exists.
  const current = Math.min(page, pageCount);
  const pageRows = useMemo(
    () => rows.slice((current - 1) * pageSize, current * pageSize),
    [rows, current, pageSize],
  );
  return { page: current, setPage, pageSize, setPageSize, pageRows };
}

/** The pager's strings, so all five reports say the same words. */
function usePagerLabels() {
  const { t } = useTranslation();
  return {
    rowsPerPage: String(t('complaintReport.rowsPerPage', { defaultValue: 'Rows per page' })),
    previous: String(t('agentReports.prev', { defaultValue: 'Previous' })),
    next: String(t('agentReports.next', { defaultValue: 'Next' })),
    showing: ({ from, to, total }: { from: number; to: number; total: number }) =>
      String(
        t('complaintReport.showingRange', {
          defaultValue: 'Showing {{from}}–{{to}} of {{total}}',
          from,
          to,
          total,
        }),
      ),
  };
}

/**
 * Rows per page for the report tables.
 *
 * Starts at 10 because a report opened to read wants a screenful, not a scroll;
 * runs to 500 because scanning for a pattern before exporting wants the lot.
 */
const REPORT_PAGE_SIZES = [10, 25, 50, 100, 250, 500] as const;

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

/**
 * A store-derived cell (brand / city / manager).
 *
 * Keeps three states apart on screen exactly as the export does: no order at
 * all is an em dash, an order whose branch is missing from Restaurants → Stores
 * is a visible "Not mapped" pill, and a resolved store shows its value. A blank
 * would read as "no order" and hide the gap that skews the by-store totals.
 */
function StoreTd({
  order,
  pick,
}: {
  order: TicketReportRow['order'];
  pick: (o: NonNullable<TicketReportRow['order']>) => string | undefined;
}) {
  const { t } = useTranslation();
  if (!order) return <Td className="text-muted-foreground">—</Td>;
  if (order.storeMapped === false)
    return (
      <Td>
        <Pill tone="warning" size="sm">
          {t('agentReports.notMapped', { defaultValue: 'Not mapped' })}
        </Pill>
      </Td>
    );
  return (
    <Td className="max-w-[10rem] truncate text-muted-foreground" title={pick(order) ?? ''}>
      {pick(order) || '—'}
    </Td>
  );
}

/* ── Report 1: Tickets + order data ───────────────────────────────────── */

/** One status tab: label + count, selected state carried by fill not just weight. */
function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors duration-fast',
        active
          ? 'bg-primary text-primary-foreground'
          : 'bg-secondary/60 text-muted-foreground ring-1 ring-border hover:text-foreground',
      )}
    >
      {label}
      <span
        className={cn('tabular-nums', active ? 'text-primary-foreground/80' : 'text-foreground/60')}
      >
        {count}
      </span>
    </button>
  );
}

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
  // Order data is ALWAYS fetched: the Tickets report exists to show tickets
  // ALONGSIDE the customer's order, so hiding it behind a checkbox made the
  // report's whole point opt-in. Kept as a const so the query below reads the
  // same as before.
  const includeOrders = true;
  const [cols, setCols] = useState<Set<TicketColumnKey>>(() => new Set(TICKET_COLUMN_KEYS));
  const [showCols, setShowCols] = useState(false);
  // Status filter, folded in from the register that used to duplicate this table.
  const [status, setStatus] = useState<string>('all');

  const contactIds = useMemo(
    () => rows.map((r) => r.contactId).filter((id): id is string => !!id),
    [rows],
  );
  const orders = useTicketOrders(contactIds, includeOrders, days);
  const ordersMap = orders.data;
  const { index: storeIndex } = useStoreIndex();

  const merged = useMemo<TicketReportRow[]>(() => {
    const withOrders = ordersMap
      ? rows.map((r) => {
          const order = r.contactId ? (ordersMap.get(r.contactId) ?? undefined) : undefined;
          if (!order) return { ...r, order: undefined };
          // Prefer the attribution frozen onto the ticket. Only fall back to a
          // live join for tickets raised before snapshots existed — otherwise
          // editing a store today would rewrite who owned a months-old ticket.
          // The order API gives a brand name and a "<city> - <branch>" string
          // and nothing else; city, managers and the canonical brand come from
          // the operations store master.
          const { match: m } = resolveStoreAttribution(r.storeSnapshot, () =>
            matchStore(storeIndex, {
              restaurantId: order.rawRestaurantId,
              restaurantName: order.rawRestaurantName,
              brandName: order.rawBrandName,
            }),
          );
          return {
            ...r,
            order: {
              ...order,
              // Once matched, show the branch as the OPERATIONS sheet names it
              // ("LCP-041 Masief Plaza"), not Yiji's "<brand> — <city> - <place>"
              // label: the brand now has its own column, so the raw label just
              // repeats it in different words. Unmatched rows keep Yiji's label
              // rather than going blank.
              restaurant: m.restaurantName || order.restaurant,
              brand: m.brandName,
              city: m.city,
              areaManager: m.areaManager,
              chainManager: m.chainManager,
              storeMapped: !isUnmappedStore(m),
            },
          };
        })
      : rows;
    return status === 'all'
      ? withOrders
      : withOrders.filter((r) => String(r.status).toLowerCase() === status);
  }, [rows, ordersMap, status, storeIndex]);

  /** Status tabs with live counts, built from the UNFILTERED rows so the numbers
   *  do not change as you filter — a count that moves with the filter tells you
   *  nothing about the dataset. */
  const statusCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const k = String(r.status).toLowerCase();
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const onExport = () => {
    if (merged.length === 0) {
      toast.error(t('agentReports.nothingToExport', { defaultValue: 'Nothing to export.' }));
      return;
    }
    // Full dataset, only the chosen columns (in canonical order).
    const chosen = TICKET_COLUMN_KEYS.filter((k) => cols.has(k));
    downloadWorkbook(reportFilename('Tickets', days), buildTicketsSheets(merged, tr, chosen));
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

  /** This report's own headline numbers, rolled up from the rows below. */
  const totals = useMemo(
    () => ({
      open: rows.filter((r) => String(r.status).toLowerCase() === 'open').length,
      urgent: rows.filter((r) => String(r.priority).toLowerCase() === 'urgent').length,
      breached: rows.filter((r) => r.firstResponseState === 'breached').length,
    }),
    [rows],
  );

  return (
    <div className="space-y-3">
      <ReportKpiStrip>
        <ReportKpi
          label={t('agentReports.kpiTickets', { defaultValue: 'Tickets' })}
          value={String(rows.length)}
          tone="blue"
          icon={<TicketIcon size={18} />}
        />
        <ReportKpi
          label={t('status.open', { ns: 'common', defaultValue: 'Open' })}
          value={String(totals.open)}
          tone="violet"
          icon={<InboxIcon size={18} />}
        />
        <ReportKpi
          label={t('priority.urgent', { ns: 'common', defaultValue: 'Urgent' })}
          value={String(totals.urgent)}
          tone="amber"
          icon={<ZapIcon size={18} />}
        />
        <ReportKpi
          label={t('slaReports.breached', { defaultValue: 'Breached' })}
          value={String(totals.breached)}
          tone="green"
          icon={<SparkleIcon size={18} />}
        />
      </ReportKpiStrip>

      {/* Pinned like the rest of the furniture: this bar acts on the table
          beside it, and a toolbar that slides out of the window when you scroll
          to the far columns is a toolbar you have to scroll back for. See
          usePinnedWidth. */}
      <div className="sticky start-0 flex w-[var(--pin-w,100%)] flex-wrap items-center gap-3">
        {/* Status filter, folded in from the register this table replaced. Counts
            come from the unfiltered set so they stay stable while filtering. */}
        <div className="flex flex-wrap items-center gap-1">
          <FilterChip
            label={t('agentReports.statusAll', { defaultValue: 'All' })}
            count={rows.length}
            active={status === 'all'}
            onClick={() => setStatus('all')}
          />
          {statusCounts.map(([k, n]) => (
            <FilterChip
              key={k}
              label={t(`status.${k}`, { ns: 'common', defaultValue: k })}
              count={n}
              active={status === k}
              onClick={() => setStatus(k)}
            />
          ))}
        </div>
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
                    {t('agentReports.exportColumns', { defaultValue: 'Rearrange columns' })}
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
                          className="h-3.5 w-3.5 rounded border-border accent-primary focus:ring-primary/60"
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

      <TableSurface flow>
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
                <>
                  <Th>{tr('agentReports.col.restaurant', { defaultValue: 'Restaurant' })}</Th>
                  <Th>{tr('agentReports.col.brand', { defaultValue: 'Brand' })}</Th>
                  <Th>{tr('agentReports.col.city', { defaultValue: 'City' })}</Th>
                  <Th>{tr('agentReports.col.areaManager', { defaultValue: 'Area manager' })}</Th>
                  <Th>{tr('agentReports.col.chainManager', { defaultValue: 'Chain manager' })}</Th>
                </>
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
                <Td className="max-w-[12rem] text-muted-foreground">
                  {r.contactName || r.contactPhone || r.contactEmail ? (
                    <span className="flex items-center gap-2">
                      <Avatar
                        size="xs"
                        name={r.contactName}
                        email={r.contactEmail}
                        phone={r.contactPhone}
                      />
                      <span className="min-w-0 truncate">
                        {r.contactName || r.contactPhone || r.contactEmail}
                      </span>
                    </span>
                  ) : (
                    '—'
                  )}
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
                  <>
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
                    <StoreTd order={r.order} pick={(o) => o.brand} />
                    <StoreTd order={r.order} pick={(o) => o.city} />
                    <StoreTd order={r.order} pick={(o) => o.areaManager} />
                    <StoreTd order={r.order} pick={(o) => o.chainManager} />
                  </>
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

/* ── Report 4: Complaints (the operations manager's own report) ───────── */

/**
 * The complaints report as operations already keep it by hand — same columns,
 * same order, same headings — produced from CRM data instead.
 *
 * The store columns (chain, area, brand, city, restaurant) are joined here
 * rather than in `api.ts` because this is where the store index lives. Unlike
 * the Tickets report this needs no live order lookup: everything it reports
 * comes from the ticket and its stored order snapshot, so a row keeps
 * reporting the same values however the upstream order later changes.
 */

function ComplaintsReport({
  rows,
  tr,
  days,
}: {
  rows: ComplaintReportRow[];
  tr: Translate;
  days: number;
}) {
  const { t } = useTranslation();
  /**
   * Which of the row actions this role is OFFERED.
   *
   * An operations role is here to read the register and take a copy of it, and
   * showing it Delete taught it by clicking that it could not. Hiding is not
   * securing — Directus refuses the write either way — but a button that only
   * ever fails is worse than no button.
   */
  const { can } = useAuth();
  const canSeeHistory = can('edit_all_tickets');
  const canDelete = can('delete_tickets');
  const canImport = can('import_data');
  const [cols, setCols] = useState<Set<ComplaintColumnKey>>(() => new Set(COMPLAINT_COLUMN_KEYS));
  const [showCols, setShowCols] = useState(false);
  const [colQuery, setColQuery] = useState('');
  /**
   * Row selection, ops-portal style: click a row, then the bar's Delete /
   * History buttons act on it. Actions moved OUT of the rows at the owner's
   * request — a 29-column sheet with a button in every row reads as clutter,
   * and selection is how their team already works.
   */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /* The row awaiting a delete confirmation — a product dialog, not the
     browser's own, which carries no voice and looks like a page error. */
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; label: string } | null>(null);
  const [historyOf, setHistoryOf] = useState<{ id: string; label: string } | null>(null);
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: (id: string) => directus.request(deleteItem('tickets' as never, id)),
    onSuccess: () => {
      setSelectedId(null);
      void qc.invalidateQueries({ queryKey: ['agent-reports'] });
      toast.success(t('complaintReport.deleted', { defaultValue: 'Ticket deleted.' }));
    },
    onError: () =>
      toast.error(
        t('complaintReport.deleteFailed', { defaultValue: 'Could not delete that ticket.' }),
      ),
  });
  /** Actor names for the history drawer — ids alone accuse nobody legibly. */
  const users = useQuery({
    queryKey: ['report-user-names'],
    staleTime: 5 * 60_000,
    queryFn: async () =>
      (await directus.request(
        readUsers({ limit: -1, fields: ['id', 'first_name', 'last_name', 'email'] }),
      )) as unknown as Array<{ id: string; first_name: string | null; email: string | null }>,
  });
  const userNames = useMemo(
    () =>
      new Map(
        (users.data ?? []).map((u) => [u.id, u.first_name?.trim() || u.email?.trim() || u.id]),
      ),
    [users.data],
  );

  /**
   * The filter, shared with the agent portal's own ticket queue so "find order
   * 946641" behaves identically wherever it is asked. See @yiji/reports.
   */
  const [criteria, setCriteria] = useState<TicketFilterCriteria>({});
  /*
   * What is typed but not yet asked for.
   *
   * These nine controls used to write straight through, so the table re-filtered
   * and re-paged on every keystroke and every half-typed date — moving under the
   * hands of somebody still deciding what to ask. Same bargain as the shared
   * ReportFilterBar: type freely, then Apply (or press Enter).
   */
  const [draft, setDraft] = useState<TicketFilterCriteria>({});
  /**
   * How many rows to show at once.
   *
   * This table is the whole operations history — thousands of rows — and the
   * right page size genuinely differs by task: 25 to read, 1000 to scan for a
   * pattern before exporting. Ten was neither.
   */
  const [pageSize, setPageSize] = useState(25);
  // The column ORDER, separate from which columns are on. Reconciled against
  // the current column list on load so a saved preference survives a column
  // being added or removed instead of silently dropping it.
  const [order, setOrder] = useState<ComplaintColumnKey[]>(() =>
    reconcileColumnOrder(loadColumnOrder(TICKET_REPORT_ORDER_KEY), COMPLAINT_COLUMN_KEYS),
  );
  const { index: storeIndex } = useStoreIndex();

  // Shared with the agent portal's own complaints table, so the same complaint
  // is attributed to the same branch in both. See @yiji/reports.
  const joined = useMemo<ComplaintReportRow[]>(
    () => joinComplaintStores(rows, storeIndex),
    [rows, storeIndex],
  );
  const unmapped = useMemo(() => countUnmappedComplaints(joined), [joined]);

  /*
   * COMPLETE ROWS ONLY, by default.
   *
   * This is the operations report — one row per complaint, in the shape the
   * team already files them. A row missing its branch, its service type, how
   * it reached us or the order it is about is not a lighter version of that:
   * it is a row that falls out of every cut on the dashboard and exports as a
   * line of empty cells. Sixty-eight of them arrived from the end-to-end test
   * suite, which seeds against this same database.
   *
   * SHOWN, NOT SWALLOWED. Filtering silently is the failure this codebase
   * keeps repeating: something matches nothing and the result reads as a
   * plausible answer. So the count of hidden rows is stated above the table
   * with a control to show them, and the export follows whatever is on screen.
   */
  const isComplete = (r: (typeof joined)[number]) =>
    Boolean(
      r.restaurantName &&
      r.complaintType &&
      r.serviceType &&
      r.complaintSource &&
      r.orderNumber &&
      r.date,
    );
  const [showIncomplete, setShowIncomplete] = useState(false);
  const incompleteCount = useMemo(() => joined.filter((r) => !isComplete(r)).length, [joined]);
  const complete = useMemo(
    () => (showIncomplete ? joined : joined.filter(isComplete)),
    [joined, showIncomplete],
  );
  const visible = useMemo(() => filterTickets(complete, criteria), [complete, criteria]);

  /**
   * Dropdown options built from the ROWS IN RANGE rather than from the enums.
   *
   * A city list of every city the company has ever operated in, on a report
   * covering last week, is a menu to read past — and choosing one of the absent
   * values returns an empty table that looks like a bug rather than an answer.
   */
  const options = useMemo(
    () => ({
      complaintType: distinctValues(joined, 'complaintType'),
      complaintStatus: distinctValues(joined, 'complaintStatus'),
      brand: distinctValues(joined, 'brand'),
      city: distinctValues(joined, 'city'),
      agent: distinctValues(joined, 'agent'),
      serviceType: distinctValues(joined, 'serviceType'),
      complaintSource: distinctValues(joined, 'complaintSource'),
      compensation: distinctValues(joined, 'compensation'),
    }),
    [joined],
  );

  const setCriterion = (patch: Partial<TicketFilterCriteria>) =>
    setDraft((c) => ({ ...c, ...patch }));

  /** Push the draft through. A filtered set is a different set, so page 7 of it
   *  means nothing — every apply lands on page 1. */
  const applyFilters = () => {
    setCriteria(draft);
    setPage(1);
  };
  const clearFilters = () => {
    setDraft({});
    setCriteria({});
    setPage(1);
  };
  const filtersDirty = JSON.stringify(draft) !== JSON.stringify(criteria);

  /** The column currently being dragged in the picker, if any. */
  const [dragKey, setDragKey] = useState<ComplaintColumnKey | null>(null);
  /** Columns that are ON, in the order the user arranged them. */
  const chosenColumns = useMemo(() => order.filter((k) => cols.has(k)), [order, cols]);

  const moveCol = (key: ComplaintColumnKey, delta: number) =>
    setOrder((prev) => {
      const from = prev.indexOf(key);
      const next = moveColumn(prev, from, from + delta);
      saveColumnOrder(TICKET_REPORT_ORDER_KEY, next);
      return next;
    });

  /**
   * Export the filtered view, or everything in the date range.
   *
   * The view is the default and stays the default: the filter is part of the
   * question being asked, and a file quietly containing rows the person
   * filtered out is how a "your report is wrong" argument starts. But someone
   * who narrowed to one brand to READ it often wants the whole set to SEND on,
   * and re-clearing six filters to get there is tedious and easy to half-do.
   *
   * The chosen columns follow in both cases — a column somebody turned off is
   * not data they filtered out, it is data they said they did not want to see.
   */
  const onExport = (scope: 'view' | 'all') => {
    /* "All" means every row the page is SHOWING, not every row in the join.
       Exporting past the completeness filter would hand somebody a file with
       the empty rows the screen just told them were hidden. */
    const rowsOut = scope === 'all' ? complete : visible;
    if (rowsOut.length === 0) {
      toast.error(t('agentReports.nothingToExport', { defaultValue: 'Nothing to export.' }));
      return;
    }
    // The columns you chose, in the order you arranged them, rendered by the
    // same function the cells use — so the file cannot say something different
    // from the screen that produced it.
    exportCsv(
      reportFilename('Tickets', days, 'csv'),
      chosenColumns.map((k) => ({
        header: tr(COMPLAINT_COLUMN_LABELS[k].key, {
          defaultValue: COMPLAINT_COLUMN_LABELS[k].def,
        }),
        value: (r: ComplaintReportRow) => complaintCell(r, k, tr),
      })),
      rowsOut,
    );
    toast.success(
      t('agentReports.exported', {
        count: rowsOut.length,
        defaultValue: 'Exported {{count}} rows.',
      }),
    );
  };

  const toggleCol = (k: ComplaintColumnKey) =>
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
  const pagerLabels = usePagerLabels();

  /**
   * Sort accessors for every column, built from the cell renderer.
   *
   * Deriving them means a column can never be sortable-but-wrong, and a new
   * column is sortable the day it is added. Three kinds need more than the
   * rendered text:
   *  - numbers, or "10" sorts before "9";
   *  - the date, because the cell renders dd/mm/yyyy and sorting that string
   *    groups every month together across years;
   *  - time, which is HH:mm and happens to sort correctly as text.
   */
  const sortAccessors = useMemo(() => {
    const acc: Record<string, (r: ComplaintReportRow) => string | number | null> = {};
    for (const k of COMPLAINT_COLUMN_KEYS) {
      acc[k] = (r) => {
        if (k === 'date') return r.date; // ISO, so it sorts chronologically
        const raw = complaintCell(r, k, tr);
        if (raw == null || raw === '') return null;
        if (COMPLAINT_COLUMN_LAYOUT[k] === 'number') {
          const n = Number(raw);
          return Number.isFinite(n) ? n : null;
        }
        return String(raw).toLowerCase();
      };
    }
    return acc;
  }, [tr]);

  const { sorted, sort, toggle } = useTableSort(visible, sortAccessors);

  const pageCount = pageCountOf(visible.length, pageSize);
  const current = Math.min(page, pageCount);
  const pageRows = sorted.slice((current - 1) * pageSize, current * pageSize);

  /**
   * This report's own headline numbers, counted over the FILTERED set so the
   * tiles answer the question actually on screen. A summary that ignores the
   * filter under it is a summary of a different report.
   */
  const totals = useMemo(
    () => ({
      compensated: visible.filter(isCompensated).length,
      branches: new Set(visible.map((r) => r.restaurantName).filter(Boolean)).size,
      unmapped: countUnmappedComplaints(visible),
    }),
    [visible],
  );

  /** A labelled dropdown built from the values actually present. */
  const FilterSelect = ({
    label,
    field,
    values,
    value,
  }: {
    label: string;
    field: keyof TicketFilterCriteria;
    values: string[];
    value: string | undefined;
  }) =>
    values.length === 0 ? null : (
      <label className="flex flex-col gap-1">
        <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {label}
        </span>
        <SelectMenu
          size="sm"
          className="w-[10rem]"
          aria-label={label}
          value={value ?? ''}
          onChange={(v) => setCriterion({ [field]: v } as Partial<TicketFilterCriteria>)}
          options={[
            { value: '', label: t('complaintReport.any', { defaultValue: 'Any' }) },
            ...values.map((v) => ({ value: v, label: v })),
          ]}
        />
      </label>
    );

  return (
    <div className="space-y-3">
      <ReportKpiStrip>
        <ReportKpi
          label={t('agentReports.kpiTickets', { defaultValue: 'Tickets' })}
          value={String(visible.length)}
          hint={
            visible.length === complete.length
              ? undefined
              : String(
                  t('complaintReport.ofTotal', {
                    total: complete.length,
                    defaultValue: 'of {{total}} in range',
                  }),
                )
          }
          tone="blue"
          icon={<TicketIcon size={18} />}
        />
        <ReportKpi
          label={t('compensation.yes', { ns: 'common', defaultValue: 'Compensated' })}
          value={String(totals.compensated)}
          hint={
            visible.length > 0 ? fmtPct((totals.compensated / visible.length) * 100) : undefined
          }
          tone="violet"
          icon={<SparkleIcon size={18} />}
        />
        <ReportKpi
          label={t('complaintReport.kpiBranches', { defaultValue: 'Branches' })}
          value={String(totals.branches)}
          tone="green"
          icon={<UsersIcon size={18} />}
        />
        <ReportKpi
          label={t('agentReports.notMapped', { defaultValue: 'Not mapped' })}
          value={String(totals.unmapped)}
          tone="amber"
          icon={<InboxIcon size={18} />}
        />
      </ReportKpiStrip>

      {/* WHAT IS BEING HIDDEN, said out loud.
          Filtering incomplete rows away silently is the failure this codebase
          keeps repeating — something matches nothing and the shortfall reads
          as a plausible answer. The count is stated and the rows are one click
          away. */}
      {incompleteCount > 0 && (
        <div className="sticky start-0 flex w-[var(--pin-w,100%)] flex-wrap items-center gap-2 rounded-xl bg-warning-tint px-3.5 py-2 text-2xs leading-relaxed text-foreground ring-1 ring-inset ring-warning/25">
          <span>
            {showIncomplete
              ? t('complaintReport.incompleteShown', {
                  count: incompleteCount,
                  defaultValue:
                    'Including {{count}} tickets with fields missing — they carry no branch, service type, channel or order.',
                })
              : t('complaintReport.incompleteHidden', {
                  count: incompleteCount,
                  defaultValue:
                    '{{count}} tickets are hidden because fields are missing — no branch, service type, channel or order.',
                })}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="ms-auto h-7"
            onClick={() => {
              setShowIncomplete((v) => !v);
              setPage(1);
            }}
          >
            {showIncomplete
              ? t('complaintReport.hideIncomplete', { defaultValue: 'Hide them' })
              : t('complaintReport.showIncomplete', { defaultValue: 'Show them' })}
          </Button>
        </div>
      )}

      {/* The filter bar. Free text first because it answers most questions on
          its own; the dropdowns are for slicing rather than finding. */}
      {/* Pinned, like the rest of the furniture — see usePinnedWidth. Without
          the explicit width it would be laid out at the TABLE's width (the
          stack is `w-max` so sticky has room to work), which is a filter card
          five thousand pixels wide with its controls huddled at one end. */}
      <form
        // A real form, so Enter anywhere inside it applies — the reflex anybody
        // typing into a search box already has.
        onSubmit={(e) => {
          e.preventDefault();
          applyFilters();
        }}
        className="sticky start-0 w-[var(--pin-w,100%)] space-y-3 rounded-2xl bg-card p-3 shadow-soft ring-1 ring-foreground/[0.06]"
      >
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-1 flex-col gap-1" style={{ minWidth: '18rem' }}>
            <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {t('complaintReport.searchLabel', {
                defaultValue: 'Search by phone, restaurant name or restaurant id',
              })}
            </span>
            {/* One box rather than five labelled fields: operations look a
                complaint up by whatever they have to hand, and deciding which
                field a number belongs to is work the computer can do. */}
            <Input
              value={draft.query ?? ''}
              onChange={(e) => setCriterion({ query: e.target.value })}
              className="h-8"
              placeholder={t('complaintReport.searchPlaceholder', {
                defaultValue: 'Order number, phone, branch, or a word from the ticket…',
              })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {t('performance.from', { defaultValue: 'From' })}
            </span>
            <DateField
              size="sm"
              className="w-[9rem]"
              value={draft.from ?? ''}
              onChange={(v) => setCriterion({ from: v })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {t('performance.to', { defaultValue: 'To' })}
            </span>
            <DateField
              size="sm"
              className="w-[9rem]"
              value={draft.to ?? ''}
              onChange={(v) => setCriterion({ to: v })}
            />
          </label>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <FilterSelect
            label={t('complaintReport.col.complaintType', { defaultValue: 'Ticket type' })}
            field="complaintType"
            values={options.complaintType}
            value={draft.complaintType}
          />
          <FilterSelect
            label={t('complaintReport.col.complaintStatus', { defaultValue: 'Status' })}
            field="status"
            values={options.complaintStatus}
            value={draft.status}
          />
          <FilterSelect
            label={t('complaintReport.col.brand', { defaultValue: 'Brand' })}
            field="brand"
            values={options.brand}
            value={draft.brand}
          />
          <FilterSelect
            label={t('complaintReport.col.city', { defaultValue: 'City' })}
            field="city"
            values={options.city}
            value={draft.city}
          />
          <FilterSelect
            label={t('complaintReport.col.agent', { defaultValue: 'Agent' })}
            field="agent"
            values={options.agent}
            value={draft.agent}
          />
          <FilterSelect
            label={t('complaintReport.col.serviceType', { defaultValue: 'Service type' })}
            field="serviceType"
            values={options.serviceType}
            value={draft.serviceType}
          />
          <FilterSelect
            label={t('complaintReport.col.complaintSource', { defaultValue: 'Source' })}
            field="source"
            values={options.complaintSource}
            value={draft.source}
          />
          <FilterSelect
            label={t('complaintReport.col.compensation', { defaultValue: 'Compensation' })}
            field="compensation"
            values={options.compensation}
            value={draft.compensation}
          />
          <div className="ms-auto flex items-end gap-2">
            {(!isEmptyFilter(criteria) || !isEmptyFilter(draft)) && (
              <Button size="sm" variant="ghost" className="h-8" onClick={clearFilters}>
                {t('complaintReport.clearFilters', { defaultValue: 'Clear filters' })}
              </Button>
            )}
            {/* Always present, disabled when nothing is waiting: a button that
                comes and goes is one people stop looking for, and its disabled
                state is what says "the table already matches these". */}
            <Button type="submit" size="sm" className="h-8" disabled={!filtersDirty}>
              {filtersDirty
                ? t('complaintReport.applyPending', { defaultValue: 'Apply changes' })
                : t('complaintReport.apply', { defaultValue: 'Apply' })}
            </Button>
          </div>
        </div>
      </form>

      {/* Pinned like the rest of the furniture: this bar acts on the table
          beside it, and a toolbar that slides out of the window when you scroll
          to the far columns is a toolbar you have to scroll back for. See
          usePinnedWidth. */}
      <div className="sticky start-0 flex w-[var(--pin-w,100%)] flex-wrap items-center gap-3">
        {unmapped > 0 && (
          <Pill tone="warning" size="sm">
            {t('complaintReport.unmappedStores', {
              count: unmapped,
              defaultValue: '{{count}} rows with an unmapped store',
            })}
          </Pill>
        )}
        <div className="relative ms-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowCols((v) => !v)}
            aria-expanded={showCols}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium text-muted-foreground ring-1 ring-border transition-colors duration-fast hover:bg-secondary hover:text-foreground"
          >
            {t('agentReports.columns', { defaultValue: 'Columns' })}
            <span className="tabular-nums opacity-70">
              {cols.size}/{COMPLAINT_COLUMN_KEYS.length}
            </span>
          </button>
          {/* A real dialog, not a dropdown: arranging 29 columns is a task, and
              a task needs room, a title that says what the order controls, a
              search, and a way to leave deliberately. The cramped popover was
              the actual complaint. */}
          <Drawer
            open={showCols}
            onClose={() => setShowCols(false)}
            title={t('agentReports.exportColumns', { defaultValue: 'Columns' })}
            description={t('complaintReport.columnsHelp', {
              defaultValue:
                'Drag a row to reorder. The order here is the order in the table and the export.',
            })}
            width="lg"
            footer={
              <Button onClick={() => setShowCols(false)}>
                {t('actions.done', { ns: 'common', defaultValue: 'Done' })}
              </Button>
            }
          >
            <div className="flex h-full flex-col">
              <div className="space-y-2 border-b border-border p-4">
                <div className="flex items-center justify-between">
                  <span className="text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                    {t('complaintReport.shownCount', {
                      defaultValue: '{{n}} of {{m}} shown',
                      n: cols.size,
                      m: COMPLAINT_COLUMN_KEYS.length,
                    })}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="text-2xs font-medium text-primary hover:underline"
                      onClick={() => setCols(new Set(COMPLAINT_COLUMN_KEYS))}
                    >
                      {t('agentReports.selectAll', { defaultValue: 'All' })}
                    </button>
                    <button
                      type="button"
                      className="text-2xs font-medium text-muted-foreground hover:text-foreground hover:underline"
                      onClick={() => {
                        const next = [...COMPLAINT_COLUMN_KEYS];
                        setOrder(next);
                        saveColumnOrder(TICKET_REPORT_ORDER_KEY, next);
                      }}
                    >
                      {t('complaintReport.resetOrder', { defaultValue: 'Reset order' })}
                    </button>
                  </div>
                </div>
                <Input
                  value={colQuery}
                  onChange={(e) => setColQuery(e.target.value)}
                  className="h-7 text-xs"
                  aria-label={t('complaintReport.findColumn', { defaultValue: 'Find a column' })}
                  placeholder={t('complaintReport.findColumn', {
                    defaultValue: 'Find a column…',
                  })}
                />
              </div>
              <ul className="flex-1 space-y-0.5 overflow-auto p-3">
                {order.map((k, i) => {
                  const label = t(COMPLAINT_COLUMN_LABELS[k].key, {
                    defaultValue: COMPLAINT_COLUMN_LABELS[k].def,
                  });
                  // Filtering hides rows but never renumbers them: the
                  // position shown is the real position in the report.
                  if (colQuery.trim() && !label.toLowerCase().includes(colQuery.toLowerCase())) {
                    return null;
                  }
                  return (
                    <li
                      key={k}
                      draggable
                      onDragStart={(e) => {
                        setDragKey(k);
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                      onDragEnd={() => setDragKey(null)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (!dragKey || dragKey === k) return;
                        setOrder((prev) => {
                          const from = prev.indexOf(dragKey);
                          const to = prev.indexOf(k);
                          if (from < 0 || to < 0) return prev;
                          const next = moveColumn(prev, from, to);
                          saveColumnOrder(TICKET_REPORT_ORDER_KEY, next);
                          return next;
                        });
                        setDragKey(null);
                      }}
                      className={cn(
                        'flex items-center gap-1 rounded-lg',
                        dragKey === k && 'opacity-40',
                      )}
                    >
                      {/* Drag to reorder — arranging 29 columns two rows at a
                            time with arrows was the actual complaint. The
                            arrows stay as the keyboard-reachable path. */}
                      <span
                        aria-hidden
                        className="shrink-0 cursor-grab select-none px-1 text-muted-foreground/60 active:cursor-grabbing"
                        title={t('complaintReport.dragHint', {
                          defaultValue: 'Drag to reorder',
                        })}
                      >
                        ⠿
                      </span>
                      <span className="w-5 shrink-0 text-end text-2xs tabular-nums text-muted-foreground/70">
                        {i + 1}
                      </span>
                      <label className="flex flex-1 cursor-pointer items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-xs text-foreground hover:bg-secondary/60">
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 rounded border-border accent-primary focus:ring-primary/60"
                          checked={cols.has(k)}
                          onChange={() => toggleCol(k)}
                        />
                        {label}
                      </label>
                      <button
                        type="button"
                        disabled={i === 0}
                        onClick={() => moveCol(k, -1)}
                        aria-label={t('complaintReport.moveUp', {
                          col: label,
                          defaultValue: 'Move {{col}} earlier',
                        })}
                        className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-30"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        disabled={i === order.length - 1}
                        onClick={() => moveCol(k, 1)}
                        aria-label={t('complaintReport.moveDown', {
                          col: label,
                          defaultValue: 'Move {{col}} later',
                        })}
                        className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-30"
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        disabled={i === 0}
                        onClick={() => moveCol(k, -i)}
                        aria-label={t('complaintReport.moveFirst', {
                          col: label,
                          defaultValue: 'Move {{col}} to the front',
                        })}
                        title={t('complaintReport.moveFirst', {
                          col: label,
                          defaultValue: 'Move {{col}} to the front',
                        })}
                        className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-30"
                      >
                        ⤒
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </Drawer>
          {/* Says the COUNT, so nobody has to wonder whether "export" means the
              page in front of them. It never has — it has always exported the
              whole filtered set — but a promise that has to be trusted is one
              that gets re-tested by hand every single time. */}
          <ExportButtons
            visibleCount={visible.length}
            totalCount={complete.length}
            onExportView={() => onExport('view')}
            onExportAll={() => onExport('all')}
            labelPlain={t('agentReports.exportCsvCount', {
              count: visible.length,
              defaultValue: 'Export CSV ({{count}})',
            })}
            labelView={t('agentReports.exportCsvFiltered', {
              count: visible.length,
              defaultValue: 'Export {{count}} shown',
            })}
            labelAll={t('agentReports.exportCsvAll', {
              count: complete.length,
              defaultValue: 'Export all {{count}}',
            })}
          />
          {/* Selection-driven actions, ops-portal style: pick a row, then act
              from here. Disabled — not hidden — without a selection, so the
              affordance teaches its own precondition. */}
          {canSeeHistory && (
            <Button
              size="sm"
              variant="ghost"
              className="ring-1 ring-border"
              disabled={!selectedId}
              onClick={() => {
                const row = visible.find((v) => v.id === selectedId);
                if (row)
                  setHistoryOf({
                    id: row.id,
                    label:
                      [row.complaintType, row.orderNumber].filter(Boolean).join(' · ') || row.id,
                  });
              }}
            >
              {t('complaintReport.historyBtn', { defaultValue: 'History' })}
            </Button>
          )}
          {canDelete && (
            <Button
              size="sm"
              variant="ghost"
              disabled={!selectedId || del.isPending}
              className="text-destructive ring-1 ring-border hover:bg-destructive/10"
              onClick={() => {
                const row = visible.find((v) => v.id === selectedId);
                if (!row) return;
                const label =
                  [row.complaintType, row.orderNumber].filter(Boolean).join(' · ') || row.id;
                setConfirmDelete({ id: row.id, label });
              }}
            >
              {t('complaintReport.deleteBtn', { defaultValue: 'Delete' })}
            </Button>
          )}
          {canImport && (
            <Button
              size="sm"
              variant="ghost"
              className="ring-1 ring-border"
              disabled
              title={t('complaintReport.importDisabled', {
                defaultValue: 'Importing is disabled',
              })}
            >
              {t('complaintReport.importBtn', { defaultValue: 'Import file' })}
            </Button>
          )}
        </div>
      </div>

      {historyOf && (
        <TicketHistoryDrawer
          ticketId={historyOf.id}
          label={historyOf.label}
          userNames={userNames}
          onClose={() => setHistoryOf(null)}
        />
      )}

      {/* Every chosen column, in the chosen order — the table and the export
          are the same report, so showing a curated subset here just meant the
          screen and the file disagreed. Wide by nature, so it scrolls
          horizontally inside its own surface rather than stretching the page. */}
      <TableSurface flow scrollLabel={t('complaintReport.title', { defaultValue: 'Tickets' })}>
        <Table>
          <thead>
            <tr>
              <Th className="w-10">
                <span className="sr-only">
                  {t('complaintReport.selectCol', { defaultValue: 'Select' })}
                </span>
              </Th>
              {chosenColumns.map((k) => (
                <SortTh
                  key={k}
                  active={sort?.key === k}
                  dir={sort?.dir ?? 'asc'}
                  align={COMPLAINT_COLUMN_LAYOUT[k] === 'number' ? 'end' : 'start'}
                  onSort={() => {
                    toggle(k);
                    // A different order is a different page 7.
                    setPage(1);
                  }}
                >
                  {tr(COMPLAINT_COLUMN_LABELS[k].key, {
                    defaultValue: COMPLAINT_COLUMN_LABELS[k].def,
                  })}
                </SortTh>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((r) => (
              <Tr
                key={r.id}
                onClick={() => setSelectedId((cur) => (cur === r.id ? null : r.id))}
                aria-selected={selectedId === r.id}
                className={cn(
                  'cursor-pointer',
                  selectedId === r.id && 'bg-primary/10 hover:bg-primary/10',
                )}
              >
                <Td className="w-10">
                  {/* The visible affordance the owner asked for — a highlighted
                      row alone did not read as "selected". */}
                  <input
                    type="checkbox"
                    className="h-4 w-4 cursor-pointer rounded border-border text-primary focus:ring-primary/60"
                    checked={selectedId === r.id}
                    onChange={() => setSelectedId((cur) => (cur === r.id ? null : r.id))}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={t('complaintReport.selectRow', {
                      label: [r.complaintType, r.orderNumber].filter(Boolean).join(' · ') || r.id,
                      defaultValue: 'Select {{label}}',
                    })}
                  />
                </Td>
                {chosenColumns.map((k) => {
                  // An unresolved store says so instead of showing a blank
                  // cell, exactly as the export does.
                  const unmapped =
                    !r.storeMapped &&
                    (r.restaurantName || r.brand) &&
                    (['chain', 'area', 'brand', 'city'] as ComplaintColumnKey[]).includes(k);
                  const layout = COMPLAINT_COLUMN_LAYOUT[k];
                  const text = String(complaintCell(r, k, tr) ?? '');
                  return (
                    <Td
                      key={k}
                      className={cn(
                        layout === 'text' ? 'align-top' : 'whitespace-nowrap',
                        layout === 'number' && 'text-end tabular-nums',
                      )}
                    >
                      {unmapped ? (
                        <Pill tone="warning" size="sm">
                          {t('agentReports.notMapped', { defaultValue: 'Not mapped' })}
                        </Pill>
                      ) : k === 'complaintStatus' && text ? (
                        /* Status as a tag pill — the same translated text the
                           export writes, toned off the RAW status value. */
                        <Pill
                          tone={STATUS_TONE[r.complaintStatus.toLowerCase()] ?? 'neutral'}
                          size="sm"
                        >
                          {text}
                        </Pill>
                      ) : layout === 'text' ? (
                        /* Fixed width on an inner block, not a max-width on the
                           cell: the table is `min-w-max`, under which a td's
                           max-width is ignored and the prose sets the column
                           width anyway. Two lines, with the whole value on
                           hover and all of it in the export. */
                        <span className="line-clamp-2 block w-[20rem] leading-snug" title={text}>
                          {text}
                        </span>
                      ) : (
                        text
                      )}
                    </Td>
                  );
                })}
              </Tr>
            ))}
          </tbody>
        </Table>
        {/* Footer aggregate band — the row count that used to float above the
            table now reads as part of it, boards-style: same strings, same
            numbers, anchored under the data they describe. */}
        <TableFooterBar>
          <span className="font-medium tabular-nums">
            {isEmptyFilter(criteria)
              ? t('complaintReport.rowCount', {
                  count: complete.length,
                  defaultValue: '{{count}} rows',
                })
              : t('complaintReport.matches', {
                  count: visible.length,
                  total: complete.length,
                  defaultValue: '{{count}} of {{total}}',
                })}
          </span>
        </TableFooterBar>
      </TableSurface>

      <TablePager
        page={current}
        onPage={setPage}
        pageSize={pageSize}
        onPageSize={setPageSize}
        total={visible.length}
        pageSizes={REPORT_PAGE_SIZES}
        labels={pagerLabels}
      />
      <ConfirmDialog
        open={!!confirmDelete}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (confirmDelete) del.mutate(confirmDelete.id);
          setConfirmDelete(null);
        }}
        destructive
        title={t('complaintReport.deleteTitle', { defaultValue: 'Delete this ticket?' })}
        description={t('complaintReport.deleteConfirm', {
          label: confirmDelete?.label ?? '',
          defaultValue:
            'Delete “{{label}}”? The record is removed; who deleted it stays in the change history.',
        })}
        confirmLabel={t('actions.delete', { ns: 'common', defaultValue: 'Delete' })}
        cancelLabel={t('actions.cancel', { ns: 'common' })}
      />
    </div>
  );
}

/* ── Report 2: Agent KPI ──────────────────────────────────────────────── */

function AgentKpiReport({
  agents,
  tr,
  days,
  range,
}: {
  agents: AgentKpiRow[];
  tr: Translate;
  days: number;
} & RangeProps) {
  const { t } = useTranslation();
  const pagerLabels = usePagerLabels();
  const [query, setQuery] = useState('');

  /**
   * This report's own headline numbers, rolled up from the rows below.
   *
   * "Answered in time" is weighted by the chats each agent's percentage was
   * measured over. A plain mean of the column would let somebody with two chats
   * move the company number as far as somebody with two hundred — and the tile
   * would then disagree with the table it sits on top of.
   */
  const totals = useMemo(() => {
    const answeredOf = (a: AgentKpiRow) => Math.max(0, a.chats - a.noReply);
    const answered = agents.reduce((n, a) => n + answeredOf(a), 0);
    const inTime = agents.reduce(
      (n, a) => (a.inTimePct == null ? n : n + (a.inTimePct / 100) * answeredOf(a)),
      0,
    );
    const csatCount = agents.reduce((n, a) => n + a.csatCount, 0);
    const csatSum = agents.reduce(
      (n, a) => (a.csatAvg == null ? n : n + a.csatAvg * a.csatCount),
      0,
    );
    return {
      agents: agents.filter((a) => a.agentId).length,
      chats: agents.reduce((n, a) => n + a.chats, 0),
      inTimePct: answered > 0 ? (inTime / answered) * 100 : null,
      csatAvg: csatCount > 0 ? csatSum / csatCount : null,
    };
  }, [agents]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? agents.filter((a) => a.agentName.toLowerCase().includes(q)) : agents;
  }, [agents, query]);

  const { sorted, sort, toggle } = useTableSort(filtered, AGENT_SORT);
  const { page, setPage, pageSize, setPageSize, pageRows } = usePaged(sorted, 25);

  const sp = (key: string, align?: 'start' | 'end') => ({
    active: sort?.key === key,
    dir: sort?.dir ?? ('asc' as const),
    onSort: () => {
      toggle(key);
      setPage(1);
    },
    align,
  });

  /** The columns of the table, as the file. Same order, same headings. */
  const csvColumns: CsvColumn<AgentKpiRow>[] = [
    { header: tr('agentReports.col.agent', { defaultValue: 'Agent' }), value: (a) => a.agentName },
    { header: tr('agentReports.col.chats', { defaultValue: 'Chats' }), value: (a) => a.chats },
    {
      header: tr('agentReports.col.noReply', { defaultValue: 'Not replied' }),
      value: (a) => a.noReply,
    },
    {
      header: tr('agentReports.col.inTime', { defaultValue: 'Replied within 5 min' }),
      // The screen shows a percentage sign; the file gives the number, so the
      // column can be averaged in a spreadsheet without stripping characters.
      value: (a) => (a.inTimePct == null ? null : Math.round(a.inTimePct)),
    },
    {
      header: tr('agentReports.col.firstResponseAvg', { defaultValue: 'First response (avg)' }),
      value: (a) => formatDuration(a.avgFirstResponseSec),
    },
    {
      header: tr('agentReports.col.timeToSolve', { defaultValue: 'Time to solve (avg)' }),
      value: (a) => formatDuration(a.avgTimeToSolveSec),
    },
    {
      header: tr('agentReports.col.commonTaken', { defaultValue: 'Common chats taken' }),
      value: (a) => a.commonTaken,
    },
    {
      header: tr('agentReports.col.tickets', { defaultValue: 'Tickets' }),
      value: (a) => a.tickets,
    },
    {
      header: tr('agentReports.col.csatAvg', { defaultValue: 'Customer rating (1-5)' }),
      value: (a) => a.csatAvg,
    },
  ];

  const onExport = (scope: 'view' | 'all') => {
    const rowsOut = scope === 'all' ? agents : sorted;
    if (rowsOut.length === 0) {
      toast.error(t('agentReports.nothingToExport', { defaultValue: 'Nothing to export.' }));
      return;
    }
    exportCsv(reportFilename('Agent KPI', days, 'csv'), csvColumns, rowsOut);
    toast.success(
      t('agentReports.exported', {
        count: rowsOut.length,
        defaultValue: 'Exported {{count}} rows.',
      }),
    );
  };

  return (
    <div className="space-y-3">
      <ReportKpiStrip>
        <ReportKpi
          label={t('agentReports.kpiAgents', { defaultValue: 'Agents' })}
          value={String(totals.agents)}
          tone="blue"
          icon={<UsersIcon size={18} />}
        />
        <ReportKpi
          label={t('agentReports.col.chats', { defaultValue: 'Chats' })}
          value={String(totals.chats)}
          tone="violet"
          icon={<InboxIcon size={18} />}
        />
        <ReportKpi
          label={t('agentReports.col.inTime', { defaultValue: 'Replied within 5 min' })}
          value={fmtPct(totals.inTimePct)}
          tone="amber"
          icon={<ZapIcon size={18} />}
        />
        <ReportKpi
          label={t('agentReports.kpiCsat', { defaultValue: 'Customer rating' })}
          value={fmtScore(totals.csatAvg)}
          tone="green"
          icon={<SparkleIcon size={18} />}
        />
      </ReportKpiStrip>

      <ReportFilterBar
        searchLabel={t('agentReports.searchAgent', { defaultValue: 'Search agent' })}
        searchPlaceholder={t('agentReports.searchAgentHint', {
          defaultValue: 'Agent name',
        })}
        search={query}
        onSearch={(v) => {
          setQuery(v);
          setPage(1);
        }}
        from={range.from}
        to={range.to}
        onFrom={range.setFrom}
        onTo={range.setTo}
        filtering={query.trim() !== ''}
        onClear={() => {
          setQuery('');
          range.reset();
          setPage(1);
        }}
        actions={
          <ExportButtons
            visibleCount={sorted.length}
            totalCount={agents.length}
            onExportView={() => onExport('view')}
            onExportAll={() => onExport('all')}
            labelPlain={t('agentReports.exportCsvCount', {
              count: sorted.length,
              defaultValue: 'Export CSV ({{count}})',
            })}
            labelView={t('agentReports.exportCsvFiltered', {
              count: sorted.length,
              defaultValue: 'Export {{count}} shown',
            })}
            labelAll={t('agentReports.exportCsvAll', {
              count: agents.length,
              defaultValue: 'Export all {{count}}',
            })}
          />
        }
        rangePreset={<RangePreset range={range} />}
      />

      <TableSurface flow scrollLabel={t('agentReports.agentsTitle', { defaultValue: 'Agent KPI' })}>
        <Table>
          <thead>
            <tr>
              <SortTh {...sp('agent')}>
                {tr('agentReports.col.agent', { defaultValue: 'Agent' })}
              </SortTh>
              <SortTh {...sp('chats', 'end')}>
                {tr('agentReports.col.chats', { defaultValue: 'Chats' })}
              </SortTh>
              <SortTh {...sp('noReply', 'end')}>
                {tr('agentReports.col.noReply', { defaultValue: 'Not replied' })}
              </SortTh>
              <SortTh {...sp('inTimePct', 'end')}>
                {tr('agentReports.col.inTime', { defaultValue: 'Replied within 5 min' })}
              </SortTh>
              <SortTh {...sp('avgFirstResponseSec', 'end')}>
                {tr('agentReports.col.firstResponseAvg', { defaultValue: 'First response (avg)' })}
              </SortTh>
              <SortTh {...sp('avgTimeToSolveSec', 'end')}>
                {tr('agentReports.col.timeToSolve', { defaultValue: 'Time to solve (avg)' })}
              </SortTh>
              <SortTh {...sp('commonTaken', 'end')}>
                {tr('agentReports.col.commonTaken', { defaultValue: 'Common chats taken' })}
              </SortTh>
              <SortTh {...sp('tickets', 'end')}>
                {tr('agentReports.col.tickets', { defaultValue: 'Tickets' })}
              </SortTh>
              <SortTh {...sp('csatAvg', 'end')}>
                {tr('agentReports.col.csatAvg', { defaultValue: 'Customer rating (1-5)' })}
              </SortTh>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((a) => (
              <Tr key={a.agentId ?? '__unassigned__'}>
                <Td className="font-medium">{a.agentName}</Td>
                <Td className="text-end tabular-nums font-semibold">{a.chats}</Td>
                <Td className="text-end tabular-nums">
                  {a.noReply > 0 ? (
                    <span className="font-semibold text-destructive">{a.noReply}</span>
                  ) : (
                    <span className="text-muted-foreground">0</span>
                  )}
                </Td>
                <Td className="text-end tabular-nums text-muted-foreground">
                  {a.inTimePct == null ? (
                    '—'
                  ) : (
                    /* Number + thin meter, boards-style: the magnitude stays
                       tabular, the bar makes the laggard visible at a scan. */
                    <span className="flex items-center justify-end gap-2">
                      <MeterBar
                        value={a.inTimePct}
                        tone={
                          a.inTimePct >= 90
                            ? 'success'
                            : a.inTimePct >= 75
                              ? 'primary'
                              : 'destructive'
                        }
                        className="w-12"
                      />
                      {fmtPct(a.inTimePct)}
                    </span>
                  )}
                </Td>
                <Td className="text-end tabular-nums text-muted-foreground">
                  {formatDuration(a.avgFirstResponseSec) ?? '—'}
                </Td>
                <Td className="text-end tabular-nums text-muted-foreground">
                  {formatDuration(a.avgTimeToSolveSec) ?? '—'}
                </Td>
                <Td className="text-end tabular-nums">
                  {a.commonTaken > 0 ? (
                    <span className="font-semibold text-success">{a.commonTaken}</span>
                  ) : (
                    <span className="text-muted-foreground">0</span>
                  )}
                </Td>
                <Td className="text-end tabular-nums text-muted-foreground">{a.tickets}</Td>
                <Td className="text-end tabular-nums font-semibold">{fmtScore(a.csatAvg)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
        {/* Footer aggregate band, boards-style — reuses the KPI tile's label so
            the band adds no new strings. */}
        <TableFooterBar>
          <span className="flex items-baseline gap-1.5">
            <span className="font-semibold tabular-nums text-foreground">{sorted.length}</span>
            <span className="text-2xs font-semibold uppercase tracking-[0.12em]">
              {t('agentReports.kpiAgents', { defaultValue: 'Agents' })}
            </span>
          </span>
        </TableFooterBar>
      </TableSurface>

      <TablePager
        page={page}
        onPage={setPage}
        pageSize={pageSize}
        onPageSize={setPageSize}
        total={sorted.length}
        pageSizes={REPORT_PAGE_SIZES}
        labels={pagerLabels}
      />
    </div>
  );
}

/* ── Report 3: Conversation status ────────────────────────────────────── */

function ConversationReport({
  report,
  tr,
  days,
  range,
}: {
  report: ConversationStatusReport;
  tr: Translate;
  days: number;
} & RangeProps) {
  const { t } = useTranslation();
  const pagerLabels = usePagerLabels();
  /** Which status box is expanded, showing the customers behind its count. */
  const [drill, setDrill] = useState<string | null>(null);
  /*
   * Which of this report's two tables is on screen.
   *
   * They answer different questions — the chat list is "which", the day matrix
   * is "how many, when" — and both are worth having. Stacked, they were worth
   * having in theory: each one asked for the height left below it, so on a
   * laptop the pair resolved to two 260px boxes, three rows apiece, one of them
   * below the fold. And the Export button sat between them exporting only the
   * first, with nothing on screen saying so.
   *
   * One at a time. Each gets the full height, and the export writes whatever
   * you are looking at.
   */
  const [view, setView] = useState<'chats' | 'byDay' | 'breakdown'>('chats');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [agent, setAgent] = useState('');
  const [priority, setPriority] = useState('');

  /** This report's own headline numbers, read off the rows underneath. */
  const totals = useMemo(() => {
    const open = report.byStatus.find((s) => s.key === 'open')?.count ?? 0;
    const urgent = report.byPriority
      .filter((p) => p.key === 'urgent' || p.key === 'high')
      .reduce((n, p) => n + p.count, 0);
    // The day the queue was heaviest — the one number on this report that says
    // WHEN rather than how many, and the reason anybody staffs differently.
    const busiest = report.byDay.reduce<{ day: string; total: number } | null>(
      (best, d) => (best == null || d.total > best.total ? { day: d.day, total: d.total } : best),
      null,
    );
    return { open, urgent, busiest };
  }, [report]);

  /** Options built from the rows in range, never from an enum. */
  const agentOptions = useMemo(
    () =>
      [...new Set(report.rows.map((r) => r.agentName).filter(Boolean))]
        .sort()
        .map((v) => ({ value: v, label: v })),
    [report.rows],
  );
  const priorityOptions = useMemo(
    () =>
      report.byPriority.map((p) => ({
        value: p.key,
        label: String(t(`priority.${p.key}`, { ns: 'common', defaultValue: p.key })),
      })),
    [report.byPriority, t],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return report.rows.filter((r) => {
      if (status && r.status !== status) return false;
      if (agent && r.agentName !== agent) return false;
      if (priority && r.priority !== priority) return false;
      if (!q) return true;
      return (
        r.customerName.toLowerCase().includes(q) ||
        r.customerPhone.toLowerCase().includes(q) ||
        r.customerEmail.toLowerCase().includes(q) ||
        r.agentName.toLowerCase().includes(q) ||
        r.orderId.toLowerCase().includes(q)
      );
    });
  }, [report.rows, query, status, agent, priority]);

  const { page, setPage, pageSize, setPageSize, pageRows } = usePaged(visible, 25);

  /** The conversations table, as the file. */
  const csvColumns: CsvColumn<ConversationRow>[] = [
    {
      header: tr('agentReports.col.customer', { defaultValue: 'Customer' }),
      value: (r) => r.customerName,
    },
    {
      header: tr('agentReports.col.phone', { defaultValue: 'Phone' }),
      value: (r) => r.customerPhone,
    },
    {
      header: tr('agentReports.col.status', { defaultValue: 'Status' }),
      value: (r) => String(t(`status.${r.status}`, { ns: 'common', defaultValue: r.status })),
    },
    {
      header: tr('agentReports.col.priority', { defaultValue: 'Priority' }),
      value: (r) => String(t(`priority.${r.priority}`, { ns: 'common', defaultValue: r.priority })),
    },
    { header: tr('agentReports.col.agent', { defaultValue: 'Agent' }), value: (r) => r.agentName },
    {
      header: tr('agentReports.col.orderNumber', { defaultValue: 'Order' }),
      value: (r) => r.orderId,
    },
    {
      header: tr('agentReports.col.lastMessage', { defaultValue: 'Last message' }),
      value: (r) => (r.lastMessageAt ? fmtDateTime(r.lastMessageAt) : null),
    },
  ];

  /** The day matrix, as the file — one column per status, same as on screen. */
  const dayCsvColumns: CsvColumn<(typeof report.byDay)[number]>[] = [
    { header: tr('agentReports.col.date', { defaultValue: 'Date' }), value: (d) => d.day },
    {
      header: tr('agentReports.col.total', { defaultValue: 'Total' }),
      value: (d) => d.total,
    },
    ...report.statuses.map((st) => ({
      header: String(t(`status.${st}`, { ns: 'common', defaultValue: st })),
      value: (d: (typeof report.byDay)[number]) => d.byStatus[st] ?? 0,
    })),
  ];

  /**
   * Export what is ON SCREEN.
   *
   * It used to export the chat list whatever you were looking at, because the
   * chat list was the only thing it knew how to write — so scrolling down to
   * the day matrix and pressing Export handed you a different table with no
   * warning. Now the button belongs to the view.
   */
  const onExport = (scope: 'view' | 'all') => {
    if (view === 'byDay') {
      if (report.byDay.length === 0) {
        toast.error(t('agentReports.nothingToExport', { defaultValue: 'Nothing to export.' }));
        return;
      }
      exportCsv(reportFilename('Chats by day', days, 'csv'), dayCsvColumns, report.byDay);
      toast.success(
        t('agentReports.exported', {
          count: report.byDay.length,
          defaultValue: 'Exported {{count}} rows.',
        }),
      );
      return;
    }
    const rowsOut = scope === 'all' ? report.rows : visible;
    if (rowsOut.length === 0) {
      toast.error(t('agentReports.nothingToExport', { defaultValue: 'Nothing to export.' }));
      return;
    }
    exportCsv(reportFilename('Conversations', days, 'csv'), csvColumns, rowsOut);
    toast.success(
      t('agentReports.exported', {
        count: rowsOut.length,
        defaultValue: 'Exported {{count}} rows.',
      }),
    );
  };

  return (
    <div className="space-y-3">
      <ReportKpiStrip>
        <ReportKpi
          label={t('agentReports.kpiConversations', { defaultValue: 'Chats' })}
          value={String(report.total)}
          tone="blue"
          icon={<InboxIcon size={18} />}
        />
        <ReportKpi
          label={t('status.open', { ns: 'common', defaultValue: 'Open' })}
          value={String(totals.open)}
          tone="violet"
          icon={<TicketIcon size={18} />}
        />
        <ReportKpi
          label={t('agentReports.kpiUrgent', { defaultValue: 'Urgent + high' })}
          value={String(totals.urgent)}
          tone="amber"
          icon={<ZapIcon size={18} />}
        />
        <ReportKpi
          label={t('agentReports.kpiBusiestDay', { defaultValue: 'Busiest day' })}
          value={totals.busiest ? String(totals.busiest.total) : '—'}
          hint={totals.busiest?.day}
          tone="green"
          icon={<SparkleIcon size={18} />}
        />
      </ReportKpiStrip>

      <ViewSwitch
        label={t('agentReports.conversationsTitle', { defaultValue: 'Chat status' })}
        value={view}
        onChange={setView}
        options={[
          {
            value: 'chats',
            label: t('agentReports.viewChats', { defaultValue: 'Chats' }),
            count: report.rows.length,
          },
          {
            value: 'byDay',
            label: t('agentReports.byDay', { defaultValue: 'By day' }),
            count: report.byDay.length,
          },
          {
            value: 'breakdown',
            label: t('agentReports.viewBreakdown', { defaultValue: 'Breakdown' }),
          },
        ]}
      />

      {/* A VIEW, not a permanent band. These two boxes are a genuinely useful
          read — the status one drills through to the customers behind each
          count — but they are 240px, and sitting above the chat list they put
          its first row 559px down a laptop screen. Given a tab of their own
          they cost the list nothing and get the room to be read properly. */}
      {view === 'breakdown' && (
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="rounded-2xl bg-card p-3 ring-1 ring-foreground/[0.06] shadow-soft">
            <h3 className="mb-2 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {t('agentReports.byStatus', { defaultValue: 'By status' })}
            </h3>
            <ul className="space-y-2">
              {report.byStatus.map((s) => {
                const open = drill === s.key;
                return (
                  <li key={s.key}>
                    {/* Clicking a count opens the customers behind it. "20 open"
                      is a number; twenty phone numbers is a morning's work, and
                      the whole reason somebody looks at this box. */}
                    <button
                      type="button"
                      onClick={() => setDrill(open ? null : s.key)}
                      aria-expanded={open}
                      className="flex w-full items-center justify-between gap-2 rounded-lg px-1.5 py-1 text-sm transition-colors duration-fast hover:bg-secondary/60"
                    >
                      <StatusPill value={s.key} />
                      <MeterBar
                        value={report.total > 0 ? (s.count / report.total) * 100 : 0}
                        tone={STATUS_METER[s.key] ?? 'primary'}
                        className="ms-auto w-16 shrink-0"
                      />
                      <span className="tabular-nums font-semibold text-foreground">{s.count}</span>
                      <span aria-hidden className="text-2xs text-muted-foreground">
                        {open ? '▴' : '▾'}
                      </span>
                    </button>
                    {open && (
                      <ul className="mt-1.5 max-h-64 space-y-1 overflow-auto rounded-xl bg-secondary/40 p-2">
                        {report.rows
                          .filter((r) => r.status === s.key)
                          .map((r) => (
                            <li
                              key={r.id}
                              className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs"
                            >
                              <span className="font-mono tabular-nums text-foreground">
                                {r.customerPhone ||
                                  r.customerName ||
                                  r.customerEmail ||
                                  t('agentReports.noContact', {
                                    defaultValue: 'no contact on file',
                                  })}
                              </span>
                              {r.customerPhone && r.customerName && (
                                <span className="text-muted-foreground">{r.customerName}</span>
                              )}
                              {r.orderId && (
                                <span className="font-mono text-2xs text-muted-foreground">
                                  #{r.orderId}
                                </span>
                              )}
                              <span className="ms-auto text-2xs text-muted-foreground">
                                {r.agentName}
                              </span>
                            </li>
                          ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
          <div className="rounded-2xl bg-card p-3 ring-1 ring-foreground/[0.06] shadow-soft">
            <h3 className="mb-2 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {t('agentReports.byPriority', { defaultValue: 'By priority' })}
            </h3>
            <ul className="space-y-1.5">
              {report.byPriority.map((p) => (
                <li key={p.key} className="flex items-center gap-2 px-1.5 text-sm">
                  <PriorityPill value={p.key} />
                  <MeterBar
                    value={report.total > 0 ? (p.count / report.total) * 100 : 0}
                    tone={PRIORITY_METER[p.key] ?? 'sky'}
                    className="ms-auto w-16 shrink-0"
                  />
                  <span className="tabular-nums font-semibold text-foreground">{p.count}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* Breakdown reads the whole range and has nothing to search, so the bar
          would sit there looking broken. Dates still drive it — they are set
          from the other two views, which is where a reader changes them. */}
      {view !== 'breakdown' && (
        <ReportFilterBar
          searchLabel={t('agentReports.searchConversations', {
            defaultValue: 'Search customer, phone, agent or order',
          })}
          searchPlaceholder={t('agentReports.searchConversationsHint', {
            defaultValue: 'Customer, phone, agent or order number',
          })}
          search={query}
          onSearch={(v) => {
            setQuery(v);
            setPage(1);
          }}
          from={range.from}
          to={range.to}
          onFrom={range.setFrom}
          onTo={range.setTo}
          selects={[
            {
              key: 'status',
              label: t('agentReports.col.status', { defaultValue: 'Status' }),
              value: status,
              onChange: (v) => {
                setStatus(v);
                setPage(1);
              },
              options: report.byStatus.map((s) => ({
                value: s.key,
                label: String(t(`status.${s.key}`, { ns: 'common', defaultValue: s.key })),
              })),
            },
            {
              key: 'agent',
              label: t('agentReports.col.agent', { defaultValue: 'Agent' }),
              value: agent,
              onChange: (v) => {
                setAgent(v);
                setPage(1);
              },
              options: agentOptions,
            },
            {
              key: 'priority',
              label: t('agentReports.col.priority', { defaultValue: 'Priority' }),
              value: priority,
              onChange: (v) => {
                setPriority(v);
                setPage(1);
              },
              options: priorityOptions,
            },
          ]}
          filtering={Boolean(query.trim() || status || agent || priority)}
          onClear={() => {
            setQuery('');
            setStatus('');
            setAgent('');
            setPriority('');
            range.reset();
            setPage(1);
          }}
          actions={
            <ExportButtons
              visibleCount={visible.length}
              totalCount={report.rows.length}
              onExportView={() => onExport('view')}
              onExportAll={() => onExport('all')}
              labelPlain={t('agentReports.exportCsvCount', {
                count: visible.length,
                defaultValue: 'Export CSV ({{count}})',
              })}
              labelView={t('agentReports.exportCsvFiltered', {
                count: visible.length,
                defaultValue: 'Export {{count}} shown',
              })}
              labelAll={t('agentReports.exportCsvAll', {
                count: report.rows.length,
                defaultValue: 'Export all {{count}}',
              })}
            />
          }
          rangePreset={<RangePreset range={range} />}
        />
      )}

      {/* The conversations themselves, with who they are with. The day matrix
          answers "how many"; this answers "which", which is what somebody
          reading a status report is about to go and do something about.

          It used to stop dead at fifty rows with a note saying so and no way to
          reach row fifty-one — the export was the only route to the rest. */}
      {view === 'chats' && (
        <>
          <TableSurface
            flow
            scrollLabel={t('agentReports.conversationsTitle', { defaultValue: 'Chat status' })}
          >
            <Table>
              <thead>
                <tr>
                  <Th>{tr('agentReports.col.customer', { defaultValue: 'Customer' })}</Th>
                  <Th>{tr('agentReports.col.phone', { defaultValue: 'Phone' })}</Th>
                  <Th>{tr('agentReports.col.status', { defaultValue: 'Status' })}</Th>
                  <Th>{tr('agentReports.col.priority', { defaultValue: 'Priority' })}</Th>
                  <Th>{tr('agentReports.col.agent', { defaultValue: 'Agent' })}</Th>
                  <Th>{tr('agentReports.col.orderNumber', { defaultValue: 'Order' })}</Th>
                  <Th>{tr('agentReports.col.lastMessage', { defaultValue: 'Last message' })}</Th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r) => (
                  <Tr key={r.id}>
                    <Td className="font-medium">
                      {r.customerName ? (
                        <span className="flex items-center gap-2">
                          <Avatar size="xs" name={r.customerName} phone={r.customerPhone} />
                          <span className="min-w-0 truncate">{r.customerName}</span>
                        </span>
                      ) : (
                        t('agentReports.noName', { defaultValue: '—' })
                      )}
                    </Td>
                    <Td className="font-mono tabular-nums text-muted-foreground">
                      {r.customerPhone || '—'}
                    </Td>
                    <Td>
                      <StatusPill value={r.status} />
                    </Td>
                    <Td>
                      <PriorityPill value={r.priority} />
                    </Td>
                    <Td className="text-muted-foreground">{r.agentName}</Td>
                    <Td className="font-mono tabular-nums text-muted-foreground">
                      {r.orderId || '—'}
                    </Td>
                    <Td className="tabular-nums text-muted-foreground">
                      {r.lastMessageAt ? fmtDateTime(r.lastMessageAt) : '—'}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            <TableFooterBar>
              <span className="font-medium tabular-nums">
                {visible.length === report.rows.length
                  ? t('complaintReport.rowCount', {
                      count: report.rows.length,
                      defaultValue: '{{count}} rows',
                    })
                  : t('complaintReport.matches', {
                      count: visible.length,
                      total: report.rows.length,
                      defaultValue: '{{count}} of {{total}}',
                    })}
              </span>
            </TableFooterBar>
          </TableSurface>

          <TablePager
            page={page}
            onPage={setPage}
            pageSize={pageSize}
            onPageSize={setPageSize}
            total={visible.length}
            pageSizes={REPORT_PAGE_SIZES}
            labels={pagerLabels}
          />
        </>
      )}

      {/* Every day in range, not the last fourteen. The matrix is at most one
          row per day, so capping it bought nothing and cost the reader the
          first half of their own date range. */}
      {view === 'byDay' && (
        <TableSurface flow scrollLabel={t('agentReports.byDay', { defaultValue: 'By day' })}>
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
              {report.byDay.map((d) => (
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
          <TableFooterBar>
            <span className="font-medium tabular-nums">
              {t('agentReports.dayCount', {
                count: report.byDay.length,
                defaultValue: '{{count}} days',
              })}
            </span>
          </TableFooterBar>
        </TableSurface>
      )}
    </div>
  );
}

/* ── Page — one instance per individual report (no tabs) ─────────────────── */

const META: Record<
  ReportKind,
  { titleKey: string; titleDefault: string; subKey: string; subDefault: string }
> = {
  tickets: {
    titleKey: 'agentReports.ticketsTitle',
    titleDefault: 'Tickets',
    subKey: 'agentReports.ticketsSubtitle',
    subDefault: 'Every ticket with SLA timings and the linked customer order — export to CSV.',
  },
  agents: {
    titleKey: 'agentReports.agentsTitle',
    titleDefault: 'Agent summary',
    subKey: 'agentReports.agentsSubtitle',
    // Names the object it counts. Three surfaces report response times now and
    // their numbers will never agree, because tickets and chats are different
    // things — saying which is which is cheaper than explaining the gap every
    // time somebody spots it.
    subDefault:
      'One row per agent: how many chats they handled, how quickly they replied, and how customers rated them.',
  },
  conversations: {
    titleKey: 'agentReports.conversationsTitle',
    titleDefault: 'Conversation status',
    subKey: 'agentReports.conversationsSubtitle',
    subDefault:
      'Conversations by status, priority and day — search, page through them, or export to CSV.',
  },
  complaints: {
    titleKey: 'complaintReport.title',
    titleDefault: 'Tickets',
    subKey: 'complaintReport.subtitle',
    subDefault:
      'Every ticket in the operations report format. Search by phone, restaurant name or ID; rearrange the columns under the Columns button; export to CSV.',
  },
};

export function AgentReportsPage({ report: which }: { report: ReportKind }) {
  const { t } = useTranslation();
  /**
   * One remembered range, shared by all three reports under this page.
   *
   * Whatever you last looked at is what you get back — on the next report, and
   * after a refresh. Only when nothing is stored does it fall back to the last
   * month up to today.
   */
  const {
    from,
    to,
    setFrom,
    setTo,
    setRange,
    reset: resetRange,
  } = useRememberedRange('sara.reports.range');
  const report = useAgentReportData(
    0,
    {
      unassigned: t('agentReports.unassigned', { defaultValue: 'Unassigned' }),
      noSubject: t('agentReports.noSubject', { defaultValue: '(no subject)' }),
    },
    { from, to },
  );
  /** Days the range actually covers — the export file name says the period. */
  const days = useMemo(() => {
    const a = Date.parse(from);
    const b = Date.parse(to);
    return Number.isFinite(a) && Number.isFinite(b)
      ? Math.max(1, Math.round((b - a) / 86_400_000))
      : 30;
  }, [from, to]);
  const tr: Translate = (key, opts) => String(t(key, opts));
  const pinRef = usePinnedWidth();
  const data = report.data;
  const meta = META[which];

  /**
   * An empty RESULT is not an empty page.
   *
   * The shell used to replace the whole body — filter bar included — the
   * moment a range returned nothing, so narrowing to a quiet month left you
   * looking at "no data" with no dates on screen to widen. The only way out
   * was the browser back button. The reports render their own empty tables
   * now, and the controls that got you here stay put; the emptiness check
   * that drove that branch went with it.
   */

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* NO VERTICAL PADDING ON THE SCROLLPORT.
                 `position: sticky; top: 0` pins to the scrollport's CONTENT
                 box, so 20px of padding here left a 20px band above the pinned
                 header with rows sliding through it — a strip of half-visible
                 checkboxes over the column names. The spacing moves inside,
                 where it is spacing rather than a gap in the sticky ceiling. */}
      {/* A VISIBLE horizontal bar.
                 The app's global scrollbar thumb is deliberately faint, which
                 is right for a page and wrong for the one control that reaches
                 half a report's columns — at 12px and near-transparent at the
                 very foot of the window it was easy to miss that the table
                 continued at all. Paired with <ColumnScroller/>, which says how
                 many columns are hidden and pages through them. */}
      <div
        ref={pinRef}
        className="[&::-webkit-scrollbar]:h-3.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-foreground/25 hover:[&::-webkit-scrollbar-thumb]:bg-foreground/40 [&::-webkit-scrollbar-track]:bg-foreground/[0.06] [scrollbar-width:auto] flex-1 overflow-auto px-4 sm:px-6 lg:px-8"
      >
        {/* Every report gets the whole monitor.
            The summaries used to be capped at 5xl-6xl on the theory that a KPI
            strip stretched across 1920px is four numbers with a metre of white
            between them. True of the strip, and false of the TABLE underneath
            it — the cap was the reason nine columns needed a sideways swipe on
            a screen with room for twenty. The strip stays capped on its own
            (see ReportKpiStrip usages); the table gets the width. */}
        <div className="w-max min-w-full space-y-3 py-4 sm:py-5">
          {/* Name and purpose on ONE line.
              They used to be three bands: a 60px toolbar carrying the name, a
              paragraph carrying the purpose, and the gaps between them — about
              90px, on a page where the table was already starting 585px down a
              screen that is often 620 CSS pixels tall.
              The name stays, as a real h1: the tab strip above shows it as a
              selected pill, but a pill is not a heading and a page with no
              heading is a page a screen reader cannot summarise. The purpose
              rides beside it and drops away on narrow screens, where there is
              no room and the reader has the tab strip anyway. */}
          <div className="sticky start-0 flex w-[var(--pin-w,100%)] flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="shrink-0 text-sm font-semibold tracking-tight text-foreground">
              {t(meta.titleKey, { defaultValue: meta.titleDefault })}
            </h1>
            <p className="min-w-0 max-w-3xl text-xs leading-relaxed text-muted-foreground">
              {t(meta.subKey, { defaultValue: meta.subDefault })}
            </p>
          </div>

          {report.isLoading ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-28 rounded-2xl" />
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
          ) : !data ? (
            <EmptyState
              title={t('agentReports.empty', { defaultValue: 'No data in this window' })}
              description={t('agentReports.emptyHint', {
                defaultValue: 'Widen the date range, or wait for tickets and chats to land.',
              })}
            />
          ) : (
            <>
              {/* No KPI strip here any more. It lived in the shell, so all
                  three reports showed the SAME four numbers — total tickets,
                  total conversations, agent count, overall CSAT — whichever
                  report you had opened. Each report now rolls up its own rows
                  and renders its own strip, which is the only way a summary can
                  be a summary OF something. */}
              {which === 'tickets' && (
                <>
                  {/* ONE table. The register that used to sit below duplicated
                      these same tickets with different column names, which read as
                      two sources of truth for one dataset. This table wins because
                      it already carries the order columns and the Excel export;
                      the register's status filter was folded into it. */}
                  <TicketsReport rows={data.tickets} tr={tr} days={days} />
                </>
              )}
              {which === 'agents' && (
                <>
                  {/* ONE table. The workload table moved here from the retired
                      Ticket report listed the same agents with overlapping
                      columns, so the page showed one dataset twice. This report's
                      own table wins — it has the Excel export. */}
                  <AgentKpiReport
                    agents={data.agents}
                    tr={tr}
                    days={days}
                    range={{ from, to, setFrom, setTo, setRange, reset: resetRange }}
                  />
                </>
              )}
              {which === 'conversations' && (
                <ConversationReport
                  report={data.conversations}
                  tr={tr}
                  days={days}
                  range={{ from, to, setFrom, setTo, setRange, reset: resetRange }}
                />
              )}
              {which === 'complaints' &&
                (data.complaintFieldsAvailable ? (
                  <ComplaintsReport rows={data.complaints} tr={tr} days={days} />
                ) : (
                  /* Better than 24 blank columns: this Directus simply has not
                     had the complaint schema applied yet, which is an operator
                     action, not a data problem. */
                  <EmptyState
                    title={t('complaintReport.noSchema', {
                      defaultValue: 'Ticket fields are not available here',
                    })}
                    description={t('complaintReport.noSchemaHint', {
                      defaultValue:
                        'This Directus does not yet have the ticket fields. Apply the Directus bootstrap, then reload.',
                    })}
                  />
                ))}

              <p className="pt-1 text-2xs text-muted-foreground">
                {t('agentReports.generatedAt', {
                  at: fmtDateTime(data.generatedAt),
                  defaultValue: 'Generated {{at}}',
                })}
              </p>
            </>
          )}
        </div>
        <ColumnScroller portRef={pinRef} />
      </div>
    </div>
  );
}
