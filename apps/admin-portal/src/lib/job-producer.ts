/**
 * Thin client that enqueues BullMQ jobs (contact imports + "run report now").
 *
 * The endpoint shape (`POST /jobs/import`, `POST /jobs/report`) is identical in
 * both environments — only the target + auth differ, set by VITE_JOB_PRODUCER_URL:
 *   - Dev:  the host-run producer (crm-app-infra/tools/job-producer) on :3031.
 *   - Prod: the socket-gateway's HTTP endpoint, which exposes the same authed
 *           routes (services/socket-gateway/src/index.ts).
 *
 * Auth: we always send the logged-in admin's Directus access token as a Bearer.
 * The gateway verifies it resolves to an Admin/Administrator role; the dev host
 * producer simply ignores the header (and accepts an optional x-producer-token).
 *
 * Throws on non-2xx so TanStack Query / mutations can surface the error.
 */
import { auth } from './directus.js';

const PRODUCER_URL =
  (import.meta.env.VITE_JOB_PRODUCER_URL as string | undefined) ?? 'http://localhost:3031';
const PRODUCER_TOKEN = (import.meta.env.VITE_JOB_PRODUCER_TOKEN as string | undefined) ?? '';

interface EnqueueResult {
  ok: boolean;
  jobId?: string;
  error?: string;
}

async function buildHeaders(): Promise<HeadersInit> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (PRODUCER_TOKEN) h['x-producer-token'] = PRODUCER_TOKEN;
  // Bearer = the current admin's Directus session token (prod gateway auth).
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
  /* No `enqueueImport`. The contact-CSV import it fed was removed from the
   * console: it bulk-loaded customers from a spreadsheet, in the one portal
   * where nobody who talks to customers can reach it. Customers arrive here by
   * chatting, by ordering, or from the Yiji app.
   *
   * The gateway's /jobs/import endpoint and the workers' `imports` queue are
   * still wired up and are now unreachable — nothing calls them. They are inert
   * rather than harmful, and pulling queue plumbing out of two services is a
   * change worth making on its own rather than alongside this one. */
  /** Enqueue a "run now" for a saved report (workers `reports` queue → ReportJob). */
  enqueueReport(reportId: string): Promise<EnqueueResult> {
    return post<EnqueueResult>('/jobs/report', { reportId });
  },
  /**
   * Tell Yiji about an approved coupon (workers `coupons` queue → CouponPushJob).
   *
   * Only the id travels: the worker re-reads the approval with its own token and
   * refuses anything that is not actually approved, so this cannot be used to
   * push a coupon nobody granted or terms other than the ones on record.
   */
  enqueueCouponPush(couponApprovalId: string): Promise<EnqueueResult> {
    return post<EnqueueResult>('/jobs/coupon-push', { couponApprovalId });
  },
};
