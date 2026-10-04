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
/**
 * A late-order CAUSE, spelled out for a reader.
 *
 * Operations add causes to an editable list, so the seeded two are not the
 * whole set and a hardcoded map would print a raw enum for anything new —
 * `late_preparation` rather than "Late preparation". Callers try
 * `lateOrders.kind.<value>` first and fall back to this, which turns any value
 * into something readable without anyone editing code.
 *
 * SHARED, because it was written twice: once in the admin register and once on
 * the way to the agent portal's ticket card. Two copies of a display rule drift,
 * and the two screens are meant to read the same.
 */
export function causeLabel(value: string): string {
  const spaced = value.replace(/_/g, ' ').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : value;
}

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
 * WHO OWNS THE CAUSE, and therefore what the decision produces.
 *
 * The pipeline used to be decided by the VALUE — `late_preparation` raised a
 * ticket, `late_delivery` did not — which meant a third cause could not be
 * added without editing code (owner, 2026-09-29).
 *
 *   wecare      a compensation only. The delay is WeCare's to answer, and no
 *               complaint is filed against a branch.
 *   operations  a compensation AND a ticket, so the branch it names sees it in
 *               the breakdown report and owns the fix.
 *
 * This is why the split matters beyond bookkeeping: an `operations` cause
 * SHARES the case with that department, and a `wecare` one deliberately does
 * not (owner, 2026-09-29 — late delivery must stay inside WeCare).
 */
export const LateOrderGroup = z.enum(['wecare', 'operations']);
export type LateOrderGroup = z.infer<typeof LateOrderGroup>;

/** The list in `option_lists` that holds the causes. */
export const LATE_ORDER_CAUSE_LIST = 'late_order_cause';

/**
 * The two causes that existed before the list was made editable.
 *
 * Kept as the SEEDED rows, with their stored keys unchanged: every decision
 * and every report row already carries `late_delivery` / `late_preparation`,
 * and renaming them would orphan all of it.
 */
export const DEFAULT_LATE_ORDER_CAUSES: ReadonlyArray<{
  value: LateOrderKind;
  group: LateOrderGroup;
}> = [
  // No ticket: WeCare answers a late delivery themselves.
  { value: 'late_delivery', group: 'wecare' },
  // A ticket as well: the branch prepared it late and has to see it.
  { value: 'late_preparation', group: 'operations' },
];

/**
 * Does this cause raise a ticket?
 *
 * The ONE place that answers it. Defaults to `wecare` — the quieter outcome —
 * for a cause whose group cannot be read, so a misconfigured row cannot start
 * filing complaints against branches on its own.
 */
export function causeRaisesTicket(group: string | null | undefined): boolean {
  return group === 'operations';
}

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
export const LATE_ORDER_COMPLAINT_TYPE: Record<string, string> = {
  late_delivery: 'Late order',
  late_preparation: 'Instore preparation late order',
};

/**
 * The complaint type a cause files under.
 *
 * The map above covers the two causes that shipped in code. A cause ADDED to
 * the list has no entry, and falling back to `undefined` would write a ticket
 * with no `complaint_type` — which the breakdown report counts as incomplete
 * and flags, exactly the silent gap this codebase keeps producing.
 *
 * So a new cause files under its own stored name. Operations see the value they
 * typed rather than a blank, and can add it to `complaint_type` themselves if
 * they want it grouped with an existing category.
 */
export function lateOrderComplaintType(cause: string): string {
  return LATE_ORDER_COMPLAINT_TYPE[cause] ?? cause;
}

/** What the agent did with a late order. */
/**
 * What was recorded against a late order.
 *
 * `ignored` IS GONE (owner, 2026-09-29). It was an action that filed a decision
 * saying nothing had been done, which is not a decision at all — the customer
 * had received nothing. It is replaced by `commented`: somebody looked, wrote
 * down what they found, and left the order open for a coupon.
 *
 * The one historical `ignored` row on production carried a real reason ("bank
 * issue") and was MIGRATED to `commented`, so the value is not kept as a legacy
 * spelling. Nothing reads it any more.
 */
export const LateOrderAction = z.enum(['commented', 'compensated']);
export type LateOrderAction = z.infer<typeof LateOrderAction>;

