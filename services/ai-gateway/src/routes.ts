import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AI_ENDPOINTS,
  ConversationRef,
  SuggestReplyRequest,
  SemanticSearchRequest,
  HelpAssistantRequest,
  type HelpAssistantResponse,
  type SummaryResponse,
  type SuggestReplyResponse,
  type SentimentResponse,
  type IntentResponse,
  type EntitiesResponse,
  type SemanticSearchResponse,
  type LeadScoreResponse,
} from '@yiji/shared-types';
import { z } from 'zod';
import { verifyCaller, AuthError, type Caller } from './auth/index.js';
import { AiConfigStore, FEATURE_BY_ENDPOINT } from './aiconfig/index.js';
import { SlidingWindowLimiter, MonthlyCap, DailyQuota } from './ratelimit/index.js';
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
  /**
   * Per-user daily budget for /help-assistant only. Separate from
   * perUserLimiter (RPM, anti-burst) — this is the anti-overuse control.
   */
  helpDailyQuota: DailyQuota;
}

type Json = Record<string, unknown>;

/* Semantic-search corpus budget. The whole corpus is inlined into a single
 * prompt, so these caps are what keep token cost (and latency) bounded:
 * 50 × ~500 chars ≈ 25 KB worst case. */
const SEARCH_CORPUS_CONVERSATIONS = 50;
const SEARCH_MESSAGES_PER_CONVERSATION = 4;
const SEARCH_SNIPPET_CHARS = 500;

/* Help-assistant output budget. The prompt asks for <=120 words, but a prompt
 * is a request, not a guarantee — these are the server-side enforcement. An
 * off-topic reply is capped far harder: a refusal needs one sentence, and a
 * long "off-topic" answer is exactly what a user trying to smuggle general
 * chat out of the assistant would be aiming for. */
const HELP_ANSWER_MAX_WORDS = 120;
const HELP_OFFTOPIC_MAX_CHARS = 240;

/** Trim to at most `max` whitespace-separated words. */
function truncateWords(text: string, max: number): string {
  const words = text.trim().split(/\s+/);
  return words.length <= max ? text.trim() : `${words.slice(0, max).join(' ')}…`;
}

