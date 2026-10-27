import { describe, it, expect, beforeEach } from 'vitest';
import type { CompensationRule, RuleCouponLimit, StoreRecord } from '@yiji/shared-types';
import {
  InboundStoreError,
  createYijiInboundService,
  type InboundCoupon,
  type InboundTicket,
  type NewCouponRow,
  type NewTicketRow,
  type YijiInboundStore,
} from '../src/yiji-inbound.js';

/**
 * THE COMPENSATION RULES on the Yiji inbound API (owner, 2026-10-27).
 *
 * A Yiji ticket sent WITHOUT a coupon gets the matching rule's coupon as a
 * PENDING request; one sent WITH a coupon keeps Yiji's and never gets a second;
 * a rule problem of any kind never blocks or undoes the ticket.
 */

const VENDOR = 'vendor-yiji';
const STORE: StoreRecord = {
  id: 'store-1',
  code: 'LCP-002',
  name: 'Marina Mall 2',
  city: 'Riyadh',
  areaManager: null,
  chainManager: null,
  brandCode: 'LCP',
  brandName: 'Casa Pasta',
  yijiRestaurantId: '501',
};

const rule = (over: Partial<CompensationRule> = {}): CompensationRule => ({
  id: 'rule-late',
  name: 'Late order 30',
  active: true,
  priority: 0,
  complaint_type: 'Late order',
  discount_category: 'Amount',
  coupon_value: 30,
  ...over,
});

type CouponRow = NewCouponRow & { date_created: string };

class FakeStore implements YijiInboundStore {
  tickets = new Map<string, NewTicketRow>();
  coupons = new Map<string, CouponRow>();
  events: Array<{ ticket: string; text: string; payload: Record<string, unknown> }> = [];
  rules: CompensationRule[] = [];
  rulesFail = false;
  limit: RuleCouponLimit | null = null;
  couponFailures: InboundStoreError[] = [];
  /** Rule coupons the customer already had (counted by ruleCouponsSince). */
  priorRuleCoupons = 0;
  private seq = 0;

  async yijiVendorId() {
    return VENDOR;
  }
  private toCoupon(r: CouponRow): InboundCoupon {
    return {
      id: r.id,
      externalId: r.external_id,
      ticketId: r.ticket,
      code: r.coupon_code,
      status: r.status,
      decisionNote: null,
      decidedAt: null,
      value: r.coupon_value,
      percent: r.coupon_percent,
      maxDiscount: r.max_discount,
      validFrom: r.valid_from,
      validTo: r.valid_to,
      removalStatus: null,
      replacedBy: null,
      dateCreated: r.date_created,
      policyRule: r.policy_rule ?? null,
    };
  }
  async findTicket(vendor: string, ext: string): Promise<InboundTicket | null> {
    const r = [...this.tickets.values()].find((t) => t.vendor === vendor && t.external_id === ext);
    return r
      ? {
          id: r.id,
          externalId: r.external_id,
          status: r.status,
          compensation: r.compensation,
          contactId: r.contact,
          customerPhone: r.customer_phone,
          orderId: r.order_id,
          description: r.description,
          restaurantId: '501',
          dateCreated: null,
          resolvedAt: null,
        }
      : null;
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
    return [STORE];
  }
  async upsertContact() {
    return 'contact-1';
  }
  async couponCodeTaken() {
    return false;
  }
  async createTicket(row: NewTicketRow) {
    this.tickets.set(row.id, { ...row });
  }
  async createCoupon(row: NewCouponRow) {
    const fail = this.couponFailures.shift();
    if (fail) throw fail;
    const all = [...this.coupons.values()];
    if (row.external_id && all.some((c) => c.external_id === row.external_id)) {
      throw new InboundStoreError('duplicate', 'not unique', 'external_id');
    }
    // uq_coupon_approvals_ticket_policy_rule
    if (row.policy_rule && all.some((c) => c.ticket === row.ticket && c.policy_rule)) {
      throw new InboundStoreError('duplicate', 'not unique', 'ticket');
    }
    this.coupons.set(row.id, { ...row, date_created: `2026-10-27T10:00:0${++this.seq}Z` });
  }
  async setTicketCompensation(id: string, value: 'Compensated' | 'Not Compensated') {
    const t = this.tickets.get(id);
    if (t) (t as { compensation: string }).compensation = value;
  }
  async addTicketEvent(
    ticket: string,
    _actor: string | null,
    text: string,
    payload: Record<string, unknown>,
  ) {
    this.events.push({ ticket, text, payload });
  }
  async actorId() {
    return 'user-yiji';
  }
  async compensationRules() {
    if (this.rulesFail) throw new Error('403 compensation_rules');
    return this.rules;
  }
  async ruleCouponLimit() {
    return this.limit;
  }
  async ruleCouponsSince(_contact: string, _since: string, max: number) {
    return Math.min(this.priorRuleCoupons, max);
  }
}

