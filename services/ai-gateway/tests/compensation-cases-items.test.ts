import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import {
  MockYiji2Transport,
  UnknownVendorError,
  Yiji2Connector,
  effectivePrivileges,
  type CompensationCasePatch,
  type CompensationCaseRow,
  type VendorConnector,
} from '@yiji/shared-types';
import {
  AFFECTED_ITEMS_MESSAGES,
  registerCompensationCaseRoutes,
  type CompensationCaseStore,
} from '../src/commerce/compensation-cases.js';
import type { SessionActor, SessionActorResolver } from '../src/auth/session-actor.js';

/**
 * "LOG V2 COMPLAINT" WITH AFFECTED ITEMS (2026-11-18; partner-v1.yaml
 * `OrderItem.order_item_id`). The gateway reads the ticket's order through the
 * connector, offers its lines to the picker, and checks a pick against them
 * BEFORE calling V2: a line id of another order (or the catalogue id) is
 * refused, a quantity is 1..the line's quantity, a category paid on items
 * needs one. V2 is the in-memory mock: ZERO NETWORK.
 */

const NOW = Date.parse('2026-11-18T10:00:00Z');
const V2 = 'vendor-v2';
const V1 = 'vendor-v1';

const asRole = (id: string, role: string): SessionActor => ({
  id,
  isAdmin: false,
  privileges: effectivePrivileges({ view_tickets: true, create_tickets: true }, role),
});
const ACTORS: Record<string, SessionActor> = {
  'tok-agent': asRole('u-agent', 'WeCare Agent'),
  'tok-ceo': asRole('u-ceo', 'CEO'),
};

function build(opts: { hidden?: string[] } = {}) {
  const transport = new MockYiji2Transport({ now: () => NOW });
  const connector = new Yiji2Connector(
    { crmId: V2, platformVendorId: '2', platform: 'yiji2', status: 'active' },
    { platform: 'yiji2', mock: true },
    { transport },
  );
  const reads: string[] = [];
  const request = transport.request.bind(transport);
  transport.request = ((method, path, o) => {
    if (method === 'GET') reads.push(path);
    return request(method, path, o);
  }) as typeof transport.request;
  const connectorFor = vi.fn(async (k: string): Promise<VendorConnector> => {
    if (k !== V2) throw new UnknownVendorError(k, 'inactive');
    return connector as unknown as VendorConnector;
  });
  const rows: CompensationCaseRow[] = [];
  const tickets: Record<string, { id: string; vendor: string; order_id: string | null }> = {
    't-v2': { id: 't-v2', vendor: V2, order_id: '2611000000001' },
    't-v2-gone': { id: 't-v2-gone', vendor: V2, order_id: '2611000000099' },
    't-v2-noorder': { id: 't-v2-noorder', vendor: V2, order_id: null },
    't-v1': { id: 't-v1', vendor: V1, order_id: '1095975' },
  };
  let n = 0;
  const store: CompensationCaseStore = {
    ticket: async (id) => tickets[id] ?? null,
    vendorPlatform: async (v) => (v === V2 ? 'yiji2' : v === V1 ? 'yiji' : null),
    casesForTicket: async (t) => rows.filter((r) => r.ticket === t),
    caseById: async (id) => rows.find((x) => x.case_id === id) ?? null,
    createCase: async (p: CompensationCasePatch) => {
      const row = { id: `row-${++n}`, ...p } as CompensationCaseRow;
      rows.push(row);
      return { ...row };
    },
    updateCase: async (id, p) => Object.assign(rows.find((x) => x.id === id)!, p),
  };
  const sessions: SessionActorResolver = {
    resolve: async (token) => ACTORS[token] ?? null,
    canRead: async (_t, _c, id) => !(opts.hidden ?? []).includes(id),
  };
  const app = Fastify();
  void registerCompensationCaseRoutes(app, {
    sessions,
    store,
    connectors: { connectorFor },
    now: () => NOW,
  });
  const logged = () => transport.calls.filter((c) => c.path === '/compensation-cases');
  return { app, transport, rows, reads, logged, connectorFor };
}

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

const lines = (b: ReturnType<typeof build>, ticketId: string, tok = 'tok-agent') =>
  b.app.inject({
    method: 'GET',
    url: `/commerce/compensation-cases/order-items?ticketId=${ticketId}`,
    headers: auth(tok),
  });

const log = (b: ReturnType<typeof build>, payload: Record<string, unknown>) =>
  b.app.inject({
    method: 'POST',
    url: '/commerce/compensation-cases',
    headers: auth('tok-agent'),
    payload: { ticketId: 't-v2', idempotencyKey: 'key-items-0000', ...payload },
  });

