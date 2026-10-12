import { describe, expect, it, vi, beforeEach } from 'vitest';
import { envKey } from '@yiji/shared-config/redis';
import { liveLateOrdersQuery, type LateOrdersSnapshot } from '@yiji/shared-types';
import {
  runLateOrdersPoll,
  scheduleLateOrdersPoll,
  type PollRedis,
} from '../src/processors/late-orders-poll.js';

/**
 * OPTION 2 (owner, 2026-10-12): ONE poller asks Yiji for today's late orders
 * once a minute per watched vendor - however many screens or worker tasks -
 * stores the snapshot, and pushes only when what an agent sees changed.
 */

/** In-memory Redis with the four calls the poller makes, and a settable clock. */
class FakeRedis implements PollRedis {
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
  async hdel(key: string, ...fields: string[]) {
    for (const f of fields) this.hashes.get(key)?.delete(f);
    return fields.length;
  }
  hset(key: string, field: string, value: string) {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    this.hashes.get(key)!.set(field, value);
  }
}

/* 13:00 Riyadh, 12 Oct: business day 2026-10-12. */
const T0 = Date.parse('2026-10-12T10:00:00Z');
const DAY = '2026-10-12';

type Row = { orderId: string; status: string; minutesElapsed: number; placedAt: string };

function connector(id: string, rows: () => Row[] | Promise<Row[]>, configured = true) {
  return {
    platform: 'yiji' as const,
    vendor: { platformVendorId: id },
    settings: {
      platform: 'yiji' as const,
      client: configured
        ? {
            apiUrl: 'https://api',
            adminApiUrl: 'https://admin',
            adminEmail: 'e',
            adminPassword: 'p',
          }
        : { apiUrl: 'https://api' },
    },
    getLateDeliveryOrders: vi.fn(async () => rows()),
  };
}

let redis: FakeRedis;
const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

function watch(vendorKey: string, thresholdMinutes = 60, at = redis.clock) {
  redis.hset(envKey('late-orders:demand'), vendorKey, JSON.stringify({ thresholdMinutes, at }));
}

function deps(conns: Record<string, ReturnType<typeof connector>>, notify = vi.fn()) {
  return {
    redis,
    logger,
    notify,
    connectors: {
      connectorFor: vi.fn(async (k: string) => {
        const c = conns[k];
        if (!c) throw new Error(`unknown ${k}`);
        return c as never;
      }),
    },
    now: () => new Date(redis.clock),
  };
}

const snap = async (vendorKey: string) => {
  const raw = await redis.get(envKey(`late-orders:snapshot:${vendorKey}`));
  return raw ? (JSON.parse(raw) as LateOrdersSnapshot) : null;
};

