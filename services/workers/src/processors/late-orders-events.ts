import type { Logger } from 'pino';
import { envKey } from '@yiji/shared-config/redis';
import {
  DEFAULT_LATE_DELIVERY_MINUTES,
  LATE_ORDERS_DEMAND_KEY,
  LIVE_ORDERS_EVENTS_MODE_SEC,
  LIVE_ORDERS_TTL_SEC,
  applyOrderEvent,
  businessDay,
  lateOrdersRowsHash,
  lateOrdersSnapshotKey,
  lateRowsFromLive,
  liveOrderExpired,
  liveOrdersEventsModeKey,
  liveOrdersKey,
  parseLiveOrders,
  pollRowToLiveOrder,
  type LateOrderRow,
  type LateOrdersDemand,
  type LateOrdersEventJob,
  type LateOrdersSnapshot,
  type LiveOrder,
} from '@yiji/shared-types';
import { describeError } from '../lib/errors.js';

/**
 * LATE ORDERS FROM EVENTS (owner, 2026-11-15): the platform tells the CRM
 * every order status change; this keeps the vendor's LIVE ORDERS table (a
 * Redis hash, one entry per order) and rebuilds the late-orders snapshot the
 * gateway serves - the same shape the once-a-minute Yiji poll wrote, so the
 * board needs no change. While events flow, the poll only rebuilds from this
 * table (minutes tick, orders cross the threshold) and asks the platform
 * every few minutes as a safety net (`mergePollRows`).
 */

export interface LiveRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ex: 'EX', seconds: number): Promise<unknown>;
  hget(key: string, field: string): Promise<string | null>;
  hset(key: string, field: string, value: string): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
  hdel(key: string, ...fields: string[]): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export interface LateOrdersEventsDeps {
  redis: LiveRedis;
  logger: Pick<Logger, 'info' | 'warn' | 'debug'>;
  notify?: ((change: { vendorKey: string; builtAt: string }) => void | Promise<void>) | undefined;
  now?: () => Date;
}

/** The snapshot key's life; freshness is judged by `builtAt` (gateway, 3 min). */
const SNAPSHOT_TTL_SEC = 15 * 60;

/** One event: update the order in the live table, then rebuild the board. */
export async function applyLateOrdersEvent(
  deps: LateOrdersEventsDeps,
  job: LateOrdersEventJob,
): Promise<{ changed: boolean; rows: number }> {
  const { redis } = deps;
  const now = deps.now?.() ?? new Date();
  const key = envKey(liveOrdersKey(job.vendorKey));
  const orderId = job.event.order.orderId;
  let prev: LiveOrder | null = null;
  try {
    const raw = await redis.hget(key, orderId);
    prev = raw ? (JSON.parse(raw) as LiveOrder) : null;
  } catch {
    prev = null;
  }
  const next = applyOrderEvent(prev, job.event);
  await redis.hset(key, orderId, JSON.stringify(next));
  await redis.expire(key, LIVE_ORDERS_TTL_SEC);
  /* "Events are flowing": the poll becomes a reconciliation for this vendor. */
  await redis.set(
    envKey(liveOrdersEventsModeKey(job.vendorKey)),
    now.toISOString(),
    'EX',
    LIVE_ORDERS_EVENTS_MODE_SEC,
  );
  const out = await rebuildLiveSnapshot(deps, job.vendorKey, now);
  deps.logger.info(
    {
      vendorKey: job.vendorKey,
      eventId: job.event.id,
      type: job.event.type,
      orderId,
      status: next.status,
      isOpen: next.isOpen,
      changed: out.changed,
      rows: out.rows,
    },
    'late-orders event applied',
  );
  return out;
}

/** Is this vendor fed by events right now? */
export async function inEventsMode(redis: Pick<LiveRedis, 'get'>, vendorKey: string) {
  try {
    return Boolean(await redis.get(envKey(liveOrdersEventsModeKey(vendorKey))));
  } catch {
    return false;
  }
}

/**
 * A reconciliation read merged into the live table: an order the platform
 * lists that events never mentioned is added; one the events already track
 * is left to the events (they carry the legs; the poll row does not).
 */
