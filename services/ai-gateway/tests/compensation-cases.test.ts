import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import {
  MockYiji2Transport,
  OWN_CASE_MESSAGE,
  UnknownVendorError,
  Yiji2Connector,
  yiji2RequestKey,
  type CompensationCasePatch,
  type CompensationCaseRow,
  type VendorConnector,
  effectivePrivileges,
} from '@yiji/shared-types';
import {
  APPROVE_COMPENSATION_CASES,
  LOG_COMPENSATION_CASES,
  registerCompensationCaseRoutes,
  type CompensationCaseStore,
} from '../src/commerce/compensation-cases.js';
import {
  createSessionActorResolver,
  type SessionActor,
  type SessionActorResolver,
} from '../src/auth/session-actor.js';

/**
 * YIJI V2 COMPENSATION CASES - the agent portal's gateway routes (owner, 18
 * Nov 2026). Each action needs `approve_compensation_cases` (the
 * Administrator always), a ticket the CALLER can read, a v2 ticket, and a case
 * linked to that ticket. V2 is the in-memory mock: ZERO NETWORK.
 */

const NOW = Date.parse('2026-11-18T10:00:00Z');
const V2 = 'vendor-v2';
const V1 = 'vendor-v1';

/** Each role at its DEFAULTS (nothing stored but the shared ticket switches). */
const asRole = (id: string, role: string): SessionActor => ({
  id,
  isAdmin: false,
  privileges: effectivePrivileges({ view_tickets: true, create_tickets: true }, role),
});

const ACTORS: Record<string, SessionActor> = {
  /* Owner, 18 Nov 2026: WeCare Agent -> WeCare Supervisor -> WeCare Admin ->
     Administrator. Agents log; supervisors and WeCare admins approve. */
  'tok-agent': asRole('u-agent', 'WeCare Agent'),
  'tok-agent2': asRole('u-agent2', 'WeCare Agent'),
  'tok-approver': asRole('u-approver', 'WeCare Supervisor'),
  'tok-wcadmin': asRole('u-wcadmin', 'WeCare Admin'),
  'tok-ceo': asRole('u-ceo', 'CEO'),
  'tok-admin': { id: 'u-admin', isAdmin: true, privileges: {} },
};

function sessions(hidden: string[] = []): SessionActorResolver {
  return {
    resolve: async (token) => ACTORS[token] ?? null,
    canRead: async (_token, _c, id) => !hidden.includes(id),
  };
}

function memoryStore(): CompensationCaseStore & { rows: CompensationCaseRow[] } {
  const rows: CompensationCaseRow[] = [];
  let n = 0;
  const tickets: Record<string, { id: string; vendor: string; order_id: string | null }> = {
    't-v2': { id: 't-v2', vendor: V2, order_id: '2611000000001' },
    't-v2-other': { id: 't-v2-other', vendor: V2, order_id: '2611000000002' },
    /* A second ticket about the same order as t-v2. */
    't-v2-same-order': { id: 't-v2-same-order', vendor: V2, order_id: '2611000000001' },
    't-v2-noorder': { id: 't-v2-noorder', vendor: V2, order_id: null },
    't-v1': { id: 't-v1', vendor: V1, order_id: '1095975' },
  };
  return {
    rows,
    ticket: async (id) => tickets[id] ?? null,
    vendorPlatform: async (v) => (v === V2 ? 'yiji2' : v === V1 ? 'yiji' : null),
    casesForTicket: async (t) => rows.filter((r) => r.ticket === t).map((r) => ({ ...r })),
    caseById: async (id) => {
      const r = rows.find((x) => x.case_id === id);
      return r ? { ...r } : null;
    },
    createCase: async (p: CompensationCasePatch) => {
      if (rows.some((r) => r.case_id === p.case_id)) throw new Error('not unique');
      const row = { id: `row-${++n}`, ...p } as CompensationCaseRow;
      rows.push(row);
      return { ...row };
    },
    updateCase: async (id, p) => {
      const r = rows.find((x) => x.id === id)!;
      Object.assign(r, p);
      return { ...r };
    },
  };
}