const silent = { info: () => {}, warn: () => {}, error: () => {} };

let store: FakeStore;
let svc: ReturnType<typeof createYijiInboundService>;
let n = 0;
beforeEach(() => {
  store = new FakeStore();
  n = 0;
  svc = createYijiInboundService({
    store,
    logger: silent,
    now: () => new Date('2026-10-27T10:00:00.000Z'),
    newId: () => `id-${++n}`,
    sleep: async () => {},
    retryDelaysMs: [0, 0],
  });
});

const body = (over: Record<string, unknown> = {}) => ({
  externalId: 'YT-1',
  customer: { phone: '0501234567' },
  restaurantId: '501',
  complaintType: 'Late order',
  serviceType: 'Delivery',
  description: 'Arrived an hour late.',
  ...over,
});

describe('Yiji ticket WITHOUT a coupon: the rule decides', () => {
  it('creates the matching rule coupon, pending, linked to the ticket', async () => {
    store.rules = [rule()];
    const res = await svc.createTicket(body());
    expect(res.status).toBe(201);
    const coupons = [...store.coupons.values()];
    expect(coupons).toHaveLength(1);
    const c = coupons[0]!;
    expect(c.status).toBe('pending');
    expect(c.policy_rule).toBe('rule-late');
    expect(c.external_id).toBeNull();
    expect(c.coupon_value).toBe(30);
    expect(c.max_discount).toBe(30);
    expect(c.coupon_type).toBe('Private');
    expect(c.issuing_side).toBe('Customer Care');
    expect(c.coupon_code).toMatch(/^CC-/);
    expect(c.reason).toBe('Arrived an hour late.');
    expect(c.ticket).toBe(res.body.ticketId);
    expect(res.body.coupon).toMatchObject({ status: 'pending', source: 'rule' });
    // The history line names the rule.
    expect(store.events.map((e) => e.text)).toContain(
      `Coupon from rule "Late order 30" (code ${c.coupon_code}) - waiting for a WeCare supervisor.`,
    );
    // Compensated once the coupon row exists, exactly like Yiji's own.
    expect([...store.tickets.values()][0]!.compensation).toBe('Compensated');
  });

  it('no rule matches: the ticket only, no coupon, no coupon key in the reply', async () => {
    store.rules = [rule({ complaint_type: 'Missing item' })];
    const res = await svc.createTicket(body());
    expect(res.status).toBe(201);
    expect(store.coupons.size).toBe(0);
    expect(res.body.coupon).toBeUndefined();
    expect([...store.tickets.values()][0]!.compensation).toBe('Not Compensated');
  });

  it('uses the optional orderValue / delayMinutes conditions', async () => {
    store.rules = [
      rule({ id: 'plain', name: 'Plain', coupon_value: 10 }),
      rule({ id: 'very-late', name: 'Very late', coupon_value: 40, min_delay_minutes: 60 }),
    ];
    await svc.createTicket(body({ delayMinutes: 75 }));
    expect([...store.coupons.values()][0]!.policy_rule).toBe('very-late');

    await svc.createTicket(body({ externalId: 'YT-2', delayMinutes: 20 }));
    const second = [...store.coupons.values()].find((c) => c.policy_rule === 'plain');
    expect(second?.coupon_value).toBe(10);
  });

  it('rejects a malformed orderValue as a field error (the ticket is not written)', async () => {
    await expect(svc.createTicket(body({ orderValue: -5 }))).rejects.toMatchObject({
      status: 400,
    });
    expect(store.tickets.size).toBe(0);
  });
});