describe('GET /commerce/compensation-cases/order-items (the picker)', () => {
  it('answers the ticket order’s lines with their V2 line ids, read through the connector', async () => {
    const b = build();
    const res = await lines(b, 't-v2');
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      ticketId: 't-v2',
      orderNumber: '2611000000001',
      currency: 'SAR',
      lines: [
        {
          orderItemId: '7001',
          name: 'Classic burger',
          nameAr: null,
          modifiers: ['Extra cheese', 'No onions'],
          quantity: 2,
          unitPriceMinor: 3200,
          lineTotalMinor: 7000,
        },
        {
          orderItemId: '7002',
          name: 'Fries',
          nameAr: null,
          modifiers: [],
          quantity: 1,
          unitPriceMinor: 1200,
          lineTotalMinor: 1200,
        },
      ],
    });
    expect(b.reads).toEqual(['/orders/2611000000001']);
    expect(b.transport.calls).toEqual([]);
  });

  it('needs log_compensation_cases, a readable v2 ticket with an order that V2 has', async () => {
    const b = build({ hidden: ['t-v2'] });
    expect((await lines(b, 't-v2', 'tok-ceo')).statusCode).toBe(403);
    expect((await lines(b, 't-v2')).statusCode).toBe(404);
    expect((await lines(b, 't-v1')).json().error).toBe('not_a_v2_ticket');
    expect((await lines(b, 't-v2-noorder')).json().error).toBe('ticket_has_no_v2_order');
    const gone = await lines(b, 't-v2-gone');
    expect([gone.statusCode, gone.json().error]).toEqual([404, 'order_not_found_on_v2']);
    expect(b.reads).toEqual(['/orders/2611000000099']);
  });
});

describe('POST /commerce/compensation-cases with affected items', () => {
  it('end to end: the picked lines reach V2 as affected_items and land on the case row', async () => {
    const b = build();
    const res = await log(b, {
      category: 'MIS',
      affectedItems: [{ orderItemId: '7001', quantity: 2 }, { orderItemId: '7002' }],
    });
    expect(res.statusCode).toBe(200);
    expect(b.logged()).toHaveLength(1);
    expect(b.logged()[0]!.body).toMatchObject({
      order_number: '2611000000001',
      category: 'MIS',
      agent_id: 'u-agent',
      affected_items: [{ order_item_id: 7001, quantity: 2 }, { order_item_id: 7002 }],
    });
    expect(res.json().data.case.affected_items).toEqual([
      expect.objectContaining({ order_item_id: 7001, quantity: 2, line_quantity: 2 }),
      expect.objectContaining({ order_item_id: 7002, quantity: 1, line_quantity: 1 }),
    ]);
    expect(b.rows[0]!.affected_items).toHaveLength(2);
  });

  it('a line id of ANOTHER order, or the catalogue id, is refused before V2 is called', async () => {
    const b = build();
    for (const id of ['7101', '7201', '301', '1']) {
      const res = await log(b, { category: 'MIS', affectedItems: [{ orderItemId: id }] });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'invalid_affected_items',
        problem: 'item_not_on_order',
        index: 0,
        message: AFFECTED_ITEMS_MESSAGES.item_not_on_order,
      });
    }
    expect(b.logged()).toEqual([]);
  });

  it('a quantity above the line’s, or a line named twice, is refused before V2', async () => {
    const b = build();
    const over = await log(b, {
      category: 'PRD-1',
      affectedItems: [{ orderItemId: '7002' }, { orderItemId: '7001', quantity: 3 }],
    });
    expect(over.json()).toMatchObject({ problem: 'item_quantity', index: 1 });
    const twice = await log(b, {
      category: 'PRD-1',
      affectedItems: [
        { orderItemId: '7001', quantity: 1 },
        { orderItemId: '7001', quantity: 1 },
      ],
    });
    expect(twice.json()).toMatchObject({ problem: 'item_twice', index: 1 });
    /* Zero is refused by the body check itself. */
    const zero = await log(b, {
      category: 'PRD-1',
      affectedItems: [{ orderItemId: '7001', quantity: 0 }],
    });
    expect([zero.statusCode, zero.json().error]).toEqual([400, 'invalid_body']);
    expect(b.logged()).toEqual([]);
  });

  it('a category paid on items needs one; other categories may go without (HAIR, CUT)', async () => {
    const b = build();
    for (const category of ['PRD-1', 'PRD-2', 'ACC-1', 'ACC-2', 'MIS', 'REM']) {
      const res = await log(b, { category });
      expect([res.statusCode, res.json().problem]).toEqual([400, 'items_required']);
    }
    expect(b.logged()).toEqual([]);
    expect(b.reads).toEqual([]);
    expect((await log(b, { category: 'HAIR' })).statusCode).toBe(200);
    expect((await log(b, { category: 'CUT', idempotencyKey: 'key-cut-00000' })).statusCode).toBe(
      200,
    );
    /* No items: the order is not read for them. */
    expect(b.reads).toEqual([]);
  });

  it('optional items on another category are still checked against the order', async () => {
    const b = build();
    const bad = await log(b, { category: 'HAIR', affectedItems: [{ orderItemId: '7101' }] });
    expect(bad.json().problem).toBe('item_not_on_order');
    const ok = await log(b, { category: 'HAIR', affectedItems: [{ orderItemId: '7002' }] });
    expect(ok.statusCode).toBe(200);
    expect(b.logged()).toHaveLength(1);
  });

  it('an order V2 no longer answers: 404, nothing logged; a v1 ticket is refused as before', async () => {
    const b = build();
    const gone = await b.app.inject({
      method: 'POST',
      url: '/commerce/compensation-cases',
      headers: auth('tok-agent'),
      payload: {
        ticketId: 't-v2-gone',
        idempotencyKey: 'key-gone-0000',
        category: 'MIS',
        affectedItems: [{ orderItemId: '7001' }],
      },
    });
    expect([gone.statusCode, gone.json().error]).toEqual([404, 'order_not_found_on_v2']);
    const v1 = await log(b, {
      ticketId: 't-v1',
      category: 'MIS',
      affectedItems: [{ orderItemId: '7001' }],
    });
    expect(v1.json().error).toBe('not_a_v2_ticket');
    expect(b.logged()).toEqual([]);
  });
});
