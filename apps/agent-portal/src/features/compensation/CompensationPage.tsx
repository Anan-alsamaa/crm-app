import { normalizeOrderId, orderLabel } from '@yiji/shared-types';
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeftIcon,
  Button,
  EmptyState,
  ErrorState,
  FormField,
  InboxIcon,
  Input,
  Pill,
  Select,
  Skeleton,
  Table,
  TablePager,
  TableSurface,
  Td,
  Textarea,
  Th,
  Tr,
  cn,
  formatDateTime,
  pageCountOf,
  toast,
} from '@yiji/ui';
import {
  useCompensationRequests,
  useCompensationRequest,
  useCompensationItems,
  useTriggerCompensationFlow,
  useComIssues,
  useComplaintCategories,
  useUpdateRequest,
  COMPENSATION_STATUSES,
  type CompensationRow,
  type CompensationStatus,
  type IssueItem,
  type RequestPatch,
} from './api.js';
import {
  COMPENSATION_ACTIONS,
  type CompAction,
  type CompInput,
  type CompLinkType,
} from './actions.js';

const STATUS_TONE: Record<
  CompensationStatus,
  'warning' | 'neutral' | 'primary' | 'success' | 'muted' | 'destructive'
> = {
  Pending: 'warning',
  'In Progress': 'primary',
  Approved: 'success',
  Rejected: 'destructive',
};

const BTN_VARIANT: Record<CompLinkType, 'default' | 'brand' | 'destructive'> = {
  primary: 'default',
  danger: 'destructive',
  success: 'brand',
};

function money(n: number | null | undefined): string {
  if (n == null) return '—';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'SAR' }).format(n);
  } catch {
    return `${n} SAR`;
  }
}
function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : formatDateTime(iso);
}

function StatusPill({ status }: { status: CompensationStatus }) {
  return (
    <Pill tone={STATUS_TONE[status]} dot>
      {status}
    </Pill>
  );
}

/* ── Queue ───────────────────────────────────────────────────────── */

/**
 * THE QUEUE AS A REPORT (owner, 2026-10-22: the page "looks very bad - uses
 * half the page").
 *
 * It was a 5xl column of stacked cards, so on a desk monitor the right half of
 * the screen was empty canvas and only five requests fitted. Now it is the
 * admin console's report shape: the title block across the page, one filter
 * card, then one full-width table with its count and pager inside the card.
 * The data, the filter and where a row leads are unchanged.
 */
