import { describe, expect, it, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { AI_ENDPOINTS } from '@yiji/shared-types';
import { registerAiRoutes } from '../src/routes.js';
import { AiConfigStore } from '../src/aiconfig/index.js';
import { SlidingWindowLimiter, MonthlyCap, DailyQuota } from '../src/ratelimit/index.js';
import { ResponseCache } from '../src/cache/index.js';
import { AiProviderError } from '../src/provider/types.js';
import type { AIProvider, AiRunInput, AiRunOutput } from '../src/provider/types.js';
import type { GatewayDirectus } from '../src/directus/index.js';

/**
 * /help-assistant — the in-app "how do I …?" endpoint for staff.
 *
 * These tests are mostly about ABUSE CONTROL rather than answer quality: the
 * daily quota and exactly what does/doesn't consume it, the admin kill switch,
 * the scope guard, and the server-side output cap.
 */

const AGENT_TOKEN = 'agent-session-token';
const auth = { authorization: `Bearer ${AGENT_TOKEN}`, 'x-yiji-vendor': 'v-1' };
const USER_ID = 'u-1';

class StubProvider implements AIProvider {
  readonly name = 'stub';
  calls: AiRunInput[] = [];
  reply = '{"answer":"Open the Tickets page and click New ticket.","offTopic":false}';
  /** When set, run() throws this instead of replying. */
  fail: Error | null = null;
  async run(input: AiRunInput): Promise<AiRunOutput> {
    this.calls.push(input);
    if (this.fail) throw this.fail;
    return { text: this.reply, model: 'stub-1' };
  }
}

function stubDirectus(): GatewayDirectus {
  return {
    async getConversation() {
      return null;
    },
    async listConversationSnippets() {
      return [];
    },
    async whoAmI(token: string) {
      return token === AGENT_TOKEN ? { id: USER_ID, role: 'role-agent' } : null;
    },
    async adminRoleIds() {
      return new Set(['role-admin']);
    },
  } as unknown as GatewayDirectus;
}

interface Harness {
  app: FastifyInstance;
  provider: StubProvider;
  redis: Redis;
  quota: DailyQuota;
  store: AiConfigStore;
  /** Move the DailyQuota clock — and therefore its UTC date key. */
  setNow: (ms: number) => void;
}

/** Fixed mid-day instants so no test ever straddles UTC midnight. */
const DAY_1 = Date.UTC(2026, 6, 28, 12, 0, 0);
const DAY_2 = Date.UTC(2026, 6, 29, 12, 0, 0);

async function buildApp(): Promise<Harness> {
  const provider = new StubProvider();
  const redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
  let now = DAY_1;
  const quota = new DailyQuota(redis, 'help:quota', () => now);
  const store = new AiConfigStore(redis);
  const app = Fastify();
  await registerAiRoutes(app, {
    provider,
    directus: stubDirectus(),
    configStore: store,
    cache: new ResponseCache(redis, 60),
    perUserLimiter: new SlidingWindowLimiter(redis, 60_000, 100, 'rl:user'),
    globalLimiter: new SlidingWindowLimiter(redis, 60_000, 1000, 'rl:global'),
    monthlyCap: new MonthlyCap(redis),
    helpDailyQuota: quota,
  });
  return {
    app,
    provider,
    redis,
    quota,
    store,
    setNow: (ms: number) => {
      now = ms;
    },
  };
}

/** POST a question with a valid agent session. */
function ask(app: FastifyInstance, question: unknown) {
  return app.inject({
    method: 'POST',
    url: AI_ENDPOINTS.helpAssistant,
    headers: auth,
    payload: { question },
  });
}

describe('/help-assistant — happy path', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildApp();
  });

  it('answers an in-scope question', async () => {
    const res = await ask(h.app, 'How do I create a ticket from a conversation?');
    expect(res.statusCode).toBe(200);
    expect(res.json().answer).toContain('Tickets');
    expect(res.json().offTopic).toBe(false);
    expect(h.provider.calls).toHaveLength(1);
  });

  it('grounds the system prompt in this product and fences the question as data', async () => {
    await ask(h.app, 'What are the ticket statuses?');
    const call = h.provider.calls[0]!;
    expect(call.system).toContain('Yiji CRM');
    expect(call.system).toContain('new -> open -> pending -> resolved -> closed');
    // The scope guard actually reaches the provider.
    expect(call.system).toContain('OUT OF SCOPE');
    expect(call.system).toContain('"offTopic":true');
    // The untrusted question is quoted as data, never spliced into the rules.
    expect(call.user).toContain('What are the ticket statuses?');
    expect(call.system).not.toContain('What are the ticket statuses?');
  });

  it('requires auth', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: AI_ENDPOINTS.helpAssistant,
      payload: { question: 'How do I assign a ticket?' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('ignores unknown body keys (no smuggled history)', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: AI_ENDPOINTS.helpAssistant,
      headers: auth,
      payload: { question: 'How do I add a tag?', history: [{ role: 'user' }], vendorId: 'x' },
    });
    expect(res.statusCode).toBe(200);
    expect(h.provider.calls[0]!.user).not.toContain('role');
  });

  it('503s when the provider is not configured', async () => {
    h.provider.fail = new AiProviderError(
      'GEMINI_API_KEY is not configured',
      'not_configured',
      503,
    );
    const res = await ask(h.app, 'How do I close a ticket?');
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('not_configured');
    // A failed call must not cost the user a question.
    expect(await h.quota.currentUsage(USER_ID)).toBe(0);
  });
});

