import { useTranslation } from 'react-i18next';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Pill, Skeleton } from '@yiji/ui';
import { useOrderCommerce } from './commerce-context.js';
/* The inbox's own order view — see `LateOrderDetail`. */
import { OrderDetails, OrderHeader } from './OrderViews.js';

/**
 * What was actually ordered, and where it got to.
 *
 * The owner asked that a late order carry its cart and its tracking (2026-09-21).
 * Both are one call each and BOTH are cached server-side, so opening a row costs
 * an agent nothing the second time and costs the queue nothing at all — the
 * panel only mounts when a row is expanded.
 *
 * SHARED BY BOTH PORTALS since 2026-10-04 (ops: the admin late-orders report's
 * cart and tracking *"should be a resonance and mirror image and exactly of the
 * cart and tracking in the late orders page in the agent portal. the data
 * displayed, the style everything"*). It lived in the agent portal and the admin
 * report had a thinner lookalike — `OrderSnapshotPanel`, which rendered the
 * frozen `order_snapshot` and made no network calls. One component is the only
 * way "exactly the same" stays true past this week.
 */

/** `1x Chicken Pasta` with the choices under it. */
function CartLines({ orderId }: { orderId: string }) {
  const { t } = useTranslation();
  const commerce = useOrderCommerce();
  const q = useQuery({
    queryKey: ['order-cart', orderId],
    queryFn: () => commerce.getOrderCart(orderId),
    staleTime: 5 * 60_000,
    retry: false,
  });

  if (q.isLoading) return <Skeleton className="h-16 w-full" />;
  if (q.isError || !q.data)
    return (
      <p className="text-2xs text-muted-foreground">
        {t('lateOrders.cartUnavailable', { defaultValue: 'Cart unavailable.' })}
      </p>
    );

  const cart = q.data;
  const money: Array<[string, number | undefined]> = [
    [t('lateOrders.cart.food', { defaultValue: 'Food' }), cart.foodPrice],
    [t('lateOrders.cart.delivery', { defaultValue: 'Delivery' }), cart.deliveryFee],
    [t('lateOrders.cart.discount', { defaultValue: 'Discount' }), cart.discount],
    [t('lateOrders.cart.total', { defaultValue: 'Total' }), cart.total],
  ];

  return (
    <div className="space-y-2">
      {/*
        THREE THINGS, EACH IN ITS OWN LANE (owner, 2026-09-28: "clearly, the
        item name, quantity price. with proper positioning spacing, empty
        space, clear visibility").

        A grid, not a flex row: the quantities align under each other in a fixed
        first column and the prices in a fixed last one, so the eye runs straight
        down each. With flex, every line started at a different x depending on
        how wide its quantity was.

        `items-baseline` so a two-line item name keeps its quantity and price on
        the FIRST line rather than floating to the middle of the block.
      */}
      <ul className="space-y-3.5">
        {cart.lines.map((l, i) => (
          <li
            key={`${l.name}-${i}`}
            className="grid grid-cols-[2.25rem_1fr_auto] items-baseline gap-x-3 text-sm leading-relaxed"
          >
            {/* How many, in its own chip. "2×" scanned as part of the name when
                it was inline, and how many is the first thing asked. */}
            <span className="justify-self-start rounded-md bg-secondary px-1.5 py-0.5 text-center text-2xs font-semibold tabular-nums text-muted-foreground">
              {l.qty}&times;
            </span>
            <span className="min-w-0 font-medium text-foreground">{l.name}</span>
            {/* WHAT THE LINE COST — quantity × unit (owner, 2026-09-29).
                `l.price` is the price of ONE, so a line of 3 waters at 1 SAR
                showed "1" here while the inbox's order panel showed 3. The unit
                price is still named, in brackets, so the multiplication is
                visible rather than asserted. */}
            <span className="shrink-0 tabular-nums font-medium text-foreground">
              {l.qty > 1 && (
                <span className="me-1 text-2xs font-normal text-muted-foreground">
                  ({l.price} {t('commerce.each', { defaultValue: 'each' })})
                </span>
              )}
              {l.price * l.qty}
            </span>
            {/* The choices are the point: "Without Broccoli" is what answers an
                accuracy complaint, and the money view alone never showed it.
                Sits under the NAME, in the name's own column. */}
            {l.modifiers.length > 0 && (
              <span className="col-start-2 col-end-4 text-xs leading-relaxed text-muted-foreground">
                {l.modifiers.join(' · ')}
              </span>
            )}
          </li>
        ))}
        {cart.lines.length === 0 && (
          <li className="text-xs text-muted-foreground">
            {t('lateOrders.cart.noLines', { defaultValue: 'No items reported.' })}
          </li>
        )}
      </ul>
      {/* The totals sit on a tinted strip instead of under a rule — a hairline
          border across a dialog is exactly the boxed look being removed. */}
      <div className="mt-5 flex flex-wrap gap-x-5 gap-y-1.5 rounded-2xl bg-secondary/50 px-4 py-3 text-xs text-muted-foreground">
        {money
          .filter(([, v]) => typeof v === 'number')
          .map(([label, v]) => (
            <span key={label}>
              {label}: <span className="tabular-nums text-foreground">{v}</span>
            </span>
          ))}
        {cart.couponCode && (
          <span>
            {t('lateOrders.cart.coupon', { defaultValue: 'Coupon' })}:{' '}
            <span className="text-foreground">{cart.couponCode}</span>
          </span>
        )}
      </div>
      {cart.deliveryAddress && (
        <p className="text-xs leading-relaxed text-muted-foreground">{cart.deliveryAddress}</p>
      )}
      {cart.trackingUrl && (
        <a
          href={cart.trackingUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-xs font-semibold text-link underline decoration-link/40 underline-offset-4 transition-colors hover:decoration-link"
        >
          {t('lateOrders.cart.trackingLink', { defaultValue: "Open the courier's tracking" })}
        </a>
      )}
    </div>
  );
}

/**
 * The status timeline — where the order actually got stuck.
 *
 * This is the same real status history that could classify the delay
 * automatically; the owner chose to keep the dropdown manual, so it is shown
 * to the agent instead and THEY read it. `in_kitchen` at 13:36 with
 * `in_delivery` at 14:14 says "preparation" without anyone guessing.
 */
function Timeline({ vendorId, orderId }: { vendorId: string; orderId: string }) {
  const { t } = useTranslation();
  const commerce = useOrderCommerce();
  const q = useQuery({
    queryKey: ['yiji-order-timeline', vendorId, orderId],
    queryFn: () => commerce.getOrderTimeline(vendorId, orderId),
    staleTime: 60_000,
    retry: false,
  });

  if (q.isLoading) return <Skeleton className="h-16 w-full" />;
  if (q.isError || !q.data)
    return (
      <p className="text-xs text-muted-foreground">
        {t('commerce.trackingUnavailable', { defaultValue: 'Order tracking unavailable.' })}
      </p>
    );

  const events = q.data.events;
  return (
    <ol className="space-y-0">
      {events.map((ev, i) => {
        const last = i === events.length - 1;
        return (
          <li key={`${ev.status}-${i}`} className="relative flex gap-3 pb-3 last:pb-0">
            <span className="flex flex-col items-center">
              <span
                className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                  last ? 'bg-brand ring-4 ring-brand/15' : 'bg-foreground/20'
                }`}
                aria-hidden
              />
              {!last && (
                <span
                  className="w-px flex-1 bg-gradient-to-b from-foreground/15 to-foreground/5"
                  aria-hidden
                />
              )}
            </span>
            <div className="flex min-w-0 flex-1 items-baseline justify-between gap-2">
              <span
                className={`text-xs ${last ? 'font-semibold text-foreground' : 'text-foreground/75'}`}
              >
                {t(`commerce.orderStatuses.${ev.status}`, { defaultValue: ev.status })}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {ev.at ? new Date(ev.at).toLocaleTimeString() : '—'}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Cart and tracking, side by side under an expanded late order. */
/**
 * THE WHOLE ORDER, the way the inbox shows it (owner, 2026-09-28).
 *
 * This used to render its own narrow view — cart lines and a status timeline —
 * so an order opened from the late-orders queue showed strictly less than the
 * SAME order opened from a chat: no order status, no payment status, no
 * totals, no brand or restaurant id. It now fetches the order and hands it to
 * `OrderDetails`, the component the inbox already uses, so there is one idea of
 * what an order is rather than two that drift.
 *
 * FALLS BACK to the cart-and-timeline pair when the order cannot be read —
 * without a vendor there is no order endpoint to call, and half a view beats a
 * blank panel.
 */
export function LateOrderDetail({
  orderId,
  vendorId,
}: {
  orderId: string;
  vendorId: string | null;
}) {
  const { t } = useTranslation();
  const commerce = useOrderCommerce();
  const order = useQuery({
    queryKey: ['yiji-order', vendorId, orderId],
    enabled: !!vendorId,
    queryFn: () => commerce.getOrder(vendorId as string, orderId),
    staleTime: 5 * 60_000,
    retry: false,
  });
  /*
   * THE CART, for the COURIER'S TRACKING LINK (owner, 2026-09-29).
   *
   * `trackingUrl` lives on the cart, not the order — it comes from Yiji's
   * `deliveryOrder`, which `/commerce/order` does not carry. So when this panel
   * moved to the inbox's `OrderDetails` the link vanished with the old view: it
   * was only ever rendered by `CartLines`, which is now the fallback.
   *
   * Shares the key with the coupon form's own cart query, so opening both costs
   * one request rather than two.
   */
  const cart = useQuery({
    queryKey: ['order-cart', orderId],
    queryFn: () => commerce.getOrderCart(orderId),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const trackingUrl = cart.data?.trackingUrl;
  /* The add-ons per line, keyed by item name — the only field the order payload
     and the cart share, since cart lines carry no item id. */
  const modifiersByItem = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const line of cart.data?.lines ?? []) {
      if (line.modifiers.length) map.set(line.name, line.modifiers);
    }
    return map;
  }, [cart.data]);

  if (vendorId && order.isLoading) return <Skeleton className="h-40 w-full" />;

  if (vendorId && order.data) {
    return (
      <div className="space-y-4">
        <OrderHeader order={order.data} />
        <OrderDetails order={order.data} vendorId={vendorId} modifiersByItem={modifiersByItem} />
        {/* The courier's own page — the driver, the map, the live status. It is
            the one thing here that is not ours, so it opens in a new tab and
            keeps the agent's queue where it was. */}
        {trackingUrl && (
          <a
            href={trackingUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-xs font-semibold text-link underline decoration-link/40 underline-offset-4 transition-colors hover:decoration-link"
          >
            {t('lateOrders.cart.trackingLink', { defaultValue: "Open the courier's tracking" })}
          </a>
        )}
      </div>
    );
  }

  /* No vendor, or the order could not be read: the cart is keyed by order id
     alone and needs neither, so it still answers "what did they buy". */
  return (
    <div className="grid gap-x-10 gap-y-6 md:grid-cols-2">
      <section className="min-w-0">
        <h4 className="mb-3 text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {t('lateOrders.cartHeading', { defaultValue: 'Cart' })}
        </h4>
        <CartLines orderId={orderId} />
      </section>
      <section className="min-w-0">
        <h4 className="mb-3 text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {t('lateOrders.trackingHeading', { defaultValue: 'Tracking' })}
        </h4>
        {vendorId ? (
          <Timeline vendorId={vendorId} orderId={orderId} />
        ) : (
          <Pill tone="neutral" size="sm">
            {t('commerce.trackingUnavailable', { defaultValue: 'Order tracking unavailable.' })}
          </Pill>
        )}
      </section>
    </div>
  );
}
