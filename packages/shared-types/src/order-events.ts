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

/* ── Yiji v2 events (owner, 2026-11-16) ─────────────────────────────────── */

/**
 * WHAT V2 SENDS: `POST /webhooks/<v2 key>/events`, signed like v1's inbound,
 * envelope `{ id, type, occurred_at, environment, data }`, at-least-once
 * (de-duplicated on `id`). The CRM acts on `order.late` (sent once when the
 * order crosses v2's threshold, replacing the poll) and `order.status_changed`
 * (every change, incl. the close); `order.created` is taken too when sent.
 * Coupon, customer and campaign types are accepted and ignored here.
 */
export const YIJI2_ORDER_EVENT_TYPES = [
  'order.created',
  'order.status_changed',
  'order.late',
] as const;

export const Yiji2EventEnvelope = z.object({
  id: z.string().trim().min(1).max(128),
  type: z.string().trim().min(1).max(64),
  occurred_at: isoDateTime,
  environment: z.string().trim().max(32).optional(),
  data: z.record(z.unknown()),
});
export type Yiji2EventEnvelope = z.infer<typeof Yiji2EventEnvelope>;

export const Yiji2EventsBatch = z.object({ events: z.array(Yiji2EventEnvelope).min(1).max(100) });

/** Parse one v2 envelope or a batch of them (same batch rule as v1's route). */
export function parseYiji2EventsBody(body: unknown) {
  const isBatch = !!body && typeof body === 'object' && 'events' in (body as object);
  return isBatch ? Yiji2EventsBatch.safeParse(body) : Yiji2EventEnvelope.safeParse(body);
}

export function yiji2EventsOf(
  parsed: Yiji2EventEnvelope | { events: Yiji2EventEnvelope[] },
): Yiji2EventEnvelope[] {
  return 'events' in parsed ? parsed.events : [parsed];
}

