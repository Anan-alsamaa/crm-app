import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMMERCE_PLATFORMS,
  ConnectorRegistry,
  EnvVendorSettingsSource,
  HttpYiji2Transport,
  MockYiji2Transport,
  RecordVendorSettingsSource,
  StaticVendorDirectory,
  UnknownVendorError,
  YIJI2_MOCK_ORDERS,
  Yiji2Connector,
  Yiji2RefusedError,
  Yiji2UnavailableError,
  asCouponPushConnector,
  isYijiRefused,
  isYijiUnavailable,
  yiji2Rfc3339,
  isYiji2OrderNumber,
  lateDeliveryMinutesKeyFor,
  mapYiji2Cart,
  mapYiji2CouponContext,
  mapYiji2Customer,
  mapYiji2History,
  mapYiji2Order,
  orderEventFromYiji2,
  parseYiji2EventsBody,
  translateV1AdminCall,
  vendorOAuthEnvNames,
  vendorOAuthFromEnv,
  yiji2Amount,
  yiji2Id,
  yiji2Minor,
  yiji2IsOpen,
  yiji2Status,
  YIJI2_STATE_TO_STATUS,
  YIJI2_CLOSING_STATES,
  YIJI2_ORDER_STATES,
  YIJI2_GRANTS_MAX_PAGES,
  YIJI2_MOCK_FOREIGN_GRANT,
  findGrantByCode,
  v2CouponProblem,
  v2PushData,
  type Yiji2Transport,
  type ConnectorVendor,
  type Yiji2OrderWire,
  type Yiji2PlatformSettings,
} from '../src/index.js';

/**
 * YIJI V2 AS A SECOND TENANT (owner, 2026-11-16): platform `yiji2`, its own
 * connector, its own settings and credentials, the v1 money path unchanged
 * (the connector translates v1's admin calls to v2's partner routes), and
 * NOTHING reaches a v2 host from the mock transport.
 */
const V2_VENDOR: ConnectorVendor = {
  crmId: 'uuid-v2',
  platformVendorId: '2',
  platform: 'yiji2',
  status: 'active',
  name: 'Yiji V2 (SA)',
};
const V1_VENDOR: ConnectorVendor = {
  crmId: 'uuid-v1',
  platformVendorId: '1',
  platform: 'yiji',
  status: 'active',
  name: 'Yiji',
};
const NOW = Date.parse('2026-11-16T09:00:00Z');
const mockSettings: Yiji2PlatformSettings = { platform: 'yiji2', mock: true, tenantId: '2' };

function mockConnector() {
  const transport = new MockYiji2Transport({ now: () => NOW });
  const connector = new Yiji2Connector(V2_VENDOR, mockSettings, { transport, now: () => NOW });
  return { transport, connector };
}

/* ── zero network ───────────────────────────────────────────────── */

