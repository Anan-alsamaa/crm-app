import { describe, it, expect, vi, beforeEach } from 'vitest';

/*
 * The idempotent, retried coupon create (owner, 2026-10-25). A fake Directus
 * executes the SDK's command thunks, so these see the real paths and bodies.
 */

const fake = vi.hoisted(() => {
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  const rows = new Map<string, Record<string, unknown>>();
  /** Scripted answers to the next coupon POSTs, in order; empty = succeed. */
  const script: Array<'network' | 'lost' | 502 | 400 | 403 | 'dupId'> = [];
  const sdkError = (status: number, code: string, message: string, field?: string) => ({
    errors: [{ message, extensions: { code, ...(field ? { field } : {}) } }],
    response: { status },
  });
  const request = async (cmd: () => { method?: string; path: string; body?: string }) => {
    const c = cmd();
    const method = c.method ?? 'GET';
    const body = c.body ? (JSON.parse(c.body) as Record<string, unknown>) : undefined;
    calls.push({ method, path: c.path, body });
    if (c.path === '/items/coupon_approvals' && method === 'GET') return [...rows.values()];
    if (c.path === '/items/coupon_approvals' && method === 'POST') {
      const next = script.shift();
      const row = body!;
      if (next === 'network') throw new TypeError('Failed to fetch');
      if (next === 'lost') {
        rows.set(String(row.id), row); // written, but the answer never came back
        throw { errors: '<html><body>502 Bad Gateway</body></html>', response: { status: 502 } };
      }
      if (next === 502)
        throw { errors: '<html><body>502 Bad Gateway</body></html>', response: { status: 502 } };
      if (next === 400)
        throw sdkError(400, 'INVALID_PAYLOAD', 'Validation failed for field "usage_limit".');
      if (next === 403)
        throw sdkError(403, 'FORBIDDEN', "You don't have permission to access this.");
      if (next === 'dupId') {
        rows.set(String(row.id), row);
        throw sdkError(400, 'RECORD_NOT_UNIQUE', 'Value for field "id" has to be unique.', 'id');
      }
      rows.set(String(row.id), row);
      return row;
    }
    if (method === 'GET' && c.path.startsWith('/items/tickets/')) return { vendor: 'vendor-yiji' };
    if (c.path === '/items/ticket_events') return body;
    return method === 'GET' ? [] : {};
  };
  return { calls, rows, script, request };
});
vi.mock('../src/lib/directus.js', () => ({
  directus: { request: fake.request },
  isForbidden: () => false,
  assetUrl: (id: string) => id,
  DIRECTUS_URL: 'http://directus.test',
}));

import {
  CouponRequestError,
  classifyCouponError,
  createCouponRequestIdempotent,
  newCouponRequestId,
  retryTransient,
} from '../src/features/coupons/coupon-request-send.js';
import { sendCouponRequest, type CreateCouponRequestInput } from '../src/features/coupons/api.js';
import { resetRecordVendorCache } from '../src/lib/record-vendor.js';

const client = { request: fake.request as never };
const posts = () =>
  fake.calls.filter((c) => c.method === 'POST' && c.path === '/items/coupon_approvals');
const events = () => fake.calls.filter((c) => c.path === '/items/ticket_events');

const input: CreateCouponRequestInput = {
  ticket: 'tk1',
  contact: 'contact-1',
  requested_by: 'agent-1',
  coupon_code: 'WC7K9QXR',
  coupon_value: 25,
  coupon_percent: null,
  compensation: 'Compensated',
  reason: 'Wrong item',
};

/** The rejection, typed; a resolution fails the test. */
const failure = (p: Promise<unknown>): Promise<CouponRequestError> =>
  p.then(
    () => {
      throw new Error('expected the request to fail');
    },
    (e: unknown) => e as CouponRequestError,
  );

