import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { signWebhook } from '../src/webhook.js';
import { registerYijiInboundApi, type YijiInboundService } from '../src/yiji-inbound.js';

/**
 * POST /webhooks/yiji/events (owner, 2026-11-15): the platform's order
 * events, signed like the ticket API, deduped by event id, handed to the
 * workers. Always 202 once parsed - the work is the workers'.
 */
const SECRET = 'events-secret';
const silent = { info: () => {}, warn: () => {}, error: () => {} };

const seenIds = new Set<string>();
const enqueue = vi.fn(async () => 'job-1');
const events = {
  vendorKey: 'yiji:1',
  seen: vi.fn(async (id: string) => {
    if (seenIds.has(id)) return true;
    seenIds.add(id);
    return false;
  }),
  enqueue,
};

function build(withEvents = true): FastifyInstance {
  const app = Fastify();
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
    secret: SECRET,
    toleranceSec: 300,
    logger: silent,
    rate: { capacity: 1000, perSec: 1000 },
    service: {} as YijiInboundService,
    ...(withEvents ? { events } : {}),
  });
  return app;
}

const signed = (body: unknown, secret = SECRET) => {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    method: 'POST' as const,
    url: '/webhooks/yiji/events',
    headers: {
      'content-type': 'application/json',
      'x-yiji-timestamp': ts,
      'x-yiji-signature': `sha256=${signWebhook(secret, ts, raw)}`,
    },
    payload: raw,
  };
};

const event = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  type: 'order.status_changed',
  at: '2026-11-15T10:05:00+03:00',
  order: {
    orderId: '1400001',
    status: 'in_delivery',
    isOpen: true,
    orderType: 'delivery',
    placedAt: '2026-11-15T09:30:00+03:00',
    restaurantId: '501',
    customer: { id: 'u-1', phone: '+966501234567' },
    ...over,
  },
});

beforeEach(() => {
  seenIds.clear();
  enqueue.mockClear();
  events.seen.mockClear();
});

describe('POST /webhooks/yiji/events', () => {
  it('accepts a signed event and hands it to the workers for the Yiji vendor', async () => {
    const res = await build().inject(signed(event('ev-1')));
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true, accepted: 1, duplicates: 0, ignored: 0 });
    expect(enqueue).toHaveBeenCalledWith({
      vendorKey: 'yiji:1',
      event: expect.objectContaining({
        id: 'ev-1',
        order: expect.objectContaining({ orderId: '1400001' }),
      }),
    });
  });
  it('a batch: each id once - a retry counts as a duplicate and queues nothing', async () => {
    const app = build();
    const first = await app.inject(signed({ events: [event('a'), event('b')] }));
    expect(first.json()).toMatchObject({ accepted: 2, duplicates: 0 });
    const retry = await app.inject(signed({ events: [event('a'), event('c')] }));
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toMatchObject({ accepted: 1, duplicates: 1 });
    expect(enqueue).toHaveBeenCalledTimes(3);
  });
  it('an event type the CRM does not act on is accepted and ignored', async () => {
    const res = await build().inject(signed({ ...event('x'), type: 'coupon.used' }));
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ accepted: 0, ignored: 1 });
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('an invalid event is a 400 naming the field; nothing is queued', async () => {
    const res = await build().inject(
      signed({ ...event('bad'), at: '2026-11-15 13:05:00', order: { orderId: '1' } }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().fields).toMatchObject({ at: expect.any(String) });
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('an unsigned or badly signed call is refused', async () => {
    const res = await build().inject(signed(event('ev-2'), 'wrong'));
    expect(res.statusCode).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('503 when events are not set up, or the queue cannot take it (retry with the same ids)', async () => {
    const off = await build(false).inject(signed(event('ev-3')));
    expect(off.statusCode).toBe(503);
    enqueue.mockResolvedValueOnce(null as never);
    const down = await build().inject(signed(event('ev-4')));
    expect(down.statusCode).toBe(503);
  });
});
