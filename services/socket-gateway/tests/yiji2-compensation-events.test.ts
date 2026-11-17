import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { signWebhook } from '../src/webhook.js';
import { registerYijiInboundApi, type YijiInboundService } from '../src/yiji-inbound.js';

/**
 * YIJI V2 AUTOMATIC COMPENSATION (owner, 18 Nov 2026): `/webhooks/yiji2/events`
 * accepts `compensation.proposed`, `.decided` and `.escalated`, verified with
 * v2's secret and de-duplicated on the envelope id like every event, and hands
 * them to the workers' coupons queue. A malformed one is ignored (never a
 * guessed case); unknown types are still ignored; v1's route never takes them.
 */
const V1_SECRET = 'v1-events-secret';
const V2_SECRET = 'v2-events-secret';
const silent = { info: () => {}, warn: () => {}, error: () => {} };

const seen = new Set<string>();
const enqueueOrder = vi.fn(async () => 'job-order');
const enqueueCoupon = vi.fn(async () => 'job-coupon');
const enqueueCompensation = vi.fn(async (): Promise<string | null> => 'job-comp');
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

function build(opts: { compensationQueue?: boolean } = {}): FastifyInstance {
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
      enqueueCouponEvent: enqueueCoupon,
      ...(opts.compensationQueue === false
        ? {}
        : { enqueueCompensationEvent: enqueueCompensation }),
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

const env = (id: string, type: string, data: Record<string, unknown>) => ({
  id,
  type,
  occurred_at: '2026-11-18T10:00:00Z',
  environment: 'staging',
  data,
});
const proposed = (id: string, data: Record<string, unknown> = {}) =>
  env(id, 'compensation.proposed', {
    case_id: 900001,
    status: 'proposed',
    source: 'auto',
    policy_version: 3,
    row_key: 'DLY-T2',
    rule_code: 'DLY',
    order_number: 2611000000001,
    customer_id: 2000000001,
    country: 'SA',
    brand_id: 91,
    order_total: { amount_minor: 9200, currency: 'SAR' },
    action_type: 'FIXED',
    comp_method: 'Monetary',
    amount: { amount_minor: 2000, currency: 'SAR' },
    has_photos: false,
    expires_at: '2026-11-21T10:00:00Z',
    at: '2026-11-18T10:00:00Z',
    ...data,
  });
const decided = (id: string) =>
  env(id, 'compensation.decided', {
    case_id: 900001,
    order_number: 2611000000001,
    customer_id: 2000000001,
    country: 'SA',
    row_key: 'DLY-T2',
    decision: 'approved',
    by: { kind: 'partner_client', id: 'crm' },
    agent_id: 'agent-uuid-1',
    issued: { amount_minor: 2000, currency: 'SAR' },
    overridden: false,
    wallet_entry_id: 950001,
    at: '2026-11-18T11:00:00Z',
  });
const escalated = (id: string) =>
  env(id, 'compensation.escalated', {
    case_id: 900002,
    row_key: 'HOS-O3',
    rule_code: 'HOS',
    escalate_to: 'Relevant management',
    condition: 'always',
    condition_known: true,
    order_number: 2611000000001,
    customer_id: 2000000001,
    country: 'SA',
    order_total: { amount_minor: 9200, currency: 'SAR' },
    at: '2026-11-18T10:00:00Z',
  });

beforeEach(() => {
  seen.clear();
  enqueueOrder.mockClear();
  enqueueCoupon.mockClear();
  enqueueCompensation.mockClear();
  enqueueV1.mockClear();
});

describe('POST /webhooks/yiji2/events - compensation.*', () => {
  it('queues each of the three types for the workers, with the event id and vendor key', async () => {
    const res = await build().inject(
      signed(
        '/webhooks/yiji2/events',
        { events: [proposed('p-1'), decided('d-1'), escalated('e-1')] },
        V2_SECRET,
      ),
    );
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true, accepted: 3, duplicates: 0, ignored: 0 });
    expect(enqueueCompensation).toHaveBeenCalledTimes(3);
    const jobs = enqueueCompensation.mock.calls.map((c) => (c as unknown[])[0]) as Array<{
      type: string;
      eventId: string;
      vendorKey: string;
      at: string;
      data: Record<string, unknown>;
    }>;
    expect(jobs.map((j) => j.type)).toEqual([
      'compensation.proposed',
      'compensation.decided',
      'compensation.escalated',
    ]);
    expect(jobs[0]).toMatchObject({
      eventId: 'p-1',
      vendorKey: 'yiji2:2',
      at: '2026-11-18T10:00:00Z',
      data: { case_id: 900001, status: 'proposed', row_key: 'DLY-T2' },
    });
    expect(jobs[1]!.data).toMatchObject({ decision: 'approved', wallet_entry_id: 950001 });
    expect(jobs[2]!.data).toMatchObject({ escalate_to: 'Relevant management' });
    expect(enqueueOrder).not.toHaveBeenCalled();
    expect(enqueueCoupon).not.toHaveBeenCalled();
  });

  it('de-duplicates a redelivery by the event id', async () => {
    const app = build();
    await app.inject(signed('/webhooks/yiji2/events', proposed('p-dup'), V2_SECRET));
    const again = await app.inject(signed('/webhooks/yiji2/events', proposed('p-dup'), V2_SECRET));
    expect(again.json()).toEqual({ ok: true, accepted: 0, duplicates: 1, ignored: 0 });
    expect(enqueueCompensation).toHaveBeenCalledTimes(1);
  });

  it('refuses an unsigned or v1-signed body (401) and queues nothing', async () => {
    const res = await build().inject(signed('/webhooks/yiji2/events', proposed('p-x'), V1_SECRET));
    expect(res.statusCode).toBe(401);
    expect(enqueueCompensation).not.toHaveBeenCalled();
  });

  it('ignores a malformed compensation event (no case id / unknown status): never a guessed case', async () => {
    const noId = proposed('p-bad');
    delete (noId.data as Record<string, unknown>).case_id;
    const badStatus = proposed('p-bad2', { status: 'approved' });
    const res = await build().inject(
      signed('/webhooks/yiji2/events', { events: [noId, badStatus] }, V2_SECRET),
    );
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ accepted: 0, ignored: 2 });
    expect(enqueueCompensation).not.toHaveBeenCalled();
  });

  it('still ignores unknown types', async () => {
    const res = await build().inject(
      signed('/webhooks/yiji2/events', env('u-1', 'compensation.whatever', {}), V2_SECRET),
    );
    expect(res.json()).toMatchObject({ accepted: 0, ignored: 1 });
    expect(enqueueCompensation).not.toHaveBeenCalled();
  });

  it('a queue that is down answers 503 so V2 retries', async () => {
    enqueueCompensation.mockResolvedValueOnce(null);
    const res = await build().inject(
      signed('/webhooks/yiji2/events', proposed('p-503'), V2_SECRET),
    );
    expect(res.statusCode).toBe(503);
  });

  it('without the compensation queue wired the types are ignored as before', async () => {
    const res = await build({ compensationQueue: false }).inject(
      signed('/webhooks/yiji2/events', proposed('p-off'), V2_SECRET),
    );
    expect(res.json()).toMatchObject({ accepted: 0, ignored: 1 });
  });
});

describe('v1 is unchanged', () => {
  it('the v1 events route never queues a compensation event', async () => {
    const res = await build().inject(
      signed('/webhooks/yiji/events', { events: [proposed('v1-p')] }, V1_SECRET),
    );
    expect(enqueueCompensation).not.toHaveBeenCalled();
    expect(enqueueV1).not.toHaveBeenCalled();
    expect([202, 400]).toContain(res.statusCode);
  });
});
