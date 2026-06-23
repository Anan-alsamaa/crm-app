import type { AiFeatureConfig } from '@yiji/shared-types';
import { auth } from './directus.js';

/**
 * Thin fetch wrapper for the ai-gateway admin endpoints.
 *
 * Auth: we send the admin's own **Directus access token** as a Bearer token; the
 * gateway verifies it and derives admin status from the user's Directus role
 * server-side. No service token is shipped to the browser, and the old
 * self-asserted `x-yiji-admin` header is gone (the gateway ignores it).
 */

const GATEWAY_URL =
  (import.meta.env.VITE_AI_GATEWAY_URL as string | undefined) ?? 'http://localhost:8081';

interface CallerHeaders {
  userId?: string;
  /** Optional cap bucket to inspect; admin config itself is global. */
  vendorId?: string;
}

async function authHeaders(c: CallerHeaders): Promise<HeadersInit> {
  const token = await auth.getToken();
  return {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    'x-yiji-vendor': c.vendorId ?? 'global',
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
    return fetchJson(`${GATEWAY_URL}/admin/config`, { headers: await authHeaders(c) });
  },
  async putConfig(
    c: CallerHeaders,
    next: Partial<typeof AiFeatureConfig._type>,
  ): Promise<typeof AiFeatureConfig._type> {
    return fetchJson(`${GATEWAY_URL}/admin/config`, {
      method: 'PUT',
      headers: await authHeaders(c),
      body: JSON.stringify(next),
    });
  },
  async getUsage(c: CallerHeaders): Promise<{ used: number; cap: number }> {
    return fetchJson(`${GATEWAY_URL}/admin/usage`, { headers: await authHeaders(c) });
  },
};