/**
 * HOW FAR ALONG A LATE ORDER IS — NOT the order's own status (owner,
 * 2026-09-29).
 *
 * These are two different things and must never be mixed: an order can be
 * `delivered` or `force_closed` upstream and still be `pending` here, because
 * nobody at WeCare has touched it yet.
 *
 *   pending    nothing done: no comment, no coupon.
 *   commented  somebody wrote down what they found, and left it there. A
 *              comment is NOT a resolution — the customer has had nothing.
 *   handled    a coupon was assigned. Only this closes it.
 *
 * `ignored` is retired from the vocabulary: "Ignore" was an action that filed a
 * decision saying nothing had been done, which is what `pending` and
 * `commented` now express honestly. Existing `ignored` rows are READ as
 * `commented` — somebody did look at them and wrote a reason — so no history is
 * rewritten and no row disappears from a report.
 *
 * Deliberately NOT called "open": that word already means an open TICKET in
 * this codebase, and one of these sitting beside the other would be read as the
 * same thing.
 */
export const LateOrderState = z.enum(['pending', 'commented', 'handled']);
export type LateOrderState = z.infer<typeof LateOrderState>;

/**
 * What state a late order is in, from whatever is recorded against it.
 *
 * ONE function, so the queue, the register and the summary can never disagree
 * about what "handled" means.
 *
 * The COUPON decides `handled` — not the decision's `action` column. A decision
 * is written the moment the coupon request is created, and a request that was
 * later rejected is not a compensation; asking about the coupon keeps the two
 * honest.
 */
export function lateOrderState(
  decision:
    | {
        action?: string | null;
        reason?: string | null;
      }
    | null
    | undefined,
): LateOrderState {
  if (!decision) return 'pending';
  if (decision.action === 'compensated') return 'handled';
  /* Anything else recorded means somebody looked and wrote something down. A
     row with no reason has nothing to show anybody, so it is still pending. */
  return decision.reason?.trim() ? 'commented' : 'pending';
}

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
  /**
   * How long the order ran, in whole minutes.
   *
   * For a LIVE order this is minutes-so-far, and it keeps growing. For a
   * finished one the clock stops at `orderStatusDate` — otherwise a closed
   * order from three weeks ago reports 43,651 minutes, which is how long ago
   * it happened rather than how late it was.
   */
  minutesElapsed: number;
  /** False once the order finished, so the UI can stop implying it is running. */
  live?: boolean;
  placedAt: string;
  brandName?: string;
  restaurantName?: string;
  restaurantId?: string;
  customerName?: string;
  customerPhone?: string;
  total?: number;
  /** Yiji's own customer id, when the row carried one — for the coupon push. */
  externalCustomerId?: string;
  /**
   * When a FINISHED order reached its final status (`orderStatusDate`).
   *
   * Carried so the client can measure SERVICE TIME — driver-accept to close —
   * without a second call for the half of the sum it already has. Absent on a
   * live order, which has not closed yet and is measured against now instead.
   */
  closedAt?: string;
}

/**
 * SERVICE TIME: how long the DRIVER leg took.
 *
 * Deliberately not `minutesElapsed`, which runs from when the order was PLACED
 * and therefore includes kitchen preparation. The owner's rule (2026-09-27):
 *
 *   closed order  →  closed time − driver-accept time
 *   live order    →  now − driver-accept time
 *
 * `null` when the driver has not accepted yet — there is no service to time, and
 * a zero there would read as "instant" rather than "not started".
 */
export function serviceMinutes(
  driverAcceptedAt: string | null | undefined,
  closedAt: string | null | undefined,
  now: number,
): number | null {
  const started = parseYijiTimestamp(driverAcceptedAt);
  if (!Number.isFinite(started)) return null;
  const ended = closedAt ? parseYijiTimestamp(closedAt) : now;
  const end = Number.isFinite(ended) ? ended : now;
  return Math.max(0, Math.floor((end - started) / 60_000));
}

/**
 * THE FOUR ORDER TIMES, from the status history (owner, 2026-09-29).
 *
 * All four are computed from `OrderStatusHistories` — the real transitions with
 * their timestamps — rather than from the order row's `orderStatusDate`, which
 * is only ever the CURRENT status's moment.
 *
 * That distinction is the bug this replaces. Order 1323407 was `closed` at
 * 17:30:39 and then `force_closed` at 22:31:24, five hours later; reading
 * `orderStatusDate` gave a service time of 365 minutes where the truth is 64.
 *
 * CLOSED ALWAYS WINS over force-closed when both exist — a force-close after a
 * close is bookkeeping, not delivery.
 *
 * Each returns null rather than 0 when its events are missing: a blank cell
 * says "not known", and a zero would read as "instant".
 */
