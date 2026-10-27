import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { StoreRecord } from '@yiji/shared-types';
import { signWebhook } from '../src/webhook.js';
import {
  InboundStoreError,
  couponPolicyProblems,
  createYijiInboundService,
  registerYijiInboundApi,
  apiCouponStatus,
  type CouponPolicy,
  type InboundCoupon,
  type InboundTicket,
  type NewCouponRow,
  type NewTicketRow,
  type YijiInboundStore,
} from '../src/yiji-inbound.js';
import { classifyDirectusError } from '../src/yiji-inbound-directus.js';

/**
 * The Yiji inbound API end to end over HTTP (owner, 2026-10-27), against an
 * in-memory store that enforces the same uniqueness the database does.
 */

const SECRET = 'inbound-test-secret';
const VENDOR = 'vendor-yiji-uuid';
const ACTOR = 'user-yiji-system';

const STORE: StoreRecord = {
  id: 'store-1',
  code: 'LCP-002',
  name: 'Marina Mall 2',
  city: 'Riyadh',
  areaManager: 'AM',
  chainManager: 'CM',
  brandCode: 'LCP',
  brandName: 'Casa Pasta',
  yijiRestaurantId: '501',
};

class FakeStore implements YijiInboundStore {
  tickets = new Map<string, NewTicketRow & { resolved_at?: string | null }>();
  coupons = new Map<
    string,
    NewCouponRow & { decision_note?: string | null; removal_status?: string | null }
  >();
  contacts = new Map<
    string,
    { id: string; vendor: string; phone: string; name: string | null; yiji: string | null }
  >();
  events: Array<{ ticket: string; actor: string | null; text: string }> = [];
  deleted: string[] = [];
  /** Queue of failures for the next createCoupon calls. */
  couponFailures: InboundStoreError[] = [];
  /** createCoupon writes the row, THEN fails (the answer was lost). */
  couponLandsThenFails = false;
  deleteFails = false;
  vendor: string | null = VENDOR;
  storeRows: StoreRecord[] = [STORE];
  private seq = 0;

