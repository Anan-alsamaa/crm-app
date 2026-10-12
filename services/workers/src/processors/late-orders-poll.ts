import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import { envKey } from '@yiji/shared-config/redis';
import {
  LATE_ORDERS_DEMAND_KEY,
  LATE_ORDERS_DEMAND_TTL_MS,
  LATE_ORDERS_POLL_LOCK_KEY,
  businessDay,
  filterLateRows,
  lateOrdersRowsHash,
  lateOrdersSnapshotKey,
  lateOrdersVendorKey,
  liveLateOrdersQuery,
  type ConnectorRegistry,
  type LateOrdersDemand,
  type LateOrdersSnapshot,
  type VendorConnector,
} from '@yiji/shared-types';
import { describeError } from '../lib/errors.js';

/**
 * THE LIVE LATE-ORDERS POLLER (owner, 2026-10-12: "option 2").
 *
 * Every open Late orders screen used to poll the ai-gateway, and the gateway
 * asked Yiji `GetFilteredOrders` behind a 60 s cache - so Yiji's load followed
 * the number of screens, cache keys and bundles in the building. This is the
 * ONE place that asks now:
 *
 *   once a minute (a BullMQ job scheduler, so N worker tasks still make one
 *   job), for every vendor a screen asked about in the last ten minutes, fetch
 *   today's queue ONCE, keep it in Redis, and - only when what an agent would
 *   see changed - tell the socket-gateway, which tells every agent's screen to
 *   refetch.
 *
 * The gateway serves that snapshot while it is fresh and falls back to asking
 * Yiji itself when it is not, so a poller that is down, misconfigured or not
 * yet deployed costs freshness of the optimisation, never the queue.
 *
 * WHY DEMAND-DRIVEN: the threshold lives in `app_settings`, which
 * `svc-workers` has no grant on (and this change was not to touch
 * permissions); the gateway reads it on every request and hands it over with
 * the demand. And a vendor nobody is watching costs Yiji nothing.
 */

/** How often the poller runs. `LATE_ORDERS_POLL_MS=0` turns it off. */
export const DEFAULT_LATE_ORDERS_POLL_MS = 60_000;
/** The BullMQ job scheduler id - one per queue, upserted at every start. */
export const LATE_ORDERS_POLL_SCHEDULER = 'late-orders-poll';
/**
 * How long the snapshot key lives. Freshness is judged by `builtAt` (3 min),
 * not by this; the TTL only stops an abandoned vendor's last answer lingering
 * in Redis for ever.
 */
const SNAPSHOT_TTL_SEC = 15 * 60;

