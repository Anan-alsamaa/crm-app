/**
 * EVERY AI CALL IS LOGGED (owner, 2026-10-07).
 *
 * The CRM counted requests and nothing else, so the real cost of the AI — and
 * what moving from Gemini to another provider would cost — could only be
 * guessed. Each call to the model now leaves a row in `ai_calls`: which
 * feature, which model, the tokens, an estimated cost at list price, how long
 * it took and whether it worked.
 *
 * The cost is the PAID list price even while the free tier is in use, so the
 * figure answers "what would this cost us?" rather than reading 0.
 */
import type { AiUsage } from './provider/types.js';

/** USD per 1M tokens, [input, output]. Thinking tokens are billed as output. */
const PRICES: Array<[RegExp, number, number]> = [
  [/^gemini-2\.5-flash-lite/, 0.1, 0.4],
  [/^gemini-2\.5-flash/, 0.3, 2.5],
  [/^gemini-2\.5-pro/, 1.25, 10],
  [/^gemini-1\.5-flash/, 0.075, 0.3],
  [/^gpt-5-nano/, 0.05, 0.4],
  [/^gpt-5-mini/, 0.25, 2],
  [/^gpt-5\.6-luna/, 0.2, 1.2],
];

export function estimateCostUsd(model: string, usage: AiUsage | undefined): number | null {
  if (!usage) return null;
  const price = PRICES.find(([re]) => re.test(model));
  if (!price) return null;
  const [, inUsd, outUsd] = price;
  const out = (usage.outputTokens ?? 0) + (usage.thinkingTokens ?? 0);
  return ((usage.inputTokens ?? 0) * inUsd + out * outUsd) / 1_000_000;
}

export interface AiCallRow {
  endpoint: string;
  provider: string;
  model: string | null;
  status: 'ok' | 'error';
  error_code: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  thinking_tokens: number | null;
  est_cost_usd: number | null;
  latency_ms: number;
  user_id: string | null;
  vendor_id: string | null;
  conversation_id: string | null;
}

/** Writes a row; must never throw into the request path. */
export type AiCallSink = (row: AiCallRow) => Promise<void>;

/** The conversation a request body is about, when it names one. */
export function conversationIdOf(body: unknown): string | null {
  const id = (body as { conversationId?: unknown } | null)?.conversationId;
  return typeof id === 'string' && id.length <= 64 ? id : null;
}
