import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deleteItem, readItems, readUsers } from '@directus/sdk';
import {
  Button,
  cn,
  ConfirmDialog,
  Drawer,
  ExportButtons,
  formatDate,
  formatRelative,
  Ltr,
  pageCountOf,
  Pill,
  ReportKpi,
  ReportKpiStrip,
  Input,
  Skeleton,
  Table,
  TablePager,
  TableSurface,
  Th,
  toast,
} from '@yiji/ui';
import { exportFileName } from '@yiji/shared-config';
import { couponDecision } from '@yiji/shared-types';
import { directus } from '../../lib/directus.js';
import { usePinnedWidth } from '../../lib/pinned-width.js';
import { ColumnScroller } from '../../components/ColumnScroller.js';
import {
  COMPENSATION_REPORT_ORDER_KEY,
  downloadCsv,
  loadColumnOrder,
  moveColumn,
  reconcileColumnOrder,
  saveColumnOrder,
  toCsv,
} from '@yiji/reports';
import { ReportFilterBar } from '../../components/ReportFilterBar.js';
import { TicketHistoryDrawer } from '../report-exports/TicketHistoryDrawer.js';
import { useAuth } from '../../lib/auth/AuthContext.js';

/**
 * The master record of every coupon the business has ever issued.
 *
 * Distinct from Admin statistics, which answers "what is waiting on me, and how
 * am I deciding?" for the supervisor working the queue. This answers "what did
 * we give away, to whom, on whose say-so, and on what terms?" — so it carries
 * every field a coupon has rather than the handful that fit a summary, and it
 * exports, because that question is usually asked by finance in a spreadsheet.
 *
 * Every column is on screen rather than behind a column picker: an operator
 * reconciling a coupon against an invoice needs the terms and the dates in one
 * glance, and hiding half of them by default only means finding the picker
 * first. The table scrolls sideways instead.
 *
 * The columns can, however, be REARRANGED — same interaction as the ticket
 * breakdown report, same shared helpers, same per-report localStorage key.
 * With 23 columns on a sideways-scrolling table, which three sit at the front
 * decides whether the answer is visible or a swipe away, and that differs by
 * who is reading: finance leads with the money, operations with the branch.
 * Rearranging is not hiding, so the "everything is on screen" promise holds.
 */
interface Row {
  id: string;
  title: string | null;
  coupon_code: string | null;
  // `numeric` columns arrive as strings — see `money` below.
  coupon_value: number | string | null;
  coupon_percent: number | string | null;
  max_discount: number | string | null;
  usage_limit: number | string | null;
  status: string | null;
  compensation: string | null;
  reason: string | null;
  decision_note: string | null;
  edited_by_admin: boolean | null;
  date_created: string | null;
  decided_at: string | null;
  valid_from: string | null;
  valid_to: string | null;
  issuing_side: string | null;
  delivery_type: string | null;
  coupon_type: string | null;
  discount_category: string | null;
  brand_id: string | null;
  restaurant_id: string | null;
  item_name: string | null;
  ticket: { order_id: string | null } | null;
  requested_by: { id: string; first_name: string | null; email: string | null } | null;
  decided_by: { id: string; first_name: string | null; email: string | null } | null;
  contact: { name: string | null; phone: string | null } | null;
}

/** `||` not `??`: Directus stores an unset name as an empty string. */
const who = (u: Row['requested_by']) => u?.first_name?.trim() || u?.email || '';

function useAllCoupons() {
  return useQuery({
    queryKey: ['all-compensation'],
    queryFn: async () =>
      (await directus.request(
        readItems(
          'coupon_approvals' as never,
          {
            limit: -1,
            sort: ['-date_created'],
            fields: [
              'id',
              'title',
              'coupon_code',
              'coupon_value',
              'coupon_percent',
              'max_discount',
              'usage_limit',
              'status',
              'compensation',
              'reason',
              'decision_note',
              'edited_by_admin',
              'date_created',
              'decided_at',
              'valid_from',
              'valid_to',
              'issuing_side',
              'delivery_type',
              'coupon_type',
              'discount_category',
              'brand_id',
              'restaurant_id',
              'item_name',
              { ticket: ['order_id'] },
              { requested_by: ['id', 'first_name', 'email'] },
              { decided_by: ['id', 'first_name', 'email'] },
              { contact: ['name', 'phone'] },
            ],
          } as never,
        ),
      )) as unknown as Row[],
  });
}

