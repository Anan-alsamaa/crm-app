import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';
import { createEnvVendorSecrets } from '@yiji/shared-types';
import { signWebhook } from '../src/webhook.js';
import { registerYijiInboundApi, type YijiInboundService } from '../src/yiji-inbound.js';
import { createVendorJwtSecrets } from '../src/vendor-auth.js';
import { createVendorVerifier, CustomerTokenError } from '../src/auth/customer-jwt.js';

/**
 * YIJI V2 - THE SECOND TENANT'S INBOUND API (owner, 2026-11-16): the same
 * routes under `/webhooks/yiji2`, verified with VENDOR_YIJI2_WEBHOOK_SECRET
 * (never v1's), events in v2's envelope translated and de-duplicated on
 * their id, handed to the workers for the `yiji2:2` late-orders table. And
 * the chat login: a v2 customer token is verified with VENDOR_YIJI2_JWT_SECRET
 * when it names vendor 2; one signed by v2 that names no vendor is NOT taken
 * for v1's.
 */
const V1_SECRET = 'v1-events-secret';
const V2_SECRET = 'v2-events-secret';
const silent = { info: () => {}, warn: () => {}, error: () => {} };

const seen = new Set<string>();
const enqueueV2 = vi.fn(async () => 'job-v2');
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

/** Both tenants mounted on one app, as index.ts does. */
function build(): FastifyInstance {
  const app = Fastify();
  jsonRaw(app);
  const base = {
    toleranceSec: 300,
    logger: silent,
    rate: { capacity: 1000, perSec: 1000 },
    service: {} as YijiInboundService,
  };
  registerYijiInboundApi(app, {
    ...base,
    secret: V1_SECRET,
    events: {
      vendorKey: 'yiji:1',
      seen: async (id) => {
        if (seen.has(`v1:${id}`)) return true;
        seen.add(`v1:${id}`);
        return false;
      },
      enqueue: enqueueV1,
    },
  });
  registerYijiInboundApi(app, {
    ...base,
    prefix: '/webhooks/yiji2',
    label: 'yiji2',
    secret: V2_SECRET,
    events: {
      format: 'yiji2',
      vendorKey: 'yiji2:2',
      seen: async (id) => {
        if (seen.has(`v2:${id}`)) return true;
        seen.add(`v2:${id}`);
        return false;
      },
      enqueue: enqueueV2,
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

const lateEvent = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  type: 'order.late',
  occurred_at: '2026-11-16T10:00:00Z',
  environment: 'staging',
  data: {
    order_number: 2611000000001,
    customer_id: 2000000001,
    brand_id: 91,
    restaurant_id: 9101,
    country: 'SA',
    placed_at: '2026-11-16T08:55:00Z',
    elapsed_seconds: 3900,
    threshold_minutes: 60,
    state: 'out_for_delivery',
    timeline: [{ state: 'created', at: '2026-11-16T08:55:00Z' }],
    ...over,
  },
});

beforeEach(() => {
  seen.clear();
  enqueueV1.mockClear();
  enqueueV2.mockClear();
});

describe('POST /webhooks/yiji2/events', () => {
  it('accepts an order.late signed with the V2 secret and queues it for the yiji2 vendor', async () => {
    const res = await build().inject(
      signed('/webhooks/yiji2/events', lateEvent('v2-ev-1'), V2_SECRET),
    );
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true, accepted: 1, duplicates: 0, ignored: 0 });
    expect(enqueueV2).toHaveBeenCalledTimes(1);
    expect(enqueueV2.mock.calls[0]![0 as never]).toMatchObject({
      vendorKey: 'yiji2:2',
      event: {
        id: 'v2-ev-1',
        type: 'order.status_changed',
        order: {
          orderId: '2611000000001',
          status: 'in_delivery',
          isOpen: true,
          placedAt: '2026-11-16T08:55:00Z',
        },
      },
    });
    expect(enqueueV1).not.toHaveBeenCalled();
  });

  it("rejects the same event signed with V1's secret (401) - v2 never borrows v1's", async () => {
    const res = await build().inject(
      signed('/webhooks/yiji2/events', lateEvent('v2-ev-2'), V1_SECRET),
    );
    expect(res.statusCode).toBe(401);
    expect(enqueueV2).not.toHaveBeenCalled();
  });

  it('de-duplicates on the envelope id (a retry is counted, not queued twice)', async () => {
    const app = build();
    await app.inject(signed('/webhooks/yiji2/events', lateEvent('v2-ev-3'), V2_SECRET));
    const res = await app.inject(signed('/webhooks/yiji2/events', lateEvent('v2-ev-3'), V2_SECRET));
    expect(res.json()).toEqual({ ok: true, accepted: 0, duplicates: 1, ignored: 0 });
    expect(enqueueV2).toHaveBeenCalledTimes(1);
  });

  it('a batch: status_changed closes the order, coupon.* is ignored, de-dup is per tenant', async () => {
    const app = build();
    const body = {
      events: [
        {
          id: 'v2-ev-4',
          type: 'order.status_changed',
          occurred_at: '2026-11-16T10:30:00Z',
          data: {
            order_number: '2611000000001',
            state: 'delivered',
            placed_at: '2026-11-16T08:55:00Z',
            total: { amount_minor: 8800, currency: 'SAR' },
          },
        },
        {
          id: 'v2-ev-5',
          type: 'coupon.granted',
          occurred_at: '2026-11-16T10:31:00Z',
          data: { grant_id: 1 },
        },
      ],
    };
    const res = await app.inject(signed('/webhooks/yiji2/events', body, V2_SECRET));
    expect(res.json()).toEqual({ ok: true, accepted: 1, duplicates: 0, ignored: 1 });
    expect(enqueueV2.mock.calls[0]![0 as never]).toMatchObject({
      vendorKey: 'yiji2:2',
      event: { order: { status: 'delivered', isOpen: false, total: 88 } },
    });
    /* The same id on V1's route is V1's own event, under V1's namespace. */
    const v1 = await app.inject(
      signed(
        '/webhooks/yiji/events',
        {
          id: 'v2-ev-4',
          type: 'order.status_changed',
          at: '2026-11-16T10:30:00+03:00',
          order: {
            orderId: '1400001',
            status: 'in_delivery',
            isOpen: true,
            orderType: 'delivery',
            placedAt: '2026-11-16T09:30:00+03:00',
          },
        },
        V1_SECRET,
      ),
    );
    expect(v1.json()).toMatchObject({ accepted: 1 });
    expect(enqueueV1.mock.calls[0]![0 as never]).toMatchObject({ vendorKey: 'yiji:1' });
  });

  it('a v2 envelope on the V1 route is a 400 (the shapes are not interchangeable)', async () => {
    const res = await build().inject(
      signed('/webhooks/yiji/events', lateEvent('v2-ev-6'), V1_SECRET),
    );
    expect(res.statusCode).toBe(400);
  });

  it('answers 503 while the v2 secret is not configured', async () => {
    const app = Fastify();
    jsonRaw(app);
    registerYijiInboundApi(app, {
      prefix: '/webhooks/yiji2',
      secret: '',
      toleranceSec: 300,
      logger: silent,
      rate: { capacity: 1000, perSec: 1000 },
      service: {} as YijiInboundService,
    });
    const res = await app.inject(signed('/webhooks/yiji2/events', lateEvent('x'), V2_SECRET));
    expect(res.statusCode).toBe(503);
  });
});