describe('the mock transport never touches the network', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('NETWORK CALL from the yiji2 mock');
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('answers customers, orders, carts, history and a coupon grant from memory', async () => {
    const { connector, transport } = mockConnector();
    const c = await connector.getCustomer('2000000001');
    expect(c).toMatchObject({ externalCustomerId: '2000000001', phone: '0500000201' });
    const orders = await connector.getOrders('2000000001');
    expect(orders.map((o) => o.orderId)).toEqual(['2611000000001', '2611000000002']);
    const cart = await connector.getOrderCart('2611000000001');
    expect(cart?.lines[0]?.modifiers).toEqual(['Extra cheese', 'No onions']);
    expect(cart?.total).toBe(2 * (32 + 3) + 12 + 8);
    const tl = await connector.getOrderTimeline('2611000000001');
    expect(tl?.current).toBe('in_delivery');
    expect(tl?.events.map((e) => e.status)).toEqual(['placed', 'received', 'in_delivery']);
    const answer = await connector.adminPost!<{
      result: number;
      extendedProperties?: { CouponUserId?: string };
    }>(
      '/api/CouponUserOrder/CreateCouponUserFromOrder',
      {
        orderId: '2611000000001',
        couponCode: 'V2-TEST-1',
        couponName: '0500000201',
        compensationReason: 'late',
        coupon: {
          code: 'V2-TEST-1',
          type: 1,
          discount: 25,
          discountPercentage: 0,
          limitForUser: 1,
          reachLimit: 10000,
        },
      },
      { 'idempotency-key': 'V2-TEST-1' },
    );
    expect(answer.result).toBe(1);
    expect(answer.extendedProperties?.CouponUserId).toBe('700001');
    expect(transport.coupons[0]).toMatchObject({ code: 'V2-TEST-1' });
    expect(transport.coupons[0]?.body).toMatchObject({
      category: 'private',
      type: 'amount',
      value: { amount_minor: 2500, currency: 'SAR' },
      title: { ar: '0500000201', en: '0500000201' },
      country: 'SA',
      order_number: '2611000000001',
    });
    /* granted in the creation call: one request, not two */
    expect(transport.calls.map((c) => c.path)).toEqual(['/compensation-coupons']);
    expect(transport.grants[0]).toMatchObject({
      customer_id: '2000000001',
      order_number: '2611000000001',
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('a retried push with the same idempotency key answers the stored result, no second coupon', async () => {
    const { connector, transport } = mockConnector();
    const body = {
      orderId: '2611000000001',
      couponCode: 'V2-IDEM',
      coupon: { code: 'V2-IDEM', discount: 10, reachLimit: 100 },
    };
    const a = await connector.adminPost!('/api/CouponUserOrder/CreateCouponUserFromOrder', body, {
      'idempotency-key': 'V2-IDEM',
    });
    const b = await connector.adminPost!('/api/CouponUserOrder/CreateCouponUserFromOrder', body, {
      'idempotency-key': 'V2-IDEM',
    });
    expect(a).toEqual(b);
    expect(transport.coupons).toHaveLength(1);
    expect(transport.grants).toHaveLength(1);
  });
});

/* ── the shapes ─────────────────────────────────────────────────── */

describe('v2 money, ids and order numbers', () => {
  it('money is always a pair; SAR has 2 decimals, BHD 3', () => {
    expect(yiji2Amount({ amount_minor: 1250, currency: 'SAR' })).toBe(12.5);
    expect(yiji2Amount({ amount_minor: 1250, currency: 'BHD' })).toBe(1.25);
    expect(yiji2Amount(null)).toBeUndefined();
    expect(yiji2Minor(12.5, 'sar')).toEqual({ amount_minor: 1250, currency: 'SAR' });
    expect(yiji2Minor(1.25, 'BHD')).toEqual({ amount_minor: 1250, currency: 'BHD' });
  });
  it('int64 ids arrive as numbers or strings and are kept as strings', () => {
    expect(yiji2Id(2000000001)).toBe('2000000001');
    expect(yiji2Id(' 2000000001 ')).toBe('2000000001');
    expect(yiji2Id(null)).toBeUndefined();
  });
  it('order numbers are YYMM x 10^9 + sequence', () => {
    expect(isYiji2OrderNumber('2611000000001')).toBe(true);
    expect(isYiji2OrderNumber(2611000000001)).toBe(true);
    expect(isYiji2OrderNumber('1339586')).toBe(false); // a v1 id
    expect(isYiji2OrderNumber('2613000000001')).toBe(false); // month 13
  });
});

describe('mapping v2 wire shapes to the CRM', () => {
  const wire: Yiji2OrderWire = {
    order_number: 2611000000007,
    customer_id: 2000000003,
    customer: { id: 2000000003, name: 'Manama', phone: '+97336000203' },
    state: 'out_for_delivery',
    order_type: 'delivery',
    country: 'BH',
    placed_at: '2026-11-16T08:00:00Z',
    restaurant_id: 9201,
    restaurant_name: 'V2 Kitchen - Seef',
    brand_id: 91,
    brand_name: 'V2 Kitchen',
    address: { text: 'Seef 1' },
    payment: { state: 'captured', method: 'benefit', paid_at: '2026-11-16T08:00:10Z' },
    money: {
      items: { amount_minor: 5500, currency: 'BHD' },
      delivery_fee: { amount_minor: 800, currency: 'BHD' },
      discount: { amount_minor: 0, currency: 'BHD' },
      coupon: { amount_minor: 500, currency: 'BHD' },
      tax: { amount_minor: 0, currency: 'BHD' },
      total: { amount_minor: 5800, currency: 'BHD' },
    },
    coupon: { id: 500001, code: 'BH-5' },
    tracking_url: 'https://track.v2.test/2611000000007',
    items: [
      {
        sku: 'PZ',
        name: 'Pizza',
        quantity: 1,
        unit_price: { amount_minor: 5500, currency: 'BHD' },
        modifiers: [
          { group: 'Crust', name: 'Thin crust', unit_price: { amount_minor: 0, currency: 'BHD' } },
        ],
      },
    ],
    sub_orders: [],
  };

  it('maps an order with BHD money and a string id', () => {
    const o = mapYiji2Order(wire)!;
    expect(o.orderId).toBe('2611000000007');
    expect(o.status).toBe('in_delivery');
    expect(o.currency).toBe('BHD');
    expect(o.total).toBe(5.8);
    expect(o.totalCouponAmount).toBe(0.5);
    expect(o.restaurantId).toBe('9201');
    expect(o.deliveryType).toBe('delivery');
    expect(o.customerPhone).toBe('+97336000203'); // not Saudi: kept as sent
    expect(o.items[0]?.modifierGroups).toEqual([
      { name: 'Crust', options: [{ name: 'Thin crust', qty: 1, price: 0 }] },
    ]);
    expect(o.groupRole).toBeUndefined();
  });

  it('a food-court master and its sub-order are told apart', () => {
    expect(
      mapYiji2Order({
        ...wire,
        sub_orders: [{ ...wire, order_number: 2611000000008, parent_order_number: 2611000000007 }],
      }),
    ).toMatchObject({
      groupRole: 'master',
      groupMasterId: '2611000000007',
    });
    expect(
      mapYiji2Order({
        ...wire,
        order_number: 2611000000008,
        parent_order_number: 2611000000007,
        sub_orders: [],
      }),
    ).toMatchObject({
      groupRole: 'sub',
      groupMasterId: '2611000000007',
    });
  });

  it('maps the cart, the history and the coupon context', () => {
    const cart = mapYiji2Cart(wire)!;
    expect(cart).toMatchObject({
      foodPrice: 5.5,
      deliveryFee: 0.8,
      total: 5.8,
      couponCode: 'BH-5',
      trackingUrl: 'https://track.v2.test/2611000000007',
    });
    const tl = mapYiji2History('2611000000007', [
      { state: 'created', at: '2026-11-16T08:00:00Z' },
      { state: 'delivered', at: '2026-11-16T09:00:00Z' },
    ]);
    expect(tl.events.map((e) => e.status)).toEqual(['placed', 'delivered']);
    expect(tl.derived).toBe(false);
    expect(mapYiji2CouponContext(wire, '2')).toEqual({
      userId: '2000000003',
      customerPhone: '+97336000203',
      customerName: 'Manama',
      restaurantId: 9201,
      brandId: 91,
      tenantId: 2,
    });
  });

  it('maps a customer and canonicalises a Saudi phone', () => {
    expect(
      mapYiji2Customer({ id: '2000000001', phone: '+966500000201', name: 'One', country: 'SA' }),
    ).toEqual({
      externalCustomerId: '2000000001',
      name: 'One',
      phone: '0500000201',
      metadata: { country: 'SA' },
    });
    expect(mapYiji2Customer({ id: '' })).toBeNull();
  });
});

/* ── the translator ─────────────────────────────────────────────── */

describe('translateV1AdminCall: v1 paths become v2 partner calls', () => {
  it('AddCoupon -> POST /compensation-coupons, the new id in exceptionMessage', async () => {
    const t = new MockYiji2Transport();
    const a = await translateV1AdminCall(
      t,
      '/api/Coupon/AddCoupon',
      { code: 'X1', type: 0, discount: 30, discountPercentage: 0, limitForUser: 2, reachLimit: 60 },
      {},
      { currency: 'SAR' },
    );
    expect(a).toEqual({ result: 1, exceptionMessage: '500001', transactionStatus: 1 });
    expect(t.calls[0]).toMatchObject({ method: 'POST', path: '/compensation-coupons' });
    expect(t.coupons[0]?.body).toMatchObject({
      category: 'general',
      type: 'amount',
      value: { amount_minor: 3000, currency: 'SAR' },
      usage_limit: 2,
      total_discount_limit: { amount_minor: 6000, currency: 'SAR' },
      country: 'SA',
    });
    expect(t.coupons[0]?.body).not.toHaveProperty('percent_bps');
    expect(t.grants).toHaveLength(0);
  });

  it('AddUserCoupon -> POST /grants; a second grant of the same coupon is refused', async () => {
    const t = new MockYiji2Transport();
    await translateV1AdminCall(
      t,
      '/api/Coupon/AddCoupon',
      { code: 'X2', discount: 5, reachLimit: 100 },
      {},
      { currency: 'SAR' },
    );
    const a = await translateV1AdminCall(
      t,
      '/api/CouponUser/AddUserCoupon',
      { couponId: 500001, userId: '2000000002' },
      {},
      { currency: 'SAR' },
    );
    expect(a).toEqual({ result: 1, extendedProperties: { CouponUserId: '700001' } });
    await expect(
      translateV1AdminCall(
        t,
        '/api/CouponUser/AddUserCoupon',
        { couponId: 500001, userId: '2000000002' },
        {},
        { currency: 'SAR' },
      ),
    ).rejects.toBeInstanceOf(Yiji2RefusedError);
  });

  it('RemoveUserCoupon, UpdateCoupon and UpdateStatusCoupon map to grants/coupons routes', async () => {
    const t = new MockYiji2Transport();
    await translateV1AdminCall(
      t,
      '/api/Coupon/AddCoupon',
      { code: 'X3', discount: 5, reachLimit: 100 },
      {},
      { currency: 'SAR' },
    );
    await translateV1AdminCall(
      t,
      '/api/CouponUser/AddCouponToUserByCode',
      { code: 'X3', userId: '2000000001' },
      {},
      { currency: 'SAR' },
    );
    expect(
      await translateV1AdminCall(
        t,
        '/api/CouponUser/RemoveUserCoupon/700001',
        {},
        {},
        { currency: 'SAR' },
      ),
    ).toEqual({ result: 1 });
    expect(t.grants[0]?.removed).toBe(true);
    expect(
      await translateV1AdminCall(
        t,
        '/api/Coupon/UpdateStatusCoupon',
        { id: 500001, status: 0 },
        {},
        { currency: 'SAR' },
      ),
    ).toEqual({ result: 1 });
    expect(t.coupons[0]?.status).toBe('inactive');
    expect(
      await translateV1AdminCall(
        t,
        '/api/Coupon/UpdateCoupon',
        { id: 500001, coupon: { code: 'X3', discount: 7 } },
        {},
        { currency: 'SAR' },
      ),
    ).toEqual({ result: 1 });
    /* an unknown grant is a 404 on a WRITE: a refusal, never "removed" */
    await expect(
      translateV1AdminCall(t, '/api/CouponUser/RemoveUserCoupon/999', {}, {}, { currency: 'SAR' }),
    ).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });

  it('SendCrmNotification -> POST /customers/{id}/push, by id or by phone', async () => {
    const t = new MockYiji2Transport();
    expect(
      await translateV1AdminCall(
        t,
        'https://x/api/NotificationData/SendCrmNotification',
        { userId: '2000000001', title: 'Yiji Support', body: 'hi', prop1: 'crm.openchat' },
        {},
        { currency: 'SAR' },
      ),
    ).toEqual({ result: 1, extendedProperties: { NotificationId: 'ntf-1' } });
    expect(
      await translateV1AdminCall(
        t,
        'https://x/api/NotificationData/SendCrmNotification',
        { phoneNumber: '+966500000202', title: 'T', body: 'b' },
        {},
        { currency: 'SAR' },
      ),
    ).toEqual({ result: 1, extendedProperties: { NotificationId: 'ntf-2' } });
    expect(t.pushes.map((p) => p.customer_id)).toEqual(['2000000001', '2000000002']);
    /* the agreed tap action travels as data.prop1 - never a top-level or data `action` */
    expect(t.pushes[0]?.body).toEqual({
      title: 'Yiji Support',
      body: 'hi',
      data: { prop1: 'crm.openchat' },
    });
  });

  it('AddCompensationCoupon is not provided on v2 and an unknown path is refused', async () => {
    const t = new MockYiji2Transport();
    await expect(
      translateV1AdminCall(t, '/api/CouponUser/AddCompensationCoupon', {}, {}, { currency: 'SAR' }),
    ).rejects.toMatchObject({ code: 'not_provided' });
    await expect(
      translateV1AdminCall(t, '/api/Something/Else', {}, {}, { currency: 'SAR' }),
    ).rejects.toMatchObject({ code: 'unsupported_call' });
    expect(t.calls).toHaveLength(0);
  });
});

describe('HttpYiji2Transport token endpoint', () => {
  it('a refused or empty token answer is an OUTAGE (retried), never a settled refusal', async () => {
    const mk = (tokenRes: () => Response) =>
      new HttpYiji2Transport({
        apiBaseUrl: 'https://api.staging.yiji.app',
        clientId: 'id',
        clientSecret: 'rotated',
        fetchImpl: (async (url: string | URL | Request) =>
          String(url).endsWith('/auth/token')
            ? tokenRes()
            : new Response('{}', { status: 200 })) as unknown as typeof fetch,
        now: () => NOW,
      });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    const e401 = await mk(() => json(401, { error: { code: 'INVALID_CLIENT' } }))
      .request('POST', '/compensation-coupons', { body: {} })
      .catch((x: unknown) => x);
    expect(e401).toBeInstanceOf(Yiji2UnavailableError);
    expect(isYijiUnavailable(e401)).toBe(true);
    const empty = await mk(() => json(200, {}))
      .request('GET', '/customers/1')
      .catch((x: unknown) => x);
    expect(empty).toBeInstanceOf(Yiji2UnavailableError);
  });
});

/* ── refusals through the connector ─────────────────────────────── */

describe('a v2 refusal through the connector', () => {
  it('reaches the v1 coupon processor as the refusal it records and never retries', async () => {
    const { connector } = mockConnector();
    const e = await connector.adminPost!('/api/CouponUser/AddCompensationCoupon', {}, {}).catch(
      (x: unknown) => x,
    );
    /* the v1 processor's own classifier says "refused" -> recorded, job done */
    expect(isYijiRefused(e)).toBe(true);
    expect(e).toMatchObject({
      status: 403,
      body: {
        result: 2,
        exceptionMessage: 'not_provided: AddCompensationCoupon is not provided on v2.',
      },
    });
  });

  it('keeps a 400 VALIDATION_FAILED with its trace id in the recorded reason', async () => {
    const transport = {
      request: async () => {
        throw new Yiji2RefusedError('VALIDATION_FAILED', 'coupon.valid_to.past', 400, 'tr-77');
      },
    };
    const connector = new Yiji2Connector(V2_VENDOR, mockSettings, { transport });
    const e = await connector.adminPost!(
      '/api/Coupon/AddCoupon',
      { code: 'X', discount: 5, reachLimit: 100 },
      {},
    ).catch((x: unknown) => x);
    expect(isYijiRefused(e)).toBe(true);
    expect(e).toMatchObject({
      status: 400,
      body: {
        result: 2,
        exceptionMessage: 'VALIDATION_FAILED: coupon.valid_to.past (trace tr-77)',
      },
    });
  });

  it('lets an outage through unchanged, so the caller retries it', async () => {
    const transport = {
      request: async () => {
        throw new Yiji2UnavailableError('yiji2 rate limited (429)', 7);
      },
    };
    const connector = new Yiji2Connector(V2_VENDOR, mockSettings, { transport });
    await expect(
      connector.adminPost!(
        '/api/Coupon/AddCoupon',
        { code: 'X', discount: 5, reachLimit: 100 },
        {},
      ),
    ).rejects.toBeInstanceOf(Yiji2UnavailableError);
  });
});

/* ── the HTTP transport ─────────────────────────────────────────── */

describe('HttpYiji2Transport', () => {
  function transport(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
      handler(String(url), init ?? {}),
    );
    return {
      fetchImpl,
      t: new HttpYiji2Transport({
        apiBaseUrl: 'https://api.staging.yiji.app/',
        clientId: 'id',
        clientSecret: 'secret',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
      }),
    };
  }
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });

  it('takes a client-credentials token once, sends it as a bearer, and keys writes', async () => {
    const seen: Array<{ url: string; auth: string | undefined; idem: string | undefined }> = [];
    const { t, fetchImpl } = transport((url, init) => {
      const h = init.headers as Record<string, string>;
      seen.push({ url, auth: h['authorization'], idem: h['idempotency-key'] });
      if (url.endsWith('/auth/token')) return json(200, { access_token: 'tok-1', expires_in: 900 });
      if (url.includes('/orders/404'))
        return json(404, { error: { code: 'not_found', message: 'no' } });
      if (url.endsWith('/grants')) return json(201, { grant_id: 1 });
      return json(200, { id: 2000000001, phone: '+966500000201' });
    });
    await t.request('GET', '/customers/2000000001');
    await t.request('POST', '/grants', { body: { coupon_id: '1' }, idempotencyKey: 'k1' });
    expect(await t.request('GET', '/orders/404')).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(seen[0]?.url).toBe('https://api.staging.yiji.app/partner/v1/auth/token');
    expect(seen[1]).toMatchObject({
      url: 'https://api.staging.yiji.app/partner/v1/customers/2000000001',
      auth: 'Bearer tok-1',
    });
    expect(seen[2]?.idem).toBe('k1');
  });

  it('a 400 VALIDATION_FAILED is a typed refusal (code, message_key, trace_id); 429 and 5xx are unavailable', async () => {
    const { t, fetchImpl } = transport((url) => {
      if (url.endsWith('/auth/token')) return json(200, { access_token: 'tok', expires_in: 900 });
      /* v2 (2026-11-16): invalid input = HTTP 400, no "fields" list, same as its other APIs */
      if (url.includes('/refuse'))
        return json(400, {
          error: {
            code: 'VALIDATION_FAILED',
            message_key: 'coupon.value.required',
            trace_id: 'tr-1',
          },
        });
      if (url.includes('/slow')) return json(429, {}, { 'retry-after': '7' });
      return json(503, {});
    });
    const refused = await t.request('POST', '/refuse', { body: {} }).catch((x: unknown) => x);
    expect(refused).toBeInstanceOf(Yiji2RefusedError);
    expect(refused).toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 400,
      traceId: 'tr-1',
      message: 'VALIDATION_FAILED (coupon.value.required)',
    });
    /* refused = decided: one request, no retry of the same body */
    expect(fetchImpl.mock.calls.filter(([u]) => String(u).includes('/refuse'))).toHaveLength(1);
    const e = await t.request('GET', '/slow').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Yiji2UnavailableError);
    expect((e as Yiji2UnavailableError).retryAfterSec).toBe(7);
    await expect(t.request('GET', '/down')).rejects.toBeInstanceOf(Yiji2UnavailableError);
  });
});

