import { describe, expect, it, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { AI_ENDPOINTS } from '@yiji/shared-types';
import { registerAiRoutes } from '../src/routes.js';
import { AiConfigStore, vendorConfigKey } from '../src/aiconfig/index.js';
import { scopeCallerToVendor } from '../src/auth/index.js';
import { SlidingWindowLimiter, MonthlyCap, DailyQuota } from '../src/ratelimit/index.js';
import { ResponseCache } from '../src/cache/index.js';
import type { AIProvider, AiRunInput, AiRunOutput } from '../src/provider/types.js';
import type { GatewayDirectus, ConversationContext } from '../src/directus/index.js';

/*
 * AI PER VENDOR (MV-4, EMA-73).
 *
 * The vendor a request is charged to, configured by and searched within is the
 * CONVERSATION's — read from the database — not whatever `x-yiji-vendor` the
 * browser sent. The header stays only as the fallback bucket for requests that
 * name no conversation.
 */

const AGENT = 'agent-token';
const ADMIN = 'admin-token';

class StubProvider implements AIProvider {
  readonly name = 'stub';
  calls: AiRunInput[] = [];
  reply = 'a summary';
  async run(input: AiRunInput): Promise<AiRunOutput> {
    this.calls.push(input);
    return { text: this.reply, model: 'stub-1' };
  }
}

function conv(id: string, vendor: string): ConversationContext {
  return {
    id,
    status: 'open',
    priority: 'medium',
    vendor,
    contact: { id: 'c-1', name: 'Customer', email: null },
    messages: [
      {
        id: `${id}-m1`,
        sender_type: 'customer',
        content: 'Where is my order?',
        is_internal_note: false,
        date_created: '2026-06-01T10:00:00Z',
      },
    ],
  };
}

const CONV_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONV_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONVS: Record<string, ConversationContext> = {
  [CONV_A]: conv(CONV_A, 'vendor-a'),
  [CONV_B]: conv(CONV_B, 'vendor-b'),
};

async function build() {
  const redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
  const provider = new StubProvider();
  const snippetCalls: Array<{ vendorId?: string }> = [];
  const directus = {
    async getConversation(id: string) {
      return CONVS[id] ?? null;
    },
    async getConversationVendor(id: string) {
      return CONVS[id] ? CONVS[id]!.vendor : undefined;
    },
    async listConversationSnippets(opts: { vendorId?: string }) {
      snippetCalls.push(opts);
      return [{ id: CONV_A, text: 'Customer: Where is my order?' }];
    },
    async whoAmI(token: string) {
      if (token === AGENT) return { id: 'u-1', role: 'role-agent' };
      if (token === ADMIN) return { id: 'u-admin', role: 'role-admin' };
      return null;
    },
    async adminRoleIds() {
      return new Set(['role-admin']);
    },
  } as unknown as GatewayDirectus;
  const app: FastifyInstance = Fastify();
  const monthlyCap = new MonthlyCap(redis);
  await registerAiRoutes(app, {
    provider,
    directus,
    configStore: new AiConfigStore(redis),
    cache: new ResponseCache(redis, 60),
    perUserLimiter: new SlidingWindowLimiter(redis, 60_000, 100, 'rl:user'),
    globalLimiter: new SlidingWindowLimiter(redis, 60_000, 1000, 'rl:global'),
    monthlyCap,
    helpDailyQuota: new DailyQuota(redis),
  });
  return { app, redis, provider, monthlyCap, snippetCalls };
}

/** The header CLAIMS vendor-b; the conversations below say otherwise. */
const headers = { authorization: `Bearer ${AGENT}`, 'x-yiji-vendor': 'vendor-b' };

describe('AI is scoped to the conversation vendor, not the header', () => {
  let t: Awaited<ReturnType<typeof build>>;
  beforeEach(async () => {
    t = await build();
  });

  it("charges the monthly cap to the conversation's vendor", async () => {
    const r = await t.app.inject({
      method: 'POST',
      url: AI_ENDPOINTS.summarizeConversation,
      headers,
      payload: { conversationId: CONV_A },
    });
    expect(r.statusCode).toBe(200);
    expect(await t.monthlyCap.currentUsage('vendor:vendor-a')).toBe(1);
    expect(await t.monthlyCap.currentUsage('vendor:vendor-b')).toBe(0);
  });

  it("applies the conversation vendor's AI config override first", async () => {
    await t.redis.set(vendorConfigKey('vendor-a'), JSON.stringify({ summarize: false }));
    const off = await t.app.inject({
      method: 'POST',
      url: AI_ENDPOINTS.summarizeConversation,
      headers,
      payload: { conversationId: CONV_A },
    });
    expect(off.statusCode).toBe(403);
    expect(off.json().error).toBe('feature_disabled');
    // Vendor-b has no override: the global config (summarize on) applies.
    const on = await t.app.inject({
      method: 'POST',
      url: AI_ENDPOINTS.summarizeConversation,
      headers,
      payload: { conversationId: CONV_B },
    });
    expect(on.statusCode).toBe(200);
  });

  it('scopes a search made from a chat to that chat vendor', async () => {
    t.provider.reply = '{"results":[{"conversationId":"s1","score":0.9,"snippet":"x"}]}';
    const r = await t.app.inject({
      method: 'POST',
      url: AI_ENDPOINTS.semanticSearch,
      headers,
      payload: { query: 'late order', vendorId: 'vendor-b', conversationId: CONV_A },
    });
    expect(r.statusCode).toBe(200);
    expect(t.snippetCalls[0]?.vendorId).toBe('vendor-a');
    expect(await t.monthlyCap.currentUsage('vendor:vendor-a')).toBe(1);
  });

  it('a search from an unknown chat is refused, not widened', async () => {
    const r = await t.app.inject({
      method: 'POST',
      url: AI_ENDPOINTS.semanticSearch,
      headers,
      payload: { query: 'late order', conversationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
    });
    expect(r.statusCode).toBe(404);
    expect(t.snippetCalls).toHaveLength(0);
  });

  it('a search with no chat keeps the old header scope', async () => {
    await t.app.inject({
      method: 'POST',
      url: AI_ENDPOINTS.semanticSearch,
      headers,
      payload: { query: 'late order' },
    });
    expect(t.snippetCalls[0]?.vendorId).toBe('vendor-b');
  });

  it('admin can write, read and clear a vendor override', async () => {
    const admin = { authorization: `Bearer ${ADMIN}` };
    const put = await t.app.inject({
      method: 'PUT',
      url: '/admin/config?vendorId=vendor-a',
      headers: admin,
      payload: { monthlyCap: 7 },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().monthlyCap).toBe(7);
    // Global untouched.
    const global = await t.app.inject({ method: 'GET', url: '/admin/config', headers: admin });
    expect(global.json().monthlyCap).toBe(0);
    const del = await t.app.inject({
      method: 'DELETE',
      url: '/admin/config?vendorId=vendor-a',
      headers: admin,
    });
    expect(del.json().monthlyCap).toBe(0);
    const agentPut = await t.app.inject({
      method: 'PUT',
      url: '/admin/config?vendorId=vendor-a',
      headers,
      payload: { monthlyCap: 1 },
    });
    expect(agentPut.statusCode).toBe(403);
  });
});

describe('AiConfigStore per-vendor override', () => {
  let redis: Redis;
  let store: AiConfigStore;
  beforeEach(async () => {
    redis = new RedisMock() as unknown as Redis;
    await redis.flushall();
    store = new AiConfigStore(redis);
  });

  it('is the global config when a vendor has no override', async () => {
    await store.set({ monthlyCap: 100, suggestReply: false });
    expect(await store.get('vendor-a')).toEqual(await store.get());
  });

  it('merges a PARTIAL override over the global config', async () => {
    await store.set({ monthlyCap: 100, suggestReply: false });
    await store.setForVendor('vendor-a', { suggestReply: true });
    const a = await store.get('vendor-a');
    expect(a.suggestReply).toBe(true);
    expect(a.monthlyCap).toBe(100);
    expect((await store.get('vendor-b')).suggestReply).toBe(false);
  });

  it('falls back to the global config on a corrupt override', async () => {
    await store.set({ monthlyCap: 100 });
    await redis.set(vendorConfigKey('vendor-a'), JSON.stringify({ monthlyCap: -5 }));
    expect((await store.get('vendor-a')).monthlyCap).toBe(100);
  });

  it('scopeCallerToVendor prefers the conversation vendor and keeps the header otherwise', () => {
    const caller = { userId: 'u', vendorId: 'hdr', isAdmin: false };
    expect(scopeCallerToVendor(caller, 'conv-v').vendorId).toBe('conv-v');
    expect(scopeCallerToVendor(caller, { id: 'conv-v' }).vendorId).toBe('conv-v');
    expect(scopeCallerToVendor(caller, null).vendorId).toBe('hdr');
  });
});