export function isHandledYiji2Event(type: string): boolean {
  return (YIJI2_ORDER_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * V2'S ORDER STATES (contract of 2026-11-17, partner routes merged): every
 * `order.*` event and every partner order read carries one of these 15.
 * Exported so the connector and the events mapper can never disagree.
 */
export const YIJI2_ORDER_STATES = [
  'created',
  'awaiting_payment',
  'accepted',
  'sent_to_kitchen',
  'kitchen_confirmed',
  'preparing',
  'ready',
  'finding_courier',
  'courier_assigned',
  'out_for_delivery',
  'delivered',
  'arrived',
  'handed_over',
  'closed',
  'cancelled',
] as const;
export type Yiji2OrderState = (typeof YIJI2_ORDER_STATES)[number];

/**
 * The states that CLOSE an order (contract 2026-11-17): exactly these four.
 * `arrived` is still in delivery (the courier is at the door). Words outside
 * the 15 (an older draft's `refunded`, `completed`, `canceled`) no longer
 * close anything: v2 does not send them, and an `is_open` on the payload
 * still wins over the word.
 */
export const YIJI2_CLOSING_STATES: ReadonlySet<string> = new Set<Yiji2OrderState>([
  'delivered',
  'handed_over',
  'closed',
  'cancelled',
]);

/** v2 `state` -> the board's status word, for exactly the 15 states. */
export const YIJI2_STATE_STATUS: Readonly<Record<Yiji2OrderState, string>> = {
  created: 'placed',
  awaiting_payment: 'placed',
  accepted: 'received',
  sent_to_kitchen: 'in_kitchen',
  kitchen_confirmed: 'in_kitchen',
  preparing: 'in_kitchen',
  ready: 'ready',
  finding_courier: 'ready',
  courier_assigned: 'ready',
  out_for_delivery: 'in_delivery',
  arrived: 'in_delivery',
  delivered: 'delivered',
  handed_over: 'delivered',
  closed: 'delivered',
  cancelled: 'canceled',
};
const V2_STATE_STATUS: Record<string, string> = YIJI2_STATE_STATUS;
const V2_CLOSED = YIJI2_CLOSING_STATES;

const v2Str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;
const v2Id = (v: unknown): string | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? String(v) : v2Str(v);
const v2Num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const v2Obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

/**
 * v2's order types (crm-events-v1.yaml, confirmed by the v2 session
 * 2026-11-16) as the CRM's. A food-court PARENT is the order that is
 * delivered (the board shows it, grouped); a SUB names its parent and is
 * hidden behind it. Unknown values are kept off the delivery board.
 */
const V2_ORDER_TYPE: Record<string, OrderEventOrderType> = {
  delivery: 'delivery',
  pickup: 'pickup',
  carhop: 'carhop',
  dine_in: 'dine_in',
  takeaway: 'takeout',
  food_court_parent: 'delivery',
  food_court_sub: 'other',
  catering: 'other',
};

/**
 * One v2 envelope as the CRM's `OrderEvent`, or null when it is not an order
 * event the CRM acts on. v2 guarantees `order_type`, `state`, `order_number`
 * and `at`/`occurred_at` on every order event, so an envelope WITHOUT one of
 * them is malformed: null, and `opts.malformed` is told (never defaulted -
 * a defaulted order type would put a pickup on the delivery board).
 * `order.late` carries `elapsed_seconds` and `placed_at`; when `placed_at`
 * is missing it is derived from `occurred_at - elapsed_seconds` so the clock
 * still runs from the right moment. Money is `{ amount_minor, currency }`
 * at `data.total` -> SAR/BHD major units.
 */
export function orderEventFromYiji2(
  e: Yiji2EventEnvelope,
  opts: { malformed?: (reason: string, eventId: string) => void } = {},
): OrderEvent | null {
  if (!isHandledYiji2Event(e.type)) return null;
  const d = e.data;
  const bad = (reason: string): null => {
    opts.malformed?.(reason, e.id);
    return null;
  };
  const orderId = v2Id(d.order_number) ?? v2Id(d.order_id);
  if (!orderId) return bad('no order_number');
  const state = v2Str(d.state) ?? v2Str(d.status);
  if (!state) return bad('no state');
  const typeRaw = v2Str(d.order_type)?.toLowerCase();
  if (!typeRaw) return bad('no order_type');
  const placedAt =
    v2Str(d.placed_at) ??
    (typeof d.elapsed_seconds === 'number'
      ? new Date(Date.parse(e.occurred_at) - d.elapsed_seconds * 1000).toISOString()
      : undefined);
  if (!placedAt || Number.isNaN(Date.parse(placedAt)))
    return bad('no placed_at or elapsed_seconds');
  const lower = state.toLowerCase();
  const status = V2_STATE_STATUS[lower] ?? lower;
  const isOpen = typeof d.is_open === 'boolean' ? d.is_open : !V2_CLOSED.has(lower);
  const orderType: OrderEventOrderType = V2_ORDER_TYPE[typeRaw] ?? 'other';
  const groupMaster = d.is_group_master === true || typeRaw === 'food_court_parent';
  const customer = v2Obj(d.customer);
  const money = v2Obj(d.total);
  const minor = v2Num(money.amount_minor);
  const currency = v2Str(money.currency)?.toUpperCase();
  const total = minor !== undefined ? minor / (currency === 'BHD' ? 1000 : 100) : undefined;
  const parent = v2Id(d.parent_order_number);
  const subs = Array.isArray(d.sub_orders) ? d.sub_orders.length : 0;
  const customerId = v2Id(d.customer_id) ?? v2Id(customer.id);
  const customerName = v2Str(customer.name);
  const customerPhone = v2Str(customer.phone);
  const candidate = {
    id: e.id,
    type: e.type === 'order.late' ? 'order.status_changed' : e.type,
    at: e.occurred_at,
    order: {
      orderId,
      status,
      isOpen,
      orderType,
      placedAt,
      ...(v2Id(d.restaurant_id) ? { restaurantId: v2Id(d.restaurant_id) } : {}),
      ...(v2Str(d.restaurant_name) ? { restaurantName: v2Str(d.restaurant_name) } : {}),
      ...(v2Id(d.brand_id) ? { brandId: v2Id(d.brand_id) } : {}),
      ...(v2Str(d.brand_name) ? { brandName: v2Str(d.brand_name) } : {}),
      ...(customerId || customerName || customerPhone
        ? {
            customer: {
              ...(customerId ? { id: customerId } : {}),
              ...(customerName ? { name: customerName } : {}),
              ...(customerPhone ? { phone: customerPhone } : {}),
            },
          }
        : {}),
      ...(total !== undefined ? { total } : {}),
      ...(subs > 0 || groupMaster ? { isGroupMaster: true } : {}),
      ...(parent ? { parentOrderId: parent } : {}),
    },
  };
  const parsed = OrderEvent.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
