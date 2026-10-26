import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import {
  ConnectorRegistry,
  EnvVendorSettingsSource,
  StaticVendorDirectory,
  YijiConnector,
  YijiUnavailableError,
  isYijiUnavailable,
  type YijiClient,
} from '@yiji/shared-types';
import { registerCommerceRoutes, nationalPhone } from '../src/commerce/index.js';
import { COMMERCE_TTL, CommerceCache } from '../src/commerce/cache.js';
import { SlidingWindowLimiter } from '../src/ratelimit/index.js';
import type { CallerVerifierDeps } from '../src/auth/index.js';

/*
 * INCIDENT 2026-10-26: the coupon page asked customer-exists once per card and
 * again on every refocus; ~3,800 lookups in 25 minutes rate-limited our egress
 * at Yiji and took the late-orders TV down with it. These are the server-side
 * guarantees that make the next such page harmless.
 */

let redis: Redis;
beforeEach(async () => {
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
});

const ttlOf = (key: string) => redis.ttl(`commerce:${key}`);

describe('CommerceCache', () => {
  it('caches a YES for the long TTL and a NO for the short one', async () => {
    const cache = new CommerceCache(redis);
    const opts = { negativeTtlSeconds: 900, isNegative: (v: { exists: boolean }) => !v.exists };
    await cache.wrap(['c', 'yes'], 43_200, async () => ({ exists: true }), opts);
    await cache.wrap(['c', 'no'], 43_200, async () => ({ exists: false }), opts);
    expect(await ttlOf('c:yes')).toBeGreaterThan(43_000);
    const noTtl = await ttlOf('c:no');
    expect(noTtl).toBeGreaterThan(800);
    expect(noTtl).toBeLessThanOrEqual(900);
  });

  it('remembers a FAILURE briefly and answers repeats without asking upstream', async () => {
    const cache = new CommerceCache(redis);
    const fetcher = vi.fn(async () => {
      throw new YijiUnavailableError('timed out after 6000ms');
    });
    await expect(cache.wrap(['f'], 300, fetcher, { failTtlSeconds: 60 })).rejects.toSatisfy(
      isYijiUnavailable,
    );
    for (let i = 0; i < 5; i++) {
      await expect(cache.wrap(['f'], 300, fetcher, { failTtlSeconds: 60 })).rejects.toSatisfy(
        isYijiUnavailable,
      );
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
    const ttl = await ttlOf('f');
    expect(ttl).toBeGreaterThan(50);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it('does NOT remember a failure unless asked to, nor a non-Yiji error', async () => {
    const cache = new CommerceCache(redis);
    const boom = vi.fn(async () => {
      throw new YijiUnavailableError('down');
    });
    await expect(cache.wrap(['x'], 60, boom)).rejects.toThrow();
    await expect(cache.wrap(['x'], 60, boom)).rejects.toThrow();
    expect(boom).toHaveBeenCalledTimes(2);
    const bug = vi.fn(async () => {
      throw new TypeError('a bug');
    });
    await expect(cache.wrap(['y'], 60, bug, { failTtlSeconds: 60 })).rejects.toThrow(TypeError);
    await expect(cache.wrap(['y'], 60, bug, { failTtlSeconds: 60 })).rejects.toThrow(TypeError);
    expect(bug).toHaveBeenCalledTimes(2);
  });

  it('single-flight in ONE task: concurrent identical asks make one call', async () => {
    const cache = new CommerceCache(redis);
    let resolve!: (v: number) => void;
    const fetcher = vi.fn(() => new Promise<number>((r) => (resolve = r)));
    const all = Promise.all(Array.from({ length: 20 }, () => cache.wrap(['s'], 60, fetcher)));
    await new Promise((r) => setTimeout(r, 10));
    resolve(7);
    expect(await all).toEqual(Array(20).fill(7));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('single-flight ACROSS tasks: the second task waits for the first one’s answer', async () => {
    const taskA = new CommerceCache(redis);
    const taskB = new CommerceCache(redis);
    let resolve!: (v: string) => void;
    const slow = vi.fn(() => new Promise<string>((r) => (resolve = r)));
    const other = vi.fn(async () => 'B asked too');
    const a = taskA.wrap(['lo'], 60, slow, { lockMs: 2_000 });
    await new Promise((r) => setTimeout(r, 20));
    const b = taskB.wrap(['lo'], 60, other, { lockMs: 2_000 });
    await new Promise((r) => setTimeout(r, 50));
    resolve('A answered');
    expect(await a).toBe('A answered');
    expect(await b).toBe('A answered');
    expect(other).not.toHaveBeenCalled();
  });

  it('across tasks, the waiter is told the failure too (it does not ask again)', async () => {
    const taskA = new CommerceCache(redis);
    const taskB = new CommerceCache(redis);
    let reject!: (e: unknown) => void;
    const failing = () => new Promise<string>((_, r) => (reject = r));
    const other = vi.fn(async () => 'B asked too');
    const opts = { lockMs: 2_000, failTtlSeconds: 30 };
    const a = taskA.wrap(['lf'], 60, failing, opts).catch((e) => e);
    await new Promise((r) => setTimeout(r, 20));
    const b = taskB.wrap(['lf'], 60, other, opts).catch((e) => e);
    await new Promise((r) => setTimeout(r, 50));
    reject(new YijiUnavailableError('HTTP 429'));
    expect(isYijiUnavailable(await a)).toBe(true);
    expect(isYijiUnavailable(await b)).toBe(true);
    expect(other).not.toHaveBeenCalled();
  });

  it('releases its lock, so the next miss can ask', async () => {
    const cache = new CommerceCache(redis);
    await cache.wrap(['rel'], 1, async () => 1, { lockMs: 5_000 });
    expect(await redis.get('commerce:rel:lock')).toBeNull();
  });
});

describe('nationalPhone', () => {
  it('gives every spelling of one number one key', () => {
    expect(nationalPhone('0501234567')).toBe('501234567');
    expect(nationalPhone('+966 50 123 4567')).toBe('501234567');
    expect(nationalPhone('966501234567')).toBe('501234567');
    expect(nationalPhone('501234567')).toBe('501234567');
  });
});

/* ── The routes ───────────────────────────────────────────────────── */

const auth = (token = 'tok-1') => ({ authorization: `Bearer ${token}` });
const directus: CallerVerifierDeps & { lateDeliveryThreshold(): Promise<number> } = {
  async whoAmI(token: string) {
    return token.startsWith('tok-') ? { id: `user-${token.slice(4)}`, role: 'role-agent' } : null;
  },
  async adminRoleIds() {
    return new Set(['role-admin']);
  },
  async lateDeliveryThreshold() {
    return 60;
  },
};

/** One Yiji vendor (`v1`, also the legacy default) over a fake client + phone finder. */
function connectorsFor(client: Record<string, unknown>) {
  const { findCustomerIdByPhone, ...rest } = client as {
    findCustomerIdByPhone?: (phone: string) => Promise<string | null>;
  };
  return new ConnectorRegistry({
    directory: new StaticVendorDirectory([
      { platformVendorId: 'v1', platform: 'yiji', status: 'active' },
    ]),
    settings: new EnvVendorSettingsSource({ platform: 'yiji', client: {} }),
    factories: {
      yiji: (vendor, settings) =>
        new YijiConnector(vendor, settings, {
          client: rest as unknown as YijiClient,
          ...(findCustomerIdByPhone ? { findCustomerIdByPhone } : {}),
        }),
    },
  });
}

async function build(
  client: Record<string, unknown>,
  extra: Partial<Parameters<typeof registerCommerceRoutes>[1]> = {},
) {
  const app = Fastify();
  await registerCommerceRoutes(app, {
    directus,
    connectors: connectorsFor(client),
    cache: new CommerceCache(redis),
    ...extra,
  });
  return app;
}

describe('/commerce/customer-exists (the route that flooded Yiji)', () => {
  it('378 cards, every spelling, every refocus: ONE Yiji lookup per number', async () => {
    const findCustomerIdByPhone = vi.fn(async () => 'yiji-user-1');
    const app = await build({ findCustomerIdByPhone });
    const phones = ['0501234567', '+966501234567', '966 50 123 4567'];
    const res = await Promise.all(
      Array.from({ length: 378 }, (_, i) =>
        app.inject({
          method: 'GET',
          url: `/commerce/customer-exists?phone=${encodeURIComponent(phones[i % 3]!)}`,
          headers: auth(),
        }),
      ),
    );
    expect(res.every((r) => r.statusCode === 200)).toBe(true);
    expect(res[0]!.json()).toEqual({
      data: { configured: true, exists: true, customerId: 'yiji-user-1' },
    });
    expect(findCustomerIdByPhone).toHaveBeenCalledTimes(1);
  });

  it('caches a NO for the short TTL', async () => {
    const app = await build({ findCustomerIdByPhone: async () => null });
    const r = await app.inject({
      method: 'GET',
      url: '/commerce/customer-exists?phone=0509999999',
      headers: auth(),
    });
    expect(r.json().data.exists).toBe(false);
    const ttl = await redis.ttl('commerce:customer-exists:-:509999999');
    expect(ttl).toBeGreaterThan(COMMERCE_TTL.customerMissing - 10);
    expect(ttl).toBeLessThanOrEqual(COMMERCE_TTL.customerMissing);
  });

  it('a failing Yiji is asked once, then answered 504 from memory for 60 s', async () => {
    const findCustomerIdByPhone = vi.fn(async () => {
      throw new YijiUnavailableError('timed out after 6000ms');
    });
    const app = await build({ findCustomerIdByPhone });
    for (let i = 0; i < 4; i++) {
      const r = await app.inject({
        method: 'GET',
        url: '/commerce/customer-exists?phone=0501111111',
        headers: auth(),
      });
      expect(r.statusCode).toBe(504);
    }
    expect(findCustomerIdByPhone).toHaveBeenCalledTimes(1);
  });

  it('without the admin credential nothing is asked or cached: configured=false', async () => {
    const app = await build({});
    const r = await app.inject({
      method: 'GET',
      url: '/commerce/customer-exists?phone=0501234567',
      headers: auth(),
    });
    expect(r.json().data).toEqual({ configured: false, exists: false, customerId: null });
    expect(await redis.keys('commerce:customer-exists*')).toEqual([]);
  });
});

describe('per-caller limits', () => {
  it('one user over the lookup budget gets 429 - another user is unaffected', async () => {
    const findCustomerIdByPhone = vi.fn(async () => null);
    const app = await build(
      { findCustomerIdByPhone },
      { lookupLimiter: new SlidingWindowLimiter(redis, 60_000, 3, 'rl:test-lookup') },
    );
    const ask = (i: number, token: string) =>
      app.inject({
        method: 'GET',
        url: `/commerce/customer-exists?phone=05000000${10 + i}`,
        headers: auth(token),
      });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await ask(i, 'tok-1')).statusCode);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    const limited = await ask(9, 'tok-1');
    expect(limited.json()).toMatchObject({ error: 'rate_limited', scope: 'lookup' });
    expect(limited.json().retryAfterMs).toBeGreaterThan(0);
    expect((await ask(0, 'tok-2')).statusCode).toBe(200);
    /* The refused ones never reached Yiji, and user 2's number was already
       cached from user 1's first ask. */
    expect(findCustomerIdByPhone).toHaveBeenCalledTimes(3);
  });

  it('the commerce budget covers every route', async () => {
    const app = await build(
      { getOrder: async () => null },
      { callerLimiter: new SlidingWindowLimiter(redis, 60_000, 2, 'rl:test-commerce') },
    );
    const ask = () =>
      app.inject({ method: 'GET', url: '/commerce/order?vendorId=v1&orderId=42', headers: auth() });
    expect((await ask()).statusCode).toBe(200);
    expect((await ask()).statusCode).toBe(200);
    const third = await ask();
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({ error: 'rate_limited', scope: 'commerce' });
  });

  it('a limiter that cannot answer lets the request through', async () => {
    const app = await build(
      { getOrder: async () => null },
      { callerLimiter: { check: () => Promise.reject(new Error('redis down')) } },
    );
    const r = await app.inject({
      method: 'GET',
      url: '/commerce/order?vendorId=v1&orderId=42',
      headers: auth(),
    });
    expect(r.statusCode).toBe(200);
  });

  it('auth still comes first: no session, no budget spent', async () => {
    const check = vi.fn(async () => ({ allowed: true, resetAt: 0 }));
    const app = await build({ getOrder: async () => null }, { callerLimiter: { check } });
    const r = await app.inject({ method: 'GET', url: '/commerce/order?vendorId=v1&orderId=42' });
    expect(r.statusCode).toBe(401);
    expect(check).not.toHaveBeenCalled();
  });
});

describe('the late-orders fallback cannot multiply', () => {
  it('a failing Yiji is asked once; the screens polling after it get 504 from memory', async () => {
    const getLateDeliveryOrders = vi.fn(async () => {
      throw new YijiUnavailableError('HTTP 429');
    });
    const app = await build({ getLateDeliveryOrders });
    for (let i = 0; i < 6; i++) {
      const r = await app.inject({
        method: 'GET',
        url: '/commerce/late-orders',
        headers: auth(`tok-${i}`),
      });
      expect(r.statusCode).toBe(504);
    }
    expect(getLateDeliveryOrders).toHaveBeenCalledTimes(1);
  });

  it('a failing timeline is not re-asked by the next service-times batch', async () => {
    const getOrderTimeline = vi.fn(async () => {
      throw new YijiUnavailableError('timed out');
    });
    const app = await build({ getOrderTimeline });
    for (let i = 0; i < 3; i++) {
      const r = await app.inject({
        method: 'GET',
        url: '/commerce/service-times?orderIds=1,2',
        headers: auth(),
      });
      expect(r.statusCode).toBe(200);
      expect(r.json().data).toEqual({ '1': {}, '2': {} });
    }
    expect(getOrderTimeline).toHaveBeenCalledTimes(2);
  });
});
