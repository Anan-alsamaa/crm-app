import { useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deleteItem, readUsers } from '@directus/sdk';
import { useTranslation } from 'react-i18next';
// Moved here when the Ticket report page was retired: the register belongs with
// the Tickets report, the workload table with Agent KPI.
import {
  Avatar,
  Button,
  cn,
  Drawer,
  EmptyState,
  InboxIcon,
  Input,
  MeterBar,
  type MetricTone,
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
  Toolbar,
  ToolbarSpacer,
  Tr,
  UsersIcon,
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
import { directus } from '../../lib/directus.js';
import { formatDuration } from '@yiji/reports';
import { TicketHistoryDrawer } from './TicketHistoryDrawer.js';
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
  chats: (r) => r.chats,
  noReply: (r) => r.noReply,
  inTimePct: (r) => r.inTimePct,
  avgFirstResponseSec: (r) => r.avgFirstResponseSec,
  avgTimeToSolveSec: (r) => r.avgTimeToSolveSec,
  commonTaken: (r) => r.commonTaken,
  tickets: (r) => r.tickets,
  csatAvg: (r) => r.csatAvg,
};

/* ── KPI card — boxed board tile: icon chip, hero numeral, micro-label ──── */
type Tone = 'blue' | 'violet' | 'green' | 'amber';
/* Colour as ACCENT, not surface — see TicketOpsPage for the rationale. This
 * page's Tone union is narrower (no crimson/slate). */
const DOT_TONE: Record<Tone, string> = {
  blue: 'bg-sky',
  violet: 'bg-violet',
  green: 'bg-success',
  amber: 'bg-warning',
};
/* Icon chips take tint + hue token pairs; amber stays NEUTRAL — warning is a
 * light token and a warning-tinted chip fails contrast on the light theme. */
const CHIP_TONE: Record<Tone, string> = {
  blue: 'bg-sky-tint text-sky',
  violet: 'bg-violet-tint text-violet',
  green: 'bg-success-tint text-success',
  amber: 'bg-secondary text-muted-foreground',
};
/* The SURFACE carries the hue too — a row of white boxes with one small
 * coloured square each reads as a form, not a dashboard. */
const SURFACE_TONE: Record<Tone, string> = {
  blue: 'bg-gradient-to-br from-sky-tint/70 to-card',
  violet: 'bg-gradient-to-br from-violet-tint/70 to-card',
  green: 'bg-gradient-to-br from-success-tint/70 to-card',
  amber: 'bg-gradient-to-br from-warning-tint/70 to-card',
};
const NUMERAL_TONE: Record<Tone, string> = {
  blue: 'text-[oklch(0.48_0.13_215)]',
  violet: 'text-violet',
  green: 'text-[oklch(0.45_0.13_155)]',
  amber: 'text-[oklch(0.5_0.13_75)]',
};

