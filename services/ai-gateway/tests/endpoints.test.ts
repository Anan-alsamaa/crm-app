import { describe, expect, it, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { AI_ENDPOINTS } from '@yiji/shared-types';
import { registerAiRoutes } from '../src/routes.js';
import { AiConfigStore } from '../src/aiconfig/index.js';
import { SlidingWindowLimiter, MonthlyCap } from '../src/ratelimit/index.js';
import { ResponseCache } from '../src/cache/index.js';
import type { AIProvider, AiRunInput, AiRunOutput } from '../src/provider/types.js';
import type { GatewayDirectus, ConversationContext } from '../src/directus/index.js';

// Session tokens the stub Directus recognises. Auth is now a VERIFIED Directus
// session — the gateway resolves the token to a user + role server-side, so a
// client can no longer self-assert identity or admin via headers.
const AGENT_TOKEN = 'agent-session-token';
const ADMIN_TOKEN = 'admin-session-token';

class StubProvider implements AIProvider {
  readonly name = 'stub';
  calls: AiRunInput[] = [];
  reply = '';
  async run(input: AiRunInput): Promise<AiRunOutput> {
    this.calls.push(input);
    return { text: this.reply, model: 'stub-1' };
  }
}

function stubDirectus(ctx: ConversationContext | null): GatewayDirectus {
  return {
    async getConversation() {
      return ctx;
    },
    async whoAmI(token: string) {
      if (token === AGENT_TOKEN) return { id: 'u-1', role: 'role-agent' };
      if (token === ADMIN_TOKEN) return { id: 'u-admin', role: 'role-admin' };
      return null; // unknown/expired token
    },
    async adminRoleIds() {
      return new Set(['role-admin']);
    },
  } as unknown as GatewayDirectus;
}

const FAKE_CONV: ConversationContext = {
  id: '11111111-1111-1111-1111-111111111111',
  status: 'open',
  priority: 'medium',
  vendor: 'v-1',
  contact: { id: 'c-1', name: 'Demo Customer', email: 'demo@example.com' },
  messages: [
    {
      id: 'm-1',
      sender_type: 'customer',
      content: 'My order #5921 is late, my email is demo@example.com',
      is_internal_note: false,
      date_created: '2026-06-01T10:00:00Z',
    },
    {
      id: 'm-2',
      sender_type: 'agent',
      content: 'Looking into it now.',
      is_internal_note: false,
      date_created: '2026-06-01T10:05:00Z',
    },
  ],
};

async function buildApp(
  opts: {
    provider?: AIProvider;
    ctx?: ConversationContext | null;
  } = {},
): Promise<{ app: FastifyInstance; provider: StubProvider; redis: Redis }> {
  const provider = (opts.provider as StubProvider) ?? new StubProvider();
  const redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
  const directus = stubDirectus(opts.ctx === undefined ? FAKE_CONV : opts.ctx);
  const app = Fastify();
  await registerAiRoutes(app, {
    provider,
    directus,
    configStore: new AiConfigStore(redis),
    cache: new ResponseCache(redis, 60),
    perUserLimiter: new SlidingWindowLimiter(redis, 60_000, 100, 'rl:user'),
    globalLimiter: new SlidingWindowLimiter(redis, 60_000, 1000, 'rl:global'),
    monthlyCap: new MonthlyCap(redis),
  });
  return { app, provider, redis };
}

const auth = {
  authorization: `Bearer ${AGENT_TOKEN}`,
  'x-yiji-vendor': 'v-1',
};
const adminAuth = {
  authorization: `Bearer ${ADMIN_TOKEN}`,
  'x-yiji-vendor': 'v-1',
};

describe('AI endpoints', () => {
  let app: FastifyInstance;
  let provider: StubProvider;
  let redis: Redis;

  beforeEach(async () => {
    ({ app, provider, redis } = await buildApp());
  });

  it('rejects missing auth on every endpoint', async () => {
    for (const path of Object.values(AI_ENDPOINTS)) {
      const res = await app.inject({
        method: 'POST',
        url: path,
        payload: { conversationId: FAKE_CONV.id },
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it('rejects an invalid/expired session token (C-1: no static browser token)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: AI_ENDPOINTS.summarizeConversation,
      headers: { authorization: 'Bearer not-a-real-session', 'x-yiji-vendor': 'v-1' },
      payload: { conversationId: FAKE_CONV.id },
    });
    expect(res.statusCode).toBe(401);
  });

  it('summarize: returns summary + redacts PII outbound', async () => {
    provider.reply = 'Order is late; will check carrier.';
    const res = await app.inject({
      method: 'POST',
      url: AI_ENDPOINTS.summarizeConversation,
      headers: auth,
      payload: { conversationId: FAKE_CONV.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ summary: 'Order is late; will check carrier.' });
    // The customer message included an email — the outbound prompt must have it redacted
    const outbound = provider.calls[0]!.user;
    expect(outbound).not.toContain('demo@example.com');
    expect(outbound).toContain('<EMAIL_1>');
  });

  it('summarize: second identical call hits the cache', async () => {
    provider.reply = 'Cached';
    const r1 = await app.inject({
      method: 'POST',
      url: AI_ENDPOINTS.summarizeConversation,
      headers: auth,
      payload: { conversationId: FAKE_CONV.id },
    });
    const r2 = await app.inject({
      method: 'POST',
      url: AI_ENDPOINTS.summarizeConversation,
      headers: auth,
      payload: { conversationId: FAKE_CONV.id },
    });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r2.json().cached).toBe(true);
    expect(provider.calls).toHaveLength(1); // second call served from cache
  });

  it('suggest-reply: accepts draft + locale, returns reply', async () => {
    provider.reply = 'Apologies — your order is on the way.';
    const res = await app.inject({
      method: 'POST',
      url: AI_ENDPOINTS.suggestReply,
      headers: auth,
      payload: { conversationId: FAKE_CONV.id, draft: 'Sorry', locale: 'en' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reply).toMatch(/order/);
  });

  it('sentiment: parses JSON response from provider', async () => {
    provider.reply = '{"label":"negative","score":0.2}';
    const res = await app.inject({
      method: 'POST',
      url: AI_ENDPOINTS.analyzeSentiment,
      headers: auth,
      payload: { conversationId: FAKE_CONV.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ label: 'negative', score: 0.2 });
  });

  it('sentiment: strips ```json fences before parsing', async () => {
    provider.reply = '```json\n{"label":"neutral","score":0.5}\n```';
    const res = await app.inject({
      method: 'POST',
      url: AI_ENDPOINTS.analyzeSentiment,
      headers: auth,
      payload: { conversationId: FAKE_CONV.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().label).toBe('neutral');
  });

  it('intent: returns typed object', async () => {
    provider.reply = '{"intent":"shipping_issue","confidence":0.88}';
    const res = await app.inject({
      method: 'POST',
      url: AI_ENDPOINTS.detectIntent,
      headers: auth,
      payload: { conversationId: FAKE_CONV.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ intent: 'shipping_issue', confidence: 0.88 });
  });

  it('entities: returns array', async () => {
    provider.reply = '{"entities":[{"type":"order","value":"5921"}]}';
    const res = await app.inject({
      method: 'POST',
      url: AI_ENDPOINTS.extractEntities,
      headers: auth,
      payload: { conversationId: FAKE_CONV.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().entities).toHaveLength(1);
  });

  it('score-lead: returns score + signals', async () => {
    provider.reply = '{"score":68,"signals":["responsive","existing customer"]}';
    const res = await app.inject({
      method: 'POST',
      url: AI_ENDPOINTS.scoreLead,
      headers: auth,
      payload: { conversationId: FAKE_CONV.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().score).toBe(68);
  });

  it('semantic-search: returns results object', async () => {
    provider.reply = '{"results":[{"conversationId":"abc","score":0.92,"snippet":"refund"}]}';
    const res = await app.inject({
      method: 'POST',
      url: AI_ENDPOINTS.semanticSearch,
      headers: auth,
      payload: { query: 'refund issue', limit: 5 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toHaveLength(1);
  });

  it('404 when conversation does not exist', async () => {
    const { app: app2, provider: p2 } = await buildApp({ ctx: null });
    p2.reply = 'never called';
    const res = await app2.inject({
      method: 'POST',
      url: AI_ENDPOINTS.summarizeConversation,
      headers: auth,
      payload: { conversationId: FAKE_CONV.id },
    });
    expect(res.statusCode).toBe(404);
    expect(p2.calls).toHaveLength(0);
  });

  it('feature disabled returns 403 + does not call provider', async () => {
    const store = new AiConfigStore(redis);
    await store.set({ summarize: false });
    const res = await app.inject({
      method: 'POST',
      url: AI_ENDPOINTS.summarizeConversation,
      headers: auth,
      payload: { conversationId: FAKE_CONV.id },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('feature_disabled');
    expect(provider.calls).toHaveLength(0);
  });

  it('invalid provider JSON yields 502', async () => {
    provider.reply = 'not json at all';
    const res = await app.inject({
      method: 'POST',
      url: AI_ENDPOINTS.analyzeSentiment,
      headers: auth,
      payload: { conversationId: FAKE_CONV.id },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('invalid_response');
  });
});

describe('admin endpoints', () => {
  it('GET /admin/config: non-admin session is 403; a spoofed x-yiji-admin header is IGNORED', async () => {
    const { app } = await buildApp();
    // plain agent session → 403
    const r1 = await app.inject({ method: 'GET', url: '/admin/config', headers: auth });
    expect(r1.statusCode).toBe(403);
    // agent session that *claims* admin via header → still 403 (header not trusted)
    const r2 = await app.inject({
      method: 'GET',
      url: '/admin/config',
      headers: { ...auth, 'x-yiji-admin': '1' },
    });
    expect(r2.statusCode).toBe(403);
    // a verified admin session → 200
    const r3 = await app.inject({ method: 'GET', url: '/admin/config', headers: adminAuth });
    expect(r3.statusCode).toBe(200);
    expect(r3.json().summarize).toBe(true); // default
  });

  it('PUT /admin/config persists toggles (verified admin)', async () => {
    const { app, redis } = await buildApp();
    const r = await app.inject({
      method: 'PUT',
      url: '/admin/config',
      headers: adminAuth,
      payload: { suggestReply: false, monthlyCap: 5000 },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().suggestReply).toBe(false);
    expect(r.json().monthlyCap).toBe(5000);
    // verify persisted
    const raw = await redis.get('ai:config:global');
    expect(JSON.parse(raw!).suggestReply).toBe(false);
  });

  it('GET /admin/usage returns used + cap (verified admin)', async () => {
    const { app } = await buildApp();
    const r = await app.inject({
      method: 'GET',
      url: '/admin/usage',
      headers: adminAuth,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ used: 0, cap: 0 });
  });
});
