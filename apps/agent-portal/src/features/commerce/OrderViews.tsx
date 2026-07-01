import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { cn, Pill, Skeleton } from '@yiji/ui';
import type { YijiOrder } from '@yiji/shared-types';
import { commerce } from '../../lib/commerce-client.js';

/**
 * Direct order views (no AI). The Yiji list endpoint returns order SUMMARIES
 * only (id, status, total, date, payment) — the line items live on the single
 * order endpoint — so a row shows the summary instantly and lazily fetches full
 * details (items, delivery, restaurant) when it is expanded. Used by:
 *   - the inbox sidebar (LatestOrder): the newest order + any same-day siblings,
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

/** Same calendar day by the YYYY-MM-DD prefix of the ISO timestamp (Yiji emits
 *  local time with no zone, so a string compare is exact — no TZ shift). */
function sameCalendarDay(aIso: string, bIso: string): boolean {
  return aIso.slice(0, 10) === bIso.slice(0, 10);
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
function OrderHeader({ order }: { order: YijiOrder }) {
  return (
    <div className="flex min-w-0 flex-1 items-baseline justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-foreground">#{order.orderId}</span>
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
      {order.restaurantName && (
        <div className="text-xs font-medium text-foreground">{order.restaurantName}</div>
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

      <div className="space-y-1 border-t border-border/60 pt-2">
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

      <dl className="space-y-1.5 text-2xs">
        {order.paymentStatus && (
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">
              {t('commerce.payment', { defaultValue: 'Payment' })}
            </dt>
            <dd className="flex items-center gap-1.5">
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
                {titleize(order.paymentStatus)}
              </Pill>
              {order.paymentMode && (
                <span className="text-muted-foreground">{titleize(order.paymentMode)}</span>
              )}
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
}: {
  vendorId: string;
  summary: YijiOrder;
  defaultOpen?: boolean;
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
    <div className="rounded-2xl bg-card/70 ring-1 ring-foreground/[0.04] shadow-sm shadow-foreground/[0.04]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-3 text-start transition-colors duration-fast ease-out hover:bg-secondary/40 rounded-2xl"
      >
        <Chevron open={open} />
        <OrderHeader order={summary} />
      </button>
      {open && (
        <div className="border-t border-border/60 px-4 py-3">
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
 * Inbox sidebar: the customer's latest order, auto-expanded. If more than one
 * order landed on the same calendar day as the newest, show up to 3 of them.
 */
export function LatestOrder({ vendorId, customerId }: { vendorId: string; customerId: string }) {
  const { t } = useTranslation();
  const orders = useQuery({
    queryKey: ['yiji-orders', vendorId, customerId, 5],
    enabled: !!vendorId && !!customerId,
    queryFn: () => commerce.getOrders(vendorId, customerId, { limit: 5 }),
    staleTime: 60_000,
  });

  // Not linked to a Yiji customer — render nothing rather than a misleading
  // "no orders" (the query is disabled, so there is nothing to show).
  if (!vendorId || !customerId) return null;

  const list = orders.data ?? [];
  const newest = list[0];
  const sameDay = newest
    ? list.filter((o) => sameCalendarDay(o.placedAt, newest.placedAt)).slice(0, 3)
    : [];

  return (
    <div className="space-y-2">
      <h3 className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {sameDay.length > 1
          ? t('commerce.latestOrders', { defaultValue: 'Latest orders' })
          : t('commerce.latestOrder', { defaultValue: 'Latest order' })}
      </h3>
      {orders.isLoading ? (
        <Skeleton className="h-20 w-full rounded-2xl" />
      ) : orders.isError ? (
        <p className="text-xs text-muted-foreground">
          {t('commerce.unavailable', { defaultValue: 'Commerce data unavailable.' })}
        </p>
      ) : newest ? (
        <ul className="space-y-2">
          {sameDay.map((o) => (
            <li key={o.orderId}>
              <ExpandableOrder vendorId={vendorId} summary={o} defaultOpen />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t('commerce.noOrders', { defaultValue: 'No orders yet.' })}
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