export interface OrderEventTimes {
  /** Driver accepted → closed (force-closed only if there is no close). */
  serviceMinutes: number | null;
  /** Driver accepted → arrived (in-delivery when there is no arrival). */
  driverArrivalMinutes: number | null;
  /** In-delivery → closed. */
  deliveryMinutes: number | null;
  /** POS accepted → ready-to-pickup (in-delivery when there is no ready). */
  preparationMinutes: number | null;
}

/** A status history flattened to `status -> first timestamp`. */
export type OrderEventAt = Readonly<Record<string, string | null | undefined>>;

function minutesBetween(from: string | null | undefined, to: string | null | undefined) {
  if (!from || !to) return null;
  const a = parseYijiTimestamp(from);
  const b = parseYijiTimestamp(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  /* Never negative: events can arrive out of order, and a negative duration is
     worse than an absent one — it reads as a real measurement. */
  return Math.max(0, Math.floor((b - a) / 60_000));
}

export function orderEventTimes(at: OrderEventAt, now?: number): OrderEventTimes {
  /* CLOSED FIRST. `force_closed` is the fallback, never the preference. */
  const finished = at.closed ?? at.force_closed ?? null;

  /* A live order has not finished, so its service time runs to NOW — that is
     what makes the column tick on the queue. A finished one is fixed. */
  const serviceEnd = finished
    ? parseYijiTimestamp(finished)
    : typeof now === 'number'
      ? now
      : Number.NaN;
  const accepted = at.driver_accepted ? parseYijiTimestamp(at.driver_accepted) : Number.NaN;
  const serviceMinutes =
    Number.isFinite(accepted) && Number.isFinite(serviceEnd)
      ? Math.max(0, Math.floor((serviceEnd - accepted) / 60_000))
      : null;

  return {
    serviceMinutes,
    // Arrived when there is one; otherwise the moment it went out for delivery.
    driverArrivalMinutes: minutesBetween(at.driver_accepted, at.arrived ?? at.in_delivery),
    deliveryMinutes: minutesBetween(at.in_delivery, finished),
    // Ready-to-pickup when there is one; otherwise it left the kitchen when it
    // went out for delivery.
    preparationMinutes: minutesBetween(at.pos_accepted, at.ready_to_pickup ?? at.in_delivery),
  };
}

/** The Yiji status whose timestamp is the driver-accept moment. */
export const YIJI_STATUS_DRIVER_ACCEPTED = 4;

export interface LateOrderQueue {
  rows: LateOrderRow[];
  /** The threshold this queue was built with, so the UI states the real rule. */
  thresholdMinutes: number;
  /** When the gateway built it — the basis for every `minutesElapsed`. */
  builtAt: string;
}

/**
 * Which late orders to fetch.
 *
 * Empty = the LIVE queue for today, which is the screen's default and the
 * thing the feature is for.
 */
export interface LateOrderQueryOptions {
  /** `YYYY-MM-DD`, inclusive. Defaults to today. */
  from?: string;
  /** `YYYY-MM-DD`, INCLUSIVE — the impl adds the exclusive day itself. */
  to?: string;
  /**
   * Include orders that have already finished.
   *
   * Required for any historical view. Of 631 late orders in the last month,
   * ZERO were still running (measured 2026-09-21) — so history without this
   * renders empty, which reads as "nothing was ever late" rather than "these
   * all finished".
   */
  includeCompleted?: boolean;
  /** Pages of 500 to walk. 1 (the default) is the live queue; a month needs 3. */
  maxPages?: number;
}

/** The widest window the UI offers, in days. A month is what operations review. */
export const LATE_ORDER_MAX_WINDOW_DAYS = 31;

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

/**
 * THE BUSINESS DAY: 08:00 → 04:00 the next morning, named after the day it
 * STARTED (owner, 2026-09-27).
 *
 * Trading runs past midnight, so the calendar date splits one night's work in
 * two: orders at 23:50 and 00:10 belong to the same shift and the same
 * reporting row, and a `date_created` cut files them a day apart.
 *
 * GAPLESS, BY DECISION. The stated window leaves 04:00–08:00 unclaimed, and
 * the owner's rule is that those hours belong to the day that just ENDED
 * (2026-09-27). So the boundary is a single instant — 08:00 — and every order
 * lands in exactly one business day:
 *
 *   Tue 07:59  →  Monday    (the tail of Monday's night)
 *   Tue 08:00  →  Tuesday   (Tuesday opens)
 *   Wed 03:59  →  Tuesday   (still Tuesday's night)
 *   Wed 06:00  →  Tuesday   (the 04:00–08:00 tail)
 *
 * Without that, "how many late orders on Tuesday" and "how many late orders
 * in total" stop reconciling, which is the failure the whole report exists to
 * avoid.
 *
 * RIYADH LOCAL, like every other Yiji timestamp — see `parseYijiTimestamp`.
 * The boundary is a wall-clock hour in the branch's own day, so it has to be
 * evaluated in Riyadh's zone, never the container's.
 */
export const BUSINESS_DAY_START_HOUR = 8;

/**
 * The business day an instant belongs to, as `YYYY-MM-DD`.
 *
 * `null` when the timestamp cannot be read — an unparseable stamp has no day,
 * and inventing one would file the order under a date nobody can trace.
 */
export function businessDay(raw: string | null | undefined): string | null {
  const ms = parseYijiTimestamp(raw);
  if (!Number.isFinite(ms)) return null;
  // Shift into Riyadh wall-clock, then roll back so the day turns at 08:00
  // rather than midnight. Both offsets are applied to the same value, so the
  // arithmetic never depends on the host's zone.
  const riyadh = ms + RIYADH_OFFSET_MS;
  const shifted = riyadh - BUSINESS_DAY_START_HOUR * 60 * 60 * 1000;
  return new Date(shifted).toISOString().slice(0, 10);
}

/**
 * The CALENDAR dates a business day touches, as `{ from, to }`.
 *
 * Yiji's `GetFilteredOrders` filters on calendar dates only — there is no way
 * to ask it for "08:00 Saturday to 04:00 Sunday". A business day therefore
 * spans TWO calendar dates, and asking for one of them loses half the night:
 * request only Saturday and every order after midnight is missing.
 *
 * So the caller asks for both and narrows per row with `businessDay()`, which
 * is the only thing that knows where the boundary actually falls. Widening the
 * upstream window is cheap; getting the boundary wrong is silent.
 *
 * `2026-09-28` → `{ from: '2026-09-28', to: '2026-09-29' }`.
 */
export function businessDayRange(day: string): { from: string; to: string } {
  const start = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(start)) return { from: day, to: day };
  return { from: day, to: new Date(start + 24 * 60 * 60 * 1000).toISOString().slice(0, 10) };
}

