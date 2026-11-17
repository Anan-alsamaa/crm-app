import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MockYiji2Transport,
  Yiji2Connector,
  Yiji2RefusedError,
  couponEventFromYiji2,
  translateV1AdminCall,
  v2PushData,
  yiji2E164,
  YIJI2_COUPON_EVENT_JOB,
  Yiji2CouponEventJob,
} from '../src/index.js';

/**
 * YIJI V2 CONTRACT OF 17 NOV 2026 (agreed with the v2 team and the owner):
 *  1. `POST /compensation-coupons` for a phone with NO account -> coupon +
 *     PENDING grant (`grant_id: null`, `pending_grant_id`, `waiting_for_signup`);
 *  2. at sign-up v2 assigns every pending grant for the phone itself and sends
 *     `coupon.granted` (+ `customer.created`);
 *  3. `POST /grants` for a coupon already assigned that way answers 200
 *     `created: false` with the existing grant;
 *  4. push `data.screen` coupon (grant_id) | order (order_number) | wallet;
 *     `topic` / `action` refused.
 */
const fetchSpy = vi.fn(() => {
  throw new Error('network');
});
beforeEach(() => vi.stubGlobal('fetch', fetchSpy));
afterEach(() => {
  vi.unstubAllGlobals();
  expect(fetchSpy).not.toHaveBeenCalled();
});

/** v1's withheld `AddCoupon` body, as the workers send it, plus the phone. */
const addCoupon = (code: string, phone?: string) => ({
  code,
  name: '0500000299',
  type: 1,
  discount: 10,
  reachLimit: 10,
  limitForUser: 1,
  activationDate: '2026-11-17',
  expirationDate: '2026-12-17',
  ...(phone ? { customerPhone: phone } : {}),
});
const ADD = '/api/Coupon/AddCoupon';
const ADD_USER = '/api/CouponUser/AddUserCoupon';
const SAR = { currency: 'SAR' };

describe('yiji2E164: v2 matches pending grants by the E.164 number', () => {
  it('spells Saudi and Bahraini numbers as v2 does, whatever the CRM stored', () => {
    expect(yiji2E164('0500000299')).toBe('+966500000299');
    expect(yiji2E164('500000299')).toBe('+966500000299');
    expect(yiji2E164('+966 50 000 0299')).toBe('+966500000299');
    expect(yiji2E164('00966500000299')).toBe('+966500000299');
    expect(yiji2E164('966500000299')).toBe('+966500000299');
    expect(yiji2E164('+97336000299')).toBe('+97336000299');
    expect(yiji2E164('36000299', 'BH')).toBe('+97336000299');
    expect(yiji2E164(undefined)).toBeUndefined();
    /* unreadable: sent as typed, v2 answers 400 rather than a guess */
    expect(yiji2E164('12')).toBe('12');
  });
});