let sleep: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fake.calls.length = 0;
  fake.rows.clear();
  fake.script.length = 0;
  resetRecordVendorCache();
  sleep = vi.fn(async () => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('createCouponRequestIdempotent', () => {
  it('sends the client-made id with the row', async () => {
    const id = newCouponRequestId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await createCouponRequestIdempotent(client, id, { coupon_code: 'A' }, { sleep });
    expect(posts()[0]!.body!.id).toBe(id);
    expect(fake.rows.size).toBe(1);
  });

  it('retries a network failure with the SAME id, with the short back-off', async () => {
    fake.script.push('network', 502);
    await createCouponRequestIdempotent(client, 'id-1', { coupon_code: 'A' }, { sleep });
    expect(posts().map((p) => p.body!.id)).toEqual(['id-1', 'id-1', 'id-1']);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([500, 1500]);
    expect(fake.rows.size).toBe(1);
  });

  it('never creates twice: a write whose answer was lost is found, not repeated', async () => {
    fake.script.push('lost');
    const row = await createCouponRequestIdempotent(
      client,
      'id-2',
      { coupon_code: 'A' },
      { sleep },
    );
    expect(row).toEqual({ id: 'id-2' });
    expect(posts()).toHaveLength(1);
    expect(fake.rows.size).toBe(1);
  });

  it('treats "id already exists" as the earlier attempt having landed', async () => {
    fake.script.push('dupId');
    const row = await createCouponRequestIdempotent(
      client,
      'id-3',
      { coupon_code: 'A' },
      { sleep },
    );
    expect(row).toEqual({ id: 'id-3' });
    expect(posts()).toHaveLength(1);
  });

  it('does NOT retry a validation refusal, and says why', async () => {
    fake.script.push(400);
    const err = await failure(createCouponRequestIdempotent(client, 'id-4', {}, { sleep }));
    expect(err).toBeInstanceOf(CouponRequestError);
    expect(err.kind).toBe('invalid');
    expect(err.status).toBe(400);
    expect(err.attempts).toBe(1);
    expect(err.message).toContain('usage_limit');
    expect(posts()).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does NOT retry a permission refusal', async () => {
    fake.script.push(403);
    const err = await failure(createCouponRequestIdempotent(client, 'id-5', {}, { sleep }));
    expect(err.kind).toBe('permission');
    expect(posts()).toHaveLength(1);
  });

  it('gives up after three transient failures, naming the last one', async () => {
    fake.script.push('network', 'network', 'network');
    const err = await failure(createCouponRequestIdempotent(client, 'id-6', {}, { sleep }));
    expect(err.kind).toBe('network');
    expect(err.attempts).toBe(3);
    expect(err.requestId).toBe('id-6');
    expect(posts()).toHaveLength(3);
  });

  it('refuses a payload that cannot be serialised before any request', async () => {
    const err = await failure(
      createCouponRequestIdempotent(client, 'id-7', { n: BigInt(1) }, { sleep }),
    );
    expect(err.kind).toBe('prepare');
    expect(fake.calls).toHaveLength(0);
  });

  it('strips an error page down to plain words', () => {
    const c = classifyCouponError({
      errors: '<html><body><h1>503 Service Temporarily Unavailable</h1></body></html>',
      response: { status: 503 },
    });
    expect(c).toEqual({
      kind: 'server',
      status: 503,
      detail: '503 Service Temporarily Unavailable',
    });
  });
});

describe('retryTransient', () => {
  it('retries a 5xx but not a 4xx', async () => {
    const flaky = vi
      .fn()
      .mockRejectedValueOnce({ errors: [], response: { status: 503 } })
      .mockResolvedValue('ok');
    await expect(retryTransient(flaky, { sleep })).resolves.toBe('ok');
    const refused = vi.fn().mockRejectedValue({ errors: [], response: { status: 403 } });
    await expect(retryTransient(refused, { sleep })).rejects.toBeTruthy();
    expect(refused).toHaveBeenCalledTimes(1);
  });
});

describe('sendCouponRequest (the hook body): traceability', () => {
  it('writes the failure to the ticket history and the console, then a success line on retry', async () => {
    fake.script.push('network', 'network', 'network');
    const first = { ...input, id: 'req-1' };
    const err = await failure(sendCouponRequest(first, { sleep }));
    expect(err).toBeInstanceOf(CouponRequestError);
    expect(events()).toHaveLength(1);
    expect(events()[0]!.body).toMatchObject({
      ticket: 'tk1',
      event_type: 'commented',
      actor: 'agent-1',
      payload: {
        text: expect.stringMatching(/^Coupon request failed: no connection to the server/),
        coupon_request: { id: 'req-1', outcome: 'failed', kind: 'network', attempts: 3 },
      },
    });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('[coupon-request] NOT sent'),
      expect.anything(),
    );

    // The dialog's Retry: same input, same id - and it works this time.
    await sendCouponRequest(first, { sleep });
    expect(events()).toHaveLength(2);
    expect(events()[1]!.body).toMatchObject({
      payload: { text: 'Coupon request sent on retry.', coupon_request: { id: 'req-1' } },
    });
    expect(fake.rows.size).toBe(1);
  });

  it('writes no history for a request that simply works', async () => {
    await sendCouponRequest({ ...input, id: 'req-2' }, { sleep });
    expect(events()).toHaveLength(0);
    expect(posts()[0]!.body).toMatchObject({ id: 'req-2', vendor: 'vendor-yiji', ticket: 'tk1' });
  });

  it('makes an id when the caller gives none', async () => {
    await sendCouponRequest(input, { sleep });
    expect(typeof posts()[0]!.body!.id).toBe('string');
  });
});
