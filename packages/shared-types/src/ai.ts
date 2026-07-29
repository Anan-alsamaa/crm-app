import { z } from 'zod';
import { Locale } from './enums.js';

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
  helpAssistant: '/help-assistant',
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
 * In-app help assistant — staff (agents/admins) ask "how do I …?" / "why is X
 * happening?" about THIS product.
 *
 * Deliberately single-shot: one question, one answer, no history field and no
 * thread id. See the route handler for why.
 */
export const HelpAssistantRequest = z.object({
  // Trimmed first, so "  ?  " can't pass as a 3-char question. 500 chars is
  // plenty for a support question and bounds the tokens we pay for.
  question: z.string().trim().min(3).max(500),
});
export type HelpAssistantRequest = z.infer<typeof HelpAssistantRequest>;

export const HelpAssistantResponse = z.object({
  answer: z.string(),
  /** True when the question was out of scope and `answer` is the refusal. */
  offTopic: z.boolean(),
  cached: z.boolean().optional(),
});
export type HelpAssistantResponse = z.infer<typeof HelpAssistantResponse>;

/** Admin-configurable AI feature flags + monthly usage cap (read by gateway). */
/**
 * PRODUCT DECISION: AI supports STAFF, not customer conversations.
 *
 * The only AI surface in the product is the help assistant — agents and admins
 * asking how the application works. The conversation-AI endpoints below (which
 * read a customer thread, and in suggest-reply's case draft text sent back to a
 * customer) are therefore DISABLED BY DEFAULT. They remain implemented and an
 * admin can switch any of them on from the AI configuration page, but nothing
 * in the UI calls them.
 */
export const AiFeatureConfig = z.object({
  summarize: z.boolean().default(false),
  suggestReply: z.boolean().default(false),
  analyzeSentiment: z.boolean().default(false),
  detectIntent: z.boolean().default(false),
  extractEntities: z.boolean().default(false),
  semanticSearch: z.boolean().default(false),
  scoreLead: z.boolean().default(false),
  /** Kill switch for the in-app help assistant (enforced by the gateway gate). */
  helpAssistant: z.boolean().default(true),
  monthlyCap: z.number().int().nonnegative().default(0), // 0 = unlimited
  /**
   * Per-user DAILY question budget for the help assistant. Deliberately much
   * stricter than the sliding-window RPM limiter: that one stops bursts, this
   * one stops a user grinding the (paid) provider all day at a polite pace.
   * 0 = unlimited.
   */
  helpDailyPerUser: z.number().int().nonnegative().default(20),
});
export type AiFeatureConfig = z.infer<typeof AiFeatureConfig>;
