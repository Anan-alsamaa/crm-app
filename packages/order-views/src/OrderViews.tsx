import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { cn, formatDateTime, Pill, Skeleton } from '@yiji/ui';
import type { YijiOrder } from '@yiji/shared-types';
import { useOrderCommerce } from './commerce-context.js';

/**
 * ONE idea of what an order looks like, for every portal (ops, 2026-10-04).
 *
 * `OrderHeader` and `OrderDetails` used to live in the agent portal's
 * `features/commerce/OrderViews.tsx` next to `LatestOrder` and
 * `CustomerOrders`, which are inbox-only — they stamp the conversation and read
 * the inbox's query keys. These two do neither: they take an order and render
 * it. Moving just them here is what lets the ADMIN portal's late-orders report
 * show the same cart and tracking the agent's queue shows, rather than the
 * thinner lookalike it had (`OrderSnapshotPanel`, now deleted).
 *
 * Nothing in this file reaches for a portal: the commerce calls come from
 * `useOrderCommerce`, which each app fills with its own client.
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

export function orderTone(status: string) {
  return ORDER_TONE[status] ?? 'neutral';
}

export function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** `in_delivery` → `In Delivery`, `apple_pay` → `Apple Pay`. */
export function titleize(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/*
 * The product's one date format, dd/mm/yyyy HH:mm.
 *
 * This used to be `toLocaleString(undefined, { month: 'short', ... })`, which
 * renders in the BROWSER's locale: `Aug 21, 2026, 02:30 PM` on an en-US
 * machine, and a different shape again in Arabic. Every other date in the app
 * goes through `formatDateTime`, so an order's date was the odd one out.
 */
function fmtDateTime(iso: string): string {
  return formatDateTime(iso) || iso;
}

/** Collapsed header — everything the summary already carries. */
/** Exported alongside `OrderDetails` — the id, status and total that head it. */
export function OrderHeader({
  order,
  onCreateTicket,
}: {
  order: YijiOrder;
  onCreateTicket?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 flex-1 items-start justify-between gap-3">
      <div className="min-w-0">
        {/* WRAPS rather than truncates.
            The status used to run straight under the total — "Force canceled"
            over SAR 1.00, unreadable. Truncating it fixed the overlap but paid
            for it in meaning: "Force can…" and "Force cancel…" are not
            statuses anyone can act on, and this panel gets genuinely narrow
            when an agent shrinks the inbox.
            So `flex-wrap`: on a wide panel the id and status sit side by side
            as before; when there is not room, the status drops to its own line
            and keeps every character. `items-start` on the row so a wrapped
            two-line block still aligns with the price beside it. */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
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
                defaultValue: 'New ticket for order',
              })} #${order.orderId}`}
              className="relative z-10 rounded font-mono text-xs text-primary underline decoration-dotted underline-offset-2 transition-colors duration-fast ease-out hover:decoration-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              #{order.orderId}
            </button>
          ) : (
            <span className="font-mono text-xs text-foreground">#{order.orderId}</span>
          )}
          {/* `max-w-full` so a very long status cannot itself force the row
              wider than the panel; it wraps to its own line instead. No
              truncation — the whole point is that the status stays readable. */}
          <Pill tone={orderTone(order.status)} size="sm" className="max-w-full">
            {titleize(order.status)}
          </Pill>
        </div>
        <div className="mt-0.5 text-2xs text-muted-foreground tabular-nums">
          {fmtDateTime(order.placedAt)}
        </div>
      </div>
      {/* Never shrinks and never gets overlapped — the money is the one number
          on this row an agent must read exactly. */}
      <div className="shrink-0 whitespace-nowrap text-sm font-semibold tabular-nums tracking-tight text-foreground">
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

/* Segment glyphs. Inline and tiny — a 12px mark that says which view without
   costing a label's worth of width, and with no icon dependency. */
function RouteIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3 w-3 shrink-0"
      aria-hidden
    >
      <path d="M8 14s4.5-4.2 4.5-7.5A4.5 4.5 0 0 0 3.5 6.5C3.5 9.8 8 14 8 14Z" />
      <circle cx="8" cy="6.5" r="1.6" />
    </svg>
  );
}

function BagIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3 w-3 shrink-0"
      aria-hidden
    >
      <path d="M3.4 5.5h9.2l-.8 8.1a1 1 0 0 1-1 .9H5.2a1 1 0 0 1-1-.9L3.4 5.5Z" />
      <path d="M5.9 7V4.6a2.1 2.1 0 0 1 4.2 0V7" />
    </svg>
  );
}

/**
 * The Cart view: the order's money composition — points, coupon and discount —
 * straight off the single-order payload (no extra API call).
 */