describe('/help-assistant — request validation', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildApp();
  });

  it('rejects a missing question', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: AI_ENDPOINTS.helpAssistant,
      headers: auth,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_body');
  });

  it('rejects a question shorter than 3 chars, whitespace included', async () => {
    expect((await ask(h.app, 'hi')).statusCode).toBe(400);
    expect((await ask(h.app, '      ')).statusCode).toBe(400);
    expect(h.provider.calls).toHaveLength(0);
  });

  it('rejects a question longer than 500 chars', async () => {
    expect((await ask(h.app, 'a'.repeat(501))).statusCode).toBe(400);
    expect(h.provider.calls).toHaveLength(0);
  });

  it('rejects a non-string question', async () => {
    expect((await ask(h.app, { nested: 'nope' })).statusCode).toBe(400);
  });

  it('accepts exactly 500 chars', async () => {
    expect((await ask(h.app, 'a'.repeat(500))).statusCode).toBe(200);
  });
});

describe('/help-assistant — scope guard', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildApp();
  });

  it('returns offTopic=true and does NOT consume the daily quota', async () => {
    h.provider.reply = '{"answer":"I can only help with using Yiji CRM.","offTopic":true}';
    const res = await ask(h.app, 'Write me a Python script to sort a list.');
    expect(res.statusCode).toBe(200);
    expect(res.json().offTopic).toBe(true);
    // Refusals are cheap by design — the quota unit is refunded.
    expect(await h.quota.currentUsage(USER_ID)).toBe(0);
  });

  it('hard-caps a long off-topic answer', async () => {
    const essay = 'The history of the Roman Empire is long and storied. '.repeat(30);
    h.provider.reply = JSON.stringify({ answer: essay, offTopic: true });
    const res = await ask(h.app, 'Tell me about the Roman Empire.');
    // 240-char cap plus the single ellipsis the truncator appends.
    expect(res.json().answer.length).toBeLessThanOrEqual(241);
    expect(res.json().answer.endsWith('…')).toBe(true);
  });

  it('refunded quota still lets the user ask real questions afterwards', async () => {
    await h.store.set({ helpDailyPerUser: 1 });
    h.provider.reply = '{"answer":"Out of scope.","offTopic":true}';
    expect((await ask(h.app, 'What is the capital of France?')).statusCode).toBe(200);

    h.provider.reply = '{"answer":"Open the Inbox.","offTopic":false}';
    const res = await ask(h.app, 'Where do I find my assigned conversations?');
    expect(res.statusCode).toBe(200);
    expect(await h.quota.currentUsage(USER_ID)).toBe(1);
  });
});

describe('/help-assistant — output bounding', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildApp();
  });

  it('truncates a long model answer to 120 words', async () => {
    const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
    h.provider.reply = JSON.stringify({ answer: long, offTopic: false });
    const res = await ask(h.app, 'Explain the SLA policy settings in detail.');
    expect(res.json().answer.split(/\s+/)).toHaveLength(120);
    expect(res.json().answer.endsWith('…')).toBe(true);
    expect(res.json().answer.startsWith('word0 word1')).toBe(true);
  });

  it('leaves a short answer untouched', async () => {
    h.provider.reply = '{"answer":"Open the Admin Portal and go to SLA.","offTopic":false}';
    const res = await ask(h.app, 'Where are SLA policies configured?');
    expect(res.json().answer).toBe('Open the Admin Portal and go to SLA.');
  });

  it('caches the TRUNCATED answer, not the raw model output', async () => {
    const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
    h.provider.reply = JSON.stringify({ answer: long, offTopic: false });
    await ask(h.app, 'Explain SLA.');
    const res = await ask(h.app, 'Explain SLA.');
    expect(res.json().cached).toBe(true);
    expect(res.json().answer.split(/\s+/)).toHaveLength(120);
  });
});