/** Trim to at most `max` characters, on a word boundary where possible. */
function truncateChars(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

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
  /** Auth gate — verifies the caller's Directus session. Runs BEFORE body
   *  validation. Returns null (and replies) on failure. */
  async function authOrReply(req: FastifyRequest, reply: FastifyReply): Promise<Caller | null> {
    try {
      return await verifyCaller(req, deps.directus);
    } catch (err) {
      if (err instanceof AuthError) {
        // Audit: surface missing/invalid sessions so credential-stuffing of the
        // gateway is detectable in the logs.
        app.log.warn({ ip: req.ip, status: err.status, reason: err.message }, 'ai auth rejected');
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
        app.log.warn({ scope: 'ip', ip: clientIp, endpoint }, 'ai rate limited');
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
      app.log.warn({ scope: 'user', userId: caller.userId, endpoint }, 'ai rate limited');
      void reply.code(429).send({
        error: 'rate_limited',
        scope: 'user',
        retryAfterMs: userVerdict.resetAt - Date.now(),
      });
      return null;
    }
    const globalVerdict = await deps.globalLimiter.check('global');
    if (!globalVerdict.allowed) {
      app.log.warn({ scope: 'global', endpoint }, 'ai rate limited');
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
      app.log.warn(
        { vendorId: caller.vendorId, used: capVerdict.used, cap: capVerdict.cap },
        'ai monthly cap reached',
      );
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
    const caller = await authOrReply(req, reply);
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
    const caller = await authOrReply(req, reply);
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
    const caller = await authOrReply(req, reply);
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
    const caller = await authOrReply(req, reply);
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
    const caller = await authOrReply(req, reply);
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
    const caller = await authOrReply(req, reply);
    if (!caller) return;
    const body = SemanticSearchRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

    // Caller's verified vendor scope wins over the (client-supplied) body value.
    // An empty scope means "search everything this session can already see" —
    // consistent with auth/index.ts, where the vendor header is a cost bucket,
    // not an access boundary.
    const vendorId = caller.vendorId || body.data.vendorId || '';
    // Vendor is part of the cache key so one vendor's ranking can never be
    // served to another.
    const cacheKey = `search:${vendorId}:${body.data.query}:${body.data.limit}`;
    const gateRes = await gate(caller, reply, AI_ENDPOINTS.semanticSearch, cacheKey, req.ip);
    if (!gateRes) return;
    if (gateRes.cached) return reply.send(gateRes.cached as SemanticSearchResponse);

    // Pull recent conversations + a representative excerpt each as the corpus to
    // rank. (A proper vector store comes later; this is a usable baseline.)
    let corpus: Array<{ id: string; text: string }>;
    try {
      corpus = await deps.directus.listConversationSnippets({
        vendorId,
        conversationLimit: SEARCH_CORPUS_CONVERSATIONS,
        messagesPerConversation: SEARCH_MESSAGES_PER_CONVERSATION,
        snippetChars: SEARCH_SNIPPET_CHARS,
      });
    } catch (err) {
      // Fail soft: a Directus outage must not 500 the search box, and must not
      // burn a provider call (+ monthly cap) on a corpus we could not load.
      app.log.error({ err, vendorId }, 'semantic-search corpus fetch failed');
      return reply.send({ results: [] } satisfies SemanticSearchResponse);
    }
    // Nothing to rank — short-circuit instead of paying for a guaranteed-empty
    // provider call.
    if (corpus.length === 0) return reply.send({ results: [] } satisfies SemanticSearchResponse);

    // Conversation ids are never sent to the provider: redaction rewrites
    // digit-heavy runs (a UUID can look like a phone number), which would
    // corrupt the ids we have to map results back onto. Rank against short
    // opaque refs and resolve them locally.
    const refToConversation = new Map<string, string>();
    const snippetByRef = new Map<string, string>();
    const ctxList = corpus.map((c, i) => {
      const ref = `s${i + 1}`;
      refToConversation.set(ref, c.id);
      snippetByRef.set(ref, c.text);
      return { id: ref, text: c.text };
    });

    // NOTE: snippet text is redacted inside runWith (redactDeep over
    // {system, user}) — the same perimeter every other endpoint uses.
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
        (text) => {
          const raw = parseJson(text, schema);
          const results = raw.results
            .flatMap((r) => {
              const conversationId = refToConversation.get(r.conversationId);
              if (!conversationId) return []; // hallucinated / unknown ref
              return [
                {
                  conversationId,
                  score: r.score,
                  // Serve OUR snippet, not the model's echo: the model only ever
                  // saw redacted placeholders (`<EMAIL_1>`).
                  snippet: (snippetByRef.get(r.conversationId) ?? '').slice(0, 200),
                },
              ];
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, body.data.limit);
          return { results };
        },
      );
      return reply.send(result);
    } catch (err) {
      handleProviderError(reply, err);
    }
  });

  /* ── /score-lead ─────────────────────────────────────────────── */
  app.post(AI_ENDPOINTS.scoreLead, async (req, reply) => {
    const caller = await authOrReply(req, reply);
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

  /* ── /help-assistant ─────────────────────────────────────────── */
  /* In-app help for STAFF: "how do I …?" / "why is X happening?" about this
   * CRM.
   *
   * DELIBERATELY STATELESS. One question in, one answer out: there is no
   * conversation history, no thread id, and no follow-up turn. That is a
   * product decision, not a missing feature — history is precisely what would
   * turn an in-app help box into a general-purpose chat companion, and it
   * multiplies the token cost of every turn. Do not add it.
   *
   * Abuse controls, in the order they fire:
   *   1. auth            — verified Directus session (authOrReply)
   *   2. body validation — 3..500 chars (HelpAssistantRequest)
   *   3. gate()          — admin kill switch, cache, per-IP/user/global RPM,
   *                        monthly vendor cap
   *   4. daily quota     — per user per UTC day, checked AFTER the cache so a
   *                        repeat question is free
   *   5. scope guard     — prompt-enforced, refunded so refusals stay cheap
   *   6. output cap      — server-side truncation
   */
  app.post(AI_ENDPOINTS.helpAssistant, async (req, reply) => {
    const caller = await authOrReply(req, reply);
    if (!caller) return;
    const body = HelpAssistantRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

    // Normalise (trim + lowercase + collapse whitespace) so "How do I close a
    // ticket?" and "  how do i   close a ticket? " share one cache entry.
    // Repeats are then free AND quota-free — the cheapest possible answer.
    const question = body.data.question;
    const cacheKey = `help:${question.toLowerCase().replace(/\s+/g, ' ').trim()}`;

    const gateRes = await gate(caller, reply, AI_ENDPOINTS.helpAssistant, cacheKey, req.ip);
    if (!gateRes) return;
    if (gateRes.cached) {
      const hit = gateRes.cached as HelpAssistantResponse;
      app.log.info(
        { userId: caller.userId, offTopic: hit.offTopic, cached: true },
        'help-assistant answered',
      );
      return reply.send(hit);
    }

    // Per-user DAILY quota. Checked here rather than inside gate() for two
    // reasons: it is help-assistant-only, and it must sit AFTER the cache
    // lookup so a cache hit never costs a user any budget.
    // (A request rejected here has already ticked the vendor monthly cap in
    // gate(). That over-counts by one, which fails safe — the cap only ever
    // gets stricter — so it is left alone rather than adding a refund path.)
    const config = await deps.configStore.get();
    const quota = await deps.helpDailyQuota.tryConsume(caller.userId, config.helpDailyPerUser);
    if (!quota.allowed) {
      app.log.warn(
        { userId: caller.userId, limit: quota.limit, scope: 'daily' },
        'help-assistant daily quota exceeded',
      );
      return reply.code(429).send({
        error: 'quota_exceeded',
        scope: 'daily',
        limit: quota.limit,
        resetAt: new Date(quota.resetAt).toISOString(),
      });
    }

    const p = prompts.helpAssistant(question);
    const schema = z.object({ answer: z.string(), offTopic: z.boolean() });
    try {
      const result: HelpAssistantResponse = await runWith(
        AI_ENDPOINTS.helpAssistant,
        cacheKey,
        p.system,
        p.user,
        schema,
        (text) => {
          const raw = parseJson(text, schema);
          return {
            answer: raw.offTopic
              ? truncateChars(raw.answer, HELP_OFFTOPIC_MAX_CHARS)
              : truncateWords(raw.answer, HELP_ANSWER_MAX_WORDS),
            offTopic: raw.offTopic,
          };
        },
      );
      // A refusal is not a service the user received. Charging for it would
      // let a user burn their own day on questions the product never intended
      // to answer — and would teach them to phrase things to dodge the guard.
      if (result.offTopic) await deps.helpDailyQuota.refund(caller.userId);
      app.log.info(
        { userId: caller.userId, offTopic: result.offTopic, cached: false },
        'help-assistant answered',
      );
      return reply.send(result);
    } catch (err) {
      // No answer was produced (provider unconfigured => 503, upstream error,
      // unparseable JSON) — give the quota unit back.
      await deps.helpDailyQuota.refund(caller.userId);
      handleProviderError(reply, err);
    }
  });

  /* ── Admin: GET / PUT config ─────────────────────────────────── */
  app.get('/admin/config', async (req, reply) => {
    const caller = await authOrReply(req, reply);
    if (!caller) return;
    if (!caller.isAdmin) return reply.code(403).send({ error: 'admin_required' });
    return reply.send(await deps.configStore.get());
  });

  app.put('/admin/config', async (req, reply) => {
    const caller = await authOrReply(req, reply);
    if (!caller) return;
    if (!caller.isAdmin) return reply.code(403).send({ error: 'admin_required' });
    try {
      const next = await deps.configStore.set(req.body);
      return reply.send(next);
    } catch (err) {
      return reply.code(400).send({ error: 'invalid_config', message: (err as Error).message });
    }
  });

  // Used by the admin UI to show current usage against the monthly cap. The
  // vendor bucket to inspect is supplied explicitly (admin is verified).
  app.get('/admin/usage', async (req, reply) => {
    const caller = await authOrReply(req, reply);
    if (!caller) return;
    if (!caller.isAdmin) return reply.code(403).send({ error: 'admin_required' });
    const vendorId = (req.query as { vendorId?: string } | undefined)?.vendorId ?? caller.vendorId;
    const used = await deps.monthlyCap.currentUsage(`vendor:${vendorId}`);
    const config = await deps.configStore.get();
    return reply.send({ used, cap: config.monthlyCap });
  });
}

// Convenience re-export so consumers of the route module get the context shape
// without reaching into ./directus. Nothing in this file references it directly.
export type { ConversationContext };
