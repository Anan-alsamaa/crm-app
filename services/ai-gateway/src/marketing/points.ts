import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * MARKETING PORTAL - POINTS, READ-ONLY (owner, 2026-11-02).
 *
 * A customer's points, the points-earning rules and Yiji's points reports, for
 * the Marketing portal. Nothing here changes anything on Yiji: giving points
 * and changing rules go through a manager's approval and the workers.
 *
 * WHO MAY ASK: the caller's OWN Directus session must be able to read
 * `marketing_activity` - which only the Marketing portal's door
 * (`use_marketing_portal`) grants. Directus decides, not this file, and the
 * gateway needs no new grants of its own.
 *
 * YIJI LOAD: every call goes through the process-wide outbound Yiji guard
 * (installed at startup) and is recorded. On top: answers are cached briefly,
 * one person may make at most PER_USER_PER_MIN lookups a minute, and a report
 * covers at most 31 days.
 *
 * Uses the CRM's Yiji account (owner, 2026-11-02: Yiji has no marketing one).
 */

export interface MarketingPointsDeps {
  directusUrl: string;
  yiji: { adminApiUrl?: string; email?: string; password?: string; tenantId?: string };
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const PER_USER_PER_MIN = 20;
const MAX_REPORT_DAYS = 31;
const TTL = { customer: 60_000, rules: 300_000, report: 300_000 };

export async function registerMarketingPointsRoutes(
  app: FastifyInstance,
  deps: MarketingPointsDeps,
): Promise<void> {
  const f = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const admin = (deps.yiji.adminApiUrl ?? '').replace(/\/+$/, '');
  const tenant = deps.yiji.tenantId || '1';

  /* ── the door ─────────────────────────────────────────────────────────── */
  const doorCache = new Map<string, { ok: boolean; at: number }>();
  const recent = new Map<string, number[]>();
  async function door(req: FastifyRequest): Promise<{ ok: boolean; status: number; who: string }> {
    const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]?.trim();
    if (!token) return { ok: false, status: 401, who: '' };
    const hit = doorCache.get(token);
    let ok: boolean;
    if (hit && now() - hit.at < 60_000) ok = hit.ok;
    else {
      const res = await f(`${deps.directusUrl}/items/marketing_activity?limit=0&fields=id`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (res.status >= 500) return { ok: false, status: 503, who: '' };
      ok = res.ok;
      doorCache.set(token, { ok, at: now() });
    }
    if (!ok) return { ok: false, status: 403, who: '' };
    /* A small per-session budget: a person, not a script. */
    const key = token.slice(-24);
    const times = (recent.get(key) ?? []).filter((t) => now() - t < 60_000);
    if (times.length >= PER_USER_PER_MIN) return { ok: false, status: 429, who: key };
    times.push(now());
    recent.set(key, times);
    return { ok: true, status: 200, who: key };
  }

  /* ── Yiji, as the CRM account ─────────────────────────────────────────── */
  let yijiToken: { value: string; at: number } | null = null;
  async function token(): Promise<string> {
    if (yijiToken && now() - yijiToken.at < 30 * 60_000) return yijiToken.value;
    const res = await f(`${admin}/api/Account/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ email: deps.yiji.email, password: deps.yiji.password }),
    });
    const body = (await res.json().catch(() => ({}))) as { token?: string };
    if (!res.ok || !body.token) throw new Error(`yiji login ${res.status}`);
    yijiToken = { value: body.token, at: now() };
    return body.token;
  }
  async function yiji<T>(path: string, query = false): Promise<T> {
    const t = await token();
    const url = query
      ? `${admin}${path}${path.includes('?') ? '&' : '?'}authorization=${encodeURIComponent(`Bearer ${t}`)}`
      : `${admin}${path}`;
    const res = await f(url, {
      headers: {
        accept: 'application/json',
        ...(query ? {} : { authorization: `Bearer ${t}` }),
        tenantid: tenant,
      },
    });
    if (res.status === 401) yijiToken = null;
    if (!res.ok)
      throw Object.assign(new Error(`yiji ${path} ${res.status}`), { status: res.status });
    return (await res.json()) as T;
  }
  const cache = new Map<string, { at: number; v: unknown }>();
  async function cached<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttl) return hit.v as T;
    const v = await fn();
    cache.set(key, { at: now(), v });
    if (cache.size > 500) cache.delete(cache.keys().next().value as string);
    return v;
  }

  const configured = () => Boolean(admin && deps.yiji.email && deps.yiji.password);

  async function handle(
    req: FastifyRequest,
    reply: import('fastify').FastifyReply,
    fn: () => Promise<unknown>,
  ) {
    const d = await door(req).catch(() => ({ ok: false, status: 503, who: '' }));
    if (!d.ok) return reply.code(d.status).send({ error: 'not_allowed' });
    if (!configured()) return reply.code(503).send({ error: 'yiji_not_configured' });
    try {
      return reply.send({ data: await fn() });
    } catch (err) {
      const status = (err as { status?: number }).status;
      app.log.warn(
        { err: String((err as Error).message), route: req.url.split('?')[0] },
        'marketing points: yiji failed',
      );
      if (status === 400) return reply.code(400).send({ error: 'bad_request' });
      if (status === 403) return reply.code(502).send({ error: 'yiji_refused' });
      return reply.code(504).send({ error: 'yiji_unavailable' });
    }
  }

  /** A customer's points, found by phone (an EXACT +966 match, one account only). */
  app.get('/commerce/marketing/points/customer', (req, reply) =>
    handle(req, reply, async () => {
      const phone = String((req.query as { phone?: string }).phone ?? '');
      const national = phone
        .replace(/\D/g, '')
        .replace(/^00/, '')
        .replace(/^966/, '')
        .replace(/^0+/, '');
      if (national.length < 8) return { found: false, reason: 'bad_phone' };
      return cached(`c:${national}`, TTL.customer, async () => {
        const users = await yiji<
          Array<{
            id?: string;
            phoneNumber?: string;
            fullName?: string;
            firstName?: string;
            lastName?: string;
          }>
        >(`/api/User/GetfilteredCustomers?PhoneNumber=${encodeURIComponent(national)}`);
        const exact = (Array.isArray(users) ? users : []).filter(
          (u) => (u.phoneNumber ?? '').replace(/\D/g, '').replace(/^00/, '') === `966${national}`,
        );
        if (exact.length !== 1) return { found: false, reason: exact.length ? 'several' : 'none' };
        const u = exact[0]!;
        const points = await yiji<unknown>(
          `/api/UserLoyalityPoints/GetUserLoyalityPoints/User/${encodeURIComponent(u.id ?? '')}?PageNumber=1&PageSize=100`,
        );
        return {
          found: true,
          customer: {
            id: u.id,
            phone: `0${national}`,
            name: u.fullName || [u.firstName, u.lastName].filter(Boolean).join(' ') || null,
          },
          points,
        };
      });
    }),
  );

  /** How customers earn points: the fixed and the percentage rules. */
  app.get('/commerce/marketing/points/rules', (req, reply) =>
    handle(req, reply, () =>
      cached('rules', TTL.rules, async () => {
        const [fixed, percentage] = await Promise.all([
          yiji<unknown>('/api/FixedPointsLoyality/GetAllFixedPointsLoyality'),
          yiji<unknown>('/api/PourcentagePointsLoyality/GetAllPourcentagePointsLoyality').catch(
            () => null,
          ),
        ]);
        return { fixed, percentage };
      }),
    ),
  );

  /** Yiji's points reports: issued or used, for at most 31 days. */
  app.get('/commerce/marketing/points/report', (req, reply) =>
    handle(req, reply, async () => {
      const q = req.query as { type?: string; from?: string; to?: string };
      const kind = q.type === 'consumed' ? 'ConsumedPoints' : 'IssuedPoints';
      const from = String(q.from ?? '').slice(0, 16);
      const to = String(q.to ?? '').slice(0, 16);
      const ok = (s: string) => /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(s);
      if (!ok(from) || !ok(to)) throw Object.assign(new Error('bad dates'), { status: 400 });
      const days = (Date.parse(to.slice(0, 10)) - Date.parse(from.slice(0, 10))) / 86_400_000;
      if (!(days >= 0) || days > MAX_REPORT_DAYS)
        throw Object.assign(new Error('range'), { status: 400 });
      return cached(`r:${kind}:${from}:${to}`, TTL.report, () =>
        yiji<unknown>(
          `/api/Report/${kind}?pageNumber=1&pageSize=5000&From=${encodeURIComponent(from)}&To=${encodeURIComponent(to)}`,
          true,
        ),
      );
    }),
  );
}
