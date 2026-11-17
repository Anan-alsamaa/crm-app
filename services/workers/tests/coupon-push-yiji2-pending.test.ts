import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import {
  ConnectorRegistry,
  EnvVendorSettingsSource,
  StaticVendorDirectory,
  MockYiji2Transport,
  Yiji2Connector,
  asCouponPushConnector,
  couponEventFromYiji2,
  type Yiji2CouponEventJob,
} from '@yiji/shared-types';
import { processCouponPushJob, type CouponApprovalRow } from '../src/processors/coupon-push.js';
import { processYiji2CouponEvent } from '../src/processors/coupon-yiji2-events.js';

/**
 * YIJI V2 PENDING GRANTS (contract agreed with the v2 team and the owner,
 * 17 Nov 2026), through the REAL v1 coupon processor and the v2 mock:
 *
 *  - a number with no v2 account: the coupon is created on v2 WITH the phone,
 *    v2 holds a pending grant, the row records the coupon id + pending grant
 *    id and is watched (`awaiting_signup_at`), nothing is granted;
 *  - the CRM's own sweep never creates or assigns it a second time: before
 *    sign-up it only re-stamps the watch; after sign-up it finds v2's grant
 *    (wallet read) or gets v2's 200 `created: false` - the same grant;
 *  - `coupon.granted` completes the row (assigned, grant id = receipt);
 *  - `customer.created` re-checks the rows waiting on that phone.
 */
vi.mock('@directus/sdk', () => ({
  readItems: (collection: string, opts: unknown) => ({ collection, opts }),
  readItem: (collection: string, id: string, opts: unknown) => ({ collection, id, opts }),
  updateItem: (collection: string, id: string, payload: unknown) => ({ collection, id, payload }),
}));

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const NO_ACCOUNT = '0500000299';

const baseRow = (over: Record<string, unknown> = {}) =>
  ({
    id: 'ca-p1',
    status: 'approved',
    coupon_code: 'V2-PEND-1',
    coupon_value: '10.00000',
    coupon_percent: null,
    max_discount: '10.00000',
    usage_limit: '1',
    total_discount_limit: '10.00000',
    valid_from: '2026-11-17',
    valid_to: '2026-12-17',
    title: NO_ACCOUNT,
    issuing_side: 'Operations',
    delivery_type: 'All',
    coupon_type: 'Private',
    discount_category: 'Amount',
    brand_id: 'V2 Kitchen',
    restaurant_id: '9101',
    item_name: null,
    no_other_discounts: false,
    reason: 'late order',
    customer_phone: null,
    contact: { id: 'k9', name: null, phone: NO_ACCOUNT, external_customer_id: null },
    ticket: { order_id: null },
    order_id: null,
    yiji_coupon_user_id: null,
    yiji_push_error: null,
    ...over,
  }) as unknown as CouponApprovalRow & Record<string, unknown>;

type Filter = Record<string, Record<string, unknown>>;
const matches = (r: Record<string, unknown>, filter: Filter) =>
  Object.entries(filter).every(([k, cond]) =>
    Object.entries(cond).every(([op, val]) => {
      const v = r[k];
      if (op === '_eq') return v != null && String(v) === String(val);
      if (op === '_neq') return v !== val;
      if (op === '_in') return (val as unknown[]).includes(v);
      if (op === '_null') return v == null;
      if (op === '_nnull') return v != null;
      throw new Error(`fake: ${op}`);
    }),
  );

