import type {
  LateOrderQueue,
  YijiOrder,
  YijiPaymentStatus,
  YijiPurchaseActivity,
  YijiShipmentTracking,
  YijiOrderCart,
  YijiOrderTimeline,
} from '@yiji/shared-types';
import { auth } from './directus.js';
import { resolveUrl } from '@yiji/shared-config';

/**
 * Commerce client — calls the ai-gateway commerce PROXY (C-2) instead of the
 * Yiji API directly, so no API token is shipped to the browser. Auth is the
 * agent's Directus session token; the gateway verifies it and injects the Yiji
 * key server-side. Method shapes mirror the old YijiClient so callers are
 * unchanged.
 */

const GATEWAY_URL = resolveUrl(
  'AI_GATEWAY_URL',
  import.meta.env.VITE_AI_GATEWAY_URL as string | undefined,
  'http://localhost:8081',
);

async function get<T>(path: string, params: Record<string, string>): Promise<T> {
  const token = await auth.getToken();
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${GATEWAY_URL}${path}?${qs}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`commerce ${res.status}`);
  const body = (await res.json()) as { data: T };
  return body.data;
}

export const commerce = {
  /**
   * The late-orders queue for a window — the same endpoint the agent portal
   * reads (owner, 2026-09-29).
   *
   * The admin report needs it because a PENDING late order has no database row
   * at all: it exists only upstream until somebody comments on it or gives a
   * coupon. Without this the report can only ever show orders that were
   * already acted on, which is the opposite of what "pending" means.
   */
  getLateOrders: (range: { from: string; to: string }) =>
    get<LateOrderQueue>('/commerce/late-orders', { from: range.from, to: range.to }),
  /**
   * Event times for a batch of orders — `orderId -> { status: timestamp }`.
   *
   * The register's service, driver-arrival, delivery and preparation columns are
   * each two stamps out of this map, computed by `orderEventTimes`. Batched so a
   * page of rows is one call rather than one per row, and the gateway caps it at
   * 50 — which is why only the VISIBLE page is ever asked for.
   */
  /**
   * Does this phone belong to a Yiji customer?
   *
   * The coupon approval card asks before it warns: an order-less coupon is
   * delivered by resolving the customer from their number, so a caveat about
   * "they may not have the app" is noise on the majority who do.
   *
   * `configured: false` means nothing was asked (no admin credential), which is
   * NOT the same as "they do not exist" and must not render a warning.
   */
  customerExists: (phone: string) =>
    get<{ configured: boolean; exists: boolean; customerId: string | null }>(
      '/commerce/customer-exists',
      { phone },
    ),
  getOrderEventTimes: (orderIds: string[]) =>
    get<Record<string, Record<string, string | null>>>('/commerce/service-times', {
      orderIds: orderIds.join(','),
    }),
  getPurchaseActivity: (vendorId: string, customerId: string) =>
    get<YijiPurchaseActivity | null>('/commerce/activity', { vendorId, customerId }),
  getOrders: (vendorId: string, customerId: string, opts: { limit?: number } = {}) =>
    get<YijiOrder[]>('/commerce/orders', {
      vendorId,
      customerId,
      ...(opts.limit ? { limit: String(opts.limit) } : {}),
    }),
  getOrder: (vendorId: string, orderId: string) =>
    get<YijiOrder | null>('/commerce/order', { vendorId, orderId }),
  getPaymentStatus: (vendorId: string, orderId: string) =>
    get<YijiPaymentStatus | null>('/commerce/payment', { vendorId, orderId }),
  getShipmentTracking: (vendorId: string, orderId: string) =>
    get<YijiShipmentTracking | null>('/commerce/shipment', { vendorId, orderId }),
  /*
   * THE CART AND THE TRACKING — the two the agent portal already reads.
   *
   * Added 2026-10-04 so the admin late-orders report can render the SAME
   * "Cart & tracking" panel rather than a thinner lookalike (ops: *"should be
   * a mirror image... the data displayed, the style, everything"*). The
   * endpoints are identical and both are cached server-side; this client was
   * simply missing the two calls, which is why the admin panel had to be
   * written as a different, smaller thing.
   *
   * `getOrderCart` takes the ORDER alone — it is keyed by order id and needs no
   * vendor, which is what lets it answer even when the order lookup cannot.
   */
  getOrderCart: (orderId: string) => get<YijiOrderCart | null>('/commerce/cart', { orderId }),
  getOrderTimeline: (vendorId: string, orderId: string) =>
    get<YijiOrderTimeline | null>('/commerce/tracking', { vendorId, orderId }),
};

export type CommerceClient = typeof commerce;