function RequestQueue() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data, isLoading, isError } = useCompensationRequests();
  const [filter, setFilter] = useState<'all' | CompensationStatus>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const rows = useMemo(
    () => (data ?? []).filter((r) => filter === 'all' || r.status === filter),
    [data, filter],
  );
  /* Per-status counts for the filter chips - read off the list already loaded. */
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: data?.length ?? 0 };
    for (const r of data ?? []) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [data]);
  const current = Math.min(page, pageCountOf(rows.length, pageSize));
  const paged = rows.slice((current - 1) * pageSize, current * pageSize);
  const open = (r: CompensationRow) => navigate(`/compensation-requests/${r.id}`);

  return (
    <div className="h-full w-full overflow-y-auto pb-10">
      {/* Title block: big title + description, the queue's size on the far side. */}
      <header className="agent-gutter flex flex-wrap items-end justify-between gap-x-6 gap-y-3 pb-5 pt-5">
        <div className="min-w-0">
          <h1 className="text-foreground">
            {t('compensation.title', { defaultValue: 'Compensation' })}
          </h1>
          <p className="mt-2 max-w-[46rem] text-sm leading-relaxed text-muted-foreground">
            {t('compensation.subtitle', {
              defaultValue: 'Review customer compensation requests and run each step.',
            })}
          </p>
        </div>
        {data && (
          <p className="text-sm text-muted-foreground">
            <span className="font-semibold tabular-nums text-foreground">{counts.all}</span>{' '}
            {t('compensation.requestsCount', { defaultValue: 'requests' })}
            <span aria-hidden className="mx-2 opacity-50">
              ·
            </span>
            <span className="font-semibold tabular-nums text-foreground">
              {counts.Pending ?? 0}
            </span>{' '}
            {t('compensation.pendingCount', { defaultValue: 'pending' })}
          </p>
        )}
      </header>

      <div className="agent-gutter space-y-4">
        {/* Filter card: the status chips, each with its count. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl bg-card px-4 py-3">
          <span className="text-sm font-semibold text-foreground/80">
            {t('compensation.statusFilter', { defaultValue: 'Status' })}
          </span>
          <div
            role="group"
            aria-label={t('compensation.statusFilter', { defaultValue: 'Status' })}
            className="flex flex-wrap gap-1.5"
          >
            {(['all', ...COMPENSATION_STATUSES] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={filter === s}
                onClick={() => {
                  setFilter(s);
                  setPage(1);
                }}
                className={cn(
                  'inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-xs font-semibold transition-colors duration-fast',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                  // The current view is the solid ink chip; the others are usable
                  // secondary actions in the soft brand fill.
                  filter === s
                    ? 'bg-ink text-ink-foreground'
                    : 'bg-primary/10 text-primary hover:bg-primary/[0.17]',
                )}
              >
                {s === 'all' ? t('compensation.all', { defaultValue: 'All' }) : s}
                {/* The count is a glance aid; the chip's name stays the status. */}
                {data && (
                  <span
                    aria-hidden
                    className={cn(
                      'font-medium tabular-nums',
                      filter === s ? 'text-ink-foreground/80' : 'text-primary',
                    )}
                  >
                    {counts[s] ?? 0}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {isLoading ? (
          <div className="space-y-px overflow-hidden rounded-2xl bg-card p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full rounded-xl" />
            ))}
          </div>
        ) : isError ? (
          // Composed failure state on the card surface — a bare sentence adrift
          // under the filters reads as a rendering bug, not as an error.
          <div className="rounded-2xl bg-card">
            <ErrorState
              title={t('compensation.loadError', {
                defaultValue: 'Could not load compensation requests.',
              })}
            />
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-2xl bg-card">
            <EmptyState
              icon={<InboxIcon size={24} />}
              title={t('compensation.empty', { defaultValue: 'No compensation requests' })}
              description={t('compensation.emptyHint', {
                defaultValue: 'Requests submitted by customers will appear here.',
              })}
            />
          </div>
        ) : (
          <TableSurface
            scrollLabel={t('compensation.title', { defaultValue: 'Compensation' })}
            footer={
              <div className="px-6 py-3">
                <TablePager
                  page={current}
                  onPage={setPage}
                  pageSize={pageSize}
                  onPageSize={(n) => {
                    setPageSize(n);
                    setPage(1);
                  }}
                  total={rows.length}
                  labels={{
                    rowsPerPage: String(
                      t('compensation.rowsPerPage', { defaultValue: 'Rows per page' }),
                    ),
                    previous: String(
                      t('actions.previous', { ns: 'common', defaultValue: 'Previous' }),
                    ),
                    next: String(t('actions.next', { ns: 'common', defaultValue: 'Next' })),
                    showing: ({ from, to, total }) =>
                      String(
                        t('compensation.showingRange', {
                          defaultValue: 'Showing {{from}}-{{to}} of {{total}}',
                          from,
                          to,
                          total,
                        }),
                      ),
                  }}
                />
              </div>
            }
          >
            <Table>
              <thead>
                <Tr>
                  <Th>{t('compensation.colRequest', { defaultValue: 'Request' })}</Th>
                  <Th>{t('compensation.customer', { defaultValue: 'Customer' })}</Th>
                  <Th>{t('compensation.colPlace', { defaultValue: 'Brand / restaurant' })}</Th>
                  <Th>{t('compensation.order', { defaultValue: 'Order' })}</Th>
                  <Th>{t('compensation.statusFilter', { defaultValue: 'Status' })}</Th>
                  <Th className="text-end">
                    {t('compensation.colAmount', { defaultValue: 'Amount' })}
                  </Th>
                  <Th className="text-end">
                    {t('compensation.colCreated', { defaultValue: 'Created' })}
                  </Th>
                </Tr>
              </thead>
              <tbody>
                {paged.map((r) => (
                  <QueueRow key={r.id} row={r} onOpen={() => open(r)} />
                ))}
              </tbody>
            </Table>
          </TableSurface>
        )}
      </div>
    </div>
  );
}

