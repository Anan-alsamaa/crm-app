import { describe, it, expect, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { YijiRefusedError, YijiUnavailableError, type CouponRemoveJob } from '@yiji/shared-types';
import { processCouponRemoveJob } from '../src/processors/coupon-remove.js';
import { processCouponPushJob } from '../src/processors/coupon-push.js';
import { createYijiCouponRemover, type YijiCouponRemover } from '../src/lib/yiji-coupon-remover.js';

/**
 * EMA-80 (owner, 2026-10-21): "Not Compensated" on a ticket takes its coupon
 * back. The record is KEPT and marked; a coupon in the customer's Yiji app is
 * removed there and VERIFIED gone from both lists; a coupon already USED is
 * never "removed" on paper. No test here talks to Yiji - every call is a mock.
 */

vi.mock('@directus/sdk', () => ({
  readItems: (collection: string, opts: unknown) => ({ op: 'readItems', collection, opts }),
  readItem: (collection: string, id: string, opts: unknown) => ({
    op: 'readItem',
    collection,
    id,
    opts,
  }),
  updateItem: (collection: string, id: string, payload: unknown) => ({
    op: 'updateItem',
    collection,
    id,
    payload,
  }),
}));

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

type Req = {
  op: string;
  collection: string;
  id?: string;
  opts?: { fields?: unknown[] };
  payload?: Record<string, unknown>;
};

const BASE = {
  id: 'ca-1',
  status: 'assigned',
  coupon_code: 'OPS-AB12CD34',
  title: '+966501234567',
  customer_phone: null,
  ticket: { id: 't1' },
  contact: { phone: '0501234567', external_customer_id: 'yiji-user-1' },
  yiji_coupon_user_id: '27507',
  removal_status: null,
};

/** A Directus fake: one coupon row, the ticket's other coupons, every write recorded. */
function fakeDirectus(
  row: Record<string, unknown> | null,
  siblings: Array<Record<string, unknown>> = [],
) {
  const state = { ...(row ?? {}) } as Record<string, unknown>;
  const writes: Array<{ collection: string; id: string; payload: Record<string, unknown> }> = [];
  const request = vi.fn(async (r: Req) => {
    if (r.op === 'readItem') return row ? { ...state } : null;
    if (r.op === 'readItems') {
      return [
        { id: state.id, status: state.status, removal_status: state.removal_status },
        ...siblings,
      ];
    }
    if (r.op === 'updateItem') {
      writes.push({ collection: r.collection, id: r.id!, payload: r.payload! });
      if (r.collection === 'coupon_approvals') Object.assign(state, r.payload);
      return {};
    }
    throw new Error(`unexpected ${r.op}`);
  });
  return { directus: { request } as never, writes, state };
}

function remover(over: Partial<YijiCouponRemover> = {}) {
  let held = ['27507', '99'];
  return {
    findCustomer: vi.fn(async () => 'yiji-user-1'),
    wallet: vi.fn(async () => ({ held: [...held], active: [...held] })),
    usedOnOrder: vi.fn(async () => null),
    removeGrant: vi.fn(async (g: string) => {
      held = held.filter((x) => x !== g);
    }),
    ...over,
  } satisfies YijiCouponRemover;
}

const job = (attemptsMade = 0, attempts = 5) =>
  ({
    data: { couponApprovalId: 'ca-1', removedBy: 'sup-1', reason: 'Customer took a refund' },
    attemptsMade,
    opts: { attempts },
  }) as unknown as Job<CouponRemoveJob>;

const ticketPatch = (writes: ReturnType<typeof fakeDirectus>['writes']) =>
  writes.filter((w) => w.collection === 'tickets').at(-1)?.payload;
const final = (state: Record<string, unknown>) => state.removal_status;

describe('a coupon in the customer’s Yiji app', () => {
  it('is removed by its GRANT id, verified gone from both lists, and the ticket follows', async () => {
    const { directus, writes, state } = fakeDirectus({ ...BASE });
    const y = remover();
    const out = await processCouponRemoveJob(job(), { directus, logger, remover: y });
    expect(out).toBe('removed');
    expect(y.removeGrant).toHaveBeenCalledWith('27507');
    expect(y.wallet).toHaveBeenCalledTimes(2); // before AND after - the verify
    expect(final(state)).toBe('removed');
    expect(state.removed_at).toBeTruthy();
    expect(state.removed_by).toBe('sup-1');
    expect(state.removed_reason).toBe('Customer took a refund');
    expect(String(state.removal_detail)).toMatch(/verified/);
    // The record is KEPT: its decision is untouched.
    expect(state.status).toBe('assigned');
    expect(ticketPatch(writes)).toEqual({
      compensation: 'Not Compensated',
      coupon_code: null,
      coupon_value: null,
      coupon_percent: null,
    });
  });

  it('marks it pending BEFORE touching Yiji, so a delivery in flight stands down', async () => {
    const { directus, writes } = fakeDirectus({ ...BASE });
    await processCouponRemoveJob(job(), { directus, logger, remover: remover() });
    expect(writes[0]!.payload).toMatchObject({ removal_status: 'pending', removed_by: 'sup-1' });
  });

  it('is NOT reported removed when it is still in the customer’s app afterwards', async () => {
    const { directus, writes, state } = fakeDirectus({ ...BASE });
    const y = remover({ removeGrant: vi.fn(async () => undefined) }); // soft delete that did nothing
    const out = await processCouponRemoveJob(job(), { directus, logger, remover: y });
    expect(out).toBe('failed');
    expect(final(state)).toBe('failed');
    expect(state.removed_at).toBeNull();
    expect(String(state.removal_detail)).toMatch(/still in the customer/);
    expect(ticketPatch(writes)).toEqual({ compensation: 'Compensated' });
  });

  it('records a Yiji refusal (403: the CRM account may not remove) without retrying', async () => {
    const { directus, state } = fakeDirectus({ ...BASE });
    const y = remover({
      removeGrant: vi.fn(async () => {
        throw new YijiRefusedError('refused', 403, { status: 403 });
      }),
    });
    const out = await processCouponRemoveJob(job(), { directus, logger, remover: y });
    expect(out).toBe('failed');
    expect(String(state.removal_detail)).toMatch(/may not remove/);
  });

  it('retries when Yiji cannot be reached, and says so on the last attempt', async () => {
    const down = () =>
      remover({
        wallet: vi.fn(async () => {
          throw new YijiUnavailableError('timed out');
        }),
      });
    const a = fakeDirectus({ ...BASE });
    await expect(
      processCouponRemoveJob(job(0, 5), { directus: a.directus, logger, remover: down() }),
    ).rejects.toThrow(/timed out/);
    const b = fakeDirectus({ ...BASE });
    const out = await processCouponRemoveJob(job(4, 5), {
      directus: b.directus,
      logger,
      remover: down(),
    });
    expect(out).toBe('failed');
    expect(String(b.state.removal_detail)).toMatch(/could not be reached/);
  });

  it('fails visibly when removal on Yiji is not configured', async () => {
    const { directus, state } = fakeDirectus({ ...BASE });
    const out = await processCouponRemoveJob(job(), { directus, logger, remover: null });
    expect(out).toBe('failed');
    expect(String(state.removal_detail)).toMatch(/not set up/);
  });

  it('looks a walk-in up by phone (no Yiji id on the contact)', async () => {
    const { directus } = fakeDirectus({
      ...BASE,
      contact: { phone: '0501234567', external_customer_id: null },
    });
    const y = remover();
    await processCouponRemoveJob(job(), { directus, logger, remover: y });
    expect(y.findCustomer).toHaveBeenCalledWith('0501234567');
  });
});

describe('a coupon the customer ALREADY USED', () => {
  it('is kept - never removed on paper - and the ticket stays Compensated', async () => {
    const { directus, writes, state } = fakeDirectus({ ...BASE });
    const y = remover({ usedOnOrder: vi.fn(async () => '1332339') });
    const out = await processCouponRemoveJob(job(), { directus, logger, remover: y });
    expect(out).toBe('used');
    expect(y.removeGrant).not.toHaveBeenCalled();
    expect(final(state)).toBe('used');
    expect(state.removed_at).toBeNull();
    expect(String(state.removal_detail)).toMatch(/order 1332339/);
    expect(ticketPatch(writes)).toEqual({ compensation: 'Compensated' });
  });
});

describe('a coupon that never reached the Yiji app', () => {
  it('PENDING: removed in the CRM only, and closed so nobody approves it later', async () => {
    const { directus, writes, state } = fakeDirectus({
      ...BASE,
      status: 'pending',
      yiji_coupon_user_id: null,
    });
    const y = remover();
    const out = await processCouponRemoveJob(job(), { directus, logger, remover: y });
    expect(out).toBe('not-on-yiji');
    expect(y.wallet).not.toHaveBeenCalled();
    expect(y.removeGrant).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      removal_status: 'not_on_yiji',
      status: 'rejected',
      decided_by: 'sup-1',
      decision_note: 'Removed from the ticket: Customer took a refund',
    });
    expect(ticketPatch(writes)?.compensation).toBe('Not Compensated');
  });

  it('APPROVED but undelivered: parked so the delivery sweep never sends it', async () => {
    const { directus, state } = fakeDirectus({
      ...BASE,
      status: 'approved',
      yiji_coupon_user_id: null,
    });
    const out = await processCouponRemoveJob(job(), { directus, logger, remover: null });
    expect(out).toBe('not-on-yiji');
    expect(state.status).toBe('approved'); // the decision stays on record
    expect(String(state.yiji_push_error)).toMatch(/Removed from the ticket/);
  });

  it('the push refuses a removed coupon however it was queued', async () => {
    const directus = {
      request: vi.fn(async (r: Req) => {
        const fields = (r.opts?.fields ?? []) as unknown[];
        if (fields.length === 1 && fields[0] === 'yiji_coupon_id') return { yiji_coupon_id: null };
        if (fields.length === 1 && fields[0] === 'removal_status')
          return { removal_status: 'not_on_yiji' };
        return {
          ...BASE,
          status: 'approved',
          yiji_coupon_user_id: null,
          ticket: { order_id: null },
        };
      }),
    };
    const postCoupon = vi.fn();
    const out = await processCouponPushJob({ data: { couponApprovalId: 'ca-1' } } as never, {
      directus: directus as never,
      logger,
      postCoupon,
      yijiTenantId: '1',
    });
    expect(out).toBe('removed');
    expect(postCoupon).not.toHaveBeenCalled();
  });
});

