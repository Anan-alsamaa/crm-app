/**
 * Thin client for the host-run job producer (tools/job-producer).
 *
 * The producer enqueues BullMQ jobs the Dockerised workers consume. It runs
 * host-side (no rebuild) on http://localhost:3031 by default; override with
 * VITE_JOB_PRODUCER_URL. An optional producer token rides in a header when
 * VITE_JOB_PRODUCER_TOKEN is set (must match the producer's PRODUCER_TOKEN).
 *
 * Throws on non-2xx so TanStack Query / mutations can surface the error.
 */

const PRODUCER_URL =
  (import.meta.env.VITE_JOB_PRODUCER_URL as string | undefined) ?? 'http://localhost:3031';
const PRODUCER_TOKEN = (import.meta.env.VITE_JOB_PRODUCER_TOKEN as string | undefined) ?? '';

interface EnqueueResult {
  ok: boolean;
  jobId?: string;
  error?: string;
}

function headers(): HeadersInit {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (PRODUCER_TOKEN) h['x-producer-token'] = PRODUCER_TOKEN;
  return h;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${PRODUCER_URL}${path}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  let payload: EnqueueResult | null = null;
  try {
    payload = (await res.json()) as EnqueueResult;
  } catch {
    /* ignore */
  }
  if (!res.ok || !payload?.ok) {
    throw Object.assign(new Error(payload?.error ?? `job producer ${res.status}`), {
      status: res.status,
      payload,
    });
  }
  return payload as T;
}

export const jobProducer = {
  /** Enqueue a contact-import job (workers `imports` queue → ImportJob). */
  enqueueImport(input: {
    fileId: string;
    vendorId: string;
    mapping: Record<string, string>;
  }): Promise<EnqueueResult> {
    return post<EnqueueResult>('/jobs/import', input);
  },
  /** Enqueue a "run now" for a saved report (workers `reports` queue → ReportJob). */
  enqueueReport(reportId: string): Promise<EnqueueResult> {
    return post<EnqueueResult>('/jobs/report', { reportId });
  },
};
