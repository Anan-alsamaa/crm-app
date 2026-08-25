/**
 * Thin client that enqueues BullMQ jobs from the AGENT portal.
 *
 * Mirrors apps/admin-portal/src/lib/job-producer.ts: the endpoint shape is
 * identical in both environments — only the target + auth differ, set by
 * VITE_JOB_PRODUCER_URL:
 *   - Dev:  the host-run producer (tools/job-producer) on :3031.
 *   - Prod: the socket-gateway's HTTP endpoint, which exposes the same authed
 *           routes (services/socket-gateway/src/index.ts).
 *
 * Auth: we always send the logged-in agent's Directus access token as a Bearer.
 * The gateway verifies it resolves to Agent/Admin/Administrator; the dev host
 * producer verifies the same via Directus /users/me.
 *
 * notify-assignment deliberately takes just
 * `{ entityType, entityId }` — the recipient and the notification copy are
 * derived SERVER-SIDE from the entity's current `assigned_agent`, so an agent
 * cannot use this to push arbitrary in-app/email messages to a colleague.
 *
 * Throws on non-2xx; callers treat assignment notifications as best-effort and
 * swallow the error so a producer outage never fails the assignment itself.
 */
import { resolveUrl } from '@yiji/shared-config';
import { auth } from './directus.js';

/* Resolved at page load, not baked in — see resolveUrl. This is the endpoint
 * that enqueues a coupon push and a report run, so a build-time value would
 * have one environment's console enqueueing into another's queue. */
const PRODUCER_URL = resolveUrl(
  'JOB_PRODUCER_URL',
  import.meta.env.VITE_JOB_PRODUCER_URL as string | undefined,
  'http://localhost:3031',
);
const PRODUCER_TOKEN = (import.meta.env.VITE_JOB_PRODUCER_TOKEN as string | undefined) ?? '';

export interface EnqueueResult {
  ok: boolean;
  enqueued?: boolean;
  jobId?: string;
  error?: string;
}

async function buildHeaders(): Promise<HeadersInit> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (PRODUCER_TOKEN) h['x-producer-token'] = PRODUCER_TOKEN;
  // Bearer = the current agent's Directus session token (gateway auth + the
  // server-side "who is the caller" check that suppresses self-notification).
  const token = await auth.getToken().catch(() => null);
  if (token) h['authorization'] = `Bearer ${token}`;
  return h;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  return call<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${PRODUCER_URL}${path}`, {
    ...init,
    headers: await buildHeaders(),
  });
  let payload: EnqueueResult | null = null;
  try {
    payload = (await res.json()) as EnqueueResult;
  } catch {
    /* ignore */
  }
  if (!res.ok || !payload?.ok) {
    throw Object.assign(new Error(payload?.error ?? `job enqueue failed (${res.status})`), {
      status: res.status,
      payload,
    });
  }
  return payload as T;
}

export const jobProducer = {
  /**
   * Tell the CURRENT assignee of a conversation/ticket that it was assigned to
   * them (workers `notifications` queue → NotificationJob type 'assignment').
   * No recipient/title/body is sent: the server reads them off the entity.
   */
  notifyAssignment(
    entityType: 'conversation' | 'ticket',
    entityId: string,
  ): Promise<EnqueueResult> {
    return post<EnqueueResult>('/jobs/notify-assignment', { entityType, entityId });
  },

  /**
   * Who on `teamId` should take a handed-over chat.
   *
   * Server-side because the answer requires counting other agents' open
   * conversations, which the Agent role cannot read — the portal's own version
   * measured everyone as zero and picked the lowest uuid, piling a whole
   * night's backlog onto one person.
   */
  async leastLoadedAgentInTeam(teamId: string): Promise<string | null> {
    const r = await call<{ ok: boolean; agentId: string | null }>(
      `/teams/${encodeURIComponent(teamId)}/least-loaded`,
    );
    return r.agentId;
  },
};

/**
 * Fire-and-forget wrapper used by the assignment mutations. NEVER throws and
 * never blocks the mutation's success path — a producer/Redis outage must not
 * fail or roll back the assignment that already persisted.
 */
export function notifyAssignmentBestEffort(
  entityType: 'conversation' | 'ticket',
  entityId: string,
): void {
  void jobProducer.notifyAssignment(entityType, entityId).catch(() => undefined);
}
