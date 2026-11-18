import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { effectivePrivileges } from '@yiji/shared-types';
import {
  CrmMarketingEngine,
  EngineRefusal,
  type Actor,
  type CrmEngineOptions,
} from './crm-engine.js';
import { StoreError, type EngineStore } from './engine-store.js';

/**
 * THE MARKETING ENGINE, SERVED BY THE CRM (owner, 2026-11-16).
 *
 *   /commerce/marketing/engine/<path>   - the same paths the portal's live
 *                                         engine (`live.ts`) has always called
 *
 * Replaces the proxy to an external engine as the default: nothing outside
 * the CRM is called. `MARKETING_ENGINE_URL` + `_KEY` still select the proxy
 * (`engine.ts`) if an external engine is ever put back - that is the only
 * cost of keeping it.
 *
 * WHO IS ASKING, decided by Directus from the caller's OWN session:
 *   - `/users/me` names the person and their role;
 *   - their `app_roles` row (which every role may read) gives their
 *     privileges, filled in by `effectivePrivileges` exactly as the portal
 *     does; the Administrator role holds everything;
 *   - the door is `use_marketing_portal`; preparing and deciding are checked
 *     per call by the engine.
 * Asked FRESH on every request - no actor cache (owner, 18 Nov 2026:
 * privilege changes take effect instantly, no lag). The per-user rate limit
 * below stays and bounds the cost.
 * The engine then reads and writes with the gateway's service account only.
 */

export interface MarketingEngineRoutesDeps {
  directusUrl: string;
  store: EngineStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Per signed-in user per minute. */
  perUserPerMin?: number;
  engine?: CrmMarketingEngine;
  /** Engine options (production: a Redis lock across gateway tasks). */
  engineOptions?: CrmEngineOptions;
}

/** Roles that hold every marketing switch (mirrors the portal's ADMIN_ROLES). */
export const MARKETING_ADMIN_ROLES = ['Administrator'];

type Door = { ok: true; actor: Actor } | { ok: false; status: number; error: string };