function build(
  opts: { hidden?: string[]; inactive?: boolean; sessions?: SessionActorResolver } = {},
) {
  const transport = new MockYiji2Transport({ now: () => NOW });
  /* Every write's key as V2 receives it, replays included (the mock answers a
     known key from its store without noting a call). */
  const sentKeys: Array<string | undefined> = [];
  const request = transport.request.bind(transport);
  transport.request = ((method, path, o) => {
    if (method !== 'GET') sentKeys.push(o?.idempotencyKey);
    return request(method, path, o);
  }) as typeof transport.request;
  const connector = new Yiji2Connector(
    { crmId: V2, platformVendorId: '2', platform: 'yiji2', status: 'active' },
    { platform: 'yiji2', mock: true },
    { transport },
  );
  const connectorFor = vi.fn(async (key: string): Promise<VendorConnector> => {
    if (key !== V2 || opts.inactive) throw new UnknownVendorError(key, 'inactive');
    return connector as unknown as VendorConnector;
  });
  const store = memoryStore();
  const app = Fastify();
  void registerCompensationCaseRoutes(app, {
    sessions: opts.sessions ?? sessions(opts.hidden),
    store,
    connectors: { connectorFor },
    now: () => NOW,
  });
  return { app, store, transport, connectorFor, sentKeys };
}

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const key = (n: string) => `key-${n}-0000`;

/** A case on the v2 ticket, as the workers would have recorded it. */
async function seeded(b: ReturnType<typeof build>, over: Record<string, unknown> = {}) {
  const id = b.transport.seedCase(over);
  const wire = b.transport.cases.get(id)!;
  b.store.rows.push({
    id: `row-seed-${id}`,
    case_id: id,
    ticket: 't-v2',
    vendor: V2,
    status: wire.status,
    amount_minor: wire.amount?.amount_minor ?? null,
    currency: wire.amount?.currency ?? null,
    percent_bps: wire.percent_bps ?? null,
    action_type: wire.action_type ?? null,
    order_total_minor: wire.order_total?.amount_minor ?? null,
    order_currency: wire.order_total?.currency ?? null,
    agent_actions: null,
  } as unknown as CompensationCaseRow);
  return id;
}

