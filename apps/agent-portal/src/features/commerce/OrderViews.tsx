import { useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { cn, Pill, Skeleton } from '@yiji/ui';
import type { YijiOrder } from '@yiji/shared-types';
import { commerce } from '../../lib/commerce-client.js';
import { getPinnedOrder, pinOrder, subscribePinnedOrders } from './pinned-order.js';

/**
 * Direct order views (no AI). The Yiji list endpoint returns order SUMMARIES
 * only (id, status, total, date, payment) — the line items live on the single
 * order endpoint — so a row shows the summary instantly and lazily fetches full
 * details (items, delivery, restaurant) when it is expanded. Used by:
 *   - the inbox sidebar (LatestOrder): the previous 2 orders, the most recent
 *     auto-expanded, so the agent sees it the moment a message comes in;
 *   - the contact panel (CustomerOrders): the latest N order ids, click to expand.
 */

const ORDER_TONE: Record<
  string,
  'success' | 'warning' | 'muted' | 'primary' | 'destructive' | 'neutral'
> = {
  // fulfilled / good terminal states
  delivered: 'success',
  closed: 'success',
  paid: 'success',
  pos_accepted: 'success',
  // in progress
  placed: 'primary',
  received: 'primary',
  in_kitchen: 'primary',
  ready_to_pickup: 'primary',
  finding_driver: 'warning',
  driver_accepted: 'warning',
  in_delivery: 'warning',
  arrived: 'warning',
  shipped: 'warning',
  // pending
  initial: 'muted',
  manual: 'muted',
  pending_payment: 'warning',
  pending_pos_accepted: 'warning',
  // failed / reversed
  canceled: 'destructive',
  cancelled: 'destructive',
  force_cancel: 'destructive',
  force_closed: 'destructive',
  not_valid: 'destructive',
  refunded: 'destructive',
};

function orderTone(status: string) {
  return ORDER_TONE[status] ?? 'neutral';
}

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** `in_delivery` → `In Delivery`, `apple_pay` → `Apple Pay`. */
function titleize(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn(
        'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-fast',
        open && 'rotate-90',
      )}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

/** Collapsed header — everything the summary already carries. */
function OrderHeader({ order, onCreateTicket }: { order: YijiOrder; onCreateTicket?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 flex-1 items-baseline justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {onCreateTicket ? (
            // The order id is the way into a complaint about THAT order. A real
            // button, so it is reachable by keyboard and named for the order it
            // opens; `relative z-10` lifts it above the row's toggle overlay so
            // the click raises a ticket instead of expanding the card.
            <button
              type="button"
              onClick={onCreateTicket}
              // The id is appended rather than interpolated: it is an opaque
              // token, not a translatable part of the sentence, and this keeps
              // it in the accessible name in every locale.
              aria-label={`${t('commerce.newComplaint', {
                defaultValue: 'New complaint for order',
              })} #${order.orderId}`}
              className="relative z-10 rounded font-mono text-xs text-primary underline decoration-dotted underline-offset-2 transition-colors duration-fast ease-out hover:decoration-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              #{order.orderId}
            </button>
          ) : (
            <span className="font-mono text-xs text-foreground">#{order.orderId}</span>
          )}
          <Pill tone={orderTone(order.status)} size="sm">
            {titleize(order.status)}
          </Pill>
        </div>
        <div className="mt-0.5 text-2xs text-muted-foreground tabular-nums">
          {fmtDateTime(order.placedAt)}
        </div>
      </div>
      <div className="shrink-0 text-sm font-semibold tabular-nums tracking-tight text-foreground">
        {money(order.total, order.currency)}
      </div>
    </div>
  );
}

function TotalsRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className={cn('text-muted-foreground', !strong && 'text-2xs')}>{label}</span>
      <span
        className={cn(
          'tabular-nums',
          strong ? 'font-semibold text-foreground' : 'text-2xs text-muted-foreground',
        )}
      >
        {value}
      </span>
    </div>
  );
}