function CartPanel({ order }: { order: YijiOrder }) {
  const { t } = useTranslation();
  const rows: Array<[string, number | undefined]> = [
    [t('commerce.totalPoints', { defaultValue: 'Total point amount' }), order.totalPointAmount],
    [t('commerce.totalCoupons', { defaultValue: 'Total coupon amount' }), order.totalCouponAmount],
    [t('commerce.totalDiscount', { defaultValue: 'Total discount' }), order.totalDiscount],
  ];
  return (
    <div className="space-y-1 rounded-xl bg-secondary/50 p-2.5">
      {rows.map(([label, v]) => (
        <TotalsRow
          key={label}
          label={label}
          value={
            v == null
              ? t('commerce.notReported', { defaultValue: 'Not reported' })
              : money(v, order.currency)
          }
        />
      ))}
    </div>
  );
}

/**
 * The Tracking view: the order's status timeline, step by step with times.
 *
 * Today the gateway DERIVES it from the order itself (placed → payment →
 * current status) because Yiji exposes no status-history endpoint yet; the
 * response says so and the caption owns up to it rather than presenting three
 * steps as the whole story.
 */
function TrackingPanel({ vendorId, orderId }: { vendorId: string; orderId: string }) {
  const { t } = useTranslation();
  const commerce = useOrderCommerce();
  const q = useQuery({
    queryKey: ['yiji-order-timeline', vendorId, orderId],
    queryFn: () => commerce.getOrderTimeline(vendorId, orderId),
    staleTime: 60_000,
    retry: false,
  });

  if (q.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <p className="text-2xs text-muted-foreground">
        {t('commerce.trackingUnavailable', { defaultValue: 'Order tracking unavailable.' })}
      </p>
    );
  }
  const timeline = q.data;
  return (
    <div className="space-y-2">
      <ol className="space-y-0">
        {timeline.events.map((ev, i) => {
          const last = i === timeline.events.length - 1;
          return (
            <li key={`${ev.status}-${i}`} className="relative flex gap-2.5 pb-3 last:pb-0">
              {/* The rail: a dot per step, a hairline connecting them. */}
              <span className="flex flex-col items-center">
                <span
                  className={cn(
                    'mt-1 h-2 w-2 shrink-0 rounded-full',
                    last ? 'bg-primary' : 'bg-foreground/25',
                  )}
                  aria-hidden
                />
                {!last && <span className="w-px flex-1 bg-foreground/10" aria-hidden />}
              </span>
              <div className="min-w-0 flex-1 pb-0.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span
                    className={cn(
                      'text-xs',
                      last ? 'font-semibold text-foreground' : 'text-foreground/80',
                    )}
                  >
                    {t(`commerce.orderStatuses.${ev.status}`, {
                      defaultValue: titleize(ev.status),
                    })}
                  </span>
                  <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
                    {ev.at
                      ? fmtDateTime(ev.at)
                      : t('commerce.timeUnknown', { defaultValue: 'Time not recorded' })}
                  </span>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      {timeline.derived && (
        <p className="text-2xs leading-relaxed text-muted-foreground">
          {t('commerce.trackingDerived', {
            defaultValue:
              'Built from the order record — the platform does not report the in-between steps yet.',
          })}
        </p>
      )}
    </div>
  );
}

/** Full order details — the expanded body. Given a COMPLETE order (with items). */
/**
 * EXPORTED so the late-orders queue shows the SAME order detail the inbox does
 * (owner, 2026-09-28: "all what we fetch from the inbox when customer send a
 * chat. includes the order status, payment type and everything").
 *
 * The late-orders drawer had grown its own narrower view — cart lines and a
 * status timeline, and nothing else — so the same order looked like two
 * different orders depending on which screen an agent opened it from. This is
 * one component with one idea of what an order is.
 */
export function OrderDetails({
  order,
  vendorId,
  modifiersByItem,
}: {
  order: YijiOrder;
  vendorId: string;
  /**
   * The add-ons chosen per line, keyed by item name (owner, 2026-09-29).
   *
   * A FALLBACK since EMA-58 (2026-10-08): the order payload DOES carry the
   * choices (`YijiOrderItem.modifiers`, read from `extraModifiers`), and those
   * win. This is used only for an order shaped without them - e.g. one cached
   * from before the change - when the caller has the cart to hand.
   *
   * Keyed by NAME rather than sku: the cart's lines carry no item id at all, so
   * the name is the only thing the two payloads share.
   */
  modifiersByItem?: Map<string, string[]>;
}) {
  const { t } = useTranslation();
  // Cart and Tracking, requested additions to every inbox order card. A view
  // toggle rather than more rows: the card is already the tallest thing in the
  // sidebar, and these answer different questions than the line items do.
  const [view, setView] = useState<'none' | 'cart' | 'tracking'>('none');
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
          {order.items.map((it, i) => {
            /* The order's own choices first (EMA-58); the cart's, matched by
               name, only for an order shaped before the order carried them. */
            const mods = it.modifiers?.length
              ? it.modifiers
              : (modifiersByItem?.get(it.name) ?? []);
            return (
              <li key={it.sku || i} className="flex items-baseline justify-between gap-2">
                {/* `truncate` only while there is nothing beneath: a modifier line
                  renders as a block inside this span, and a truncated parent
                  would clip it to one line and hide the rest. */}
                <span className={mods.length ? 'min-w-0' : 'min-w-0 truncate'}>
                  <span className="text-foreground/80 tabular-nums">{it.qty}×</span> {it.name}
                  {it.qty > 1 && (
                    <span className="ms-1 text-2xs text-muted-foreground tabular-nums">
                      ({money(it.price, order.currency)}{' '}
                      {t('commerce.each', { defaultValue: 'each' })})
                    </span>
                  )}
                  {/* The category only when there are no choices to show: it was
                    the cut-off "· Com..." that sat where the add-ons belong. */}
                  {it.category && !mods.length && (
                    <span className="ms-1 text-2xs text-muted-foreground">· {it.category}</span>
                  )}
                  {/* THE CHOICES, under the line they belong to. "Without
                    Broccoli" is what answers an accuracy complaint, and the
                    money view alone never showed it. */}
                  {mods.length > 0 && (
                    <span className="mt-0.5 block text-2xs leading-relaxed text-muted-foreground">
                      {mods.join(' · ')}
                    </span>
                  )}
                </span>
                <span className="shrink-0 tabular-nums text-foreground">
                  {money(it.price * it.qty, order.currency)}
                </span>
              </li>
            );
          })}
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

      {/* Cart & Tracking, beside the payment/status facts they extend. Toggles,
          so clicking the open one closes it again.

          One row split in half across the card — Tracking leads because "where
          is my order" is the question asked first. Both carry the primary hue
          rather than only the open one: they are peers, and a greyed-out half
          read as disabled. The OPEN one deepens to primary-strong, which says
          which panel is showing without demoting the other to furniture. */}
      <div className="border-t border-foreground/[0.06] pt-2.5">
        {/* ONE control, two segments — not two buttons side by side.

            A pale field holds a white thumb that SLIDES between the halves, so
            the state change is something you watch happen rather than something
            you compare before/after. The blue stays as the tint and the live
            label instead of a heavy fill, which keeps the card's lightest
            surface (white) on the thing you are actually reading.

            The corners are deliberately asymmetric — large on one diagonal,
            tight on the other — so the control reads as designed rather than as
            the default pill every other chip on this page already uses. The
            thumb repeats the same geometry one step smaller. */}
        <div
          role="group"
          aria-label={t('commerce.orderViews', { defaultValue: 'Order views' })}
          // No outline ring and no square corners: the tint alone is enough to
          // read as a field, and a hairline border around a 26px control only
          // adds a boxy edge. Nested radii follow the real rule — outer 16px
          // minus the 4px padding leaves 12px inside — so the thumb's curve
          // stays concentric with the track's instead of merely close to it.
          className="relative flex w-full rounded-2xl bg-primary/[0.07] p-1"
        >
          <span
            aria-hidden
            className={cn(
              'pointer-events-none absolute inset-y-1 start-1 w-[calc(50%-0.25rem)]',
              'rounded-xl bg-card shadow-soft',
              // ease-drawer decelerates hard at the end, so the thumb arrives
              // rather than coasting — the difference between a control that
              // feels mechanical and one that feels handled.
              'transition-[transform,opacity] duration-medium ease-drawer',
              // Logical, not left/right: in Arabic the second segment sits on
              // the other side, and a hard-coded translate would slide the
              // thumb off the control.
              view === 'cart' && 'translate-x-full rtl:-translate-x-full',
              // Neither view open — the thumb has nothing to mark, so it goes.
              view === 'none' && 'opacity-0',
            )}
          />
          {(['tracking', 'cart'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView((cur) => (cur === v ? 'none' : v))}
              className={cn(
                'group relative z-10 flex flex-1 items-center justify-center gap-1.5 rounded-xl px-3 py-1',
                'text-2xs font-semibold transition-[background-color,color,transform] duration-fast ease-out',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                'motion-safe:active:scale-[0.96]',
                view === v
                  ? 'text-primary'
                  : // Hovering the closed half fills it with the original solid
                    // blue — the colour that used to sit there permanently now
                    // answers the pointer instead, so the control previews what
                    // clicking selects.
                    'text-muted-foreground hover:bg-primary hover:text-primary-foreground',
              )}
            >
              <span className="transition-transform duration-fast ease-out motion-safe:group-hover:scale-110">
                {v === 'cart' ? <BagIcon /> : <RouteIcon />}
              </span>
              {v === 'cart'
                ? t('commerce.cart', { defaultValue: 'Cart' })
                : t('commerce.tracking', { defaultValue: 'Tracking' })}
            </button>
          ))}
        </div>
      </div>
      {view === 'cart' && <CartPanel order={order} />}
      {view === 'tracking' && <TrackingPanel vendorId={vendorId} orderId={order.orderId} />}
    </div>
  );
}