  async yijiVendorId() {
    return this.vendor;
  }
  private toTicket(r: NewTicketRow & { resolved_at?: string | null }): InboundTicket {
    return {
      id: r.id,
      externalId: r.external_id,
      status: r.status,
      compensation: r.compensation,
      contactId: r.contact,
      customerPhone: r.customer_phone,
      orderId: r.order_id,
      description: r.description,
      restaurantId: this.storeRows.find((s) => s.id === r.store)?.yijiRestaurantId ?? null,
      dateCreated: '2026-10-27T10:00:00.000Z',
      resolvedAt: r.resolved_at ?? null,
    };
  }
  private toCoupon(
    r: NewCouponRow & { decision_note?: string | null; removal_status?: string | null },
  ): InboundCoupon {
    return {
      id: r.id,
      externalId: r.external_id,
      ticketId: r.ticket,
      code: r.coupon_code,
      status: r.status,
      decisionNote: r.decision_note ?? null,
      decidedAt: null,
      value: r.coupon_value,
      percent: r.coupon_percent,
      maxDiscount: r.max_discount,
      validFrom: r.valid_from,
      validTo: r.valid_to,
      removalStatus: r.removal_status ?? null,
      replacedBy: null,
      dateCreated: null,
    };
  }
  async findTicket(vendor: string, ext: string) {
    const r = [...this.tickets.values()].find((t) => t.vendor === vendor && t.external_id === ext);
    return r ? this.toTicket(r) : null;
  }
  async findCoupon(vendor: string, ext: string) {
    const r = [...this.coupons.values()].find((c) => c.vendor === vendor && c.external_id === ext);
    return r ? this.toCoupon(r) : null;
  }
  async couponExists(id: string) {
    return this.coupons.has(id);
  }
  async ticketCoupons(ticketId: string) {
    return [...this.coupons.values()]
      .filter((c) => c.ticket === ticketId)
      .map((c) => this.toCoupon(c));
  }
  async stores() {
    return this.storeRows;
  }
  async upsertContact(
    vendor: string,
    c: { phone: string; name: string | null; yijiCustomerId: string | null },
  ) {
    const found = [...this.contacts.values()].find(
      (x) => x.vendor === vendor && x.phone === c.phone,
    );
    if (found) return found.id;
    const id = `contact-${++this.seq}`;
    this.contacts.set(id, { id, vendor, phone: c.phone, name: c.name, yiji: c.yijiCustomerId });
    return id;
  }
  async couponCodeTaken(code: string) {
    return [...this.coupons.values()].some((c) => c.coupon_code === code);
  }
  async createTicket(row: NewTicketRow) {
    if (
      [...this.tickets.values()].some(
        (t) => t.vendor === row.vendor && t.external_id === row.external_id,
      )
    ) {
      throw new InboundStoreError('duplicate', 'not unique', 'external_id');
    }
    this.tickets.set(row.id, { ...row });
  }
  async deleteTicket(id: string) {
    if (this.deleteFails) throw new InboundStoreError('refused', 'forbidden');
    this.deleted.push(id);
    this.tickets.delete(id);
    for (const [cid, c] of this.coupons) if (c.ticket === id) this.coupons.delete(cid);
  }
  async createCoupon(row: NewCouponRow) {
    const fail = this.couponFailures.shift();
    if (fail) throw fail;
    if (
      [...this.coupons.values()].some(
        (c) => c.vendor === row.vendor && c.external_id === row.external_id,
      )
    ) {
      throw new InboundStoreError('duplicate', 'not unique', 'external_id');
    }
    if (!this.tickets.has(row.ticket)) throw new InboundStoreError('refused', 'FK: ticket missing');
    this.coupons.set(row.id, { ...row });
    if (this.couponLandsThenFails) {
      this.couponLandsThenFails = false;
      throw new InboundStoreError('transient', 'socket hang up');
    }
  }
  async setTicketCompensation(id: string, value: 'Compensated' | 'Not Compensated') {
    const t = this.tickets.get(id);
    if (t) (t as { compensation: string }).compensation = value;
  }
  async addTicketEvent(ticket: string, actor: string | null, text: string) {
    this.events.push({ ticket, actor, text });
  }
  async actorId() {
    return ACTOR;
  }
}

const silent = { info: () => {}, warn: () => {}, error: () => {} };

function build(
  store: FakeStore,
  opts: {
    secret?: string;
    policy?: CouponPolicy;
    nowMs?: number;
    rate?: { capacity: number; perSec: number };
  } = {},
): FastifyInstance {
  const app = Fastify();
  // Exactly as index.ts: the raw body is kept for the HMAC.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body: string, done) => {
    (req as { rawBody?: string }).rawBody = body;
    try {
      done(null, body ? JSON.parse(body) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });
  registerYijiInboundApi(app, {
    secret: opts.secret ?? SECRET,
    toleranceSec: 300,
    logger: silent,
    rate: opts.rate ?? { capacity: 1000, perSec: 1000 },
    service: createYijiInboundService({
      store,
      logger: silent,
      now: () => new Date('2026-10-27T10:00:00.000Z'),
      sleep: async () => {},
      retryDelaysMs: [0, 0],
      ...(opts.policy ? { policy: opts.policy } : {}),
    }),
  });
  return app;
}

const nowTs = () => String(Math.floor(Date.now() / 1000));

function signed(
  method: 'POST' | 'GET',
  url: string,
  body?: unknown,
  ts = nowTs(),
  secret = SECRET,
) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  return {
    method,
    url,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      'x-yiji-timestamp': ts,
      'x-yiji-signature': `sha256=${signWebhook(secret, ts, raw)}`,
    },
    ...(body === undefined ? {} : { payload: raw }),
  };
}

const ticketBody = (over: Record<string, unknown> = {}) => ({
  externalId: 'YT-1001',
  customer: { phone: '+966501234567', name: 'Sara', yijiCustomerId: '77881' },
  orderNumber: '1280043',
  restaurantId: '501',
  subject: 'Missing fries',
  description: 'The fries were missing from the order.',
  complaintType: 'missing item',
  serviceType: 'Delivery',
  attachments: ['https://cdn.yiji.example/p/1.jpg'],
  occurredAt: '2026-10-27T13:30:00+03:00',
  ...over,
});