/** The Redis calls the poller makes - narrow so tests need no server. */
export interface PollRedis {
  set(key: string, value: string, px: 'PX', ms: number, nx: 'NX'): Promise<unknown>;
  set(key: string, value: string, ex: 'EX', seconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;
  hdel(key: string, ...fields: string[]): Promise<unknown>;
}

export interface LateOrdersChange {
  vendorKey: string;
  builtAt: string;
}

export interface LateOrdersPollDeps {
  redis: PollRedis;
  connectors: Pick<ConnectorRegistry, 'connectorFor'>;
  logger: Pick<Logger, 'info' | 'warn' | 'debug'>;
  /** Tell the screens. Fire-and-forget; absent = screens catch up on their own poll. */
  notify?: (change: LateOrdersChange) => void | Promise<void>;
  now?: () => Date;
  /** The poll interval, for the lock's lifetime. */
  intervalMs?: number;
}

export interface LateOrdersPollResult {
  /** True when another task held the lock and this run did nothing. */
  skipped: boolean;
  polled: string[];
  changed: string[];
  failed: string[];
}

/**
 * Whether this connector would really ask the platform.
 *
 * The workers build their connectors from THEIR env. A Yiji connector with no
 * `YIJI_API_URL` is the in-memory MOCK client, and one without the admin
 * credential answers `[]` for "we cannot ask" - either written as a snapshot
 * would tell every screen that nothing is late. So such a vendor is not
 * polled at all, and the gateway (with its own, real credential) keeps
 * answering it as before.
 */
function canAskPlatform(connector: VendorConnector): boolean {
  if (connector.platform !== 'yiji') return true;
  const settings = connector.settings;
  if (settings.platform !== 'yiji') return false;
  const c = settings.client;
  return Boolean(
    c.apiUrl?.trim() && c.adminApiUrl?.trim() && c.adminEmail?.trim() && c.adminPassword?.trim(),
  );
}

/** Vendors that warned "not configured" once, so the log is not a line a minute. */
const warnedUnconfigured = new Set<string>();

/**
 * ONE poll: lock, read demand, fetch each watched vendor once, store, notify.
 */
export async function runLateOrdersPoll(deps: LateOrdersPollDeps): Promise<LateOrdersPollResult> {
  const { redis, logger } = deps;
  const now = deps.now?.() ?? new Date();
  const result: LateOrdersPollResult = { skipped: false, polled: [], changed: [], failed: [] };

  /*
   * ONLY ONE TASK MAY ASK YIJI PER INTERVAL.
   *
   * The job scheduler already produces one job a minute however many worker
   * tasks run. This lock is the second fence, for the cases a scheduler does
   * not cover: a stalled job re-run while the original is still fetching, or a
   * deploy overlapping two scheduler definitions for a minute. Its lifetime is
   * just under the interval, so the next minute's job always gets it.
   *
   * NO REDIS, NO POLL: unlike the idle-close sweep, nothing is lost by
   * skipping - the gateway falls back to Yiji - so a Redis that cannot take
   * the lock cannot hold the snapshot either.
   */
  const lockMs = Math.max(5_000, (deps.intervalMs ?? DEFAULT_LATE_ORDERS_POLL_MS) - 5_000);
  try {
    const ok = await redis.set(
      envKey(LATE_ORDERS_POLL_LOCK_KEY),
      String(now.getTime()),
      'PX',
      lockMs,
      'NX',
    );
    if (ok !== 'OK') return { ...result, skipped: true };
  } catch (err) {
    logger.warn({ err: describeError(err) }, 'late-orders poll: redis unavailable - skipped');
    return { ...result, skipped: true };
  }

  const day = businessDay(now.toISOString());
  if (!day) return result;

  let demand: Record<string, string>;
  try {
    demand = (await redis.hgetall(envKey(LATE_ORDERS_DEMAND_KEY))) ?? {};
  } catch (err) {
    logger.warn({ err: describeError(err) }, 'late-orders poll: could not read demand');
    return result;
  }

  const expired: string[] = [];
  for (const [vendorKey, raw] of Object.entries(demand)) {
    let want: LateOrdersDemand | null = null;
    try {
      want = JSON.parse(raw) as LateOrdersDemand;
    } catch {
      want = null;
    }
    if (
      !want ||
      typeof want.thresholdMinutes !== 'number' ||
      !Number.isFinite(want.at) ||
      now.getTime() - want.at > LATE_ORDERS_DEMAND_TTL_MS
    ) {
      /* Nobody has asked for ten minutes: stop asking Yiji for it. */
      expired.push(vendorKey);
      continue;
    }
    await pollVendor(deps, vendorKey, want.thresholdMinutes, day, now, result);
  }
  if (expired.length > 0) {
    await redis.hdel(envKey(LATE_ORDERS_DEMAND_KEY), ...expired).catch(() => undefined);
  }
  if (result.polled.length > 0) {
    logger.debug(
      { polled: result.polled, changed: result.changed, failed: result.failed },
      'late-orders poll done',
    );
  }
  return result;
}

async function pollVendor(
  deps: LateOrdersPollDeps,
  vendorKey: string,
  thresholdMinutes: number,
  day: string,
  now: Date,
  result: LateOrdersPollResult,
): Promise<void> {
  const { redis, logger } = deps;
  const sep = vendorKey.indexOf(':');
  const platformVendorId = sep >= 0 ? vendorKey.slice(sep + 1) : '';
  try {
    if (!platformVendorId) return;
    const connector = await deps.connectors.connectorFor(platformVendorId);
    /* The key names a platform too; a vendor id that now resolves to another
       platform's connector is not the vendor the screen asked about. */
    if (lateOrdersVendorKey(connector) !== vendorKey) return;
    if (!canAskPlatform(connector)) {
      if (!warnedUnconfigured.has(vendorKey)) {
        warnedUnconfigured.add(vendorKey);
        logger.warn(
          { vendorKey },
          'late-orders poll: this vendor has no Yiji API URL + admin credential in the workers env - not polled (the gateway keeps answering it)',
        );
      }
      return;
    }

    const fetched = await connector.getLateDeliveryOrders(
      thresholdMinutes,
      liveLateOrdersQuery(day),
    );
    const rows = filterLateRows(fetched, thresholdMinutes);
    const snapshot: LateOrdersSnapshot = {
      rows,
      thresholdMinutes,
      builtAt: now.toISOString(),
      day,
      hash: lateOrdersRowsHash(rows),
      vendorKey,
    };
    const key = envKey(lateOrdersSnapshotKey(vendorKey));
    let previous: Pick<LateOrdersSnapshot, 'hash' | 'day' | 'thresholdMinutes'> | null = null;
    try {
      const raw = await redis.get(key);
      previous = raw ? (JSON.parse(raw) as LateOrdersSnapshot) : null;
    } catch {
      previous = null;
    }
    await redis.set(key, JSON.stringify(snapshot), 'EX', SNAPSHOT_TTL_SEC);
    result.polled.push(vendorKey);

    /*
     * PUSH ONLY ON A REAL CHANGE. The hash leaves `minutesElapsed` out (it
     * ticks every minute on every live row), so an unchanged queue pushes
     * nothing and screens are not made to refetch for no reason. A first
     * snapshot, a new day or a new threshold count as a change: the screens
     * are showing the fallback's answer and should move onto this one.
     */
    const changed =
      !previous ||
      previous.hash !== snapshot.hash ||
      previous.day !== snapshot.day ||
      previous.thresholdMinutes !== snapshot.thresholdMinutes;
    if (changed) {
      result.changed.push(vendorKey);
      if (deps.notify) {
        try {
          await deps.notify({ vendorKey, builtAt: snapshot.builtAt });
        } catch {
          /* The snapshot is written; screens catch up on their own poll. */
        }
      }
    }
  } catch (err) {
    /*
     * NOTHING IS WRITTEN on a failure. The previous snapshot ages past three
     * minutes and the gateway goes back to asking Yiji itself - a failed poll
     * must never become "nothing is late".
     */
    result.failed.push(vendorKey);
    logger.warn(
      { vendorKey, err: describeError(err) },
      'late-orders poll failed - the gateway falls back to Yiji',
    );
  }
}

/**
 * Register (or remove) the once-a-minute job.
 *
 * A job SCHEDULER upserted by id, not `add({ repeat })`: a repeatable added
 * with a different interval leaves the old one running beside it, while an
 * upsert replaces it - so changing `LATE_ORDERS_POLL_MS` never doubles the
 * calls. `0` removes it, which is the off switch.
 */
export async function scheduleLateOrdersPoll(queue: Queue, everyMs: number): Promise<void> {
  if (!(everyMs > 0)) {
    await queue.removeJobScheduler(LATE_ORDERS_POLL_SCHEDULER);
    return;
  }
  await queue.upsertJobScheduler(
    LATE_ORDERS_POLL_SCHEDULER,
    { every: everyMs },
    {
      name: 'poll',
      data: {},
      opts: { removeOnComplete: true, removeOnFail: true, attempts: 1 },
    },
  );
}