const TONE: Record<string, 'success' | 'destructive' | 'warning' | 'neutral'> = {
  approved: 'success',
  assigned: 'success',
  edited: 'success',
  rejected: 'destructive',
  pending: 'warning',
};

const PAGE_SIZE = 25;

/**
 * A money figure without the database's trailing zeros.
 *
 * Postgres hands a `numeric` column back as the STRING "0.00000" — not a
 * number, because numeric is arbitrary-precision and JavaScript's float would
 * lose it. So this takes both: the first version assumed a number, called
 * `.toFixed` on a string, and took the whole page down with it. On screen the
 * raw value also reads as a precision nobody entered, hence the trim.
 *
 * Two decimals only when there are actually halalas.
 */
export function money(n: number | string | null | undefined): string {
  if (n == null || n === '') return '';
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
}

/**
 * Every column key, in the order the report ships with.
 *
 * Declared separately from the column definitions (which need `t` and so must
 * be built inside the component) purely so the saved arrangement can be
 * reconciled against it — a saved order naming a column that no longer exists,
 * or missing one added since, is repaired rather than obeyed.
 */
const COMPENSATION_COLUMN_KEYS = [
  'code',
  'title',
  'customer',
  'phone',
  'brand',
  'store',
  'order',
  'item',
  'issuing',
  'delivery',
  'couponType',
  'category',
  'worth',
  'cap',
  'uses',
  'validFrom',
  'validTo',
  'state',
  'agent',
  'decidedBy',
  'raised',
  'decidedAt',
  'reason',
  'note',
] as const;

type CompensationColumnKey = (typeof COMPENSATION_COLUMN_KEYS)[number];

interface Column {
  key: CompensationColumnKey;
  label: string;
  end?: boolean;
  get: (r: Row) => string;
}