const amountCoupon = (over: Record<string, unknown> = {}) => ({
  externalId: 'YC-9001',
  type: 'amount',
  value: 25,
  validFrom: '2026-10-27',
  validTo: '2026-11-27',
  reason: 'Missing item',
  ...over,
});

let store: FakeStore;
let app: FastifyInstance;
beforeEach(() => {
  store = new FakeStore();
  app = build(store);
});

describe('signature', () => {
  it('accepts a valid signature', async () => {
    const res = await app.inject(signed('POST', '/webhooks/yiji/tickets', ticketBody()));
    expect(res.statusCode).toBe(201);
  });

  it('rejects a wrong signature with 401 and writes nothing', async () => {
    const req = signed('POST', '/webhooks/yiji/tickets', ticketBody(), nowTs(), 'not-the-secret');
    const res = await app.inject(req);
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_signature');
    expect(store.tickets.size).toBe(0);
  });

  it('rejects a body changed after signing', async () => {
    const req = signed('POST', '/webhooks/yiji/tickets', ticketBody());
    const res = await app.inject({ ...req, payload: JSON.stringify(ticketBody({ subject: 'x' })) });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a stale timestamp (replay window)', async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    const res = await app.inject(signed('POST', '/webhooks/yiji/tickets', ticketBody(), stale));
    expect(res.statusCode).toBe(401);
  });

  it('rejects a request with no signature headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/webhooks/yiji/tickets/YT-1' });
    expect(res.statusCode).toBe(401);
  });

  it('answers 503 on every route while the secret is unset', async () => {
    const off = build(store, { secret: '' });
    const res = await off.inject(signed('POST', '/webhooks/yiji/tickets', ticketBody()));
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('not_configured');
    const get = await off.inject(signed('GET', '/webhooks/yiji/tickets/YT-1001'));
    expect(get.statusCode).toBe(503);
  });

  it('rate-limits per caller with 429', async () => {
    const tight = build(store, { rate: { capacity: 2, perSec: 0 } });
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) {
      codes.push((await tight.inject(signed('GET', '/webhooks/yiji/tickets/none'))).statusCode);
    }
    expect(codes).toEqual([404, 404, 429]);
  });
});

describe('POST /webhooks/yiji/tickets - ticket only', () => {
  it('creates a Yiji ticket on the branch, with the customer, pending, Not Compensated', async () => {
    const res = await app.inject(signed('POST', '/webhooks/yiji/tickets', ticketBody()));
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.coupon).toBeUndefined();
    expect(body.externalId).toBe('YT-1001');
    expect(body.ticketNumber).toMatch(/^[0-9A-F]{8}$/);

    const t = store.tickets.get(body.ticketId)!;
    expect(t).toMatchObject({
      vendor: VENDOR,
      external_id: 'YT-1001',
      status: 'pending',
      complaint_source: 'Yiji',
      complaint_type: 'Missing item', // canonical spelling
      service_type: 'Delivery',
      store: 'store-1',
      order_id: '1280043',
      customer_phone: '0501234567', // one canonical form
      compensation: 'Not Compensated',
      complaint_date: '2026-10-27T10:30:00.000Z',
    });
    expect(t.store_snapshot.via).toBe('yiji_id');
    expect(t.description).toContain('https://cdn.yiji.example/p/1.jpg');
    const contact = store.contacts.get(t.contact)!;
    expect(contact).toMatchObject({ phone: '0501234567', name: 'Sara', yiji: '77881' });
    expect(store.events.map((e) => e.text)).toEqual(['Created by Yiji (externalId YT-1001).']);
    expect(store.events[0]!.actor).toBe(ACTOR);
  });

  it('refuses a restaurant that maps to no branch with 422, writing nothing', async () => {
    const res = await app.inject(
      signed('POST', '/webhooks/yiji/tickets', ticketBody({ restaurantId: '999' })),
    );
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      error: 'unknown_restaurant',
      fields: { restaurantId: expect.any(String) },
    });
    expect(store.tickets.size).toBe(0);
    expect(store.contacts.size).toBe(0);
  });
});

