import { z } from 'zod';
import type { LateOrderRow } from './late-delivery.js';

/**
 * ORDER EVENTS FROM THE COMMERCE PLATFORM (owner, 2026-11-15): late orders
 * stay in the CRM, "but in a much more efficient manner than the existing
 * calls to Yiji". Instead of asking Yiji every minute which orders are late,
 * the platform (Yiji v2) tells the CRM every order status change as it
 * happens. The CRM keeps its own LIVE ORDERS table per vendor, times each
 * order itself, and builds the late-orders board from it; the old poll
 * becomes a reconciliation every few minutes.
 *
 * This file is the contract (what an event carries) and the pure logic (how
 * an event changes a live order, and how live orders become board rows). The
 * receiver (socket-gateway) and the processor (workers) are thin around it.
 */

/** The order's channel, in the CRM's words. The board shows delivery only. */
export const OrderEventOrderType = z.enum([
  'delivery',
  'pickup',
  'dine_in',
  'carhop',
  'takeout',
  'other',
]);
export type OrderEventOrderType = z.infer<typeof OrderEventOrderType>;

/** The event types the CRM acts on today. Others are accepted and ignored. */
export const ORDER_EVENT_TYPES = ['order.created', 'order.status_changed'] as const;
export type OrderEventType = (typeof ORDER_EVENT_TYPES)[number];

const isoDateTime = z.string().datetime({ offset: true });

/** One event, as the platform sends it. */
export const OrderEvent = z.object({
  /** The platform's event id: the idempotency key. A retry carries the same id. */
  id: z.string().trim().min(1).max(128),
  type: z.string().trim().min(1).max(64),
  /** When it happened (ISO 8601 with an offset or Z - never a bare local time). */
  at: isoDateTime,
  order: z.object({
    orderId: z.string().trim().min(1).max(64),
    /** The platform's status word (e.g. in_kitchen, in_delivery, delivered). */
    status: z.string().trim().min(1).max(64),
    /** False once the order is finished - delivered, closed or cancelled. */
    isOpen: z.boolean(),
    orderType: OrderEventOrderType,
    placedAt: isoDateTime,
    restaurantId: z.string().trim().max(64).optional(),
    restaurantName: z.string().trim().max(200).optional(),
    brandId: z.string().trim().max(64).optional(),
    brandName: z.string().trim().max(200).optional(),
    customer: z
      .object({
        id: z.string().trim().max(64).optional(),
        name: z.string().trim().max(200).optional(),
        phone: z.string().trim().max(32).optional(),
      })
      .optional(),
    /** The order's value in SAR. */
    total: z.number().min(0).optional(),
    /** A food-court master (one order to several restaurants). */
    isGroupMaster: z.boolean().optional(),
    /** Set on a sub-order of a group: the master's id. Sub-orders are not board rows. */
    parentOrderId: z.string().trim().max(64).nullable().optional(),
  }),
});
export type OrderEvent = z.infer<typeof OrderEvent>;

/** A batch of up to 100. */
export const OrderEventsBatch = z.object({ events: z.array(OrderEvent).min(1).max(100) });
/** One event, or a batch. */
export const OrderEventsBody = z.union([OrderEventsBatch, OrderEvent]);
export type OrderEventsBody = z.infer<typeof OrderEventsBody>;

export function orderEventsOf(body: OrderEventsBody): OrderEvent[] {
  return 'events' in body ? body.events : [body];
}

/**
 * Parse a body as a batch when it says `events`, else as one event - so an
 * invalid field is named (a union's error only says "invalid input").
 */
export function parseOrderEventsBody(body: unknown) {
  const isBatch = !!body && typeof body === 'object' && 'events' in (body as object);
  return isBatch ? OrderEventsBatch.safeParse(body) : OrderEvent.safeParse(body);
}

export function isHandledOrderEvent(type: string): type is OrderEventType {
  return (ORDER_EVENT_TYPES as readonly string[]).includes(type);
}

/** The job the receiver hands the workers: one event, for one vendor. */
export const LateOrdersEventJob = z.object({
  /** `<platform>:<platformVendorId>` - the late-orders vendor key. */
  vendorKey: z.string().min(3),
  event: OrderEvent,
});
export type LateOrdersEventJob = z.infer<typeof LateOrdersEventJob>;
export const LATE_ORDERS_EVENT_JOB = 'event';

