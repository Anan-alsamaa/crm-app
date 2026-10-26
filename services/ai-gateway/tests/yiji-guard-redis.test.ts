import { beforeEach, describe, expect, it } from 'vitest';
import RedisMock from 'ioredis-mock';
import {
  RedisYijiGuardStore,
  YijiShedError,
  createYijiOutboundGuard,
  resolveYijiGuardLimits,
  type YijiGuardEvent,
  type YijiGuardRedis,
} from '@yiji/shared-types';

/*
 * The SHARED store's Lua, run for real (ioredis-mock executes Lua). Two guards
 * on one Redis stand in for two service tasks: the budget and the breaker must
 * be ONE across them, or N tasks would be N budgets.
 */

const T0 = Date.UTC(2026, 9, 26, 13, 0, 0, 0);

describe('RedisYijiGuardStore', () => {
  let redis: YijiGuardRedis & { flushall(): Promise<unknown>; keys(p: string): Promise<string[]> };

  beforeEach(async () => {
    redis = new RedisMock() as never;
    await redis.flushall();
  });

  it('enforces the per-class minute ceilings across tasks', async () => {
    const limits = resolveYijiGuardLimits({
      perSecond: 1_000,
      perMinute: 10,
      normalPerMinute: 6,
      lowPerMinute: 2,
      lowPerSecond: 1_000,
    });
    const a = new RedisYijiGuardStore(redis, 'test');
    const b = new RedisYijiGuardStore(redis, 'test');
    expect(await a.take('low', T0, limits, false)).toEqual({ ok: true });
    expect(await b.take('low', T0, limits, false)).toEqual({ ok: true });
    expect(await a.take('low', T0, limits, false)).toMatchObject({ ok: false, reason: 'minute' });
    for (let i = 0; i < 4; i++) expect((await b.take('normal', T0, limits, false)).ok).toBe(true);
    expect(await a.take('normal', T0, limits, false)).toMatchObject({
      ok: false,
      reason: 'minute',
    });
    /* Critical is never refused by a minute ceiling... */
    for (let i = 0; i < 6; i++) expect((await a.take('critical', T0, limits, false)).ok).toBe(true);
    /* ...and a new minute is a new budget. */
    expect((await a.take('low', T0 + 60_000, limits, false)).ok).toBe(true);
  });

  it('enforces the per-second ceilings; force always counts', async () => {
    const limits = resolveYijiGuardLimits({ perSecond: 2, lowPerSecond: 1 });
    const s = new RedisYijiGuardStore(redis, 'test');
    expect((await s.take('low', T0, limits, false)).ok).toBe(true);
    expect(await s.take('low', T0, limits, false)).toMatchObject({ ok: false, reason: 'second' });
    expect((await s.take('critical', T0, limits, false)).ok).toBe(true);
    expect(await s.take('critical', T0, limits, false)).toMatchObject({ reason: 'second' });
    expect((await s.take('critical', T0, limits, true)).ok).toBe(true);
  });

  it('the breaker: opened once, extended never shortened, critical passes, settles once', async () => {
    const limits = resolveYijiGuardLimits();
    const s = new RedisYijiGuardStore(redis, 'test');
    expect(await s.open(T0, 60_000, 'HTTP 429')).toBe(true);
    expect(await s.open(T0, 10_000, 'HTTP 429')).toBe(false);
    const shed = await s.take('normal', T0, limits, false);
    expect(shed).toMatchObject({ ok: false, reason: 'breaker' });
    expect((shed as { retryInMs: number }).retryInMs).toBeGreaterThan(50_000);
    expect((await s.take('critical', T0, limits, false)).ok).toBe(true);
    expect(await s.settle()).toBe('open');
  });

  it('settles exactly once after the cool-down runs out', async () => {
    const s = new RedisYijiGuardStore(redis, 'test');
    expect(await s.settle()).toBe('closed');
    await s.open(T0, 40, 'HTTP 429');
    await new Promise((r) => setTimeout(r, 80));
    expect(await s.settle()).toBe('closed-now');
    expect(await s.settle()).toBe('closed');
  });

  it('counts failures per window', async () => {
    const s = new RedisYijiGuardStore(redis, 'test');
    expect(await s.fail(T0, 30)).toBe(1);
    expect(await s.fail(T0 + 1_000, 30)).toBe(2);
    expect(await s.fail(T0 + 30_000, 30)).toBe(1);
  });

  it('keeps every key under ONE hash tag (a cluster runs the scripts on one slot)', async () => {
    const s = new RedisYijiGuardStore(redis, 'prod');
    await s.take('low', T0, resolveYijiGuardLimits(), false);
    await s.open(T0, 60_000, 'x');
    await s.fail(T0, 30);
    const keys = await redis.keys('*');
    expect(keys.length).toBeGreaterThan(3);
    expect(keys.every((k) => k.startsWith('{yiji-guard:prod}:'))).toBe(true);
  });

  it('two gateway tasks share one breaker: a 429 seen by one stops the other', async () => {
    const events: YijiGuardEvent[] = [];
    const mk = () =>
      createYijiOutboundGuard({
        service: 'ai-gateway',
        store: new RedisYijiGuardStore(redis, 'test'),
        onEvent: (e) => events.push(e),
      });
    const one = mk();
    const two = mk();
    one.observe('customer.lookup', { status: 429, retryAfter: '60' });
    two.observe('customer.lookup', { status: 429, retryAfter: '60' });
    await new Promise((r) => setTimeout(r, 20));
    await expect(two.admit('order.lookup')).rejects.toBeInstanceOf(YijiShedError);
    /* Reported once for the whole fleet, not once per task or per call. */
    expect(events.filter((e) => e.type === 'breaker_open')).toHaveLength(1);
  });
});