/* ───────────────────────────────────────────────────────────────────────────
 * THE LATE-ORDER REGISTER
 *
 * A pending late order has NO DATABASE ROW: it exists only in Yiji's live
 * queue until somebody comments on it or grants a coupon. So the register is
 * always a MERGE of two sources, and `mergeLateOrders` is the one place that
 * knows how.
 *
 * It lives here rather than in either portal because BOTH show this register
 * and a second implementation is how they drift — which is exactly what
 * happened: the admin report merged, the user portal did not, and a decided
 * order vanished from one screen while sitting plainly on the other.
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * The stored order copy, as much of it as the late-order screens read.
 *
 * SHARED, because BOTH portals show this register and they must agree about
 * what an order was. It used to live in the admin portal alone, which is how
 * the user portal ended up showing only the live Yiji queue and losing every
 * decided order the moment Yiji stopped returning it (ops, 2026-10-03).
 *
 * A narrow view on purpose: the full `TicketOrderSnapshot` lives in the agent
 * portal and would drag that app's commerce client in with it.
 *
 * Every field optional, because a snapshot is a point-in-time copy of whatever
 * Yiji answered: an order with no address, no payment mode or no items is a
 * real order, not a malformed row.
 */
export interface LateOrderSnapshot {
  orderId?: string | null;
  status?: string | null;
  total?: number | null;
  currency?: string | null;
  placedAt?: string | null;
  items?: Array<{
    sku?: string | null;
    name?: string | null;
    /** How many. Absent means one — see `snapshotLines`. */
    qty?: number | null;
    /** The price of ONE. The LINE is `qty * price`. */
    price?: number | null;
    category?: string | null;
  }> | null;
  brandName?: string | null;
  restaurantName?: string | null;
  restaurantId?: string | null;
  deliveryType?: string | null;
  deliveryAddress?: string | null;
  paymentStatus?: string | null;
  paymentMode?: string | null;
  /**
   * The customer, captured with the order.
   *
   * This is where the report's "Customer mobile" column comes from. It read
   * `customer_phone` off the decision row, which has no such field, so the
   * column was permanently blank — the snapshot shaper had been dropping Yiji's
   * `customerPhoneNumber` (owner, 2026-10-01). Stored canonical `05…`.
   */
  customerPhone?: string | null;
  customerName?: string | null;
  /** When the copy was taken — what makes it a snapshot rather than a claim. */
  capturedAt?: string | null;
}

