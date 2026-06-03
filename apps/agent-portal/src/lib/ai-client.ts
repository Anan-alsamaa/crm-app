import type {
  EntitiesResponse,
  IntentResponse,
  LeadScoreResponse,
  SemanticSearchResponse,
  SentimentResponse,
  SuggestReplyResponse,
  SummaryResponse,
} from '@yiji/shared-types';
import { AI_ENDPOINTS } from '@yiji/shared-types';

/**
 * Thin fetch wrapper for the ai-gateway from the agent portal.
 * Token + caller identity ride in headers exactly as the gateway expects.
 */

const GATEWAY_URL = (import.meta.env.VITE_AI_GATEWAY_URL as string | undefined) ?? 'http://localhost:8081';
const SVC_TOKEN = (import.meta.env.VITE_AI_SVC_TOKEN as string | undefined) ?? '';

export interface AiCaller {
  userId: string;
  vendorId: string;
}

function headers(c: AiCaller): HeadersInit {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${SVC_TOKEN}`,
    'x-yiji-user': c.userId,
    'x-yiji-vendor': c.vendorId,
  };
}

export interface AiError extends Error {
  status: number;
  code?: string;
  retryAfterMs?: number;
}

async function post<T>(c: AiCaller, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    method: 'POST',
    headers: headers(c),
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
};