describe('POST /webhooks/yiji/tickets - the ticket never depends on its coupon', () => {
  it('creates both: the coupon pending for a supervisor, the ticket then Compensated', async () => {
    const res = await app.inject(
      signed('POST', '/webhooks/yiji/tickets', ticketBody({ coupon: amountCoupon() })),
    );
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.coupon).toMatchObject({ externalId: 'YC-9001', status: 'pending' });
    expect(body.coupon.code).toMatch(/^CC-[A-Z2-9]{8}$/);

    const c = store.coupons.get(body.coupon.id)!;
    expect(c).toMatchObject({
      vendor: VENDOR,
      ticket: body.ticketId,
      status: 'pending',
      requested_by: ACTOR,
      coupon_value: 25,
      coupon_percent: null,
      max_discount: 25, // an amount's ceiling IS the amount
      discount_category: 'Amount',
      coupon_type: 'Private',
      delivery_type: 'All',
      issuing_side: 'Customer Care',
      customer_phone: '0501234567',
      order_id: '1280043',
      restaurant_id: '501',
      usage_limit: 1,
      delivery_excluded: false,
    });
    expect(store.tickets.get(body.ticketId)!.compensation).toBe('Compensated');
    expect(store.events.map((e) => e.text)).toEqual([
      'Created by Yiji (externalId YT-1001).',
      expect.stringContaining('Coupon requested by Yiji (externalId YC-9001'),
    ]);
  });

  // Owner, 2026-10-27: a coupon problem never blocks or removes the complaint.
  it('keeps the ticket when the coupon cannot be stored, and says so', async () => {
    store.couponFailures = [new InboundStoreError('refused', 'FORBIDDEN')];
    const res = await app.inject(
      signed('POST', '/webhooks/yiji/tickets', ticketBody({ coupon: amountCoupon() })),
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().coupon.status).toBe('not_created');
    expect(store.tickets.size).toBe(1);
    expect([...store.tickets.values()][0]!.compensation).toBe('Not Compensated');
    expect(store.coupons.size).toBe(0);
  });

  it('retries a transient coupon failure and succeeds', async () => {
    store.couponFailures = [new InboundStoreError('transient', 'ECONNRESET')];
    const res = await app.inject(
      signed('POST', '/webhooks/yiji/tickets', ticketBody({ coupon: amountCoupon() })),
    );
    expect(res.statusCode).toBe(201);
    expect(store.coupons.size).toBe(1);
  });

  it('a write that landed but lost its answer is not written twice', async () => {
    store.couponLandsThenFails = true;
    const res = await app.inject(
      signed('POST', '/webhooks/yiji/tickets', ticketBody({ coupon: amountCoupon() })),
    );
    expect(res.statusCode).toBe(201);
    expect(store.coupons.size).toBe(1);
  });

  it('a coupon that failed is completed later with the add-coupon call', async () => {
    store.couponFailures = [new InboundStoreError('refused', 'FORBIDDEN')];
    const first = await app.inject(
      signed('POST', '/webhooks/yiji/tickets', ticketBody({ coupon: amountCoupon() })),
    );
    expect(first.statusCode).toBe(201);
    const [left] = [...store.tickets.values()];
    expect(left!.compensation).toBe('Not Compensated');

    const retry = await app.inject(
      signed('POST', '/webhooks/yiji/tickets', ticketBody({ coupon: amountCoupon() })),
    );
    expect(retry.statusCode).toBe(200);
    expect(retry.json().ticketId).toBe(left!.id);
    expect(retry.json().coupon.status).toBe('pending');
    expect(store.coupons.size).toBe(1);
    expect(store.tickets.get(left!.id)!.compensation).toBe('Compensated');
  });

  it('a coupon externalId already used on another ticket: the new ticket is created, its coupon is not', async () => {
    await app.inject(
      signed('POST', '/webhooks/yiji/tickets', ticketBody({ coupon: amountCoupon() })),
    );
    const res = await app.inject(
      signed(
        'POST',
        '/webhooks/yiji/tickets',
        ticketBody({ externalId: 'YT-2002', coupon: amountCoupon() }),
      ),
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().coupon).toMatchObject({
      status: 'not_created',
      error: { code: 'coupon_external_id_conflict' },
    });
    expect(store.tickets.size).toBe(2);
    expect(store.coupons.size).toBe(1);
  });
});

