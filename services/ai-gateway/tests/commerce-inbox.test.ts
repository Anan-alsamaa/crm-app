import { describe, expect, it, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerCommerceRoutes } from '../src/commerce/index.js';
import { CommerceCache } from '../src/commerce/cache.js';
import type { CallerVerifierDeps } from '../src/auth/index.js';

const AGENT_TOKEN = 'agent-session-token';
const auth = { authorization: `Bearer ${AGENT_TOKEN}` };

const directus: CallerVerifierDeps = {
  async whoAmI(token: string) {
    return token === AGENT_TOKEN ? { id: 'u-1', role: 'role-agent' } : null;
  },
  async adminRoleIds() {
    return new Set(['role-admin']);
  },
};

/** A Redis stand-in with the three calls the cache makes. */
function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    }),
  };
}

const order = (id: string) => ({
  orderId: id,
  status: 'delivered',
  total: 50,
  currency: 'SAR',
  placedAt: '2026-08-01T00:00:00Z',
  items: [{ name: 'Burger', qty: 1 }],
});

function fakeYiji() {
  const calls = { getOrders: 0, getOrder: 0 };
  return {
    calls,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: {
      getPurchaseActivity: async () => null,
      getOrders: async (_v: string, _c: string, opts: { limit?: number }) => {
        calls.getOrders += 1;
        return Array.from({ length: opts.limit ?? 6 }, (_, i) => ({ orderId: `O-${i}` }));
      },
      getOrder: async (_v: string, id: string) => {
        calls.getOrder += 1;
        return order(id);
      },
      getPaymentStatus: async () => null,
      getShipmentTracking: async () => null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

async function build(yijiClient: unknown, redis?: ReturnType<typeof fakeRedis>) {
  const app = Fastify();
  await registerCommerceRoutes(app, {
    directus,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    yiji: yijiClient as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(redis ? { cache: new CommerceCache(redis as any) } : {}),
  });
  return app;
}

describe('/commerce/inbox', () => {
  let yiji: ReturnType<typeof fakeYiji>;
  let app: FastifyInstance;

  beforeEach(async () => {
    yiji = fakeYiji();
    app = await build(yiji.client);
  });

  it('still requires a verified agent session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/commerce/inbox?vendorId=v1&customerId=c1',
    });
    expect(res.statusCode).toBe(401);
  });

  it('answers the list AND the newest order’s detail in one request', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/commerce/inbox?vendorId=v1&customerId=c1&limit=2',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.orders).toHaveLength(2);
    // The whole point: the summary list carries no line items, and the panel
    // shows the newest order expanded.
    expect(data.detail.orderId).toBe('O-0');
    expect(data.detail.items).toHaveLength(1);
  });

  it('does not invent a detail call for a customer with no orders', async () => {
    const empty = {
      ...yiji.client,
      getOrders: async () => [],
      getOrder: async () => {
        throw new Error('must not be called');
      },
    };
    const a = await build(empty);
    const res = await a.inject({
      method: 'GET',
      url: '/commerce/inbox?vendorId=v1&customerId=c1',
      headers: auth,
    });
    expect(res.json().data).toEqual({ orders: [], detail: null });
  });

  it('returns the summaries rather than waiting out a slow detail call', async () => {
    // The detail is a bonus that saves the caller a round trip; it must never
    // cost more time than that round trip would have. Upstream cold latency has
    // been measured from 300ms to 30 SECONDS on this API.
    const slow = {
      ...yiji.client,
      getOrder: () => new Promise(() => {}), // never settles
    };
    const app2 = await build(slow);
    const started = Date.now();
    const res = await app2.inject({
      method: 'GET',
      url: '/commerce/inbox?vendorId=v1&customerId=c1&limit=2',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.orders).toHaveLength(2);
    // Null, not an error: the caller falls back to fetching it lazily on
    // expand, exactly as it did before this endpoint existed.
    expect(res.json().data.detail).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('says commerce is not responding rather than "no orders"', async () => {
    // `orders: []` would read as "this customer has never ordered", which is a
    // different and much worse claim than "we could not ask". The portal turns
    // a non-200 into "unavailable" beside the manual order box.
    vi.useFakeTimers();
    const stuck = { ...yiji.client, getOrders: () => new Promise(() => {}) };
    const app2 = await build(stuck);
    const pending = app2.inject({
      method: 'GET',
      url: '/commerce/inbox?vendorId=v1&customerId=c1',
      headers: auth,
    });
    await vi.advanceTimersByTimeAsync(9_000);
    const res = await pending;
    vi.useRealTimers();
    expect(res.statusCode).toBe(504);
    expect(res.json()).toEqual({ error: 'commerce_timeout' });
  });

  it('rejects a request missing the ids it cannot guess', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/commerce/inbox?vendorId=v1',
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('commerce caching', () => {
  it('goes upstream once and serves the rest from cache', async () => {
    const yiji = fakeYiji();
    const redis = fakeRedis();
    const app = await build(yiji.client, redis);

    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: 'GET',
        url: '/commerce/inbox?vendorId=v1&customerId=c1&limit=2',
        headers: auth,
      });
    }
    expect(yiji.calls.getOrders).toBe(1);
    expect(yiji.calls.getOrder).toBe(1);
  });

  it('collapses a burst of identical requests into ONE upstream call', async () => {
    // A cold key with ten concurrent readers is ten upstream calls unless the
    // in-flight promise is shared — which is the burst a cache exists for.
    const yiji = fakeYiji();
    const redis = fakeRedis();
    const app = await build(yiji.client, redis);

    await Promise.all(
      Array.from({ length: 10 }, () =>
        app.inject({
          method: 'GET',
          url: '/commerce/inbox?vendorId=v1&customerId=c1&limit=2',
          headers: auth,
        }),
      ),
    );
    expect(yiji.calls.getOrders).toBe(1);
  });

  it('keeps a different customer’s orders separate', async () => {
    const yiji = fakeYiji();
    const redis = fakeRedis();
    const app = await build(yiji.client, redis);
    await app.inject({
      method: 'GET',
      url: '/commerce/inbox?vendorId=v1&customerId=c1',
      headers: auth,
    });
    await app.inject({
      method: 'GET',
      url: '/commerce/inbox?vendorId=v1&customerId=c2',
      headers: auth,
    });
    expect(yiji.calls.getOrders).toBe(2);
  });

  it('serves the answer when the cache itself is down', async () => {
    // Redis being unreachable must degrade to today's behaviour, not to an error.
    const yiji = fakeYiji();
    const broken = {
      get: vi.fn(async () => {
        throw new Error('redis down');
      }),
      set: vi.fn(async () => {
        throw new Error('redis down');
      }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = await build(yiji.client, broken as any);
    const res = await app.inject({
      method: 'GET',
      url: '/commerce/inbox?vendorId=v1&customerId=c1',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.orders.length).toBeGreaterThan(0);
  });

  it('does not cache a failure', async () => {
    // Caching a transient upstream error turns one bad second into a bad minute.
    let attempts = 0;
    const flaky = {
      ...fakeYiji().client,
      getOrders: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('upstream blip');
        return [{ orderId: 'O-9' }];
      },
      getOrder: async (_v: string, id: string) => order(id),
    };
    const app = await build(flaky, fakeRedis());
    const first = await app.inject({
      method: 'GET',
      url: '/commerce/inbox?vendorId=v1&customerId=c1',
      headers: auth,
    });
    expect(first.statusCode).toBe(500);
    const second = await app.inject({
      method: 'GET',
      url: '/commerce/inbox?vendorId=v1&customerId=c1',
      headers: auth,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().data.orders[0].orderId).toBe('O-9');
  });
});