describe('(1) a coupon for a phone with no v2 account: a pending grant', () => {
  it('AddCoupon with the phone -> pending grant; v1 answer carries the coupon id and PendingGrantId', async () => {
    const t = new MockYiji2Transport();
    const a = await translateV1AdminCall(t, ADD, addCoupon('P-1', '0500000299'), {}, SAR);
    expect(a.result).toBe(1);
    const couponId = t.coupons[0]!.coupon_id;
    expect(a.exceptionMessage).toBe(couponId);
    expect(a.extendedProperties).toEqual({
      PendingGrantId: t.pendingGrants[0]!.pending_grant_id,
      State: 'waiting_for_signup',
    });
    expect(t.calls[0]!.body).toMatchObject({ phone: '+966500000299', country: 'SA' });
    expect(t.pendingGrants[0]).toMatchObject({
      coupon_id: couponId,
      code: 'P-1',
      phone: '+966500000299',
      country: 'SA',
      grant_id: null,
    });
    expect(t.grants).toHaveLength(0);
  });

  it('a phone that HAS an account is granted in the same call (CouponUserId)', async () => {
    const t = new MockYiji2Transport();
    const a = await translateV1AdminCall(t, ADD, addCoupon('P-2', '0500000201'), {}, SAR);
    expect(a.extendedProperties).toEqual({ CouponUserId: t.grants[0]!.grant_id, State: 'active' });
    expect(t.pendingGrants).toHaveLength(0);
  });

  it('without a phone AddCoupon is unchanged: a coupon, no grant, no pending grant', async () => {
    const t = new MockYiji2Transport();
    const a = await translateV1AdminCall(t, ADD, addCoupon('P-3'), {}, SAR);
    expect(a).toEqual({
      result: 1,
      exceptionMessage: t.coupons[0]!.coupon_id,
      transactionStatus: 1,
    });
    expect(t.calls[0]!.body).not.toHaveProperty('phone');
    expect(t.pendingGrants).toHaveLength(0);
  });

  it('the mock refuses a phone that is not E.164 (400 VALIDATION_FAILED, field phone)', async () => {
    const t = new MockYiji2Transport();
    await expect(
      t.request('POST', '/compensation-coupons', {
        body: {
          code: 'P-4',
          type: 'amount',
          value: { amount_minor: 1000, currency: 'SAR' },
          total_discount_limit: { amount_minor: 1000, currency: 'SAR' },
          country: 'SA',
          phone: '0500000299',
        },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', field: 'phone' });
  });

  it('a retried AddCoupon (same idempotency key) is the same coupon and the same pending grant', async () => {
    const t = new MockYiji2Transport();
    const h = { 'idempotency-key': 'unassigned:P-5' };
    const a = await translateV1AdminCall(t, ADD, addCoupon('P-5', '0500000299'), h, SAR);
    const b = await translateV1AdminCall(t, ADD, addCoupon('P-5', '0500000299'), h, SAR);
    expect(b).toEqual(a);
    expect(t.coupons).toHaveLength(1);
    expect(t.pendingGrants).toHaveLength(1);
  });
});

describe('(2) sign-up: v2 assigns the pending grants itself and tells the CRM', () => {
  it('simulateSignup creates the account, assigns every pending grant for the phone, emits the events', async () => {
    const t = new MockYiji2Transport();
    await translateV1AdminCall(t, ADD, addCoupon('S-1', '0500000299'), {}, SAR);
    await translateV1AdminCall(t, ADD, addCoupon('S-2', '+966500000299'), {}, SAR);
    await translateV1AdminCall(t, ADD, addCoupon('S-3', '0500000288'), {}, SAR);
    const r = t.simulateSignup('0500000299');
    expect(r.grants).toHaveLength(2);
    expect(t.pendingGrants.filter((p) => p.grant_id)).toHaveLength(2);
    expect(t.pendingGrants.find((p) => p.code === 'S-3')!.grant_id).toBeNull();
    expect(r.events.map((e) => e.type)).toEqual([
      'coupon.granted',
      'coupon.granted',
      'customer.created',
    ]);
    expect(r.events[0]!.data).toMatchObject({
      pending_grant_id: Number(r.grants[0]!.pending_grant_id),
      grant_id: Number(r.grants[0]!.grant_id),
      phone: '+966500000299',
    });
    expect(r.events[2]!.data).toMatchObject({
      customer_id: Number(r.customer_id),
      phone: '+966500000299',
      country: 'SA',
    });
    /* the account is real now: lookup, wallet */
    const c = new Yiji2Connector(
      { crmId: 'v2', platformVendorId: '2', platform: 'yiji2', status: 'active' },
      { platform: 'yiji2', mock: true },
      { transport: t },
    );
    expect(await c.findCustomerIdByPhone!('0500000299')).toBe(r.customer_id);
    expect(await c.findCustomerCoupon!(r.customer_id, 'S-1')).toMatchObject({
      couponUserId: r.grants[0]!.grant_id,
    });
    expect(() => t.simulateSignup('0500000299')).toThrow(/already has an account/);
  });

  it('a pending grant is for its country only: a BH sign-up does not take an SA grant', async () => {
    const t = new MockYiji2Transport();
    await translateV1AdminCall(t, ADD, addCoupon('S-4', '+97336000299'), {}, SAR);
    /* the SA vendor's coupon names the phone with SA as its country */
    const r = t.simulateSignup('+97336000299', { country: 'BH' });
    expect(r.grants).toHaveLength(0);
  });

  it('the events map to the workers job; one without pending_grant_id is not ours', async () => {
    const t = new MockYiji2Transport();
    await translateV1AdminCall(t, ADD, addCoupon('S-5', '0500000299'), {}, SAR);
    const { events, grants } = t.simulateSignup('0500000299');
    const granted = couponEventFromYiji2(events[0]!, 'yiji2:2');
    expect(granted).toEqual({
      type: 'coupon.granted',
      eventId: events[0]!.id,
      vendorKey: 'yiji2:2',
      at: events[0]!.occurred_at,
      pendingGrantId: grants[0]!.pending_grant_id,
      grantId: grants[0]!.grant_id,
      couponId: t.coupons[0]!.coupon_id,
      code: 'S-5',
      customerId: expect.any(String),
      phone: '+966500000299',
    });
    expect(Yiji2CouponEventJob.safeParse(granted).success).toBe(true);
    expect(couponEventFromYiji2(events[1]!, 'yiji2:2')).toMatchObject({
      type: 'customer.created',
      phone: '+966500000299',
      country: 'SA',
    });
    const malformed = vi.fn();
    const base = { id: 'x', occurred_at: '2026-11-17T10:00:00Z' };
    expect(
      couponEventFromYiji2({ ...base, type: 'coupon.granted', data: { grant_id: 1 } }, 'yiji2:2', {
        malformed,
      }),
    ).toBeNull();
    expect(malformed).not.toHaveBeenCalled();
    expect(
      couponEventFromYiji2(
        { ...base, type: 'coupon.granted', data: { pending_grant_id: 1 } },
        'yiji2:2',
        { malformed },
      ),
    ).toBeNull();
    expect(
      couponEventFromYiji2({ ...base, type: 'customer.created', data: { phone: '+9665' } }, 'k', {
        malformed,
      }),
    ).toBeNull();
    expect(malformed).toHaveBeenCalledTimes(2);
    expect(couponEventFromYiji2({ ...base, type: 'order.late', data: {} }, 'yiji2:2')).toBeNull();
    expect(YIJI2_COUPON_EVENT_JOB).toBe('yiji2-event');
  });
});

describe('(3) POST /grants of a coupon v2 already assigned at sign-up: 200 created:false', () => {
  it('AddUserCoupon answers the EXISTING grant as success - never a second grant', async () => {
    const t = new MockYiji2Transport();
    await translateV1AdminCall(t, ADD, addCoupon('G-1', '0500000299'), {}, SAR);
    const { customer_id, grants } = t.simulateSignup('0500000299');
    const a = await translateV1AdminCall(
      t,
      ADD_USER,
      { couponId: Number(t.coupons[0]!.coupon_id), userId: customer_id },
      {},
      SAR,
    );
    expect(a).toEqual({
      result: 1,
      extendedProperties: { CouponUserId: grants[0]!.grant_id, Created: false },
    });
    expect(t.grants).toHaveLength(1);
  });

  it('a fresh grant says created:true; a second ordinary grant is still refused (409)', async () => {
    const t = new MockYiji2Transport();
    await translateV1AdminCall(t, ADD, addCoupon('G-2'), {}, SAR);
    const body = { couponId: Number(t.coupons[0]!.coupon_id), userId: '2000000001' };
    const a = await translateV1AdminCall(t, ADD_USER, body, {}, SAR);
    expect(a).toEqual({ result: 1, extendedProperties: { CouponUserId: t.grants[0]!.grant_id } });
    expect(
      await t.request('GET', '/grants', { query: { customer_id: '2000000001' } }),
    ).toBeTruthy();
    await expect(translateV1AdminCall(t, ADD_USER, body, {}, SAR)).rejects.toBeInstanceOf(
      Yiji2RefusedError,
    );
  });
});

describe('(4) push data keys: screen coupon | order | wallet; never topic/action', () => {
  it('a coupon-grant notification opens the coupon: { screen: coupon, grant_id }', () => {
    expect(v2PushData({ couponUserId: 700005, data: { prop1: 'crm.openchat' } })).toEqual({
      prop1: 'crm.openchat',
      screen: 'coupon',
      grant_id: '700005',
    });
    expect(v2PushData({ data: { grant_id: '700006' } })).toEqual({
      screen: 'coupon',
      grant_id: '700006',
    });
  });

  it('anything else carries NO screen keys; stray ones are dropped; topic/action never sent', () => {
    expect(
      v2PushData({
        action: 'crm.openchat',
        data: { topic: '7', screen: 'order', order_number: '2611000000001', conversationId: 'c1' },
      }),
    ).toEqual({ prop1: 'crm.openchat', conversationId: 'c1' });
  });

  it('SendCrmNotification about a grant reaches v2 with the coupon screen; the mock accepts it', async () => {
    const t = new MockYiji2Transport();
    const a = await translateV1AdminCall(
      t,
      '/api/NotificationData/SendCrmNotification',
      {
        userId: '2000000001',
        title: 'Coupon',
        body: 'Your coupon is ready',
        couponUserId: '700005',
      },
      {},
      SAR,
    );
    expect(a.result).toBe(1);
    expect(t.pushes[0]!.body).toEqual({
      title: 'Coupon',
      body: 'Your coupon is ready',
      data: { screen: 'coupon', grant_id: '700005' },
    });
  });

  it('the mock enforces the key rules like v2', async () => {
    const t = new MockYiji2Transport();
    const send = (data: Record<string, unknown>) =>
      t.request('POST', '/customers/2000000001/push', { body: { title: 'T', body: 'b', data } });
    await expect(send({ screen: 'coupon', grant_id: '1' })).resolves.toMatchObject({
      result: 'delivered',
    });
    await expect(send({ screen: 'order', order_number: '2611000000001' })).resolves.toBeTruthy();
    await expect(send({ screen: 'wallet' })).resolves.toBeTruthy();
    await expect(send({ screen: 'coupon' })).rejects.toMatchObject({ field: 'data.grant_id' });
    await expect(send({ screen: 'order' })).rejects.toMatchObject({ field: 'data.order_number' });
    await expect(send({ screen: 'chat' })).rejects.toMatchObject({ field: 'data.screen' });
    await expect(send({ topic: 'x' })).rejects.toMatchObject({ field: 'data.topic' });
    await expect(send({ action: 'x' })).rejects.toMatchObject({ field: 'data.action' });
  });
});