describe('the ticket follows ALL its coupons', () => {
  it('stays Compensated while another coupon still counts', async () => {
    const { directus, writes } = fakeDirectus({ ...BASE }, [
      { id: 'ca-2', status: 'approved', removal_status: null },
    ]);
    await processCouponRemoveJob(job(), { directus, logger, remover: remover() });
    expect(ticketPatch(writes)).toEqual({ compensation: 'Compensated' });
  });

  it('does nothing twice: an already-removed coupon is left alone', async () => {
    const { directus, writes } = fakeDirectus({ ...BASE, removal_status: 'removed' });
    const y = remover();
    const out = await processCouponRemoveJob(job(), { directus, logger, remover: y });
    expect(out).toBe('already-removed');
    expect(y.removeGrant).not.toHaveBeenCalled();
    expect(writes.filter((w) => w.collection === 'coupon_approvals')).toEqual([]);
  });
});

describe('createYijiCouponRemover — the four Yiji calls', () => {
  function fakeFetch(handler: (url: string, init: RequestInit) => Response) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return handler(url, init);
    });
    return { f: f as unknown as typeof fetch, calls };
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('is null when nothing can authenticate', () => {
    expect(createYijiCouponRemover({ adminApiUrl: 'https://admin.x' })).toBeNull();
    expect(createYijiCouponRemover({ removeToken: 't' })).toBeNull();
  });

  it('DELETEs RemoveUserCoupon/{grantId} with the configured token', async () => {
    const { f, calls } = fakeFetch(() => json({ result: 1 }));
    const r = createYijiCouponRemover({
      adminApiUrl: 'https://admin.x/',
      removeToken: 'Bearer OWNER',
      tenantId: '1',
      fetchImpl: f,
    })!;
    await r.removeGrant('27507');
    expect(calls[0]!.url).toBe('https://admin.x/api/CouponUser/RemoveUserCoupon/27507');
    expect(calls[0]!.init.method).toBe('DELETE');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer OWNER');
  });

  it('a 403 (or a 200 with result != 1) is a refusal, not an outage', async () => {
    const r403 = createYijiCouponRemover({
      adminApiUrl: 'https://admin.x',
      removeToken: 'T',
      fetchImpl: fakeFetch(() => new Response('', { status: 403 })).f,
    })!;
    await expect(r403.removeGrant('1')).rejects.toMatchObject({
      name: 'YijiRefusedError',
      status: 403,
    });
    const r2 = createYijiCouponRemover({
      adminApiUrl: 'https://admin.x',
      removeToken: 'T',
      fetchImpl: fakeFetch(() => json({ result: 2, exceptionMessage: 'nope' })).f,
    })!;
    await expect(r2.removeGrant('1')).rejects.toMatchObject({ name: 'YijiRefusedError' });
  });

  it('reads BOTH coupon lists for the verify, and finds a spent grant on the orders', async () => {
    const { f, calls } = fakeFetch((url) => {
      if (url.includes('GetCouponByUser')) return json([{ id: 27507 }, { id: 5 }]);
      if (url.includes('GetActiveCouponByUser')) return json([{ id: 5 }]);
      if (url.includes('GetOrderByUser'))
        return json([{ id: 9, orderNumber: 1332339, couponId: 27507 }]);
      return json([]);
    });
    const r = createYijiCouponRemover({
      adminApiUrl: 'https://admin.x',
      apiUrl: 'https://order.x',
      removeToken: 'T',
      fetchImpl: f,
    })!;
    expect(await r.wallet('u1')).toEqual({ held: ['27507', '5'], active: ['5'] });
    expect(await r.usedOnOrder('u1', '27507')).toBe('1332339');
    expect(await r.usedOnOrder('u1', '5')).toBeNull();
    expect(calls.map((c) => c.url)).toContain('https://order.x/api/Order/GetOrderByUser/u1');
  });

  it('finds the customer by EXACT +966 number only', async () => {
    const { f } = fakeFetch(() =>
      json([
        { id: 'wrong', phoneNumber: '+9616501234567' },
        { id: 'right', phoneNumber: '+966501234567' },
      ]),
    );
    const r = createYijiCouponRemover({
      adminApiUrl: 'https://admin.x',
      removeToken: 'T',
      fetchImpl: f,
    })!;
    expect(await r.findCustomer('0501234567')).toBe('right');
  });

  it('signs in with the service credential when no token is set', async () => {
    const { f, calls } = fakeFetch((url) =>
      url.endsWith('/api/Account/login') ? json({ token: 'SVC' }) : json({ result: 1 }),
    );
    const r = createYijiCouponRemover({
      adminApiUrl: 'https://admin.x',
      adminEmail: 'crm@x',
      adminPassword: 'p',
      fetchImpl: f,
    })!;
    await r.removeGrant('7');
    expect((calls[1]!.init.headers as Record<string, string>).authorization).toBe('Bearer SVC');
  });
});