/* ── the registry and the settings ──────────────────────────────── */

describe('registry: yiji2 is its own platform', () => {
  it('is a known platform and resolves to Yiji2Connector, never YijiConnector', async () => {
    expect(COMMERCE_PLATFORMS).toEqual(['yiji', 'yiji2', 'mock']);
    const r = new ConnectorRegistry({
      directory: new StaticVendorDirectory([V1_VENDOR, V2_VENDOR]),
      settings: new EnvVendorSettingsSource(
        { platform: 'yiji', client: {} },
        { yiji2: mockSettings },
      ),
      legacyVendorKey: '1',
    });
    const v2 = await r.connectorFor('2');
    expect(v2).toBeInstanceOf(Yiji2Connector);
    expect(v2.platform).toBe('yiji2');
    expect((await r.connectorFor('1')).platform).toBe('yiji');
    expect(asCouponPushConnector(v2)).toBe(v2);
    /* v1 stays the ONLY legacy default: records without a vendor never go to v2. */
    expect(await r.defaultVendorForLegacyRecords()).toBe('1');
  });

  it('an INACTIVE v2 vendor is refused (the morning state: implemented, not activated)', async () => {
    const r = new ConnectorRegistry({
      directory: new StaticVendorDirectory([V1_VENDOR, { ...V2_VENDOR, status: 'inactive' }]),
      settings: new EnvVendorSettingsSource(
        { platform: 'yiji', client: {} },
        { yiji2: mockSettings },
      ),
    });
    const err = await r.connectorFor('2').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnknownVendorError);
    expect((err as UnknownVendorError).reason).toBe('inactive');
  });

  it('without v2 settings the env source refuses the platform rather than answering with v1', async () => {
    const r = new ConnectorRegistry({
      directory: new StaticVendorDirectory([V1_VENDOR, V2_VENDOR]),
      settings: new EnvVendorSettingsSource({
        platform: 'yiji',
        client: { apiUrl: 'https://order.yiji-app.com' },
      }),
    });
    await expect(r.connectorFor('2')).rejects.toMatchObject({ reason: 'unsupported_platform' });
  });
});

