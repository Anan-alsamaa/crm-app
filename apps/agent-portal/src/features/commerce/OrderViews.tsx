import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { cn, Skeleton } from '@yiji/ui';
import type { YijiOrder } from '@yiji/shared-types';
/*
 * THE ORDER CARD ITSELF NOW LIVES IN A PACKAGE (ops, 2026-10-04).
 *
 * `OrderHeader` and `OrderDetails` were defined in this file; they moved to
 * `@yiji/order-views` so the ADMIN portal's late-orders report renders the exact
 * same cart and tracking rather than a thinner lookalike of its own. Re-exported
 * from here too: every existing importer names this module, and an agent-portal
 * reader looking for the order card should still find it where it has always
 * been.
 */
export { OrderDetails, OrderHeader } from '@yiji/order-views';
import { OrderDetails, OrderHeader } from '@yiji/order-views';
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
 *
 * What remains in this file is everything INBOX-SPECIFIC: stamping the
 * conversation with the order the panel resolved, the agent's pinned and
 * manually kept orders, and the query keys the inbox invalidates. None of that
 * exists in the admin portal, which is why only the card moved.
 */

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
            <OrderDetails order={detail.data} vendorId={vendorId} />
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
        // Wraps: with a minimum width on the input, a narrow panel has to put
        // the heading on its own line rather than crush the field.
        className="flex flex-wrap items-center gap-x-2 gap-y-1.5"
      >
        {heading}
        {/* Wide enough to SHOW a whole order id.
            It was `flex-1` next to a heading and a button, which on a narrow
            panel left room for about six digits of a seven-digit number — so
            an agent reading "1234535" down the line saw "123453" and could not
            tell whether they had mistyped it. Both are real orders, so the
            lookup answered confidently with the wrong one.
            `min-w-[7.5rem]` keeps room for the id itself, and the heading
            above it wraps instead of squeezing this. `font-mono` +
            `tabular-nums` so every digit is the same width and a transposed
            one is visible. */}
        {/*
          READS AS A FIELD, not as a line of text.
          It was a flat card-coloured box on a card-coloured panel, separated
          from its surroundings by a single hairline ring — so an agent could
          not tell it was somewhere to TYPE (owner, 2026-09-15). A recessed
          input surface, a heavier border and a magnifier make it obviously an
          entry box before anyone clicks it.
        */}
        <input
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
          inputMode="numeric"
          aria-label={t('commerce.lookupLabel', { defaultValue: 'Look up an order by ID' })}
          placeholder={t('commerce.lookupPlaceholder', { defaultValue: 'Type an order ID…' })}
          className="h-8 min-w-[8rem] flex-1 rounded-lg bg-input px-2.5 font-mono text-xs tabular-nums text-foreground ring-1 ring-inset ring-foreground/15 placeholder:font-sans placeholder:text-muted-foreground/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
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
  pinnedOrderId,
  onCreateTicket,
}: {
  vendorId: string;
  customerId?: string;
  conversationId?: string;
  /**
   * THE order this chat is about, when Yiji opened it from that order's
   * tracking screen.
   *
   * Shown FIRST and always, even when it is not among the customer's two most
   * recent: the customer is writing about this one, and a panel that lists
   * their newest orders instead makes the agent guess — wrong the moment they
   * have two open (owner, 2026-09-27).
   */
  pinnedOrderId?: string | null;
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

  /*
   * The pinned order, fetched by id.
   *
   * Only when there IS one, and only when it is not already in the recent
   * list — a chat opened from tracking usually names the customer's newest
   * order anyway, and paying for a second call to learn that would be waste.
   */
  const pinnedOrder = useQuery({
    queryKey: ['yiji-order', vendorId, pinnedOrderId],
    enabled: !!vendorId && !!pinnedOrderId,
    queryFn: () => commerce.getOrder(vendorId, pinnedOrderId as string),
    staleTime: 60_000,
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
    /*
     * NEVER OVERWRITE A PINNED ORDER.
     *
     * `last_order_id` is one column serving two writers: this effect stamps
     * whatever the panel resolved, and the gateway sets it at creation when
     * Yiji opened the chat from an order's tracking screen. This effect ran
     * anyway and stamped the customer's NEWEST order over the pinned one — so
     * the panel correctly showed "the order this chat is about" and then, a
     * moment later, showed the wrong order under that heading. Measured in
     * production: conversation 65cf4304 was created at 10:55 carrying the
     * tracked order and re-stamped at 11:46 with 1232382 (owner, 2026-09-27).
     *
     * The customer's own subject outranks anything this panel infers, so when
     * a pinned id is present the stamp stands down entirely.
     */
    if (pinnedOrderId) return;
    const resolved = detail ?? orders.data?.orders[0] ?? null;
    if (resolved) stampOrder(conversationId, resolved);
  }, [conversationId, detail, orders.data, stampOrder, pinnedOrderId]);

  // Orders the agent looked up and kept, alongside the automatic ones.
  const added = useSyncExternalStore(
    subscribeOrderPins,
    () => getAddedOrders(conversationId),
    () => [] as readonly YijiOrder[],
  );

  // No VENDOR means there is no commerce system to ask at all — not even by
  // order number, since every lookup is scoped to one. That is different from
  // an unlinked CUSTOMER, which is precisely when the manual lookup matters and
  // is why this checks the vendor and not `customerId`. The sidebar gates on
  // the same thing before rendering; this is the guard for every other caller.
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
  const recent = (live ?? (stamped ? [stamped] : [])).slice(0, 2);
  /*
   * The pinned order leads, and is never dropped by the slice.
   *
   * When it is already among the recent ones it simply moves to the front
   * rather than appearing twice; when it is older than both, it is shown
   * anyway — being older is not the same as being irrelevant when it is the
   * order the customer opened the chat from.
   */
  const pinned = pinnedOrderId
    ? (pinnedOrder.data ?? recent.find((o) => String(o.orderId) === pinnedOrderId) ?? null)
    : null;
  /* Rendered SEPARATELY above, so it is removed from the recent list here —
     otherwise the same order appears twice on the panel. */
  const fetched = pinned
    ? recent.filter((o) => String(o.orderId) !== String(pinned.orderId))
    : recent;

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

  const total = fetched.length + kept.length + (pinned ? 1 : 0);

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
          {/*
           * KEPT ORDERS FIRST — above the customer's automatic ones.
           *
           * `addOrder` already prepends within the kept list, but the list
           * itself rendered BELOW `fetched`, so an order the agent had just
           * looked up by number and deliberately kept still landed under every
           * automatic order (owner, 2026-09-16). Ordering the inner list was
           * never going to be enough while the outer order was wrong.
           *
           * An agent types an order number precisely because that is the order
           * being discussed. It is the most specific thing on the panel and the
           * only part they chose, so it goes where they are looking.
           */}
          {/*
            THE ORDER THE CUSTOMER CAME FROM — first, and said out loud.
            
            Above even the kept orders: an agent may type an order number for
            their own reasons, but this one is the customer's own subject, set
            when Yiji opened the chat from that order's tracking screen. It is
            also LABELLED, because an order card that is merely first looks
            like the newest one and the agent has no way to know the customer
            named it (owner, 2026-09-27).
          */}
          {pinned && (
            <li className="space-y-1">
              <p className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.12em] text-primary">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-primary" />
                {t('commerce.orderFromChat', {
                  defaultValue: 'The order this chat is about',
                })}
              </p>
              <ExpandableOrder
                vendorId={vendorId}
                summary={pinned}
                defaultOpen
                onCreateTicket={raiseTicket}
              />
            </li>
          )}
          {kept.map((o, i) => (
            <li key={o.orderId} className="space-y-1">
              {/* The newest kept order is the one just looked up — open it. */}
              <ExpandableOrder
                vendorId={vendorId}
                summary={o}
                defaultOpen={i === 0 && !pinned}
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
          {/* The customer's own recent orders, below anything the agent kept. */}
          {fetched.map((o, i) => (
            <li key={o.orderId}>
              {/* Expand the most recent only when nothing kept is above it —
                  two open cards push the rest of the panel off the screen. */}
              <ExpandableOrder
                vendorId={vendorId}
                summary={o}
                defaultOpen={i === 0 && kept.length === 0 && !pinned}
                onCreateTicket={raiseTicket}
              />
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