/* ── the live order, as the CRM keeps it ─────────────────────────────────── */

/** One order the CRM is tracking, built from events (or a reconciliation read). */
export interface LiveOrder {
  orderId: string;
  status: string;
  isOpen: boolean;
  orderType: OrderEventOrderType;
  placedAt: string;
  /** When it finished (the first "not open" event); null while it runs. */
  closedAt: string | null;
  /** The FIRST time each status was seen - the legs of the timeline. */
  firstAt: Record<string, string>;
  /** The newest event applied; an older one never moves the status back. */
  lastEventAt: string;
  restaurantId?: string;
  restaurantName?: string;
  brandId?: string;
  brandName?: string;
  customerId?: string;
  customerName?: string;
  customerPhone?: string;
  total?: number;
  isGroupMaster?: boolean;
  parentOrderId?: string | null;
  /** Where the CRM last heard about it. */
  source: 'event' | 'poll';
}

/** The Redis hash of a vendor's live orders: field = orderId, value = LiveOrder JSON. */
export const liveOrdersKey = (vendorKey: string): string => `late-orders:live:${vendorKey}`;
/** "Events are flowing for this vendor" - set on every event, so the poll becomes a reconciliation. */
export const liveOrdersEventsModeKey = (vendorKey: string): string =>
  `late-orders:events-mode:${vendorKey}`;
/** When the vendor's live table was last reconciled against the platform. */
export const liveOrdersReconciledKey = (vendorKey: string): string =>
  `late-orders:reconciled:${vendorKey}`;
/** A live table nobody has written to in this long is dropped whole. */
export const LIVE_ORDERS_TTL_SEC = 12 * 60 * 60;
/** Events for this long after the last one keep the vendor in events mode. */
export const LIVE_ORDERS_EVENTS_MODE_SEC = 15 * 60;
/** How often the platform is still asked, as a safety net, while events flow. */
export const DEFAULT_LATE_ORDERS_RECONCILE_MS = 5 * 60_000;
/** A finished order leaves the table this long after it finished; an open one this long after it was placed. */
export const LIVE_ORDER_MAX_AGE_MS = 6 * 60 * 60_000;

const ms = (iso: string): number => Date.parse(iso);

/**
 * Apply one event to what the CRM knows about the order. Pure. Newest wins:
 * an event older than the last one applied changes nothing but the legs
 * (its status's first-seen time, if earlier). The first "not open" event
 * stops the clock; a later open event cannot restart it.
 */
export function applyOrderEvent(prev: LiveOrder | null, e: OrderEvent): LiveOrder {
  const o = e.order;
  const firstAt = { ...(prev?.firstAt ?? {}) };
  const seen = firstAt[o.status];
  if (!seen || ms(e.at) < ms(seen)) firstAt[o.status] = e.at;
  const stale = prev !== null && ms(e.at) < ms(prev.lastEventAt);
  const base: LiveOrder = prev ?? {
    orderId: o.orderId,
    status: o.status,
    isOpen: o.isOpen,
    orderType: o.orderType,
    placedAt: o.placedAt,
    closedAt: null,
    firstAt: {},
    lastEventAt: e.at,
    source: 'event',
  };
  const closedAt =
    base.closedAt ?? (o.isOpen ? null : stale && prev ? (prev.isOpen ? e.at : null) : e.at);
  const next: LiveOrder = {
    ...base,
    firstAt,
    source: 'event',
    placedAt: prev?.placedAt ?? o.placedAt,
    closedAt,
    ...(stale
      ? {}
      : {
          status: o.status,
          isOpen: closedAt ? false : o.isOpen,
          orderType: o.orderType,
          lastEventAt: e.at,
        }),
    ...(o.restaurantId ? { restaurantId: o.restaurantId } : {}),
    ...(o.restaurantName ? { restaurantName: o.restaurantName } : {}),
    ...(o.brandId ? { brandId: o.brandId } : {}),
    ...(o.brandName ? { brandName: o.brandName } : {}),
    ...(o.customer?.id ? { customerId: o.customer.id } : {}),
    ...(o.customer?.name ? { customerName: o.customer.name } : {}),
    ...(o.customer?.phone ? { customerPhone: o.customer.phone } : {}),
    ...(typeof o.total === 'number' ? { total: o.total } : {}),
    ...(typeof o.isGroupMaster === 'boolean' ? { isGroupMaster: o.isGroupMaster } : {}),
    ...(o.parentOrderId !== undefined ? { parentOrderId: o.parentOrderId } : {}),
  };
  return next;
}

