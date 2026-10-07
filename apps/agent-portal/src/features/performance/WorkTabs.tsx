import { useMemo, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  EmptyState,
  ErrorState,
  formatDateTime,
  InboxIcon,
  Pill,
  Skeleton,
  TicketIcon,
} from '@yiji/ui';
import { formatDuration } from '@yiji/reports';
import {
  couponOrderId,
  displayContactName,
  normaliseTicketStatus,
  normalizePhone,
} from '@yiji/shared-types';
import { isForbidden } from '../../lib/directus.js';
import {
  useCouponPerformance,
  useTicketPerformance,
  type PerformanceCouponRow,
  type PerformanceFilters,
} from './api.js';
import { couponStage, matchesSearch, mean, median, type CouponStage } from './search.js';
import { Tile } from './Tile.js';

/**
 * The Tickets and Coupons tabs of the agent performance page (owner,
 * 2026-10-07): "In the user portal performance page we must have 3 subpages:
 * Chats, Tickets and Coupons. Each must display data, and like the Chat by chat
 * table, a click on a row redirects to the ticket / chat page."
 *
 * The SUMMARY tiles count the whole range; the search box narrows the TABLE
 * only — the same split the Chats tab makes, so a search never quietly
 * rewrites the headline numbers.
 */

const TH = 'px-4 py-2.5 text-start font-semibold';
const HEAD_ROW =
  'tracking-[0.12em] bg-secondary/70 text-2xs uppercase tracking-[0.14em] text-muted-foreground shadow-[inset_0_-1px_0_oklch(var(--foreground)/0.08)]';
const BODY_ROW =
  'cursor-pointer border-t border-foreground/[0.06] transition-colors duration-fast hover:bg-primary/[0.07]';

const STAGE_TONE: Record<
  CouponStage,
  'highlight' | 'success' | 'warning' | 'destructive' | 'muted'
> = {
  waitingApproval: 'highlight',
  approved: 'success',
  delivered: 'success',
  createdNotAssigned: 'muted',
  waitingSignup: 'warning',
  rejected: 'destructive',
};

/** Every stage spelled out, so the i18n guard can see each key. */
function useStageLabel() {
  const { t } = useTranslation();
  return (s: CouponStage): string => {
    switch (s) {
      case 'waitingApproval':
        return t('performance.stage.waitingApproval', { defaultValue: 'Waiting for approval' });
      case 'approved':
        return t('performance.stage.approved', { defaultValue: 'Approved' });
      case 'delivered':
        return t('performance.stage.delivered', { defaultValue: 'Delivered to Yiji' });
      case 'createdNotAssigned':
        return t('performance.stage.createdNotAssigned', {
          defaultValue: 'Created on Yiji, not assigned',
        });
      case 'waitingSignup':
        return t('performance.stage.waitingSignup', {
          defaultValue: 'Waiting for the customer to join Yiji',
        });
      case 'rejected':
        return t('performance.stage.rejected', { defaultValue: 'Rejected' });
    }
  };
}

function money(n: number): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'SAR' }).format(n);
  } catch {
    return `${n} SAR`;
  }
}

function couponValue(r: PerformanceCouponRow): string {
  if (r.coupon_percent != null && (r.discount_category === 'Percentage' || r.coupon_value == null))
    return `${r.coupon_percent}%`;
  if (r.coupon_value != null) return money(r.coupon_value);
  return '—';
}

/** Loading, refused, failed or empty — the four ways a tab has no table. */
function tabState({
  isLoading,
  error,
  empty,
  forbiddenTitle,
  errorTitle,
  emptyTitle,
}: {
  isLoading: boolean;
  error: unknown;
  empty: boolean;
  forbiddenTitle: string;
  errorTitle: string;
  emptyTitle: string;
}): ReactNode {
  if (isLoading)
    return (
      <div className="space-y-4">
        <Skeleton className="h-[5.5rem] w-full rounded-2xl" />
        <Skeleton className="h-56 w-full rounded-2xl" />
      </div>
    );
  /* A REFUSAL is calm, not red: the role simply does not include this list,
     and an error card would read as something to report (owner, 2026-10-07). */
  if (error && isForbidden(error))
    return (
      <div className="rounded-2xl bg-card shadow-soft ring-1 ring-foreground/[0.06]">
        <EmptyState icon={<InboxIcon size={24} />} title={forbiddenTitle} />
      </div>
    );
  if (error)
    return (
      <div className="rounded-2xl bg-card shadow-soft ring-1 ring-foreground/[0.06]">
        <ErrorState title={errorTitle} />
      </div>
    );
  if (empty)
    return (
      <div className="rounded-2xl bg-card shadow-soft ring-1 ring-foreground/[0.06]">
        <EmptyState icon={<TicketIcon size={24} />} title={emptyTitle} />
      </div>
    );
  return null;
}

