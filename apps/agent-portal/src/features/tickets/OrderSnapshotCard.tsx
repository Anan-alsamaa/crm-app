import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { cn, Pill, Skeleton } from '@yiji/ui';
import type { YijiOrder } from '@yiji/shared-types';
import { commerce } from '../../lib/commerce-client.js';
import { useOrderStore } from './useStoreMatch.js';

/**
 * The order a ticket was raised about, captured when the ticket was created.
 *
 * Stored as structured JSON on `tickets.order_snapshot` (a point-in-time copy —
 * the upstream order may change or vanish), which is what lets us render it as
 * a real order card instead of pasting prose into the ticket description.
 */
export interface TicketOrderSnapshotItem {
  name: string;
  qty: number;
  price: number;
  category?: string;
}

export interface TicketOrderSnapshot {
  orderId: string;
  status: string;
  total: number;
  currency: string;
  placedAt: string;
  items: TicketOrderSnapshotItem[];
  brandName?: string;
  restaurantName?: string;
  /**
   * Yiji's own restaurant id. Persisted because it is the ONLY stable key
   * between an order and the operations store list — the names do not line up
   * ("Riyadh - Masief Plaza" vs "LCP-041 Masief Plaza"). It is available only
   * on the single-order endpoint, so if it is not captured here it is lost for
   * that ticket forever, leaving reporting on fuzzy name matching.
   */
  restaurantId?: string;
  deliveryType?: string;
  deliveryAddress?: string;
  paymentStatus?: string;
  paymentMode?: string;
  /** When this copy was taken (ISO). */
  capturedAt?: string;
}

/** Flatten a live Yiji order into the stored snapshot shape. */
export function orderToSnapshot(order: YijiOrder): TicketOrderSnapshot {
  return {
    orderId: order.orderId,
    status: order.status,
    total: order.total,
    currency: order.currency,
    placedAt: order.placedAt,
    items: order.items.map((it) => ({
      name: it.name,
      qty: it.qty,
      price: it.price,
      ...(it.category ? { category: it.category } : {}),
    })),
    ...(order.brandName ? { brandName: order.brandName } : {}),
    ...(order.restaurantName ? { restaurantName: order.restaurantName } : {}),
    ...(order.restaurantId ? { restaurantId: order.restaurantId } : {}),
    ...(order.deliveryType ? { deliveryType: order.deliveryType } : {}),
    ...(order.deliveryAddress ? { deliveryAddress: order.deliveryAddress } : {}),
    ...(order.paymentStatus ? { paymentStatus: order.paymentStatus } : {}),
    ...(order.paymentMode ? { paymentMode: order.paymentMode } : {}),
  };
}

/**
 * Tickets created BEFORE `order_snapshot` existed had the order flattened into
 * the description as prose, e.g.
 *
 *   Order from this chat:
 *   #946641 · Closed
 *   Total: SAR 26.00
 *
 * Rather than leave those rendering as a text blob forever, pull the order id
 * out (the `#<id> ·` line is locale-independent — the surrounding labels are
 * not) and hand back the description with that block removed, so the caller can
 * re-fetch the real order and render the same card.
 */
const LEGACY_ORDER_LINE = /^#(\S+)\s*·/;

export function parseLegacyOrderBlock(
  description: string | null | undefined,
): { orderId: string; description: string } | null {
  if (!description) return null;
  const lines = description.split('\n');
  const idx = lines.findIndex((l) => LEGACY_ORDER_LINE.test(l.trim()));
  if (idx === -1) return null;
  const orderId = lines[idx]!.trim().match(LEGACY_ORDER_LINE)?.[1];
  if (!orderId) return null;
  // The label line directly above ("Order from this chat:") is part of the block.
  const start = idx > 0 && lines[idx - 1]!.trim().endsWith(':') ? idx - 1 : idx;
  return { orderId, description: lines.slice(0, start).join('\n').trim() };
}

/**
 * Renders a legacy ticket's order by re-fetching it from commerce with the id
 * recovered from the description. Degrades silently: if the order is gone
 * upstream (or commerce is down) nothing is shown, which is strictly better
 * than the old wall of text.
 */
export function LegacyOrderSnapshotCard({
  vendorId,
  orderId,
  className,
}: {
  vendorId: string;
  orderId: string;
  className?: string;
}) {
  const q = useQuery({
    queryKey: ['ticket-legacy-order', vendorId, orderId],
    staleTime: 60_000,
    queryFn: () => commerce.getOrder(vendorId, orderId),
  });
  if (q.isLoading) return <Skeleton className={cn('h-40 w-full rounded-2xl', className)} />;
  if (q.isError || !q.data) return null;
  return <OrderSnapshotCard order={orderToSnapshot(q.data)} className={className} />;
}

/** Tone per Yiji order status, mirroring the commerce order views. */
const STATUS_TONE: Record<string, 'success' | 'warning' | 'muted' | 'primary' | 'destructive'> = {
  delivered: 'success',
  closed: 'success',
  paid: 'success',
  pos_accepted: 'success',
  placed: 'primary',
  received: 'primary',
  in_kitchen: 'primary',
  ready_to_pickup: 'primary',
  finding_driver: 'warning',
  driver_accepted: 'warning',
  in_delivery: 'warning',
  arrived: 'warning',
  pending_payment: 'warning',
  pending_pos_accepted: 'warning',
  initial: 'muted',
  manual: 'muted',
  canceled: 'destructive',
  cancelled: 'destructive',
  force_cancel: 'destructive',
  force_closed: 'destructive',
  not_valid: 'destructive',
  refunded: 'destructive',
};

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** `in_delivery` → `In Delivery`. */
function titleize(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtDateTime(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
}

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <dt className="shrink-0 text-2xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 text-end text-xs text-foreground">{value}</dd>
    </div>
  );
}