/** A board row from a reconciliation read, so the poll can fill the table. */
export function pollRowToLiveOrder(row: LateOrderRow, now: number): LiveOrder {
  const live = row.live !== false;
  const closedAt = live ? null : (row.closedAt ?? new Date(now).toISOString());
  return {
    orderId: row.orderId,
    status: row.status,
    isOpen: live,
    orderType: 'delivery',
    placedAt: row.placedAt,
    closedAt,
    firstAt: {},
    lastEventAt: new Date(now).toISOString(),
    ...(row.restaurantId ? { restaurantId: row.restaurantId } : {}),
    ...(row.restaurantName ? { restaurantName: row.restaurantName } : {}),
    ...(row.brandName ? { brandName: row.brandName } : {}),
    ...(row.externalCustomerId ? { customerId: row.externalCustomerId } : {}),
    ...(row.customerName ? { customerName: row.customerName } : {}),
    ...(row.customerPhone ? { customerPhone: row.customerPhone } : {}),
    ...(typeof row.total === 'number' ? { total: row.total } : {}),
    source: 'poll',
  };
}

/**
 * A live order as the board shows it: minutes so far while it runs, the
 * clock stopped at `closedAt` once it finished (otherwise a closed order from
 * this morning would report how long AGO it happened, not how late it was).
 */
export function liveOrderToLateRow(o: LiveOrder, now: number): LateOrderRow {
  const end = o.closedAt ? ms(o.closedAt) : now;
  const minutesElapsed = Math.max(0, Math.floor((end - ms(o.placedAt)) / 60_000));
  return {
    orderId: o.orderId,
    status: o.status,
    minutesElapsed,
    live: !o.closedAt,
    placedAt: o.placedAt,
    ...(o.brandName ? { brandName: o.brandName } : {}),
    ...(o.restaurantName ? { restaurantName: o.restaurantName } : {}),
    ...(o.restaurantId ? { restaurantId: o.restaurantId } : {}),
    ...(o.customerName ? { customerName: o.customerName } : {}),
    ...(o.customerPhone ? { customerPhone: o.customerPhone } : {}),
    ...(typeof o.total === 'number' ? { total: o.total } : {}),
    ...(o.customerId ? { externalCustomerId: o.customerId } : {}),
    ...(o.closedAt ? { closedAt: o.closedAt } : {}),
  };
}

/** Is this order too old to keep in the live table? */
export function liveOrderExpired(o: LiveOrder, now: number): boolean {
  const since = o.closedAt ? ms(o.closedAt) : ms(o.placedAt);
  return !Number.isFinite(since) || now - since > LIVE_ORDER_MAX_AGE_MS;
}

/**
 * The board rows: delivery orders (masters, never the sub-orders of a group)
 * running past the threshold, longest first - the same shape and filter the
 * Yiji poll produced, so the board needs no change.
 */
export function lateRowsFromLive(
  orders: readonly LiveOrder[],
  thresholdMinutes: number,
  now: number,
): LateOrderRow[] {
  return orders
    .filter((o) => o.orderType === 'delivery' && !o.parentOrderId && !liveOrderExpired(o, now))
    .map((o) => liveOrderToLateRow(o, now))
    .filter((r) => r.minutesElapsed >= thresholdMinutes)
    .sort((a, b) => b.minutesElapsed - a.minutesElapsed);
}

/** Parse what Redis holds; a damaged entry is dropped, never a crash. */
export function parseLiveOrders(raw: Record<string, string>): LiveOrder[] {
  const out: LiveOrder[] = [];
  for (const v of Object.values(raw)) {
    try {
      const o = JSON.parse(v) as LiveOrder;
      if (o && typeof o.orderId === 'string' && typeof o.placedAt === 'string') out.push(o);
    } catch {
      /* dropped */
    }
  }
  return out;
}
