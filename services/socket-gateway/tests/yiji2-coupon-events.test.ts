import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { MockYiji2Transport } from '@yiji/shared-types';
import { signWebhook } from '../src/webhook.js';
import { registerYijiInboundApi, type YijiInboundService } from '../src/yiji-inbound.js';

/**
 * YIJI V2 PENDING GRANTS (contract 17 Nov 2026): `/webhooks/yiji2/events`
 * accepts `coupon.granted` WITH a `pending_grant_id` and `customer.created`,
 * de-duplicated on the envelope id like every event, and hands them to the
 * workers' coupons queue. A `coupon.granted` with no pending id (a grant the
 * CRM made itself) and unknown types are still ignored. v1's route never
 * takes them.
 */
const V1_SECRET = 'v1-events-secret';
const V2_SECRET = 'v2-events-secret';
const silent = { info: () => {}, warn: () => {}, error: () => {} };

const seen = new Set<string>();
const enqueueOrder = vi.fn(async () => 'job-order');
const enqueueCoupon = vi.fn(async () => 'job-coupon');
const enqueueV1 = vi.fn(async () => 'job-v1');

function jsonRaw(app: FastifyInstance) {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body: string, done) => {
    (req as { rawBody?: string }).rawBody = body;
    try {
      done(null, body ? JSON.parse(body) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });
}

function build(opts: { couponQueue?: boolean } = {}): FastifyInstance {
  const app = Fastify();
  jsonRaw(app);
  const base = {
    toleranceSec: 300,
    logger: silent,
    rate: { capacity: 1000, perSec: 1000 },
    service: {} as YijiInboundService,
  };
  const dedupe = (ns: string) => async (id: string) => {
    if (seen.has(`${ns}:${id}`)) return true;
    seen.add(`${ns}:${id}`);
    return false;
  };
  registerYijiInboundApi(app, {
    ...base,
    secret: V1_SECRET,
    events: { vendorKey: 'yiji:1', seen: dedupe('v1'), enqueue: enqueueV1 },
  });
  registerYijiInboundApi(app, {
    ...base,
    prefix: '/webhooks/yiji2',
    label: 'yiji2',
    secret: V2_SECRET,
    events: {
      format: 'yiji2',
      vendorKey: 'yiji2:2',
      seen: dedupe('v2'),
      enqueue: enqueueOrder,
      ...(opts.couponQueue === false ? {} : { enqueueCouponEvent: enqueueCoupon }),
    },
  });
  return app;
}

const signed = (url: string, body: unknown, secret: string) => {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    method: 'POST' as const,
    url,
    headers: {
      'content-type': 'application/json',
      'x-yiji-timestamp': ts,
      'x-yiji-signature': `sha256=${signWebhook(secret, ts, raw)}`,
    },
    payload: raw,
  };
};

const granted = (id: string, data: Record<string, unknown> = {}) => ({
  id,
  type: 'coupon.granted',
  occurred_at: '2026-11-17T10:00:00Z',
  environment: 'staging',
  data: { pending_grant_id: 800001, grant_id: 700005, coupon_id: 500001, code: 'V2-P1', ...data },
});
const created = (id: string) => ({
  id,
  type: 'customer.created',
  occurred_at: '2026-11-17T10:00:00Z',
  environment: 'staging',
  data: {
    customer_id: 2000000101,
    phone: '+966500000299',
    country: 'SA',
    at: '2026-11-17T09:59:59Z',
  },
});

beforeEach(() => {
  seen.clear();
  enqueueOrder.mockClear();
  enqueueCoupon.mockClear();
  enqueueV1.mockClear();
});