describe('RecordVendorSettingsSource for yiji2', () => {
  const rows = [
    {
      id: 'uuid-v1',
      yiji_vendor_id: '1',
      webhook_path_key: 'yiji',
      api_base_url: 'https://order.yiji-app.com',
    },
    {
      id: 'uuid-v2',
      yiji_vendor_id: '2',
      webhook_path_key: 'yiji2',
      api_base_url: 'https://api.staging.yiji.app',
      tenant_id: '2',
      brand_id: '91',
      notify_settings: { notifyTitle: 'Yiji Support' },
    },
  ];
  const env = {
    client: {
      apiUrl: 'https://order.yiji-app.com',
      adminApiUrl: 'https://admin.yiji-app.com',
      adminEmail: 'crm@yiji',
      adminPassword: 'v1-secret',
    },
    push: { apiKey: 'v1-key' },
  };

  it('reads the v2 record and ONLY VENDOR_YIJI2_* credentials - never v1 values', async () => {
    const src = new RecordVendorSettingsSource({
      env: { platform: 'yiji', ...env },
      legacyVendorKey: '1',
      load: async () => rows,
      credentialEnv: {
        VENDOR_YIJI2_CLIENT_ID: 'cid',
        VENDOR_YIJI2_CLIENT_SECRET: 'csec',
        YIJI_API_KEY: 'v1-key',
      },
    });
    const s = await src.settingsFor(V2_VENDOR);
    expect(s).toEqual({
      platform: 'yiji2',
      apiBaseUrl: 'https://api.staging.yiji.app',
      clientId: 'cid',
      clientSecret: 'csec',
      tenantId: '2',
      brandId: '91',
      push: {
        notifyUrl: undefined,
        notifyTopic: undefined,
        notifyTitle: 'Yiji Support',
        openChatAction: undefined,
      },
    });
    /* currency is never guessed from the name (review 2026-11-16) */
    expect(s).not.toHaveProperty('environment');
    expect(s).not.toHaveProperty('currency');
    expect(JSON.stringify(s)).not.toContain('v1-');
    /* v1 is untouched by the v2 row. */
    const v1 = await src.settingsFor(V1_VENDOR);
    expect(v1.platform).toBe('yiji');
  });

  it('without credentials the connector has null capabilities and sends nothing', async () => {
    const src = new RecordVendorSettingsSource({
      env: { platform: 'yiji', ...env },
      legacyVendorKey: '1',
      load: async () => rows,
      credentialEnv: {},
    });
    const s = (await src.settingsFor(V2_VENDOR)) as Yiji2PlatformSettings;
    expect(s.clientId).toBeUndefined();
    const onUnconfigured = vi.fn();
    const c = new Yiji2Connector(V2_VENDOR, s, { onUnconfigured });
    expect(c.adminPost).toBeNull();
    expect(c.findCustomerIdByPhone).toBeNull();
    expect(await c.getOrders('2000000001')).toEqual([]);
    expect(onUnconfigured).toHaveBeenCalledTimes(1);
  });

  it('uses the in-memory transport only with allowMock and no API URL', async () => {
    const noUrl = rows.map((r) => (r.id === 'uuid-v2' ? { ...r, api_base_url: '' } : r));
    const withMock = new RecordVendorSettingsSource({
      env: { platform: 'yiji', ...env },
      legacyVendorKey: '1',
      load: async () => noUrl,
      allowMock: true,
      credentialEnv: {},
    });
    expect((await withMock.settingsFor(V2_VENDOR)) as Yiji2PlatformSettings).toMatchObject({
      mock: true,
    });
    const noMock = new RecordVendorSettingsSource({
      env: { platform: 'yiji', ...env },
      legacyVendorKey: '1',
      load: async () => noUrl,
      credentialEnv: {},
    });
    expect(((await noMock.settingsFor(V2_VENDOR)) as Yiji2PlatformSettings).mock).toBeUndefined();
    const withUrl = new RecordVendorSettingsSource({
      env: { platform: 'yiji', ...env },
      legacyVendorKey: '1',
      load: async () => rows,
      allowMock: true,
      credentialEnv: {},
    });
    expect(((await withUrl.settingsFor(V2_VENDOR)) as Yiji2PlatformSettings).mock).toBeUndefined();
    /* a FAILED integration read is "unconfigured", never the in-memory mock
       (a real coupon would be "delivered" into memory - review 2026-11-16) */
    const readFails = new RecordVendorSettingsSource({
      env: { platform: 'yiji', ...env },
      legacyVendorKey: '1',
      load: async () => {
        throw new Error('directus down');
      },
      allowMock: true,
      credentialEnv: {},
    });
    const s = (await readFails.settingsFor(V2_VENDOR)) as Yiji2PlatformSettings;
    expect(s.platform).toBe('yiji2');
    expect(s.mock).toBeUndefined();
    expect(s.apiBaseUrl).toBeUndefined();
  });
});

describe('review fixes 2026-11-16', () => {
  it('coupon dates reach v2 as RFC 3339 with the fixed +03:00 offset', () => {
    expect(yiji2Rfc3339('2026-12-16T23:59:00')).toBe('2026-12-16T23:59:00+03:00');
    expect(yiji2Rfc3339('2026-12-16T23:59')).toBe('2026-12-16T23:59:00+03:00');
    expect(yiji2Rfc3339('2026-12-16')).toBe('2026-12-16T00:00:00+03:00');
    expect(yiji2Rfc3339('2026-12-16T20:59:00Z')).toBe('2026-12-16T20:59:00Z');
    expect(yiji2Rfc3339('2026-12-16T23:59:00+03:00')).toBe('2026-12-16T23:59:00+03:00');
    expect(yiji2Rfc3339(undefined)).toBeUndefined();
  });

  it('the draft carries zoned dates', async () => {
    const t = new MockYiji2Transport();
    await translateV1AdminCall(
      t,
      '/api/Coupon/AddCoupon',
      {
        code: 'D1',
        discount: 5,
        reachLimit: 100,
        activationDateTime: '2026-11-16T00:00:00',
        expirationDateTime: '2026-12-16T23:59:00',
      },
      {},
      { currency: 'SAR' },
    );
    expect(t.coupons[0]?.body).toMatchObject({
      valid_from: '2026-11-16T00:00:00+03:00',
      valid_to: '2026-12-16T23:59:00+03:00',
    });
  });

  it('attach-by-code takes the ids from the PATH, as v1 sends them', async () => {
    const t = new MockYiji2Transport();
    await translateV1AdminCall(
      t,
      '/api/Coupon/AddCoupon',
      { code: 'BC-1', discount: 5, reachLimit: 100 },
      {},
      { currency: 'SAR' },
    );
    const a = await translateV1AdminCall(
      t,
      '/api/CouponUser/AddCouponToUserByCode/2000000002/BC-1',
      {},
      {},
      { currency: 'SAR' },
    );
    expect(a).toMatchObject({ result: 1, extendedProperties: { CouponUserId: '700001' } });
    expect(t.grants[0]).toMatchObject({ customer_id: '2000000002', code: 'BC-1' });
  });

  it('currency is explicit: SAR unless settings say BHD; the vendor name never decides', async () => {
    const bh = new Yiji2Connector(
      { ...V2_VENDOR, name: 'Yiji V2 Abha' },
      { ...mockSettings, currency: 'BHD' },
      { transport: new MockYiji2Transport() },
    );
    await bh.adminPost!(
      '/api/Coupon/AddCoupon',
      { code: 'C-BH', discount: 1.5, reachLimit: 15 },
      {},
    );
    expect((bh.transport as MockYiji2Transport).coupons[0]?.body).toMatchObject({
      value: { amount_minor: 1500, currency: 'BHD' },
      country: 'BH',
    });
    const named = new Yiji2Connector({ ...V2_VENDOR, name: 'Yiji V2 BH branch' }, mockSettings, {
      transport: new MockYiji2Transport(),
    });
    await named.adminPost!(
      '/api/Coupon/AddCoupon',
      { code: 'C-SA', discount: 10, reachLimit: 100 },
      {},
    );
    expect((named.transport as MockYiji2Transport).coupons[0]?.body).toMatchObject({
      value: { amount_minor: 1000, currency: 'SAR' },
      country: 'SA',
    });
  });

  it('a Yiji2UnavailableError is an outage to the v1 helpers too', () => {
    expect(isYijiUnavailable(new Yiji2UnavailableError('down'))).toBe(true);
    expect(isYijiRefused(new Yiji2UnavailableError('down'))).toBe(false);
  });
});

