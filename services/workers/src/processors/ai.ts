import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { updateItem } from '@directus/sdk';
import {
  AI_ENDPOINTS,
  type AiJob,
  type SummaryResponse,
  type LeadScoreResponse,
} from '@yiji/shared-types';
import type { YijiDirectusClient } from '@yiji/shared-config';

/**
 * AI queue processor.
 *
 * Two job types right now:
 *   - `summarize` — runs after a conversation closes; calls the AI gateway's
 *     /summarize-conversation, persists the result on the conversation row.
 *   - `score_lead` — scheduled (or manual); calls /score-lead and persists
 *     score + signals on the conversation row for the agent UI to show.
 *
 * The worker is the trusted caller — it sets a service-account user id and
 * vendor 'worker' on the request so the gateway's auth + cap accounting are
 * still honored.
 */

export interface AiDeps {
  directus: YijiDirectusClient;
  /** AI gateway base URL (e.g. http://ai-gateway:8081 inside docker). */
  gatewayUrl: string;
  /** SVC_AI_TOKEN — the gateway's service token. */
  gatewayToken: string;
  /** Worker's stable user id for rate-limit scoping (matches a Directus service-account user). */
  workerUserId: string;
  logger: Logger;
}

async function call<T>(
  deps: AiDeps,
  endpoint: string,
  body: Record<string, unknown>,
  vendorId: string,
): Promise<T> {
  const res = await fetch(`${deps.gatewayUrl}${endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${deps.gatewayToken}`,
      'x-yiji-user': deps.workerUserId,
      'x-yiji-vendor': vendorId,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`AI gateway ${endpoint} → ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

async function loadVendor(deps: AiDeps, conversationId: string): Promise<string> {
  // Read the conversation header to discover vendor — needed for cap scoping.
  const { readItem } = await import('@directus/sdk');
  const conv = (await deps.directus.request(
    readItem('conversations', conversationId, { fields: ['vendor'] }),
  )) as { vendor: string } | null;
  return conv?.vendor ?? 'unknown';
}

export async function processAiJob(job: Job<AiJob>, deps: AiDeps): Promise<void> {
  const { job: kind, conversationId } = job.data;
  const vendorId = await loadVendor(deps, conversationId);

  if (kind === 'summarize') {
    const { summary } = await call<SummaryResponse>(
      deps,
      AI_ENDPOINTS.summarizeConversation,
      { conversationId },
      vendorId,
    );
    await deps.directus.request(
      updateItem('conversations', conversationId, { ai_summary: summary } as never),
    );
    deps.logger.info({ conversationId, len: summary.length }, 'conversation summary stored');
    return;
  }

  if (kind === 'score_lead') {
    const { score, signals } = await call<LeadScoreResponse>(
      deps,
      AI_ENDPOINTS.scoreLead,
      { conversationId },
      vendorId,
    );
    await deps.directus.request(
      updateItem('conversations', conversationId, {
        ai_lead_score: score,
        ai_lead_signals: signals,
      } as never),
    );
    deps.logger.info({ conversationId, score, signals: signals.length }, 'lead score stored');
    return;
  }

  deps.logger.warn({ kind, conversationId }, 'unknown ai job kind');
}
