import type {
  EntitiesResponse,
  IntentResponse,
  LeadScoreResponse,
  OrderAssistResponse,
  SemanticSearchResponse,
  SentimentResponse,
  SuggestReplyResponse,
  SummaryResponse,
} from '@yiji/shared-types';
import { AI_ENDPOINTS } from '@yiji/shared-types';
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

const GATEWAY_URL =
  (import.meta.env.VITE_AI_GATEWAY_URL as string | undefined) ?? 'http://localhost:8081';

export interface AiCaller {
  /** Kept for call-site compatibility; identity is derived server-side. */
  userId: string;
  vendorId: string;
}

export interface AiError extends Error {
  status: number;
  code?: string;
  retryAfterMs?: number;
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
    let payload: { error?: string; retryAfterMs?: number } = {};
    try {
      payload = await res.json();
    } catch {
      /* ignore */
    }
    const err = Object.assign(new Error(`AI gateway ${res.status}: ${payload.error ?? ''}`), {
      status: res.status,
      code: payload.error,
      retryAfterMs: payload.retryAfterMs,
    }) as AiError;
    throw err;
  }
  return (await res.json()) as T;
}

export const ai = {
  summarize: (c: AiCaller, conversationId: string) =>
    post<SummaryResponse>(c, AI_ENDPOINTS.summarizeConversation, { conversationId }),
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
  intent: (c: AiCaller, conversationId: string) =>
    post<IntentResponse>(c, AI_ENDPOINTS.detectIntent, { conversationId }),
  entities: (c: AiCaller, conversationId: string) =>
    post<EntitiesResponse>(c, AI_ENDPOINTS.extractEntities, { conversationId }),
  search: (c: AiCaller, query: string, limit = 10) =>
    post<SemanticSearchResponse>(c, AI_ENDPOINTS.semanticSearch, { query, limit }),
  scoreLead: (c: AiCaller, conversationId: string) =>
    post<LeadScoreResponse>(c, AI_ENDPOINTS.scoreLead, { conversationId }),
  /**
   * In-chat order retrieval: pass an orderId for a specific order, or a
   * customerId (the contact's external_customer_id) for the latest N orders.
   * The gateway fetches live commerce data server-side and returns a grounded
   * answer plus the raw order(s).
   */
  orderAssist: (
    c: AiCaller,
    opts: {
      vendorId: string;
      customerId?: string;
      orderId?: string;
      question?: string;
      limit?: number;
      locale?: string;
    },
  ) => post<OrderAssistResponse>(c, AI_ENDPOINTS.orderAssist, opts),
};