describe('a v2 customer chat token', () => {
  const YIJI_JWT = 'yiji-jwt-secret-that-is-long-enough-for-hs256-xx';
  const V2_JWT = 'yiji2-jwt-secret-that-is-long-enough-for-hs256-x';
  const secrets = createEnvVendorSecrets({
    YIJI_JWT_SECRET: YIJI_JWT,
    VENDOR_YIJI2_JWT_SECRET: V2_JWT,
  });
  const jwtSecret = createVendorJwtSecrets({
    secrets,
    defaultVendorId: '1',
    lookupKey: async (id) => (id === '2' ? 'yiji2' : null),
  });
  const verifier = createVendorVerifier(jwtSecret);
  const claims = { customer_id: '2000000001', phone: '+966500000201', name: 'V2 One' };

  it('is verified with VENDOR_YIJI2_JWT_SECRET when it names vendor 2', async () => {
    const token = jwt.sign({ ...claims, vendor_id: '2' }, V2_JWT, {
      algorithm: 'HS256',
      expiresIn: '1h',
    });
    const out = await verifier.verify(token);
    expect(out.vendor_id).toBe('2');
    expect(out.customer_id).toBe('2000000001');
  });

  it("is rejected when it names vendor 2 but was signed with v1's secret, and vice versa", async () => {
    const wrong = jwt.sign({ ...claims, vendor_id: '2' }, YIJI_JWT, {
      algorithm: 'HS256',
      expiresIn: '1h',
    });
    await expect(verifier.verify(wrong)).rejects.toBeInstanceOf(CustomerTokenError);
    const asV1 = jwt.sign({ ...claims, vendor_id: '1' }, V2_JWT, {
      algorithm: 'HS256',
      expiresIn: '1h',
    });
    await expect(verifier.verify(asV1)).rejects.toBeInstanceOf(CustomerTokenError);
  });

  it('is NOT swallowed by the default vendor: a v2-signed token with no vendor_id is refused', async () => {
    const noVendor = jwt.sign(claims, V2_JWT, { algorithm: 'HS256', expiresIn: '1h' });
    await expect(verifier.verify(noVendor)).rejects.toBeInstanceOf(CustomerTokenError);
  });
});