/**
 * Renders a ticket's order snapshot as a proper order card: a tinted header
 * with the order id, status and total; the brand/branch; the line items with
 * per-line totals; then the fulfilment/payment/delivery detail.
 */
export function OrderSnapshotCard({
  order,
  className,
}: {
  order: TicketOrderSnapshot;
  className?: string;
}) {
  const { t } = useTranslation();
  // Resolve against the operations store list so the agent sees the branch as
  // operations name it, plus the city and who owns it. Falls back to Yiji's
  // wording when the branch is not in the list.
  const store = useOrderStore(order);
  const restaurant =
    store.restaurantName || [order.brandName, order.restaurantName].filter(Boolean).join(' — ');
  const subline = [store.brandName, store.city].filter(Boolean).join(' · ');
  const owners = [
    store.areaManager &&
      `${t('tickets.areaManager', { defaultValue: 'Area' })}: ${store.areaManager}`,
    store.chainManager &&
      `${t('tickets.chainManager', { defaultValue: 'Chain' })}: ${store.chainManager}`,
  ]
    .filter(Boolean)
    .join(' · ');
  const itemsSubtotal = order.items.reduce((sum, it) => sum + it.price * it.qty, 0);
  const showSubtotal = itemsSubtotal > 0 && Math.abs(order.total - itemsSubtotal) > 0.005;

  return (
    <div
      className={cn(
        'overflow-hidden rounded-2xl bg-card ring-1 ring-foreground/[0.06] shadow-soft',
        className,
      )}
    >
      {/* Header — brand-tinted band carrying identity + the headline number. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 bg-primary/[0.06] px-4 py-3">
        <span className="font-mono text-xs font-medium text-foreground">#{order.orderId}</span>
        <Pill tone={STATUS_TONE[order.status] ?? 'neutral'} size="sm" dot>
          {t(`commerce.orderStatuses.${order.status}`, { defaultValue: titleize(order.status) })}
        </Pill>
        {order.deliveryType && (
          <Pill tone="neutral" size="sm">
            {t(`commerce.deliveryTypes.${order.deliveryType}`, {
              defaultValue: titleize(order.deliveryType),
            })}
          </Pill>
        )}
        <span className="ms-auto text-base font-bold tabular-nums tracking-tight text-foreground">
          {money(order.total, order.currency)}
        </span>
      </div>

      <div className="px-4 py-3">
        {restaurant && (
          <div className="mb-2.5">
            <div className="text-sm font-semibold tracking-tight text-foreground">{restaurant}</div>
            {subline && <div className="mt-0.5 text-xs text-muted-foreground">{subline}</div>}
            {owners && <div className="mt-0.5 text-2xs text-muted-foreground">{owners}</div>}
          </div>
        )}

        {order.items.length > 0 ? (
          <ul className="space-y-1.5">
            {order.items.map((it, i) => (
              <li key={`${it.name}-${i}`} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 text-xs">
                  <span className="inline-flex min-w-[1.75rem] tabular-nums font-medium text-foreground">
                    {it.qty}×
                  </span>
                  <span className="text-foreground">{it.name}</span>
                  {it.category && (
                    <span className="ms-1.5 text-2xs text-muted-foreground">· {it.category}</span>
                  )}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-foreground">
                  {money(it.price * it.qty, order.currency)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-2xs text-muted-foreground">
            {t('tickets.orderNoItems', { defaultValue: 'No line items on this order.' })}
          </p>
        )}

        {/* Totals + fulfilment detail. */}
        <dl className="mt-3 divide-y divide-foreground/[0.06] border-t border-foreground/[0.06] pt-1">
          {showSubtotal && (
            <MetaRow
              label={t('commerce.subtotal', { defaultValue: 'Items subtotal' })}
              value={<span className="tabular-nums">{money(itemsSubtotal, order.currency)}</span>}
            />
          )}
          {order.paymentStatus && (
            <MetaRow
              label={t('commerce.paymentStatus', { defaultValue: 'Payment status' })}
              value={
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
              }
            />
          )}
          {order.paymentMode && (
            <MetaRow
              label={t('commerce.paymentType', { defaultValue: 'Payment type' })}
              value={t(`commerce.paymentModes.${order.paymentMode}`, {
                defaultValue: titleize(order.paymentMode),
              })}
            />
          )}
          {order.deliveryAddress && (
            <MetaRow
              label={t('commerce.deliverTo', { defaultValue: 'Deliver to' })}
              value={order.deliveryAddress}
            />
          )}
          {order.placedAt && (
            <MetaRow
              label={t('commerce.placedAt', { defaultValue: 'Placed' })}
              value={<span className="tabular-nums">{fmtDateTime(order.placedAt)}</span>}
            />
          )}
        </dl>

        {order.capturedAt && (
          <p className="mt-2.5 text-2xs text-muted-foreground">
            {t('tickets.orderCapturedAt', {
              at: fmtDateTime(order.capturedAt),
              defaultValue: 'Snapshot taken {{at}}',
            })}
          </p>
        )}
      </div>
    </div>
  );
}