describe('v2 credential names', () => {
  it('are VENDOR_<KEY>_CLIENT_ID / _CLIENT_SECRET and never exist for the yiji key', () => {
    expect(vendorOAuthEnvNames('yiji2')).toEqual({
      clientId: 'VENDOR_YIJI2_CLIENT_ID',
      clientSecret: 'VENDOR_YIJI2_CLIENT_SECRET',
    });
    expect(
      vendorOAuthFromEnv(
        { VENDOR_YIJI2_CLIENT_ID: ' a ', VENDOR_YIJI2_CLIENT_SECRET: 'b' },
        'yiji2',
      ),
    ).toEqual({ clientId: 'a', clientSecret: 'b' });
    expect(vendorOAuthFromEnv({ VENDOR_YIJI_CLIENT_ID: 'x' }, 'yiji')).toEqual({});
    expect(vendorOAuthFromEnv({ VENDOR_BAD_KEY_CLIENT_ID: 'x' }, 'Bad Key!')).toEqual({});
  });
});

/* ── events and settings ────────────────────────────────────────── */

describe('v2 events -> the CRM order event', () => {
  const late = {
    id: 'evt-late-1',
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
      order_type: 'delivery',
      is_group_master: false,
      timeline: [{ state: 'created', at: '2026-11-16T08:55:00Z' }],
    },
  };

  it('order.late becomes an open delivery order placed at placed_at', () => {
    const parsed = parseYiji2EventsBody(late);
    expect(parsed.success).toBe(true);
    const e = orderEventFromYiji2(parsed.success ? (parsed.data as never) : (null as never))!;
    expect(e).toMatchObject({
      id: 'evt-late-1',
      type: 'order.status_changed',
      at: '2026-11-16T10:00:00Z',
      order: {
        orderId: '2611000000001',
        status: 'in_delivery',
        isOpen: true,
        orderType: 'delivery',
        placedAt: '2026-11-16T08:55:00Z',
        restaurantId: '9101',
        brandId: '91',
        customer: { id: '2000000001' },
      },
    });
  });

  it('derives placed_at from elapsed_seconds when v2 omits it, and closes on status_changed', () => {
    const noPlaced = { ...late, id: 'evt-2', data: { ...late.data, placed_at: undefined } };
    expect(orderEventFromYiji2(noPlaced as never)?.order.placedAt).toBe('2026-11-16T08:55:00.000Z');
    const closed = orderEventFromYiji2({
      id: 'evt-3',
      type: 'order.status_changed',
      occurred_at: '2026-11-16T10:30:00Z',
      data: {
        order_number: '2611000000001',
        state: 'delivered',
        order_type: 'delivery',
        placed_at: '2026-11-16T08:55:00Z',
        total: { amount_minor: 8800, currency: 'SAR' },
      },
    })!;
    expect(closed.order).toMatchObject({ status: 'delivered', isOpen: false, total: 88 });
  });

  it('a missing order_type, state or order_number is MALFORMED: null and reported, never defaulted', () => {
    /* v2 session 2026-11-16: every order.* event carries order_type and state;
       a defaulted order type would put a pickup on the delivery board. */
    const malformed = vi.fn();
    const without = (k: string) => ({
      ...late,
      id: `evt-no-${k}`,
      data: { ...late.data, [k]: undefined },
    });
    expect(orderEventFromYiji2(without('order_type') as never, { malformed })).toBeNull();
    expect(orderEventFromYiji2(without('state') as never, { malformed })).toBeNull();
    expect(orderEventFromYiji2(without('order_number') as never, { malformed })).toBeNull();
    expect(malformed.mock.calls.map((c) => c[0])).toEqual([
      'no order_type',
      'no state',
      'no order_number',
    ]);
    /* a type the CRM has no name for is kept, off the delivery board */
    expect(
      orderEventFromYiji2({ ...late, data: { ...late.data, order_type: 'catering' } } as never)
        ?.order.orderType,
    ).toBe('other');
  });

  it("maps v2's order types; a food-court parent is the delivered, grouped order", () => {
    const of = (order_type: string, extra: Record<string, unknown> = {}) =>
      orderEventFromYiji2({ ...late, data: { ...late.data, order_type, ...extra } } as never)!
        .order;
    expect(of('takeaway').orderType).toBe('takeout');
    expect(of('pickup').orderType).toBe('pickup');
    expect(of('carhop').orderType).toBe('carhop');
    expect(of('dine_in').orderType).toBe('dine_in');
    expect(of('food_court_parent', { is_group_master: true })).toMatchObject({
      orderType: 'delivery',
      isGroupMaster: true,
    });
    const sub = of('food_court_sub', { parent_order_number: 2611000000009 });
    expect(sub).toMatchObject({ orderType: 'other', parentOrderId: '2611000000009' });
    expect(sub.isGroupMaster).toBeUndefined();
  });

  it("maps v2's 15 states; only delivered, handed_over, closed, cancelled close", () => {
    const open = [
      'created',
      'awaiting_payment',
      'accepted',
      'sent_to_kitchen',
      'kitchen_confirmed',
      'preparing',
      'ready',
      'finding_courier',
      'courier_assigned',
      'out_for_delivery',
      'arrived',
    ];
    for (const s of open) {
      expect(yiji2IsOpen(s), s).toBe(true);
      expect(yiji2Status(s), s).not.toBe('unknown');
      expect(yiji2Status(s), s).toBe(YIJI2_STATE_TO_STATUS[s]);
    }
    for (const s of ['delivered', 'handed_over', 'closed', 'cancelled']) {
      expect(yiji2IsOpen(s), s).toBe(false);
    }
    expect(yiji2Status('finding_courier')).toBe('ready');
    expect(yiji2Status('arrived')).toBe('in_delivery');
    expect(yiji2Status('handed_over')).toBe('delivered');
    expect(yiji2Status('closed')).toBe('delivered');
    /* the event mapper agrees */
    const closed = orderEventFromYiji2({
      ...late,
      id: 'evt-ho',
      type: 'order.status_changed',
      data: { ...late.data, state: 'handed_over' },
    } as never)!;
    expect(closed.order).toMatchObject({ status: 'delivered', isOpen: false });
  });

  it('ignores types the CRM does not act on, and a batch parses', () => {
    expect(
      orderEventFromYiji2({
        id: 'c',
        type: 'coupon.granted',
        occurred_at: '2026-11-16T10:00:00Z',
        data: {},
      }),
    ).toBeNull();
    const batch = parseYiji2EventsBody({ events: [late, { ...late, id: 'evt-x' }] });
    expect(batch.success).toBe(true);
  });
});

describe('per-platform late-delivery setting key', () => {
  it('keeps v1 on late_delivery_minutes and gives v2 its own suffixed key', () => {
    expect(lateDeliveryMinutesKeyFor('yiji')).toBe('late_delivery_minutes');
    expect(lateDeliveryMinutesKeyFor(undefined)).toBe('late_delivery_minutes');
    expect(lateDeliveryMinutesKeyFor('yiji2')).toBe('late_delivery_minutes_yiji2');
  });
});

