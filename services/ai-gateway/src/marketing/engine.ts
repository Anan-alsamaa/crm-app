import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * THE PROMOTION ENGINE PROXY (owner, 2026-11-15): the Marketing portal's live
 * engine is Yiji v2, reached only through here. The browser holds no v2
 * credential; this checks the person may use the Marketing portal (the same
 * door as the points routes), adds the engine key and forwards 1:1:
 *
 *   /commerce/marketing/engine/<path>  ->  MARKETING_ENGINE_URL/v1/<path>
 *
 * Unset `MARKETING_ENGINE_URL` = every call answers 503 `engine_not_configured`
 * and the portal stays on its sample engine. Going live is these two
 * variables on the gateway plus the portal's `marketing_engine` setting.
 */
export interface MarketingEngineProxyDeps {
  directusUrl: string;
  engineUrl: string;
  engineKey: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Per signed-in user per minute. */
  perUserPerMin?: number;
  /** Per forwarded call. */
  timeoutMs?: number;
}

const ALLOWED = /^[A-Za-z0-9/_\-.]{1,200}$/;

export async function registerMarketingEngineProxy(
  app: FastifyInstance,
  deps: MarketingEngineProxyDeps,
): Promise<void> {
  const f = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const base = deps.engineUrl.replace(/\/+$/, '');
  const limit = deps.perUserPerMin ?? 120;
  const doorCache = new Map<string, { ok: boolean; at: number }>();
  const recent = new Map<string, number[]>();

  async function door(
    req: FastifyRequest,
  ): Promise<{ ok: boolean; status: number; error?: string }> {
    const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]?.trim();
    if (!token) return { ok: false, status: 401, error: 'unauthenticated' };
    const hit = doorCache.get(token);
    let ok: boolean;
    if (hit && now() - hit.at < 60_000) ok = hit.ok;
    else {
      /* The marketing activity log is readable by exactly the roles that may
         use the portal (use_marketing_portal): reading it is the door. */
      const res = await f(`${deps.directusUrl}/items/marketing_activity?limit=0&fields=id`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (res.status >= 500) return { ok: false, status: 503, error: 'directus_unavailable' };
      ok = res.ok;
      doorCache.set(token, { ok, at: now() });
      if (doorCache.size > 2000) doorCache.delete(doorCache.keys().next().value as string);
    }
    if (!ok) return { ok: false, status: 403, error: 'forbidden' };
    const key = token.slice(-24);
    const times = (recent.get(key) ?? []).filter((t) => now() - t < 60_000);
    if (times.length >= limit) return { ok: false, status: 429, error: 'rate_limited' };
    times.push(now());
    recent.set(key, times);
    return { ok: true, status: 200 };
  }

  app.all<{ Params: { '*': string } }>('/commerce/marketing/engine/*', async (req, reply) => {
    const d = await door(req);
    if (!d.ok) return reply.code(d.status).send({ error: d.error });
    if (!base || !deps.engineKey) return reply.code(503).send({ error: 'engine_not_configured' });
    const path = req.params['*'] ?? '';
    if (!ALLOWED.test(path) || path.includes('..'))
      return reply.code(400).send({ error: 'bad_path' });
    const qs = req.raw.url?.includes('?') ? req.raw.url.slice(req.raw.url.indexOf('?')) : '';
    const method = req.method.toUpperCase();
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method))
      return reply.code(405).send({ error: 'method' });
    try {
      const res = await f(`${base}/v1/${path}${qs}`, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${deps.engineKey}`,
          ...(method === 'GET' || method === 'DELETE'
            ? {}
            : { 'content-type': 'application/json' }),
        },
        body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(req.body ?? {}),
        signal: AbortSignal.timeout(deps.timeoutMs ?? 20_000),
      });
      const text = await res.text();
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      if (!res.ok) {
        const err =
          (data as { error?: string; message?: string } | null)?.error ?? `engine_${res.status}`;
        return reply
          .code(res.status >= 500 ? 502 : res.status)
          .send({ error: err, detail: (data as { message?: string } | null)?.message ?? null });
      }
      /* v2 answers either a bare value or {data}: the portal always gets {data}. */
      const body = data && typeof data === 'object' && 'data' in (data as object) ? data : { data };
      return reply.code(200).send(body);
    } catch (err) {
      const timeout = (err as Error)?.name === 'TimeoutError';
      req.log.warn({ err: (err as Error)?.message, path }, 'marketing engine call failed');
      return reply
        .code(timeout ? 504 : 502)
        .send({ error: timeout ? 'engine_timeout' : 'engine_unreachable' });
    }
  });
}
