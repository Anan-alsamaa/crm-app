import type {
  YijiOrder,
  YijiOrderTimeline,
  YijiPaymentStatus,
  YijiPurchaseActivity,
  YijiShipmentTracking,
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

/**
 * What the inbox sidebar needs, in one answer: the newest orders as summaries,
 * plus the FULL detail of the first one (line items, restaurant, delivery) —
 * which the list endpoint does not carry and which the panel shows expanded.
 */
export interface InboxOrders {
  orders: YijiOrder[];
  detail: YijiOrder | null;
}

export const commerce = {
  getPurchaseActivity: (vendorId: string, customerId: string) =>
    get<YijiPurchaseActivity | null>('/commerce/activity', { vendorId, customerId }),
  /**
   * One request instead of list-then-detail. The two calls were sequential with
   * a component mount between them, so the panel cost two client round trips
   * and two cold upstream calls before it could show anything.
   */
  getInboxOrders: (vendorId: string, customerId: string, opts: { limit?: number } = {}) =>
    get<InboxOrders>('/commerce/inbox', {
      vendorId,
      customerId,
      ...(opts.limit ? { limit: String(opts.limit) } : {}),
    }),
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
  /** The order's status timeline (derived until Yiji ships a history API). */
  getOrderTimeline: (vendorId: string, orderId: string) =>
    get<YijiOrderTimeline | null>('/commerce/tracking', { vendorId, orderId }),
  getShipmentTracking: (vendorId: string, orderId: string) =>
    get<YijiShipmentTracking | null>('/commerce/shipment', { vendorId, orderId }),
};

export type CommerceClient = typeof commerce;