describe('GET /commerce/compensation-cases (the ticket panel)', () => {
  it('answers a v2 ticket with its cases and whether the caller may act', async () => {
    const b = build();
    await seeded(b);
    const res = await b.app.inject({
      url: '/commerce/compensation-cases?ticketId=t-v2',
      headers: auth('tok-agent'),
    });
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d).toMatchObject({ v2: true, orderNumber: '2611000000001', canAct: false });
    expect(d.cases).toHaveLength(1);
    const admin = await b.app.inject({
      url: '/commerce/compensation-cases?ticketId=t-v2',
      headers: auth('tok-admin'),
    });
    expect(admin.json().data.canAct).toBe(true);
  });

  it('a v1 ticket: v2 false, no cases, nothing asked of any vendor', async () => {
    const b = build();
    const res = await b.app.inject({
      url: '/commerce/compensation-cases?ticketId=t-v1',
      headers: auth('tok-admin'),
    });
    expect(res.json().data).toMatchObject({ v2: false, cases: [], orderNumber: null });
    expect(b.connectorFor).not.toHaveBeenCalled();
  });

  it('a ticket the caller cannot read is 404; no session is 401', async () => {
    const b = build({ hidden: ['t-v2'] });
    expect(
      (
        await b.app.inject({
          url: '/commerce/compensation-cases?ticketId=t-v2',
          headers: auth('tok-admin'),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await b.app.inject({ url: '/commerce/compensation-cases?ticketId=t-v2' })).statusCode,
    ).toBe(401);
  });
});

describe('who logs, who decides (owner, 18 Nov 2026)', () => {
  const decisions = (caseId: string) => [
    { url: `/commerce/compensation-cases/${caseId}/approve`, body: { reason: 'ok' } },
    { url: `/commerce/compensation-cases/${caseId}/reject`, body: { reason: 'no' } },
    { url: `/commerce/compensation-cases/${caseId}/evidence`, body: { reason: 'seen' } },
    {
      url: `/commerce/compensation-cases/${caseId}/verification`,
      body: { reason: 'cams', result: 'confirmed' },
    },
  ];
  const post = (
    b: ReturnType<typeof build>,
    tok: string,
    url: string,
    body: Record<string, unknown>,
    ticket = 't-v2',
  ) =>
    b.app.inject({
      method: 'POST',
      url,
      headers: auth(tok),
      payload: { ticketId: ticket, idempotencyKey: key('x'), ...body },
    });
  const logAs = (b: ReturnType<typeof build>, tok: string, category = 'CUT') =>
    post(b, tok, '/commerce/compensation-cases', { category });

  it('a WeCare Agent (no approve privilege) may LOG a V2 complaint', async () => {
    expect(ACTORS['tok-agent']!.privileges[APPROVE_COMPENSATION_CASES]).toBe(false);
    expect(ACTORS['tok-agent']!.privileges[LOG_COMPENSATION_CASES]).toBe(true);
    const b = build();
    const res = await logAs(b, 'tok-agent');
    expect(res.statusCode).toBe(200);
    expect(res.json().data.case).toMatchObject({ ticket: 't-v2', logged_by_agent: 'u-agent' });
    expect(b.transport.calls.at(-1)).toMatchObject({
      path: '/compensation-cases',
      body: { agent_id: 'u-agent' },
    });
  });

  it('a WeCare Agent is 403 on approve / reject / evidence / verification; nothing reaches V2', async () => {
    const b = build();
    const id = await seeded(b);
    for (const r of decisions(id)) {
      const res = await post(b, 'tok-agent', r.url, r.body);
      expect(res.statusCode, r.url).toBe(403);
      expect(res.json().error).toBe('approve_compensation_cases_required');
    }
    expect(b.transport.calls).toHaveLength(0);
  });

  it('a role with neither switch (CEO) cannot log either: 403, nothing reaches V2', async () => {
    const b = build();
    const res = await logAs(b, 'tok-ceo');
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('log_compensation_cases_required');
    expect(b.transport.calls).toHaveLength(0);
  });

  it('a WeCare Supervisor and a WeCare Admin may approve and reject; so may the Administrator', async () => {
    const b = build();
    const id = await seeded(b);
    const res = await post(b, 'tok-approver', `/commerce/compensation-cases/${id}/approve`, {
      reason: 'late, fair',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.case).toMatchObject({ status: 'approved', issued_minor: 2000 });
    const id2 = await seeded(b);
    const wc = await post(b, 'tok-wcadmin', `/commerce/compensation-cases/${id2}/approve`, {
      reason: 'fair',
    });
    expect(wc.statusCode).toBe(200);
    const id3 = await seeded(b);
    const admin = await post(b, 'tok-admin', `/commerce/compensation-cases/${id3}/reject`, {
      reason: 'not our fault',
    });
    expect(admin.statusCode).toBe(200);
  });

  it('an agent logs, a supervisor approves the same case (the whole flow)', async () => {
    const b = build();
    const logged = await logAs(b, 'tok-agent', 'CUT');
    const caseId = logged.json().data.case.case_id as string;
    const res = await post(b, 'tok-approver', `/commerce/compensation-cases/${caseId}/approve`, {
      reason: 'checked the order',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.case.status).toBe('approved');
  });

  describe('four eyes: the person who logged a case never decides it', () => {
    it('own case: approve and reject are 403 own_case (EN and AR); nothing reaches V2', async () => {
      const b = build();
      const logged = await logAs(b, 'tok-approver', 'CUT');
      expect(logged.statusCode).toBe(200);
      const caseId = logged.json().data.case.case_id as string;
      const calls = b.transport.calls.length;
      for (const action of ['approve', 'reject'] as const) {
        const res = await post(
          b,
          'tok-approver',
          `/commerce/compensation-cases/${caseId}/${action}`,
          {
            reason: 'mine',
          },
        );
        expect(res.statusCode, action).toBe(403);
        expect(res.json()).toEqual({
          error: 'own_case',
          message: OWN_CASE_MESSAGE.en,
          message_ar: OWN_CASE_MESSAGE.ar,
        });
      }
      expect(b.transport.calls.length).toBe(calls);
      /* Another approver may. */
      const other = await post(b, 'tok-wcadmin', `/commerce/compensation-cases/${caseId}/approve`, {
        reason: 'second pair of eyes',
      });
      expect(other.statusCode).toBe(200);
    });

    it('judged from V2 (logged_by_agent) as well as from the CRM log', async () => {
      const b = build();
      const id = await seeded(b);
      b.store.rows.find((r) => r.case_id === id)!.logged_by_agent = 'u-wcadmin';
      const res = await post(b, 'tok-wcadmin', `/commerce/compensation-cases/${id}/reject`, {
        reason: 'mine',
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('own_case');
    });

    it('photos received and the camera check are not decisions: the logger may still do them', async () => {
      const b = build();
      const logged = await logAs(b, 'tok-approver', 'HAIR');
      const caseId = logged.json().data.case.case_id as string;
      expect(logged.json().data.case.status).toBe('evidence_hold');
      const res = await post(b, 'tok-approver', `/commerce/compensation-cases/${caseId}/evidence`, {
        reason: 'photos ok',
      });
      expect(res.statusCode).toBe(200);
    });

    it('the Administrator may decide a case they logged', async () => {
      const b = build();
      const logged = await logAs(b, 'tok-admin', 'CUT');
      const caseId = logged.json().data.case.case_id as string;
      const res = await post(b, 'tok-admin', `/commerce/compensation-cases/${caseId}/approve`, {
        reason: 'owner',
      });
      expect(res.statusCode).toBe(200);
    });

    it('the panel answer names the caller’s own cases (none for the Administrator)', async () => {
      const b = build();
      const logged = await logAs(b, 'tok-agent', 'CUT');
      const caseId = logged.json().data.case.case_id as string;
      const panel = async (tok: string) =>
        (
          await b.app.inject({
            url: '/commerce/compensation-cases?ticketId=t-v2',
            headers: auth(tok),
          })
        ).json().data;
      expect(await panel('tok-agent')).toMatchObject({
        canAct: false,
        canLog: true,
        ownCases: [caseId],
      });
      expect(await panel('tok-approver')).toMatchObject({
        canAct: true,
        canLog: true,
        ownCases: [],
      });
      expect(await panel('tok-ceo')).toMatchObject({ canAct: false, canLog: false });
      expect(await panel('tok-admin')).toMatchObject({ canAct: true, canLog: true, ownCases: [] });
    });
  });

  describe('instant privileges: no cache between the Roles page and the next request', () => {
    /** A Directus that answers the CURRENT app_roles row on every call. */
    function liveDirectus() {
      const role = { privileges: { approve_compensation_cases: true } as Record<string, boolean> };
      const calls: string[] = [];
      const fetchImpl = vi.fn(async (url: string | URL | Request) => {
        const u = String(url);
        calls.push(u);
        if (u.includes('/users/me'))
          return new Response(
            JSON.stringify({
              data: { id: 'u-sup', role: { id: 'r-sup', name: 'WeCare Supervisor' } },
            }),
            { status: 200 },
          );
        if (u.includes('/items/app_roles'))
          return new Response(JSON.stringify({ data: [{ privileges: role.privileges }] }), {
            status: 200,
          });
        if (u.includes('/items/tickets/'))
          return new Response(JSON.stringify({ data: { id: 't-v2' } }), { status: 200 });
        return new Response('{}', { status: 403 });
      });
      const resolver = createSessionActorResolver({
        directusUrl: 'http://directus.invalid',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      return { role, calls, resolver };
    }

    it('a privilege revoked takes effect on the very next request; granted again, the next one', async () => {
      const live = liveDirectus();
      const b = build({ sessions: live.resolver });
      const id1 = await seeded(b);
      const id2 = await seeded(b);
      const id3 = await seeded(b);
      const approve = (id: string) =>
        post(b, 'tok-sup', `/commerce/compensation-cases/${id}/approve`, { reason: 'ok' });
      expect((await approve(id1)).statusCode).toBe(200);
      live.role.privileges = { approve_compensation_cases: false };
      const revoked = await approve(id2);
      expect(revoked.statusCode).toBe(403);
      expect(revoked.json().error).toBe('approve_compensation_cases_required');
      live.role.privileges = { approve_compensation_cases: true };
      expect((await approve(id3)).statusCode).toBe(200);
    });

    it('the resolver asks Directus on every call (no per-token cache)', async () => {
      const live = liveDirectus();
      await live.resolver.resolve('tok-sup');
      await live.resolver.resolve('tok-sup');
      expect(live.calls.filter((u) => u.includes('/users/me'))).toHaveLength(2);
      expect(live.calls.filter((u) => u.includes('/items/app_roles'))).toHaveLength(2);
    });

    it('the per-user rate limit still applies', async () => {
      const b = build();
      const app = Fastify();
      void registerCompensationCaseRoutes(app, {
        sessions: sessions(),
        store: b.store,
        connectors: { connectorFor: b.connectorFor },
        now: () => NOW,
        perUserPerMin: 2,
      });
      const get = () =>
        app.inject({
          url: '/commerce/compensation-cases?ticketId=t-v2',
          headers: auth('tok-agent'),
        });
      expect((await get()).statusCode).toBe(200);
      expect((await get()).statusCode).toBe(200);
      expect((await get()).statusCode).toBe(429);
    });
  });
});

describe('approve / reject / evidence / verification', () => {
  it('approve sends the agent from the session, the reason and the key; records the action', async () => {
    const b = build();
    const id = await seeded(b);
    await b.app.inject({
      method: 'POST',
      url: `/commerce/compensation-cases/${id}/approve`,
      headers: auth('tok-approver'),
      payload: {
        ticketId: 't-v2',
        idempotencyKey: key('approve'),
        reason: 'late',
        amountMinor: 1500,
      },
    });
    const sent = {
      agent_id: 'u-approver',
      reason: 'late',
      amount: { amount_minor: 1500, currency: 'SAR' },
    };
    expect(b.transport.calls.at(-1)).toMatchObject({
      path: `/compensation-cases/${id}/approve`,
      /* The portal's key AND the request: one key per distinct request. */
      idempotencyKey: yiji2RequestKey(key('approve'), {
        caseId: id,
        action: 'approve',
        body: sent,
        reason: 'late',
      }),
      body: sent,
    });
    const row = b.store.rows.find((r) => r.case_id === id)!;
    expect(row).toMatchObject({ status: 'approved', overridden: true, issued_minor: 1500 });
    expect(row.agent_actions?.at(-1)).toMatchObject({
      action: 'approve',
      by: 'u-approver',
      reason: 'late',
      amount_minor: 1500,
      outcome: 'ok',
    });
  });

  /* Review follow-up 1 (18 Nov): after a refusal the form keeps its key. A
     retry with a CHANGED body must be a new request to V2; an identical one
     must reach V2 with the same key. */
  describe('the key V2 receives follows the request', () => {
    const act = (
      b: ReturnType<typeof build>,
      id: string,
      action: string,
      payload: Record<string, unknown>,
    ) =>
      b.app.inject({
        method: 'POST',
        url: `/commerce/compensation-cases/${id}/${action}`,
        headers: auth('tok-approver'),
        payload: { ticketId: 't-v2', idempotencyKey: key('form'), ...payload },
      });
    const lastKey = (b: ReturnType<typeof build>) => b.sentKeys.at(-1);

    it('approve: a changed amount (same portal key) is a new V2 request; the first answer is not replayed', async () => {
      const b = build();
      const id = await seeded(b);
      /* V2 refuses the first try and would answer that key with it again. */
      b.transport.failOnApprove.add(id);
      const first = await act(b, id, 'approve', { reason: 'late', amountMinor: 1500 });
      expect(first.statusCode).toBe(409);
      const k1 = lastKey(b);
      const n = b.transport.calls.length;
      await act(b, id, 'approve', { reason: 'late', amountMinor: 1200 });
      /* A real call with the new body, under a new key. */
      expect(b.transport.calls.length).toBe(n + 1);
      expect(lastKey(b)).not.toBe(k1);
      expect(b.transport.calls.at(-1)!.body).toMatchObject({
        amount: { amount_minor: 1200, currency: 'SAR' },
      });
    });

    it('approve: an identical retry reaches V2 with the same key (V2 answers it once)', async () => {
      const b = build();
      const id = await seeded(b);
      await act(b, id, 'approve', { reason: 'late', amountMinor: 1500 });
      const k1 = lastKey(b);
      const calls = b.transport.calls.length;
      const again = await act(b, id, 'approve', { reason: 'late', amountMinor: 1500 });
      expect(again.statusCode).toBe(200);
      expect(b.sentKeys).toHaveLength(2);
      expect(lastKey(b)).toBe(k1);
      /* V2 (the mock) answered it from its store: no second approval. */
      expect(b.transport.calls.length).toBe(calls);
      /* The mock answers the stored result: approved once, issued once. */
      expect(b.store.rows.find((r) => r.case_id === id)).toMatchObject({
        status: 'approved',
        issued_minor: 1500,
      });
    });

    it('approve: a changed reason, or no amount instead of one, is a new key', async () => {
      const b = build();
      const id = await seeded(b);
      b.transport.failOnApprove.add(id);
      const keys = new Set<string>();
      for (const p of [
        { reason: 'late', amountMinor: 1500 },
        { reason: 'very late', amountMinor: 1500 },
        { reason: 'very late' },
        { reason: 'very late', amountMinor: 1500 },
      ]) {
        await act(b, id, 'approve', p);
        keys.add(lastKey(b)!);
      }
      /* The 2nd and 4th bodies are identical: same key. */
      expect(keys.size).toBe(3);
    });

    it('reject, evidence, verification and log complaint: same body same key, changed body new key', async () => {
      const b = build();
      const keysOf = async (
        send: (p: Record<string, unknown>) => Promise<unknown>,
        a: Record<string, unknown>,
        changed: Record<string, unknown>,
      ) => {
        await send(a);
        const k1 = lastKey(b);
        await send(a);
        const k2 = lastKey(b);
        await send(changed);
        return [k1, k2, lastKey(b)];
      };
      const held = await seeded(b, { status: 'evidence_hold' });
      const ver = await seeded(b, { verification: 'open', status: 'approved' });
      const open = await seeded(b);
      const results = [
        await keysOf(
          (p) => act(b, open, 'reject', p),
          { reason: 'not our fault' },
          { reason: 'the branch checked' },
        ),
        await keysOf(
          (p) => act(b, held, 'evidence', p),
          { reason: 'photos ok' },
          { reason: 'photos checked twice' },
        ),
        await keysOf(
          (p) => act(b, ver, 'verification', p),
          { reason: 'cam 2', result: 'confirmed' },
          { reason: 'cam 2', result: 'not_confirmed' },
        ),
        await keysOf(
          (p) =>
            b.app.inject({
              method: 'POST',
              url: '/commerce/compensation-cases',
              headers: auth('tok-approver'),
              payload: { ticketId: 't-v2-other', idempotencyKey: key('form'), ...p },
            }),
          { category: 'CUT', text: 'a cut' },
          { category: 'HAIR', text: 'a cut' },
        ),
      ];
      for (const [k1, k2, k3] of results) {
        expect(k1).toBeTruthy();
        expect(k2).toBe(k1);
        expect(k3).not.toBe(k1);
      }
    });
  });

  it('an override outside the contract limits is refused before any call', async () => {
    const b = build();
    const id = await seeded(b);
    for (const amountMinor of [0, 9201, -5]) {
      const res = await b.app.inject({
        method: 'POST',
        url: `/commerce/compensation-cases/${id}/approve`,
        headers: auth('tok-admin'),
        payload: {
          ticketId: 't-v2',
          idempotencyKey: key(`o${amountMinor}`),
          reason: 'r',
          amountMinor,
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_amount');
    }
    const pct = await seeded(b, {
      percent_bps: 1500,
      amount: undefined,
      action_type: 'COUPON_PCT',
    });
    const res = await b.app.inject({
      method: 'POST',
      url: `/commerce/compensation-cases/${pct}/approve`,
      headers: auth('tok-admin'),
      payload: { ticketId: 't-v2', idempotencyKey: key('pct'), reason: 'r', amountMinor: 100 },
    });
    expect(res.json()).toMatchObject({ error: 'invalid_amount', problem: 'not_amount_case' });
    expect(b.transport.calls).toHaveLength(0);
  });

  it('a 409 answers its reason and a clear message, notes it, and refreshes the case', async () => {
    const b = build();
    const id = await seeded(b, { status: 'evidence_hold' });
    const res = await b.app.inject({
      method: 'POST',
      url: `/commerce/compensation-cases/${id}/approve`,
      headers: auth('tok-admin'),
      payload: { ticketId: 't-v2', idempotencyKey: key('h'), reason: 'r' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'conflict', reason: 'evidence_hold' });
    expect(res.json().message).toMatch(/waiting for photos/);
    const row = b.store.rows.find((r) => r.case_id === id)!;
    expect(row.agent_actions?.at(-1)).toMatchObject({
      outcome: 'refused',
      detail: 'evidence_hold',
    });

    const old = await seeded(b);
    b.transport.expireCase(old);
    const exp = await b.app.inject({
      method: 'POST',
      url: `/commerce/compensation-cases/${old}/approve`,
      headers: auth('tok-admin'),
      payload: { ticketId: 't-v2', idempotencyKey: key('e'), reason: 'r' },
    });
    expect(exp.json()).toMatchObject({ reason: 'expired', case: { status: 'expired' } });
    expect(b.store.rows.find((r) => r.case_id === old)!.status).toBe('expired');
  });

  it('evidence and verification send the contract bodies', async () => {
    const b = build();
    const held = await seeded(b, { status: 'evidence_hold', has_photos: true });
    const ev = await b.app.inject({
      method: 'POST',
      url: `/commerce/compensation-cases/${held}/evidence`,
      headers: auth('tok-admin'),
      payload: { ticketId: 't-v2', idempotencyKey: key('ev'), reason: 'photos checked' },
    });
    expect(ev.json().data.case.status).toBe('proposed');
    expect(b.transport.calls.at(-1)!.body).toEqual({ agent_id: 'u-admin' });
    const cctv = await seeded(b, { verification: { status: 'open' }, rule_code: 'MIS' });
    const v = await b.app.inject({
      method: 'POST',
      url: `/commerce/compensation-cases/${cctv}/verification`,
      headers: auth('tok-admin'),
      payload: {
        ticketId: 't-v2',
        idempotencyKey: key('v'),
        reason: 'courier seen at door',
        result: 'confirmed',
      },
    });
    expect(v.statusCode).toBe(200);
    expect(b.transport.calls.at(-1)!.body).toEqual({
      agent_id: 'u-admin',
      result: 'confirmed',
      note: 'courier seen at door',
    });
    expect(v.json().data.case.verification).toBe('confirmed');
  });

  it('a reason is required; a key is required', async () => {
    const b = build();
    const id = await seeded(b);
    for (const payload of [
      { ticketId: 't-v2', idempotencyKey: key('n'), reason: '  ' },
      { ticketId: 't-v2', reason: 'r' },
    ]) {
      const res = await b.app.inject({
        method: 'POST',
        url: `/commerce/compensation-cases/${id}/reject`,
        headers: auth('tok-admin'),
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('a case is acted on only from ITS ticket; a v1 ticket is refused; an inactive vendor is 404', async () => {
    const b = build();
    const id = await seeded(b);
    const other = await b.app.inject({
      method: 'POST',
      url: `/commerce/compensation-cases/${id}/approve`,
      headers: auth('tok-admin'),
      payload: { ticketId: 't-v2-other', idempotencyKey: key('o'), reason: 'r' },
    });
    expect(other.json().error).toBe('case_not_on_ticket');
    const v1 = await b.app.inject({
      method: 'POST',
      url: `/commerce/compensation-cases/${id}/approve`,
      headers: auth('tok-admin'),
      payload: { ticketId: 't-v1', idempotencyKey: key('v1'), reason: 'r' },
    });
    expect(v1.statusCode).toBe(409);
    expect(v1.json().error).toBe('not_a_v2_ticket');
    expect(b.transport.calls).toHaveLength(0);

    const off = build({ inactive: true });
    const idOff = await seeded(off);
    const res = await off.app.inject({
      method: 'POST',
      url: `/commerce/compensation-cases/${idOff}/approve`,
      headers: auth('tok-admin'),
      payload: { ticketId: 't-v2', idempotencyKey: key('off'), reason: 'r' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('unknown_vendor');
  });
});

describe('POST /commerce/compensation-cases (Log V2 complaint)', () => {
  it('logs from a v2 ticket with an order and links the case to THAT ticket', async () => {
    const b = build();
    const res = await b.app.inject({
      method: 'POST',
      url: '/commerce/compensation-cases',
      headers: auth('tok-agent'),
      payload: {
        ticketId: 't-v2',
        idempotencyKey: key('log'),
        category: 'HAIR',
        hasPhotos: false,
        text: 'hair in the burger',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      ticketId: 't-v2',
      onThisTicket: true,
      case: { status: 'evidence_hold', rule_code: 'HAIR', ticket: 't-v2', vendor: V2 },
    });
    const sent = {
      order_number: '2611000000001',
      category: 'HAIR',
      agent_id: 'u-agent',
      has_photos: false,
      text: 'hair in the burger',
    };
    expect(b.transport.calls.at(-1)).toMatchObject({
      path: '/compensation-cases',
      idempotencyKey: yiji2RequestKey(key('log'), { action: 'log', body: sent }),
      body: sent,
    });
  });

  /* Review follow-up 2 (18 Nov): V2 answers with the order's EXISTING case,
     linked to another CRM ticket. The row is never returned. */
  describe('an existing case on ANOTHER ticket', () => {
    async function loggedOnFirst(b: ReturnType<typeof build>) {
      const first = await b.app.inject({
        method: 'POST',
        url: '/commerce/compensation-cases',
        headers: auth('tok-approver'),
        payload: { ticketId: 't-v2', idempotencyKey: key('first'), category: 'CUT' },
      });
      expect(first.statusCode).toBe(200);
      return first.json().data.case as CompensationCaseRow;
    }
    const second = (b: ReturnType<typeof build>) =>
      b.app.inject({
        method: 'POST',
        url: '/commerce/compensation-cases',
        headers: auth('tok-approver'),
        payload: { ticketId: 't-v2-same-order', idempotencyKey: key('second'), category: 'CUT' },
      });

    it('409 case_on_other_ticket with only that ticket id when the caller may read it', async () => {
      const b = build();
      const c = await loggedOnFirst(b);
      const res = await second(b);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: 'case_on_other_ticket',
        message: expect.stringContaining('another ticket'),
        ticketId: 't-v2',
      });
      /* The row stays on its ticket; nothing is noted on it by this caller. */
      const row = b.store.rows.find((r) => r.case_id === c.case_id)!;
      expect(row.ticket).toBe('t-v2');
      expect(row.agent_actions).toHaveLength(1);
    });

    it('no ticket id and no row when the caller cannot read the other ticket', async () => {
      const b = build();
      await loggedOnFirst(b);
      /* Same V2 and store as b; only the caller's visibility differs. */
      const app = Fastify();
      void registerCompensationCaseRoutes(app, {
        sessions: sessions(['t-v2']),
        store: b.store,
        connectors: { connectorFor: async () => (await b.connectorFor(V2)) as VendorConnector },
        now: () => NOW,
      });
      const res = await app.inject({
        method: 'POST',
        url: '/commerce/compensation-cases',
        headers: auth('tok-approver'),
        payload: { ticketId: 't-v2-same-order', idempotencyKey: key('h'), category: 'CUT' },
      });
      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error).toBe('case_on_other_ticket');
      expect(body).not.toHaveProperty('ticketId');
      expect(body).not.toHaveProperty('data');
      expect(body).not.toHaveProperty('case');
      expect(JSON.stringify(body)).not.toContain('t-v2"');
    });

    it('a race (the events job linked it elsewhere first) is refused the same way', async () => {
      const b = build();
      /* The case exists on V2 but the CRM row appears, on t-v2, only while
         this request is on its way (the events job won the create). */
      const id = b.transport.seedCase({ rule_code: 'CUT', order_number: '2611000000001' });
      const create = b.store.createCase;
      b.store.createCase = async (p) => {
        await create({ ...p, ticket: 't-v2' });
        throw new Error('not unique');
      };
      const res = await second(b);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'case_on_other_ticket', ticketId: 't-v2' });
      expect(res.json()).not.toHaveProperty('data');
      expect(b.store.rows.find((r) => r.case_id === id)!.ticket).toBe('t-v2');
    });

    it('the same ticket again answers the case as before', async () => {
      const b = build();
      const c = await loggedOnFirst(b);
      const again = await b.app.inject({
        method: 'POST',
        url: '/commerce/compensation-cases',
        headers: auth('tok-approver'),
        payload: { ticketId: 't-v2', idempotencyKey: key('again'), category: 'CUT' },
      });
      expect(again.statusCode).toBe(200);
      expect(again.json().data).toMatchObject({ onThisTicket: true, case: { case_id: c.case_id } });
    });
  });

  it('refuses a ticket without a v2 order, a v1 ticket, and an unknown category', async () => {
    const b = build();
    const post = (payload: Record<string, unknown>) =>
      b.app.inject({
        method: 'POST',
        url: '/commerce/compensation-cases',
        headers: auth('tok-admin'),
        payload: { idempotencyKey: key('l'), category: 'CUT', ...payload },
      });
    expect((await post({ ticketId: 't-v2-noorder' })).json().error).toBe('ticket_has_no_v2_order');
    expect((await post({ ticketId: 't-v1' })).json().error).toBe('not_a_v2_ticket');
    expect((await post({ ticketId: 't-v2', category: 'DLY' })).statusCode).toBe(400);
    expect(b.transport.calls).toHaveLength(0);
  });
});

describe('the session resolver (the caller’s own Directus session)', () => {
  it('reads the role’s stored privileges with effectivePrivileges; the Administrator holds all', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const tok = String((init?.headers as Record<string, string>)?.authorization ?? '');
      if (u.includes('/users/me'))
        return new Response(
          JSON.stringify({
            data: tok.includes('admin')
              ? { id: 'u-admin', role: { id: 'r0', name: 'Administrator' } }
              : { id: 'u-1', role: { id: 'r1', name: 'WeCare Supervisor' } },
          }),
          { status: 200 },
        );
      if (u.includes('/items/app_roles'))
        return new Response(
          JSON.stringify({ data: [{ privileges: { approve_compensation_cases: true } }] }),
          { status: 200 },
        );
      if (u.includes('/items/tickets/t-ok'))
        return new Response(JSON.stringify({ data: { id: 't-ok' } }), { status: 200 });
      return new Response('{}', { status: 403 });
    });
    const r = createSessionActorResolver({
      directusUrl: 'http://directus.invalid',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const sup = await r.resolve('tok-sup');
    expect(sup).toMatchObject({ id: 'u-1', isAdmin: false });
    expect((sup as SessionActor).privileges.approve_compensation_cases).toBe(true);
    expect(await r.resolve('tok-admin')).toMatchObject({ isAdmin: true });
    expect(await r.canRead('tok-sup', 'tickets', 't-ok')).toBe(true);
    expect(await r.canRead('tok-sup', 'tickets', 't-no')).toBe(false);
  });
});