/**
 * One request, one row. The whole row opens it (as the card did); the request
 * code is a real button so the row stays reachable from the keyboard.
 */
function QueueRow({ row, onOpen }: { row: CompensationRow; onOpen: () => void }) {
  const { t } = useTranslation();
  const place = [row.brand_name, row.restaurant_name].filter(Boolean).join(' · ');
  return (
    <Tr className="cursor-pointer" onClick={onOpen}>
      <Td>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          aria-label={t('compensation.openRequest', {
            code: row.request_code ?? row.id.slice(0, 8),
            defaultValue: 'Open request {{code}}',
          })}
          className="rounded-md font-mono text-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {row.request_code ?? row.id.slice(0, 8)}
        </button>
      </Td>
      <Td>
        <div className="max-w-[16rem] truncate font-semibold text-foreground">
          {row.customer_name ?? row.customer_mobile ?? '—'}
        </div>
        {row.customer_name && row.customer_mobile && (
          <div className="mt-0.5 text-xs tabular-nums text-muted-foreground" dir="ltr">
            {row.customer_mobile}
          </div>
        )}
      </Td>
      <Td>
        <span className="block max-w-[20rem] truncate text-foreground/90">{place || '—'}</span>
      </Td>
      <Td className="tabular-nums text-foreground/90">
        {normalizeOrderId(row.order_id) ? `#${row.order_id}` : '—'}
      </Td>
      <Td>
        <StatusPill status={row.status} />
      </Td>
      <Td className="text-end text-base font-bold tabular-nums tracking-[-0.02em] text-foreground">
        {money(row.final_compensation_value ?? row.user_complaint_amount)}
      </Td>
      <Td className="text-end text-xs tabular-nums text-muted-foreground">
        {fmtDate(row.date_created)}
      </Td>
    </Tr>
  );
}

/* ── Detail ──────────────────────────────────────────────────────── */

/**
 * One fact about the request. The label sits ABOVE its value rather than
 * opposite it: the old side-by-side row truncated every value that mattered
 * (restaurant names, coupon codes, decline reasons) to fit a narrow column.
 */
function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0 py-2">
      <dt className="text-xs font-semibold text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words text-sm font-medium text-foreground">{value}</dd>
    </div>
  );
}

function Section({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('rounded-2xl bg-card px-6 pb-5 pt-5', className)}>
      <h2 className="mb-2 text-base font-semibold tracking-tight text-foreground">{title}</h2>
      <dl className="grid gap-x-8 gap-y-1 sm:grid-cols-2">{children}</dl>
    </section>
  );
}

/** A label / value line in the side summary: label on the start, value at the end. */
function SummaryLine({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <dt className="shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-end text-sm font-semibold text-foreground">
        {value}
      </dd>
    </div>
  );
}

