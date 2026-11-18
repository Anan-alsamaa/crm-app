import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerMarketingEngineRoutes } from '../src/marketing/engine-routes.js';
import { StoreError } from '../src/marketing/engine-store.js';
import { MemoryEngineStore, forecastFor, issuableDraft } from './marketing-engine-fixture.js';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Who each bearer token is, as Directus would answer for that session. */
const PEOPLE: Record<
  string,
  { id: string; role: { id: string; name: string }; privileges?: unknown }
> = {
  'tok-maker': {
    id: 'u-maker',
    role: { id: 'r-mkt', name: 'Marketing' },
    privileges: { use_marketing_portal: true, manage_marketing: true },
  },
  'tok-checker': {
    id: 'u-checker',
    role: { id: 'r-mgr', name: 'Marketing Manager' },
    /* Stored as a string, as some rows are. */
    privileges: JSON.stringify({ use_marketing_portal: true, approve_marketing: true }),
  },
  'tok-agent': {
    id: 'u-agent',
    role: { id: 'r-agent', name: 'Agent' },
    privileges: { use_chat: true },
  },
  'tok-admin': { id: 'u-admin', role: { id: 'r-admin', name: 'Administrator' } },
};

function setup(opts: { directusDown?: boolean; perUserPerMin?: number } = {}) {
  const store = new MemoryEngineStore();
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (opts.directusDown) return json(503, {});
    const token = String((init?.headers as Record<string, string>)?.authorization ?? '').replace(
      'Bearer ',
      '',
    );
    const who = PEOPLE[token];
    if (url.includes('/users/me')) return who ? json(200, { data: who }) : json(401, {});
    if (url.includes('/items/app_roles')) {
      const role = new URL(url).searchParams.get('filter') ?? '';
      const p = Object.values(PEOPLE).find((x) => role.includes(x.role.id));
      return json(200, { data: p?.privileges !== undefined ? [{ privileges: p.privileges }] : [] });
    }
    return json(404, {});
  });
  const app = Fastify();
  void registerMarketingEngineRoutes(app, {
    directusUrl: 'https://d.test/',
    store,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    perUserPerMin: opts.perUserPerMin,
  });
  const call = (
    token: string | null,
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    body?: unknown,
  ) =>
    app.inject({
      method,
      url: `/commerce/marketing/engine${url}`,
      payload: body as never,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  return { app, store, call, calls };
}

describe('the CRM marketing engine routes: the door', () => {
  it('401 without a session, 401 for a dead one, 403 for a role without the Marketing portal', async () => {
    const { call } = setup();
    expect((await call(null, 'GET', '/home')).statusCode).toBe(401);
    expect((await call('tok-dead', 'GET', '/home')).statusCode).toBe(401);
    const r = await call('tok-agent', 'GET', '/home');
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: 'forbidden' });
  });

  it('503 when Directus cannot say who is asking', async () => {
    const { call } = setup({ directusDown: true });
    expect((await call('tok-maker', 'GET', '/home')).json()).toEqual({
      error: 'directus_unavailable',
    });
  });

  it('lets the Administrator in without an app_roles row, and asks who is asking on EVERY request', async () => {
    const { call, calls } = setup();
    expect((await call('tok-admin', 'GET', '/money-model')).statusCode).toBe(200);
    await call('tok-admin', 'GET', '/money-model');
    /* No actor cache (owner, 18 Nov 2026: privilege changes apply instantly). */
    expect(calls.filter((u) => u.includes('/users/me'))).toHaveLength(2);
    expect(calls.some((u) => u.includes('/items/app_roles'))).toBe(false);
  });

  it('a privilege revoked on the Roles page applies to the very next request (no lag)', async () => {
    const { call } = setup();
    const maker = PEOPLE['tok-maker']!;
    const before = maker.privileges;
    try {
      expect((await call('tok-maker', 'GET', '/home')).statusCode).toBe(200);
      maker.privileges = { manage_marketing: true, use_marketing_portal: false };
      expect((await call('tok-maker', 'GET', '/home')).statusCode).toBe(403);
      maker.privileges = before;
      expect((await call('tok-maker', 'GET', '/home')).statusCode).toBe(200);
    } finally {
      maker.privileges = before;
    }
  });

  it('a session signed out (or moved off the role) is refused on the very next request', async () => {
    const { call } = setup();
    expect((await call('tok-checker', 'GET', '/home')).statusCode).toBe(200);
    const was = PEOPLE['tok-checker']!;
    delete PEOPLE['tok-checker'];
    try {
      expect((await call('tok-checker', 'GET', '/home')).statusCode).toBe(401);
    } finally {
      PEOPLE['tok-checker'] = was;
    }
  });

  it('a person, not a script: rate limited per user', async () => {
    const { call } = setup({ perUserPerMin: 2 });
    await call('tok-maker', 'GET', '/campaigns');
    await call('tok-maker', 'GET', '/campaigns');
    expect((await call('tok-maker', 'GET', '/campaigns')).statusCode).toBe(429);
  });

  it('calls nothing but Directus', async () => {
    const { call, calls } = setup();
    await call('tok-maker', 'GET', '/home');
    await call('tok-maker', 'GET', '/catalogue');
    expect(calls.every((u) => u.startsWith('https://d.test/'))).toBe(true);
  });
});

