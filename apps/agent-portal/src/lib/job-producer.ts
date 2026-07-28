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
 * Only ONE route lives here today: notify-assignment. It deliberately takes just
 * `{ entityType, entityId }` — the recipient and the notification copy are
 * derived SERVER-SIDE from the entity's current `assigned_agent`, so an agent
 * cannot use this to push arbitrary in-app/email messages to a colleague.
 *
 * Throws on non-2xx; callers treat assignment notifications as best-effort and
 * swallow the error so a producer outage never fails the assignment itself.
 */
import { auth } from './directus.js';

const PRODUCER_URL =
  (import.meta.env.VITE_JOB_PRODUCER_URL as string | undefined) ?? 'http://localhost:3031';
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
  const res = await fetch(`${PRODUCER_URL}${path}`, {
    method: 'POST',
    headers: await buildHeaders(),
    body: JSON.stringify(body),
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
