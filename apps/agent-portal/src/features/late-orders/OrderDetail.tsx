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
      {/* The QUANTITY leads, in its own soft chip: "2×" scanned as part of the
          name when it was inline, and how many is the first thing asked. */}
      <ul className="space-y-2.5">
        {cart.lines.map((l, i) => (
          <li key={`${l.name}-${i}`} className="text-sm leading-snug">
            <div className="flex items-baseline justify-between gap-3">
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 rounded-md bg-secondary px-1.5 py-0.5 text-2xs font-semibold tabular-nums text-muted-foreground">
                  {l.qty}&times;
                </span>
                <span className="font-medium text-foreground">{l.name}</span>
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{l.price}</span>
            </div>
            {/* The choices are the point: "Without Broccoli" is what answers an
                accuracy complaint, and the money view alone never showed it. */}
            {l.modifiers.length > 0 && (
              <div className="ps-8 pt-0.5 text-xs text-muted-foreground">
                {l.modifiers.join(' · ')}
              </div>
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
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 rounded-xl bg-secondary/50 px-3 py-2 text-xs text-muted-foreground">
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