export async function registerMarketingEngineRoutes(
  app: FastifyInstance,
  deps: MarketingEngineRoutesDeps,
): Promise<void> {
  const f = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const limit = deps.perUserPerMin ?? 120;
  const engine = deps.engine ?? new CrmMarketingEngine(deps.store, deps.engineOptions ?? {});
  const base = deps.directusUrl.replace(/\/+$/, '');
  const recent = new Map<string, number[]>();

  async function asCaller<T>(token: string, path: string): Promise<{ status: number; data?: T }> {
    const res = await f(`${base}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { status: res.status };
    const body = (await res.json().catch(() => ({}))) as { data?: T };
    return { status: res.status, data: body.data };
  }

  async function resolveActor(token: string): Promise<Actor | null | 'unavailable'> {
    const me = await asCaller<{ id?: string; role?: { id?: string; name?: string } | null }>(
      token,
      '/users/me?fields=id,role.id,role.name',
    );
    if (me.status >= 500) return 'unavailable';
    if (me.status === 401 || me.status === 403 || !me.data?.id) return null;
    const roleId = me.data.role?.id ?? null;
    const roleName = me.data.role?.name ?? '';
    const isAdmin = MARKETING_ADMIN_ROLES.includes(roleName);
    let stored: Record<string, boolean> | null = null;
    if (roleId && !isAdmin) {
      const q = new URLSearchParams({
        filter: JSON.stringify({ directus_role: { _eq: roleId } }),
        fields: 'privileges',
        limit: '1',
      });
      const rows = await asCaller<Array<{ privileges: unknown }>>(
        token,
        `/items/app_roles?${q.toString()}`,
      );
      if (rows.status >= 500) return 'unavailable';
      const raw = rows.data?.[0]?.privileges;
      stored = (typeof raw === 'string' ? safeJson(raw) : raw) as Record<string, boolean> | null;
    }
    const actor: Actor = {
      id: me.data.id,
      isAdmin,
      privileges: isAdmin ? {} : effectivePrivileges(stored, roleName),
    };
    return actor;
  }

  async function door(req: FastifyRequest): Promise<Door> {
    const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]?.trim();
    if (!token) return { ok: false, status: 401, error: 'unauthenticated' };
    let actor: Actor | null | 'unavailable';
    try {
      actor = await resolveActor(token);
    } catch {
      actor = 'unavailable';
    }
    if (actor === 'unavailable') return { ok: false, status: 503, error: 'directus_unavailable' };
    if (!actor) return { ok: false, status: 401, error: 'unauthenticated' };
    if (!actor.isAdmin && actor.privileges.use_marketing_portal !== true)
      return { ok: false, status: 403, error: 'forbidden' };
    const times = (recent.get(actor.id) ?? []).filter((t) => now() - t < 60_000);
    if (times.length >= limit) return { ok: false, status: 429, error: 'rate_limited' };
    times.push(now());
    recent.set(actor.id, times);
    if (recent.size > 5000) recent.delete(recent.keys().next().value as string);
    return { ok: true, actor };
  }

  type Handler = (ctx: {
    actor: Actor;
    params: Record<string, string>;
    query: Record<string, string>;
    body: unknown;
  }) => Promise<unknown>;

  function route(method: 'GET' | 'POST' | 'PUT', path: string, handler: Handler) {
    app.route({
      method,
      url: `/commerce/marketing/engine${path}`,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const d = await door(req);
        if (!d.ok) return reply.code(d.status).send({ error: d.error });
        try {
          const data = await handler({
            actor: d.actor,
            params: (req.params ?? {}) as Record<string, string>,
            query: (req.query ?? {}) as Record<string, string>,
            body: req.body ?? null,
          });
          return reply.code(200).send({ data });
        } catch (err) {
          if (err instanceof EngineRefusal)
            return reply.code(err.status).send({
              error: err.code,
              ...(err.detail !== undefined ? { detail: err.detail } : {}),
            });
          const status = err instanceof StoreError ? err.status : 0;
          req.log.warn(
            { err: (err as Error)?.message, route: path, status },
            'marketing engine call failed',
          );
          return reply.code(status === 403 ? 502 : 503).send({
            error: status === 403 ? 'engine_storage_refused' : 'engine_storage_unavailable',
          });
        }
      },
    });
  }

  const range = (q: Record<string, string>) => ({
    from: String(q.from ?? ''),
    to: String(q.to ?? ''),
  });

  route('GET', '/home', () => engine.home());
  route('GET', '/catalogue', () => engine.catalogue());
  route('GET', '/money-model', () => engine.moneyModel());

  route('GET', '/campaigns', ({ query }) =>
    engine.listCampaigns({ status: query.status, objective: query.objective }),
  );
  /* `null` for an unknown id, as the interface (and the sample) answers it:
     the page shows "No campaign with that id" rather than an error. */
  route('GET', '/campaigns/:id', ({ params }) => engine.getCampaign(params.id!));
  route('POST', '/campaigns', ({ actor, body }) => engine.saveCampaign(actor, body));
  route('PUT', '/campaigns/:id', ({ actor, body, params }) =>
    engine.saveCampaign(actor, body, params.id),
  );
  route('POST', '/campaigns/:id/submit', ({ actor, body, params }) =>
    engine.submitForApproval(actor, params.id!, body),
  );
  route('POST', '/campaigns/:id/decision', ({ actor, body, params }) =>
    engine.decideCampaign(actor, params.id!, body),
  );
  route('POST', '/campaigns/:id/status', ({ actor, body, params }) =>
    engine.setCampaignStatus(actor, params.id!, body),
  );
  route('GET', '/campaigns/:id/performance', ({ params }) => engine.performance(params.id!));
  route('GET', '/campaigns/:id/redemptions', ({ params }) => engine.redemptions(params.id!));
  route('POST', '/issuance', ({ actor, body }) => engine.issue(actor, body));
  route('POST', '/checkout/simulate', ({ body }) => engine.simulateCheckout(body));

  route('GET', '/liability', () => engine.liability());
  route('GET', '/gift-cards/products', () => engine.giftCardProducts());
  route('POST', '/gift-cards/products', ({ actor, body }) =>
    engine.saveGiftCardProduct(actor, body),
  );
  route('PUT', '/gift-cards/products/:id', ({ actor, body, params }) =>
    engine.saveGiftCardProduct(actor, body, params.id),
  );
  route('GET', '/gift-cards/stats', ({ query }) => engine.giftCardStats(range(query)));
  route('GET', '/gift-cards/activity', () => engine.giftCardActivity());

  route('GET', '/rewards/earning-rules', () => engine.earningRules());
  route('POST', '/rewards/earning-rules', ({ actor, body }) => engine.saveEarningRule(actor, body));
  route('PUT', '/rewards/earning-rules/:id', ({ actor, body, params }) =>
    engine.saveEarningRule(actor, body, params.id),
  );
  route('GET', '/rewards/campaigns', () => engine.rewardsCampaigns());
  route('GET', '/rewards/items', () => engine.rewardsItems());
  route('GET', '/rewards/stats', () => engine.rewardsStats());
  route('GET', '/rewards/members', () => engine.rewardsMembers());

  route('GET', '/orders/export', () => engine.ordersExport());
  route('GET', '/studies', () => engine.listStudies());
  /* Registered before `/studies/:id` reads clearer; find-my-way prefers the
     static segment either way. */
  route('GET', '/studies/opportunities', () => engine.opportunities());
  route('GET', '/studies/customer-groups', () => engine.customerGroups());
  route('GET', '/studies/:id', ({ params }) => engine.getStudy(params.id!));
  route('PUT', '/studies/:id', ({ actor, body, params }) =>
    engine.saveStudy(actor, body, params.id!),
  );
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
