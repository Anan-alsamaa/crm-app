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
  filterTickets,
  isEmptyFilter,
  moveColumn,
  reconcileColumnOrder,
  type TicketFilterCriteria,
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
/**
 * Page sizes for the tickets report.
 *
 * The right one genuinely differs by task: 25 to read a queue, 1000 to scan for
 * a pattern before exporting. One fixed size served neither.
 */
const PAGE_SIZES = [25, 50, 100, 200, 1000] as const;

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
  const [colQuery, setColQuery] = useState('');
  /**
   * The filter, shared with the agent portal's own ticket queue so "find order
   * 946641" behaves identically wherever it is asked. See @yiji/reports.
   */
  const [criteria, setCriteria] = useState<TicketFilterCriteria>({});
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
  const visible = useMemo(() => filterTickets(joined, criteria), [joined, criteria]);

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

  const setCriterion = (patch: Partial<TicketFilterCriteria>) => {
    setCriteria((c) => ({ ...c, ...patch }));
    setPage(1); // a filtered set is a different set; page 7 of it means nothing
  };

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

  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
  const current = Math.min(page, pageCount);
  const pageRows = visible.slice((current - 1) * pageSize, current * pageSize);

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
    <div className="space-y-4">
      {/* The filter bar. Free text first because it answers most questions on
          its own; the dropdowns are for slicing rather than finding. */}
      <div className="space-y-3 rounded-2xl bg-card p-3 shadow-soft ring-1 ring-foreground/[0.06]">
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
              value={criteria.query ?? ''}
              onChange={(e) => setCriterion({ query: e.target.value })}
              className="h-8"
              placeholder={t('complaintReport.searchPlaceholder', {
                defaultValue: 'Order number, phone, branch, or a word from the complaint…',
              })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {t('performance.from', { defaultValue: 'From' })}
            </span>
            <Input
              type="date"
              className="h-8 w-[9rem]"
              value={criteria.from ?? ''}
              onChange={(e) => setCriterion({ from: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {t('performance.to', { defaultValue: 'To' })}
            </span>
            <Input
              type="date"
              className="h-8 w-[9rem]"
              value={criteria.to ?? ''}
              onChange={(e) => setCriterion({ to: e.target.value })}
            />
          </label>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <FilterSelect
            label={t('complaintReport.col.complaintType', { defaultValue: 'Complaint type' })}
            field="complaintType"
            values={options.complaintType}
            value={criteria.complaintType}
          />
          <FilterSelect
            label={t('complaintReport.col.complaintStatus', { defaultValue: 'Status' })}
            field="status"
            values={options.complaintStatus}
            value={criteria.status}
          />
          <FilterSelect
            label={t('complaintReport.col.brand', { defaultValue: 'Brand' })}
            field="brand"
            values={options.brand}
            value={criteria.brand}
          />
          <FilterSelect
            label={t('complaintReport.col.city', { defaultValue: 'City' })}
            field="city"
            values={options.city}
            value={criteria.city}
          />
          <FilterSelect
            label={t('complaintReport.col.agent', { defaultValue: 'Agent' })}
            field="agent"
            values={options.agent}
            value={criteria.agent}
          />
          <FilterSelect
            label={t('complaintReport.col.serviceType', { defaultValue: 'Service type' })}
            field="serviceType"
            values={options.serviceType}
            value={criteria.serviceType}
          />
          <FilterSelect
            label={t('complaintReport.col.complaintSource', { defaultValue: 'Source' })}
            field="source"
            values={options.complaintSource}
            value={criteria.source}
          />
          <FilterSelect
            label={t('complaintReport.col.compensation', { defaultValue: 'Compensation' })}
            field="compensation"
            values={options.compensation}
            value={criteria.compensation}
          />
          {!isEmptyFilter(criteria) && (
            <Button
              size="sm"
              variant="ghost"
              className="h-8"
              onClick={() => {
                setCriteria({});
                setPage(1);
              }}
            >
              {t('complaintReport.clearFilters', { defaultValue: 'Clear filters' })}
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {unmapped > 0 && (
          <Pill tone="warning" size="sm">
            {t('complaintReport.unmappedStores', {
              count: unmapped,
              defaultValue: '{{count}} rows with an unmapped store',
            })}
          </Pill>
        )}
        <span className="text-2xs tabular-nums text-muted-foreground">
          {isEmptyFilter(criteria)
            ? t('complaintReport.rowCount', {
                count: joined.length,
                defaultValue: '{{count}} rows',
              })
            : t('complaintReport.matches', {
                count: visible.length,
                total: joined.length,
                defaultValue: '{{count}} of {{total}}',
              })}
        </span>
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
              {/* Wider and taller than before, with a search: arranging 27
                  columns through a 64-wide list scrolled two rows at a time was
                  the actual complaint. The list IS the arrangement — its order
                  is the table's order and the export's order. */}
              <div className="absolute end-0 top-9 z-40 flex max-h-[32rem] w-80 flex-col rounded-xl bg-card shadow-float ring-1 ring-foreground/10">
                <div className="space-y-2 border-b border-border p-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                      {t('agentReports.exportColumns', { defaultValue: 'Columns' })}
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
                  <p className="text-2xs text-muted-foreground">
                    {t('complaintReport.columnsHelp', {
                      defaultValue: 'The order here is the order in the table and the export.',
                    })}
                  </p>
                </div>
                <ul className="flex-1 space-y-0.5 overflow-auto p-1.5">
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
                      <li key={k} className="flex items-center gap-1">
                        <span className="w-5 shrink-0 text-end text-2xs tabular-nums text-muted-foreground/70">
                          {i + 1}
                        </span>
                        <label className="flex flex-1 cursor-pointer items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-xs text-foreground hover:bg-secondary/60">
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5 rounded border-border text-primary focus:ring-primary/60"
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
            </>
          )}
          {/* Says the COUNT, so nobody has to wonder whether "export" means the
              page in front of them. It never has — it has always exported the
              whole filtered set — but a promise that has to be trusted is one
              that gets re-tested by hand every single time. */}
          <Button size="sm" onClick={onExport}>
            {t('agentReports.exportExcelCount', {
              count: visible.length,
              defaultValue: 'Export {{count}} rows',
            })}
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
                <Th key={k} className={cn(COMPLAINT_COLUMN_LAYOUT[k] === 'number' && 'text-end')}>
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
      </TableSurface>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-2xs text-muted-foreground">
          {t('complaintReport.rowsPerPage', { defaultValue: 'Rows per page' })}
          <SelectMenu
            size="sm"
            className="w-[6rem]"
            aria-label={t('complaintReport.rowsPerPage', { defaultValue: 'Rows per page' })}
            value={String(pageSize)}
            onChange={(v) => {
              setPageSize(Number(v));
              // Row 3,000 is on a different page at 25 than at 1000, so the
              // page number cannot survive the change. Going back to the start
              // is the only honest answer.
              setPage(1);
            }}
            options={PAGE_SIZES.map((n) => ({ value: String(n), label: String(n) }))}
          />
        </label>
        <span className="text-2xs tabular-nums text-muted-foreground">
          {t('complaintReport.showingRange', {
            defaultValue: 'Showing {{from}}–{{to}} of {{total}}',
            from: visible.length === 0 ? 0 : (current - 1) * pageSize + 1,
            to: Math.min(current * pageSize, visible.length),
            total: visible.length,
          })}
        </span>
        <div className="ms-auto">
          <Pagination
            page={current}
            pageCount={pageCount}
            onPage={setPage}
            prevLabel={t('agentReports.prev', { defaultValue: 'Previous' })}
            nextLabel={t('agentReports.next', { defaultValue: 'Next' })}
          />
        </div>
      </div>
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
  /** Which status box is expanded, showing the customers behind its count. */
  const [drill, setDrill] = useState<string | null>(null);

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
                    <span className="ms-auto tabular-nums font-semibold text-foreground">
                      {s.count}
                    </span>
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
                                t('agentReports.noContact', { defaultValue: 'no contact on file' })}
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

      {/* The conversations themselves, with who they are with. The day matrix
          below answers "how many"; this answers "which", which is what somebody
          reading a status report is about to go and do something about. */}
      <TableSurface className="overflow-x-auto">
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
            {report.rows.slice(0, 50).map((r) => (
              <Tr key={r.id}>
                <Td className="font-medium">
                  {r.customerName || t('agentReports.noName', { defaultValue: '—' })}
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
                <Td className="font-mono tabular-nums text-muted-foreground">{r.orderId || '—'}</Td>
                <Td className="tabular-nums text-muted-foreground">
                  {r.lastMessageAt ? fmtDateTime(r.lastMessageAt) : '—'}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableSurface>
      <PreviewNote shown={Math.min(report.rows.length, 50)} total={report.rows.length} />

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
    // Names the object it counts. Three surfaces report response times now and
    // their numbers will never agree, because tickets and chats are different
    // things — saying which is which is cheaper than explaining the gap every
    // time somebody spots it.
    subDefault:
      'One row per agent, over TICKETS: how many they held, how fast the first reply went out, how many breached, and what customers scored them. For the individual breaches see SLA performance; for chat response times see Agent performance.',
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
      'Every ticket in the operations report format. Search by phone, restaurant name or ID; rearrange the columns under the Columns button; export to Excel.',
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
        {/* The tickets report is a 27-column operations sheet and gets the whole
            monitor; the other three are read-and-move-on summaries and stay
            narrow, because a KPI strip stretched across 1920px is four numbers
            with a metre of white between them. */}
        <div
          className={cn('mx-auto space-y-5', which === 'complaints' ? 'max-w-none' : 'max-w-5xl')}
        >
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
