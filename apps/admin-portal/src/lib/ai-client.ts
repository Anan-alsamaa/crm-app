import type { AiFeatureConfig } from '@yiji/shared-types';

/**
 * Thin fetch wrapper for the ai-gateway admin endpoints.
 *
 * Token + caller identity ride in headers — exactly what the gateway's
 * `authenticate()` expects. Throws on non-2xx so TanStack Query can show
 * the error directly.
 */

const GATEWAY_URL =
  (import.meta.env.VITE_AI_GATEWAY_URL as string | undefined) ?? 'http://localhost:8081';
const SVC_TOKEN = (import.meta.env.VITE_AI_SVC_TOKEN as string | undefined) ?? '';

interface CallerHeaders {
  userId: string;
  /** Optional. Admin config is global; defaults to 'global'. */
  vendorId?: string;
}

function headers(c: CallerHeaders): HeadersInit {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${SVC_TOKEN}`,
    'x-yiji-user': c.userId,
    'x-yiji-vendor': c.vendorId ?? 'global',
    'x-yiji-admin': '1',
  };
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      /* ignore */
    }
    throw Object.assign(new Error(`AI gateway ${res.status}`), { status: res.status, payload });
  }
  return (await res.json()) as T;
}

export const aiAdmin = {
  async getConfig(c: CallerHeaders): Promise<typeof AiFeatureConfig._type> {
    return fetchJson(`${GATEWAY_URL}/admin/config`, { headers: headers(c) });
  },
  async putConfig(
    c: CallerHeaders,
    next: Partial<typeof AiFeatureConfig._type>,
  ): Promise<typeof AiFeatureConfig._type> {
    return fetchJson(`${GATEWAY_URL}/admin/config`, {
      method: 'PUT',
      headers: headers(c),
      body: JSON.stringify(next),
    });
  },
  async getUsage(c: CallerHeaders): Promise<{ used: number; cap: number }> {
    return fetchJson(`${GATEWAY_URL}/admin/usage`, { headers: headers(c) });
  },
};
