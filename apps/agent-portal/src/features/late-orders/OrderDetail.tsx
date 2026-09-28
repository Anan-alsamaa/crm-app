import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Pill, Skeleton } from '@yiji/ui';
import { commerce } from '../../lib/commerce-client.js';

/**
 * What was actually ordered, and where it got to.
 *
 * The owner asked that a late order carry its cart and its tracking (2026-09-21).
 * Both are one call each and BOTH are cached server-side, so opening a row costs
 * an agent nothing the second time and costs the queue nothing at all — the
 * panel only mounts when a row is expanded.
 */

/** `1x Chicken Pasta` with the choices under it. */
function CartLines({ orderId }: { orderId: string }) {
  const { t } = useTranslation();
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
            {/* The price, right-aligned and full-strength: it is a figure the
                agent reads off, not a caption. */}
            <span className="shrink-0 tabular-nums font-medium text-foreground">{l.price}</span>
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
          className="inline-flex items-center gap-1 text-xs font-medium text-brand underline decoration-brand/30 underline-offset-4 transition-colors hover:decoration-brand"
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
export function LateOrderDetail({
  orderId,
  vendorId,
}: {
  orderId: string;
  vendorId: string | null;
}) {
  const { t } = useTranslation();
  return (
    /*
     * TWO COLUMNS, NO BOXES.
     *
     * This was a grey panel with a rounded outline sitting inside whatever
     * contained it — which read as a box inside a box once it moved into a
     * dialog of its own (owner, 2026-09-28: "modern, not boxy... there are
     * boxed lines, modernize it"). The dialog is already a surface, so the
     * sections just sit on it and the GAP does the separating.
     *
     * `md:` for the split: at a phone width two columns of cart lines are two
     * columns of wrapped text, so they stack.
     */
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
        {/* The timeline endpoint is vendor-scoped; without one there is nothing
            honest to show, so it says so rather than rendering an empty rail. */}
        {vendorId ? (
          <Timeline vendorId={vendorId} orderId={orderId} />
        ) : (
          <p className="text-2xs text-muted-foreground">
            <Pill tone="neutral" size="sm">
              {t('commerce.trackingUnavailable', { defaultValue: 'Order tracking unavailable.' })}
            </Pill>
          </p>
        )}
      </section>
    </div>
  );
}
