import { z } from 'zod';

/**
 * Late Delivery Handling — the contract shared by the gateway, the agent
 * portal and the reports.
 *
 * WHAT THIS AUTOMATES. WeCare watch Yiji's dashboard for delivery orders that
 * pass an hour and chase them by hand. This turns that into a queue with two
 * recorded outcomes, so the decision has an author and the reason survives.
 */

/**
 * The threshold, in minutes. The owner's rule is 60 for every brand
 * (2026-09-21) — this is not a per-brand setting and must not become one
 * without them saying so.
 */
export const DEFAULT_LATE_DELIVERY_MINUTES = 60;

/** The `app_settings` key holding the editable threshold. */
export const LATE_DELIVERY_MINUTES_KEY = 'late_delivery_minutes';

/**
 * Read the threshold from whatever `app_settings` holds, falling back to 60.
 *
 * Deliberately total: a blank row, a typo, a negative or a wild number all
 * resolve to the documented default rather than throwing or — worse —
 * producing a queue that silently matches everything or nothing. A setting
 * nobody can break is a setting operations can be trusted with.
 *
 * The ceiling is a day: past that the "queue" is a history report, and a
 * mistyped 6000 would quietly empty the screen the feature exists to fill.
 */
export function lateDeliveryMinutes(raw: string | number | null | undefined): number {
  const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? '').trim());
  if (!Number.isFinite(n)) return DEFAULT_LATE_DELIVERY_MINUTES;
  const whole = Math.floor(n);
  if (whole < 1 || whole > 24 * 60) return DEFAULT_LATE_DELIVERY_MINUTES;
  return whole;
}

/**
 * Saudi Arabia is UTC+3 all year — no daylight saving, ever.
 *
 * A fixed offset is therefore correct here in a way it would not be for most
 * timezones, and it avoids depending on the host having tz data.
 */
const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * Yiji's naked timestamps, as an instant.
 *
 * `creationTime` arrives as `2026-09-21T15:15:53.811204` with NO zone marker,
 * and it is RIYADH local time. `Date.parse` reads an unmarked timestamp as the
 * HOST's local time, so the answer depends on where the code runs:
 *
 *   - on this dev machine (Riyadh) it is right, which is how the bug survived
 *   - in the ECS container (UTC) the same string is read three hours early,
 *     making every order appear to be placed in the FUTURE
 *
 * Measured on staging 2026-09-21: an order placed 15:15 Riyadh reported
 * `minutesElapsed: -141`. A negative age is at least visibly absurd; the real
 * danger is the silent half of it — an order genuinely 3 hours late reads as
 * 3 minutes old and never enters the queue at all.
 *
 * So the offset is applied EXPLICITLY rather than trusting `TZ`. Returns NaN
 * for anything unparseable, which callers skip.
 */
export function parseYijiTimestamp(raw: string | null | undefined): number {
  const text = String(raw ?? '').trim();
  if (!text) return Number.NaN;
  // Already zoned (`Z` or `+03:00`)? Then it means what it says.
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) return Date.parse(text);
  // Naked: parse the wall clock as UTC, then subtract Riyadh's offset.
  const asUtc = Date.parse(`${text}Z`);
  return Number.isFinite(asUtc) ? asUtc - RIYADH_OFFSET_MS : Number.NaN;
}

/**
 * How long an order has been running, in whole minutes.
 *
 * Never negative: a clock disagreement between Yiji and us must not produce an
 * order that is "-141 minutes late", which is both nonsense on screen and
 * sorts to the bottom of a list ordered by lateness.
 */
export function minutesSince(placedAt: string | null | undefined, now: number): number | null {
  const started = parseYijiTimestamp(placedAt);
  if (!Number.isFinite(started)) return null;
  return Math.max(0, Math.floor((now - started) / 60_000));
}

/**
 * Yiji order statuses that mean the order is STILL RUNNING.
 *
 * `GetFilteredOrders` answers with finished and cancelled orders too — a
 * `force_cancel` at 3.1 minutes came back under a 60-minute filter — so the
 * live set is filtered our side. Measured 2026-09-21.
 *
 * Names from `YIJI_ORDER_STATUS`: received(2), finding_driver(3),
 * driver_accepted(4), in_kitchen(5), ready_to_pickup(7), in_delivery(8),
 * arrived(65).
 */
export const LIVE_ORDER_STATUSES = [2, 3, 4, 5, 7, 8, 65] as const;

/** Yiji `DeliveryType` for a delivery order (as opposed to pickup/carhop). */
export const YIJI_DELIVERY_TYPE_DELIVERY = 1;

export function isLiveOrderStatus(status: number | null | undefined): boolean {
  return status != null && (LIVE_ORDER_STATUSES as readonly number[]).includes(status);
}

/**
 * How the agent classified the delay.
 *
 * Manual (owner, 2026-09-21): the two values are obvious to whoever is looking
 * at the order, and a wrong automatic answer is worse than none. The status
 * history WOULD support classifying this — see docs/LATE-DELIVERY.md — so this
 * stays a closed set rather than free text, and prefilling it later is a small
 * change.
 */
export const LateOrderKind = z.enum(['late_delivery', 'late_preparation']);
export type LateOrderKind = z.infer<typeof LateOrderKind>;

/**
 * The ticket type raised for each kind.
 *
 * Both are EXISTING values in the live `option_lists` (verified against
 * production 2026-09-21) — no data change, no new type. The stored spellings
 * are operations' own and must not be "fixed": `Instore preparation late
 * order` is displayed as "Late preparation in store" by the portal's DISPLAY
 * map, and correcting the stored value here would split the category in two
 * across old and new rows.
 */
export const LATE_ORDER_COMPLAINT_TYPE: Record<LateOrderKind, string> = {
  late_delivery: 'Late order',
  late_preparation: 'Instore preparation late order',
};

/** What the agent did with a late order. */
export const LateOrderAction = z.enum(['ignored', 'compensated']);
export type LateOrderAction = z.infer<typeof LateOrderAction>;

/**
 * One row in the late-orders queue: a live delivery order past the threshold.
 *
 * `minutesElapsed` is computed server-side against the gateway's clock, NOT in
 * the browser. A phone or laptop with a skewed clock would otherwise disagree
 * with the queue it is reading, and "how late is this" is the one number the
 * whole screen is about.
 */
export interface LateOrderRow {
  orderId: string;
  status: string;
  /** Minutes since the order was created, at the moment the queue was built. */
  minutesElapsed: number;
  placedAt: string;
  brandName?: string;
  restaurantName?: string;
  restaurantId?: string;
  customerName?: string;
  customerPhone?: string;
  total?: number;
  /** Yiji's own customer id, when the row carried one — for the coupon push. */
  externalCustomerId?: string;
}

export interface LateOrderQueue {
  rows: LateOrderRow[];
  /** The threshold this queue was built with, so the UI states the real rule. */
  thresholdMinutes: number;
  /** When the gateway built it — the basis for every `minutesElapsed`. */
  builtAt: string;
}

/**
 * A decision recorded against a late order.
 *
 * `reason` is required for BOTH actions (owner, 2026-09-21): ignoring is a
 * decision somebody has to stay answerable for, exactly like compensating.
 */
export const LateOrderDecision = z.object({
  orderId: z.string().min(1),
  kind: LateOrderKind,
  action: LateOrderAction,
  reason: z.string().trim().min(1, 'A reason is required.'),
});
export type LateOrderDecision = z.infer<typeof LateOrderDecision>;
