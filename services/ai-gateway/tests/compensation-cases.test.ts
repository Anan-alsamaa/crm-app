import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import {
  MockYiji2Transport,
  UnknownVendorError,
  Yiji2Connector,
  type CompensationCasePatch,
  type CompensationCaseRow,
  type VendorConnector,
} from '@yiji/shared-types';
import {
  APPROVE_COMPENSATION_CASES,
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

const ACTORS: Record<string, SessionActor> = {
  'tok-agent': { id: 'u-agent', isAdmin: false, privileges: { view_tickets: true } },
  'tok-approver': {
    id: 'u-approver',
    isAdmin: false,
    privileges: { view_tickets: true, [APPROVE_COMPENSATION_CASES]: true },
  },
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

function build(opts: { hidden?: string[]; inactive?: boolean } = {}) {
  const transport = new MockYiji2Transport({ now: () => NOW });
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
    sessions: sessions(opts.hidden),
    store,
    connectors: { connectorFor },
    now: () => NOW,
  });
  return { app, store, transport, connectorFor };
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

describe('the privilege: approve_compensation_cases', () => {
  const routes = (caseId: string) => [
    { url: `/commerce/compensation-cases/${caseId}/approve`, body: { reason: 'ok' } },
    { url: `/commerce/compensation-cases/${caseId}/reject`, body: { reason: 'no' } },
    { url: `/commerce/compensation-cases/${caseId}/evidence`, body: { reason: 'seen' } },
    {
      url: `/commerce/compensation-cases/${caseId}/verification`,
      body: { reason: 'cams', result: 'confirmed' },
    },
    { url: '/commerce/compensation-cases', body: { category: 'CUT' } },
  ];

  it('every action is 403 without it, and nothing reaches V2', async () => {
    const b = build();
    const id = await seeded(b);
    for (const r of routes(id)) {
      const res = await b.app.inject({
        method: 'POST',
        url: r.url,
        headers: auth('tok-agent'),
        payload: { ticketId: 't-v2', idempotencyKey: key('x'), ...r.body },
      });
      expect(res.statusCode, r.url).toBe(403);
      expect(res.json().error).toBe('approve_compensation_cases_required');
    }
    expect(b.transport.calls).toHaveLength(0);
  });

  it('a role holding it may act; so may the Administrator', async () => {
    const b = build();
    const id = await seeded(b);
    const res = await b.app.inject({
      method: 'POST',
      url: `/commerce/compensation-cases/${id}/approve`,
      headers: auth('tok-approver'),
      payload: { ticketId: 't-v2', idempotencyKey: key('a'), reason: 'late, fair' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.case).toMatchObject({ status: 'approved', issued_minor: 2000 });
    const id2 = await seeded(b);
    const admin = await b.app.inject({
      method: 'POST',
      url: `/commerce/compensation-cases/${id2}/reject`,
      headers: auth('tok-admin'),
      payload: { ticketId: 't-v2', idempotencyKey: key('b'), reason: 'not our fault' },
    });
    expect(admin.statusCode).toBe(200);
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
    expect(b.transport.calls.at(-1)).toMatchObject({
      path: `/compensation-cases/${id}/approve`,
      idempotencyKey: key('approve'),
      body: {
        agent_id: 'u-approver',
        reason: 'late',
        amount: { amount_minor: 1500, currency: 'SAR' },
      },
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
      headers: auth('tok-approver'),
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
    expect(b.transport.calls.at(-1)).toMatchObject({
      path: '/compensation-cases',
      idempotencyKey: key('log'),
      body: {
        order_number: '2611000000001',
        category: 'HAIR',
        agent_id: 'u-approver',
        has_photos: false,
        text: 'hair in the burger',
      },
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
