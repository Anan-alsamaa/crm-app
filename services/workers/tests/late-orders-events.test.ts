import { describe, it, expect, vi, beforeEach } from 'vitest';
import { envKey } from '@yiji/shared-config/redis';
import type { LateOrdersSnapshot } from '@yiji/shared-types';
import {
  applyLateOrdersEvent,
  inEventsMode,
  rebuildLiveSnapshot,
  type LiveRedis,
} from '../src/processors/late-orders-events.js';
import { runLateOrdersPoll } from '../src/processors/late-orders-poll.js';

/**
 * LATE ORDERS FROM EVENTS (owner, 2026-11-15): one event updates the live
 * table and rebuilds the board; while events flow the minute poll rebuilds
 * from the table and asks the platform only every few minutes.
 */
class FakeRedis implements LiveRedis {
  clock = 0;
  private kv = new Map<string, { v: string; exp: number }>();
  private hashes = new Map<string, Map<string, string>>();
  private live(key: string) {
    const e = this.kv.get(key);
    if (e && e.exp <= this.clock) this.kv.delete(key);
    return this.kv.get(key);
  }
  async set(key: string, value: string, ...args: Array<string | number>) {
    const nx = args.includes('NX');
    if (nx && this.live(key)) return null;
    let exp = Infinity;
    const px = args.indexOf('PX');
    if (px >= 0) exp = this.clock + Number(args[px + 1]);
    const ex = args.indexOf('EX');
    if (ex >= 0) exp = this.clock + Number(args[ex + 1]) * 1000;
    this.kv.set(key, { v: value, exp });
    return 'OK';
  }
  async get(key: string) {
    return this.live(key)?.v ?? null;
  }
  async hgetall(key: string) {
    return Object.fromEntries(this.hashes.get(key) ?? new Map());
  }
  async hget(key: string, field: string) {
    return this.hashes.get(key)?.get(field) ?? null;
  }
  async hdel(key: string, ...fields: string[]) {
    for (const f of fields) this.hashes.get(key)?.delete(f);
    return fields.length;
  }
  async hset(key: string, field: string, value: string) {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    this.hashes.get(key)!.set(field, value);
    return 1;
  }
  async expire() {
    return 1;
  }
}

/* 13:00 Riyadh, 15 Nov. */
const T0 = Date.parse('2026-11-15T10:00:00Z');
const V = 'yiji:1';
let redis: FakeRedis;
const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
const notify = vi.fn();
const deps = () => ({ redis, logger, notify, now: () => new Date(redis.clock) });
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const ev = (
  id: string,
  orderId: string,
  status: string,
  min: number,
  over: Record<string, unknown> = {},
) => ({
  vendorKey: V,
  event: {
    id,
    type: 'order.status_changed',
    at: at(min),
    order: {
      orderId,
      status,
      isOpen: true,
      orderType: 'delivery' as const,
      placedAt: at(0),
      brandName: 'Casa Pasta',
      restaurantName: 'One Square',
      customer: { id: 'u-1', name: 'Saad', phone: '+966545808075' },
      ...over,
    },
  },
});
const snap = async () => {
  const raw = await redis.get(envKey(`late-orders:snapshot:${V}`));
  return raw ? (JSON.parse(raw) as LateOrdersSnapshot) : null;
};
const watch = (thresholdMinutes = 60) =>
  redis.hset(
    envKey('late-orders:demand'),
    V,
    JSON.stringify({ thresholdMinutes, at: redis.clock }),
  );

beforeEach(() => {
  redis = new FakeRedis();
  redis.clock = T0;
  vi.clearAllMocks();
});