describe('late-orders poller', () => {
  beforeEach(() => {
    redis = new FakeRedis();
    redis.clock = T0;
    vi.clearAllMocks();
  });

  it('asks Yiji ONCE per watched vendor per poll, however many screens asked', async () => {
    const a = connector('1', () => [
      { orderId: 'A', status: 'x', minutesElapsed: 70, placedAt: '' },
    ]);
    const b = connector('2', () => []);
    // Forty requests from screens are forty writes of the same demand field.
    for (let i = 0; i < 40; i++) watch('yiji:1');
    watch('yiji:2');
    const d = deps({ '1': a, '2': b });
    const res = await runLateOrdersPoll(d);
    expect(a.getLateDeliveryOrders).toHaveBeenCalledTimes(1);
    expect(b.getLateDeliveryOrders).toHaveBeenCalledTimes(1);
    expect(res.polled.sort()).toEqual(['yiji:1', 'yiji:2']);
    /* The SAME question the gateway's fallback asks for today's live view. */
    expect(a.getLateDeliveryOrders).toHaveBeenCalledWith(60, liveLateOrdersQuery(DAY));
  });

  it('polls once a minute: a second run inside the minute is skipped, the next minute runs', async () => {
    const a = connector('1', () => []);
    watch('yiji:1');
    const d = deps({ '1': a });
    expect((await runLateOrdersPoll(d)).skipped).toBe(false);
    redis.clock += 30_000;
    watch('yiji:1');
    expect((await runLateOrdersPoll(d)).skipped).toBe(true);
    redis.clock += 30_000;
    watch('yiji:1');
    expect((await runLateOrdersPoll(d)).skipped).toBe(false);
    expect(a.getLateDeliveryOrders).toHaveBeenCalledTimes(2);
  });

  it('two worker tasks running the same minute make ONE Yiji call (the lock)', async () => {
    const a = connector('1', () => []);
    watch('yiji:1');
    const [one, two] = await Promise.all([
      runLateOrdersPoll(deps({ '1': a })),
      runLateOrdersPoll(deps({ '1': a })),
    ]);
    expect([one.skipped, two.skipped].sort()).toEqual([false, true]);
    expect(a.getLateDeliveryOrders).toHaveBeenCalledTimes(1);
  });

  it('stores the snapshot in the gateway shape, with the threshold filter applied', async () => {
    const a = connector('1', () => [
      { orderId: 'LATE', status: 'in_delivery', minutesElapsed: 75, placedAt: '' },
      { orderId: 'EARLY', status: 'force_cancel', minutesElapsed: 9, placedAt: '' },
    ]);
    watch('yiji:1', 60);
    await runLateOrdersPoll(deps({ '1': a }));
    const s = await snap('yiji:1');
    expect(s?.rows.map((r) => r.orderId)).toEqual(['LATE']);
    expect(s?.thresholdMinutes).toBe(60);
    expect(s?.day).toBe(DAY);
    expect(s?.builtAt).toBe(new Date(T0).toISOString());
  });

  it('pushes once per change - not for the minutes ticking on an unchanged queue', async () => {
    let rows: Row[] = [{ orderId: 'A', status: 'in_delivery', minutesElapsed: 61, placedAt: '' }];
    const a = connector('1', () => rows);
    const notify = vi.fn();
    const d = deps({ '1': a }, notify);
    watch('yiji:1');

    await runLateOrdersPoll(d); // first snapshot = a change
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenLastCalledWith({
      vendorKey: 'yiji:1',
      builtAt: new Date(T0).toISOString(),
    });

    redis.clock += 60_000;
    watch('yiji:1');
    rows = [{ ...rows[0]!, minutesElapsed: 62 }];
    await runLateOrdersPoll(d); // same order, one minute later
    expect(notify).toHaveBeenCalledTimes(1);

    redis.clock += 60_000;
    watch('yiji:1');
    rows = [...rows, { orderId: 'B', status: 'in_delivery', minutesElapsed: 60, placedAt: '' }];
    await runLateOrdersPoll(d); // a new late order
    expect(notify).toHaveBeenCalledTimes(2);

    redis.clock += 60_000;
    watch('yiji:1');
    rows = rows.map((r) => (r.orderId === 'A' ? { ...r, status: 'closed' } : r));
    await runLateOrdersPoll(d); // a status change
    expect(notify).toHaveBeenCalledTimes(3);
  });

  it('a failed fetch writes nothing and pushes nothing - the old snapshot ages out', async () => {
    let fail = false;
    const a = connector('1', () => {
      if (fail) throw new Error('yiji 503');
      return [{ orderId: 'A', status: 'x', minutesElapsed: 70, placedAt: '' }];
    });
    const notify = vi.fn();
    const d = deps({ '1': a }, notify);
    watch('yiji:1');
    await runLateOrdersPoll(d);
    const before = await snap('yiji:1');

    fail = true;
    redis.clock += 60_000;
    watch('yiji:1');
    const res = await runLateOrdersPoll(d);
    expect(res.failed).toEqual(['yiji:1']);
    expect(await snap('yiji:1')).toEqual(before);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('stops asking for a vendor nobody has watched for ten minutes', async () => {
    const a = connector('1', () => []);
    watch('yiji:1', 60, T0 - 11 * 60_000);
    const res = await runLateOrdersPoll(deps({ '1': a }));
    expect(a.getLateDeliveryOrders).not.toHaveBeenCalled();
    expect(res.polled).toEqual([]);
    expect(await redis.hgetall(envKey('late-orders:demand'))).toEqual({});
  });

  it('does not poll a vendor whose Yiji admin credential is missing from the workers env', async () => {
    /* Its connector would answer [] ("we cannot ask"), and a snapshot of that
       would tell every screen nothing is late. */
    const a = connector('1', () => [], false);
    watch('yiji:1');
    await runLateOrdersPoll(deps({ '1': a }));
    expect(a.getLateDeliveryOrders).not.toHaveBeenCalled();
    expect(await snap('yiji:1')).toBeNull();
  });

  it('does nothing at all when nobody is watching', async () => {
    const a = connector('1', () => []);
    const res = await runLateOrdersPoll(deps({ '1': a }));
    expect(a.getLateDeliveryOrders).not.toHaveBeenCalled();
    expect(res.polled).toEqual([]);
  });
});

describe('scheduleLateOrdersPoll', () => {
  it('upserts ONE job scheduler by id (so a changed interval replaces, never doubles)', async () => {
    const queue = { upsertJobScheduler: vi.fn(), removeJobScheduler: vi.fn() };
    await scheduleLateOrdersPoll(queue as never, 60_000);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'late-orders-poll',
      { every: 60_000 },
      expect.objectContaining({ name: 'poll' }),
    );
    expect(queue.removeJobScheduler).not.toHaveBeenCalled();
  });

  it('0 removes it - the off switch', async () => {
    const queue = { upsertJobScheduler: vi.fn(), removeJobScheduler: vi.fn() };
    await scheduleLateOrdersPoll(queue as never, 0);
    expect(queue.removeJobScheduler).toHaveBeenCalledWith('late-orders-poll');
    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
  });
});