describe('/help-assistant — daily quota', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildApp();
  });

  it('429s quota_exceeded with limit + resetAt once the budget is spent', async () => {
    await h.store.set({ helpDailyPerUser: 2 });
    expect((await ask(h.app, 'How do I assign a ticket to a team?')).statusCode).toBe(200);
    expect((await ask(h.app, 'How do I add a tag to a contact?')).statusCode).toBe(200);

    const res = await ask(h.app, 'How do I import contacts from CSV?');
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe('quota_exceeded');
    expect(res.json().scope).toBe('daily');
    expect(res.json().limit).toBe(2);
    // resetAt is an ISO-8601 UTC instant: the next UTC midnight.
    expect(res.json().resetAt).toBe('2026-07-29T00:00:00.000Z');
    // Blocked before the provider was ever reached.
    expect(h.provider.calls).toHaveLength(2);
  });

  it('a rejected request does not further inflate the counter', async () => {
    await h.store.set({ helpDailyPerUser: 1 });
    await ask(h.app, 'How do I reopen a ticket?');
    await ask(h.app, 'How do I escalate a ticket?');
    await ask(h.app, 'How do I resolve a ticket?');
    expect(await h.quota.currentUsage(USER_ID)).toBe(1);
  });

  it('resets on the next UTC day (new date key)', async () => {
    await h.store.set({ helpDailyPerUser: 1 });
    expect((await ask(h.app, 'How do I create a team?')).statusCode).toBe(200);
    expect((await ask(h.app, 'How do I delete a team?')).statusCode).toBe(429);

    h.setNow(DAY_2);
    expect((await ask(h.app, 'How do I rename a team?')).statusCode).toBe(200);
    // Yesterday's counter is untouched; today's is a fresh key.
    expect(await h.redis.get(`help:quota:${USER_ID}:2026-07-28`)).toBe('1');
    expect(await h.redis.get(`help:quota:${USER_ID}:2026-07-29`)).toBe('1');
  });

  it('helpDailyPerUser = 0 means unlimited', async () => {
    await h.store.set({ helpDailyPerUser: 0 });
    for (let i = 0; i < 25; i++) {
      expect((await ask(h.app, `How do I do thing number ${i}?`)).statusCode).toBe(200);
    }
  });

  it('keys the counter per user per UTC day, with a self-cleaning TTL', async () => {
    const key = `help:quota:${USER_ID}:2026-07-28`;
    await ask(h.app, 'How do I filter the inbox?');
    expect(await h.redis.get(key)).toBe('1');
    expect(await h.redis.ttl(key)).toBeGreaterThan(0);
  });
});

describe('/help-assistant — cache', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildApp();
  });

  it('a cache hit does NOT consume the daily quota and never calls the provider', async () => {
    expect((await ask(h.app, 'How do I mark a first response?')).statusCode).toBe(200);
    expect(await h.quota.currentUsage(USER_ID)).toBe(1);

    const res = await ask(h.app, 'How do I mark a first response?');
    expect(res.statusCode).toBe(200);
    expect(res.json().cached).toBe(true);
    // The repeat was free: still one provider call, still one quota unit.
    expect(h.provider.calls).toHaveLength(1);
    expect(await h.quota.currentUsage(USER_ID)).toBe(1);
  });

  it('normalises case and whitespace onto one cache entry', async () => {
    await ask(h.app, 'How do I close a ticket?');
    const res = await ask(h.app, '  how   do i CLOSE a   ticket?  ');
    expect(res.json().cached).toBe(true);
    expect(h.provider.calls).toHaveLength(1);
    expect(await h.quota.currentUsage(USER_ID)).toBe(1);
  });

  it('a cached answer is still served once the quota is exhausted', async () => {
    await h.store.set({ helpDailyPerUser: 1 });
    await ask(h.app, 'How do I add a custom field?');
    const res = await ask(h.app, 'How do I add a custom field?');
    expect(res.statusCode).toBe(200);
    expect(res.json().cached).toBe(true);
  });
});

describe('/help-assistant — admin kill switch', () => {
  it('403s feature_disabled and never calls the provider or the quota', async () => {
    const h = await buildApp();
    await h.store.set({ helpAssistant: false });
    const res = await ask(h.app, 'How do I create a ticket?');
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('feature_disabled');
    expect(res.json().endpoint).toBe('/help-assistant');
    expect(h.provider.calls).toHaveLength(0);
    expect(await h.quota.currentUsage(USER_ID)).toBe(0);
  });

  it('is enabled by default', async () => {
    const h = await buildApp();
    expect((await ask(h.app, 'How do I open the command palette?')).statusCode).toBe(200);
  });
});