describe('one event', () => {
  it('puts the vendor in events mode, keeps the order, and builds a board with nothing late yet', async () => {
    await watch(60);
    redis.clock = T0 + 10 * 60_000;
    const r = await applyLateOrdersEvent(deps(), ev('e1', '1400001', 'in_kitchen', 10));
    expect(await inEventsMode(redis, V)).toBe(true);
    const s = await snap();
    expect(s).toMatchObject({ vendorKey: V, thresholdMinutes: 60, rows: [] });
    /* The first snapshot is a change (there was none). */
    expect(r.changed).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
  });
  it('the order crosses the threshold on a later rebuild - no event needed - and the screens are pushed once', async () => {
    await watch(60);
    await applyLateOrdersEvent(deps(), ev('e1', '1400001', 'in_kitchen', 10));
    notify.mockClear();
    redis.clock = T0 + 61 * 60_000;
    expect((await rebuildLiveSnapshot(deps(), V)).changed).toBe(true);
    expect((await snap())!.rows.map((r) => [r.orderId, r.minutesElapsed, r.live])).toEqual([
      ['1400001', 61, true],
    ]);
    expect(notify).toHaveBeenCalledTimes(1);
    /* A minute later the minutes tick but the queue is the same: no push. */
    redis.clock = T0 + 62 * 60_000;
    expect((await rebuildLiveSnapshot(deps(), V)).changed).toBe(false);
    expect((await snap())!.rows[0]!.minutesElapsed).toBe(62);
    expect(notify).toHaveBeenCalledTimes(1);
  });
  it('a close stops the clock; the row stays today with live=false', async () => {
    await watch(60);
    await applyLateOrdersEvent(deps(), ev('e1', '1400001', 'in_delivery', 40));
    redis.clock = T0 + 80 * 60_000;
    await applyLateOrdersEvent(deps(), ev('e2', '1400001', 'delivered', 70, { isOpen: false }));
    redis.clock = T0 + 200 * 60_000;
    await rebuildLiveSnapshot(deps(), V);
    expect((await snap())!.rows[0]).toMatchObject({
      minutesElapsed: 70,
      live: false,
      closedAt: at(70),
    });
  });
  it('a retried (duplicate) event changes nothing', async () => {
    await watch(60);
    redis.clock = T0 + 70 * 60_000;
    await applyLateOrdersEvent(deps(), ev('e1', '1400001', 'in_kitchen', 10));
    const before = (await snap())!.hash;
    const r = await applyLateOrdersEvent(deps(), ev('e1', '1400001', 'in_kitchen', 10));
    expect(r.changed).toBe(false);
    expect((await snap())!.hash).toBe(before);
  });
});

describe('the poll while events flow', () => {
  const connector = (rows: Array<Record<string, unknown>>) => ({
    platform: 'yiji' as const,
    vendor: { platformVendorId: '1' },
    settings: {
      platform: 'yiji' as const,
      client: {
        apiUrl: 'https://api',
        adminApiUrl: 'https://admin',
        adminEmail: 'e',
        adminPassword: 'p',
      },
    },
    getLateDeliveryOrders: vi.fn(async () => rows),
  });
  const pollDeps = (c: ReturnType<typeof connector>, reconcileMs = 5 * 60_000) => ({
    redis,
    logger,
    notify,
    connectors: { connectorFor: vi.fn(async () => c as never) },
    now: () => new Date(redis.clock),
    reconcileMs,
  });

  it('rebuilds from the live table without asking the platform, until the reconcile interval', async () => {
    const c = connector([]);
    /* The event arrives at minute 61 (events mode lasts 15 min from the last one). */
    redis.clock = T0 + 61 * 60_000;
    await watch(60);
    await applyLateOrdersEvent(deps(), ev('e1', '1400001', 'in_kitchen', 5));
    /* First poll in events mode: a reconcile is due (never done) - one call. */
    const r1 = await runLateOrdersPoll(pollDeps(c));
    expect(c.getLateDeliveryOrders).toHaveBeenCalledTimes(1);
    expect(r1.polled).toEqual([V]);
    /* The event itself already built (and pushed) the board: the poll's rebuild finds it unchanged. */
    expect(r1.changed).toEqual([]);
    expect((await snap())!.rows.map((r) => r.orderId)).toEqual(['1400001']);
    /* The next minute: the table only. */
    redis.clock = T0 + 62 * 60_000;
    await runLateOrdersPoll(pollDeps(c));
    expect(c.getLateDeliveryOrders).toHaveBeenCalledTimes(1);
    /* Five minutes on: the safety net asks again. */
    redis.clock = T0 + 67 * 60_000;
    await runLateOrdersPoll(pollDeps(c));
    expect(c.getLateDeliveryOrders).toHaveBeenCalledTimes(2);
  });
  it('a reconciliation adds an order the events never mentioned, and leaves event-fed ones alone', async () => {
    redis.clock = T0 + 70 * 60_000;
    await watch(60);
    await applyLateOrdersEvent(
      deps(),
      ev('e1', '1400001', 'in_delivery', 5, { brandName: 'Casa Pasta' }),
    );
    const c = connector([
      {
        orderId: '1400001',
        status: '8',
        minutesElapsed: 70,
        live: true,
        placedAt: at(0),
        brandName: 'WRONG',
      },
      {
        orderId: '1400777',
        status: '5',
        minutesElapsed: 90,
        live: true,
        placedAt: at(-20),
        brandName: 'Okashi',
      },
    ]);
    await runLateOrdersPoll(pollDeps(c));
    const rows = (await snap())!.rows;
    expect(rows.map((r) => [r.orderId, r.brandName])).toEqual([
      ['1400777', 'Okashi'],
      ['1400001', 'Casa Pasta'],
    ]);
  });
});
