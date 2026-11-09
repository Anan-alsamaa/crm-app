import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { updateItem } from '@directus/sdk';
import {
  AI_ENDPOINTS,
  type AiJob,
  type SummaryResponse,
  type LeadScoreResponse,
  type AutoReplyResponse,
  type AiDraft,
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
  /** Where Maha's answers go: the socket gateway consumes it (2026-11-09). */
  mahaQueue?: { add(name: string, data: unknown, opts?: unknown): Promise<unknown> };
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

  if (kind === 'auto_reply') {
    await autoReplyDraft(deps, conversationId, vendorId);
    return;
  }

  if (kind === 'maha_reply') {
    await mahaReply(deps, conversationId, vendorId, job.data.forMessageId ?? null);
    return;
  }

  deps.logger.warn({ kind, conversationId }, 'unknown ai job kind');
}

/**
 * AI AUTO-REPLY, SHADOW MODE (owner, 2026-10-13; docs/AI-AUTO-REPLY-PLAN.md).
 *
 * Asks the gateway what it WOULD say to the latest customer message and stores
 * it on the conversation (`ai_draft`) for agents to compare - nothing is sent
 * to the customer. Stands down when the chat is solved or a person has already
 * answered; a disabled feature (403) is a quiet no-op, not a failure.
 */
async function autoReplyDraft(deps: AiDeps, conversationId: string, vendorId: string) {
  const { readItem, readItems } = await import('@directus/sdk');
  const conv = (await deps.directus.request(
    readItem('conversations', conversationId, { fields: ['status'] }),
  )) as { status?: string } | null;
  if (!conv || conv.status === 'solved') return;
  const [last] = (await deps.directus.request(
    readItems('messages', {
      filter: { conversation: { _eq: conversationId }, is_internal_note: { _neq: true } },
      fields: ['id', 'sender_type'],
      sort: ['-date_created'],
      limit: 1,
    }),
  )) as Array<{ id: string; sender_type: string }>;
  if (!last || last.sender_type !== 'customer') return;

  const res = await fetch(`${deps.gatewayUrl}${AI_ENDPOINTS.autoReply}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${deps.gatewayToken}`,
      'x-yiji-user': deps.workerUserId,
      'x-yiji-vendor': vendorId,
    },
    body: JSON.stringify({ conversationId }),
  });
  if (res.status === 403 || res.status === 409) return; // off, or nothing to answer
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`AI gateway auto-reply → ${res.status}: ${text}`);
  }
  const out = (await res.json()) as AutoReplyResponse;
  const draft: AiDraft = { ...out, forMessageId: last.id, at: new Date().toISOString() };
  await deps.directus.request(
    updateItem('conversations', conversationId, { ai_draft: draft } as never),
  );
  deps.logger.info(
    { conversationId, action: out.action, blocked: out.blocked },
    'ai auto-reply draft stored (shadow)',
  );
}

/**
 * MAHA, AUTO MODE (owner, 2026-11-09): ask the AI gateway what Maha says to
 * the customer's latest message and hand the decision to the socket gateway
 * (`maha` queue), which writes it into the chat. Never retried: a second
 * answer would be a duplicate message, and the gateway's watchdog hands the
 * chat to a person if no answer lands.
 *
 *  - skipped when Maha no longer has the chat, or the customer has written
 *    again since (the newer job answers both - one answer per burst);
 *  - any gateway failure is delivered as a HANDOVER, so the customer is never
 *    left waiting on an error.
 */
async function mahaReply(
  deps: AiDeps,
  conversationId: string,
  vendorId: string,
  forMessageId: string | null,
): Promise<void> {
  if (!forMessageId || !deps.mahaQueue) return;
  const { readItem, readItems } = await import('@directus/sdk');
  const conv = (await deps.directus.request(
    readItem('conversations', conversationId, { fields: ['ai_active', 'ai_replies'] } as never),
  )) as { ai_active?: boolean | null; ai_replies?: number | null } | null;
  if (conv?.ai_active !== true) return;
  const [last] = (await deps.directus.request(
    readItems('messages', {
      filter: { conversation: { _eq: conversationId }, is_internal_note: { _neq: true } },
      fields: ['id'],
      sort: ['-date_created'],
      limit: 1,
    }),
  )) as Array<{ id: string }>;
  if (last?.id !== forMessageId) return;

  let decision: AutoReplyResponse;
  try {
    const res = await fetch(`${deps.gatewayUrl}${AI_ENDPOINTS.autoReply}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${deps.gatewayToken}`,
        'x-yiji-user': deps.workerUserId,
        'x-yiji-vendor': vendorId,
      },
      body: JSON.stringify({
        conversationId,
        mode: 'auto',
        aiReplies: Number(conv.ai_replies ?? 0) || 0,
      }),
      signal: AbortSignal.timeout(35_000),
    });
    if (!res.ok) throw new Error(`AI gateway auto-reply -> ${res.status}`);
    decision = (await res.json()) as AutoReplyResponse;
  } catch (err) {
    deps.logger.warn({ err, conversationId }, 'maha: no answer from the AI gateway - handing over');
    decision = { action: 'handover', reply: null, reason: 'ai_error:gateway', blocked: false };
  }
  await deps.mahaQueue.add('deliver', {
    kind: 'deliver',
    conversationId,
    forMessageId,
    action: decision.action,
    reply: decision.reply ?? null,
    reason: decision.reason ?? null,
    summary: decision.summary ?? null,
  });
  deps.logger.info(
    { conversationId, action: decision.action, reason: decision.reason },
    'maha decision queued',
  );
}