describe('the CRM marketing engine routes: the paths live.ts calls', () => {
  it('runs a campaign end to end over HTTP: create, submit, four eyes, decide, live, issue', async () => {
    const { call, store } = setup();
    const created = await call('tok-maker', 'POST', '/campaigns', issuableDraft());
    expect(created.statusCode).toBe(200);
    const id = created.json().data.id as string;
    expect(created.json().data).toMatchObject({ status: 'draft', createdBy: 'u-maker' });

    expect((await call('tok-maker', 'GET', '/campaigns?status=draft')).json().data).toHaveLength(1);
    expect((await call('tok-maker', 'GET', '/campaigns?status=live')).json().data).toHaveLength(0);
    expect((await call('tok-maker', 'GET', `/campaigns/${id}`)).json().data.id).toBe(id);
    expect((await call('tok-maker', 'GET', '/campaigns/CMP-nope')).json()).toEqual({ data: null });

    const put = await call('tok-maker', 'PUT', `/campaigns/${id}`, {
      ...issuableDraft(),
      notes: 'edited',
    });
    expect(put.json().data.notes).toBe('edited');

    const sub = await call('tok-maker', 'POST', `/campaigns/${id}/submit`, {
      forecast: forecastFor(),
    });
    expect(sub.json().data.status).toBe('waiting_approval');

    /* The maker is not an approver: 403 before the four-eyes rule is even asked. */
    const self = await call('tok-maker', 'POST', `/campaigns/${id}/decision`, {
      decision: 'approve',
      note: '',
    });
    expect(self.statusCode).toBe(403);
    expect(self.json().error).toBe('approve_marketing_required');

    const ok = await call('tok-checker', 'POST', `/campaigns/${id}/decision`, {
      decision: 'approve',
      note: 'within budget',
    });
    expect(ok.json().data).toMatchObject({
      status: 'approved',
      approval: { decidedBy: 'u-checker' },
    });

    const live = await call('tok-maker', 'POST', `/campaigns/${id}/status`, { status: 'live' });
    expect(live.json().data.status).toBe('live');

    const locked = await call('tok-maker', 'PUT', `/campaigns/${id}`, {
      ...issuableDraft(),
      offer: { type: 'FIXED', amountSar: 99 },
    });
    expect(locked.statusCode).toBe(422);
    expect(locked.json()).toEqual({ error: 'locked_while_live', detail: { fields: ['offer'] } });

    const issued = await call('tok-maker', 'POST', '/issuance', {
      campaignId: id,
      customerIds: ['0551234567'],
    });
    expect(issued.json().data).toMatchObject({ requested: 1, issued: 1 });
    expect(store.coupons[0]!.row).toMatchObject({ status: 'approved', decided_by: 'u-checker' });

    expect(
      (await call('tok-maker', 'GET', `/campaigns/${id}/performance`)).json().data.issued,
    ).toBe(0);
    expect(
      (await call('tok-maker', 'GET', `/campaigns/${id}/redemptions?limit=5`)).json().data,
    ).toEqual([]);
    const sim = await call('tok-maker', 'POST', '/checkout/simulate', {
      campaignId: id,
      brandId: '1',
      orderType: 'DELIVERY',
      subtotalSar: 85,
      otherOffer: false,
      otherCoupon: false,
      loyalty: false,
    });
    expect(sim.json().data).toMatchObject({ allowed: true, discountSar: 10 });
    expect((await call('tok-maker', 'GET', '/home')).json().data.coupons.live).toBe(1);
    expect((await call('tok-maker', 'GET', '/liability')).json().data.totalFaceValueSar).toBe(5000);
  });

  it('answers every read path the portal uses with {data}', async () => {
    const { call } = setup();
    for (const path of [
      '/home',
      '/catalogue',
      '/money-model',
      '/campaigns',
      '/liability',
      '/gift-cards/products',
      '/gift-cards/stats?from=2026-11-01&to=2026-11-16',
      '/gift-cards/activity?limit=40',
      '/rewards/earning-rules',
      '/rewards/campaigns',
      '/rewards/items',
      '/rewards/stats',
      '/rewards/members?q=&limit=50',
      '/orders/export?from=2026-11-01&to=2026-11-16',
      '/studies',
      '/studies/opportunities?from=2026-11-01&to=2026-11-16',
      '/studies/customer-groups?from=2026-11-01&to=2026-11-16',
      '/studies/STU-none',
    ]) {
      const r = await call('tok-maker', 'GET', path);
      expect(r.statusCode, path).toBe(200);
      expect(r.json(), path).toHaveProperty('data');
    }
  });

  it('saves gift card products, earning rules and studies under the right privilege', async () => {
    const { call } = setup();
    const product = {
      name: { en: 'Gift card SAR 50', ar: 'بطاقة' },
      valueSar: 50,
      priceSar: 50,
      validityDays: 365,
      design: { background: '#000', accent: '#fff', message: 'Enjoy' },
      active: true,
      canCombineWithCoupons: false,
    };
    expect((await call('tok-checker', 'POST', '/gift-cards/products', product)).statusCode).toBe(
      403,
    );
    const p = (await call('tok-maker', 'POST', '/gift-cards/products', product)).json().data;
    const put = await call('tok-maker', 'PUT', `/gift-cards/products/${p.id}`, {
      ...product,
      priceSar: 45,
    });
    expect(put.json().data.priceSar).toBe(45);

    const rule = {
      name: 'Standard',
      cashbackPct: { DELIVERY: 5, PICKUP: 8, CARHOP: 10, DINE_IN: 5 },
      brandIds: [],
      active: true,
      validFrom: '2026-01-01',
      validTo: null,
    };
    const r = (await call('tok-admin', 'POST', '/rewards/earning-rules', rule)).json().data;
    expect(
      (
        await call('tok-admin', 'PUT', `/rewards/earning-rules/${r.id}`, { ...rule, name: 'X' })
      ).json().data.name,
    ).toBe('X');

    const study = {
      id: 'STU-2611-0001',
      name: 'Lunch',
      stage: 'draft',
      objective: 'SLOW_HOURS',
      createdBy: 'x',
      createdAt: 'x',
      period: { from: '2026-05-01', to: '2026-11-01' },
      data: {
        rowsRead: 0,
        completedOrders: 0,
        notCompleted: 0,
        brands: 0,
        cities: 0,
        customers: 0,
        revenueSar: 0,
      },
      scenarios: [],
      chosenScenarioId: null,
      review: { by: null, at: null, note: null },
      approval: {
        requestedBy: null,
        requestedAt: null,
        decidedBy: null,
        decidedAt: null,
        note: null,
      },
      campaignId: null,
    };
    const s = await call('tok-maker', 'PUT', '/studies/STU-2611-0001', study);
    expect(s.json().data).toMatchObject({ id: 'STU-2611-0001', createdBy: 'u-maker' });
    expect((await call('tok-maker', 'GET', '/studies/STU-2611-0001')).json().data.name).toBe(
      'Lunch',
    );
  });

  it('a refusal is a 4xx with its code, never a 200', async () => {
    const { call } = setup();
    const bad = await call('tok-maker', 'POST', '/campaigns', { objective: 'NOPE' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error).toBe('invalid_campaign');
    expect(bad.json().detail.field).toBe('objective');
    expect((await call('tok-maker', 'POST', '/campaigns/CMP-x/submit', {})).statusCode).toBe(404);
  });

  it('a storage failure is 503 (502 when Directus refuses the service account), with no detail', async () => {
    const { call, store } = setup();
    store.listCampaigns = async () => {
      throw new StoreError('directus GET /items/marketing_campaigns 500', 500);
    };
    const r = await call('tok-maker', 'GET', '/campaigns');
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: 'engine_storage_unavailable' });
    store.listCampaigns = async () => {
      throw new StoreError('directus GET /items/marketing_campaigns 403', 403);
    };
    expect((await call('tok-maker', 'GET', '/campaigns')).json()).toEqual({
      error: 'engine_storage_refused',
    });
  });
});