describe('POST /webhooks/yiji2/events - coupon.granted and customer.created', () => {
  it('queues coupon.granted with a pending grant id for the coupons queue, ids as strings', async () => {
    const res = await build().inject(signed('/webhooks/yiji2/events', granted('g-1'), V2_SECRET));
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true, accepted: 1, duplicates: 0, ignored: 0 });
    expect(enqueueCoupon).toHaveBeenCalledTimes(1);
    expect(enqueueCoupon.mock.calls[0]![0 as never]).toEqual({
      type: 'coupon.granted',
      eventId: 'g-1',
      vendorKey: 'yiji2:2',
      at: '2026-11-17T10:00:00Z',
      pendingGrantId: '800001',
      grantId: '700005',
      couponId: '500001',
      code: 'V2-P1',
    });
    expect(enqueueOrder).not.toHaveBeenCalled();
  });

  it('queues customer.created (customer id, E.164 phone, country)', async () => {
    const res = await build().inject(signed('/webhooks/yiji2/events', created('c-1'), V2_SECRET));
    expect(res.json()).toEqual({ ok: true, accepted: 1, duplicates: 0, ignored: 0 });
    expect(enqueueCoupon.mock.calls[0]![0 as never]).toEqual({
      type: 'customer.created',
      eventId: 'c-1',
      vendorKey: 'yiji2:2',
      at: '2026-11-17T09:59:59Z',
      customerId: '2000000101',
      phone: '+966500000299',
      country: 'SA',
    });
  });

  it('de-duplicates on the envelope id like every other event', async () => {
    const app = build();
    await app.inject(signed('/webhooks/yiji2/events', granted('g-2'), V2_SECRET));
    const res = await app.inject(signed('/webhooks/yiji2/events', granted('g-2'), V2_SECRET));
    expect(res.json()).toEqual({ ok: true, accepted: 0, duplicates: 1, ignored: 0 });
    expect(enqueueCoupon).toHaveBeenCalledTimes(1);
  });

  it('a coupon.granted without pending_grant_id, an unknown type and a malformed one are ignored', async () => {
    const body = {
      events: [
        { ...granted('g-3'), data: { grant_id: 1 } },
        { id: 'x-1', type: 'campaign.sent', occurred_at: '2026-11-17T10:00:00Z', data: {} },
        { ...granted('g-4'), data: { pending_grant_id: 800002 } },
        { ...created('c-2'), data: { customer_id: 2000000102 } },
      ],
    };
    const res = await build().inject(signed('/webhooks/yiji2/events', body, V2_SECRET));
    expect(res.json()).toEqual({ ok: true, accepted: 0, duplicates: 0, ignored: 4 });
    expect(enqueueCoupon).not.toHaveBeenCalled();
  });

  it('without a coupon queue the two types stay ignored, as before', async () => {
    const res = await build({ couponQueue: false }).inject(
      signed('/webhooks/yiji2/events', { events: [granted('g-5'), created('c-3')] }, V2_SECRET),
    );
    expect(res.json()).toEqual({ ok: true, accepted: 0, duplicates: 0, ignored: 2 });
  });

  it('a queue that is down answers 503 (v2 retries with the same ids)', async () => {
    enqueueCoupon.mockResolvedValueOnce(null as never);
    const res = await build().inject(signed('/webhooks/yiji2/events', granted('g-6'), V2_SECRET));
    expect(res.statusCode).toBe(503);
  });

  it('takes exactly what the v2 mock emits at sign-up, in one batch with an order event', async () => {
    const t = new MockYiji2Transport();
    await t.request('POST', '/compensation-coupons', {
      body: {
        code: 'V2-P2',
        type: 'amount',
        category: 'private',
        value: { amount_minor: 1000, currency: 'SAR' },
        total_discount_limit: { amount_minor: 1000, currency: 'SAR' },
        usage_limit: 1,
        country: 'SA',
        phone: '+966500000277',
      },
    });
    const { events } = t.simulateSignup('0500000277');
    expect(events.map((e) => e.type)).toEqual(['coupon.granted', 'customer.created']);
    const order = {
      id: 'o-1',
      type: 'order.status_changed',
      occurred_at: '2026-11-17T10:30:00Z',
      data: {
        order_number: '2611000000001',
        state: 'delivered',
        order_type: 'delivery',
        placed_at: '2026-11-17T08:55:00Z',
      },
    };
    const res = await build().inject(
      signed('/webhooks/yiji2/events', { events: [...events, order] }, V2_SECRET),
    );
    expect(res.json()).toEqual({ ok: true, accepted: 3, duplicates: 0, ignored: 0 });
    expect(enqueueOrder).toHaveBeenCalledTimes(1);
    expect(enqueueCoupon).toHaveBeenCalledTimes(2);
    expect(enqueueCoupon.mock.calls[0]![0 as never]).toMatchObject({
      type: 'coupon.granted',
      pendingGrantId: t.pendingGrants[0]!.pending_grant_id,
      grantId: t.pendingGrants[0]!.grant_id,
      phone: '+966500000277',
    });
  });

  it("v1's /webhooks/yiji/events never takes them", async () => {
    const res = await build().inject(signed('/webhooks/yiji/events', granted('g-7'), V1_SECRET));
    expect(res.statusCode).toBe(400);
    expect(enqueueCoupon).not.toHaveBeenCalled();
    expect(enqueueV1).not.toHaveBeenCalled();
  });
});