export interface LateOrderDecisionRow {
  id: string;
  order_id: string | null;
  kind: LateOrderKind | null;
  action: 'commented' | 'compensated' | null;
  reason: string | null;
  /**
   * What the agent DID about it — the Comments box's second field.
   *
   * OPTIONAL, because every decision recorded before 2026-09-27 predates the
   * field and genuinely has nothing to show. A required type here would be a
   * claim the data does not support.
   */
  action_taken?: string | null;
  /**
   * The ORDER AS IT STOOD when the agent decided.
   *
   * Written by the agent portal on every decision — comment and compensation
   * alike — from the same `orderToSnapshot` the tickets path uses, so there is
   * one idea of what an order snapshot is rather than two that drift.
   *
   * Read here rather than re-fetched, deliberately. A coupon is judged against
   * what the customer actually received on the day, and Yiji keeps mutating an
   * order afterwards — order 1323407 gained a `force_closed` five hours after
   * its `closed`. Asking Yiji again months later would answer a different
   * question, and would cost one call per row on a report that can hold
   * thousands.
   *
   * NULL is normal and must render as such: a pending order has no decision, so
   * nothing was ever captured, and a handful of rows predate the column.
   */
  order_snapshot?: LateOrderSnapshot | null;
  minutes_elapsed: number | null;
  brand_name: string | null;
  restaurant_name: string | null;
  date_created: string | null;
  decided_by: { id: string; first_name: string | null; last_name: string | null } | null;
  ticket: { id: string } | null;
}

/**
 * A late order as the register shows it: decided or not.
 *
 * A PENDING late order has NO DATABASE ROW — it exists only in Yiji's queue
 * until somebody comments on it or gives a coupon (owner, 2026-09-29). So the
 * register is a MERGE of two sources, and a row can come from either.
 */
export interface LateOrderRegisterRow extends Omit<LateOrderDecisionRow, 'id'> {
  /** The decision's id, or a synthetic one for a queue-only row. */
  id: string;
  /** pending | commented | handled — never the ORDER's own status. */
  state: LateOrderState;
  /** The order's own status from Yiji — a different thing entirely. */
  order_status?: string | null;
  customer_phone?: string | null;
  /** True when nothing has been recorded: the row is queue-only. */
  pendingOnly: boolean;
  /**
   * WHEN THE ORDER WAS PLACED, as opposed to when it was decided.
   *
   * `date_created` means different things on the two kinds of row — the
   * decision's time on a decided one, the order's on a pending one — and the
   * register's "Creation time" column needs the ORDER's, always (EMA-26). Kept
   * beside `date_created` rather than overwriting it: the decision date is real
   * data that the agent and acted-on columns legitimately report.
   */
  order_placed_at?: string | null;
}

/**
 * Merge the live queue with what has been decided.
 *
 * DECISIONS WIN. An order that has been commented on or compensated is
 * described by its decision; the queue only supplies the orders nobody has
 * touched. Merged on `orderId`, the one identifier both sides share.
 *
 * The queue is the source for a pending row's branch, brand, phone and ORDER
 * STATUS — which is not the handling state and must never be confused with it.
 *
 * Exported so the tests exercise the real rule.
 */
