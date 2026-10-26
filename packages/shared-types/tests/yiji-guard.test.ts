import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_YIJI_GUARD_LIMITS,
  HttpYijiClient,
  MemoryYijiGuardStore,
  YijiShedError,
  createYijiOutboundGuard,
  currentYijiOutboundGuard,
  fetchWithYijiUsage,
  installYijiOutboundGuard,
  isYijiGuardOperation,
  isYijiShed,
  isYijiUnavailable,
  resolveYijiGuardLimits,
  retryAfterMs,
  setYijiOutboundGuard,
  yijiGuardLimitsFromEnv,
  yijiPriorityFor,
  type YijiGuardEvent,
  type YijiGuardStore,
} from '../src/index.js';

/** A clock the test moves; `sleep` advances it instead of waiting. */
function clock(start = Date.UTC(2026, 9, 26, 13, 0, 0, 0)) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

function guardWith(
  limits: Partial<typeof DEFAULT_YIJI_GUARD_LIMITS> = {},
  opts: { store?: YijiGuardStore; service?: 'ai-gateway' | 'workers' | 'socket-gateway' } = {},
) {
  const c = clock();
  const events: YijiGuardEvent[] = [];
  const guard = createYijiOutboundGuard({
    service: opts.service ?? 'ai-gateway',
    limits,
    now: c.now,
    sleep: c.sleep,
    onEvent: (e) => events.push(e),
    ...(opts.store ? { store: opts.store } : {}),
  });
  return { guard, c, events };
}

/** Let the observe() fire-and-forget work settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => setYijiOutboundGuard(null));

describe('yijiPriorityFor', () => {
  it('makes the UI phone lookup LOW and everything the workers do critical', () => {
    expect(yijiPriorityFor('ai-gateway', 'customer.lookup')).toBe('low');
    expect(yijiPriorityFor('ai-gateway', 'order.history')).toBe('normal');
    expect(yijiPriorityFor('ai-gateway', 'order.late_poll')).toBe('normal');
    expect(yijiPriorityFor('workers', 'order.late_poll')).toBe('critical');
    expect(yijiPriorityFor('workers', 'coupon.push')).toBe('critical');
    expect(yijiPriorityFor('workers', 'coupon.remove')).toBe('critical');
    /* The signup watch repeats it per held coupon: bounded, and a refusal is a retry. */
    expect(yijiPriorityFor('workers', 'customer.lookup')).toBe('normal');
    expect(yijiPriorityFor('socket-gateway', 'user.lookup')).toBe('critical');
    expect(yijiPriorityFor('socket-gateway', 'order.by_user')).toBe('normal');
    /* Refusing a login would refuse the call it was made for. */
    expect(yijiPriorityFor('ai-gateway', 'login')).toBe('critical');
  });
});

describe('limits', () => {
  it('reads env, ignoring junk and non-positive values', () => {
    const l = yijiGuardLimitsFromEnv({
      YIJI_BUDGET_PER_MIN: '200',
      YIJI_BUDGET_LOW_PER_MIN: 'lots',
      YIJI_BUDGET_PER_SEC: '0',
      YIJI_BREAKER_COOLDOWN_SEC: '-5',
    });
    expect(l.perMinute).toBe(200);
    expect(l.lowPerMinute).toBe(DEFAULT_YIJI_GUARD_LIMITS.lowPerMinute);
    expect(l.perSecond).toBe(DEFAULT_YIJI_GUARD_LIMITS.perSecond);
    expect(l.breakerCooldownSec).toBe(DEFAULT_YIJI_GUARD_LIMITS.breakerCooldownSec);
  });

  it('keeps low <= normal <= overall', () => {
    const l = resolveYijiGuardLimits({ perMinute: 20, normalPerMinute: 50, lowPerMinute: 40 });
    expect(l.normalPerMinute).toBe(20);
    expect(l.lowPerMinute).toBe(20);
  });

  it('defaults stay well under the ~150/min that tripped Yiji', () => {
    expect(DEFAULT_YIJI_GUARD_LIMITS.perMinute).toBeLessThanOrEqual(100);
    expect(DEFAULT_YIJI_GUARD_LIMITS.lowPerMinute).toBeLessThan(
      DEFAULT_YIJI_GUARD_LIMITS.normalPerMinute,
    );
  });
});

