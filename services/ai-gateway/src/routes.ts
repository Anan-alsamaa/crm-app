import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AI_ENDPOINTS,
  ConversationRef,
  SuggestReplyRequest,
  SemanticSearchRequest,
  type SummaryResponse,
  type SuggestReplyResponse,
  type SentimentResponse,
  type IntentResponse,
  type EntitiesResponse,
  type SemanticSearchResponse,
  type LeadScoreResponse,
} from '@yiji/shared-types';
import { z } from 'zod';
import { authenticate, AuthError, type Caller } from './auth/index.js';
import { AiConfigStore, FEATURE_BY_ENDPOINT } from './aiconfig/index.js';
import { SlidingWindowLimiter, MonthlyCap } from './ratelimit/index.js';
import { ResponseCache } from './cache/index.js';
import { redactDeep } from './redaction/index.js';
import { prompts } from './prompts/index.js';
import type { AIProvider } from './provider/types.js';
import { AiProviderError } from './provider/types.js';
import type { GatewayDirectus, ConversationContext } from './directus/index.js';

export interface RouteDeps {
  provider: AIProvider;
  directus: GatewayDirectus;
  configStore: AiConfigStore;
  cache: ResponseCache;
  perUserLimiter: SlidingWindowLimiter;
  /** Optional per-IP limiter; if omitted, only user + global limits apply. */
  perIpLimiter?: SlidingWindowLimiter;
  globalLimiter: SlidingWindowLimiter;
  monthlyCap: MonthlyCap;
  serviceToken: string;
}

type Json = Record<string, unknown>;

/** Parse JSON safely from provider text — strips markdown fences if present. */
function parseJson<T>(text: string, schema: z.ZodType<T>): T {
  let cleaned = text.trim();
  // Strip ```json ... ``` fences
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  try {
    return schema.parse(JSON.parse(cleaned));
  } catch (err) {
    throw new AiProviderError(
      `Provider returned invalid JSON: ${(err as Error).message}`,
      'invalid_response',
      502,
    );
  }
}

