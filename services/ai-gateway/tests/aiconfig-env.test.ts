import { afterEach, describe, expect, it } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { AiConfigStore } from '../src/aiconfig/index.js';

/* Staging and production share one Redis cluster. The AI settings used to be
   one bare key, so a switch flipped in the STAGING admin portal flipped it in
   production too (found 2026-10-14). */
const saved = process.env.REDIS_NAMESPACE;
afterEach(() => {
  process.env.REDIS_NAMESPACE = saved;
});

describe('AI settings are per environment', () => {
  it('a setting saved on staging does not reach production', async () => {
    const redis = new RedisMock() as unknown as Redis;
    await redis.flushall();
    const store = new AiConfigStore(redis);
    process.env.REDIS_NAMESPACE = 'yiji-staging';
    await store.set({ autoReply: true, suggestReply: false });
    process.env.REDIS_NAMESPACE = 'yiji-prod';
    const prod = await store.get();
    expect(prod.autoReply).toBe(false);
    expect(prod.suggestReply).toBe(true);
  });

  it('production keeps what it had: the old shared key is read until it saves', async () => {
    const redis = new RedisMock() as unknown as Redis;
    await redis.flushall();
    await redis.set('ai:config:global', JSON.stringify({ monthlyCap: 777, summarize: false }));
    process.env.REDIS_NAMESPACE = 'yiji-prod';
    const prod = await new AiConfigStore(redis).get();
    expect(prod.monthlyCap).toBe(777);
    expect(prod.summarize).toBe(false);
  });
});