describe('retryAfterMs', () => {
  it('reads delta-seconds and HTTP dates', () => {
    const now = Date.UTC(2026, 9, 26, 13, 0, 0);
    expect(retryAfterMs('120', now)).toBe(120_000);
    expect(retryAfterMs(new Date(now + 30_000).toUTCString(), now)).toBe(30_000);
    expect(retryAfterMs(null, now)).toBeNull();
    expect(retryAfterMs('soon', now)).toBeNull();
  });
});

describe('the budget', () => {
  it('sheds LOW at once when its minute is used up - no queueing', async () => {
    const { guard } = guardWith({ lowPerMinute: 3, lowPerSecond: 100 });
    for (let i = 0; i < 3; i++) await guard.admit('customer.lookup');
    const err = await guard.admit('customer.lookup').catch((e) => e);
    expect(isYijiShed(err)).toBe(true);
    expect(isYijiUnavailable(err)).toBe(true);
    expect((err as YijiShedError).reason).toBe('budget');
    expect((err as YijiShedError).priority).toBe('low');
  });

  it('sheds LOW past its per-second rate', async () => {
    const { guard } = guardWith({ lowPerSecond: 2 });
    await guard.admit('customer.lookup');
    await guard.admit('customer.lookup');
    await expect(guard.admit('customer.lookup')).rejects.toBeInstanceOf(YijiShedError);
  });

  it('a flood of LOW lookups cannot starve normal or critical work', async () => {
    const { guard } = guardWith({ lowPerMinute: 5, lowPerSecond: 100, perSecond: 1_000 });
    const results = await Promise.allSettled(
      Array.from({ length: 378 }, () => guard.admit('customer.lookup')),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    await expect(guard.admit('order.lookup')).resolves.toBeUndefined();
    const workers = createYijiOutboundGuard({ service: 'workers', limits: {} });
    await expect(workers.admit('order.late_poll')).resolves.toBeUndefined();
  });

  it('NORMAL waits for the next second, then goes', async () => {
    const { guard, c } = guardWith({ perSecond: 2, normalWaitMs: 2_000 });
    await guard.admit('order.lookup');
    await guard.admit('order.lookup');
    const before = c.now();
    await guard.admit('order.lookup');
    expect(c.now()).toBeGreaterThan(before);
  });

  it('NORMAL is refused when the wait would exceed its budget', async () => {
    const { guard } = guardWith({ normalPerMinute: 2, normalWaitMs: 2_000 });
    await guard.admit('order.lookup');
    await guard.admit('order.lookup');
    const err = await guard.admit('order.lookup').catch((e) => e);
    expect(err).toBeInstanceOf(YijiShedError);
    expect((err as YijiShedError).retryAfterMs).toBeGreaterThan(0);
  });

  it('CRITICAL is never refused: past the minute ceiling it still goes', async () => {
    const { guard } = guardWith({ perMinute: 3, perSecond: 1_000 }, { service: 'workers' });
    for (let i = 0; i < 10; i++) await guard.admit('coupon.push');
  });

  it('CRITICAL waits for a free second, then goes anyway', async () => {
    const { guard, c } = guardWith({ perSecond: 1, criticalWaitMs: 500 }, { service: 'workers' });
    await guard.admit('order.late_poll');
    const before = c.now();
    await guard.admit('order.late_poll');
    expect(c.now()).toBeGreaterThanOrEqual(before);
  });

  it('critical traffic consumes the headroom normal sees', async () => {
    const store = new MemoryYijiGuardStore();
    const c = clock();
    const limits = { perMinute: 4, normalPerMinute: 4, perSecond: 100, normalWaitMs: 0 };
    const workers = createYijiOutboundGuard({ service: 'workers', store, limits, now: c.now });
    const gateway = createYijiOutboundGuard({ service: 'ai-gateway', store, limits, now: c.now });
    for (let i = 0; i < 4; i++) await workers.admit('order.late_poll');
    await expect(gateway.admit('order.lookup')).rejects.toBeInstanceOf(YijiShedError);
  });

  it('a new minute is a new budget', async () => {
    const { guard, c } = guardWith({ lowPerMinute: 1 });
    await guard.admit('customer.lookup');
    await expect(guard.admit('customer.lookup')).rejects.toBeInstanceOf(YijiShedError);
    c.advance(60_000);
    await expect(guard.admit('customer.lookup')).resolves.toBeUndefined();
  });

  it('reports shedding at most once a minute, with counts', async () => {
    const { guard, c, events } = guardWith({ lowPerMinute: 1 });
    await guard.admit('customer.lookup');
    for (let i = 0; i < 20; i++) await guard.admit('customer.lookup').catch(() => undefined);
    expect(events.filter((e) => e.type === 'shedding')).toHaveLength(1);
    c.advance(61_000);
    await guard.admit('customer.lookup');
    await guard.admit('customer.lookup').catch(() => undefined);
    const shedding = events.filter((e) => e.type === 'shedding');
    expect(shedding).toHaveLength(2);
    /* The second summary carries the 19 refused since the first. */
    expect(shedding[1]).toMatchObject({ counts: { 'low:budget': 20 } });
  });
});

describe('the circuit breaker', () => {
  it('a 429 opens it: non-critical calls stop, critical ones carry on', async () => {
    const store = new MemoryYijiGuardStore();
    const c = clock();
    const events: YijiGuardEvent[] = [];
    const opts = {
      store,
      now: c.now,
      sleep: c.sleep,
      onEvent: (e: YijiGuardEvent) => events.push(e),
    };
    const gateway = createYijiOutboundGuard({ service: 'ai-gateway', ...opts });
    const workers = createYijiOutboundGuard({ service: 'workers', ...opts });

    await gateway.admit('customer.lookup');
    gateway.observe('customer.lookup', { status: 429, retryAfter: '120' });
    await flush();

    const err = await gateway.admit('order.lookup').catch((e) => e);
    expect(err).toBeInstanceOf(YijiShedError);
    expect((err as YijiShedError).reason).toBe('breaker');
    /* The late-orders poll keeps its pace. */
    await expect(workers.admit('order.late_poll')).resolves.toBeUndefined();
    expect(events.filter((e) => e.type === 'breaker_open')).toEqual([
      expect.objectContaining({ cooldownMs: 120_000, httpStatus: 429 }),
    ]);
  });

  it('honours Retry-After, and closes after it - reported ONCE each way', async () => {
    const { guard, c, events } = guardWith();
    guard.observe('order.lookup', { status: 429, retryAfter: '30' });
    guard.observe('order.lookup', { status: 429, retryAfter: '30' });
    await flush();
    await expect(guard.admit('order.lookup')).rejects.toBeInstanceOf(YijiShedError);
    c.advance(29_000);
    await expect(guard.admit('order.lookup')).rejects.toBeInstanceOf(YijiShedError);
    c.advance(2_000);
    await expect(guard.admit('order.lookup')).resolves.toBeUndefined();
    guard.observe('order.lookup', { status: 200 });
    guard.observe('order.lookup', { status: 200 });
    await flush();
    expect(events.filter((e) => e.type === 'breaker_open')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'breaker_closed')).toHaveLength(1);
  });

  it('uses the default cool-down without Retry-After, and never less than 10 s', async () => {
    const { guard, c, events } = guardWith({ breakerCooldownSec: 60 });
    guard.observe('order.lookup', { status: 429 });
    await flush();
    expect(events[0]).toMatchObject({ type: 'breaker_open', cooldownMs: 60_000 });
    const quick = guardWith();
    quick.guard.observe('order.lookup', { status: 429, retryAfter: '0' });
    await flush();
    expect(quick.events[0]).toMatchObject({ cooldownMs: 10_000 });
    c.advance(1);
  });

  it('caps a huge Retry-After at the maximum cool-down', async () => {
    const { guard, events } = guardWith({ breakerMaxCooldownSec: 600 });
    guard.observe('order.lookup', { status: 429, retryAfter: '86400' });
    await flush();
    expect(events[0]).toMatchObject({ cooldownMs: 600_000 });
  });

  it('a burst of timeouts opens it; a scattering does not', async () => {
    const { guard, c, events } = guardWith({ breakerFailures: 3, breakerWindowSec: 30 });
    guard.observe('order.lookup', { status: null });
    await flush();
    guard.observe('order.lookup', { status: 503 });
    await flush();
    expect(events).toHaveLength(0);
    guard.observe('order.lookup', { status: null });
    await flush();
    expect(events).toEqual([expect.objectContaining({ type: 'breaker_open' })]);

    const calm = guardWith({ breakerFailures: 3, breakerWindowSec: 30 });
    for (let i = 0; i < 5; i++) {
      calm.guard.observe('order.lookup', { status: null });
      await flush();
      calm.c.advance(16_000);
    }
    expect(calm.events).toHaveLength(0);
    c.advance(1);
  });

  it('a 4xx refusal is an answer, not a failure', async () => {
    const { guard, events } = guardWith({ breakerFailures: 1 });
    guard.observe('coupon.push', { status: 400 });
    guard.observe('coupon.push', { status: 403 });
    await flush();
    expect(events).toHaveLength(0);
  });
});