describe('idempotency', () => {
  it('the same ticket externalId returns the existing ticket (200), never a second', async () => {
    const a = await app.inject(signed('POST', '/webhooks/yiji/tickets', ticketBody()));
    const b = await app.inject(signed('POST', '/webhooks/yiji/tickets', ticketBody()));
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(200);
    expect(b.json().ticketId).toBe(a.json().ticketId);
    expect(store.tickets.size).toBe(1);
  });

  it('the same ticket + coupon replayed returns both, writes nothing new', async () => {
    const body = ticketBody({ coupon: amountCoupon() });
    const a = await app.inject(signed('POST', '/webhooks/yiji/tickets', body));
    const b = await app.inject(signed('POST', '/webhooks/yiji/tickets', body));
    expect(b.statusCode).toBe(200);
    expect(b.json().coupon).toEqual(a.json().coupon);
    expect(store.coupons.size).toBe(1);
    expect(store.tickets.size).toBe(1);
  });

  it('the same coupon externalId added twice returns the existing coupon (200)', async () => {
    await app.inject(signed('POST', '/webhooks/yiji/tickets', ticketBody()));
    const url = '/webhooks/yiji/tickets/YT-1001/coupons';
    const a = await app.inject(signed('POST', url, amountCoupon()));
    const b = await app.inject(signed('POST', url, amountCoupon()));
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(200);
    expect(b.json().coupon.id).toBe(a.json().coupon.id);
    expect(store.coupons.size).toBe(1);
  });
});

describe('POST /webhooks/yiji/tickets/:externalId/coupons', () => {
  it('404 for an unknown ticket - never a loose coupon', async () => {
    const res = await app.inject(
      signed('POST', '/webhooks/yiji/tickets/NOPE/coupons', amountCoupon()),
    );
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('ticket_not_found');
    expect(store.coupons.size).toBe(0);
  });

  it('adds a coupon to an existing Yiji ticket and marks it Compensated', async () => {
    const t = await app.inject(signed('POST', '/webhooks/yiji/tickets', ticketBody()));
    const res = await app.inject(
      signed('POST', '/webhooks/yiji/tickets/YT-1001/coupons', {
        externalId: 'YC-7',
        type: 'percentage',
        percent: 20,
        maxDiscount: 40,
        deliveryTypes: ['delivery', 'Pickup'],
        audience: 'general',
      }),
    );
    expect(res.statusCode).toBe(201);
    const c = store.coupons.get(res.json().coupon.id)!;
    expect(c).toMatchObject({
      ticket: t.json().ticketId,
      discount_category: 'Percentage',
      coupon_percent: 20,
      coupon_value: null,
      max_discount: 40,
      delivery_type: 'Delivery, Pickup',
      coupon_type: 'Public',
      restaurant_id: '501',
      status: 'pending',
      reason: 'The fries were missing from the order.',
    });
    expect(store.tickets.get(t.json().ticketId)!.compensation).toBe('Compensated');
  });
});

