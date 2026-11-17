import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { signWebhook } from '../src/webhook.js';
import { registerYijiInboundApi, type YijiInboundService } from '../src/yiji-inbound.js';
import SAMPLES from '../../../packages/shared-types/tests/fixtures/yiji2-compensation-samples.json';

/**
 * THE REAL V2 PAYLOADS at the receiver (yiji-platform
 * `docs/integrations/crm/auto-compensation-samples.md`, printed by a V2 test
 * run on 2026-11-18). Each sample is signed and POSTed to
 * `/webhooks/yiji2/events`; it must be accepted and handed to the workers'
 * queue with its `data` unchanged - never ignored as malformed. The worker
 * side of the same samples is `services/workers/tests/compensation-yiji2-samples.test.ts`.
 */
type Rec = Record<string, unknown>;
type SampleName = Exclude<keyof typeof SAMPLES, '_source'>;
const NAMES = Object.keys(SAMPLES).filter((k) => k !== '_source') as SampleName[];

const V2_SECRET = 'v2-events-secret';
const seen = new Set<string>();
const enqueueOrder = vi.fn(async () => 'job-order');
const enqueueCoupon = vi.fn(async () => 'job-coupon');
const enqueueCompensation = vi.fn(async (): Promise<string | null> => 'job-comp');
const warn = vi.fn();
const logger = { info: () => {}, warn, error: () => {} };

function build(): FastifyInstance {
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
    toleranceSec: 300,
    logger,
    rate: { capacity: 1000, perSec: 1000 },
    service: {} as YijiInboundService,
    prefix: '/webhooks/yiji2',
    label: 'yiji2',
    secret: V2_SECRET,
    events: {
      format: 'yiji2',
      vendorKey: 'yiji2:2',
      seen: async (id: string) => {
        if (seen.has(id)) return true;
        seen.add(id);
        return false;
      },
      enqueue: enqueueOrder,
      enqueueCouponEvent: enqueueCoupon,
      enqueueCompensationEvent: enqueueCompensation,
    },
  });
  return app;
}

const signed = (body: unknown) => {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    method: 'POST' as const,
    url: '/webhooks/yiji2/events',
    headers: {
      'content-type': 'application/json',
      'x-yiji-timestamp': ts,
      'x-yiji-signature': `sha256=${signWebhook(V2_SECRET, ts, raw)}`,
    },
    payload: raw,
  };
};

let seq = 0;
const envelope = (name: SampleName): Rec => ({
  ...structuredClone(SAMPLES[name]),
  id: `sample-${name}-${++seq}`,
});
function reverseKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reverseKeys);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v as Rec)
        .reverse()
        .map(([k, x]) => [k, reverseKeys(x)]),
    );
  return v;
}
const jobs = () => enqueueCompensation.mock.calls.map((c) => (c as unknown[])[0] as Rec);

beforeEach(() => {
  seen.clear();
  enqueueOrder.mockClear();
  enqueueCoupon.mockClear();
  enqueueCompensation.mockClear();
  warn.mockClear();
});

describe('each V2 sample, signed, at /webhooks/yiji2/events', () => {
  it.each(NAMES)('%s: accepted and queued with its data unchanged', async (name) => {
    const e = envelope(name);
    const res = await build().inject(signed(e));
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true, accepted: 1, duplicates: 0, ignored: 0 });
    expect(jobs()).toEqual([
      {
        type: SAMPLES[name].type,
        eventId: e.id,
        vendorKey: 'yiji2:2',
        at: '2026-11-17T21:57:45.610701Z',
        data: SAMPLES[name].data,
      },
    ]);
    expect(enqueueOrder).not.toHaveBeenCalled();
    expect(enqueueCoupon).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('the whole run in one batch (11 events), keys reversed: all 11 queued in order', async () => {
    const body = { events: NAMES.map((n) => reverseKeys(envelope(n))) };
    const res = await build().inject(signed(body));
    expect(res.json()).toEqual({ ok: true, accepted: 11, duplicates: 0, ignored: 0 });
    expect(jobs().map((j) => [j.type, (j.data as Rec).case_id])).toEqual(
      NAMES.map((n) => [SAMPLES[n].type, SAMPLES[n].data.case_id]),
    );
    jobs().forEach((j, i) => expect(j.data).toEqual(SAMPLES[NAMES[i]!].data));
  });

  it('a decided without order_number is still queued (matched by case_id in the worker)', async () => {
    const e = envelope('decided_2_1_approved_wallet');
    delete (e.data as Rec).order_number;
    const res = await build().inject(signed(e));
    expect(res.json()).toMatchObject({ accepted: 1, ignored: 0 });
    expect(jobs()).toHaveLength(1);
  });
});

describe('a coupon case: coupon.granted and compensation.decided in either order', () => {
  /** A compensation grant (no pending_grant_id), ids of sample 2.2. */
  const couponGranted = () => ({
    id: `granted-${++seq}`,
    type: 'coupon.granted',
    occurred_at: '2026-11-17T21:57:45.610701Z',
    environment: 'dev',
    data: {
      coupon_id: 1,
      grant_id: 1,
      code: 'COMP-6',
      customer_id: 1,
      status: 'active',
      coupon_status: 'active',
      source: 'system',
      by: { kind: 'system' },
      at: '2026-11-17T21:57:45.610701Z',
    },
  });
  it.each(['granted first', 'decided first'])(
    '%s: the decision is queued, the grant is not handed to the pending-grants job',
    async (order) => {
      const events =
        order === 'granted first'
          ? [couponGranted(), envelope('decided_2_2_approved_coupon')]
          : [envelope('decided_2_2_approved_coupon'), couponGranted()];
      const res = await build().inject(signed({ events }));
      expect(res.statusCode).toBe(202);
      expect(enqueueCoupon).not.toHaveBeenCalled();
      expect(jobs()).toHaveLength(1);
      expect(jobs()[0]).toMatchObject({
        type: 'compensation.decided',
        data: { case_id: 6, grant_id: 1, coupon_id: 1 },
      });
    },
  );
});