/** A Directus that holds rows; a field in `missing` is not applied (403s like Directus). */
function fakeDirectus(rows: Array<Record<string, unknown>>, missing: string[] = []) {
  const byId = new Map(rows.map((r) => [String(r.id), { ...r }]));
  const updates: Array<{ id: string; payload: Record<string, unknown> }> = [];
  const forbidden = (keys: string[]) => {
    const bad = keys.find((k) => missing.includes(k));
    if (bad) throw { errors: [{ message: `FORBIDDEN: ${bad}` }] };
  };
  const request = vi.fn(async (arg: Record<string, unknown>) => {
    if ('payload' in arg) {
      const payload = arg.payload as Record<string, unknown>;
      forbidden(Object.keys(payload));
      updates.push({ id: String(arg.id), payload });
      Object.assign(byId.get(String(arg.id))!, payload);
      return {};
    }
    const opts = (arg.opts ?? {}) as { fields?: unknown[]; filter?: Filter };
    forbidden((opts.fields ?? []).filter((f): f is string => typeof f === 'string'));
    if ('id' in arg) return { ...byId.get(String(arg.id)) };
    forbidden(Object.keys(opts.filter ?? {}));
    return [...byId.values()].filter((r) => matches(r, opts.filter ?? {})).map((r) => ({ ...r }));
  });
  return { request, updates, row: (id: string) => byId.get(id)! };
}

const registry = () =>
  new ConnectorRegistry({
    directory: new StaticVendorDirectory([
      { crmId: 'uuid-v2', platformVendorId: '2', platform: 'yiji2', status: 'active' },
    ]),
    settings: new EnvVendorSettingsSource(
      { platform: 'yiji', client: {} },
      { yiji2: { platform: 'yiji2', mock: true, tenantId: '2' } },
    ),
    legacyVendorKey: '2',
  });

let v2: Yiji2Connector;
let t: MockYiji2Transport;
const fetchSpy = vi.fn(() => {
  throw new Error('network');
});

beforeEach(async () => {
  vi.stubGlobal('fetch', fetchSpy);
  v2 = asCouponPushConnector(await registry().connectorFor('uuid-v2')) as Yiji2Connector;
  t = v2.transport as MockYiji2Transport;
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(fetchSpy).not.toHaveBeenCalled();
});

const push = (directus: { request: unknown }, opts: { wallet?: boolean } = {}) =>
  processCouponPushJob(
    { data: { couponApprovalId: 'ca-p1' } } as Job<{ couponApprovalId: string }>,
    {
      directus: directus as never,
      logger,
      platform: v2.platform,
      postCoupon: v2.adminPost ?? undefined,
      findCustomer: v2.findCustomerIdByPhone ?? undefined,
      ...(opts.wallet === false ? {} : { findUserCoupon: v2.findCustomerCoupon ?? undefined }),
      yijiTenantId: v2.settings.tenantId ?? '1',
    },
  );

const grantedJob = (events: MockYiji2Transport['events']) =>
  couponEventFromYiji2(events.find((e) => e.type === 'coupon.granted')!, 'yiji2:2')!;

