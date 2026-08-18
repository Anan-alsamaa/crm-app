import type { AiFeatureConfig, HelpAssistantResponse, HelpAssistantTurn } from '@yiji/shared-types';
import { AI_ENDPOINTS } from '@yiji/shared-types';
import { resolveUrl } from '@yiji/shared-config';
import { auth } from './directus.js';

/**
 * Thin fetch wrapper for the ai-gateway admin endpoints.
 *
 * Auth: we send the admin's own **Directus access token** as a Bearer token; the
 * gateway verifies it and derives admin status from the user's Directus role
 * server-side. No service token is shipped to the browser, and the old
 * self-asserted `x-yiji-admin` header is gone (the gateway ignores it).
 */

const GATEWAY_URL = resolveUrl(
  'AI_GATEWAY_URL',
  import.meta.env.VITE_AI_GATEWAY_URL as string | undefined,
  'http://localhost:8081',
);

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

/**
 * Error shape for the non-admin AI endpoints the console calls (currently just
 * the help assistant). Keeps the gateway's structured error fields intact so
 * the UI can say *why* a call failed instead of "something went wrong".
 */
export interface AiError extends Error {
  status: number;
  code?: string;
  retryAfterMs?: number;
  scope?: string;
  limit?: number;
  resetAt?: string;
}

interface AiErrorPayload {
  error?: string;
  retryAfterMs?: number;
  scope?: string;
  limit?: number;
  resetAt?: string;
}

export const ai = {
  /** In-app help assistant — one question, one answer, no history kept. */
  /**
   * `history` carries the earlier turns of the CURRENT panel session so
   * follow-ups resolve. Nothing is persisted anywhere — the transcript lives
   * in component state and dies with the panel.
   */
  async helpAssistant(
    c: CallerHeaders,
    question: string,
    history: HelpAssistantTurn[] = [],
    /* The interface language, so the answer comes back in the language the
       question was asked in rather than always in English. */
    locale?: string,
  ): Promise<HelpAssistantResponse> {
    const res = await fetch(`${GATEWAY_URL}${AI_ENDPOINTS.helpAssistant}`, {
      method: 'POST',
      headers: await authHeaders(c),
      body: JSON.stringify({
        question,
        ...(history.length ? { history } : {}),
        ...(locale ? { locale } : {}),
      }),
    });
    if (!res.ok) {
      let payload: AiErrorPayload = {};
      try {
        payload = await res.json();
      } catch {
        /* ignore */
      }
      throw Object.assign(new Error(`AI gateway ${res.status}: ${payload.error ?? ''}`), {
        status: res.status,
        code: payload.error,
        retryAfterMs: payload.retryAfterMs,
        scope: payload.scope,
        limit: payload.limit,
        resetAt: payload.resetAt,
      }) as AiError;
    }
    return (await res.json()) as HelpAssistantResponse;
  },
};
