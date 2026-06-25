import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, cn, Pill, Skeleton } from '@yiji/ui';
import type {
  YijiOrder,
  YijiPaymentStatus,
  YijiPurchaseActivity,
  YijiShipmentTracking,
} from '@yiji/shared-types';
import { commerce, type CommerceClient } from '../../lib/commerce-client.js';
import { ai, type AiError } from '../../lib/ai-client.js';
import { useAuth } from '../../lib/auth/AuthContext.js';

/**
 * Commerce side panel.
 *
 * Consumes the ai-gateway commerce PROXY (C-2) — the Yiji API key stays on the
 * server. Renders lifetime value + recent orders, with per-order payment +
 * shipment status pulled inline. Every section degrades gracefully — if the
 * proxy returns null the panel shows a soft "Commerce data unavailable" notice
 * rather than crashing.
 */

interface Props {
  yijiVendorId: string;
  externalCustomerId: string;
}

const ORDER_TONE: Record<
  string,
  'success' | 'warning' | 'muted' | 'primary' | 'destructive' | 'neutral'
> = {
  placed: 'primary',
  paid: 'primary',
  shipped: 'warning',
  delivered: 'success',
  cancelled: 'muted',
  refunded: 'destructive',
};

const PAYMENT_TONE: Record<string, 'success' | 'warning' | 'muted' | 'destructive' | 'neutral'> = {
  pending: 'warning',
  authorized: 'warning',
  captured: 'success',
  failed: 'destructive',
  refunded: 'destructive',
};

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function fmtAiErr(err: unknown): string {
  const e = err as AiError;
  if (e?.code === 'feature_disabled') return 'Disabled by admin.';
  if (e?.code === 'order_not_found') return 'Order not found.';
  if (e?.code === 'no_orders') return 'No orders for this customer.';
  if (e?.code === 'rate_limited') return 'Rate limited — try again shortly.';
  if (e?.code === 'provider_unavailable' || e?.code === 'upstream')
    return 'AI is temporarily busy. Try again.';
  return e?.message ?? 'Failed.';
}

/**
 * In-chat order retrieval. The agent enters an order id (or leaves it blank to
 * use the customer's latest orders) plus an optional question; the gateway
 * fetches live commerce data server-side and the model answers grounded in it.
 */
function OrderAssistCard({ yijiVendorId, externalCustomerId }: Props) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const caller = { userId: user?.id ?? '', vendorId: yijiVendorId };
  const [orderId, setOrderId] = useState('');
  const [question, setQuestion] = useState('');

  const assist = useMutation({
    mutationFn: () =>
      ai.orderAssist(caller, {
        vendorId: yijiVendorId,
        ...(orderId.trim()
          ? { orderId: orderId.trim() }
          : { customerId: externalCustomerId, limit: 4 }),
        ...(question.trim() ? { question: question.trim() } : {}),
      }),
  });

  return (
    <div className="rounded-2xl bg-card/70 ring-1 ring-foreground/[0.04] shadow-sm shadow-foreground/[0.04] px-5 py-4 space-y-3">
      <h3 className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {t('commerce.askAi', { defaultValue: 'Ask AI about orders' })}
      </h3>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          assist.mutate();
        }}
        className="space-y-2"
      >
        <input
          type="text"
          value={orderId}
          onChange={(e) => setOrderId(e.target.value)}
          aria-label={t('commerce.orderIdLabel', { defaultValue: 'Order ID (optional)' })}
          placeholder={t('commerce.orderIdPlaceholder', {
            defaultValue: 'Order ID (blank = latest orders)',
          })}
          className="block h-8 w-full rounded-md border border-border bg-background/60 px-2.5 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none text-start"
        />
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            aria-label={t('commerce.askPlaceholder', { defaultValue: 'Ask about the order(s)…' })}
            placeholder={t('commerce.askPlaceholder', { defaultValue: 'Ask about the order(s)…' })}
            className="block h-8 w-full rounded-md border border-border bg-background/60 px-2.5 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none text-start"
          />
          <Button type="submit" size="sm" loading={assist.isPending}>
            {t('commerce.ask', { defaultValue: 'Ask' })}
          </Button>
        </div>
      </form>

      {assist.data && (
        <div className="rounded-xl bg-secondary/40 px-4 py-3 space-y-2">
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
            {assist.data.answer}
          </p>
          {assist.data.order && (
            <p className="text-2xs tabular-nums text-muted-foreground">
              {assist.data.order.orderId} · {assist.data.order.status} ·{' '}
              {formatMoney(assist.data.order.total, assist.data.order.currency)}
            </p>
          )}
          {assist.data.orders && assist.data.orders.length > 0 && (
            <p className="text-2xs tabular-nums text-muted-foreground">
              {assist.data.orders.map((o) => o.orderId).join(', ')}
            </p>
          )}
        </div>
      )}
      {assist.isError && <p className="text-xs text-destructive">{fmtAiErr(assist.error)}</p>}
    </div>
  );
}