describe('a v2 customer with no account: the coupon is created WITH the phone (pending grant)', () => {
  it('records the coupon and the pending grant, watches the number, grants nothing', async () => {
    const d = fakeDirectus([baseRow()]);
    expect(await push(d)).toBe('awaiting-signup');
    expect(t.coupons).toHaveLength(1);
    expect(t.coupons[0]!.body).toMatchObject({
      code: 'V2-PEND-1',
      category: 'private',
      phone: '+966500000299',
      country: 'SA',
    });
    expect(t.pendingGrants).toEqual([
      expect.objectContaining({ phone: '+966500000299', country: 'SA', grant_id: null }),
    ]);
    expect(t.grants).toHaveLength(0);
    expect(t.calls.map((c) => c.path)).toEqual(['/compensation-coupons']);
    const row = d.row('ca-p1');
    expect(row).toMatchObject({
      status: 'approved',
      yiji_coupon_user_id: null,
      yiji_coupon_id: t.coupons[0]!.coupon_id,
      yiji_pending_grant_id: t.pendingGrants[0]!.pending_grant_id,
      yiji_push_error: null,
    });
    expect(row.awaiting_signup_at).toEqual(expect.any(String));
  });

  it('the sweep before sign-up only re-stamps the watch: never a second coupon', async () => {
    const d = fakeDirectus([baseRow()]);
    await push(d);
    expect(await push(d)).toBe('awaiting-signup');
    expect(await push(d)).toBe('awaiting-signup');
    expect(t.coupons).toHaveLength(1);
    expect(t.pendingGrants).toHaveLength(1);
    expect(t.calls).toHaveLength(1);
  });

  it('coupon.granted completes the row: assigned, v2 grant id as the receipt; then nothing more', async () => {
    const d = fakeDirectus([baseRow()]);
    await push(d);
    const { events, grants } = t.simulateSignup(NO_ACCOUNT);
    expect(grants).toHaveLength(1);
    const job = grantedJob(events);
    expect(
      await processYiji2CouponEvent(job, {
        directus: d as never,
        logger,
        platformOf: async () => 'yiji2',
      }),
    ).toBe('assigned');
    expect(d.row('ca-p1')).toMatchObject({
      status: 'assigned',
      yiji_coupon_user_id: grants[0]!.grant_id,
      yiji_push_error: null,
    });
    /* the sweep and a replayed event change nothing, and call v2 for nothing */
    const calls = t.calls.length;
    expect(await push(d)).toBe('already-assigned');
    expect(await processYiji2CouponEvent(job, { directus: d as never, logger })).toBe(
      'already-assigned',
    );
    expect(t.calls).toHaveLength(calls);
    expect(t.grants).toHaveLength(1);
  });

  it('safety net: the sweep sees the account first and finds v2’s grant in the wallet - no POST', async () => {
    const d = fakeDirectus([baseRow()]);
    await push(d);
    const { events, grants } = t.simulateSignup(NO_ACCOUNT);
    expect(await push(d)).toBe('delivered');
    expect(d.row('ca-p1')).toMatchObject({
      status: 'assigned',
      yiji_coupon_user_id: grants[0]!.grant_id,
    });
    expect(t.calls.map((c) => c.path)).toEqual(['/compensation-coupons']);
    expect(t.grants).toHaveLength(1);
    /* the event that follows is a no-op */
    expect(
      await processYiji2CouponEvent(grantedJob(events), { directus: d as never, logger }),
    ).toBe('already-assigned');
  });

  it('safety net without the wallet read: AddUserCoupon gets 200 created:false - the same grant', async () => {
    const d = fakeDirectus([baseRow()]);
    await push(d, { wallet: false });
    const { grants } = t.simulateSignup(NO_ACCOUNT);
    expect(await push(d, { wallet: false })).toBe('delivered');
    expect(t.calls.map((c) => c.path)).toEqual(['/compensation-coupons', '/grants']);
    expect(t.grants).toHaveLength(1);
    expect(d.row('ca-p1')).toMatchObject({
      status: 'assigned',
      yiji_coupon_user_id: grants[0]!.grant_id,
      yiji_push_error: null,
    });
  });

  it('without the yiji_pending_grant_id column the coupon still holds, and the event finds it by coupon id', async () => {
    const d = fakeDirectus([baseRow()], ['yiji_pending_grant_id']);
    expect(await push(d)).toBe('awaiting-signup');
    expect(d.row('ca-p1').yiji_coupon_id).toBe(t.coupons[0]!.coupon_id);
    const { events, grants } = t.simulateSignup(NO_ACCOUNT);
    expect(
      await processYiji2CouponEvent(grantedJob(events), { directus: d as never, logger }),
    ).toBe('assigned');
    expect(d.row('ca-p1').yiji_coupon_user_id).toBe(grants[0]!.grant_id);
  });

  it('a General coupon is not created now (unchanged rule): watched, nothing on v2', async () => {
    const d = fakeDirectus([baseRow({ coupon_type: 'General' })]);
    expect(await push(d)).toBe('awaiting-signup');
    expect(t.coupons).toHaveLength(0);
    expect(t.calls).toHaveLength(0);
  });

  it('a number that HAS an account is granted at once, exactly as before', async () => {
    const d = fakeDirectus([
      baseRow({ contact: { id: 'k1', phone: '0500000201', external_customer_id: null } }),
    ]);
    expect(await push(d)).toBe('delivered');
    expect(t.pendingGrants).toHaveLength(0);
    expect(t.calls.map((c) => c.path)).toEqual(['/compensation-coupons', '/grants']);
  });
});

