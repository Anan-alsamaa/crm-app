import { Fragment, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createItem } from '@directus/sdk';
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Input,
  PageHeader,
  Pill,
  Select,
  Skeleton,
  Table,
  Td,
  Th,
  Textarea,
  Tr,
  toast,
} from '@yiji/ui';
import {
  LATE_ORDER_COMPLAINT_TYPE,
  type LateOrderKind,
  type LateOrderRow,
} from '@yiji/shared-types';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { directus } from '../../lib/directus.js';
import { useVendors } from '../tickets/api.js';
import { CouponRequestDialog } from '../coupons/CouponRequestDialog.js';
import { LateOrderDetail } from './OrderDetail.js';
import {
  useHandledLateOrders,
  useLateOrders,
  useRecordLateDecision,
  lateOrderTicket,
  FALLBACK_THRESHOLD,
} from './api.js';

/**
 * Late Delivery Handling - the agent's queue.
 *
 * Delivery orders still running past the threshold, with the two decisions the
 * owner specified: Ignore, and Assign coupon. Both demand a reason; both record
 * what was decided so the queue does not offer the same order again a minute
 * later.
 *
 * See docs/LATE-DELIVERY.md for the measured behaviour of the Yiji endpoint
 * behind this - several of its properties are counter-intuitive and load-bearing.
 */

