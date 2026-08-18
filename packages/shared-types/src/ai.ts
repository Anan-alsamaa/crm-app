import { z } from 'zod';
import { Locale, ReportType } from './enums.js';

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

/** One prior turn of an in-session help conversation. */
export const HelpAssistantTurn = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(2000),
});
export type HelpAssistantTurn = z.infer<typeof HelpAssistantTurn>;

/** Turns the client may replay. 3 exchanges is enough to resolve "that one". */
export const HELP_HISTORY_MAX_TURNS = 6;

/**
 * In-app help assistant — staff (agents/admins) ask "how do I …?" / "why is X
 * happening?" about THIS product.
 *
 * Multi-turn WITHIN A SESSION only. The client replays the recent turns it is
 * holding in memory; the server stores nothing and there is no thread id, so
 * closing the panel or reloading starts clean and no staff question is ever
 * persisted. This was single-shot until 2026-07-29 — follow-ups like "and what
 * about the one I just asked?" were unanswerable and got refused as off-topic.
 *
 * History does NOT widen the scope guard: the guard is enforced by the system
 * prompt on every call and prior turns are fenced as untrusted data, exactly
 * like the question itself, so an earlier turn cannot be used to argue the
 * assistant into general-purpose chat.
 */
export const HelpAssistantRequest = z.object({
  // Trimmed first, so "  ?  " can't pass as a 3-char question. 500 chars is
  // plenty for a support question and bounds the tokens we pay for.
  question: z.string().trim().min(3).max(500),
  /**
   * Recent turns, oldest first, EXCLUDING the current question. Bounded so a
   * client cannot inflate the prompt (and the bill) without limit; the server
   * additionally truncates rather than trusting the client.
   */
  history: z.array(HelpAssistantTurn).max(HELP_HISTORY_MAX_TURNS).optional(),
  /**
   * The language the staff member is working in.
   *
   * Aura answered in English whatever the interface was set to, because this
   * never reached the prompt — an Arabic user got an English answer about an
   * Arabic screen.
   */
  locale: Locale.optional(),
});
export type HelpAssistantRequest = z.infer<typeof HelpAssistantRequest>;

/**
 * A change Aura believes the user asked for, described but NOT performed.
 *
 * The assistant never writes anything itself. It returns a proposal, the
 * portal renders exactly what would be created, and the user presses the
 * button — so the write runs under THEIR session and THEIR permissions, and
 * an assistant that misreads a request produces a wrong card rather than a
 * wrong record. `kind` is a closed set for the same reason: an action the
 * portal does not recognise is ignored, not attempted.
 */
export const AuraAction = z.object({
  kind: z.literal('create_scheduled_report'),
  /** Human-readable summary of the proposal, rendered above the button. */
  summary: z.string().max(300),
  payload: z.object({
    name: z.string().min(1).max(120),
    type: ReportType,
    /** Cron the worker registers; absent means run-on-demand only. */
    cron: z.string().max(80).optional(),
    recipients: z.array(z.string().email()).max(20).optional(),
  }),
});
export type AuraAction = z.infer<typeof AuraAction>;

export const HelpAssistantResponse = z.object({
  answer: z.string(),
  /** True when the question was out of scope and `answer` is the refusal. */
  offTopic: z.boolean(),
  cached: z.boolean().optional(),
  /** Present when the user asked Aura to DO something she can propose. */
  action: AuraAction.nullish(),
});
export type HelpAssistantResponse = z.infer<typeof HelpAssistantResponse>;

/** Admin-configurable AI feature flags + monthly usage cap (read by gateway). */
export const AiFeatureConfig = z.object({
  summarize: z.boolean().default(true),
  suggestReply: z.boolean().default(true),
  analyzeSentiment: z.boolean().default(true),
  detectIntent: z.boolean().default(true),
  extractEntities: z.boolean().default(true),
  semanticSearch: z.boolean().default(true),
  scoreLead: z.boolean().default(true),
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
