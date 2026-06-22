import type {
  YijiOrder,
  YijiPaymentStatus,
  YijiPurchaseActivity,
  YijiShipmentTracking,
} from '@yiji/shared-types';
import { auth } from './directus.js';

/**
 * Commerce client — calls the ai-gateway commerce PROXY (C-2) instead of the
 * Yiji API directly, so no API token is shipped to the browser. Auth is the
 * agent's Directus session token; the gateway verifies it and injects the Yiji
 * key server-side. Method shapes mirror the old YijiClient so callers are
 * unchanged.
 */

const GATEWAY_URL =
  (import.meta.env.VITE_AI_GATEWAY_URL as string | undefined) ?? 'http://localhost:8081';

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
  getPurchaseActivity: (vendorId: string, customerId: string) =>
    get<YijiPurchaseActivity | null>('/commerce/activity', { vendorId, customerId }),
  getOrders: (vendorId: string, customerId: string, opts: { limit?: number } = {}) =>
    get<YijiOrder[]>('/commerce/orders', {
      vendorId,
      customerId,
      ...(opts.limit ? { limit: String(opts.limit) } : {}),
    }),
  getPaymentStatus: (vendorId: string, orderId: string) =>
    get<YijiPaymentStatus | null>('/commerce/payment', { vendorId, orderId }),
  getShipmentTracking: (vendorId: string, orderId: string) =>
    get<YijiShipmentTracking | null>('/commerce/shipment', { vendorId, orderId }),
};

export type CommerceClient = typeof commerce;