/** Full order details — the expanded body. Given a COMPLETE order (with items). */
function OrderDetails({ order }: { order: YijiOrder }) {
  const { t } = useTranslation();
  const subtotal = order.items.reduce((sum, it) => sum + it.price * it.qty, 0);
  const showSubtotal = subtotal > 0 && order.total > subtotal + 0.001;

  return (
    <div className="space-y-2.5">
      {(order.brandName || order.restaurantName || order.restaurantId) && (
        <div className="flex items-baseline justify-between gap-2">
          <div className="min-w-0">
            {/* Brand (the eatery) as the prominent name; the branch/location
                below it. Both come from the Yiji order and are shown together. */}
            <span className="block truncate text-xs font-medium text-foreground">
              {order.brandName ??
                order.restaurantName ??
                t('commerce.restaurant', { defaultValue: 'Restaurant' })}
            </span>
            {order.brandName &&
              order.restaurantName &&
              order.restaurantName !== order.brandName && (
                <span className="block truncate text-2xs text-muted-foreground">
                  {order.restaurantName}
                </span>
              )}
          </div>
          {order.restaurantId && (
            <span className="shrink-0 font-mono text-2xs text-muted-foreground">
              {t('commerce.restaurantId', { defaultValue: 'Restaurant ID' })} #{order.restaurantId}
            </span>
          )}
        </div>
      )}

      {order.items.length > 0 ? (
        <ul className="space-y-1 text-xs">
          {order.items.map((it, i) => (
            <li key={it.sku || i} className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate">
                <span className="text-foreground/80 tabular-nums">{it.qty}×</span> {it.name}
                {it.qty > 1 && (
                  <span className="ms-1 text-2xs text-muted-foreground tabular-nums">
                    ({money(it.price, order.currency)}{' '}
                    {t('commerce.each', { defaultValue: 'each' })})
                  </span>
                )}
                {it.category && (
                  <span className="ms-1 text-2xs text-muted-foreground">· {it.category}</span>
                )}
              </span>
              <span className="shrink-0 tabular-nums text-foreground">
                {money(it.price * it.qty, order.currency)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-2xs text-muted-foreground">
          {t('commerce.noItems', { defaultValue: 'No line items on this order.' })}
        </p>
      )}

      <div className="space-y-1 rounded-xl bg-secondary/50 p-2.5">
        {showSubtotal && (
          <TotalsRow
            label={t('commerce.subtotal', { defaultValue: 'Items subtotal' })}
            value={money(subtotal, order.currency)}
          />
        )}
        <TotalsRow
          label={t('commerce.total', { defaultValue: 'Total' })}
          value={money(order.total, order.currency)}
          strong
        />
      </div>

      {/* Every field the Yiji order carries, one labelled row each, so the agent
          sees the complete order at a glance. Each row renders only when the API
          actually returned that field. */}
      <dl className="space-y-1.5 text-2xs">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">
            {t('commerce.orderStatus', { defaultValue: 'Order status' })}
          </dt>
          <dd>
            <Pill tone={orderTone(order.status)} size="sm">
              {t(`commerce.orderStatuses.${order.status}`, {
                defaultValue: titleize(order.status),
              })}
            </Pill>
          </dd>
        </div>
        {order.deliveryType && (
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">
              {t('commerce.deliveryType', { defaultValue: 'Delivery type' })}
            </dt>
            <dd className="text-foreground/90">
              {t(`commerce.deliveryTypes.${order.deliveryType}`, {
                defaultValue: titleize(order.deliveryType),
              })}
            </dd>
          </div>
        )}
        {order.paymentStatus && (
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">
              {t('commerce.paymentStatus', { defaultValue: 'Payment status' })}
            </dt>
            <dd>
              <Pill
                tone={
                  order.paymentStatus === 'paid'
                    ? 'success'
                    : order.paymentStatus === 'not_paid'
                      ? 'warning'
                      : 'neutral'
                }
                size="sm"
              >
                {t(`commerce.paymentStatuses.${order.paymentStatus}`, {
                  defaultValue: titleize(order.paymentStatus),
                })}
              </Pill>
            </dd>
          </div>
        )}
        {order.paymentMode && (
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">
              {t('commerce.paymentType', { defaultValue: 'Payment type' })}
            </dt>
            <dd className="text-foreground/90">
              {t(`commerce.paymentModes.${order.paymentMode}`, {
                defaultValue: titleize(order.paymentMode),
              })}
            </dd>
          </div>
        )}
        {order.customerPhone && (
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">
              {t('commerce.customerPhone', { defaultValue: 'Customer phone' })}
            </dt>
            <dd className="tabular-nums text-foreground/90" dir="ltr">
              {order.customerPhone}
            </dd>
          </div>
        )}
        {order.deliveryAddress && (
          <div className="flex items-start justify-between gap-3">
            <dt className="shrink-0 text-muted-foreground">
              {t('commerce.deliverTo', { defaultValue: 'Deliver to' })}
            </dt>
            <dd className="text-end text-foreground/90">{order.deliveryAddress}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

/**
 * One order card: summary header always visible, full details lazy-loaded (and
 * cached) the first time it's expanded. `defaultOpen` pre-expands it (inbox).
 */
function ExpandableOrder({
  vendorId,
  summary,
  defaultOpen = false,
  onCreateTicket,
}: {
  vendorId: string;
  summary: YijiOrder;
  defaultOpen?: boolean;
  onCreateTicket?: (order: YijiOrder) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  const detail = useQuery({
    queryKey: ['yiji-order', vendorId, summary.orderId],
    enabled: open,
    queryFn: () => commerce.getOrder(vendorId, summary.orderId),
    staleTime: 60_000,
  });

  return (
    <div className="rounded-2xl bg-card/70 ring-1 ring-foreground/[0.04] shadow-soft">
      {/* The whole row still expands the card, but the order id inside it is now
          its own button — so the toggle is a stretched overlay UNDERNEATH the
          header rather than a <button> wrapping it, which would nest one button
          inside another. */}
      <div className="relative flex items-center gap-2 rounded-2xl px-4 py-3 text-start transition-colors duration-fast ease-out hover:bg-secondary/40">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={`${t('commerce.orderDetails', {
            defaultValue: 'Order details',
          })} #${summary.orderId}`}
          className="absolute inset-0 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
        />
        <Chevron open={open} />
        <OrderHeader
          order={summary}
          // Hand over the fullest order we hold: once expanded, the detail query
          // has the line items the ticket snapshot wants.
          onCreateTicket={onCreateTicket ? () => onCreateTicket(detail.data ?? summary) : undefined}
        />
      </div>
      {open && (
        <div className="rounded-b-2xl bg-secondary/40 px-4 py-3">
          {detail.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : detail.isError || detail.data === null ? (
            <p className="text-2xs text-muted-foreground">
              {t('commerce.detailUnavailable', { defaultValue: 'Order details unavailable.' })}
            </p>
          ) : detail.data ? (
            <OrderDetails order={detail.data} />
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * Inbox sidebar: the customer's previous 2 orders. The Yiji list endpoint gives
 * ids + status + totals only, so each row shows that instantly and fetches full
 * details (restaurant, items, delivery) lazily on expand. The most recent order
 * is auto-expanded; the second stays collapsed until the agent opens it.
 */

/**
 * Manual order lookup.
 *
 * The automatic list resolves orders from the contact's linked customer id, which
 * fails whenever the CRM contact is not matched to a commerce customer — a common
 * case for a phone or walk-in enquiry. Rather than leaving the agent at a dead
 * end reading "No orders yet" while the customer is reading an order number down
 * the line, this lets them type it and fetch it directly.
 */
function ManualOrderLookup({
  vendorId,
  conversationId,
  onCreateTicket,
}: {
  vendorId: string;
  conversationId?: string;
  onCreateTicket?: (order: YijiOrder) => void;
}) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [orderId, setOrderId] = useState('');

  const q = useQuery({
    queryKey: ['yiji-order-manual', vendorId, orderId],
    enabled: !!vendorId && !!orderId,
    queryFn: async () => {
      const order = await commerce.getOrder(vendorId, orderId);
      // Pin it so it survives navigating away, and so the ticket dialog can
      // snapshot it without the agent retyping the number.
      if (order && conversationId) pinOrder(conversationId, order as YijiOrder);
      return order;
    },
    retry: false,
    staleTime: 60_000,
  });

  const pinned = useSyncExternalStore(
    subscribePinnedOrders,
    () => getPinnedOrder(conversationId),
    () => null,
  );
  const shown = (q.data as YijiOrder | undefined) ?? pinned;

  return (
    <div className="space-y-2">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const v = input.trim();
          if (v) setOrderId(v);
        }}
        className="flex items-center gap-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
          inputMode="numeric"
          aria-label={t('commerce.lookupLabel', { defaultValue: 'Look up an order by ID' })}
          placeholder={t('commerce.lookupPlaceholder', { defaultValue: 'Order ID…' })}
          className="h-8 min-w-0 flex-1 rounded-lg bg-card px-2.5 text-xs text-foreground ring-1 ring-border placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
        />
        <button
          type="submit"
          disabled={!input.trim()}
          className="h-8 shrink-0 rounded-lg bg-primary px-2.5 text-xs font-medium text-primary-foreground transition-opacity disabled:opacity-40"
        >
          {t('commerce.lookupGo', { defaultValue: 'Find' })}
        </button>
      </form>

      {q.isFetching ? (
        <Skeleton className="h-20 w-full rounded-2xl" />
      ) : q.isError ? (
        <p className="text-xs text-destructive">
          {t('commerce.lookupNotFound', {
            orderId,
            defaultValue: 'No order {{orderId}} for this vendor.',
          })}
        </p>
      ) : shown ? (
        // `shown` prefers the fresh result but falls back to the pinned one, so
        // the order stays on screen after navigating away and back.
        <ExpandableOrder
          vendorId={vendorId}
          summary={shown}
          defaultOpen
          onCreateTicket={onCreateTicket}
        />
      ) : null}
    </div>
  );
}

export function LatestOrder({
  vendorId,
  customerId,
  conversationId,
  onCreateTicket,
}: {
  vendorId: string;
  customerId?: string;
  conversationId?: string;
  /** Inbox only: makes each order id a "New complaint" trigger for that order. */
  onCreateTicket?: (order: YijiOrder) => void;
}) {
  const { t } = useTranslation();
  const orders = useQuery({
    queryKey: ['yiji-orders', vendorId, customerId, 2],
    enabled: !!vendorId && !!customerId,
    // `enabled` already guards this, but the compiler cannot see that.
    queryFn: () => commerce.getOrders(vendorId, customerId as string, { limit: 2 }),
    staleTime: 60_000,
  });

  // With no linked customer there is nothing to look up automatically, but the
  // agent can still find an order by number — that is the whole point of the
  // manual path, so render it rather than bailing out.
  if (!vendorId) return null;

  // The last 2 orders (list is already newest-first from the client).
  const recent = (orders.data ?? []).slice(0, 2);

  // Clicking an order id raises a complaint about THAT order, which may not be
  // the customer's newest one. Pin it first — pinning is already how an order
  // travels from this panel into ticket creation — then let the conversation
  // open the dialog. With no conversation there is nothing to pin against and
  // no dialog to open, so the id stays plain text.
  const raiseTicket =
    onCreateTicket && conversationId
      ? (order: YijiOrder) => {
          pinOrder(conversationId, order);
          onCreateTicket(order);
        }
      : undefined;

  return (
    <div className="space-y-2">
      <h3 className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {recent.length > 1
          ? t('commerce.latestOrders', { defaultValue: 'Latest orders' })
          : t('commerce.latestOrder', { defaultValue: 'Latest order' })}
      </h3>
      {orders.isLoading ? (
        <Skeleton className="h-20 w-full rounded-2xl" />
      ) : orders.isError ? (
        <p className="text-xs text-muted-foreground">
          {t('commerce.unavailable', { defaultValue: 'Commerce data unavailable.' })}
        </p>
      ) : recent.length > 0 ? (
        <ul className="space-y-2">
          {recent.map((o, i) => (
            <li key={o.orderId}>
              {/* Default-expand only the most recent (i === 0). */}
              <ExpandableOrder
                vendorId={vendorId}
                summary={o}
                defaultOpen={i === 0}
                onCreateTicket={raiseTicket}
              />
            </li>
          ))}
        </ul>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {t('commerce.noOrdersHint', {
              defaultValue: 'No orders found for this contact. Enter an order ID to look it up.',
            })}
          </p>
          <ManualOrderLookup
            vendorId={vendorId}
            conversationId={conversationId}
            onCreateTicket={raiseTicket}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Contact panel: the customer's latest N order ids (default 5). Each row is
 * collapsed; clicking it expands the items + full details below.
 */
export function CustomerOrders({
  vendorId,
  customerId,
  limit = 5,
}: {
  vendorId: string;
  customerId: string;
  limit?: number;
}) {
  const { t } = useTranslation();
  const orders = useQuery({
    queryKey: ['yiji-orders', vendorId, customerId, limit],
    enabled: !!vendorId && !!customerId,
    queryFn: () => commerce.getOrders(vendorId, customerId, { limit }),
    staleTime: 60_000,
  });

  if (!vendorId || !customerId) return null;

  return (
    <div className="space-y-2">
      <h3 className="px-1 text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {t('commerce.recentOrders', { defaultValue: 'Recent orders' })}
      </h3>
      {orders.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-14 w-full rounded-2xl" />
          <Skeleton className="h-14 w-full rounded-2xl" />
        </div>
      ) : orders.isError ? (
        <p className="px-1 text-xs text-muted-foreground">
          {t('commerce.unavailable', { defaultValue: 'Commerce data unavailable.' })}
        </p>
      ) : orders.data && orders.data.length > 0 ? (
        <ul className="space-y-2">
          {orders.data.map((o) => (
            <li key={o.orderId}>
              <ExpandableOrder vendorId={vendorId} summary={o} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-1 text-xs text-muted-foreground">
          {t('commerce.noOrders', { defaultValue: 'No orders yet.' })}
        </p>
      )}
    </div>
  );
}
