import { Fragment, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createItem } from '@directus/sdk';
import {
  Button,
  Card,
  ConfirmDialog,
  DateField,
  EmptyState,
  ErrorState,
  Input,
  PageHeader,
  Pill,
  SelectMenu,
  Skeleton,
  Table,
  Td,
  Th,
  Textarea,
  Tr,
  formatDate,
  toast,
} from '@yiji/ui';
import {
  LATE_ORDER_COMPLAINT_TYPE,
  parseYijiTimestamp,
  type LateOrderKind,
  type LateOrderRow,
} from '@yiji/shared-types';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { directus } from '../../lib/directus.js';
import { useVendors } from '../tickets/api.js';
import { CouponRequestDialog } from '../coupons/CouponRequestDialog.js';
import { LateOrderDetail } from './OrderDetail.js';
import {
  resolveLateOrderContact,
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

/**
 * How far back the page opens. Thirty days is what operations review, and it
 * is comfortably inside the upstream page budget (two months measured 1,062
 * rows against a 500-per-page walk).
 */
const DEFAULT_WINDOW_DAYS = 30;

/** `YYYY-MM-DD`, n days ago, in the AGENT's own timezone rather than UTC. */
function isoDaysAgo(n: number): string {
  const d = new Date(Date.now() - n * 86_400_000);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
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
  /*
   * OPENS ON A REAL WINDOW, not on nothing.
   *
   * It used to open on the live queue alone, which is legitimately empty most
   * of the time — nothing is past the threshold right this second — so the
   * page looked broken and read as "no data loaded" (owner, 2026-09-22). It
   * was not: the same request with dates returns 1,062 orders over two months.
   *
   * So it starts on the last 30 days. The live queue is still one click away
   * via "Live only", and the rows say which is which — a finished order is
   * toned neutral and offers no actions.
   */
  const [draftFrom, setDraftFrom] = useState(() => isoDaysAgo(DEFAULT_WINDOW_DAYS));
  const [draftTo, setDraftTo] = useState(() => isoDaysAgo(0));
  const [range, setRange] = useState<{ from: string; to: string } | null>(() => ({
    from: isoDaysAgo(DEFAULT_WINDOW_DAYS),
    to: isoDaysAgo(0),
  }));
  /**
   * TODAY — live orders, narrowed to orders PLACED today (owner, 2026-09-24).
   *
   * Deliberately not a date range of today..today. Passing dates to the gateway
   * switches it into register mode: it walks pages and sets
   * `includeCompleted: true`, so "today" would fill with orders that already
   * finished. The ask was the opposite — what is late right now, today only —
   * so this stays on the LIVE queue (no range, live statuses only) and filters
   * the rows it returns by their own `placedAt`.
   *
   * It matters because the live queue is not implicitly today: an order placed
   * before midnight that is still running is genuinely live, and shows in the
   * unfiltered queue. This button is how an agent excludes exactly those.
   */
  const [todayOnly, setTodayOnly] = useState(false);
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
    /* Resolved before the form opens, so the request names the customer it is
       for rather than an anonymous row. */
    contactId: string | null;
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
      /*
       * Placed TODAY, in the agent's own calendar.
       *
       * `placedAt` is Riyadh-local with no zone marker, so it is parsed by
       * `parseYijiTimestamp` rather than `Date.parse` — reading it raw in a UTC
       * container puts every order three hours in the future, which is the bug
       * that once showed `minutesElapsed: -141`.
       */
      if (todayOnly) {
        const ms = parseYijiTimestamp(r.placedAt);
        if (!Number.isFinite(ms)) return false;
        const d = new Date(ms);
        const key = new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
          .toISOString()
          .slice(0, 10);
        if (key !== today) return false;
      }
      if (order && !r.orderId.includes(order)) return false;
      if (brand && !`${r.brandName ?? ''} ${r.restaurantName ?? ''}`.toLowerCase().includes(brand))
        return false;
      return true;
    });
  }, [queue.data, handled.data, orderQuery, brandQuery, range, todayOnly, today]);

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
      /* The CONTACT, per the owner's spec. Without it the branch gets a
         complaint with nobody attached, the ticket cannot be found by
         searching the number that raised it, and the coupon request names
         nobody. Resolved ONCE here and reused by both paths. */
      const contactId = await resolveLateOrderContact(draft.row, soleVendorId);
      if (kind === 'late_preparation') {
        const created = (await directus.request(
          createItem(
            'tickets' as never,
            lateOrderTicket({
              row: draft.row,
              kind,
              reason: text,
              contactId,
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
        setCoupon({
          row: draft.row,
          reason: text,
          kind,
          ticketId,
          contactId,
        });
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
          {/* `DateField`, not `<Input type="date">`: a native date input renders
              in the BROWSER's locale, so an en-US machine showed mm/dd/yyyy on a
              page every other date in this app writes as dd/mm/yyyy. DateField
              takes and emits the same ISO `yyyy-mm-dd` string, so the state, the
              `max` bound and the query are unchanged. */}
          <DateField
            value={draftFrom}
            max={today}
            onChange={(v) => setDraftFrom(v)}
            className="w-40"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('lateOrders.filter.to', { defaultValue: 'To' })}
          </span>
          <DateField value={draftTo} max={today} onChange={(v) => setDraftTo(v)} className="w-40" />
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
          onClick={() => {
            setTodayOnly(false);
            setRange({ from: draftFrom, to: draftTo });
          }}
        >
          {t('lateOrders.filter.apply', { defaultValue: 'Load range' })}
        </Button>
        {/*
          TODAY — the live queue, narrowed to orders placed today.

          It drops the range rather than setting one to today..today, because
          dates put the gateway into register mode and pull in finished orders.
          Live statuses only, so every row it shows is still running and still
          actionable.
        */}
        <Button
          variant={todayOnly ? 'brand' : 'ghost'}
          aria-pressed={todayOnly}
          onClick={() => {
            const next = !todayOnly;
            setTodayOnly(next);
            // Today is a LIVE view: a loaded range would contradict it.
            if (next) setRange(null);
          }}
        >
          {t('lateOrders.filter.today', { defaultValue: 'Today' })}
        </Button>
        {/* Always offered, because the page no longer STARTS live — this is how
            an agent gets to "what is late right now". */}
        <Button
          variant="ghost"
          onClick={() => {
            setRange(null);
            setOrderQuery('');
            setBrandQuery('');
            setTodayOnly(false);
          }}
        >
          {t('lateOrders.filter.clear', { defaultValue: 'Live only' })}
        </Button>
        {/* Says which live view is on, so "Today" and "Live only" are never
            ambiguous — an empty Today queue is good news, not a broken page. */}
        {todayOnly && !range && (
          <Pill tone="success" size="sm">
            {t('lateOrders.filter.todayNote', {
              defaultValue: 'Today only — live orders still running',
            })}
          </Pill>
        )}
        {/* A historical window is NOT the live queue, and must never be mistaken
            for it — the rows are finished orders. */}
        {range && (
          <Pill tone="blue" size="sm">
            {t('lateOrders.filter.historyNote', {
              // dd/mm/yyyy, like every other date on screen — the pill used to
              // print the raw ISO the query carries.
              from: formatDate(range.from),
              to: formatDate(range.to),
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
                <Th>{t('lateOrders.col.kind', { defaultValue: 'Source of delay' })}</Th>
                <Th>{t('lateOrders.col.actions', { defaultValue: 'Decision' })}</Th>
              </Tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <Fragment key={row.orderId}>
                  <Tr>
                    <Td className="whitespace-nowrap font-medium tabular-nums">{row.orderId}</Td>
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
                      {/*
                        `SelectMenu`, not a native `<select>`: the OS styles the
                        native menu itself, so it arrived as a boxed grey
                        control that matched nothing else on the page (owner,
                        2026-09-22). This is the same listbox the rest of the
                        portal uses — keyboard, type-ahead and ARIA included —
                        and it renders in a portal so it is never clipped by the
                        table's own scroll.

                        The dots carry the meaning at a glance: amber for a
                        kitchen that ran long, blue for a delivery that did.
                      */}
                      <SelectMenu
                        value={kindOf(row)}
                        size="sm"
                        aria-label={t('lateOrders.col.kind', {
                          defaultValue: 'Source of delay',
                        })}
                        onChange={(v) =>
                          setKinds((cur) => ({ ...cur, [row.orderId]: v as LateOrderKind }))
                        }
                        options={[
                          {
                            value: 'late_delivery',
                            label: t('lateOrders.kind.late_delivery', {
                              defaultValue: 'Late delivery',
                            }),
                            dot: 'oklch(var(--sky))',
                          },
                          {
                            value: 'late_preparation',
                            label: t('lateOrders.kind.late_preparation', {
                              defaultValue: 'Late preparation',
                            }),
                            dot: 'oklch(var(--warning))',
                          },
                        ]}
                      />
                    </Td>
                    <Td>
                      {/*
                        A HANDLED historical order shows its decision instead of
                        the buttons: offering "Ignore" on something already
                        ignored invites a second, contradictory record.
                      */}
                      {range && handled.data?.has(row.orderId) ? (
                        /* The DECISION replaces the two actions, but not the
                           detail: looking at what was ordered is exactly what
                           somebody reviewing a handled order came to do. */
                        <div className="flex items-center gap-2">
                          <Pill tone="success" size="sm">
                            {t('lateOrders.alreadyHandled', { defaultValue: 'Handled' })}
                          </Pill>
                          <Button
                            size="sm"
                            variant="secondary"
                            aria-expanded={expanded === row.orderId}
                            onClick={() =>
                              setExpanded((cur) => (cur === row.orderId ? null : row.orderId))
                            }
                          >
                            {expanded === row.orderId
                              ? t('lateOrders.hideDetail', { defaultValue: 'Hide details' })
                              : t('lateOrders.showDetail', { defaultValue: 'Cart & tracking' })}
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          {/*
                            A NAMED control, not the order number.

                            Cart and tracking used to hang off clicking the id —
                            an affordance nothing announced, which an agent had
                            to be told about (owner, 2026-09-22). A button that
                            says what it opens needs no telling, and the row
                            says whether it is open.
                          */}
                          <Button
                            size="sm"
                            variant="secondary"
                            aria-expanded={expanded === row.orderId}
                            onClick={() =>
                              setExpanded((cur) => (cur === row.orderId ? null : row.orderId))
                            }
                          >
                            {expanded === row.orderId
                              ? t('lateOrders.hideDetail', { defaultValue: 'Hide details' })
                              : t('lateOrders.showDetail', {
                                  defaultValue: 'Cart & tracking',
                                })}
                          </Button>
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
          contactId={coupon.contactId}
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
