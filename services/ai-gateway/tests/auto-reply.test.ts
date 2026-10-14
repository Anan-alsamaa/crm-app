import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { AI_ENDPOINTS } from '@yiji/shared-types';
import { registerAiRoutes } from '../src/routes.js';
import { AiConfigStore } from '../src/aiconfig/index.js';
import { SlidingWindowLimiter, MonthlyCap, DailyQuota } from '../src/ratelimit/index.js';
import { ResponseCache } from '../src/cache/index.js';
import { preCheck, postCheck } from '../src/autoreply-guard.js';
import type { AIProvider, AiRunInput, AiRunOutput } from '../src/provider/types.js';
import type { GatewayDirectus, ConversationContext } from '../src/directus/index.js';

/* AI auto-reply, shadow mode (owner, 2026-10-13; docs/AI-AUTO-REPLY-PLAN.md). */

describe('hard limits - before the model', () => {
  it.each([
    ['I want to talk to a real person', 'asked_for_person'],
    ['ابي اكلم موظف', 'asked_for_person'],
    ['I want a refund', 'asked_for_compensation'],
    ['ابي تعويض', 'asked_for_compensation'],
    ['are you a bot?', 'asked_if_bot'],
    ['انت روبوت؟', 'asked_if_bot'],
  ])('%s -> %s', (text, reason) => {
    expect(preCheck(text)).toBe(reason);
  });

  it.each(['وين طلبي؟', 'Where is my order?', 'الطلب الي طلبته متاخر'])(
    'an ordinary question is left to the model: %s',
    (text) => {
      expect(preCheck(text)).toBeNull();
    },
  );
});

describe('hard limits - after the model', () => {
  it.each([
    ['We will send you a coupon for the trouble.', 'mentions_compensation'],
    ['سنقوم بتعويضك بكوبون خصم', 'mentions_compensation'],
    ["I'm a real person, not a bot.", 'claims_human'],
  ])('%s -> %s', (text, reason) => {
    expect(postCheck(text)).toBe(reason);
  });

  it('a plain status answer passes', () => {
    expect(postCheck('Your order left the branch and is on its way.')).toBeNull();
  });
});

const SVC = 'svc-token';
const CONV = '11111111-1111-1111-1111-111111111111';

class Stub implements AIProvider {
  readonly name = 'stub';
  calls: AiRunInput[] = [];
  reply = '';
  async run(input: AiRunInput): Promise<AiRunOutput> {
    this.calls.push(input);
    return { text: this.reply, model: 'stub-1' };
  }
}

function ctx(customerText: string): ConversationContext {
  return {
    id: CONV,
    status: 'open',
    priority: 'medium',
    vendor: 'v-1',
    contact: { id: 'c-1', name: 'Demo', email: null },
    messages: [
      {
        id: 'm-1',
        sender_type: 'customer',
        content: customerText,
        is_internal_note: false,
        date_created: '2026-10-13T10:00:00Z',
      },
    ],
  };
}

async function build(customerText: string, autoReply: boolean) {
  const redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
  const provider = new Stub();
  const configStore = new AiConfigStore(redis);
  if (autoReply) await configStore.set({ autoReply: true });
  const directus = {
    async getConversation() {
      return ctx(customerText);
    },
    async getAutoReplyContext() {
      return {
        knowledge: [{ title: 'Working hours', content: 'Support is open 09:00-04:00.' }],
        order: { id: '1314302', status: 'on the way' },
      };
    },
    async whoAmI(token: string) {
      return token === SVC ? { id: 'worker', role: 'role-svc' } : { id: 'u-1', role: 'r' };
    },
    async adminRoleIds() {
      return new Set<string>();
    },
  } as unknown as GatewayDirectus;
  const app = Fastify();
  await registerAiRoutes(app, {
    provider,
    directus,
    configStore,
    cache: new ResponseCache(redis, 60),
    perUserLimiter: new SlidingWindowLimiter(redis, 60_000, 100, 'rl:user'),
    globalLimiter: new SlidingWindowLimiter(redis, 60_000, 1000, 'rl:global'),
    monthlyCap: new MonthlyCap(redis),
    helpDailyQuota: new DailyQuota(redis),
    serviceToken: SVC,
  });
  const call = (token = SVC) =>
    app.inject({
      method: 'POST',
      url: AI_ENDPOINTS.autoReply,
      headers: { authorization: `Bearer ${token}`, 'x-yiji-vendor': 'v-1' },
      payload: { conversationId: CONV },
    });
  return { provider, call };
}

describe('/auto-reply', () => {
  it('is OFF by default', async () => {
    const { call } = await build('Where is my order?', false);
    expect((await call()).statusCode).toBe(403);
  });

  it('only the workers may call it, never a browser session', async () => {
    const { call } = await build('Where is my order?', true);
    const res = await call('agent-session-token');
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('service_only');
  });

  it('answers from the knowledge base and the order', async () => {
    const { call, provider } = await build('Where is my order?', true);
    provider.reply = JSON.stringify({
      action: 'reply',
      reply: 'Your order #1314302 is on its way.',
      reason: null,
    });
    const res = await call();
    expect(res.json()).toMatchObject({ action: 'reply', blocked: false });
    expect(provider.calls[0]!.system).toContain('Support is open 09:00-04:00.');
    expect(provider.calls[0]!.system).toContain('on the way'); // the order (ids are redacted)
  });

  it('a reply that offers compensation is never used: it becomes a handover', async () => {
    const { call, provider } = await build('Where is my order?', true);
    provider.reply = JSON.stringify({
      action: 'reply',
      reply: 'Sorry! Here is a coupon for the trouble.',
      reason: null,
    });
    expect((await call()).json()).toMatchObject({
      action: 'handover',
      reply: null,
      reason: 'mentions_compensation',
      blocked: true,
    });
  });

  it('asking for a person hands over without calling the model', async () => {
    const { call, provider } = await build('ابي اكلم موظف', true);
    expect((await call()).json()).toMatchObject({
      action: 'handover',
      reason: 'asked_for_person',
    });
    expect(provider.calls).toHaveLength(0);
  });
});
