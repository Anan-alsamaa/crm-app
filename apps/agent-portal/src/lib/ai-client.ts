import type {
  EntitiesResponse,
  HelpAssistantResponse,
  HelpAssistantTurn,
  IntentResponse,
  LeadScoreResponse,
  SemanticSearchResponse,
  SentimentResponse,
  SuggestReplyResponse,
  SummaryResponse,
} from '@yiji/shared-types';
import { AI_ENDPOINTS } from '@yiji/shared-types';
import { resolveUrl } from '@yiji/shared-config';
import { auth } from './directus.js';

/**
 * Thin fetch wrapper for the ai-gateway from the agent portal.
 *
 * Auth: we send the agent's own **Directus access token** as a Bearer token; the
 * gateway verifies it against Directus and derives the user id + admin role
 * server-side. No service token is shipped to the browser, and identity/role are
 * NOT asserted via headers (the gateway ignores those). `x-yiji-vendor` is sent
 * only as the monthly-cap bucket hint.
 */

const GATEWAY_URL = resolveUrl(
  'AI_GATEWAY_URL',
  import.meta.env.VITE_AI_GATEWAY_URL as string | undefined,
  'http://localhost:8081',
);

export interface AiCaller {
  /** Kept for call-site compatibility; identity is derived server-side. */
  userId: string;
  vendorId: string;
}

export interface AiError extends Error {
  status: number;
  code?: string;
  retryAfterMs?: number;
  /** Which bucket the limit applies to ('user' | 'global' | 'daily' | …). */
  scope?: string;
  /** Allowance size for `quota_exceeded`. */
  limit?: number;
  /** ISO timestamp the `quota_exceeded` allowance resets at. */
  resetAt?: string;
}

interface AiErrorPayload {
  error?: string;
  retryAfterMs?: number;
  scope?: string;
  limit?: number;
  resetAt?: string;
}

async function post<T>(c: AiCaller, path: string, body: unknown): Promise<T> {
  const token = await auth.getToken();
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'x-yiji-vendor': c.vendorId,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let payload: AiErrorPayload = {};
    try {
      payload = await res.json();
    } catch {
      /* ignore */
    }
    const err = Object.assign(new Error(`AI gateway ${res.status}: ${payload.error ?? ''}`), {
      status: res.status,
      code: payload.error,
      retryAfterMs: payload.retryAfterMs,
      scope: payload.scope,
      limit: payload.limit,
      resetAt: payload.resetAt,
    }) as AiError;
    throw err;
  }
  return (await res.json()) as T;
}

export const ai = {
  summarize: (c: AiCaller, conversationId: string, locale?: string) =>
    post<SummaryResponse>(c, AI_ENDPOINTS.summarizeConversation, { conversationId, locale }),
  suggestReply: (
    c: AiCaller,
    conversationId: string,
    opts: { draft?: string; locale?: string } = {},
  ) =>
    post<SuggestReplyResponse>(c, AI_ENDPOINTS.suggestReply, {
      conversationId,
      draft: opts.draft,
      locale: opts.locale,
    }),
  sentiment: (c: AiCaller, conversationId: string) =>
    post<SentimentResponse>(c, AI_ENDPOINTS.analyzeSentiment, { conversationId }),
  /**
   * `candidates` are the live complaint types. Sent from here rather than
   * known by the gateway so the classifier always answers in whatever
   * vocabulary operations are using today.
   */
  intent: (c: AiCaller, conversationId: string, candidates?: string[]) =>
    post<IntentResponse>(c, AI_ENDPOINTS.detectIntent, { conversationId, candidates }),
  entities: (c: AiCaller, conversationId: string, locale?: string) =>
    post<EntitiesResponse>(c, AI_ENDPOINTS.extractEntities, { conversationId, locale }),
  search: (c: AiCaller, query: string, limit = 10) =>
    post<SemanticSearchResponse>(c, AI_ENDPOINTS.semanticSearch, { query, limit }),
  scoreLead: (c: AiCaller, conversationId: string) =>
    post<LeadScoreResponse>(c, AI_ENDPOINTS.scoreLead, { conversationId }),
  /** In-app help assistant — one question, one answer, no history kept. */
  /**
   * `history` carries the earlier turns of the CURRENT panel session so
   * follow-ups resolve. Nothing is persisted anywhere — the transcript lives
   * in component state and dies with the panel.
   */
  helpAssistant: (
    c: AiCaller,
    question: string,
    history: HelpAssistantTurn[] = [],
    /* The interface language, so the answer arrives in the language the
       question was asked in rather than always in English. */
    locale?: string,
  ) =>
    post<HelpAssistantResponse>(c, AI_ENDPOINTS.helpAssistant, {
      question,
      ...(history.length ? { history } : {}),
      ...(locale ? { locale } : {}),
    }),
};