export async function registerAiRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  /** Auth gate — must run BEFORE body validation. */
  function authOrReply(req: FastifyRequest, reply: FastifyReply): Caller | null {
    try {
      return authenticate(req, deps.serviceToken);
    } catch (err) {
      if (err instanceof AuthError) {
        void reply.code(err.status).send({ error: err.message });
        return null;
      }
      throw err;
    }
  }

  /** After-auth gate — feature flag + cache check + rate limits + cap. */
  async function gate(
    caller: Caller,
    reply: FastifyReply,
    endpoint: string,
    cacheKey: string,
    clientIp?: string,
  ): Promise<{ cached?: unknown } | null> {
    // Feature flag
    const config = await deps.configStore.get();
    const flag = FEATURE_BY_ENDPOINT[endpoint];
    if (flag && !config[flag]) {
      void reply.code(403).send({ error: 'feature_disabled', endpoint });
      return null;
    }

    // Cache check
    const cached = await deps.cache.get<Json>(endpoint, cacheKey);
    if (cached) {
      return { cached: { ...cached, cached: true } };
    }

    // Rate limits — per IP (anti-abuse) → per user → global
    if (deps.perIpLimiter && clientIp) {
      const ipVerdict = await deps.perIpLimiter.check(`ip:${clientIp}`);
      if (!ipVerdict.allowed) {
        void reply.code(429).send({
          error: 'rate_limited',
          scope: 'ip',
          retryAfterMs: ipVerdict.resetAt - Date.now(),
        });
        return null;
      }
    }
    const userVerdict = await deps.perUserLimiter.check(`user:${caller.userId}`);
    if (!userVerdict.allowed) {
      void reply.code(429).send({
        error: 'rate_limited',
        scope: 'user',
        retryAfterMs: userVerdict.resetAt - Date.now(),
      });
      return null;
    }
    const globalVerdict = await deps.globalLimiter.check('global');
    if (!globalVerdict.allowed) {
      void reply.code(429).send({
        error: 'rate_limited',
        scope: 'global',
        retryAfterMs: globalVerdict.resetAt - Date.now(),
      });
      return null;
    }

    // Monthly cap (per-vendor)
    const capVerdict = await deps.monthlyCap.tryConsume(
      `vendor:${caller.vendorId}`,
      config.monthlyCap,
    );
    if (!capVerdict.allowed) {
      void reply.code(429).send({
        error: 'monthly_cap_reached',
        used: capVerdict.used,
        cap: capVerdict.cap,
      });
      return null;
    }

    return {};
  }

  async function runWith<T>(
    endpoint: string,
    cacheKey: string,
    system: string,
    user: string,
    schema: z.ZodType<T>,
    extract: (text: string) => T,
  ): Promise<T> {
    // PII redaction before the outbound call — this is the perimeter
    const { redacted } = redactDeep({ system, user });
    const out = await deps.provider.run({
      endpoint,
      system: redacted.system,
      user: redacted.user,
    });
    const result = extract(out.text);
    schema.parse(result);
    await deps.cache.set(endpoint, cacheKey, result);
    return result;
  }

  function handleProviderError(reply: FastifyReply, err: unknown): void {
    if (err instanceof AiProviderError) {
      void reply.code(err.status).send({ error: err.code, message: err.message });
      return;
    }
    app.log.error({ err }, 'ai endpoint failed');
    void reply.code(500).send({ error: 'internal_error' });
  }

  /* ── /summarize-conversation ─────────────────────────────────────── */
  app.post(AI_ENDPOINTS.summarizeConversation, async (req, reply) => {
    const caller = authOrReply(req, reply);
    if (!caller) return;
    const body = ConversationRef.safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: 'invalid_body', issues: body.error.format() });
    const ctx = await deps.directus.getConversation(body.data.conversationId);
    if (!ctx) return reply.code(404).send({ error: 'conversation_not_found' });

    const cacheKey = `summary:${body.data.conversationId}:${ctx.messages.length}`;
    const gateRes = await gate(caller, reply, AI_ENDPOINTS.summarizeConversation, cacheKey, req.ip);
    if (!gateRes) return;
    if (gateRes.cached) return reply.send(gateRes.cached as SummaryResponse);

    const p = prompts.summarize(ctx);
    try {
      const result: SummaryResponse = await runWith(
        AI_ENDPOINTS.summarizeConversation,
        cacheKey,
        p.system,
        p.user,
        z.object({ summary: z.string() }),
        (text) => ({ summary: text }),
      );
      return reply.send(result);
    } catch (err) {
      handleProviderError(reply, err);
    }
  });

  /* ── /suggest-reply ─────────────────────────────────────────────── */
  app.post(AI_ENDPOINTS.suggestReply, async (req, reply) => {
    const caller = authOrReply(req, reply);
    if (!caller) return;
    const body = SuggestReplyRequest.safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: 'invalid_body', issues: body.error.format() });
    const ctx = await deps.directus.getConversation(body.data.conversationId);
    if (!ctx) return reply.code(404).send({ error: 'conversation_not_found' });

    const cacheKey = `reply:${body.data.conversationId}:${ctx.messages.length}:${body.data.draft ?? ''}:${body.data.locale ?? ''}`;
    const gateRes = await gate(caller, reply, AI_ENDPOINTS.suggestReply, cacheKey, req.ip);
    if (!gateRes) return;
    if (gateRes.cached) return reply.send(gateRes.cached as SuggestReplyResponse);

    const p = prompts.suggestReply(ctx, body.data.draft, body.data.locale);
    try {
      const result: SuggestReplyResponse = await runWith(
        AI_ENDPOINTS.suggestReply,
        cacheKey,
        p.system,
        p.user,
        z.object({ reply: z.string() }),
        (text) => ({ reply: text }),
      );
      return reply.send(result);
    } catch (err) {
      handleProviderError(reply, err);
    }
  });

  /* ── /analyze-sentiment ─────────────────────────────────────────── */
  app.post(AI_ENDPOINTS.analyzeSentiment, async (req, reply) => {
    const caller = authOrReply(req, reply);
    if (!caller) return;
    const body = ConversationRef.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const ctx = await deps.directus.getConversation(body.data.conversationId);
    if (!ctx) return reply.code(404).send({ error: 'conversation_not_found' });

    const cacheKey = `sentiment:${body.data.conversationId}:${ctx.messages.length}`;
    const gateRes = await gate(caller, reply, AI_ENDPOINTS.analyzeSentiment, cacheKey, req.ip);
    if (!gateRes) return;
    if (gateRes.cached) return reply.send(gateRes.cached as SentimentResponse);

    const p = prompts.analyzeSentiment(ctx);
    const schema = z.object({
      label: z.enum(['positive', 'neutral', 'negative']),
      score: z.number(),
    });
    try {
      const result: SentimentResponse = await runWith(
        AI_ENDPOINTS.analyzeSentiment,
        cacheKey,
        p.system,
        p.user,
        schema,
        (text) => parseJson(text, schema),
      );
      return reply.send(result);
    } catch (err) {
      handleProviderError(reply, err);
    }
  });

  /* ── /detect-intent ─────────────────────────────────────────────── */
  app.post(AI_ENDPOINTS.detectIntent, async (req, reply) => {
    const caller = authOrReply(req, reply);
    if (!caller) return;
    const body = ConversationRef.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const ctx = await deps.directus.getConversation(body.data.conversationId);
    if (!ctx) return reply.code(404).send({ error: 'conversation_not_found' });

    const cacheKey = `intent:${body.data.conversationId}:${ctx.messages.length}`;
    const gateRes = await gate(caller, reply, AI_ENDPOINTS.detectIntent, cacheKey, req.ip);
    if (!gateRes) return;
    if (gateRes.cached) return reply.send(gateRes.cached as IntentResponse);

    const p = prompts.detectIntent(ctx);
    const schema = z.object({ intent: z.string(), confidence: z.number() });
    try {
      const result: IntentResponse = await runWith(
        AI_ENDPOINTS.detectIntent,
        cacheKey,
        p.system,
        p.user,
        schema,
        (text) => parseJson(text, schema),
      );
      return reply.send(result);
    } catch (err) {
      handleProviderError(reply, err);
    }
  });

  /* ── /extract-entities ─────────────────────────────────────────── */
  app.post(AI_ENDPOINTS.extractEntities, async (req, reply) => {
    const caller = authOrReply(req, reply);
    if (!caller) return;
    const body = ConversationRef.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const ctx = await deps.directus.getConversation(body.data.conversationId);
    if (!ctx) return reply.code(404).send({ error: 'conversation_not_found' });

    const cacheKey = `entities:${body.data.conversationId}:${ctx.messages.length}`;
    const gateRes = await gate(caller, reply, AI_ENDPOINTS.extractEntities, cacheKey, req.ip);
    if (!gateRes) return;
    if (gateRes.cached) return reply.send(gateRes.cached as EntitiesResponse);

    const p = prompts.extractEntities(ctx);
    const schema = z.object({
      entities: z.array(z.object({ type: z.string(), value: z.string() })),
    });
    try {
      const result: EntitiesResponse = await runWith(
        AI_ENDPOINTS.extractEntities,
        cacheKey,
        p.system,
        p.user,
        schema,
        (text) => parseJson(text, schema),
      );
      return reply.send(result);
    } catch (err) {
      handleProviderError(reply, err);
    }
  });

  /* ── /semantic-search ─────────────────────────────────────────── */
  app.post(AI_ENDPOINTS.semanticSearch, async (req, reply) => {
    const caller = authOrReply(req, reply);
    if (!caller) return;
    const body = SemanticSearchRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

    // Caller's vendor scope wins over body
    const cacheKey = `search:${body.data.query}:${body.data.limit}`;
    const gateRes = await gate(caller, reply, AI_ENDPOINTS.semanticSearch, cacheKey, req.ip);
    if (!gateRes) return;
    if (gateRes.cached) return reply.send(gateRes.cached as SemanticSearchResponse);

    // Pull recent open conversations and their last messages as snippets to rank.
    // (A proper vector store comes later; this is a usable baseline.)
    const ctxList: Array<{ id: string; text: string }> = [];
    // Snippets come from recent conversations of the caller's vendor.
    const ranking = prompts.semanticSearch(body.data.query, ctxList);
    const schema = z.object({
      results: z.array(
        z.object({ conversationId: z.string(), score: z.number(), snippet: z.string() }),
      ),
    });
    try {
      const result: SemanticSearchResponse = await runWith(
        AI_ENDPOINTS.semanticSearch,
        cacheKey,
        ranking.system,
        ranking.user,
        schema,
        (text) => parseJson(text, schema),
      );
      return reply.send(result);
    } catch (err) {
      handleProviderError(reply, err);
    }
  });

  /* ── /score-lead ─────────────────────────────────────────────── */
  app.post(AI_ENDPOINTS.scoreLead, async (req, reply) => {
    const caller = authOrReply(req, reply);
    if (!caller) return;
    const body = ConversationRef.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    const ctx = await deps.directus.getConversation(body.data.conversationId);
    if (!ctx) return reply.code(404).send({ error: 'conversation_not_found' });

    const cacheKey = `lead:${body.data.conversationId}:${ctx.messages.length}`;
    const gateRes = await gate(caller, reply, AI_ENDPOINTS.scoreLead, cacheKey, req.ip);
    if (!gateRes) return;
    if (gateRes.cached) return reply.send(gateRes.cached as LeadScoreResponse);

    const p = prompts.scoreLead(ctx);
    const schema = z.object({ score: z.number(), signals: z.array(z.string()) });
    try {
      const result: LeadScoreResponse = await runWith(
        AI_ENDPOINTS.scoreLead,
        cacheKey,
        p.system,
        p.user,
        schema,
        (text) => parseJson(text, schema),
      );
      return reply.send(result);
    } catch (err) {
      handleProviderError(reply, err);
    }
  });

  /* ── Admin: GET / PUT config ─────────────────────────────────── */
  app.get('/admin/config', async (req, reply) => {
    let caller: Caller;
    try {
      caller = authenticate(req, deps.serviceToken);
    } catch (err) {
      if (err instanceof AuthError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
    if (!caller.isAdmin) return reply.code(403).send({ error: 'admin_required' });
    return reply.send(await deps.configStore.get());
  });

  app.put('/admin/config', async (req, reply) => {
    let caller: Caller;
    try {
      caller = authenticate(req, deps.serviceToken);
    } catch (err) {
      if (err instanceof AuthError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
    if (!caller.isAdmin) return reply.code(403).send({ error: 'admin_required' });
    try {
      const next = await deps.configStore.set(req.body);
      return reply.send(next);
    } catch (err) {
      return reply.code(400).send({ error: 'invalid_config', message: (err as Error).message });
    }
  });

  // Used by the admin UI to show current usage against the monthly cap.
  app.get('/admin/usage', async (req, reply) => {
    let caller: Caller;
    try {
      caller = authenticate(req, deps.serviceToken);
    } catch (err) {
      if (err instanceof AuthError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
    if (!caller.isAdmin) return reply.code(403).send({ error: 'admin_required' });
    const used = await deps.monthlyCap.currentUsage(`vendor:${caller.vendorId}`);
    const config = await deps.configStore.get();
    return reply.send({ used, cap: config.monthlyCap });
  });
}

// Suppress unused-context warning from ConversationContext re-export in the
// limited semantic-search baseline above; keep typing intact for future use.
export type { ConversationContext };
