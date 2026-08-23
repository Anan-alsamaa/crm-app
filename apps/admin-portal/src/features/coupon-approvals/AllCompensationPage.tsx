import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { readItems } from '@directus/sdk';
import {
  Button,
  DateField,
  ExportButtons,
  formatDate,
  formatRelative,
  Input,
  Ltr,
  pageCountOf,
  Pill,
  ReportKpi,
  ReportKpiStrip,
  SelectMenu,
  Skeleton,
  Table,
  TablePager,
  TableSurface,
  Th,
  Toolbar,
  ToolbarSpacer,
} from '@yiji/ui';
import { exportFileName } from '@yiji/shared-config';
import { directus } from '../../lib/directus.js';
import { downloadCsv, toCsv } from '@yiji/reports';

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

interface Column {
  key: string;
  label: string;
  end?: boolean;
  get: (r: Row) => string;
}

export function AllCompensationPage() {
  const { t } = useTranslation();
  const rows = useAllCoupons();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [agent, setAgent] = useState('');
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  // The right page size differs by task: 25 to read the queue, 500 to scan a
  // month before exporting. One fixed size served neither.
  const [pageSize, setPageSize] = useState(PAGE_SIZE);

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
      const st = (r.status ?? 'pending').toLowerCase();
      if (st === 'approved' || st === 'assigned') approved += 1;
      if (st === 'pending') pending += 1;
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

  const columns: Column[] = [
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
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t('compensationAll.title', { defaultValue: 'Compensation' })}
        </h1>
        <ToolbarSpacer />
        <span className="text-2xs tabular-nums text-muted-foreground">
          {t('compensationAll.count', {
            defaultValue: '{{n}} of {{total}}',
            n: filtered.length,
            total: list.length,
          })}
        </span>
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
      </Toolbar>

      <div className="flex-1 overflow-auto px-4 py-4 sm:px-6 sm:py-5 lg:px-8">
        <div className="space-y-5">
          <div className="border-b border-foreground/10 pb-5">
            <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
              {t('compensationAll.hint', {
                defaultValue:
                  'Every coupon anyone has asked for, whatever state it reached, with the full terms of each. Admin statistics is the supervisor view of those decisions; this is the record.',
              })}
            </p>
          </div>

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

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,16rem)_9rem_9rem_minmax(0,12rem)_minmax(0,10rem)_auto]">
            <label className="block space-y-1">
              <span className="block text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {t('actions.search', { ns: 'common', defaultValue: 'Search' })}
              </span>
              <Input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(1);
                }}
                placeholder={t('compensationAll.searchPlaceholder', {
                  defaultValue: 'Order ID, code, customer, phone, brand',
                })}
                aria-label={t('actions.search', { ns: 'common', defaultValue: 'Search' })}
              />
            </label>
            <label className="block space-y-1">
              <span className="block text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {t('performance.from', { defaultValue: 'From' })}
              </span>
              <DateField
                value={from}
                onChange={(v) => {
                  setFrom(v);
                  setPage(1);
                }}
                aria-label={t('performance.from', { defaultValue: 'From' })}
              />
            </label>
            <label className="block space-y-1">
              <span className="block text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {t('performance.to', { defaultValue: 'To' })}
              </span>
              <DateField
                value={to}
                onChange={(v) => {
                  setTo(v);
                  setPage(1);
                }}
                aria-label={t('performance.to', { defaultValue: 'To' })}
              />
            </label>
            <label className="block space-y-1">
              <span className="block text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {t('compensationAll.agent', { defaultValue: 'Assigned by' })}
              </span>
              <SelectMenu
                fullWidth
                value={agent}
                onChange={(v) => {
                  setAgent(v);
                  setPage(1);
                }}
                aria-label={t('compensationAll.agent', { defaultValue: 'Assigned by' })}
                options={[
                  { value: '', label: t('compensationAll.anyAgent', { defaultValue: 'Anyone' }) },
                  ...agents,
                ]}
              />
            </label>
            <label className="block space-y-1">
              <span className="block text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {t('compensationAll.state', { defaultValue: 'Status' })}
              </span>
              <SelectMenu
                fullWidth
                value={status}
                onChange={(v) => {
                  setStatus(v);
                  setPage(1);
                }}
                aria-label={t('compensationAll.state', { defaultValue: 'Status' })}
                options={[
                  { value: '', label: t('agentReports.statusAll', { defaultValue: 'All' }) },
                  ...statuses.map((s) => ({
                    value: s,
                    label: t(`status.${s}`, { ns: 'common', defaultValue: s }),
                  })),
                ]}
              />
            </label>
            {filtering && (
              <div className="flex items-end">
                <Button type="button" variant="ghost" size="sm" onClick={reset}>
                  {t('inbox.clearFilters', { defaultValue: 'Clear filters' })}
                </Button>
              </div>
            )}
          </div>

          {rows.isLoading ? (
            <Skeleton className="h-64 w-full rounded-2xl" />
          ) : (
            /* The shared table shell, like every other report: one rounded
               surface, one scroll container, and a sticky header row. This page
               hand-rolled its own, so its header scrolled away and a reader
               thirty rows down had to scroll back up to learn which column
               they were looking at. */
            <TableSurface
              maxHeight="calc(100vh - 24rem)"
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
                      <tr
                        key={r.id}
                        className="border-t border-foreground/[0.06] transition-colors duration-fast hover:bg-primary/[0.07]"
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
        </div>
      </div>
    </div>
  );
}
