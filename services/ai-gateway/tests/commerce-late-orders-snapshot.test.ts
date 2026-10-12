import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { envKey } from '@yiji/shared-config/redis';
import type { LateOrdersSnapshot } from '@yiji/shared-types';
import { registerCommerceRoutes, type CommerceDeps } from '../src/commerce/index.js';
import {
  RedisLateOrdersLiveStore,
  type LateOrdersLiveStore,
} from '../src/commerce/late-orders-live.js';
import { connectorsFor } from './connectors-fixture.js';

/**
 * OPTION 2 (owner, 2026-10-12): today's live late-orders queue is answered
 * from the workers' once-a-minute snapshot when it is fresh, and from Yiji -
 * exactly as before - when it is missing, stale, or for another day/threshold.
 */
const AGENT = 'agent-session-token';
const auth = { authorization: `Bearer ${AGENT}` };
/* 13:00 Riyadh on 12 Oct: business day 2026-10-12. */
const NOW = Date.parse('2026-10-12T10:00:00Z');
const TODAY = '2026-10-12';
const liveUrl = `/commerce/late-orders?from=${TODAY}&to=${TODAY}&live=1&vendorId=v1`;

const yijiRow = { orderId: 'Y-1', status: 'in_delivery', minutesElapsed: 70, placedAt: '' };
const snapRow = { orderId: 'S-1', status: 'in_delivery', minutesElapsed: 65, placedAt: '' };

function snapshot(over: Partial<LateOrdersSnapshot> = {}): LateOrdersSnapshot {
  return {
    rows: [snapRow],
    thresholdMinutes: 60,
    builtAt: new Date(NOW - 30_000).toISOString(),
    day: TODAY,
    hash: 'h',
    vendorKey: 'yiji:v1',
    ...over,
  };
}

function build(snap: LateOrdersSnapshot | null, threshold = 60) {
  const getLateDeliveryOrders = vi.fn(async () => [yijiRow]);
  const store = {
    registerDemand: vi.fn(async () => undefined),
    readSnapshot: vi.fn(async () => snap),
  } satisfies LateOrdersLiveStore;
  const deps: CommerceDeps = {
    directus: {
      async whoAmI(token: string) {
        return token === AGENT ? { id: 'u-1', role: 'role-agent' } : null;
      },
      async adminRoleIds() {
        return new Set(['role-admin']);
      },
      async lateDeliveryThreshold() {
        return threshold;
      },
    },
    connectors: connectorsFor({ getLateDeliveryOrders }),
    lateOrdersLive: store,
    now: () => NOW,
  };
  const app = Fastify();
  return { app, deps, store, getLateDeliveryOrders };
}

async function get(snap: LateOrdersSnapshot | null, url = liveUrl, threshold = 60) {
  const t = build(snap, threshold);
  await registerCommerceRoutes(t.app, t.deps);
  const res = await t.app.inject({ method: 'GET', url, headers: auth });
  return {
    ...t,
    res,
    body: res.json() as { data: { rows: Array<{ orderId: string }>; builtAt: string } },
  };
}

describe('GET /commerce/late-orders - the live snapshot', () => {
  it('serves a fresh snapshot without asking Yiji, and records the demand', async () => {
    const { res, body, store, getLateDeliveryOrders } = await get(snapshot());
    expect(res.statusCode).toBe(200);
    expect(body.data.rows.map((r) => r.orderId)).toEqual(['S-1']);
    /* The poller's build time, not the moment this request was read. */
    expect(body.data.builtAt).toBe(new Date(NOW - 30_000).toISOString());
    expect(getLateDeliveryOrders).not.toHaveBeenCalled();
    expect(store.registerDemand).toHaveBeenCalledWith('yiji:v1', 60);
  });

  it('answers any number of screens from one snapshot - Yiji is never asked', async () => {
    const t = build(snapshot());
    await registerCommerceRoutes(t.app, t.deps);
    for (let i = 0; i < 25; i++) {
      await t.app.inject({ method: 'GET', url: liveUrl, headers: auth });
    }
    expect(t.getLateDeliveryOrders).not.toHaveBeenCalled();
  });

  it('falls back to Yiji when there is no snapshot (poller not deployed yet)', async () => {
    const { body, getLateDeliveryOrders, store } = await get(null);
    expect(body.data.rows.map((r) => r.orderId)).toEqual(['Y-1']);
    expect(getLateDeliveryOrders).toHaveBeenCalledTimes(1);
    /* Still records the demand - that is what starts the poller. */
    expect(store.registerDemand).toHaveBeenCalled();
  });

  it('falls back to Yiji when the snapshot is stale (over 3 minutes)', async () => {
    const stale = snapshot({ builtAt: new Date(NOW - 4 * 60_000).toISOString() });
    const { body, getLateDeliveryOrders } = await get(stale);
    expect(body.data.rows.map((r) => r.orderId)).toEqual(['Y-1']);
    expect(getLateDeliveryOrders).toHaveBeenCalledTimes(1);
  });

  it('falls back when the snapshot was built with another threshold or for another day', async () => {
    const a = await get(snapshot({ thresholdMinutes: 45 }));
    expect(a.getLateDeliveryOrders).toHaveBeenCalledTimes(1);
    const b = await get(snapshot({ day: '2026-10-11' }));
    expect(b.getLateDeliveryOrders).toHaveBeenCalledTimes(1);
  });

  it('never consults the snapshot for a historical range', async () => {
    const { store, getLateDeliveryOrders } = await get(
      snapshot(),
      `/commerce/late-orders?from=2026-10-01&to=2026-10-03&vendorId=v1`,
    );
    expect(store.readSnapshot).not.toHaveBeenCalled();
    expect(store.registerDemand).not.toHaveBeenCalled();
    expect(getLateDeliveryOrders).toHaveBeenCalledTimes(1);
  });

  it('never consults it for today asked WITHOUT live=1, or for a day that is not today', async () => {
    const a = await get(snapshot(), `/commerce/late-orders?from=${TODAY}&to=${TODAY}&vendorId=v1`);
    expect(a.store.readSnapshot).not.toHaveBeenCalled();
    const b = await get(
      snapshot(),
      `/commerce/late-orders?from=2026-10-11&to=2026-10-11&live=1&vendorId=v1`,
    );
    expect(b.store.readSnapshot).not.toHaveBeenCalled();
  });
});

describe('RedisLateOrdersLiveStore', () => {
  it('writes the demand into the namespaced hash and reads the namespaced snapshot', async () => {
    const hset = vi.fn(async () => 1);
    const get = vi.fn(async () => JSON.stringify(snapshot()));
    const store = new RedisLateOrdersLiveStore({ hset, get } as never, () => 1234);
    await store.registerDemand('yiji:1', 60);
    expect(hset).toHaveBeenCalledWith(
      envKey('late-orders:demand'),
      'yiji:1',
      JSON.stringify({ thresholdMinutes: 60, at: 1234 }),
    );
    expect((await store.readSnapshot('yiji:1'))?.rows).toHaveLength(1);
    expect(get).toHaveBeenCalledWith(envKey('late-orders:snapshot:yiji:1'));
  });

  it('never throws: a Redis outage reads as "no snapshot" and the route asks Yiji', async () => {
    const boom = vi.fn(async () => {
      throw new Error('redis down');
    });
    const store = new RedisLateOrdersLiveStore({ hset: boom, get: boom } as never);
    await expect(store.registerDemand('yiji:1', 60)).resolves.toBeUndefined();
    await expect(store.readSnapshot('yiji:1')).resolves.toBeNull();
  });
});
