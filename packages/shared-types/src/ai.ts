import { z } from 'zod';
import { Locale } from './enums.js';
import type { YijiOrder } from './yiji.js';

/**
 * AI gateway request/response contracts (contracts/ai-gateway.openapi.yaml).
 * Shared by the agent portal, workers, and the ai-gateway service.
 */

export const AI_ENDPOINTS = {
  summarizeConversation: '/summarize-conversation',
  suggestReply: '/suggest-reply',
  analyzeSentiment: '/analyze-sentiment',
  detectIntent: '/detect-intent',
  extractEntities: '/extract-entities',
  semanticSearch: '/semantic-search',
  scoreLead: '/score-lead',
  orderAssist: '/order-assist',
} as const;
export type AiEndpoint = (typeof AI_ENDPOINTS)[keyof typeof AI_ENDPOINTS];

export const ConversationRef = z.object({ conversationId: z.string().uuid() });
export type ConversationRef = z.infer<typeof ConversationRef>;

export const SummaryResponse = z.object({ summary: z.string(), cached: z.boolean().optional() });
export type SummaryResponse = z.infer<typeof SummaryResponse>;

export const SuggestReplyRequest = z.object({
  conversationId: z.string().uuid(),
  draft: z.string().optional(),
  locale: Locale.optional(),
});
export type SuggestReplyRequest = z.infer<typeof SuggestReplyRequest>;
export const SuggestReplyResponse = z.object({ reply: z.string() });
export type SuggestReplyResponse = z.infer<typeof SuggestReplyResponse>;

export const SentimentResponse = z.object({
  label: z.enum(['positive', 'neutral', 'negative']),
  score: z.number(),
});
export type SentimentResponse = z.infer<typeof SentimentResponse>;

export const IntentResponse = z.object({ intent: z.string(), confidence: z.number() });
export type IntentResponse = z.infer<typeof IntentResponse>;

export const ExtractedEntity = z.object({ type: z.string(), value: z.string() });
export const EntitiesResponse = z.object({ entities: z.array(ExtractedEntity) });
export type EntitiesResponse = z.infer<typeof EntitiesResponse>;

export const SemanticSearchRequest = z.object({
  query: z.string().min(1),
  vendorId: z.string().optional(),
  limit: z.number().int().positive().default(10),
});
export type SemanticSearchRequest = z.infer<typeof SemanticSearchRequest>;
export const SemanticSearchResult = z.object({
  conversationId: z.string(),
  score: z.number(),
  snippet: z.string(),
});
export const SemanticSearchResponse = z.object({ results: z.array(SemanticSearchResult) });
export type SemanticSearchResponse = z.infer<typeof SemanticSearchResponse>;

export const LeadScoreResponse = z.object({ score: z.number(), signals: z.array(z.string()) });
export type LeadScoreResponse = z.infer<typeof LeadScoreResponse>;

/**
 * In-chat order retrieval. Fetch a specific order (orderId) or the customer's
 * latest orders (customerId), then have the assistant answer grounded in that
 * live commerce data. At least one of orderId/customerId is required.
 */
export const OrderAssistRequest = z
  .object({
    vendorId: z.string().min(1),
    customerId: z.string().min(1).optional(),
    orderId: z.string().min(1).optional(),
    question: z.string().max(2000).optional(),
    limit: z.number().int().min(1).max(10).optional(),
    locale: Locale.optional(),
  })
  .refine((d) => Boolean(d.customerId) || Boolean(d.orderId), {
    message: 'customerId or orderId is required',
  });
export type OrderAssistRequest = z.infer<typeof OrderAssistRequest>;

export interface OrderAssistResponse {
  /** Natural-language answer grounded in the order data below. */
  answer: string;
  /** Present when orderId was supplied — the resolved order. */
  order?: YijiOrder;
  /** Present when customerId was supplied — the latest N orders. */
  orders?: YijiOrder[];
  cached?: boolean;
}

/** Admin-configurable AI feature flags + monthly usage cap (read by gateway). */
export const AiFeatureConfig = z.object({
  summarize: z.boolean().default(true),
  suggestReply: z.boolean().default(true),
  analyzeSentiment: z.boolean().default(true),
  detectIntent: z.boolean().default(true),
  extractEntities: z.boolean().default(true),
  semanticSearch: z.boolean().default(true),
  scoreLead: z.boolean().default(true),
  orderAssist: z.boolean().default(true),
  monthlyCap: z.number().int().nonnegative().default(0), // 0 = unlimited
});
export type AiFeatureConfig = z.infer<typeof AiFeatureConfig>;