/** The card a row table sits in — same anatomy as "Chat by chat". */
function TableCard({
  title,
  help,
  shown,
  total,
  children,
}: {
  title: string;
  help: string;
  shown: number;
  total: number;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl bg-card shadow-soft ring-1 ring-foreground/[0.06]">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3">
        <h2 className="text-sm font-semibold tracking-[-0.01em] text-foreground">{title}</h2>
        <span className="text-2xs text-muted-foreground">{help}</span>
        <span className="ms-auto text-2xs tabular-nums text-muted-foreground">
          {shown === total ? total : `${shown} / ${total}`}
        </span>
      </header>
      <div className="max-h-[28rem] overflow-auto">{children}</div>
    </section>
  );
}

function NoMatchRow({ colSpan, search }: { colSpan: number; search: string }) {
  const { t } = useTranslation();
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-8 text-center text-sm text-muted-foreground">
        {t('performance.searchNoMatch', {
          defaultValue: 'Nothing matches “{{q}}”.',
          q: search.trim(),
        })}
      </td>
    </tr>
  );
}

/* ── Tickets ──────────────────────────────────────────────────────────────── */

export function TicketsTab({
  filters,
  search,
  agentNames,
}: {
  filters: PerformanceFilters;
  search: string;
  agentNames: Map<string, string>;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const stageLabel = useStageLabel();
  const query = useTicketPerformance(filters);
  const oneAgent = !!filters.agentId;

  const rows = useMemo(
    () =>
      (query.data ?? []).map((tk) => {
        const status = normaliseTicketStatus(tk.status);
        const start = tk.createdAt ? Date.parse(tk.createdAt) : NaN;
        const end = tk.resolvedAt ? Date.parse(tk.resolvedAt) : NaN;
        const solveSec =
          status === 'solved' && Number.isFinite(start) && Number.isFinite(end)
            ? Math.max(0, Math.round((end - start) / 1000))
            : null;
        return {
          ...tk,
          status,
          solveSec,
          // A name that is really the phone reads as the canonical 05 number.
          customer: displayContactName(tk.contactName, tk.contactPhone ?? tk.customerPhone) || null,
        };
      }),
    [query.data],
  );

  const summary = useMemo(() => {
    const solved = rows.filter((r) => r.status === 'solved');
    const times = solved.map((r) => r.solveSec).filter((s): s is number => s != null);
    return {
      total: rows.length,
      pending: rows.length - solved.length,
      solved: solved.length,
      avgSolve: mean(times),
      medianSolve: median(times),
    };
  }, [rows]);

  const visible = useMemo(
    () =>
      rows.filter((r) =>
        matchesSearch(search, {
          phones: [r.contactPhone, r.customerPhone],
          text: [r.id, r.orderId, r.subject, r.complaintType, r.coupon?.code, r.customer],
        }),
      ),
    [rows, search],
  );

  const state = tabState({
    isLoading: query.isLoading,
    error: query.error,
    empty: rows.length === 0,
    forbiddenTitle: t('performance.ticketsForbidden', {
      defaultValue: 'You don’t have access to tickets.',
    }),
    errorTitle: t('performance.ticketsError', { defaultValue: 'Could not load tickets.' }),
    emptyTitle: t('performance.ticketsEmpty', { defaultValue: 'No tickets match these filters.' }),
  });
  if (state) return state;

  const nameOf = (id: string | null) =>
    id
      ? (agentNames.get(id) ?? t('performance.unknownAgent', { defaultValue: 'Unknown agent' }))
      : t('performance.unassigned', { defaultValue: 'Unassigned' });

  return (
    <>
      <section
        aria-label={t('performance.ticketSummary', { defaultValue: 'Ticket summary' })}
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        <Tile
          label={t('performance.tabTickets', { defaultValue: 'Tickets' })}
          value={String(summary.total)}
        />
        <Tile
          label={t('performance.ticketPending', { defaultValue: 'Pending' })}
          value={String(summary.pending)}
          tone={summary.pending > 0 ? 'bad' : 'plain'}
        />
        <Tile
          label={t('performance.ticketSolved', { defaultValue: 'Solved' })}
          value={String(summary.solved)}
          tone={summary.solved > 0 ? 'good' : 'plain'}
        />
        <Tile
          label={t('performance.avgSolve', { defaultValue: 'Time to solve' })}
          value={formatDuration(summary.avgSolve) ?? '—'}
          hint={t('performance.ticketSolveHint', {
            defaultValue: 'average · median {{median}}',
            median: formatDuration(summary.medianSolve) ?? '—',
          })}
        />
      </section>

      <TableCard
        title={t('performance.ticketsTitle', { defaultValue: 'Ticket by ticket' })}
        help={t('performance.ticketsHelp', {
          defaultValue: 'Raised by or assigned to the agent. Open one to see it.',
        })}
        shown={visible.length}
        total={rows.length}
      >
        <table
          className="w-full text-sm"
          aria-label={t('performance.ticketsTitle', { defaultValue: 'Ticket by ticket' })}
        >
          <thead className="sticky top-0 z-10 bg-card">
            <tr className={HEAD_ROW}>
              <th className={TH}>{t('performance.ticketCol', { defaultValue: 'Ticket' })}</th>
              <th className={TH}>{t('performance.customer', { defaultValue: 'Customer' })}</th>
              {!oneAgent && (
                <th className={TH}>{t('performance.agent', { defaultValue: 'Agent' })}</th>
              )}
              <th className={TH}>{t('performance.created', { defaultValue: 'Created' })}</th>
              <th className={TH}>{t('performance.status', { defaultValue: 'Status' })}</th>
              <th className={`${TH} text-end`}>
                {t('performance.timeToSolve', { defaultValue: 'Time to solve' })}
              </th>
              <th className={TH}>{t('performance.couponCol', { defaultValue: 'Coupon' })}</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && <NoMatchRow colSpan={oneAgent ? 6 : 7} search={search} />}
            {visible.map((r) => (
              <tr
                key={r.id}
                onClick={() => navigate(`/tickets/${encodeURIComponent(r.id)}`)}
                className={BODY_ROW}
              >
                <td className="max-w-[18rem] px-4 py-2.5 text-foreground">
                  <span
                    className="block truncate font-medium"
                    title={r.complaintType ?? r.subject ?? ''}
                  >
                    {r.complaintType?.trim() ||
                      r.subject?.trim() ||
                      t('performance.ticketNoSubject', { defaultValue: 'Ticket' })}
                  </span>
                  <span className="font-mono text-2xs text-muted-foreground">
                    {r.orderId ? `#${r.orderId}` : `ID ${r.id}`}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">
                  <span className="block max-w-[12rem] truncate">
                    {r.customer ?? t('performance.unknownCustomer', { defaultValue: 'Customer' })}
                  </span>
                </td>
                {!oneAgent && (
                  <td className="px-4 py-2.5 text-muted-foreground">
                    <span className="block">{nameOf(r.assignedAgent)}</span>
                    {/* Raised by somebody other than its owner — the reason the
                        row is on this agent's list at all. */}
                    {r.createdBy && r.createdBy !== r.assignedAgent && (
                      <span className="block text-2xs">
                        {t('performance.raisedBy', {
                          defaultValue: 'Raised by {{name}}',
                          name: nameOf(r.createdBy),
                        })}
                      </span>
                    )}
                  </td>
                )}
                <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                  {r.createdAt ? formatDateTime(r.createdAt) : '—'}
                </td>
                <td className="px-4 py-2.5">
                  <Pill tone={r.status === 'solved' ? 'success' : 'highlight'} size="sm">
                    {r.status === 'solved'
                      ? t('performance.ticketSolved', { defaultValue: 'Solved' })
                      : t('performance.ticketPending', { defaultValue: 'Pending' })}
                  </Pill>
                </td>
                <td className="px-4 py-2.5 text-end tabular-nums text-foreground">
                  {r.solveSec == null ? (
                    <span className="text-muted-foreground">
                      {t('performance.ticketPending', { defaultValue: 'Pending' })}
                    </span>
                  ) : (
                    formatDuration(r.solveSec)
                  )}
                </td>
                <td className="px-4 py-2.5">
                  {r.coupon ? (
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-xs font-semibold text-foreground">
                        {r.coupon.code ?? t('performance.noCode', { defaultValue: 'no code' })}
                      </span>
                      <Pill tone={STAGE_TONE[couponStage(r.coupon)]} size="sm">
                        {stageLabel(couponStage(r.coupon))}
                      </Pill>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableCard>
    </>
  );
}

/* ── Coupons ──────────────────────────────────────────────────────────────── */

export function CouponsTab({ filters, search }: { filters: PerformanceFilters; search: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const stageLabel = useStageLabel();
  const query = useCouponPerformance(filters);
  const oneAgent = !!filters.agentId;

  const rows = useMemo(
    () =>
      (query.data ?? []).map((r) => ({
        ...r,
        stage: couponStage(r),
        phone: r.contact?.phone ?? r.customer_phone ?? null,
        customer:
          displayContactName(r.contact?.name, r.contact?.phone ?? r.customer_phone) ||
          normalizePhone(r.customer_phone ?? '') ||
          null,
        orderId: couponOrderId(r),
      })),
    [query.data],
  );

  const summary = useMemo(() => {
    const count = (pred: (s: CouponStage) => boolean) => rows.filter((r) => pred(r.stage)).length;
    const amounts = rows.filter((r) => r.stage !== 'rejected' && r.coupon_value != null);
    return {
      total: rows.length,
      waiting: count((s) => s === 'waitingApproval'),
      approved: count((s) => s !== 'waitingApproval' && s !== 'rejected'),
      rejected: count((s) => s === 'rejected'),
      value: amounts.reduce((sum, r) => sum + (r.coupon_value ?? 0), 0),
    };
  }, [rows]);

  const visible = useMemo(
    () =>
      rows.filter((r) =>
        matchesSearch(search, {
          phones: [r.contact?.phone, r.customer_phone],
          text: [
            r.coupon_code,
            r.ticketId,
            r.orderId,
            r.ticket?.subject,
            r.ticket?.complaint_type,
            r.customer,
          ],
        }),
      ),
    [rows, search],
  );

  const state = tabState({
    isLoading: query.isLoading,
    error: query.error,
    empty: rows.length === 0,
    forbiddenTitle: t('performance.couponsForbidden', {
      defaultValue: 'You don’t have access to coupons.',
    }),
    errorTitle: t('performance.couponsError', { defaultValue: 'Could not load coupon requests.' }),
    emptyTitle: t('performance.couponsEmpty', {
      defaultValue: 'No coupon requests match these filters.',
    }),
  });
  if (state) return state;

  return (
    <>
      <section
        aria-label={t('performance.couponSummary', { defaultValue: 'Coupon summary' })}
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5"
      >
        <Tile
          label={t('performance.couponsRequested', { defaultValue: 'Requested' })}
          value={String(summary.total)}
        />
        <Tile
          label={t('performance.stage.waitingApproval', { defaultValue: 'Waiting for approval' })}
          value={String(summary.waiting)}
        />
        <Tile
          label={t('performance.stage.approved', { defaultValue: 'Approved' })}
          value={String(summary.approved)}
          tone={summary.approved > 0 ? 'good' : 'plain'}
        />
        <Tile
          label={t('performance.stage.rejected', { defaultValue: 'Rejected' })}
          value={String(summary.rejected)}
          tone={summary.rejected > 0 ? 'bad' : 'plain'}
        />
        {/* SAR only, and rejected requests left out: a percentage has no face
            value to add, and a refused coupon cost nothing. */}
        <Tile
          label={t('performance.couponsValue', { defaultValue: 'Total value' })}
          value={money(summary.value)}
          hint={t('performance.couponsValueHint', { defaultValue: 'SAR, not rejected' })}
        />
      </section>

      <TableCard
        title={t('performance.couponsTitle', { defaultValue: 'Coupon by coupon' })}
        help={t('performance.couponsHelp', {
          defaultValue: 'Coupon requests the agent raised. Open one to see its ticket.',
        })}
        shown={visible.length}
        total={rows.length}
      >
        <table
          className="w-full text-sm"
          aria-label={t('performance.couponsTitle', { defaultValue: 'Coupon by coupon' })}
        >
          <thead className="sticky top-0 z-10 bg-card">
            <tr className={HEAD_ROW}>
              <th className={TH}>{t('performance.code', { defaultValue: 'Code' })}</th>
              <th className={`${TH} text-end`}>
                {t('performance.value', { defaultValue: 'Value' })}
              </th>
              <th className={TH}>{t('performance.customer', { defaultValue: 'Customer' })}</th>
              <th className={TH}>{t('performance.ticketCol', { defaultValue: 'Ticket' })}</th>
              {!oneAgent && (
                <th className={TH}>{t('performance.agent', { defaultValue: 'Agent' })}</th>
              )}
              <th className={TH}>{t('performance.requested', { defaultValue: 'Requested' })}</th>
              <th className={TH}>{t('performance.status', { defaultValue: 'Status' })}</th>
              <th className={TH}>
                {t('performance.assignOnYiji', { defaultValue: 'Assign on Yiji' })}
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && <NoMatchRow colSpan={oneAgent ? 7 : 8} search={search} />}
            {visible.map((r) => (
              <tr
                key={r.id}
                /* The ticket when there is one; a late-order coupon has none,
                   so it opens the compensation list it lives in. */
                onClick={() =>
                  navigate(
                    r.ticketId ? `/tickets/${encodeURIComponent(r.ticketId)}` : '/compensation',
                  )
                }
                className={BODY_ROW}
              >
                <td className="px-4 py-2.5 font-mono text-sm font-semibold text-foreground">
                  {r.coupon_code ?? t('performance.noCode', { defaultValue: 'no code' })}
                </td>
                <td className="px-4 py-2.5 text-end font-semibold tabular-nums text-foreground">
                  {couponValue(r)}
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">
                  <span className="block max-w-[12rem] truncate">
                    {r.customer ?? t('performance.unknownCustomer', { defaultValue: 'Customer' })}
                  </span>
                </td>
                <td className="max-w-[16rem] px-4 py-2.5 text-foreground">
                  {r.ticket || r.ticketId ? (
                    <span className="block truncate" title={r.ticket?.subject ?? ''}>
                      {r.ticket?.complaint_type?.trim() ||
                        r.ticket?.subject?.trim() ||
                        `${t('performance.ticketNoSubject', { defaultValue: 'Ticket' })} ${r.ticketId ?? ''}`.trim()}
                    </span>
                  ) : (
                    <span className="block text-muted-foreground">
                      {t('performance.noTicket', { defaultValue: 'No ticket' })}
                    </span>
                  )}
                  {r.orderId && (
                    <span className="font-mono text-2xs text-muted-foreground">#{r.orderId}</span>
                  )}
                </td>
                {!oneAgent && (
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {r.requested_by?.first_name?.trim() || r.requested_by?.email || '—'}
                  </td>
                )}
                <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                  {r.date_created ? formatDateTime(r.date_created) : '—'}
                </td>
                <td className="px-4 py-2.5">
                  <Pill tone={STAGE_TONE[r.stage]} size="sm">
                    {stageLabel(r.stage)}
                  </Pill>
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">
                  {/* Undefined = the field could not be read on this env. */}
                  {r.delivery_excluded === undefined
                    ? '—'
                    : r.delivery_excluded === true
                      ? t('performance.no', { defaultValue: 'No' })
                      : t('performance.yes', { defaultValue: 'Yes' })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableCard>
    </>
  );
}