export function mergeLateOrders(
  decisions: readonly LateOrderDecisionRow[],
  queue: readonly LateOrderRow[],
): LateOrderRegisterRow[] {
  const decided = new Set<string>();
  const out: LateOrderRegisterRow[] = [];

  /* The live queue, by order, so a decided row can still answer "whose order
     was this?" — see `customer_phone` below. */
  const queueByOrder = new Map(queue.map((q) => [q.orderId?.trim() ?? '', q]));

  for (const d of decisions) {
    const key = d.order_id?.trim();
    if (key) decided.add(key);
    out.push({
      ...d,
      state: lateOrderState(d),
      pendingOnly: false,
      /*
       * WHEN THE ORDER WAS PLACED — which is NOT when it was decided.
       *
       * Reported by operations (EMA-26, 2026-10-04): *"the Order Creation Date
       * currently changes based on the selected date range. The actual order
       * creation date should remain fixed and accurate."*
       *
       * It was never the range doing it. A DECIDED row spreads `...d`, so its
       * `date_created` is the DECISION's — when an agent acted — while a
       * PENDING row takes `q.placedAt`, the order's own time. One column,
       * labelled "Creation time", showing two different facts depending on
       * whether anybody had touched the row yet. Widening the range pulls in
       * decisions taken on other days, so the dates appear to move.
       *
       * Measured on staging: order 1323103 was placed 2026-09-28 and shows
       * 2026-10-04, the day it was compensated — six days out.
       *
       * The SNAPSHOT first: it is what the order was when the decision was
       * taken, and it is immutable. The live queue second, for a decision made
       * before snapshots captured `placedAt`. Null last, and the column falls
       * back to the decision date rather than rendering a blank — a dash where
       * a date belongs reads as missing data, and the decision date is at least
       * an upper bound on when the order existed.
       */
      order_placed_at:
        d.order_snapshot?.placedAt?.trim() ||
        (key ? (queueByOrder.get(key)?.placedAt ?? null) : null) ||
        null,
      /*
       * THE CUSTOMER'S NUMBER, WHICH A DECIDED ROW NEVER CARRIED.
       *
       * `late_order_decisions` has no phone column, so spreading the row left
       * `customer_phone` undefined and the report's "Customer mobile" column
       * was blank on every decided order — while pending rows, which take it
       * from the live queue, showed one (owner, 2026-10-01).
       *
       * The SNAPSHOT first: it is what the order was when the decision was
       * made, which is the honest answer for a historical row. The live queue
       * second, so a decision taken before the snapshot captured a phone still
       * shows one while the order remains in the window.
       */
      customer_phone:
        d.order_snapshot?.customerPhone?.trim() ||
        (key ? (queueByOrder.get(key)?.customerPhone ?? null) : null) ||
        null,
    });
  }

  for (const q of queue) {
    const key = q.orderId?.trim();
    /* Already answered for. The decision describes it, not the queue. */
    if (!key || decided.has(key)) continue;
    out.push({
      /* Synthetic and PREFIXED, so it can never collide with a decision's uuid
         and so anything keying off it is obviously not a decision. */
      id: `pending:${key}`,
      order_id: key,
      /* Unclassified until somebody says otherwise — the cause is a judgement
         an agent makes, not something the queue knows. */
      kind: null,
      action: null,
      reason: null,
      action_taken: null,
      minutes_elapsed: q.minutesElapsed ?? null,
      brand_name: q.brandName ?? null,
      restaurant_name: q.restaurantName ?? null,
      /* The ORDER's creation time. A pending row has no decision, so there is
         no decision time to show — and dating it "now" would put every pending
         order at the top of a report sorted by when things happened. */
      date_created: q.placedAt ?? null,
      /* A pending row has no decision, so the two are the same time — but it
         is still stated, so every row in the register answers "when was this
         order placed?" from one field. */
      order_placed_at: q.placedAt ?? null,
      decided_by: null,
      ticket: null,
      /* NULL, and that is the truth rather than a gap: nobody has acted on this
         order, so no snapshot was ever captured. The panel says so. */
      order_snapshot: null,
      state: 'pending',
      order_status: q.status ?? null,
      customer_phone: q.customerPhone ?? null,
      pendingOnly: true,
    });
  }

  /* Newest first, like the decisions query — one ordering for the whole
     register rather than decisions first and pending appended. */
  return out.sort((a, b) => (b.date_created ?? '').localeCompare(a.date_created ?? ''));
}

