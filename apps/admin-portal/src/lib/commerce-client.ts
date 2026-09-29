import type {
  LateOrderQueue,
  YijiOrder,
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
};

export type CommerceClient = typeof commerce;
