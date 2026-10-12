import type { LateOrderRow } from './late-delivery.js';
import type { VendorConnector } from './connector.js';

/**
 * THE LIVE LATE-ORDERS SNAPSHOT (owner, 2026-10-12: "Yiji's load must not
 * depend on how many screens are open").
 *
 * Before this, every screen on the Late orders page polled the ai-gateway, and
 * the gateway asked Yiji `GetFilteredOrders` behind a 60 s cache. The cache
 * kept it to one call a minute PER CACHE KEY - but the key held the vendor,
 * the dates and the threshold, so an old bundle, a second vendor or a screen
 * across the 08:00 rollover each bought their own call, and the whole thing
 * ran all day whether or not anybody was looking.
 *
 * Now ONE poller in the workers asks Yiji once a minute per vendor that a
 * screen is actually watching, stores the answer here, and tells the screens
 * when it changed. The gateway answers a live request from the snapshot and
 * only falls back to Yiji when the snapshot is missing or stale.
 *
 * The pieces that BOTH sides must agree on live in this file, so the writer
 * (workers) and the reader (ai-gateway) cannot drift: the key names, the
 * exact Yiji query, the row filter, the change hash and the freshness rule.
 * Redis keys are namespaced by the caller (`envKey` in shared-config), because
 * staging and production share one cluster.
 */

/** One vendor's snapshot of today's live queue. */
export interface LateOrdersSnapshot {
  /** Same three fields the gateway's `/commerce/late-orders` has always returned. */
  rows: LateOrderRow[];
  thresholdMinutes: number;
  /** When the poller fetched it from the platform (NOT when it was read). */
  builtAt: string;
  /** The business day (`YYYY-MM-DD`) it was fetched for. */
  day: string;
  /** `lateOrdersRowsHash(rows)` - what change detection compares. */
  hash: string;
  /** `platform:platformVendorId` - see `lateOrdersVendorKey`. */
  vendorKey: string;
}

/**
 * Who is watching, per vendor: the HASH the gateway writes on every live
 * request and the poller reads once a minute.
 *
 * Demand-driven rather than "every active vendor" for two reasons:
 *  - the THRESHOLD lives in `app_settings`, which the gateway can read and
 *    `svc-workers` cannot (no permission change was allowed for this), so the
 *    gateway hands it over with the demand;
 *  - nobody watching means nobody needs the queue, so Yiji is not asked at all
 *    overnight or on a day nobody opens the page.
 *
 * ONE hash key, not a key per vendor, so the poller never has to SCAN - a SCAN
 * on a Redis Cluster only sees one node.
 */
export const LATE_ORDERS_DEMAND_KEY = 'late-orders:demand';
/** Single-instance guard for one poll (see the workers' poller). */
export const LATE_ORDERS_POLL_LOCK_KEY = 'late-orders:poll-lock';
/** The snapshot key suffix for one vendor. */
export const lateOrdersSnapshotKey = (vendorKey: string): string =>
  `late-orders:snapshot:${vendorKey}`;

/** A demand entry: the threshold the screen was asking with, and when. */
export interface LateOrdersDemand {
  thresholdMinutes: number;
  /** Epoch ms of the last live request. */
  at: number;
}

/**
 * How long one request keeps the poller asking for that vendor. Ten minutes:
 * longer than the portal's slowest safety-net poll (2 min) by a wide margin,
 * so an open screen never lets its demand lapse, and short enough that a
 * closed page stops costing Yiji calls within minutes.
 */
export const LATE_ORDERS_DEMAND_TTL_MS = 10 * 60_000;
/**
 * How old a snapshot may be and still be served. The poller writes one a
 * minute; three minutes tolerates a slow Yiji answer or one failed poll, and
 * past it the gateway asks Yiji itself rather than show a queue going stale.
 */
export const LATE_ORDERS_SNAPSHOT_MAX_AGE_MS = 3 * 60_000;

/**
 * The canonical vendor key: `platform:platformVendorId`.
 *
 * Requests name a vendor by CRM UUID, by `yiji_vendor_id`, or not at all (an
 * old bundle = the legacy vendor). All three resolve to the same connector,
 * and keying by the CONNECTOR'S vendor makes them share one snapshot instead
 * of three.
 */
export function lateOrdersVendorKey(connector: Pick<VendorConnector, 'platform' | 'vendor'>) {
  return `${connector.platform}:${connector.vendor.platformVendorId}`;
}

/**
 * The exact Yiji query for today's live view - the one the portal's Today /
 * Live view makes (`from = to = the current business day`, `live=1`) and the
 * gateway turns into these options. The poller asks the same question, so a
 * snapshot is byte-for-byte what the fallback path would have fetched.
 */
export function liveLateOrdersQuery(day: string) {
  return { from: day, to: day, includeCompleted: true, maxPages: 200 } as const;
}

/**
 * A LATE order ran past the threshold (owner, 2026-10-11). Yiji's own filter
 * also returned order 1339586, force-cancelled after 9 minutes; an order that
 * never reached the threshold is not late. Shared so the gateway's fallback
 * and the poller drop exactly the same rows.
 */
export function filterLateRows<T extends { minutesElapsed?: unknown }>(
  rows: readonly T[],
  thresholdMinutes: number,
): T[] {
  return rows.filter(
    (r) => !(typeof r.minutesElapsed === 'number' && r.minutesElapsed < thresholdMinutes),
  );
}

/**
 * A fingerprint of what an agent would SEE CHANGE: which orders, their status,
 * live flag, close time, customer and branch.
 *
 * `minutesElapsed` is deliberately LEFT OUT. It grows by one on every live row
 * every minute, so including it would call every poll a change and push a
 * refetch to every screen every minute - the very load this exists to remove,
 * moved one hop inward. Rows are sorted by order id so Yiji's ordering cannot
 * fake a change.
 *
 * FNV-1a, not a crypto hash: this runs in shared code that the browser bundle
 * also imports, and it only has to tell "same" from "different".
 */
export function lateOrdersRowsHash(rows: readonly LateOrderRow[]): string {
  const canon = [...rows]
    .map((r) => {
      const rest: Record<string, unknown> = { ...r };
      delete rest.minutesElapsed;
      return Object.keys(rest)
        .sort()
        .map((k) => [k, rest[k]]);
    })
    .map((entries) => JSON.stringify(entries))
    .sort();
  const text = canon.join('\n');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${rows.length}:${h.toString(16).padStart(8, '0')}`;
}

/**
 * May the gateway answer a live request from this snapshot?
 *
 * Only when it is for the SAME business day, built with the SAME threshold
 * the request is answered with (operations can change it at any minute, and a
 * queue selected by the old rule must not be labelled with the new one), and
 * fresh. Anything else - including a snapshot from the future, which is a
 * clock fault, not a fresh answer - falls back to asking Yiji.
 */
export function isServableLateOrdersSnapshot(
  snap: LateOrdersSnapshot | null | undefined,
  want: { day: string; thresholdMinutes: number; nowMs: number },
  maxAgeMs = LATE_ORDERS_SNAPSHOT_MAX_AGE_MS,
): snap is LateOrdersSnapshot {
  if (!snap || !Array.isArray(snap.rows)) return false;
  if (snap.day !== want.day) return false;
  if (snap.thresholdMinutes !== want.thresholdMinutes) return false;
  const built = Date.parse(snap.builtAt);
  if (!Number.isFinite(built)) return false;
  const age = want.nowMs - built;
  return age >= -5_000 && age <= maxAgeMs;
}