describe('a failing shared store', () => {
  it('falls back to a per-process budget (and says so once), never blocking a call', async () => {
    const broken: YijiGuardStore = {
      take: () => Promise.reject(new Error('redis down')),
      open: () => Promise.reject(new Error('redis down')),
      fail: () => Promise.reject(new Error('redis down')),
      settle: () => Promise.reject(new Error('redis down')),
    };
    const { guard, events } = guardWith({ lowPerMinute: 1 }, { store: broken });
    await guard.admit('customer.lookup');
    await expect(guard.admit('customer.lookup')).rejects.toBeInstanceOf(YijiShedError);
    expect(events.filter((e) => e.type === 'store_fallback')).toHaveLength(1);
  });

  it('a HANGING store times out instead of hanging the Yiji call', async () => {
    const hung: YijiGuardStore = {
      take: () => new Promise(() => undefined),
      open: () => new Promise(() => undefined),
      fail: () => new Promise(() => undefined),
      settle: () => new Promise(() => undefined),
    };
    const guard = createYijiOutboundGuard({ service: 'workers', store: hung, storeTimeoutMs: 5 });
    await expect(guard.admit('order.late_poll')).resolves.toBeUndefined();
  });
});

describe('installYijiOutboundGuard', () => {
  const log = { info: vi.fn(), warn: vi.fn() };

  it('installs a guard for the whole process', () => {
    const g = installYijiOutboundGuard({ service: 'workers', env: {}, log });
    expect(g).not.toBeNull();
    expect(currentYijiOutboundGuard()).toBe(g);
  });

  it('YIJI_GUARD=off installs none', () => {
    installYijiOutboundGuard({ service: 'workers', env: {}, log });
    expect(installYijiOutboundGuard({ service: 'workers', env: { YIJI_GUARD: 'off' }, log })).toBe(
      null,
    );
    expect(currentYijiOutboundGuard()).toBeNull();
  });

  it('records a breaker opening ONCE in yiji_api_usage, as guard bookkeeping', async () => {
    const onUsage = vi.fn();
    const g = installYijiOutboundGuard({ service: 'ai-gateway', env: {}, log, onUsage })!;
    g.observe('customer.lookup', { status: 429 });
    g.observe('customer.lookup', { status: 429 });
    await flush();
    expect(onUsage).toHaveBeenCalledTimes(1);
    const row = onUsage.mock.calls[0]![0];
    expect(row).toMatchObject({ operation: 'guard.breaker', outcome: 'error', httpStatus: 429 });
    expect(isYijiGuardOperation(row.operation)).toBe(true);
    expect(isYijiGuardOperation('customer.lookup')).toBe(false);
  });
});

