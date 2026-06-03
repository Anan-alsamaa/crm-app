import { describe, expect, it, beforeEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import { SlidingWindowLimiter, MonthlyCap } from '../src/ratelimit/index.js';
import { ResponseCache } from '../src/cache/index.js';
import type { Redis } from 'ioredis';

describe('SlidingWindowLimiter', () => {
  let redis: Redis;
  beforeEach(async () => {
    redis = new RedisMock() as unknown as Redis;
    await redis.flushall();
  });

  it('allows up to the limit then rejects', async () => {
    const limiter = new SlidingWindowLimiter(redis, 60_000, 3);
    const verdicts = await Promise.all([
      limiter.check('u1'),
      limiter.check('u1'),
      limiter.check('u1'),
      limiter.check('u1'),
    ]);
    expect(verdicts.slice(0, 3).every((v) => v.allowed)).toBe(true);
    expect(verdicts[3]?.allowed).toBe(false);
    expect(verdicts[3]?.count).toBe(3);
  });

  it('scopes per key', async () => {
    const limiter = new SlidingWindowLimiter(redis, 60_000, 2);
    expect((await limiter.check('a')).allowed).toBe(true);
    expect((await limiter.check('a')).allowed).toBe(true);
    expect((await limiter.check('a')).allowed).toBe(false);
    // Different scope — fresh budget
    expect((await limiter.check('b')).allowed).toBe(true);
  });

  it('returns resetAt so callers can surface retry-after', async () => {
    const limiter = new SlidingWindowLimiter(redis, 60_000, 1);
    await limiter.check('u');
    const v = await limiter.check('u');
    expect(v.allowed).toBe(false);
    expect(v.resetAt).toBeGreaterThan(Date.now());
  });
});

describe('MonthlyCap', () => {
  let redis: Redis;
  beforeEach(async () => {
    redis = new RedisMock() as unknown as Redis;
    await redis.flushall();
  });

  it('allows under cap, blocks over', async () => {
    const cap = new MonthlyCap(redis);
    const r1 = await cap.tryConsume('vendor-1', 3);
    const r2 = await cap.tryConsume('vendor-1', 3);
    const r3 = await cap.tryConsume('vendor-1', 3);
    const r4 = await cap.tryConsume('vendor-1', 3);
    expect([r1.allowed, r2.allowed, r3.allowed, r4.allowed]).toEqual([true, true, true, false]);
    expect(r4.used).toBe(3);
  });

  it('cap=0 means unlimited but still tracks usage', async () => {
    const cap = new MonthlyCap(redis);
    for (let i = 0; i < 5; i++) {
      const r = await cap.tryConsume('v', 0);
      expect(r.allowed).toBe(true);
    }
    expect(await cap.currentUsage('v')).toBe(5);
  });

  it('rolled-back failed attempt does not consume budget', async () => {
    const cap = new MonthlyCap(redis);
    await cap.tryConsume('v', 1);
    await cap.tryConsume('v', 1); // rejected, rolled back
    await cap.tryConsume('v', 1); // still rejected
    expect(await cap.currentUsage('v')).toBe(1);
  });
});

describe('ResponseCache', () => {
  let redis: Redis;
  beforeEach(async () => {
    redis = new RedisMock() as unknown as Redis;
    await redis.flushall();
  });

  it('round-trips a value keyed by endpoint + input', async () => {
    const cache = new ResponseCache(redis);
    await cache.set('/summarize', 'hello world', { summary: 'hi' });
    const hit = await cache.get<{ summary: string }>('/summarize', 'hello world');
    expect(hit).toEqual({ summary: 'hi' });
  });

  it('misses when input differs', async () => {
    const cache = new ResponseCache(redis);
    await cache.set('/summarize', 'A', { summary: 'a' });
    expect(await cache.get('/summarize', 'B')).toBeNull();
  });

  it('misses when endpoint differs', async () => {
    const cache = new ResponseCache(redis);
    await cache.set('/summarize', 'A', { summary: 'a' });
    expect(await cache.get('/sentiment', 'A')).toBeNull();
  });

  it('respects custom TTL (set EX is applied)', async () => {
    const cache = new ResponseCache(redis, 1);
    await cache.set('/x', 'k', { v: 1 });
    const key = cache.key('/x', 'k');
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(1);
  });
});