export function AllCompensationPage() {
  const { t } = useTranslation();
  const rows = useAllCoupons();
  const pinRef = usePinnedWidth();
  const { can } = useAuth();
  const qc = useQueryClient();
  /*
   * The row-level actions this page was missing.
   *
   * Ticket breakdown has had History and Delete since the ops-portal batch;
   * Compensation, which is the same shape of report over a different
   * collection, had neither — so the one page recording what the business
   * gave away was also the one page where you could not ask who changed a
   * coupon after it was approved.
   *
   * Selection-driven, the same way: pick a row, then act from the bar.
   * Disabled rather than hidden without a selection, so the control teaches
   * its own precondition.
   */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [historyOf, setHistoryOf] = useState<{ id: string; label: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; label: string } | null>(null);
  const canSeeHistory = can('approve_coupons');
  const canDelete = can('delete_tickets');
  const del = useMutation({
    mutationFn: (id: string) => directus.request(deleteItem('coupon_approvals' as never, id)),
    onSuccess: () => {
      setSelectedId(null);
      void qc.invalidateQueries({ queryKey: ['all-coupons'] });
      toast.success(t('compensationAll.deleted', { defaultValue: 'Coupon record deleted.' }));
    },
    onError: () =>
      toast.error(
        t('compensationAll.deleteFailed', { defaultValue: 'Could not delete that record.' }),
      ),
  });
  /*
   * Actor names for the history drawer. Ids alone accuse nobody legibly: a
   * change log reading "f5548287-… set status to approved" is a log people
   * stop opening.
   */
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
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [agent, setAgent] = useState('');
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  // The right page size differs by task: 25 to read the queue, 500 to scan a
  // month before exporting. One fixed size served neither.
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  // The column arrangement — a browser preference, reconciled on load so it
  // survives a column being added or removed. Same helpers, same behaviour as
  // the ticket breakdown report.
  const [order, setOrder] = useState<CompensationColumnKey[]>(() =>
    reconcileColumnOrder(
      loadColumnOrder<CompensationColumnKey>(COMPENSATION_REPORT_ORDER_KEY),
      COMPENSATION_COLUMN_KEYS,
    ),
  );
  const [showCols, setShowCols] = useState(false);
  const [colQuery, setColQuery] = useState('');
  const [dragKey, setDragKey] = useState<CompensationColumnKey | null>(null);

  const list = useMemo(() => rows.data ?? [], [rows.data]);

  /** Only names that actually appear — an empty filter option helps nobody. */
  const agents = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of list) {
      if (r.requested_by?.id) m.set(r.requested_by.id, who(r.requested_by) || '—');
    }
    return [...m.entries()].map(([value, label]) => ({ value, label }));
  }, [list]);

  const statuses = useMemo(
    () => [...new Set(list.map((r) => r.status ?? 'pending'))].sort(),
    [list],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return list.filter((r) => {
      const day = (r.date_created ?? '').slice(0, 10);
      if (from && day < from) return false;
      // Inclusive of the end day: "up to the 17th" means including the 17th.
      if (to && day > to) return false;
      if (agent && r.requested_by?.id !== agent) return false;
      if (status && (r.status ?? 'pending') !== status) return false;
      if (q) {
        const hay = [
          r.coupon_code,
          r.title,
          r.contact?.name,
          r.contact?.phone,
          r.brand_id,
          r.restaurant_id,
          r.item_name,
          r.ticket?.order_id,
          r.coupon_type,
          who(r.requested_by),
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [list, from, to, agent, status, query]);

  /**
   * This report's own headline numbers, over the FILTERED set — a summary that
   * ignores the filter under it is a summary of a different report.
   *
   * Value is deliberately the SAR total only. A percentage coupon has no value
   * until an order is placed against it, so adding "20" from a 20% coupon to a
   * riyal total would produce a number that is not money and cannot be checked
   * against anything. The percentage coupons are counted separately instead.
   */
  const totals = useMemo(() => {
    let sar = 0;
    let percentCoupons = 0;
    let approved = 0;
    let pending = 0;
    for (const r of filtered) {
      // The DECISION, not the literal — `edited` is an approval with amended
      // terms and was being left out of this count.
      const decision = couponDecision(r.status);
      if (decision === 'approved') approved += 1;
      if (decision === 'pending') pending += 1;
      const pct = Number(r.coupon_percent);
      if (Number.isFinite(pct) && pct > 0) percentCoupons += 1;
      else {
        const v = Number(r.coupon_value);
        if (Number.isFinite(v)) sar += v;
      }
    }
    return { sar, percentCoupons, approved, pending };
  }, [filtered]);

  const pageCount = pageCountOf(filtered.length, pageSize);
  // Clamped rather than stored: narrowing a filter while on page 9 must not
  // leave the operator staring at an empty table.
  const current = Math.min(page, pageCount);
  const paged = filtered.slice((current - 1) * pageSize, current * pageSize);

  /**
   * What the coupon is worth, in whichever of the two forms it was granted.
   *
   * Driven by the formatted result rather than a null check on the raw column:
   * an empty string is as absent as a null here, and testing the column left a
   * bare "%" in the cell for a percentage coupon that had no percentage on it.
   */
  const worth = (r: Row) => {
    const pct = money(r.coupon_percent);
    if (pct) return `${pct}%`;
    return money(r.coupon_value);
  };

  const statusLabel = (r: Row) =>
    t(`status.${r.status ?? 'pending'}`, { ns: 'common', defaultValue: r.status ?? 'pending' });

  const columnDefs: Column[] = [
    {
      key: 'code',
      label: t('coupons.code', { defaultValue: 'Coupon code' }),
      get: (r) => r.coupon_code ?? '',
    },
    {
      key: 'title',
      label: t('coupons.titleField', { defaultValue: 'Coupon title' }),
      get: (r) => r.title ?? '',
    },
    {
      key: 'customer',
      label: t('compensationAll.customer', { defaultValue: 'Customer' }),
      get: (r) => r.contact?.name ?? '',
    },
    {
      key: 'phone',
      label: t('compensationAll.phone', { defaultValue: 'Phone' }),
      get: (r) => r.contact?.phone ?? '',
    },
    {
      key: 'brand',
      label: t('stores.colBrand', { defaultValue: 'Brand' }),
      get: (r) => r.brand_id ?? '',
    },
    {
      key: 'store',
      label: t('compensationAll.store', { defaultValue: 'Store' }),
      get: (r) => r.restaurant_id ?? '',
    },
    {
      key: 'order',
      label: t('compensationAll.order', { defaultValue: 'Order' }),
      get: (r) => r.ticket?.order_id ?? '',
    },
    {
      key: 'item',
      label: t('coupons.itemShort', { defaultValue: 'Item' }),
      get: (r) => r.item_name ?? '',
    },
    {
      key: 'issuing',
      label: t('lists.issuingSide', { defaultValue: 'Issuing side' }),
      get: (r) => r.issuing_side ?? '',
    },
    {
      key: 'delivery',
      label: t('lists.deliveryType', { defaultValue: 'Delivery type' }),
      get: (r) => r.delivery_type ?? '',
    },
    {
      key: 'couponType',
      label: t('lists.couponType', { defaultValue: 'Coupon type' }),
      get: (r) => r.coupon_type ?? '',
    },
    {
      key: 'category',
      label: t('lists.discountCategory', { defaultValue: 'Discount category' }),
      get: (r) => r.discount_category ?? '',
    },
    {
      key: 'worth',
      label: t('compensationAll.worth', { defaultValue: 'Worth' }),
      end: true,
      get: worth,
    },
    {
      key: 'cap',
      label: t('coupons.maxDiscount', { defaultValue: 'Maximum discount' }),
      end: true,
      get: (r) => money(r.max_discount),
    },
    {
      key: 'uses',
      label: t('coupons.usageLimit', { defaultValue: 'Number of uses' }),
      end: true,
      get: (r) => money(r.usage_limit),
    },
    {
      key: 'validFrom',
      label: t('performance.from', { defaultValue: 'From' }),
      get: (r) => formatDate(r.valid_from),
    },
    {
      key: 'validTo',
      label: t('performance.to', { defaultValue: 'To' }),
      get: (r) => formatDate(r.valid_to),
    },
    {
      key: 'state',
      label: t('compensationAll.state', { defaultValue: 'Status' }),
      get: statusLabel,
    },
    {
      key: 'agent',
      label: t('compensationAll.agent', { defaultValue: 'Assigned by' }),
      get: (r) => who(r.requested_by),
    },
    {
      key: 'decidedBy',
      label: t('compensationAll.decidedBy', { defaultValue: 'Approved by' }),
      get: (r) => who(r.decided_by),
    },
    {
      key: 'raised',
      label: t('compensationAll.raised', { defaultValue: 'Raised' }),
      get: (r) => formatDate(r.date_created),
    },
    {
      key: 'decidedAt',
      label: t('compensationAll.decidedAt', { defaultValue: 'Date' }),
      get: (r) => formatDate(r.decided_at),
    },
    {
      key: 'reason',
      label: t('coupons.why', { defaultValue: 'Why' }),
      get: (r) => r.reason ?? '',
    },
    {
      key: 'note',
      label: t('compensationAll.note', { defaultValue: 'Note' }),
      get: (r) => r.decision_note ?? '',
    },
  ];

  /**
   * The columns as the reader arranged them.
   *
   * One source of order for the table AND the export: an operator who moved
   * "Worth" to the front and then exported would otherwise get a spreadsheet
   * in a different order from the screen they arranged, which is worse than
   * not offering the arrangement at all.
   */
  const byKey = new Map(columnDefs.map((c) => [c.key, c]));
  /*
   * Reconciled against the DEFINITIONS, not just the key list.
   *
   * Mapping the saved order and dropping whatever does not resolve would lose
   * a column silently the moment the two lists disagreed — the exact failure
   * shape this codebase keeps meeting: a filter that matches nothing and
   * renders as a plausible, wrong table. Appending the unresolved definitions
   * instead means a newly added column shows up at the end rather than
   * vanishing, whatever a year-old saved arrangement says.
   */
  const ordered = reconcileColumnOrder(
    order.filter((k) => byKey.has(k)),
    columnDefs.map((c) => c.key),
  );
  const columns: Column[] = ordered
    .map((k) => byKey.get(k))
    .filter((c): c is Column => c !== undefined);

  /**
   * Move one column by `delta` places, persisting the new arrangement.
   *
   * Reorders `ordered` — the list the table actually renders — because the
   * index the caller passes came from those rendered rows. Reordering the raw
   * saved `order` instead would apply a position from one array to another.
   */
  const reorderTo = (key: CompensationColumnKey, to: number) => {
    const from = ordered.indexOf(key);
    if (from < 0) return;
    const next = moveColumn(ordered, from, to);
    setOrder(next);
    saveColumnOrder(COMPENSATION_REPORT_ORDER_KEY, next);
  };

  const moveCol = (key: CompensationColumnKey, delta: number) =>
    reorderTo(key, ordered.indexOf(key) + delta);

  const resetOrder = () => {
    const next = [...COMPENSATION_COLUMN_KEYS];
    setOrder(next);
    saveColumnOrder(COMPENSATION_REPORT_ORDER_KEY, next);
  };

  /** What was filtered, for the file name — see `exportFileName`. */
  const scope = () => {
    const bits: string[] = [];
    if (from || to) bits.push(`${from || 'start'} to ${to || 'today'}`);
    if (agent) bits.push(agents.find((a) => a.value === agent)?.label ?? 'one agent');
    if (status) bits.push(status);
    if (query.trim()) bits.push(`matching ${query.trim()}`);
    return bits.length ? bits.join(', ') : 'all';
  };

  /**
   * The filtered view, or every compensation on record.
   *
   * This page is the single source of truth for what agents have asked for, so
   * "give me the lot" is a real request — usually for a month-end review, where
   * whichever filter happened to be set is exactly what should NOT decide the
   * contents.
   */
  const exportCsv = (which: 'view' | 'all') =>
    downloadCsv(
      // The filter is in the name, so two exports sitting in a downloads folder
      // are never the same file with a difference nobody can remember.
      exportFileName('Compensation', { scope: which === 'all' ? 'all' : scope() }),
      toCsv(
        columns.map((c) => c.label),
        (which === 'all' ? (rows.data ?? []) : filtered).map((r) => columns.map((c) => c.get(r))),
      ),
    );

  const reset = () => {
    setFrom('');
    setTo('');
    setAgent('');
    setStatus('');
    setQuery('');
    setPage(1);
  };
  const filtering = Boolean(from || to || agent || status || query.trim());

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* No Toolbar. It carried the report's NAME, which the tab strip directly
          above already shows as a selected pill, plus an export that belongs
          with the filters it exports. Two bands, one fact, 60px of a screen
          the table needs. */}
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
        <div className="w-max min-w-full space-y-3 py-4 sm:py-5">
          <ReportKpiStrip>
            <ReportKpi
              label={t('compensationAll.kpiRequests', { defaultValue: 'Coupons' })}
              value={String(filtered.length)}
              hint={
                filtered.length === list.length
                  ? undefined
                  : String(
                      t('complaintReport.ofTotal', {
                        total: list.length,
                        defaultValue: 'of {{total}} in range',
                      }),
                    )
              }
              tone="blue"
            />
            <ReportKpi
              label={t('compensationAll.kpiApproved', { defaultValue: 'Approved' })}
              value={String(totals.approved)}
              tone="green"
            />
            <ReportKpi
              label={t('compensationAll.kpiPending', { defaultValue: 'Pending' })}
              value={String(totals.pending)}
              tone="amber"
            />
            <ReportKpi
              label={t('compensationAll.kpiValue', { defaultValue: 'Value (SAR)' })}
              value={String(Math.round(totals.sar))}
              hint={
                totals.percentCoupons > 0
                  ? String(
                      t('compensationAll.kpiPercentAside', {
                        count: totals.percentCoupons,
                        defaultValue: 'plus {{count}} percentage coupons',
                      }),
                    )
                  : undefined
              }
              tone="violet"
            />
          </ReportKpiStrip>

          {/* The SHARED filter bar, not a sixth idea of one.
              This page hand-rolled a six-column grid with its own labels,
              spacing and Clear button, so "narrow to last week" looked and
              behaved differently here than on every other report. Same
              anatomy everywhere now: search, dates, dropdowns, clear — and the
              actions that operate on whatever those leave. */}
          <ReportFilterBar
            searchLabel={String(t('actions.search', { ns: 'common', defaultValue: 'Search' }))}
            searchPlaceholder={String(
              t('compensationAll.searchPlaceholder', {
                defaultValue: 'Order ID, code, customer, phone, brand',
              }),
            )}
            search={query}
            onSearch={(v) => {
              setQuery(v);
              setPage(1);
            }}
            from={from}
            to={to}
            onFrom={(v) => {
              setFrom(v);
              setPage(1);
            }}
            onTo={(v) => {
              setTo(v);
              setPage(1);
            }}
            selects={[
              {
                key: 'agent',
                label: String(t('compensationAll.agent', { defaultValue: 'Assigned by' })),
                value: agent,
                onChange: (v) => {
                  setAgent(v);
                  setPage(1);
                },
                options: agents,
              },
              {
                key: 'status',
                label: String(t('compensationAll.state', { defaultValue: 'Status' })),
                value: status,
                onChange: (v) => {
                  setStatus(v);
                  setPage(1);
                },
                options: statuses.map((st) => ({
                  value: st,
                  label: String(t(`status.${st}`, { ns: 'common', defaultValue: st })),
                })),
              },
            ]}
            filtering={filtering}
            onClear={reset}
            actions={
              <div className="flex flex-wrap items-center gap-2">
                {/* Arrange only — no checkboxes. Every column stays on screen
                    by design (see the note on this component); what differs by
                    reader is which ones come FIRST on a 23-column table that
                    scrolls sideways. */}
                <button
                  type="button"
                  onClick={() => setShowCols(true)}
                  aria-expanded={showCols}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium text-muted-foreground ring-1 ring-border transition-colors duration-fast hover:bg-secondary hover:text-foreground"
                >
                  {t('agentReports.columns', { defaultValue: 'Columns' })}
                  <span className="tabular-nums opacity-70">{columns.length}</span>
                </button>
                <ExportButtons
                  visibleCount={filtered.length}
                  totalCount={rows.data?.length ?? 0}
                  onExportView={() => exportCsv('view')}
                  onExportAll={() => exportCsv('all')}
                  labelPlain={t('stores.export', { defaultValue: 'Export CSV' })}
                  labelView={t('compensationAll.exportFiltered', {
                    count: filtered.length,
                    defaultValue: 'Export {{count}} shown',
                  })}
                  labelAll={t('compensationAll.exportAll', {
                    count: rows.data?.length ?? 0,
                    defaultValue: 'Export all {{count}}',
                  })}
                />
                {canSeeHistory && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ring-1 ring-border"
                    disabled={!selectedId}
                    onClick={() => {
                      const row = filtered.find((r) => r.id === selectedId);
                      if (row)
                        setHistoryOf({
                          id: row.id,
                          label: row.coupon_code || row.title || row.id,
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
                      const row = filtered.find((r) => r.id === selectedId);
                      if (!row) return;
                      setConfirmDelete({
                        id: row.id,
                        label: row.coupon_code || row.title || row.id,
                      });
                    }}
                  >
                    {t('complaintReport.deleteBtn', { defaultValue: 'Delete' })}
                  </Button>
                )}
              </div>
            }
          />

          {rows.isLoading ? (
            <Skeleton className="h-64 w-full rounded-2xl" />
          ) : (
            /* The shared table shell, like every other report: one rounded
               surface, one scroll container, and a sticky header row. This page
               hand-rolled its own, so its header scrolled away and a reader
               thirty rows down had to scroll back up to learn which column
               they were looking at. */
            <TableSurface
              flow
              scrollLabel={String(t('compensationAll.title', { defaultValue: 'Compensation' }))}
            >
              <Table className="min-w-[80rem]">
                <thead>
                  <tr>
                    {columns.map((c) => (
                      <Th key={c.key} className={c.end ? 'text-end' : 'text-start'}>
                        {c.label}
                      </Th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {paged.length === 0 ? (
                    <tr>
                      <td
                        colSpan={columns.length}
                        className="py-10 text-center text-sm text-muted-foreground"
                      >
                        {list.length === 0
                          ? t('compensationAll.none', {
                              defaultValue: 'No coupon has been raised yet.',
                            })
                          : t('compensationAll.noMatches', {
                              defaultValue: 'No coupon matches those filters.',
                            })}
                      </td>
                    </tr>
                  ) : (
                    paged.map((r) => (
                      /* Clicking the row selects it; the bar above then acts on
                         it. `aria-selected` rather than colour alone — a tinted
                         row does not read as "selected" to anyone who cannot
                         see the tint, and this is the row a Delete is about to
                         act on. */
                      <tr
                        key={r.id}
                        onClick={() => setSelectedId((cur) => (cur === r.id ? null : r.id))}
                        aria-selected={selectedId === r.id}
                        className={cn(
                          'cursor-pointer border-t border-foreground/[0.06] transition-colors duration-fast',
                          selectedId === r.id
                            ? 'bg-primary/[0.10] hover:bg-primary/[0.14]'
                            : 'hover:bg-primary/[0.07]',
                        )}
                      >
                        {columns.map((c) => {
                          const v = c.get(r);
                          if (c.key === 'code') {
                            return (
                              <td className="whitespace-nowrap px-4 py-3" key={c.key}>
                                <Ltr className="font-mono text-xs font-semibold text-foreground">
                                  {v || '—'}
                                </Ltr>
                              </td>
                            );
                          }
                          if (c.key === 'state') {
                            return (
                              <td key={c.key} className="whitespace-nowrap px-4 py-3">
                                <Pill
                                  tone={TONE[(r.status ?? 'pending').toLowerCase()] ?? 'neutral'}
                                  size="sm"
                                >
                                  {v}
                                </Pill>
                                {r.edited_by_admin && (
                                  <span className="ms-1.5 text-2xs text-muted-foreground">
                                    {t('compensationAll.amended', { defaultValue: 'amended' })}
                                  </span>
                                )}
                              </td>
                            );
                          }
                          if (c.key === 'raised') {
                            return (
                              <td
                                key={c.key}
                                className="whitespace-nowrap px-4 py-3 text-2xs tabular-nums text-muted-foreground"
                              >
                                {formatRelative(r.date_created)}
                              </td>
                            );
                          }
                          // A phone has no language: left-to-right wherever
                          // the page is going, or the + moves to the far end.
                          if (c.key === 'phone') {
                            return (
                              <td className="whitespace-nowrap px-4 py-3" key={c.key}>
                                <Ltr className="tabular-nums text-muted-foreground">{v || '—'}</Ltr>
                              </td>
                            );
                          }
                          // Free text is capped so one wordy complaint cannot
                          // push the terms off the side of the table.
                          const wide = c.key === 'reason' || c.key === 'note';
                          return (
                            <td
                              key={c.key}
                              // Free text, so the browser decides from the
                              // content: a title is usually the customer's
                              // phone but may be Arabic prose, and forcing
                              // either direction gets one of them wrong.
                              dir="auto"
                              title={wide && v ? v : undefined}
                              className={[
                                'px-4 py-3',
                                c.end
                                  ? 'text-end tabular-nums font-semibold text-foreground'
                                  : 'text-muted-foreground',
                                wide ? 'max-w-[18rem] truncate' : 'whitespace-nowrap',
                              ].join(' ')}
                            >
                              {v || '—'}
                            </td>
                          );
                        })}
                      </tr>
                    ))
                  )}
                </tbody>
              </Table>
            </TableSurface>
          )}

          <TablePager
            page={current}
            onPage={setPage}
            pageSize={pageSize}
            onPageSize={setPageSize}
            total={filtered.length}
            pageSizes={[10, 25, 50, 100, 250, 500]}
            labels={{
              rowsPerPage: String(
                t('complaintReport.rowsPerPage', { defaultValue: 'Rows per page' }),
              ),
              previous: String(t('pagination.prev', { defaultValue: 'Previous' })),
              next: String(t('pagination.next', { defaultValue: 'Next' })),
              showing: ({ from: f, to: tt, total }) =>
                String(
                  t('complaintReport.showingRange', {
                    defaultValue: 'Showing {{from}}-{{to}} of {{total}}',
                    from: f,
                    to: tt,
                    total,
                  }),
                ),
            }}
          />

          {historyOf && (
            /* The SAME drawer Ticket breakdown uses, pointed at a different
               collection. A second implementation would be a second opinion
               about what counts as a change. */
            <TicketHistoryDrawer
              ticketId={historyOf.id}
              collection="coupon_approvals"
              label={historyOf.label}
              userNames={userNames}
              onClose={() => setHistoryOf(null)}
            />
          )}

          {/* A dialog rather than a popover, matching the ticket breakdown:
              arranging 23 columns is a task, and it needs room, a search and a
              deliberate way out. */}
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
                    {t('compensationAll.columnCount', {
                      defaultValue: '{{n}} columns',
                      n: columns.length,
                    })}
                  </span>
                  <button
                    type="button"
                    className="text-2xs font-medium text-muted-foreground hover:text-foreground hover:underline"
                    onClick={resetOrder}
                  >
                    {t('complaintReport.resetOrder', { defaultValue: 'Reset order' })}
                  </button>
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
                {columns.map((c, i) => {
                  // Filtering hides rows but never renumbers them: the position
                  // shown is the real position in the report.
                  if (
                    colQuery.trim() &&
                    !c.label.toLowerCase().includes(colQuery.trim().toLowerCase())
                  ) {
                    return null;
                  }
                  return (
                    <li
                      key={c.key}
                      draggable
                      onDragStart={(e) => {
                        setDragKey(c.key);
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                      onDragEnd={() => setDragKey(null)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (!dragKey || dragKey === c.key) return;
                        reorderTo(dragKey, ordered.indexOf(c.key));
                        setDragKey(null);
                      }}
                      className={cn(
                        'flex items-center gap-1 rounded-lg',
                        dragKey === c.key && 'opacity-40',
                      )}
                    >
                      {/* Drag is the fast path; the arrows are the
                          keyboard-reachable one. */}
                      <span
                        aria-hidden
                        className="shrink-0 cursor-grab select-none px-1 text-muted-foreground/60 active:cursor-grabbing"
                        title={t('complaintReport.dragHint', { defaultValue: 'Drag to reorder' })}
                      >
                        ⠿
                      </span>
                      <span className="w-5 shrink-0 text-end text-2xs tabular-nums text-muted-foreground/70">
                        {i + 1}
                      </span>
                      <span className="flex-1 rounded-lg px-1.5 py-1.5 text-xs text-foreground">
                        {c.label}
                      </span>
                      <button
                        type="button"
                        disabled={i === 0}
                        onClick={() => moveCol(c.key, -1)}
                        aria-label={t('complaintReport.moveUp', {
                          col: c.label,
                          defaultValue: 'Move {{col}} earlier',
                        })}
                        className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-30"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        disabled={i === columns.length - 1}
                        onClick={() => moveCol(c.key, 1)}
                        aria-label={t('complaintReport.moveDown', {
                          col: c.label,
                          defaultValue: 'Move {{col}} later',
                        })}
                        className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-30"
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        disabled={i === 0}
                        onClick={() => moveCol(c.key, -i)}
                        aria-label={t('complaintReport.moveFirst', {
                          col: c.label,
                          defaultValue: 'Move {{col}} to the front',
                        })}
                        title={t('complaintReport.moveFirst', {
                          col: c.label,
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

          <ConfirmDialog
            open={!!confirmDelete}
            onCancel={() => setConfirmDelete(null)}
            onConfirm={() => {
              if (confirmDelete) del.mutate(confirmDelete.id);
              setConfirmDelete(null);
            }}
            destructive
            title={t('compensationAll.deleteTitle', { defaultValue: 'Delete this coupon record?' })}
            description={t('compensationAll.deleteConfirm', {
              label: confirmDelete?.label ?? '',
              defaultValue:
                'Delete \u201c{{label}}\u201d? The record goes; who deleted it stays in the change history. A coupon already issued to a customer is NOT recalled by this.',
            })}
            confirmLabel={t('complaintReport.deleteBtn', { defaultValue: 'Delete' })}
            cancelLabel={t('actions.cancel', { ns: 'common', defaultValue: 'Cancel' })}
          />
        </div>
        <ColumnScroller portRef={pinRef} />
      </div>
    </div>
  );
}