describe('Yiji ticket WITH a coupon: Yiji decides, never a second (rule) coupon', () => {
  it('keeps Yiji’s coupon and adds no rule coupon', async () => {
    store.rules = [rule()];
    const res = await svc.createTicket(
      body({ coupon: { externalId: 'YC-1', type: 'amount', value: 15 } }),
    );
    expect(res.status).toBe(201);
    const coupons = [...store.coupons.values()];
    expect(coupons).toHaveLength(1);
    expect(coupons[0]!.external_id).toBe('YC-1');
    expect(coupons[0]!.policy_rule).toBeUndefined();
    expect(res.body.coupon).not.toHaveProperty('source');
  });

  it('an INVALID Yiji coupon is still Yiji’s call: no rule coupon either', async () => {
    store.rules = [rule()];
    const res = await svc.createTicket(body({ coupon: { externalId: 'YC-1', type: 'amount' } }));
    expect(res.status).toBe(201);
    expect(store.coupons.size).toBe(0);
    expect((res.body.coupon as { status: string }).status).toBe('not_created');
  });
});

describe('a rule problem never blocks the ticket', () => {
  it('rules unreadable: ticket created, no coupon', async () => {
    store.rulesFail = true;
    const res = await svc.createTicket(body());
    expect(res.status).toBe(201);
    expect(store.tickets.size).toBe(1);
    expect(store.coupons.size).toBe(0);
  });

  it('the coupon cannot be stored: ticket kept, history says so', async () => {
    store.rules = [rule()];
    store.couponFailures = [new InboundStoreError('refused', 'field policy_rule not found')];
    const res = await svc.createTicket(body());
    expect(res.status).toBe(201);
    expect(store.tickets.size).toBe(1);
    expect(store.coupons.size).toBe(0);
    expect(res.body.coupon).toBeUndefined();
    expect(store.events.some((e) => e.text.includes('could not be stored'))).toBe(true);
    expect([...store.tickets.values()][0]!.compensation).toBe('Not Compensated');
  });

  it('a rule that is not a valid coupon: ticket kept, history names the rule', async () => {
    store.rules = [rule({ coupon_value: 0 })];
    const res = await svc.createTicket(body());
    expect(res.status).toBe(201);
    expect(store.coupons.size).toBe(0);
    expect(
      store.events.some(
        (e) => e.text.includes('"Late order 30"') && e.text.includes('not a valid coupon'),
      ),
    ).toBe(true);
  });
});

describe('one rule coupon per ticket', () => {
  it('a replay of the same ticket never adds a second rule coupon', async () => {
    store.rules = [rule()];
    await svc.createTicket(body());
    const again = await svc.createTicket(body());
    expect(again.status).toBe(200);
    expect(store.coupons.size).toBe(1);
    expect(again.body.coupon).toMatchObject({ source: 'rule' });
  });

  it('a replay after the rule coupon failed the first time finishes the job, once', async () => {
    store.rules = [rule()];
    store.couponFailures = [new InboundStoreError('refused', 'boom')];
    await svc.createTicket(body());
    expect(store.coupons.size).toBe(0);
    await svc.createTicket(body());
    await svc.createTicket(body());
    expect(store.coupons.size).toBe(1);
  });

  it('a ticket that already has a coupon (Yiji added one later) gets no rule coupon on replay', async () => {
    await svc.createTicket(body());
    await svc.addCoupon('YT-1', { externalId: 'YC-7', type: 'amount', value: 20 });
    store.rules = [rule()];
    await svc.createTicket(body());
    expect([...store.coupons.values()].map((c) => c.external_id)).toEqual(['YC-7']);
  });
});

describe('the optional per-customer limit', () => {
  it('off by default: a rule coupon is created', async () => {
    store.rules = [rule()];
    store.priorRuleCoupons = 99;
    await svc.createTicket(body());
    expect(store.coupons.size).toBe(1);
  });

  it('reached: no coupon, the ticket stands, history says why', async () => {
    store.rules = [rule()];
    store.limit = { maxPerCustomer: 2, windowDays: 30 };
    store.priorRuleCoupons = 2;
    const res = await svc.createTicket(body());
    expect(res.status).toBe(201);
    expect(store.coupons.size).toBe(0);
    expect(
      store.events.some((e) => e.text.includes('already had 2 rule coupon(s) in the last 30 days')),
    ).toBe(true);
  });

  it('under the limit: created', async () => {
    store.rules = [rule()];
    store.limit = { maxPerCustomer: 2, windowDays: 30 };
    store.priorRuleCoupons = 1;
    await svc.createTicket(body());
    expect(store.coupons.size).toBe(1);
  });
});