export function CommercePanel({ yijiVendorId, externalCustomerId }: Props) {
  const { t } = useTranslation();
  const client = commerce;

  const activity = useQuery({
    queryKey: ['yiji-activity', yijiVendorId, externalCustomerId],
    enabled: !!yijiVendorId && !!externalCustomerId,
    queryFn: () => client.getPurchaseActivity(yijiVendorId, externalCustomerId),
    staleTime: 60_000,
  });

  const orders = useQuery({
    queryKey: ['yiji-orders', yijiVendorId, externalCustomerId],
    enabled: !!yijiVendorId && !!externalCustomerId,
    queryFn: () => client.getOrders(yijiVendorId, externalCustomerId, { limit: 6 }),
    staleTime: 60_000,
  });

  const loading = activity.isLoading || orders.isLoading;
  const unavailable =
    !activity.data && !loading && !orders.isLoading && (orders.data?.length ?? 0) === 0;

  if (!yijiVendorId || !externalCustomerId) {
    return (
      <div className="rounded-2xl bg-card/60 ring-1 ring-foreground/[0.04] px-5 py-4">
        <p className="text-xs text-muted-foreground">
          {t('commerce.noLink', {
            defaultValue: 'No Yiji customer linked — commerce data not available.',
          })}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* In-chat AI order retrieval */}
      <OrderAssistCard yijiVendorId={yijiVendorId} externalCustomerId={externalCustomerId} />

      {/* Activity summary */}
      <div className="rounded-2xl bg-card/70 ring-1 ring-foreground/[0.04] shadow-sm shadow-foreground/[0.04] px-5 py-4">
        <h3 className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {t('commerce.activity', { defaultValue: 'Lifetime activity' })}
        </h3>
        {loading ? (
          <div className="mt-3 space-y-2">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-4 w-20" />
          </div>
        ) : activity.data ? (
          <ActivitySummary data={activity.data} />
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            {t('commerce.unavailable', { defaultValue: 'Commerce data unavailable.' })}
          </p>
        )}
      </div>

      {/* Orders */}
      <div className="space-y-2">
        <h3 className="px-1 text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {t('commerce.recentOrders', { defaultValue: 'Recent orders' })}
        </h3>
        {orders.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full rounded-2xl" />
            <Skeleton className="h-16 w-full rounded-2xl" />
          </div>
        ) : orders.data && orders.data.length > 0 ? (
          <ul className="space-y-2">
            {orders.data.map((o) => (
              <li key={o.orderId}>
                <OrderCard order={o} client={client} yijiVendorId={yijiVendorId} />
              </li>
            ))}
          </ul>
        ) : unavailable ? (
          <p className="px-1 text-xs text-muted-foreground">
            {t('commerce.unavailable', { defaultValue: 'Commerce data unavailable.' })}
          </p>
        ) : (
          <p className="px-1 text-xs text-muted-foreground">
            {t('commerce.noOrders', { defaultValue: 'No orders yet.' })}
          </p>
        )}
      </div>
    </div>
  );
}