describe('the connector answers no late-order poll (events feed the board)', () => {
  it('getLateDeliveryOrders is always empty, even with late mock orders', async () => {
    const { connector } = mockConnector();
    expect(YIJI2_MOCK_ORDERS.some((o) => (o.minutesAgo ?? 0) > 60)).toBe(true);
    expect(await connector.getLateDeliveryOrders(60)).toEqual([]);
  });
});

/* ── the v2 partner contract of 2026-11-17 ──────────────────────── */

describe('contract 2026-11-17 (1): order states', () => {
  it('knows exactly the 15 platform states and closes on exactly four', () => {
    expect([...YIJI2_ORDER_STATES]).toEqual([
      'created',
      'awaiting_payment',
      'accepted',
      'sent_to_kitchen',
      'kitchen_confirmed',
      'preparing',
      'ready',
      'finding_courier',
      'courier_assigned',
      'out_for_delivery',
      'delivered',
      'arrived',
      'handed_over',
      'closed',
      'cancelled',
    ]);
    expect([...YIJI2_CLOSING_STATES].sort()).toEqual(
      ['cancelled', 'closed', 'delivered', 'handed_over'].sort(),
    );
    expect(Object.keys(YIJI2_STATE_TO_STATUS).sort()).toEqual([...YIJI2_ORDER_STATES].sort());
    for (const s of YIJI2_ORDER_STATES)
      expect(yiji2IsOpen(s), s).toBe(!YIJI2_CLOSING_STATES.has(s));
    /* words outside the 15 no longer close an order */
    expect(yiji2IsOpen('refunded')).toBe(true);
    expect(yiji2Status('refunded')).toBe('refunded');
  });

  it('the event mapper closes on the same four and keeps arrived open', () => {
    const ev = (state: string) =>
      orderEventFromYiji2({
        id: `evt-${state}`,
        type: 'order.status_changed',
        occurred_at: '2026-11-17T10:00:00Z',
        data: {
          order_number: 2611000000001,
          state,
          order_type: 'delivery',
          placed_at: '2026-11-17T09:00:00Z',
        },
      })!;
    for (const s of ['delivered', 'handed_over', 'closed', 'cancelled'])
      expect(ev(s).order.isOpen, s).toBe(false);
    for (const s of ['arrived', 'out_for_delivery', 'finding_courier', 'awaiting_payment'])
      expect(ev(s).order.isOpen, s).toBe(true);
    expect(ev('cancelled').order.status).toBe('canceled');
  });
});

