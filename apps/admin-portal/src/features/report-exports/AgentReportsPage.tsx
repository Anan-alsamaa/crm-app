import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
// Moved here when the Ticket report page was retired: the register belongs with
// the Tickets report, the workload table with Agent KPI.
import {
  Button,
  cn,
  EmptyState,
  Input,
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
import { matchStore, isUnmappedStore, resolveStoreAttribution } from '@yiji/shared-types';
import {
  useAgentReportData,
  useTicketOrders,
  type AgentKpiRow,
  type ComplaintReportRow,
  type ConversationStatusReport,
  type SlaOutcome,
  type TicketReportRow,
} from './api.js';
import { useStoreIndex } from '../restaurants/api.js';
import {
  buildAgentKpiSheets,
  buildComplaintsSheets,
  buildConversationSheets,
  buildTicketsSheets,
  COMPLAINT_COLUMN_KEYS,
  COMPLAINT_COLUMN_LABELS,
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
  filterComplaintRows,
  moveColumn,
  reconcileColumnOrder,
} from '@yiji/reports';

/** Which of the four exportable reports this page instance renders. */
export type ReportKind = 'tickets' | 'agents' | 'conversations' | 'complaints';
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
/* Colour as ACCENT, not surface — see TicketOpsPage for the rationale. This
 * page's Tone union is narrower (no crimson/slate). */
const DOT_TONE: Record<Tone, string> = {
  blue: 'bg-sky',
  violet: 'bg-violet',
  green: 'bg-success',
  amber: 'bg-warning',
};
function KpiTile({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div
      className={cn(
        'rounded-2xl bg-card px-4 py-4 shadow-soft ring-1 ring-border transition-[box-shadow,transform] duration-base ease-out hover:shadow-float motion-safe:hover:-translate-y-0.5',
      )}
    >
      <div className="text-4xl font-bold tabular-nums leading-none tracking-[-0.03em] text-foreground">
        {value}
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', DOT_TONE[tone])} />
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
  const [cols, setCols] = useState<Set<ComplaintColumnKey>>(() => new Set(COMPLAINT_COLUMN_KEYS));
  const [showCols, setShowCols] = useState(false);
  const [query, setQuery] = useState('');
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
  // One box: branch name, ops store code, Yiji restaurant id or phone.
  const visible = useMemo(() => filterComplaintRows(joined, query), [joined, query]);

  /** Columns that are ON, in the order the user arranged them. */
  const chosenColumns = useMemo(() => order.filter((k) => cols.has(k)), [order, cols]);

  const moveCol = (key: ComplaintColumnKey, delta: number) =>
    setOrder((prev) => {
      const from = prev.indexOf(key);
      const next = moveColumn(prev, from, from + delta);
      saveColumnOrder(TICKET_REPORT_ORDER_KEY, next);
      return next;
    });

  const onExport = () => {
    if (visible.length === 0) {
      toast.error(t('agentReports.nothingToExport', { defaultValue: 'Nothing to export.' }));
      return;
    }
    downloadWorkbook(
      reportFilename('reports-tickets', days),
      // Export what is on screen: the filter is part of the question being
      // asked, so exporting the unfiltered set would answer a different one.
      buildComplaintsSheets(visible, tr, chosenColumns),
    );
    toast.success(
      t('agentReports.exported', {
        count: visible.length,
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
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const current = Math.min(page, pageCount);
  const pageRows = visible.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        {unmapped > 0 && (
          <Pill tone="warning" size="sm">
            {t('complaintReport.unmappedStores', {
              count: unmapped,
              defaultValue: '{{count}} rows with an unmapped store',
            })}
          </Pill>
        )}
        {/* One box rather than four labelled fields: operations look a
            complaint up by whatever they have to hand. */}
        <Input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
          className="h-8 w-72"
          aria-label={t('complaintReport.searchLabel', {
            defaultValue: 'Search by phone, restaurant name or restaurant id',
          })}
          placeholder={t('complaintReport.searchPlaceholder', {
            defaultValue: 'Phone, restaurant name or ID…',
          })}
        />
        {query && (
          <span className="text-2xs tabular-nums text-muted-foreground">
            {t('complaintReport.matches', {
              count: visible.length,
              total: joined.length,
              defaultValue: '{{count}} of {{total}}',
            })}
          </span>
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
                    onClick={() => setCols(new Set(COMPLAINT_COLUMN_KEYS))}
                  >
                    {t('agentReports.selectAll', { defaultValue: 'All' })}
                  </button>
                </div>
                <ul className="space-y-0.5">
                  {/* Listed in the user's own order, so the list doubles as
                      the arrangement — moving a row here moves the column in
                      the table and the export. */}
                  {order.map((k, i) => (
                    <li key={k} className="flex items-center gap-1">
                      <label className="flex flex-1 cursor-pointer items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-xs text-foreground hover:bg-secondary/60">
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 rounded border-border text-primary focus:ring-primary/60"
                          checked={cols.has(k)}
                          onChange={() => toggleCol(k)}
                        />
                        {t(COMPLAINT_COLUMN_LABELS[k].key, {
                          defaultValue: COMPLAINT_COLUMN_LABELS[k].def,
                        })}
                      </label>
                      <button
                        type="button"
                        disabled={i === 0}
                        onClick={() => moveCol(k, -1)}
                        aria-label={t('complaintReport.moveUp', {
                          col: t(COMPLAINT_COLUMN_LABELS[k].key, {
                            defaultValue: COMPLAINT_COLUMN_LABELS[k].def,
                          }),
                          defaultValue: 'Move {{col}} earlier',
                        })}
                        className="grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-30"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        disabled={i === order.length - 1}
                        onClick={() => moveCol(k, 1)}
                        aria-label={t('complaintReport.moveDown', {
                          col: t(COMPLAINT_COLUMN_LABELS[k].key, {
                            defaultValue: COMPLAINT_COLUMN_LABELS[k].def,
                          }),
                          defaultValue: 'Move {{col}} later',
                        })}
                        className="grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-30"
                      >
                        ↓
                      </button>
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

      {/* Every chosen column, in the chosen order — the table and the export
          are the same report, so showing a curated subset here just meant the
          screen and the file disagreed. Wide by nature, so it scrolls
          horizontally inside its own surface rather than stretching the page. */}
      <TableSurface className="overflow-x-auto">
        <Table>
          <thead>
            <tr>
              {chosenColumns.map((k) => (
                <Th key={k}>
                  {tr(COMPLAINT_COLUMN_LABELS[k].key, {
                    defaultValue: COMPLAINT_COLUMN_LABELS[k].def,
                  })}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((r) => (
              <Tr key={r.id}>
                {chosenColumns.map((k) => {
                  // An unresolved store says so instead of showing a blank
                  // cell, exactly as the export does.
                  const unmapped =
                    !r.storeMapped &&
                    (r.restaurantName || r.brand) &&
                    (['chain', 'area', 'brand', 'city'] as ComplaintColumnKey[]).includes(k);
                  return (
                    <Td key={k} className="whitespace-nowrap">
                      {unmapped ? (
                        <Pill tone="warning" size="sm">
                          {t('agentReports.notMapped', { defaultValue: 'Not mapped' })}
                        </Pill>
                      ) : (
                        String(complaintCell(r, k, tr) ?? '')
                      )}
                    </Td>
                  );
                })}
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableSurface>

      <PreviewNote shown={pageRows.length} total={joined.length} />
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
              <SortTh {...sp('missed', 'end')}>
                {tr('agentReports.col.missed', { defaultValue: 'Missed' })}
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
                <Td className="text-end tabular-nums">
                  {a.offered === 0 ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <>
                      <span className={a.missed > 0 ? 'font-semibold text-destructive' : ''}>
                        {a.missed}
                      </span>
                      <span className="text-muted-foreground"> / {a.offered}</span>
                    </>
                  )}
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
    titleDefault: 'Tickets',
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
  complaints: {
    titleKey: 'complaintReport.title',
    titleDefault: 'Tickets',
    subKey: 'complaintReport.subtitle',
    subDefault:
      'Every ticket in the operations report format. Search by phone, restaurant name or ID; drag columns into the order you want; export to Excel.',
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
        : which === 'complaints'
          ? !!data && data.complaints.length === 0
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
                  <AgentKpiReport agents={data.agents} tr={tr} days={days} />
                </>
              )}
              {which === 'conversations' && (
                <ConversationReport report={data.conversations} tr={tr} days={days} />
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
                      defaultValue: 'Complaint fields are not available here',
                    })}
                    description={t('complaintReport.noSchemaHint', {
                      defaultValue:
                        'This Directus does not yet have the complaint fields. Apply the Directus bootstrap, then reload.',
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
      </div>
    </div>
  );
}
