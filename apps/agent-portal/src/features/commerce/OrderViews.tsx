import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { cn, Pill, Skeleton } from '@yiji/ui';
import type { YijiOrder } from '@yiji/shared-types';
import { commerce } from '../../lib/commerce-client.js';
import { inboxOrdersKey, useStampConversationOrder } from '../inbox/api.js';
import {
  addOrder,
  chooseOrder,
  getAddedOrders,
  removeOrder,
  subscribeOrderPins,
} from './pinned-order.js';

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
  heading,
  onAdd,
}: {
  vendorId: string;
  conversationId?: string;
  /**
   * Rendered on the SAME row as the search box, to its start side.
   *
   * The lookup used to sit at the foot of the panel, below however many orders
   * were listed — so on the one call where the customer is reading a number
   * down the line, the agent had to scroll past the orders that were not it.
   * Pairing it with the section heading puts it where the eye already is.
   */
  heading?: React.ReactNode;
  /** Called when the agent keeps a found order. Absent = nowhere to keep it. */
  onAdd?: (order: YijiOrder) => void;
}) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [orderId, setOrderId] = useState('');

  const q = useQuery({
    queryKey: ['yiji-order-manual', vendorId, orderId],
    enabled: !!vendorId && !!orderId,
    // Deliberately does NOT keep the order: a lookup is a question ("is this
    // the right one?"), and answering it by silently adding to the panel makes
    // every mistyped number permanent. The agent adds it explicitly.
    queryFn: () => commerce.getOrder(vendorId, orderId),
    retry: false,
    staleTime: 60_000,
  });

  const found = q.data as YijiOrder | undefined;

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
        {heading}
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
      ) : found ? (
        <div className="space-y-1.5 rounded-2xl bg-secondary/40 p-2">
          <ExpandableOrder vendorId={vendorId} summary={found} defaultOpen />
          <button
            type="button"
            onClick={() => {
              if (!conversationId || !onAdd) return;
              onAdd(found);
              // Clear the search so the panel shows the kept copy, not a
              // duplicate of it sitting in the result slot.
              setInput('');
              setOrderId('');
            }}
            disabled={!conversationId || !onAdd}
            className="h-7 w-full rounded-lg bg-primary/10 text-xs font-medium text-primary transition-colors hover:bg-primary/20 disabled:opacity-40"
          >
            {t('commerce.addToPanel', { defaultValue: '+ Keep this order' })}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function LatestOrder({
  vendorId,
  customerId,
  conversationId,
  stamped,
  onCreateTicket,
}: {
  vendorId: string;
  customerId?: string;
  conversationId?: string;
  /**
   * The order recorded on this conversation the last time it was worked.
   * Rendered immediately so the panel is never blank while the live copy is
   * being fetched — see `conversations.last_order_snapshot`.
   */
  stamped?: YijiOrder | null;
  /** Inbox only: makes each order id a "New complaint" trigger for that order. */
  onCreateTicket?: (order: YijiOrder) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const stampOrder = useStampConversationOrder();

  const orders = useQuery({
    queryKey: inboxOrdersKey(vendorId, customerId),
    enabled: !!vendorId && !!customerId,
    // ONE call: the list and the newest order's full detail together. They used
    // to be two sequential round trips with a component mount between them,
    // which is most of the reason this panel felt slow.
    // `enabled` already guards customerId, but the compiler cannot see that.
    queryFn: () => commerce.getInboxOrders(vendorId, customerId as string, { limit: 2 }),
    staleTime: 60_000,
    // Fail fast rather than retrying with backoff. The commerce proxy is an
    // external dependency that can be slow or absent, and three silent retries
    // leave a loading skeleton sitting there for a minute with no way to tell
    // "still loading" from "never coming". Saying "unavailable" and showing the
    // manual box is the useful answer — the agent has the order number anyway.
    retry: false,
  });

  // Hand the detail we already have to the expandable row, so opening the
  // newest order — which is auto-expanded — costs nothing at all instead of
  // firing the second request this endpoint exists to avoid.
  const detail = orders.data?.detail ?? null;
  useEffect(() => {
    if (detail) qc.setQueryData(['yiji-order', vendorId, detail.orderId], detail);
  }, [qc, vendorId, detail]);

  // Record what we resolved onto the conversation. Two jobs: the next open of
  // this chat paints from Directus before the commerce call has even started,
  // and "find the chat about order 946641" becomes answerable at all.
  useEffect(() => {
    if (!conversationId) return;
    const resolved = detail ?? orders.data?.orders[0] ?? null;
    if (resolved) stampOrder(conversationId, resolved);
  }, [conversationId, detail, orders.data, stampOrder]);

  // Orders the agent looked up and kept, alongside the automatic ones.
  const added = useSyncExternalStore(
    subscribeOrderPins,
    () => getAddedOrders(conversationId),
    () => [] as readonly YijiOrder[],
  );

  // With no linked customer there is nothing to look up automatically, but the
  // agent can still find an order by number — that is the whole point of the
  // manual path, so render it rather than bailing out.
  if (!vendorId) return null;

  // The last 2 orders (list is already newest-first from the client). An order
  // the agent also added by hand is shown once, as the automatic one, so it
  // keeps its "cannot be removed" status.
  //
  // While the live answer is in flight, this falls back to the copy stamped on
  // the conversation the last time anybody worked it. That is the difference
  // between a skeleton and an order: the panel is populated the instant the
  // chat opens, and the fresh copy replaces it when it lands.
  /**
   * An EMPTY live list counts as "nothing came back", not as an answer.
   *
   * `orders.data?.orders ?? null` treated `[]` as a real result — and `[]` is
   * exactly what a failed upstream used to produce — so a correct, fully
   * painted order card was replaced by "No orders found for this contact" on a
   * chat whose stamp held the order the agent was reading about. The app had
   * the right answer in memory and chose to print a denial.
   *
   * The upstream now fails loudly (see YijiUnavailableError), so `[]` here
   * should mean a genuinely order-less customer. Preferring the stamp anyway
   * costs nothing in that case — a customer with no orders has no stamp — and
   * keeps the panel honest if any other path ever produces an empty list.
   */
  const liveOrders = orders.data?.orders;
  const live = liveOrders && liveOrders.length > 0 ? liveOrders : null;
  const fetched = (live ?? (stamped ? [stamped] : [])).slice(0, 2);

  // A DISABLED query never resolves, so `isLoading` stays true forever and the
  // skeleton sits there pretending to load an order that will never arrive.
  // A contact with no linked commerce customer is the common case for a phone
  // enquiry, which is exactly when the agent needs the manual box instead.
  // With a stamped copy on screen there is nothing to skeleton over either.
  const loadingOrders = !!customerId && orders.isFetching && fetched.length === 0;

  const fetchedIds = new Set(fetched.map((o) => o.orderId));
  const kept = added.filter((o) => !fetchedIds.has(o.orderId));

  /**
   * Clicking an order id raises a complaint about THAT order, which may not be
   * the customer's newest. Record the choice first — that is what the ticket
   * snapshots — then let the conversation open the dialog. With no
   * conversation there is nothing to record against and no dialog to open, so
   * the id stays plain text.
   */
  const raiseTicket =
    onCreateTicket && conversationId
      ? (order: YijiOrder) => {
          chooseOrder(conversationId, order);
          onCreateTicket(order);
        }
      : undefined;

  const total = fetched.length + kept.length;

  return (
    <div className="space-y-2">
      {/* The heading and the manual lookup share a row, and the lookup's result
          lands directly under them — above the automatic orders, because an
          order the agent just typed in is the one they are looking at. */}
      <ManualOrderLookup
        vendorId={vendorId}
        conversationId={conversationId}
        onAdd={conversationId ? (o) => addOrder(conversationId, o) : undefined}
        heading={
          <h3 className="shrink-0 text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            {total > 1
              ? t('commerce.latestOrders', { defaultValue: 'Latest orders' })
              : t('commerce.latestOrder', { defaultValue: 'Latest order' })}
          </h3>
        }
      />

      {loadingOrders ? (
        <Skeleton className="h-20 w-full rounded-2xl" />
      ) : /* The stamped card wins over the error notice. This branch used to be
             evaluated FIRST, so an honest 504 wiped a perfectly good last-known
             order off the screen and replaced it with "unavailable" — throwing
             away the exact thing the stamp exists to provide. The error only
             speaks when there is nothing to show. */
      total > 0 ? (
        <ul className="space-y-2">
          {fetched.map((o, i) => (
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
          {kept.map((o) => (
            <li key={o.orderId} className="space-y-1">
              <ExpandableOrder
                vendorId={vendorId}
                summary={o}
                defaultOpen={fetched.length === 0}
                onCreateTicket={raiseTicket}
              />
              {/* Only orders the agent ADDED can be removed. The customer's
                  own recent orders are fact, not a working note, and a remove
                  control on them would imply the panel had been edited. */}
              <button
                type="button"
                onClick={() => conversationId && removeOrder(conversationId, o.orderId)}
                aria-label={t('commerce.removeOrder', {
                  orderId: o.orderId,
                  defaultValue: 'Remove order {{orderId}}',
                })}
                className="h-6 w-full rounded-lg text-2xs font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              >
                {t('commerce.removeOrderShort', { defaultValue: 'Remove' })}
              </button>
            </li>
          ))}
        </ul>
      ) : customerId && orders.isError ? (
        /* Nothing to show AND the lookup failed — so say we could not ask.
           "No orders found" here would be a claim about the customer made from
           no information, which is what an agent then repeats to them. */
        <p className="text-xs text-muted-foreground">
          {t('commerce.unavailable', {
            defaultValue: 'Commerce data unavailable. Enter an order ID to look it up.',
          })}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t('commerce.noOrdersHint', {
            defaultValue: 'No orders found for this contact. Enter an order ID to look it up.',
          })}
        </p>
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