describe('contract 2026-11-17 (2): POST /compensation-coupons', () => {
  const amount = (extra: Record<string, unknown> = {}) => ({
    code: 'K1',
    type: 1,
    discount: 25,
    discountPercentage: 0,
    limitForUser: 2,
    reachLimit: 50,
    ...extra,
  });

  it('a percentage coupon is refused LOCALLY, before any network call', async () => {
    const t = new MockYiji2Transport();
    const e = await translateV1AdminCall(
      t,
      '/api/Coupon/AddCoupon',
      { code: 'P1', discount: 0, discountPercentage: 10, maximumDiscount: 30, reachLimit: 100 },
      {},
      { currency: 'SAR' },
    ).catch((x: unknown) => x);
    expect(e).toMatchObject({
      code: 'percent_not_supported_on_v2',
      status: 400,
      field: 'category',
    });
    expect((e as Error).message).toMatch(/amount coupons only/);
    expect(t.calls).toHaveLength(0);
    /* the order path too */
    await expect(
      translateV1AdminCall(
        t,
        '/api/CouponUserOrder/CreateCouponUserFromOrder',
        { orderId: '2611000000001', coupon: { code: 'P2', discountPercentage: 5, reachLimit: 9 } },
        {},
        { currency: 'SAR' },
      ),
    ).rejects.toMatchObject({ code: 'percent_not_supported_on_v2' });
    expect(t.calls).toHaveLength(0);
  });

  it('through the connector the percentage refusal is the v1 refusal the processor records', async () => {
    const { connector, transport } = mockConnector();
    const e = await connector.adminPost!(
      '/api/Coupon/AddCoupon',
      { code: 'P3', discountPercentage: 15, reachLimit: 100 },
      {},
    ).catch((x: unknown) => x);
    expect(isYijiRefused(e)).toBe(true);
    expect(e).toMatchObject({ status: 400, body: { result: 2 } });
    expect((e as { body: { exceptionMessage: string } }).body.exceptionMessage).toMatch(
      /^percent_not_supported_on_v2 \[category\]: /,
    );
    expect(transport.calls).toHaveLength(0);
  });

  it('the mock refuses a percentage coupon like v2: 400 VALIDATION_FAILED, field category', async () => {
    const t = new MockYiji2Transport();
    await expect(
      t.request('POST', '/compensation-coupons', {
        body: {
          code: 'P4',
          type: 'percent',
          percent_bps: 1000,
          country: 'SA',
          total_discount_limit: { amount_minor: 10000, currency: 'SAR' },
        },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 400, field: 'category' });
    expect(t.coupons).toHaveLength(0);
  });

  it('total_discount_limit is never raised: below value x usage_limit is refused locally', async () => {
    const t = new MockYiji2Transport();
    const e = await translateV1AdminCall(
      t,
      '/api/Coupon/AddCoupon',
      amount({ reachLimit: 40 }),
      {},
      { currency: 'SAR' },
    ).catch((x: unknown) => x);
    expect(e).toMatchObject({
      code: 'total_limit_below_uses_on_v2',
      status: 400,
      field: 'total_discount_limit',
    });
    expect((e as Error).message).toContain('40 SAR');
    expect((e as Error).message).toContain('value 25 SAR x 2 uses = 50 SAR');
    expect(t.calls).toHaveLength(0);
    /* a missing total is refused too: nothing is invented */
    await expect(
      translateV1AdminCall(
        t,
        '/api/Coupon/AddCoupon',
        amount({ reachLimit: undefined }),
        {},
        { currency: 'SAR' },
      ),
    ).rejects.toMatchObject({ code: 'total_limit_missing_on_v2' });
    expect(t.calls).toHaveLength(0);
    /* exactly value x uses is fine, and is sent as approved */
    await translateV1AdminCall(t, '/api/Coupon/AddCoupon', amount(), {}, { currency: 'SAR' });
    expect(t.coupons[0]?.body).toMatchObject({
      total_discount_limit: { amount_minor: 5000, currency: 'SAR' },
      usage_limit: 2,
    });
  });

  it('the mock enforces the total rule like v2', async () => {
    const t = new MockYiji2Transport();
    await expect(
      t.request('POST', '/compensation-coupons', {
        body: {
          code: 'T1',
          type: 'amount',
          country: 'SA',
          value: { amount_minor: 2500, currency: 'SAR' },
          usage_limit: 2,
          total_discount_limit: { amount_minor: 4000, currency: 'SAR' },
        },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', field: 'total_discount_limit' });
  });

  it("currency is the vendor country's: a mismatch is refused locally and by the mock", async () => {
    const t = new MockYiji2Transport();
    await expect(
      translateV1AdminCall(
        t,
        '/api/Coupon/AddCoupon',
        amount(),
        {},
        {
          currency: 'SAR',
          country: 'BH',
        },
      ),
    ).rejects.toMatchObject({ code: 'currency_not_country_on_v2', field: 'currency' });
    expect(t.calls).toHaveLength(0);
    expect(
      v2CouponProblem({
        type: 'amount',
        country: 'BH',
        value: { amount_minor: 1500, currency: 'BHD' },
        total_discount_limit: { amount_minor: 1500, currency: 'BHD' },
      }),
    ).toBeNull();
    await expect(
      t.request('POST', '/compensation-coupons', {
        body: {
          code: 'CU1',
          type: 'amount',
          country: 'BH',
          value: { amount_minor: 1000, currency: 'SAR' },
          total_discount_limit: { amount_minor: 1000, currency: 'SAR' },
        },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', field: 'currency' });
    /* BHD for BH is created */
    await translateV1AdminCall(
      t,
      '/api/Coupon/AddCoupon',
      amount({ discount: 1.5, reachLimit: 3 }),
      {},
      {
        currency: 'BHD',
      },
    );
    expect(t.coupons[0]?.body).toMatchObject({
      country: 'BH',
      value: { amount_minor: 1500, currency: 'BHD' },
    });
  });

  it('the brand needs an active restaurant in the country; a restaurant must match brand and country', async () => {
    const t = new MockYiji2Transport();
    const send = (extra: Record<string, unknown>, currency = 'SAR') =>
      translateV1AdminCall(t, '/api/Coupon/AddCoupon', amount(extra), {}, { currency });
    /* brand 93 has no active restaurant anywhere */
    await expect(send({ code: 'B1', brandId: 93 })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 400,
      field: 'brand_id',
    });
    /* 9201 is brand 91 in BH, not SA */
    await expect(send({ code: 'B2', brandId: 91, restaurantId: 9201 })).rejects.toMatchObject({
      field: 'restaurant_id',
    });
    /* an unknown restaurant */
    await expect(send({ code: 'B3', restaurantId: 9999 })).rejects.toMatchObject({
      field: 'restaurant_id',
    });
    expect(t.coupons).toHaveLength(0);
    await send({ code: 'B4', brandId: 91, restaurantId: 9101 });
    await send({ code: 'B5', brandId: 91, restaurantId: 9201, discount: 1, reachLimit: 2 }, 'BHD');
    expect(t.coupons.map((c) => c.code)).toEqual(['B4', 'B5']);
  });

  it('the brand rule refused by v2 reaches the v1 processor as a recorded refusal', async () => {
    const { connector } = mockConnector();
    const e = await connector.adminPost!(
      '/api/Coupon/AddCoupon',
      amount({ code: 'B6', brandId: 93 }),
      {},
    ).catch((x: unknown) => x);
    expect(isYijiRefused(e)).toBe(true);
    expect((e as { body: { exceptionMessage: string } }).body.exceptionMessage).toBe(
      'VALIDATION_FAILED [brand_id]: coupon.brand.no_active_restaurant_in_country',
    );
  });

  it('coupons at or above SAR 200 / BHD 20 are created and only alerted, never refused', async () => {
    const t = new MockYiji2Transport();
    await translateV1AdminCall(
      t,
      '/api/Coupon/AddCoupon',
      amount({ code: 'L1', discount: 200, limitForUser: 1, reachLimit: 200 }),
      {},
      { currency: 'SAR' },
    );
    await translateV1AdminCall(
      t,
      '/api/Coupon/AddCoupon',
      amount({ code: 'L2', discount: 199.99, limitForUser: 1, reachLimit: 199.99 }),
      {},
      { currency: 'SAR' },
    );
    await translateV1AdminCall(
      t,
      '/api/Coupon/AddCoupon',
      amount({ code: 'L3', discount: 20, limitForUser: 1, reachLimit: 20 }),
      {},
      { currency: 'BHD' },
    );
    expect(t.coupons.map((c) => c.code)).toEqual(['L1', 'L2', 'L3']);
    expect(t.alerts).toEqual([
      { code: 'L1', amount_minor: 20000, currency: 'SAR' },
      { code: 'L3', amount_minor: 20000, currency: 'BHD' },
    ]);
  });

  it('an edit (PUT /coupons/{id}) is checked only on the fields it names', async () => {
    const t = new MockYiji2Transport();
    await translateV1AdminCall(t, '/api/Coupon/AddCoupon', amount(), {}, { currency: 'SAR' });
    expect(
      await translateV1AdminCall(
        t,
        '/api/Coupon/UpdateCoupon',
        { id: 500001, coupon: { code: 'K1', discount: 7 } },
        {},
        { currency: 'SAR' },
      ),
    ).toEqual({ result: 1 });
    await expect(
      translateV1AdminCall(
        t,
        '/api/Coupon/UpdateCoupon',
        { id: 500001, coupon: { code: 'K1', discountPercentage: 7 } },
        {},
        { currency: 'SAR' },
      ),
    ).rejects.toMatchObject({ code: 'percent_not_supported_on_v2' });
  });
});

describe('contract 2026-11-17 (3): grants the CRM did not create', () => {
  const setup = async () => {
    const t = new MockYiji2Transport();
    await translateV1AdminCall(
      t,
      '/api/Coupon/AddCoupon',
      { code: 'G1', discount: 5, reachLimit: 5, limitForUser: 1 },
      {},
      { currency: 'SAR' },
    );
    await translateV1AdminCall(
      t,
      '/api/CouponUser/AddUserCoupon',
      { couponId: 500001, userId: '2000000002' },
      {},
      { currency: 'SAR' },
    );
    return t;
  };

  it("DELETE of a grant that is not the CRM's is a recorded refusal (not_found), never success", async () => {
    const t = await setup();
    await expect(
      translateV1AdminCall(
        t,
        `/api/CouponUser/RemoveUserCoupon/${YIJI2_MOCK_FOREIGN_GRANT.grant_id}`,
        {},
        {},
        { currency: 'SAR' },
      ),
    ).rejects.toMatchObject({ code: 'not_found', status: 404 });
    expect(t.foreignGrants[0]?.removed).toBe(false);
    const connector = new Yiji2Connector(V2_VENDOR, mockSettings, { transport: t });
    const e = await connector.adminPost!(
      `/api/CouponUser/RemoveUserCoupon/${YIJI2_MOCK_FOREIGN_GRANT.grant_id}`,
      {},
      {},
    ).catch((x: unknown) => x);
    expect(isYijiRefused(e)).toBe(true);
    expect(e).toMatchObject({ status: 404 });
  });

  it('removing twice: the second DELETE is a 404 refusal', async () => {
    const t = await setup();
    expect(
      await translateV1AdminCall(
        t,
        '/api/CouponUser/RemoveUserCoupon/700001',
        {},
        {},
        {
          currency: 'SAR',
        },
      ),
    ).toEqual({ result: 1 });
    await expect(
      translateV1AdminCall(
        t,
        '/api/CouponUser/RemoveUserCoupon/700001',
        {},
        {},
        {
          currency: 'SAR',
        },
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('re-granting a removed grant answers 409 COUPON_INVALID, a recorded refusal', async () => {
    const t = await setup();
    await translateV1AdminCall(
      t,
      '/api/CouponUser/RemoveUserCoupon/700001',
      {},
      {},
      {
        currency: 'SAR',
      },
    );
    const connector = new Yiji2Connector(V2_VENDOR, mockSettings, { transport: t });
    const e = await connector.adminPost!(
      '/api/CouponUser/AddUserCoupon',
      { couponId: 500001, userId: '2000000002' },
      {},
    ).catch((x: unknown) => x);
    expect(isYijiRefused(e)).toBe(true);
    expect(e).toMatchObject({ status: 409 });
    expect((e as { body: { exceptionMessage: string } }).body.exceptionMessage).toMatch(
      /^COUPON_INVALID: /,
    );
  });

  it('POST /grants of a coupon the CRM did not create is a 404 refusal', async () => {
    const t = await setup();
    await expect(
      translateV1AdminCall(
        t,
        `/api/CouponUser/AddCouponToUserByCode/2000000002/${YIJI2_MOCK_FOREIGN_GRANT.code}`,
        {},
        {},
        { currency: 'SAR' },
      ),
    ).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });

  it('reads still return every grant, the foreign one included', async () => {
    const t = await setup();
    const all = await t.request<{ items: Array<{ grant_id: number; code: string }> }>(
      'GET',
      '/grants',
      { query: { customer_id: '2000000001' } },
    );
    expect(all?.items.map((g) => g.code)).toEqual([YIJI2_MOCK_FOREIGN_GRANT.code]);
    const byIds = await t.request<{ items: Array<{ grant_id: number }> }>('GET', '/grants', {
      query: { ids: `700001,${YIJI2_MOCK_FOREIGN_GRANT.grant_id}` },
    });
    /* newest first */
    expect(byIds?.items.map((g) => g.grant_id)).toEqual([700001, 600001]);
  });

  it('the HTTP transport: a 404 on a WRITE is not_found, on a READ null', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/auth/token')
        ? new Response(JSON.stringify({ access_token: 't', expires_in: 900 }), { status: 200 })
        : new Response('', { status: 404 }),
    );
    const t = new HttpYiji2Transport({
      apiBaseUrl: 'https://api.staging.yiji.app',
      clientId: 'id',
      clientSecret: 'secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(await t.request('GET', '/grants/1')).toBeNull();
    for (const method of ['POST', 'PUT', 'DELETE'] as const)
      await expect(t.request(method, '/grants/1', { body: {} })).rejects.toMatchObject({
        code: 'not_found',
        status: 404,
      });
  });

  it('the HTTP transport keeps the field v2 names on a 400', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/auth/token')
        ? new Response(JSON.stringify({ access_token: 't', expires_in: 900 }), { status: 200 })
        : new Response(
            JSON.stringify({
              error: { code: 'VALIDATION_FAILED', message_key: 'k', field: 'category' },
            }),
            { status: 400 },
          ),
    );
    const t = new HttpYiji2Transport({
      apiBaseUrl: 'https://api.staging.yiji.app',
      clientId: 'id',
      clientSecret: 'secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    await expect(t.request('POST', '/compensation-coupons', { body: {} })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      field: 'category',
    });
  });
});

describe('contract 2026-11-17 (4): POST /customers/{id}/push', () => {
  const push = (t: Yiji2Transport, body: Record<string, unknown>) =>
    translateV1AdminCall(
      t,
      'https://x/api/NotificationData/SendCrmNotification',
      body,
      {},
      {
        currency: 'SAR',
      },
    );

  it("'delivered' with a notification id is v1's success", async () => {
    const t = new MockYiji2Transport();
    expect(await push(t, { userId: '2000000001', title: 'T', body: 'b' })).toEqual({
      result: 1,
      extendedProperties: { NotificationId: 'ntf-1' },
    });
    expect(t.pushes[0]?.result).toBe('delivered');
  });

  it("'no_device' is v1's 'no registered FCM device token' refusal", async () => {
    const t = new MockYiji2Transport();
    await expect(push(t, { userId: '2000000003', title: 'T', body: 'b' })).rejects.toMatchObject({
      code: 'no_device',
      message: 'Customer has no registered FCM device token.',
    });
    expect(t.pushes[0]?.result).toBe('no_device');
    const connector = new Yiji2Connector(V2_VENDOR, mockSettings, { transport: t });
    const e = await connector.adminPost!(
      'https://x/api/NotificationData/SendCrmNotification',
      { userId: '2000000003', title: 'T', body: 'b' },
      {},
    ).catch((x: unknown) => x);
    expect(isYijiRefused(e)).toBe(true);
    expect((e as { body: { exceptionMessage: string } }).body.exceptionMessage).toMatch(
      /no registered FCM device token/i,
    );
  });

  it('an unknown customer is "Customer not found", the v1 words for a settled answer', async () => {
    const t = new MockYiji2Transport();
    await expect(push(t, { userId: '2999999999', title: 'T', body: 'b' })).rejects.toMatchObject({
      code: 'customer_not_found',
      message: expect.stringMatching(/customer not found/i),
    });
    await expect(
      push(t, { phoneNumber: '+966511111111', title: 'T', body: 'b' }),
    ).rejects.toMatchObject({
      code: 'customer_not_found',
    });
  });

  it('never sends the data keys topic or action; the mock refuses them like v2', async () => {
    expect(
      v2PushData({ data: { prop1: 'crm.openchat', conversationId: 'c1', source: 'sara-crm' } }),
    ).toEqual({
      prop1: 'crm.openchat',
      conversationId: 'c1',
      source: 'sara-crm',
    });
    expect(v2PushData({ data: { action: 'crm.openchat', topic: 7 } })).toEqual({
      prop1: 'crm.openchat',
    });
    expect(v2PushData({ action: 'x', data: { prop1: 'crm.openchat', topic: '7' } })).toEqual({
      prop1: 'crm.openchat',
    });
    const t = new MockYiji2Transport();
    await push(t, {
      userId: '2000000001',
      title: 'T',
      body: 'b',
      data: { action: 'crm.openchat', topic: 3, conversationId: 'c1' },
    });
    expect(t.pushes[0]?.body).toEqual({
      title: 'T',
      body: 'b',
      data: { prop1: 'crm.openchat', conversationId: 'c1' },
    });
    for (const k of ['topic', 'action'])
      await expect(
        t.request('POST', '/customers/2000000001/push', {
          body: { title: 'T', body: 'b', data: { [k]: 'x' } },
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 400, field: `data.${k}` });
  });
});

describe('contract 2026-11-17 (5): GET /grants paging', () => {
  it('findCustomerCoupon follows after_id through every page, newest first', async () => {
    const t = new MockYiji2Transport({ maxGrantPage: 2 });
    for (let i = 1; i <= 5; i++) {
      await translateV1AdminCall(
        t,
        '/api/Coupon/AddCoupon',
        { code: `PG-${i}`, discount: 5, reachLimit: 5, limitForUser: 1 },
        {},
        { currency: 'SAR' },
      );
      await translateV1AdminCall(
        t,
        '/api/CouponUser/AddUserCoupon',
        { couponId: 500000 + i, userId: '2000000001' },
        {},
        { currency: 'SAR' },
      );
    }
    const spy = vi.spyOn(t, 'request');
    const connector = new Yiji2Connector(V2_VENDOR, mockSettings, { transport: t });
    /* 6 grants (5 + the app's) at 2 a page: the oldest CRM grant is on page 3 */
    expect(await connector.findCustomerCoupon!('2000000001', 'PG-1')).toEqual({
      couponUserId: '700001',
      couponId: 500001,
    });
    const pages = spy.mock.calls.filter(([m, p]) => m === 'GET' && p === '/grants');
    expect(pages.map(([, , o]) => o?.query?.after_id)).toEqual([undefined, '700004', '700002']);
    /* the newest is on page 1 */
    spy.mockClear();
    expect(await connector.findCustomerCoupon!('2000000001', 'PG-5')).toMatchObject({
      couponUserId: '700005',
    });
    expect(spy.mock.calls.filter(([m, p]) => m === 'GET' && p === '/grants')).toHaveLength(1);
    /* the app's grant is read too; a code nobody holds walks to the end and answers null */
    expect(await connector.findCustomerCoupon!('2000000001', 'V2-APP-WELCOME')).toMatchObject({
      couponUserId: '600001',
    });
    expect(await connector.findCustomerCoupon!('2000000001', 'NOPE')).toBeNull();
  });

  it('a removed grant is not a held coupon', async () => {
    const t = new MockYiji2Transport();
    await translateV1AdminCall(
      t,
      '/api/Coupon/AddCoupon',
      { code: 'RM-1', discount: 5, reachLimit: 5, limitForUser: 1 },
      {},
      { currency: 'SAR' },
    );
    await translateV1AdminCall(
      t,
      '/api/CouponUser/AddUserCoupon',
      { couponId: 500001, userId: '2000000002' },
      {},
      { currency: 'SAR' },
    );
    await translateV1AdminCall(
      t,
      '/api/CouponUser/RemoveUserCoupon/700001',
      {},
      {},
      {
        currency: 'SAR',
      },
    );
    expect(await findGrantByCode(t, '2000000002', 'RM-1')).toBeNull();
  });

  it('stops at the page cap, on a cursor that does not move, and falls back when /grants is absent', async () => {
    let calls = 0;
    const endless: Yiji2Transport = {
      request: async <T>() => {
        calls++;
        return {
          items: [{ grant_id: 1_000_000 - calls, code: 'OTHER', state: 'active' }],
          next_after_id: 1_000_000 - calls,
        } as T;
      },
    };
    expect(await findGrantByCode(endless, '1', 'X')).toBeNull();
    expect(calls).toBe(YIJI2_GRANTS_MAX_PAGES);

    let stuck = 0;
    const stuckT: Yiji2Transport = {
      request: async <T>() => {
        stuck++;
        return { items: [{ grant_id: 5, code: 'OTHER' }], next_after_id: 5 } as T;
      },
    };
    expect(await findGrantByCode(stuckT, '1', 'X')).toBeNull();
    expect(stuck).toBe(2);

    const older: Yiji2Transport = {
      request: async <T>(_m: string, path: string) =>
        (path === '/grants'
          ? null
          : { id: 1, coupons: [{ grant_id: 9, coupon_id: 3, code: 'X', state: 'active' }] }) as T,
    };
    expect(await findGrantByCode(older, '1', 'X')).toMatchObject({ grant_id: 9 });
  });
});