function KpiTile({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: string;
  tone: Tone;
  /** Rendered inside a tinted rounded-square chip above the numeral. */
  icon?: ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-2xl p-5 shadow-[0_1px_2px_oklch(var(--shadow-color)/0.06),0_12px_32px_-12px_oklch(var(--shadow-color)/0.18)]',
        'transition-[box-shadow,transform] duration-base ease-out motion-safe:hover:-translate-y-1',
        'hover:shadow-[0_2px_4px_oklch(var(--shadow-color)/0.08),0_20px_44px_-16px_oklch(var(--shadow-color)/0.28)]',
        SURFACE_TONE[tone],
      )}
    >
      {icon && (
        <span
          aria-hidden
          className={cn('mb-3 grid h-9 w-9 place-items-center rounded-lg', CHIP_TONE[tone])}
        >
          {icon}
        </span>
      )}
      {/* Numeral first, label as its NEXT sibling — the KPI reader in the
          tests walks exactly this pair, so the anatomy is contractual. */}
      <div
        className={cn(
          'text-4xl font-extrabold tabular-nums leading-none tracking-[-0.03em]',
          NUMERAL_TONE[tone],
        )}
      >
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
  const [historyOf, setHistoryOf] = useState<{ id: string; label: string } | null>(null);
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: (id: string) => directus.request(deleteItem('tickets' as never, id)),
    onSuccess: () => {
      setSelectedId(null);
      void qc.invalidateQueries({ queryKey: ['agent-reports'] });
      toast.success(t('complaintReport.deleted', { defaultValue: 'Complaint deleted.' }));
    },
    onError: () =>
      toast.error(
        t('complaintReport.deleteFailed', { defaultValue: 'Could not delete that complaint.' }),
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

  const onExport = () => {
    if (visible.length === 0) {
      toast.error(t('agentReports.nothingToExport', { defaultValue: 'Nothing to export.' }));
      return;
    }
    downloadWorkbook(
      reportFilename('Tickets', days),
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
          <Button size="sm" onClick={onExport}>
            {t('agentReports.exportExcelCount', {
              count: visible.length,
              defaultValue: 'Export {{count}} rows',
            })}
          </Button>
          {/* Selection-driven actions, ops-portal style: pick a row, then act
              from here. Disabled — not hidden — without a selection, so the
              affordance teaches its own precondition. */}
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
                  label: [row.complaintType, row.orderNumber].filter(Boolean).join(' · ') || row.id,
                });
            }}
          >
            {t('complaintReport.historyBtn', { defaultValue: 'History' })}
          </Button>
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
              if (
                window.confirm(
                  t('complaintReport.deleteConfirm', {
                    label,
                    defaultValue:
                      'Delete “{{label}}”? The record is removed; who deleted it stays in the change history.',
                  }),
                )
              )
                del.mutate(row.id);
            }}
          >
            {t('complaintReport.deleteBtn', { defaultValue: 'Delete' })}
          </Button>
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
      <TableSurface className="overflow-x-auto">
        <Table>
          <thead>
            <tr>
              <Th className="w-10">
                <span className="sr-only">
                  {t('complaintReport.selectCol', { defaultValue: 'Select' })}
                </span>
              </Th>
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
                  count: joined.length,
                  defaultValue: '{{count}} rows',
                })
              : t('complaintReport.matches', {
                  count: visible.length,
                  total: joined.length,
                  defaultValue: '{{count}} of {{total}}',
                })}
          </span>
        </TableFooterBar>
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
    downloadWorkbook(reportFilename('Agent performance', days), buildAgentKpiSheets(agents, tr));
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
              <SortTh {...sp('chats', 'end')}>
                {tr('agentReports.col.chats', { defaultValue: 'Chats' })}
              </SortTh>
              <SortTh {...sp('noReply', 'end')}>
                {tr('agentReports.col.noReply', { defaultValue: 'No reply yet' })}
              </SortTh>
              <SortTh {...sp('inTimePct', 'end')}>
                {tr('agentReports.col.inTime', { defaultValue: 'Answered in time' })}
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
                {tr('agentReports.col.csatAvg', { defaultValue: 'CSAT avg (1–5)' })}
              </SortTh>
            </tr>
          </thead>
          <tbody>
            {sorted.map((a) => (
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
            <span className="font-semibold tabular-nums text-foreground">{agents.length}</span>
            <span className="text-2xs font-semibold uppercase tracking-[0.12em]">
              {t('agentReports.kpiAgents', { defaultValue: 'Agents' })}
            </span>
          </span>
        </TableFooterBar>
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
    downloadWorkbook(reportFilename('Conversations', days), buildConversationSheets(report, tr));
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
        <div className="rounded-2xl bg-card p-5 ring-1 ring-foreground/[0.06] shadow-soft">
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
        <div className="rounded-2xl bg-card p-5 ring-1 ring-foreground/[0.06] shadow-soft">
          <h3 className="mb-3 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {t('agentReports.byPriority', { defaultValue: 'By priority' })}
          </h3>
          <ul className="space-y-2">
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
                <Td className="font-mono tabular-nums text-muted-foreground">{r.orderId || '—'}</Td>
                <Td className="tabular-nums text-muted-foreground">
                  {r.lastMessageAt ? fmtDateTime(r.lastMessageAt) : '—'}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
        {/* The truncation note reads as part of the table it truncates —
            a bare caption floating on the canvas read as dead space. */}
        {report.rows.length > 50 && (
          <TableFooterBar>
            <PreviewNote shown={Math.min(report.rows.length, 50)} total={report.rows.length} />
          </TableFooterBar>
        )}
      </TableSurface>

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
        {report.byDay.length > preview.length && (
          <TableFooterBar>
            <PreviewNote shown={preview.length} total={report.byDay.length} unit="days" />
          </TableFooterBar>
        )}
      </TableSurface>
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
            with a metre of white between them. Agent KPI gets one step more
            room: its seven columns overflowed a 5xl card and clipped the CSAT
            columns behind a scroll nobody notices on a 1920px monitor. */}
        <div
          className={cn(
            'mx-auto space-y-5',
            which === 'complaints' ? 'max-w-none' : which === 'agents' ? 'max-w-6xl' : 'max-w-5xl',
          )}
        >
          {/* Clean editorial header — no gradient banner. */}
          <div className="border-b border-foreground/10 pb-5">
            <h2 className="text-3xl font-bold tracking-tight text-foreground">
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
              {/* KPI strip — boxed board tiles: tinted icon chips, hero numerals.
                  On the full-bleed complaints sheet the strip stays capped: four
                  tiles stretched across 1920px are four small numbers separated
                  by dead width. */}
              <div
                className={cn(
                  'grid grid-cols-2 gap-3 sm:grid-cols-4',
                  which === 'complaints' && 'max-w-4xl',
                )}
              >
                <KpiTile
                  label={t('agentReports.kpiTickets', { defaultValue: 'Tickets' })}
                  value={String(data.tickets.length)}
                  tone="blue"
                  icon={<TicketIcon size={18} />}
                />
                <KpiTile
                  label={t('agentReports.kpiConversations', { defaultValue: 'Conversations' })}
                  value={String(data.conversations.total)}
                  tone="violet"
                  icon={<InboxIcon size={18} />}
                />
                <KpiTile
                  label={t('agentReports.kpiAgents', { defaultValue: 'Agents' })}
                  value={String(data.agents.filter((a) => a.agentId).length)}
                  tone="amber"
                  icon={<UsersIcon size={18} />}
                />
                <KpiTile
                  label={t('agentReports.kpiCsat', { defaultValue: 'CSAT avg' })}
                  value={fmtScore(data.csatOverall.avg)}
                  tone="green"
                  icon={<SparkleIcon size={18} />}
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