describe('validation: 400 with field messages, never 500', () => {
  it('names every missing required field', async () => {
    const res = await app.inject(signed('POST', '/webhooks/yiji/tickets', {}));
    expect(res.statusCode).toBe(400);
    const { error, fields } = res.json();
    expect(error).toBe('validation_failed');
    expect(Object.keys(fields)).toEqual(
      expect.arrayContaining(['externalId', 'customer', 'restaurantId', 'complaintType']),
    );
  });

  it('refuses a bad phone, an unknown complaint type and a bad date', async () => {
    const res = await app.inject(
      signed(
        'POST',
        '/webhooks/yiji/tickets',
        ticketBody({
          customer: { phone: 'call me' },
          complaintType: 'Rude parrot',
          occurredAt: 'yesterday',
        }),
      ),
    );
    expect(res.statusCode).toBe(400);
    expect(Object.keys(res.json().fields)).toEqual(
      expect.arrayContaining(['customer.phone', 'occurredAt']),
    );
  });

  it('refuses an unknown complaint type by name', async () => {
    const res = await app.inject(
      signed('POST', '/webhooks/yiji/tickets', ticketBody({ complaintType: 'Rude parrot' })),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().fields.complaintType).toContain('Unknown complaint type');
  });

  it('applies the agent form coupon rules (zero value, percentage without a cap, dates)', async () => {
    const zero = await app.inject(
      signed('POST', '/webhooks/yiji/tickets', ticketBody({ coupon: amountCoupon({ value: 0 }) })),
    );
    // The ticket is created; the coupon is reported with its field errors.
    expect(zero.statusCode).toBe(201);
    expect(zero.json().coupon.error.fields['coupon.value']).toBeDefined();

    const noCap = await app.inject(
      signed(
        'POST',
        '/webhooks/yiji/tickets',
        ticketBody({
          externalId: 'YT-NOCAP',
          coupon: { externalId: 'C1', type: 'percentage', percent: 20 },
        }),
      ),
    );
    expect(noCap.statusCode).toBe(201);
    expect(noCap.json().coupon.error.fields['coupon.maxDiscount']).toContain('maximum discount');

    const backwards = await app.inject(
      signed(
        'POST',
        '/webhooks/yiji/tickets',
        ticketBody({
          externalId: 'YT-BACKWARDS',
          coupon: amountCoupon({ validFrom: '2026-11-10', validTo: '2026-11-01' }),
        }),
      ),
    );
    expect(backwards.statusCode).toBe(201);
    expect(backwards.json().coupon.error.fields['coupon.validTo']).toBeDefined();
    expect(store.coupons.size).toBe(0);
  });

  it('refuses a mismatched money field and an unknown delivery type', async () => {
    const res = await app.inject(
      signed(
        'POST',
        '/webhooks/yiji/tickets',
        ticketBody({ coupon: amountCoupon({ percent: 10, deliveryTypes: ['teleport'] }) }),
      ),
    );
    expect(res.statusCode).toBe(201);
    expect(Object.keys(res.json().coupon.error.fields)).toEqual(
      expect.arrayContaining(['coupon.percent', 'coupon.deliveryTypes']),
    );
  });

  it('a body that is not JSON is a 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/yiji/tickets',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_request');
  });

  it('an add-coupon body is validated with coupon.* field names', async () => {
    await app.inject(signed('POST', '/webhooks/yiji/tickets', ticketBody()));
    const res = await app.inject(
      signed('POST', '/webhooks/yiji/tickets/YT-1001/coupons', { type: 'cash' }),
    );
    expect(res.statusCode).toBe(400);
    expect(Object.keys(res.json().fields)).toEqual(
      expect.arrayContaining(['coupon.externalId', 'coupon.type']),
    );
  });
});

describe('GET /webhooks/yiji/tickets/:externalId', () => {
  it('reads back the ticket status and every coupon with its decision', async () => {
    const created = await app.inject(
      signed('POST', '/webhooks/yiji/tickets', ticketBody({ coupon: amountCoupon() })),
    );
    await app.inject(
      signed(
        'POST',
        '/webhooks/yiji/tickets/YT-1001/coupons',
        amountCoupon({ externalId: 'YC-2' }),
      ),
    );
    const [first, second] = [...store.coupons.values()];
    first!.status = 'assigned' as never;
    second!.status = 'rejected' as never;
    second!.decision_note = 'Already compensated by phone.';
    store.tickets.get(created.json().ticketId)!.status = 'solved' as never;

    const res = await app.inject(signed('GET', '/webhooks/yiji/tickets/YT-1001'));
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(body).toMatchObject({
      ticketId: created.json().ticketId,
      externalId: 'YT-1001',
      status: 'solved',
      compensation: 'Compensated',
    });
    expect(body.coupons).toHaveLength(2);
    expect(body.coupons[0]).toMatchObject({ externalId: 'YC-9001', status: 'assigned', value: 25 });
    expect(body.coupons[1]).toMatchObject({
      externalId: 'YC-2',
      status: 'rejected',
      decisionNote: 'Already compensated by phone.',
    });
  });

  it('404 for an unknown ticket', async () => {
    const res = await app.inject(signed('GET', '/webhooks/yiji/tickets/UNKNOWN-1'));
    expect(res.statusCode).toBe(404);
  });
});

