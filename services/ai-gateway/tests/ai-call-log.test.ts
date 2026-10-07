import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { AI_ENDPOINTS } from '@yiji/shared-types';
import { registerAiRoutes } from '../src/routes.js';
import { AiConfigStore } from '../src/aiconfig/index.js';
import { SlidingWindowLimiter, MonthlyCap, DailyQuota } from '../src/ratelimit/index.js';
import { ResponseCache } from '../src/cache/index.js';
import { AiProviderError, type AIProvider } from '../src/provider/types.js';
import type { GatewayDirectus, ConversationContext } from '../src/directus/index.js';
import { estimateCostUsd, type AiCallRow } from '../src/usage-log.js';

/** Every AI call leaves a row: tokens, cost, latency, outcome (owner, 2026-10-07). */

const CONV: ConversationContext = {
  id: '11111111-1111-1111-1111-111111111111',
  status: 'open',
  priority: 'medium',
  vendor: 'v-1',
  contact: null,
  messages: [
    {
      id: 'm-1',
      sender_type: 'customer',
      content: 'Where is my order?',
      is_internal_note: false,
      date_created: '2026-10-07T10:00:00Z',
    },
  ],
};

async function build(provider: AIProvider) {
  const redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
  const rows: AiCallRow[] = [];
  const app = Fastify();
  await registerAiRoutes(app, {
    provider,
    logAiCall: async (r) => {
      rows.push(r);
    },
    directus: {
      getConversation: async () => CONV,
      whoAmI: async () => ({ id: 'agent-7', role: 'r' }),
      adminRoleIds: async () => new Set<string>(),
    } as unknown as GatewayDirectus,
    configStore: new AiConfigStore(redis),
    cache: new ResponseCache(redis, 60),
    perUserLimiter: new SlidingWindowLimiter(redis, 60_000, 100, 'rl:user'),
    globalLimiter: new SlidingWindowLimiter(redis, 60_000, 1000, 'rl:global'),
    monthlyCap: new MonthlyCap(redis),
    helpDailyQuota: new DailyQuota(redis),
  });
  const call = () =>
    app.inject({
      method: 'POST',
      url: AI_ENDPOINTS.summarizeConversation,
      headers: { authorization: 'Bearer t', 'x-yiji-vendor': 'v-1' },
      payload: { conversationId: CONV.id },
    });
  return { rows, call };
}

describe('AI call log', () => {
  it('records model, tokens, cost, agent and chat for a successful call', async () => {
    const { rows, call } = await build({
      name: 'gemini',
      run: async () => ({
        text: 'A summary.',
        model: 'gemini-2.5-flash',
        usage: { inputTokens: 1000, outputTokens: 200, thinkingTokens: 300 },
      }),
    });
    expect((await call()).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      endpoint: AI_ENDPOINTS.summarizeConversation,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      status: 'ok',
      input_tokens: 1000,
      output_tokens: 200,
      thinking_tokens: 300,
      user_id: 'agent-7',
      conversation_id: CONV.id,
    });
    // 1000 × $0.30/M + (200 + 300) × $2.50/M
    expect(rows[0]!.est_cost_usd).toBeCloseTo(0.0003 + 0.00125, 8);
  });

  it('records a failed call too, and a cached answer costs nothing so logs nothing', async () => {
    let fail = true;
    const { rows, call } = await build({
      name: 'gemini',
      run: async () => {
        if (fail) throw new AiProviderError('quota', 'rate_limited', 429);
        return { text: 'ok', model: 'gemini-2.5-flash' };
      },
    });
    expect((await call()).statusCode).toBe(429);
    fail = false;
    await call();
    await call(); // served from cache
    await new Promise((r) => setTimeout(r, 0));
    expect(rows.map((r) => r.status)).toEqual(['error', 'ok']);
    expect(rows[0]!.error_code).toBe('rate_limited');
  });

  it('prices unknown models as null rather than guessing', () => {
    expect(estimateCostUsd('mystery-model', { inputTokens: 5 })).toBeNull();
    expect(estimateCostUsd('gemini-2.5-flash', undefined)).toBeNull();
  });
});