describe('every outbound path passes the guard', () => {
  const okJson = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });

  it('HttpYijiClient: a refused call is never sent and reads as "could not ask"', async () => {
    const fetchSpy = vi.fn(async () => okJson([]));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const guard = createYijiOutboundGuard({ service: 'ai-gateway', limits: { lowPerMinute: 1 } });
      const client = new HttpYijiClient({
        baseUrl: 'https://order.example',
        adminUrl: 'https://admin.example',
        adminEmail: 'crm@example.com',
        adminPassword: 'pw',
        guard,
      });
      fetchSpy.mockImplementation(async (url: string) =>
        String(url).includes('/api/Account/login') ? okJson({ token: 't' }) : okJson([]),
      );
      await client.findCustomerIdByPhone('0501234567');
      const sent = fetchSpy.mock.calls.length;
      const err = await client.findCustomerIdByPhone('0507654321').catch((e) => e);
      expect(isYijiShed(err)).toBe(true);
      expect(isYijiUnavailable(err)).toBe(true);
      expect(fetchSpy.mock.calls.length).toBe(sent);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('HttpYijiClient: a 429 from Yiji opens the breaker (installed guard)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson({ title: 'slow down' }, 429, { 'retry-after': '45' })),
    );
    try {
      const events: YijiGuardEvent[] = [];
      setYijiOutboundGuard(
        createYijiOutboundGuard({ service: 'ai-gateway', onEvent: (e) => events.push(e) }),
      );
      const client = new HttpYijiClient({ baseUrl: 'https://order.example' });
      await expect(client.getOrder('1', '42')).rejects.toSatisfy(isYijiUnavailable);
      await flush();
      expect(events).toEqual([
        expect.objectContaining({ type: 'breaker_open', cooldownMs: 45_000 }),
      ]);
      await expect(client.getOrder('1', '43')).rejects.toSatisfy(isYijiShed);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('guard: null opts a client out of the installed guard', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson(null, 404)),
    );
    try {
      const refuseAll = {
        admit: () => Promise.reject(new YijiShedError('x', 'low', 'budget', 0)),
        observe: () => undefined,
      };
      setYijiOutboundGuard(refuseAll);
      const client = new HttpYijiClient({ baseUrl: 'https://order.example', guard: null });
      await expect(client.getOrder('1', '42')).resolves.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fetchWithYijiUsage (the direct push path) is guarded too', async () => {
    const doFetch = vi.fn(async () => new Response('{}', { status: 200 }));
    const refuseAll = {
      admit: () => Promise.reject(new YijiShedError('push.notify', 'normal', 'breaker', 1)),
      observe: vi.fn(),
    };
    setYijiOutboundGuard(refuseAll);
    const f = fetchWithYijiUsage(undefined, 'crm', doFetch as unknown as typeof fetch);
    await expect(f('https://notify.example/NotificationData/Send')).rejects.toSatisfy(isYijiShed);
    expect(doFetch).not.toHaveBeenCalled();

    const observe = vi.fn();
    setYijiOutboundGuard({ admit: async () => undefined, observe });
    await f('https://notify.example/NotificationData/Send');
    expect(observe).toHaveBeenCalledWith('push.notify', { status: 200, retryAfter: null });
  });
});
