import type {
  LateOrderQueue,
  YijiOrder,
  YijiOrderCart,
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

/**
 * The OPTIONAL vendor of the four routes that took none before MV-1 (cart,
 * late orders, service times, customer-exists). Omitted entirely when unknown,
 * so the request is byte-identical to the old one and the gateway answers for
 * the legacy vendor.
 */
function vendorParam(vendorId: string | null | undefined): { vendorId?: string } {
  const v = vendorId?.trim();
  return v ? { vendorId: v } : {};
}

async function get<T>(path: string, params: Record<string, string>): Promise<T> {
  const token = await auth.getToken();
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${GATEWAY_URL}${path}?${qs}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  /*
   * Distinguish "not signed in" from "no such order".
   *
   * The client authenticates in cookie mode, so getToken() returns the access
   * token held in memory — and null once a refresh has failed. The gateway then
   * answers 401 "Missing bearer token", the caller catches any error, and the
   * order panel renders "No order NNN for this vendor". That sent us looking at
   * Yiji and at vendor scoping for a fault that was only an expired session.
   * A thrown AUTH is caught by the same callers but says what actually happened.
   */
  if (res.status === 401 || res.status === 403) throw new Error('commerce AUTH');
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
  /**
   * The order's status timeline — Yiji's REAL status history when the admin
   * API is configured, falling back to a derived placed→payment→current shape
   * when it is not. The response says which (`derived`), and the panel labels
   * it, so a three-step guess is never shown as the whole story.
   */
  getOrderTimeline: (vendorId: string, orderId: string) =>
    get<YijiOrderTimeline | null>('/commerce/tracking', { vendorId, orderId }),
  getShipmentTracking: (vendorId: string, orderId: string) =>
    get<YijiShipmentTracking | null>('/commerce/shipment', { vendorId, orderId }),
  /**
   * Live delivery orders past the late threshold, newest-late first.
   *
   * Takes no arguments on purpose: the threshold is the business's rule, read
   * from `app_settings` server-side, not something a browser gets to choose.
   * It comes back on the response so the screen can state the real rule.
   */
  /**
   * Late orders. No dates = today's LIVE queue; a range = the register,
   * which includes orders that have since finished.
   */
  getLateOrders: (range?: { from: string; to: string }, live = false, vendorId?: string | null) =>
    get<LateOrderQueue>(
      '/commerce/late-orders',
      /* `live` marks a range that is the CURRENT business day rather than a past
         window, so the gateway caches it for 20s instead of 300 — see the note
         there. Omitted entirely when false, so existing callers are unchanged. */
      {
        ...(range ? { from: range.from, to: range.to, ...(live ? { live: '1' } : {}) } : {}),
        ...vendorParam(vendorId),
      },
    ),
  /**
   * The order's cart — every line and the choices behind it.
   *
   * Keyed by order id on the platform's admin API; the optional `vendorId`
   * (MV-1) picks whose platform, omitted = the legacy vendor. Returns null when no service credential is configured, which the
   * panel renders as "unavailable" rather than as an empty cart.
   */
  getOrderCart: (orderId: string, vendorId?: string | null) =>
    get<YijiOrderCart | null>('/commerce/cart', { orderId, ...vendorParam(vendorId) }),
  /**
   * Event times for a batch of orders — one call, not one per row.
   *
   * Returns `orderId -> { status: timestamp }`: the order's whole status
   * history, flattened. Every duration the late-orders screens show is two
   * stamps out of this map — service, driver arrival, delivery and preparation
   * — and they are computed by `orderEventTimes`, never here.
   *
   * None of these moments are in the late-orders LIST; they live in each order's
   * status history. Asked for only the rows on screen, so a long queue never
   * turns into hundreds of calls against Yiji's production API. The gateway caps
   * the batch at 50.
   */
  getOrderEventTimes: (orderIds: string[], vendorId?: string | null) =>
    get<Record<string, Record<string, string | null>>>('/commerce/service-times', {
      orderIds: orderIds.join(','),
      ...vendorParam(vendorId),
    }),
};

export type CommerceClient = typeof commerce;