/** Exactly what rebuilding a queue row needs from a recorded decision. */
export interface DecidedOrderSource {
  order_id: string | null;
  minutes_elapsed?: number | null;
  brand_name?: string | null;
  restaurant_name?: string | null;
  date_created?: string | null;
  order_snapshot?: LateOrderSnapshot | null;
}

/**
 * A DECIDED ORDER THAT YIJI NO LONGER RETURNS, in the queue's own shape.
 *
 * The late-orders QUEUE is live: Yiji answers with orders currently past the
 * threshold, and an order drops out of that answer once it is old enough. The
 * decision we recorded against it does not drop out — it is a row in our own
 * database for ever.
 *
 * So a screen that renders only the queue loses its own history. Operations
 * reported exactly that (2026-10-03): the user portal showed "no data for
 * yesterday or the day before", while the same orders sat plainly in the admin
 * register, which merges the two sources.
 *
 * `mergeLateOrders` above is the full answer and returns the REGISTER shape.
 * This is the other direction, for a screen already built around `LateOrderRow`:
 * it rebuilds a queue-shaped row from what the decision captured, so the two
 * lists can simply be concatenated. Nothing is invented — every field comes
 * from the snapshot taken when the agent decided, or from the decision's own
 * columns, and anything neither holds is left undefined rather than guessed.
 *
 * ORDERS STILL IN THE QUEUE ARE NOT DUPLICATED: the live row wins, because it
 * is current and the snapshot is a copy of one moment.
 */
export function decidedOrdersAsQueueRows(
  /*
   * STRUCTURAL, not the register's row type.
   *
   * The two portals select different columns from `late_order_decisions` and
   * declare their own narrower rows for what they asked for. Demanding the full
   * register row here would force a caller to claim fields its query never
   * fetched. This asks for exactly what a queue row is rebuilt FROM, so a
   * caller missing any of it fails to compile rather than silently rendering a
   * row of zeroes.
   */
  decisions: ReadonlyArray<DecidedOrderSource>,
  queue: ReadonlyArray<LateOrderRow>,
): LateOrderRow[] {
  const live = new Set(queue.map((q) => q.orderId?.trim()).filter(Boolean));
  const seen = new Set<string>();
  const out: LateOrderRow[] = [];

  for (const d of decisions) {
    const id = d.order_id?.trim();
    /* No id, already on screen, or already rebuilt from a newer decision for
       the same order — the decisions query returns newest first. */
    if (!id || live.has(id) || seen.has(id)) continue;
    seen.add(id);

    const s = d.order_snapshot ?? null;
    out.push({
      orderId: id,
      /* The order's OWN status, as captured. Unknown is honest: the column the
         status filter reads must not claim a state nobody recorded. */
      status: s?.status ?? '',
      /* How late it was, from the decision. The queue recomputes this against
         the gateway clock for a live order; a finished one has a fixed answer
         and this is it. */
      minutesElapsed: d.minutes_elapsed ?? 0,
      /* Not live by definition — it is no longer in the queue. The UI uses this
         to stop implying the clock is still running. */
      live: false,
      /*
       * WHEN THE ORDER WAS PLACED, not when the decision was taken.
       *
       * The business-day cut keys on this, so using the decision time would
       * file an order under the night somebody got round to looking at it.
       * Falls back to the decision time only when the snapshot predates the
       * field, which is better than dropping the row entirely.
       */
      placedAt: s?.placedAt ?? d.date_created ?? '',
      ...(s?.brandName?.trim() || d.brand_name
        ? { brandName: (s?.brandName?.trim() || d.brand_name) ?? undefined }
        : {}),
      ...(s?.restaurantName?.trim() || d.restaurant_name
        ? { restaurantName: (s?.restaurantName?.trim() || d.restaurant_name) ?? undefined }
        : {}),
      ...(s?.restaurantId ? { restaurantId: s.restaurantId } : {}),
      ...(s?.customerName ? { customerName: s.customerName } : {}),
      ...(s?.customerPhone ? { customerPhone: s.customerPhone } : {}),
      ...(typeof s?.total === 'number' ? { total: s.total } : {}),
    });
  }
  return out;
}