/** How the elapsed time reads: "1h 12m" rather than "72". */
function elapsed(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * How overdue reads at a glance. An order twenty minutes past the line and one
 * three hours past need different urgency from across a room, and these rows
 * are scanned far more often than they are read.
 */
function tone(minutes: number, threshold: number): 'warning' | 'destructive' {
  return minutes >= threshold * 1.5 ? 'destructive' : 'warning';
}

interface DecisionDraft {
  row: LateOrderRow;
  action: 'ignored' | 'compensated';
}

export function LateOrdersPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  /*
   * THE FILTERS (owner, 2026-09-21): order id, then a date range, then brand
   * or branch.
   *
   * `range` is applied on APPLY, not on each keystroke: a range change refetches
   * up to three upstream pages, so typing "2026-09-01" one character at a time
   * would fire a query per character. Order id and brand/branch narrow what is
   * already loaded and so are instant.
   */
  const [orderQuery, setOrderQuery] = useState('');
  const [brandQuery, setBrandQuery] = useState('');
  const [draftFrom, setDraftFrom] = useState('');
  const [draftTo, setDraftTo] = useState('');
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const vendors = useVendors();
  // The queue follows the range: no range = today's live orders.
  const queue = useLateOrders(range ?? undefined);
  const handled = useHandledLateOrders();
  const record = useRecordLateDecision();

  /** The classification per row, defaulted to late delivery. */
  const [kinds, setKinds] = useState<Record<string, LateOrderKind>>({});
  const [draft, setDraft] = useState<DecisionDraft | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  /** The row whose cart + tracking is open. One at a time: the panel is tall,
      and two open rows push the queue itself off the screen. */
  const [expanded, setExpanded] = useState<string | null>(null);

  /**
   * The coupon form's subject, held while it is open.
   *
   * Carries `kind` and `ticketId` because the DECISION is written when the
   * request is created, not before — so everything it needs has to survive the
   * form being open.
   */
  const [coupon, setCoupon] = useState<{
    row: LateOrderRow;
    reason: string;
    kind: LateOrderKind;
    ticketId: string | null;
  } | null>(null);

  const threshold = queue.data?.thresholdMinutes ?? FALLBACK_THRESHOLD;
  // Local, not UTC: the date pickers are the agent's own calendar.
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);
  const soleVendorId = vendors.data?.length === 1 ? vendors.data[0]!.id : null;

  /*
   * What is still OPEN.
   *
   * Yiji has no idea we have handled anything, so a decided order keeps coming
   * back from `GetFilteredOrders` until it completes. Filtering here - rather
   * than trusting the upstream list - is what stops an agent facing the same
   * three rows every thirty seconds.
   */
  const rows = useMemo(() => {
    const done = handled.data ?? new Set<string>();
    const order = orderQuery.trim();
    const brand = brandQuery.trim().toLowerCase();
    return (queue.data?.rows ?? []).filter((r) => {
      /*
       * A handled order is hidden from the LIVE queue only.
       *
       * In a historical window the decision is part of what you are looking
       * at — hiding those rows would quietly under-report the month.
       */
      if (!range && done.has(r.orderId)) return false;
      if (order && !r.orderId.includes(order)) return false;
      if (brand && !`${r.brandName ?? ''} ${r.restaurantName ?? ''}`.toLowerCase().includes(brand))
        return false;
      return true;
    });
  }, [queue.data, handled.data, orderQuery, brandQuery, range]);

  const kindOf = (row: LateOrderRow): LateOrderKind => kinds[row.orderId] ?? 'late_delivery';

  const openDecision = (row: LateOrderRow, action: 'ignored' | 'compensated') => {
    setDraft({ row, action });
    setReason('');
  };

  /**
   * Commit the decision.
   *
   * ORDER MATTERS, and it differs by action.
   *
   * **Ignore** records immediately: the decision IS the whole act.
   *
   * **Assign coupon** records NOTHING yet — it opens the coupon form and the
   * decision is written only once a request actually exists. Recording first
   * looked safer (the order leaves the queue, so two agents cannot both work
   * it) and was wrong: an agent who opens the form and closes it leaves a
   * permanent row claiming the customer was compensated when nothing was ever
   * sent. Staging produced exactly that row within minutes of the feature
   * going up. A ticket-less order sitting in the queue is a visible, fixable
   * state; a false "compensated" is a quiet lie in the register operations
   * read. See [[silent-empty-failures]] for this shape.
   *
   * For a late PREPARATION the owner asked for a ticket as well, prefilled
   * from the order. It is raised FIRST and its id recorded with the decision,
   * so a failure leaves nothing half-done.
   */
  const commit = async () => {
    if (!draft) return;
    const text = reason.trim();
    if (!text) return;
    const kind = kindOf(draft.row);
    setBusy(true);
    try {
      let ticketId: string | null = null;
      if (kind === 'late_preparation') {
        const created = (await directus.request(
          createItem(
            'tickets' as never,
            lateOrderTicket({
              row: draft.row,
              kind,
              reason: text,
              contactId: null,
              vendorId: soleVendorId,
              agentId: user?.id ?? null,
            }) as never,
          ),
        )) as { id: string };
        ticketId = created?.id ?? null;
      }
      if (draft.action === 'compensated') {
        // Nothing is recorded yet — see the note above. The coupon form writes
        // the decision itself, once a request actually exists.
        setCoupon({ row: draft.row, reason: text, kind, ticketId });
      } else {
        await record.mutateAsync({
          row: draft.row,
          kind,
          action: 'ignored',
          reason: text,
          agentId: user?.id ?? null,
          ticketId,
        });
        toast.success(
          t('lateOrders.ignored', { defaultValue: 'Ignored, and the reason recorded.' }),
        );
      }
      setDraft(null);
      setReason('');
    } catch {
      toast.error(
        t('lateOrders.decisionFailed', { defaultValue: 'Could not record that decision.' }),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    /* Every page in this portal supplies its OWN padding — the shell gives
       none — and this one had none, so its text sat flush against the left
       edge of the window (owner, 2026-09-22). `p-4` matches the inbox and
       contacts; `min-h-0` keeps the table's own scroll working. */
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      <PageHeader
        title={t('lateOrders.title', { defaultValue: 'Late orders' })}
        subtitle={t('lateOrders.subtitle', {
          minutes: threshold,
          defaultValue: 'Delivery orders running longer than {{minutes}} minutes.',
        })}
      />

      {/*
        Order id, then dates, then brand/branch — the owner's order (2026-09-21),
        which is also the order an agent narrows in: they usually have a number.
      */}
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('lateOrders.filter.order', { defaultValue: 'Order number' })}
          </span>
          <Input
            value={orderQuery}
            onChange={(e) => setOrderQuery(e.target.value)}
            placeholder={t('lateOrders.filter.orderPlaceholder', { defaultValue: 'e.g. 1314302' })}
            inputMode="numeric"
            className="w-40"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('lateOrders.filter.from', { defaultValue: 'From' })}
          </span>
          <Input
            type="date"
            value={draftFrom}
            max={today}
            onChange={(e) => setDraftFrom(e.target.value)}
            className="w-40"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('lateOrders.filter.to', { defaultValue: 'To' })}
          </span>
          <Input
            type="date"
            value={draftTo}
            max={today}
            onChange={(e) => setDraftTo(e.target.value)}
            className="w-40"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('lateOrders.filter.brand', { defaultValue: 'Brand or branch' })}
          </span>
          <Input
            value={brandQuery}
            onChange={(e) => setBrandQuery(e.target.value)}
            placeholder={t('lateOrders.filter.brandPlaceholder', {
              defaultValue: 'e.g. Okashi, Narjis',
            })}
            className="w-52"
          />
        </label>
        {/* Applied on click, not per keystroke: a range walks up to three
            upstream pages, so typing a date would fire a query per character. */}
        <Button
          variant="secondary"
          disabled={!draftFrom || !draftTo || draftFrom > draftTo}
          onClick={() => setRange({ from: draftFrom, to: draftTo })}
        >
          {t('lateOrders.filter.apply', { defaultValue: 'Load range' })}
        </Button>
        {(range || orderQuery || brandQuery) && (
          <Button
            variant="ghost"
            onClick={() => {
              setRange(null);
              setOrderQuery('');
              setBrandQuery('');
              setDraftFrom('');
              setDraftTo('');
            }}
          >
            {t('lateOrders.filter.clear', { defaultValue: 'Back to live' })}
          </Button>
        )}
        {/* A historical window is NOT the live queue, and must never be mistaken
            for it — the rows are finished orders. */}
        {range && (
          <Pill tone="blue" size="sm">
            {t('lateOrders.filter.historyNote', {
              from: range.from,
              to: range.to,
              defaultValue: 'History {{from}} to {{to}} — finished orders included',
            })}
          </Pill>
        )}
      </div>

      {queue.isError ? (
        /*
         * A failed fetch must NOT look like an empty queue.
         *
         * "Nothing is late" and "we cannot see what is late" are opposite
         * facts, and the second is the one an agent has to act on.
         */
        <ErrorState
          title={t('lateOrders.errorTitle', { defaultValue: 'Could not load late orders' })}
          message={t('lateOrders.errorBody', {
            defaultValue:
              'The order system did not answer. That is not the same as there being none - try again in a moment.',
          })}
          onRetry={() => void queue.refetch()}
        />
      ) : queue.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title={t('lateOrders.noneTitle', { defaultValue: 'Nothing is running late' })}
          description={t('lateOrders.noneBody', {
            minutes: threshold,
            defaultValue: 'No delivery order has passed {{minutes}} minutes. This updates itself.',
          })}
        />
      ) : (
        <Card className="min-h-0 flex-1 overflow-auto p-0">
          <Table>
            <thead>
              <Tr>
                <Th>{t('lateOrders.col.order', { defaultValue: 'Order' })}</Th>
                <Th>{t('lateOrders.col.elapsed', { defaultValue: 'Running' })}</Th>
                <Th>{t('lateOrders.col.brand', { defaultValue: 'Brand / branch' })}</Th>
                <Th>{t('lateOrders.col.customer', { defaultValue: 'Customer' })}</Th>
                <Th>{t('lateOrders.col.status', { defaultValue: 'Status' })}</Th>
                <Th>{t('lateOrders.col.kind', { defaultValue: 'Cause' })}</Th>
                <Th>{t('lateOrders.col.actions', { defaultValue: 'Decision' })}</Th>
              </Tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <Fragment key={row.orderId}>
                  <Tr>
                    <Td className="whitespace-nowrap font-medium tabular-nums">
                      {/* The order NUMBER is the control: it is what an agent
                        looks at first, and it needs no extra column. */}
                      <button
                        type="button"
                        className="underline decoration-dotted underline-offset-4 hover:text-primary"
                        aria-expanded={expanded === row.orderId}
                        onClick={() =>
                          setExpanded((cur) => (cur === row.orderId ? null : row.orderId))
                        }
                      >
                        {row.orderId}
                      </button>
                    </Td>
                    <Td className="whitespace-nowrap">
                      <Pill tone={tone(row.minutesElapsed, threshold)} size="sm">
                        {elapsed(row.minutesElapsed)}
                      </Pill>
                    </Td>
                    <Td className="max-w-[16rem] truncate">
                      {[row.brandName, row.restaurantName].filter(Boolean).join(' - ') || '-'}
                    </Td>
                    <Td className="whitespace-nowrap">
                      {row.customerName || row.customerPhone || '-'}
                    </Td>
                    <Td className="whitespace-nowrap text-muted-foreground">
                      {t(`commerce.orderStatuses.${row.status}`, { defaultValue: row.status })}
                    </Td>
                    <Td>
                      <Select
                        value={kindOf(row)}
                        aria-label={t('lateOrders.col.kind', { defaultValue: 'Cause' })}
                        onChange={(e) =>
                          setKinds((cur) => ({
                            ...cur,
                            [row.orderId]: e.target.value as LateOrderKind,
                          }))
                        }
                      >
                        <option value="late_delivery">
                          {t('lateOrders.kind.late_delivery', { defaultValue: 'Late delivery' })}
                        </option>
                        <option value="late_preparation">
                          {t('lateOrders.kind.late_preparation', {
                            defaultValue: 'Late preparation',
                          })}
                        </option>
                      </Select>
                    </Td>
                    <Td>
                      {/*
                        A HANDLED historical order shows its decision instead of
                        the buttons: offering "Ignore" on something already
                        ignored invites a second, contradictory record.
                      */}
                      {range && handled.data?.has(row.orderId) ? (
                        <Pill tone="success" size="sm">
                          {t('lateOrders.alreadyHandled', { defaultValue: 'Handled' })}
                        </Pill>
                      ) : (
                        <div className="flex items-center gap-2">
                          <Button size="sm" onClick={() => openDecision(row, 'compensated')}>
                            {t('lateOrders.assignCoupon', { defaultValue: 'Assign coupon' })}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => openDecision(row, 'ignored')}
                          >
                            {t('lateOrders.ignore', { defaultValue: 'Ignore' })}
                          </Button>
                        </div>
                      )}
                    </Td>
                  </Tr>
                  {expanded === row.orderId && (
                    <Tr>
                      {/* Mounted only when open, so the queue never pays for
                        carts nobody asked to see. */}
                      <Td colSpan={7} className="p-2">
                        <LateOrderDetail orderId={row.orderId} vendorId={soleVendorId} />
                      </Td>
                    </Tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {/*
        The reason, demanded for BOTH actions.

        `ConfirmDialog` rather than a hand-rolled overlay: it brings the focus
        trap, Escape and backdrop-click that a bare `fixed inset-0` div does
        not, and every other confirm in these portals already looks like this.
        The textarea rides in `description`, which takes a ReactNode.
      */}
      {draft && (
        <ConfirmDialog
          open
          title={
            draft.action === 'ignored'
              ? t('lateOrders.ignoreTitle', { defaultValue: 'Ignore this order?' })
              : t('lateOrders.couponTitle', { defaultValue: 'Compensate this order' })
          }
          description={
            <div className="space-y-3">
              <p>
                {t('lateOrders.reasonPrompt', {
                  order: draft.row.orderId,
                  minutes: elapsed(draft.row.minutesElapsed),
                  defaultValue: 'Order {{order}} has been running {{minutes}}. Why?',
                })}
              </p>
              <Textarea
                autoFocus
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t('lateOrders.reasonPlaceholder', {
                  defaultValue: 'The reason - recorded against this order.',
                })}
              />
              {kindOf(draft.row) === 'late_preparation' && (
                <p className="rounded-lg bg-secondary/50 px-3 py-2 text-xs leading-relaxed">
                  {t('lateOrders.willRaiseTicket', {
                    type: LATE_ORDER_COMPLAINT_TYPE.late_preparation,
                    defaultValue: 'A "{{type}}" ticket will be raised for this order.',
                  })}
                </p>
              )}
            </div>
          }
          confirmLabel={
            draft.action === 'ignored'
              ? t('lateOrders.confirmIgnore', { defaultValue: 'Ignore' })
              : t('lateOrders.confirmCoupon', { defaultValue: 'Continue to coupon' })
          }
          cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
          loading={busy}
          onConfirm={() => {
            // The reason is required; the dialog's own button cannot express
            // that, so an empty one is simply refused rather than committed.
            if (reason.trim()) void commit();
          }}
          onCancel={() => setDraft(null)}
        />
      )}

      {/*
        The same coupon form the Add-ticket page uses, and the same approval
        flow behind it. No ticket: a late order has an order and no complaint
        behind it, and `order_id` is what delivery actually needs.
      */}
      {coupon && (
        <CouponRequestDialog
          open
          onClose={() => setCoupon(null)}
          ticketId={null}
          orderId={coupon.row.orderId}
          contactId={null}
          customerPhone={coupon.row.customerPhone ?? null}
          description={coupon.reason}
          brandId={null}
          restaurantId={coupon.row.restaurantId ?? null}
          brandName={coupon.row.brandName ?? null}
          branchName={coupon.row.restaurantName ?? null}
          requestedBy={user?.id ?? null}
          onCreated={() => {
            /*
             * The coupon EXISTS now, so the decision is true and can be
             * written. If this fails the order stays in the queue with a
             * coupon already requested — visible and fixable, unlike a
             * register that claims a compensation nobody sent.
             */
            void record
              .mutateAsync({
                row: coupon.row,
                kind: coupon.kind,
                action: 'compensated',
                reason: coupon.reason,
                agentId: user?.id ?? null,
                ticketId: coupon.ticketId,
              })
              .catch(() =>
                toast.error(
                  t('lateOrders.recordFailed', {
                    defaultValue:
                      'The coupon was requested, but this order could not be marked handled.',
                  }),
                ),
              );
            setCoupon(null);
          }}
        />
      )}
    </div>
  );
}