describe('CRM-side compensation policy hook', () => {
  const big = () => ticketBody({ coupon: amountCoupon({ value: 500 }) });

  it('OFF by default: a coupon over the limits is still accepted (pending a supervisor)', async () => {
    const res = await app.inject(signed('POST', '/webhooks/yiji/tickets', big()));
    expect(res.statusCode).toBe(201);
  });

  it('ON: the coupon is refused as policy_violation; the ticket is still created', async () => {
    const strict = build(store, {
      policy: { enforce: true, maxExposureSar: 200, maxPercent: 50, maxValidityDays: 90 },
    });
    const res = await strict.inject(signed('POST', '/webhooks/yiji/tickets', big()));
    expect(res.statusCode).toBe(201);
    expect(res.json().coupon).toMatchObject({
      status: 'not_created',
      error: { code: 'policy_violation', fields: { 'coupon.value': expect.any(String) } },
    });
    expect(store.tickets.size).toBe(1);
    expect(store.coupons.size).toBe(0);

    // Yiji fixes the coupon and resends: same ticket, the coupon is added.
    const ok = await strict.inject(
      signed('POST', '/webhooks/yiji/tickets', ticketBody({ coupon: amountCoupon() })),
    );
    expect(ok.statusCode).toBe(200);
    expect(ok.json().coupon.status).toBe('pending');
    expect(store.tickets.size).toBe(1);
  });

  it('checks percent and validity length too', () => {
    const p = { enforce: true, maxExposureSar: 200, maxPercent: 30, maxValidityDays: 30 };
    expect(
      couponPolicyProblems(
        {
          discount_category: 'Percentage',
          coupon_value: null,
          coupon_percent: 50,
          max_discount: 20,
          valid_from: '2026-10-01',
          valid_to: '2026-12-31',
        },
        p,
      ),
    ).toEqual({ 'coupon.percent': expect.any(String), 'coupon.validTo': expect.any(String) });
  });
});

describe('helpers', () => {
  it('maps CRM coupon states onto what Yiji reads', () => {
    const s = (
      status: string | null,
      removalStatus: string | null = null,
      replacedBy: string | null = null,
    ) => apiCouponStatus({ status, removalStatus, replacedBy });
    expect(s('pending')).toBe('pending');
    expect(s('edited')).toBe('approved');
    expect(s('approved')).toBe('approved');
    expect(s('assigned')).toBe('assigned');
    expect(s('rejected')).toBe('rejected');
    expect(s('assigned', 'removed')).toBe('removed');
    expect(s('approved', null, 'other')).toBe('replaced');
  });

  it('sorts Directus failures into duplicate / transient / refused', () => {
    expect(
      classifyDirectusError({
        errors: [{ message: 'x', extensions: { code: 'RECORD_NOT_UNIQUE', field: 'external_id' } }],
        response: { status: 400 },
      }),
    ).toMatchObject({ kind: 'duplicate', field: 'external_id' });
    expect(classifyDirectusError(new TypeError('fetch failed')).kind).toBe('transient');
    expect(classifyDirectusError({ errors: [], response: { status: 503 } }).kind).toBe('transient');
    expect(
      classifyDirectusError({ errors: [{ message: 'no' }], response: { status: 403 } }).kind,
    ).toBe('refused');
  });
});