function ActivitySummary({ data }: { data: YijiPurchaseActivity }) {
  const { t } = useTranslation();
  return (
    <div className="mt-2 space-y-2">
      <div className="flex items-baseline gap-3">
        <span className="text-2xl font-semibold tracking-tight tabular-nums text-foreground">
          {formatMoney(data.lifetimeValue, 'SAR')}
        </span>
        <span className="text-xs text-muted-foreground">
          {t('commerce.ltv', { defaultValue: 'lifetime value' })}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-muted-foreground tabular-nums">
        <span>
          <strong className="font-medium text-foreground">{data.orderCount}</strong>{' '}
          {t('commerce.orders', { defaultValue: 'orders' })}
        </span>
        {data.lastOrderAt && (
          <span>
            {t('commerce.lastOrder', { defaultValue: 'last order' })}:{' '}
            <strong className="font-medium text-foreground">
              {new Date(data.lastOrderAt).toLocaleDateString()}
            </strong>
          </span>
        )}
      </div>
    </div>
  );
}

function OrderCard({
  order,
  client,
  yijiVendorId,
}: {
  order: YijiOrder;
  client: CommerceClient;
  yijiVendorId: string;
}) {
  const { t } = useTranslation();
  const payment = useQuery({
    queryKey: ['yiji-payment', yijiVendorId, order.orderId],
    queryFn: () => client.getPaymentStatus(yijiVendorId, order.orderId),
    staleTime: 5 * 60_000,
  });
  const shipment = useQuery({
    queryKey: ['yiji-shipment', yijiVendorId, order.orderId],
    queryFn: () => client.getShipmentTracking(yijiVendorId, order.orderId),
    staleTime: 5 * 60_000,
  });

  return (
    <div className="rounded-2xl bg-card/70 ring-1 ring-foreground/[0.04] shadow-sm shadow-foreground/[0.04] px-4 py-3 space-y-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-xs text-muted-foreground">{order.orderId}</span>
            <Pill tone={ORDER_TONE[order.status] ?? 'neutral'} size="sm">
              {order.status}
            </Pill>
          </div>
          <div className="mt-0.5 text-2xs text-muted-foreground tabular-nums">
            {new Date(order.placedAt).toLocaleDateString()}
          </div>
        </div>
        <div className="shrink-0 text-sm font-semibold tabular-nums tracking-tight text-foreground">
          {formatMoney(order.total, order.currency)}
        </div>
      </div>

      {order.items.length > 0 && (
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {order.items.slice(0, 3).map((it) => (
            <li key={it.sku} className="flex items-baseline justify-between gap-2">
              <span className="truncate">
                <span className="text-foreground/80">{it.qty}×</span> {it.name}
              </span>
              <span className="shrink-0 tabular-nums">
                {formatMoney(it.price * it.qty, order.currency)}
              </span>
            </li>
          ))}
          {order.items.length > 3 && (
            <li className="text-2xs italic">
              +{order.items.length - 3} {t('commerce.moreItems', { defaultValue: 'more' })}
            </li>
          )}
        </ul>
      )}

      <PaymentShipmentRow payment={payment.data} shipment={shipment.data} />
    </div>
  );
}

function PaymentShipmentRow({
  payment,
  shipment,
}: {
  payment: YijiPaymentStatus | null | undefined;
  shipment: YijiShipmentTracking | null | undefined;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-1 text-2xs">
      {payment ? (
        <span className="inline-flex items-center gap-1.5">
          <span className="text-muted-foreground">
            {t('commerce.payment', { defaultValue: 'payment' })}:
          </span>
          <Pill tone={PAYMENT_TONE[payment.status] ?? 'neutral'} size="sm">
            {payment.status}
          </Pill>
          {payment.method && <span className="text-muted-foreground">· {payment.method}</span>}
        </span>
      ) : null}
      {shipment ? (
        <span className="inline-flex items-center gap-1.5">
          <span className="text-muted-foreground">
            {t('commerce.shipment', { defaultValue: 'shipment' })}:
          </span>
          <Pill tone={shipment.status === 'delivered' ? 'success' : 'warning'} size="sm">
            {shipment.status.replace(/_/g, ' ')}
          </Pill>
          {shipment.carrier && (
            <span className="text-muted-foreground tabular-nums">
              · {shipment.carrier} {shipment.trackingNumber ?? ''}
            </span>
          )}
        </span>
      ) : null}
    </div>
  );
}

// Suppress unused-import lint warning from cn helper kept for downstream tweaks.
export const _cn = cn;