function RequestDetail({ id }: { id: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: r, isLoading } = useCompensationRequest(id);
  const { data: items } = useCompensationItems(id);

  /* Back to the queue, at the top of every state of this page. */
  const back = (
    <Button
      variant="ghost"
      size="sm"
      iconStart={<ArrowLeftIcon size={16} className="rtl:-scale-x-100" />}
      onClick={() => navigate('/compensation')}
    >
      {t('compensation.back', { defaultValue: 'Back' })}
    </Button>
  );

  if (isLoading) {
    return (
      <div className="h-full w-full overflow-y-auto pb-10">
        <div className="agent-gutter space-y-4 pt-5">
          <Skeleton className="h-8 w-24 rounded-full" />
          <Skeleton className="h-10 w-72" />
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
            <Skeleton className="h-72 w-full rounded-2xl" />
            <Skeleton className="h-72 w-full rounded-2xl" />
          </div>
        </div>
      </div>
    );
  }
  if (!r) {
    return (
      <div className="h-full w-full overflow-y-auto pb-10">
        <div className="agent-gutter pt-5">
          {back}
          {/* The "nothing here" card, rather than a stray sentence under the
              Back button. */}
          <div className="mt-4 rounded-2xl bg-card">
            <EmptyState
              title={t('compensation.notFound', { defaultValue: 'Request not found.' })}
            />
          </div>
        </div>
      </div>
    );
  }

  const place = [r.brand_name, r.restaurant_name].filter(Boolean).join(' · ');

  /*
   * TWO COLUMNS THAT FILL THE PAGE (owner, 2026-10-22).
   *
   * The work - the actions and the four editable sections - runs in the wide
   * main column; the facts anyone opening a request needs first (where it
   * stands, how much, which coupon) sit in a side summary that stays in view
   * while the main column scrolls. Below xl the summary drops under the title,
   * before the work, so a laptop still opens on the answer.
   */
  return (
    <div className="h-full w-full overflow-y-auto pb-10">
      <header className="agent-gutter pb-5 pt-5">
        {back}
        <div className="mt-4 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm text-muted-foreground">
                {r.request_code ?? r.id.slice(0, 8)}
              </span>
              <StatusPill status={r.status} />
            </div>
            <h1 className="mt-2 truncate text-foreground">
              {r.customer_name ?? t('compensation.unknownCustomer', { defaultValue: 'Customer' })}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {place || '—'}
              {normalizeOrderId(r.order_id) ? ` · #${r.order_id}` : ''}
            </p>
          </div>
        </div>
      </header>

      <div className="agent-gutter grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        {/* Side summary - first in the source so it leads on a narrow screen,
            placed in the end column on a wide one. */}
        <aside className="space-y-4 xl:sticky xl:top-4 xl:col-start-2 xl:row-start-1">
          <section className="rounded-2xl bg-card px-6 pb-4 pt-5">
            <h2 className="text-base font-semibold tracking-tight text-foreground">
              {t('compensation.summary', { defaultValue: 'Summary' })}
            </h2>
            <div className="mt-4 rounded-2xl bg-secondary/70 px-4 py-4">
              <div className="text-xs font-semibold text-muted-foreground">
                {t('compensation.final', { defaultValue: 'Final value' })}
              </div>
              <div className="mt-1.5 text-[2.25rem] font-bold leading-none tabular-nums tracking-[-0.035em] text-foreground">
                {money(r.final_compensation_value)}
              </div>
              {r.suggested_compensation_value != null && (
                <div className="mt-2 text-xs text-muted-foreground">
                  {t('compensation.suggested', { defaultValue: 'Suggested' })}:{' '}
                  <span className="font-semibold tabular-nums text-foreground">
                    {r.suggested_compensation_value}
                  </span>
                </div>
              )}
            </div>
            <dl className="mt-2 divide-y divide-foreground/[0.06]">
              <SummaryLine
                label={t('compensation.statusFilter', { defaultValue: 'Status' })}
                value={<StatusPill status={r.status} />}
              />
              <SummaryLine
                label={t('compensation.coupon', { defaultValue: 'Coupon' })}
                value={<span className="font-mono">{r.coupons?.Code ?? r.coupon_code ?? '—'}</span>}
              />
              <SummaryLine
                label={t('compensation.claimed', { defaultValue: 'Claimed amount' })}
                value={<span className="tabular-nums">{money(r.user_complaint_amount)}</span>}
              />
              <SummaryLine label="#" value={orderLabel(r.order_id)} />
              <SummaryLine
                label={t('compensation.colCreated', { defaultValue: 'Created' })}
                value={<span className="tabular-nums">{fmtDate(r.date_created)}</span>}
              />
              {r.decline_reason && (
                <SummaryLine
                  label={t('compensation.declineReason', { defaultValue: 'Decline reason' })}
                  value={r.decline_reason}
                />
              )}
            </dl>
          </section>
        </aside>

        <div className="min-w-0 space-y-4 xl:col-start-1 xl:row-start-1">
          <ActionPanel request={r} />

          <div className="grid gap-4 2xl:grid-cols-2">
            <Section title={t('compensation.customer', { defaultValue: 'Customer' })}>
              <Row
                label={t('compensation.name', { defaultValue: 'Name' })}
                value={r.customer_name ?? '—'}
              />
              <Row
                label={t('compensation.mobile', { defaultValue: 'Mobile' })}
                value={r.customer_mobile ?? '—'}
              />
              <Row label="ID" value={r.customer_id ?? '—'} />
            </Section>
            <Section title={t('compensation.order', { defaultValue: 'Order' })}>
              <Row label="#" value={orderLabel(r.order_id)} />
              <Row
                label={t('compensation.brand', { defaultValue: 'Brand' })}
                value={r.brand_name ?? '—'}
              />
              <Row
                label={t('compensation.restaurant', { defaultValue: 'Restaurant' })}
                value={r.restaurant_name ?? '—'}
              />
              <div className="mt-1 grid gap-3 sm:col-span-2 sm:grid-cols-2">
                <EditableAmount
                  request={r}
                  field="order_total"
                  label={t('compensation.orderTotal', { defaultValue: 'Order total (SAR)' })}
                />
                <EditableAmount
                  request={r}
                  field="delivery_fee"
                  label={t('compensation.deliveryFee', { defaultValue: 'Delivery fee (SAR)' })}
                  hint={t('compensation.deliveryFeeHint', {
                    defaultValue: 'Used by DELIVERY-type compensation rules.',
                  })}
                />
              </div>
            </Section>
            <Section title={t('compensation.complaint', { defaultValue: 'Ticket' })}>
              <div className="sm:col-span-2">
                <ClassificationEditor request={r} />
              </div>
              <div className="mt-1 sm:col-span-2">
                <EditableAmount
                  request={r}
                  field="user_complaint_amount"
                  label={t('compensation.claimed', { defaultValue: 'Claimed amount (SAR)' })}
                  hint={t('compensation.claimedHint', {
                    defaultValue: 'Used by PERCENT-type compensation rules.',
                  })}
                />
              </div>
              {r.description && (
                <p className="mt-3 whitespace-pre-wrap rounded-xl bg-secondary/60 px-4 py-3 text-sm leading-relaxed text-foreground/90 sm:col-span-2">
                  {r.description}
                </p>
              )}
            </Section>
            <Section title={t('compensation.resolution', { defaultValue: 'Compensation' })}>
              <Row
                label={t('compensation.suggested', { defaultValue: 'Suggested' })}
                value={r.suggested_compensation_value ?? '—'}
              />
              <Row
                label={t('compensation.final', { defaultValue: 'Final value' })}
                value={money(r.final_compensation_value)}
              />
              <Row
                label={t('compensation.coupon', { defaultValue: 'Coupon' })}
                value={r.coupons?.Code ?? r.coupon_code ?? '—'}
              />
              {r.decline_reason && (
                <Row
                  label={t('compensation.declineReason', { defaultValue: 'Decline reason' })}
                  value={r.decline_reason}
                />
              )}
            </Section>
          </div>

          <ItemsEditor request={r} />

          {items && items.length > 0 && (
            <Section title={t('compensation.orderItems', { defaultValue: 'Order line items' })}>
              <ul className="divide-y divide-foreground/[0.06] text-sm sm:col-span-2">
                {items.map((it) => (
                  <li key={it.id} className="flex items-baseline justify-between gap-3 py-2.5">
                    <span className="min-w-0">
                      <span className="me-2 tabular-nums text-muted-foreground">
                        {it.quantity ?? 1}×
                      </span>
                      <span className="break-words text-foreground">{it.name}</span>
                    </span>
                    <span className="shrink-0 font-semibold tabular-nums text-foreground">
                      {money(it.price)}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Classification editor (the request's "related data") ────────────── */

/**
 * Lets ops set the request's Category + Issue from the portal — the related data
 * the workflow buttons read: the Issue (com_issue) drives the SLA timers
 * (Acknowledge/Approve) and the compensation rules (Calculate). Ops have no
 * Directus access, so this is the only place they can classify a request. The
 * Agent policy permits updating only these two fields; auto-saves on change.
 */
function ClassificationEditor({ request }: { request: CompensationRow }) {
  const { t } = useTranslation();
  const { data: categories } = useComplaintCategories();
  const { data: issues } = useComIssues();
  const update = useUpdateRequest();
  const [catId, setCatId] = useState<string>(request.complaint_type?.id ?? '');
  const [issueId, setIssueId] = useState<string>(request.com_issue?.id ?? '');

  // Only offer Issues that belong to the chosen Category (all if none chosen).
  const issueOptions = useMemo(
    () =>
      (issues ?? []).filter((i) => !catId || String(i.com_issue_category ?? '') === String(catId)),
    [issues, catId],
  );

  const save = (patch: { com_issue?: string | null; complaint_type?: string | null }) =>
    update.mutate(
      { requestId: request.id, patch },
      {
        onError: () =>
          toast.error(
            t('compensation.classifyError', { defaultValue: 'Could not save. Try again.' }),
          ),
      },
    );

  const onCategory = (v: string) => {
    setCatId(v);
    // Drop the Issue if it no longer belongs to the newly chosen Category.
    const keep = (issues ?? []).some(
      (i) => i.id === issueId && String(i.com_issue_category ?? '') === String(v),
    );
    if (!keep) setIssueId('');
    save({ complaint_type: v || null, ...(keep ? {} : { com_issue: null }) });
  };
  const onIssue = (v: string) => {
    setIssueId(v);
    save({ com_issue: v || null });
  };

  return (
    <div className="mb-1 grid gap-3 sm:grid-cols-2">
      <FormField label={t('compensation.type', { defaultValue: 'Category' })}>
        <Select value={catId} onChange={(e) => onCategory(e.currentTarget.value)}>
          <option value="">
            {t('compensation.unclassified', { defaultValue: 'Unclassified' })}
          </option>
          {(categories ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name ?? c.id}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField
        label={t('compensation.issue', { defaultValue: 'Issue' })}
        hint={t('compensation.issueHint', {
          defaultValue: 'Drives the SLA timers and the compensation calculation.',
        })}
      >
        <Select value={issueId} onChange={(e) => onIssue(e.currentTarget.value)}>
          <option value="">
            {t('compensation.selectIssue', { defaultValue: 'Select an issue…' })}
          </option>
          {issueOptions.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name ?? i.id}
            </option>
          ))}
        </Select>
      </FormField>
    </div>
  );
}

/* ── Order / amounts + items editors (data the calc rules read) ──────── */

type AmountField = 'order_total' | 'delivery_fee' | 'user_complaint_amount';

/**
 * An inline-editable currency amount that the compensation rules read
 * (DELIVERY → delivery_fee, PERCENT → user_complaint_amount, …). Saves on blur,
 * only when changed. Agent policy permits these fields; other writes go via flows.
 */
function EditableAmount({
  request,
  field,
  label,
  hint,
}: {
  request: CompensationRow;
  field: AmountField;
  label: string;
  hint?: string;
}) {
  const { t } = useTranslation();
  const update = useUpdateRequest();
  const [val, setVal] = useState<string>(request[field] == null ? '' : String(request[field]));

  const save = () => {
    const trimmed = val.trim();
    const num = trimmed === '' ? null : Number(trimmed);
    if (num !== null && Number.isNaN(num)) return;
    if ((num ?? null) === (request[field] ?? null)) return; // unchanged
    update.mutate(
      { requestId: request.id, patch: { [field]: num } as RequestPatch },
      {
        onError: () =>
          toast.error(t('compensation.saveError', { defaultValue: 'Could not save. Try again.' })),
      },
    );
  };

  return (
    <FormField label={label} hint={hint}>
      <Input
        type="number"
        inputMode="decimal"
        step="0.01"
        value={val}
        onChange={(e) => setVal(e.currentTarget.value)}
        onBlur={save}
      />
    </FormField>
  );
}

/**
 * Editor for `items_with_issue` — the JSON list an ITEMS-rule calculation sums
 * (Σ price). Ops add/remove rows and edit name/price/quantity; the whole array
 * is saved on blur / add / remove.
 */
function ItemsEditor({ request }: { request: CompensationRow }) {
  const { t } = useTranslation();
  const update = useUpdateRequest();
  const [items, setItems] = useState<IssueItem[]>(() => request.items_with_issue ?? []);

  const persist = (next: IssueItem[]) => {
    setItems(next);
    update.mutate(
      { requestId: request.id, patch: { items_with_issue: next } },
      {
        onError: () =>
          toast.error(t('compensation.saveError', { defaultValue: 'Could not save. Try again.' })),
      },
    );
  };
  const edit = (i: number, key: keyof IssueItem, raw: string) =>
    setItems((prev) =>
      prev.map((it, idx) =>
        idx === i
          ? { ...it, [key]: key === 'name' ? raw : raw.trim() === '' ? null : Number(raw) }
          : it,
      ),
    );
  const total = items.reduce((s, it) => s + (Number(it.price) || 0), 0);

  return (
    <Section title={t('compensation.itemsWithIssue', { defaultValue: 'Items with issue' })}>
      <p className="mb-3 text-xs text-muted-foreground sm:col-span-2">
        {t('compensation.itemsWithIssueHint', {
          defaultValue: 'Used by ITEMS-type compensation rules (sums the prices below).',
        })}
      </p>
      {items.length > 0 && (
        <ul className="mb-3 space-y-2 sm:col-span-2">
          {items.map((it, i) => (
            <li key={i} className="flex items-center gap-2">
              <Input
                className="flex-1"
                placeholder={t('compensation.itemName', { defaultValue: 'Item' })}
                value={it.name ?? ''}
                onChange={(e) => edit(i, 'name', e.currentTarget.value)}
                onBlur={() => persist(items)}
              />
              <Input
                className="w-20"
                type="number"
                inputMode="numeric"
                placeholder="Qty"
                value={it.quantity ?? ''}
                onChange={(e) => edit(i, 'quantity', e.currentTarget.value)}
                onBlur={() => persist(items)}
              />
              <Input
                className="w-28"
                type="number"
                inputMode="decimal"
                step="0.01"
                placeholder={t('compensation.price', { defaultValue: 'Price' })}
                value={it.price ?? ''}
                onChange={(e) => edit(i, 'price', e.currentTarget.value)}
                onBlur={() => persist(items)}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={t('compensation.removeItem', { defaultValue: 'Remove item' })}
                onClick={() => persist(items.filter((_, idx) => idx !== i))}
              >
                ✕
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between sm:col-span-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => persist([...items, { name: '', quantity: 1, price: null }])}
        >
          + {t('compensation.addItem', { defaultValue: 'Add item' })}
        </Button>
        {items.length > 0 && (
          <span className="text-sm tabular-nums text-muted-foreground">
            {t('compensation.itemsTotal', { defaultValue: 'Total' })}: {money(total)}
          </span>
        )}
      </div>
    </Section>
  );
}

/* ── Action panel ────────────────────────────────────────────────── */

function ActionPanel({ request }: { request: CompensationRow }) {
  const { t } = useTranslation();
  const trigger = useTriggerCompensationFlow();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  // The action whose input form is open (null = none). Only actions with
  // `inputs` open a form; the rest fire on click.
  const [formKey, setFormKey] = useState<string | null>(null);

  // Fire this record's Directus flow. Actions with no manual inputs are
  // one-click; actions with inputs pass the operator's values as the flow
  // trigger body (the SAME fields prod's manual-trigger dialog asks for), so
  // Directus still owns all the logic — the portal only collects + forwards.
  const run = (a: CompAction, inputs?: Record<string, unknown>) => {
    setPendingKey(a.key);
    trigger.mutate(
      { flowId: a.flowId, requestId: request.id, inputs },
      {
        onSuccess: () => {
          setFormKey(null);
          toast.success(
            t('compensation.done', { label: a.label, defaultValue: '{{label}} done.' }),
          );
        },
        onError: () =>
          toast.error(t('compensation.actionError', { defaultValue: 'Action failed. Try again.' })),
        onSettled: () => setPendingKey(null),
      },
    );
  };

  const onClick = (a: CompAction) => {
    if (a.inputs.length === 0) {
      run(a);
      return;
    }
    // Toggle the form for this action (close it if it's already open).
    setFormKey((k) => (k === a.key ? null : a.key));
  };

  const openAction = COMPENSATION_ACTIONS.find((a) => a.key === formKey) ?? null;

  return (
    <div className="rounded-2xl bg-card px-6 py-5">
      <h2 className="mb-3.5 text-base font-semibold tracking-tight text-foreground">
        {t('compensation.actions', { defaultValue: 'Actions' })}
      </h2>
      <div className="flex flex-wrap gap-2">
        {COMPENSATION_ACTIONS.map((a) => (
          <Button
            key={a.key}
            size="sm"
            variant={BTN_VARIANT[a.type]}
            onClick={() => onClick(a)}
            loading={pendingKey === a.key}
            disabled={trigger.isPending && pendingKey !== a.key}
            aria-expanded={a.inputs.length > 0 ? formKey === a.key : undefined}
          >
            {a.label}
          </Button>
        ))}
      </div>

      {openAction && (
        <ActionForm
          key={openAction.key}
          action={openAction}
          pending={pendingKey === openAction.key}
          onCancel={() => setFormKey(null)}
          onSubmit={(inputs) => run(openAction, inputs)}
        />
      )}
    </div>
  );
}

/**
 * The input form for an action whose prod flow requires manual fields. Renders
 * one control per `action.inputs` entry, enforces `required`, and hands the
 * collected values back so they ride along with the flow trigger.
 */
function ActionForm({
  action,
  pending,
  onCancel,
  onSubmit,
}: {
  action: CompAction;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (inputs: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, boolean>>({});

  const set = (field: string, v: string) => {
    setValues((prev) => ({ ...prev, [field]: v }));
    if (errors[field]) setErrors((prev) => ({ ...prev, [field]: false }));
  };

  const submit = () => {
    const nextErrors: Record<string, boolean> = {};
    for (const inp of action.inputs) {
      if (inp.required && !(values[inp.field] ?? '').trim()) nextErrors[inp.field] = true;
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    // Only forward fields the operator actually filled — matches Directus'
    // manual trigger, which omits untouched optional inputs.
    const inputs: Record<string, unknown> = {};
    for (const inp of action.inputs) {
      const v = (values[inp.field] ?? '').trim();
      if (v) inputs[inp.field] = v;
    }
    onSubmit(inputs);
  };

  return (
    <form
      className="mt-4 space-y-4 rounded-2xl bg-secondary/60 p-5"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="text-sm font-semibold text-foreground">
        {t('compensation.formTitle', {
          label: action.label,
          defaultValue: '{{label}} — fill the required fields',
        })}
      </p>
      {action.inputs.map((inp) => (
        <ActionInput
          key={inp.field}
          input={inp}
          value={values[inp.field] ?? ''}
          invalid={errors[inp.field] ?? false}
          onChange={(v) => set(inp.field, v)}
        />
      ))}
      <div className="flex flex-wrap gap-2 pt-1">
        <Button type="submit" size="sm" variant={BTN_VARIANT[action.type]} loading={pending}>
          {t('compensation.submit', { label: action.label, defaultValue: 'Confirm {{label}}' })}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
          {t('compensation.cancel', { defaultValue: 'Cancel' })}
        </Button>
      </div>
    </form>
  );
}

function ActionInput({
  input,
  value,
  invalid,
  onChange,
}: {
  input: CompInput;
  value: string;
  invalid: boolean;
  onChange: (v: string) => void;
}) {
  const { t } = useTranslation();
  const label = (
    <>
      {input.label}
      {input.required && <span className="text-destructive"> *</span>}
    </>
  );
  const error = invalid
    ? t('compensation.required', { defaultValue: 'This field is required.' })
    : undefined;

  return (
    <FormField label={label} error={error}>
      {input.kind === 'text' ? (
        <Textarea
          value={value}
          invalid={invalid}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      ) : input.kind === 'select' ? (
        <Select value={value} invalid={invalid} onChange={(e) => onChange(e.currentTarget.value)}>
          <option value="">
            {t('compensation.selectPlaceholder', { defaultValue: 'Select…' })}
          </option>
          {(input.choices ?? []).map((c) => (
            <option key={c.value} value={c.value}>
              {c.text}
            </option>
          ))}
        </Select>
      ) : (
        <Input
          type={input.kind === 'dateTime' ? 'datetime-local' : 'text'}
          value={value}
          invalid={invalid}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      )}
    </FormField>
  );
}

/* ── Route entry ─────────────────────────────────────────────────── */

export function CompensationPage() {
  const { id } = useParams<{ id: string }>();
  return id ? <RequestDetail id={id} /> : <RequestQueue />;
}