export async function mergePollRows(
  redis: LiveRedis,
  vendorKey: string,
  rows: readonly LateOrderRow[],
  now: number,
): Promise<number> {
  const key = envKey(liveOrdersKey(vendorKey));
  let added = 0;
  for (const r of rows) {
    let prev: LiveOrder | null = null;
    try {
      const raw = await redis.hget(key, r.orderId);
      prev = raw ? (JSON.parse(raw) as LiveOrder) : null;
    } catch {
      prev = null;
    }
    if (prev?.source === 'event') continue;
    await redis.hset(key, r.orderId, JSON.stringify(pollRowToLiveOrder(r, now)));
    added += 1;
  }
  if (rows.length > 0) await redis.expire(key, LIVE_ORDERS_TTL_SEC);
  return added;
}

/** The board's threshold for this vendor, as the screens asked (else the default). */
async function thresholdFor(redis: LiveRedis, vendorKey: string): Promise<number> {
  try {
    const raw = await redis.hget(envKey(LATE_ORDERS_DEMAND_KEY), vendorKey);
    const d = raw ? (JSON.parse(raw) as LateOrdersDemand) : null;
    return typeof d?.thresholdMinutes === 'number'
      ? d.thresholdMinutes
      : DEFAULT_LATE_DELIVERY_MINUTES;
  } catch {
    return DEFAULT_LATE_DELIVERY_MINUTES;
  }
}

/**
 * Rebuild the vendor's late-orders snapshot from its live table: drop what is
 * too old, keep the delivery masters past the threshold, longest first; write
 * it in the gateway's shape and push the screens when the rows changed (the
 * hash leaves the ticking minutes out, so an unchanged queue pushes nothing).
 */
export async function rebuildLiveSnapshot(
  deps: LateOrdersEventsDeps,
  vendorKey: string,
  now: Date = deps.now?.() ?? new Date(),
): Promise<{ changed: boolean; rows: number }> {
  const { redis, logger } = deps;
  const key = envKey(liveOrdersKey(vendorKey));
  let all: LiveOrder[] = [];
  try {
    all = parseLiveOrders((await redis.hgetall(key)) ?? {});
  } catch (err) {
    logger.warn(
      { err: describeError(err), vendorKey },
      'late-orders events: live table unreadable',
    );
    return { changed: false, rows: 0 };
  }
  const nowMs = now.getTime();
  const expired = all.filter((o) => liveOrderExpired(o, nowMs)).map((o) => o.orderId);
  if (expired.length > 0) await redis.hdel(key, ...expired).catch(() => undefined);
  const thresholdMinutes = await thresholdFor(redis, vendorKey);
  const rows = lateRowsFromLive(all, thresholdMinutes, nowMs);
  const snapshot: LateOrdersSnapshot = {
    rows,
    thresholdMinutes,
    builtAt: now.toISOString(),
    day: businessDay(now.toISOString()) ?? now.toISOString().slice(0, 10),
    hash: lateOrdersRowsHash(rows),
    vendorKey,
  };
  const snapshotKey = envKey(lateOrdersSnapshotKey(vendorKey));
  let previous: Pick<LateOrdersSnapshot, 'hash' | 'day' | 'thresholdMinutes'> | null = null;
  try {
    const raw = await redis.get(snapshotKey);
    previous = raw ? (JSON.parse(raw) as LateOrdersSnapshot) : null;
  } catch {
    previous = null;
  }
  await redis.set(snapshotKey, JSON.stringify(snapshot), 'EX', SNAPSHOT_TTL_SEC);
  const changed =
    !previous ||
    previous.hash !== snapshot.hash ||
    previous.day !== snapshot.day ||
    previous.thresholdMinutes !== snapshot.thresholdMinutes;
  if (changed && deps.notify) {
    try {
      await deps.notify({ vendorKey, builtAt: snapshot.builtAt });
    } catch {
      /* The snapshot is written; screens catch up on their own poll. */
    }
  }
  if (expired.length > 0 || all.length > 0) {
    logger.debug(
      { vendorKey, live: all.length, expired: expired.length, rows: rows.length, thresholdMinutes },
      'late-orders live snapshot rebuilt',
    );
  }
  return { changed, rows: rows.length };
}
