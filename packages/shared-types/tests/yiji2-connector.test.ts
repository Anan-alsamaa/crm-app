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
      visibility: 'private',
      discount: { kind: 'amount', amount: { amount_minor: 2500, currency: 'SAR' } },
    });
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
      coupon: { code: 'V2-IDEM', discount: 10 },
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
      { code: 'X1', type: 0, discountPercentage: 10, maximumDiscount: 30 },
      {},
      { currency: 'SAR' },
    );
    expect(a).toEqual({ result: 1, exceptionMessage: '500001', transactionStatus: 1 });
    expect(t.calls[0]).toMatchObject({ method: 'POST', path: '/compensation-coupons' });
    expect(t.coupons[0]?.body).toMatchObject({
      visibility: 'general',
      discount: { kind: 'percent', percent: 10, max: { amount_minor: 3000, currency: 'SAR' } },
    });
  });

  it('AddUserCoupon -> POST /grants; a second grant of the same coupon is refused', async () => {
    const t = new MockYiji2Transport();
    await translateV1AdminCall(
      t,
      '/api/Coupon/AddCoupon',
      { code: 'X2', discount: 5 },
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
      { code: 'X3', discount: 5 },
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
    expect(
      await translateV1AdminCall(
        t,
        '/api/CouponUser/RemoveUserCoupon/999',
        {},
        {},
        { currency: 'SAR' },
      ),
    ).toMatchObject({ result: 2 });
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
    ).toEqual({ result: 1 });
    expect(
      await translateV1AdminCall(
        t,
        'https://x/api/NotificationData/SendCrmNotification',
        { phoneNumber: '+966500000202', title: 'T', body: 'b' },
        {},
        { currency: 'SAR' },
      ),
    ).toEqual({ result: 1 });
    expect(t.pushes.map((p) => p.customer_id)).toEqual(['2000000001', '2000000002']);
    expect(t.pushes[0]?.body).toMatchObject({
      title: 'Yiji Support',
      body: 'hi',
      action: 'crm.openchat',
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

  it('a refusal is typed with v2 error code; 429 and 5xx are unavailable', async () => {
    const { t } = transport((url) => {
      if (url.endsWith('/auth/token')) return json(200, { access_token: 'tok', expires_in: 900 });
      if (url.includes('/refuse'))
        return json(422, { error: { code: 'invalid_discount', message: 'Too much.' } });
      if (url.includes('/slow')) return json(429, {}, { 'retry-after': '7' });
      return json(503, {});
    });
    await expect(t.request('POST', '/refuse', { body: {} })).rejects.toMatchObject({
      code: 'invalid_discount',
      status: 422,
    });
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
      environment: 'Yiji V2 (SA)',
    });
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
        placed_at: '2026-11-16T08:55:00Z',
        total: { amount_minor: 8800, currency: 'SAR' },
      },
    })!;
    expect(closed.order).toMatchObject({ status: 'delivered', isOpen: false, total: 88 });
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