describe('the coupon.granted job', () => {
  const job = (over: Partial<Extract<Yiji2CouponEventJob, { type: 'coupon.granted' }>> = {}) =>
    ({
      type: 'coupon.granted',
      eventId: 'e-1',
      vendorKey: 'yiji2:2',
      at: '2026-11-17T10:00:00Z',
      pendingGrantId: '800001',
      grantId: '700009',
      ...over,
    }) as Yiji2CouponEventJob;

  it('falls back to code + phone when neither id is stored', async () => {
    const d = fakeDirectus([
      baseRow({ awaiting_signup_at: '2026-11-17T09:00:00Z' }),
      baseRow({ id: 'ca-other', contact: { phone: '0500000111' } }),
    ]);
    expect(
      await processYiji2CouponEvent(job({ code: 'V2-PEND-1', phone: '+966500000299' }), {
        directus: d as never,
        logger,
      }),
    ).toBe('assigned');
    expect(d.row('ca-p1').yiji_coupon_user_id).toBe('700009');
    expect(d.row('ca-other').yiji_coupon_user_id).toBeNull();
  });

  it('no match is settled (not-found); a non-v2 row or a different grant is never changed', async () => {
    const d = fakeDirectus([baseRow({ yiji_pending_grant_id: '800001' })]);
    expect(
      await processYiji2CouponEvent(job({ pendingGrantId: '899999' }), {
        directus: d as never,
        logger,
      }),
    ).toBe('not-found');
    expect(
      await processYiji2CouponEvent(job(), {
        directus: d as never,
        logger,
        platformOf: async () => 'yiji',
      }),
    ).toBe('not-v2');
    expect(d.updates).toHaveLength(0);
    const held = fakeDirectus([
      baseRow({ yiji_pending_grant_id: '800001', yiji_coupon_user_id: '700001' }),
    ]);
    expect(await processYiji2CouponEvent(job(), { directus: held as never, logger })).toBe(
      'conflict',
    );
    const gone = fakeDirectus([baseRow({ yiji_pending_grant_id: '800001', status: 'rejected' })]);
    expect(await processYiji2CouponEvent(job(), { directus: gone as never, logger })).toBe(
      'not-approved',
    );
    expect(held.updates).toHaveLength(0);
    expect(gone.updates).toHaveLength(0);
  });

  it('waits for a running push of the same coupon (lock held -> retried)', async () => {
    const d = fakeDirectus([baseRow({ yiji_pending_grant_id: '800001' })]);
    const lock = { acquire: vi.fn(async () => false), release: vi.fn(async () => undefined) };
    await expect(
      processYiji2CouponEvent(job(), { directus: d as never, logger, lock }),
    ).rejects.toThrow(/another change/);
    expect(d.updates).toHaveLength(0);
  });
});

describe('the customer.created job', () => {
  it('logs and re-checks only the rows waiting on a v2 pending grant for that phone', async () => {
    const d = fakeDirectus([
      baseRow({ awaiting_signup_at: '2026-11-17T09:00:00Z', yiji_pending_grant_id: '800001' }),
      /* same phone, but a v1 hold (no pending grant): not touched */
      baseRow({ id: 'ca-v1', awaiting_signup_at: '2026-11-17T09:00:00Z' }),
      /* another phone */
      baseRow({
        id: 'ca-x',
        awaiting_signup_at: '2026-11-17T09:00:00Z',
        yiji_pending_grant_id: '800002',
        contact: { phone: '0500000111' },
      }),
    ]);
    const add = vi.fn(async () => ({ id: 'j' }));
    expect(
      await processYiji2CouponEvent(
        {
          type: 'customer.created',
          eventId: 'c-1',
          vendorKey: 'yiji2:2',
          at: '2026-11-17T10:00:00Z',
          customerId: '2000000101',
          phone: '+966500000299',
          country: 'SA',
        },
        { directus: d as never, logger, couponsQueue: { add } as never },
      ),
    ).toBe('customer-noted');
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith('push', { couponApprovalId: 'ca-p1' }, expect.anything());
    expect(d.updates).toHaveLength(0);
  });
});
