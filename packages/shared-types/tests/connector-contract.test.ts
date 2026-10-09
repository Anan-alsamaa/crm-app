import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createEnvConnectorRegistry,
  createYijiAdminPoster,
  createYijiClient,
  createYijiCustomerFinder,
  createYijiLatestBrandReader,
  createYijiLatestOrderReader,
  createYijiOrderReader,
  createYijiUserCouponFinder,
  createYijiUserReader,
  type VendorConnector,
  type VendorIntegrationRow,
  type YijiClientEnv,
  type YijiPlatformSettings,
} from '../src/index.js';

/**
 * THE CONNECTOR SENDS BYTE-IDENTICAL REQUESTS TO THE CODE IT REPLACED (MV-2).
 *
 * Each case runs one operation twice against a recording `fetch`: once the way
 * a service called Yiji before the registry existed (the `createYiji*`
 * factories, built from that service's env), once through
 * `registry.connectorFor('1')`. URL, method, every header (incl. the bearer,
 * the admin login and `tenantid`) and the body must match exactly, in order.
 */

interface Recorded {
  url: string;
  method: string;
  headers: Array<[string, string]>;
  body: string | null;
}

const RAW_ORDER = {
  id: 1334028,
  userId: 'u-guid',
  customerPhoneNumber: '+966540041059',
  customerName: 'Sara',
  brandName: 'Casa Pasta',
  restaurantId: 4,
  brandId: 1,
  tenantId: 1,
  creationTime: '2026-10-08T10:00:00',
  orderStatus: 6,
  total: 50,
  orderDetails: [],
};

function respond(url: string, method: string): unknown {
  if (url.endsWith('/api/Account/login')) return { token: 'admin-token' };
  if (url.includes('/GetOrderByUser/')) return [RAW_ORDER];
  if (url.includes('/GetOrderAsync/')) return RAW_ORDER;
  if (url.includes('/GetOrderStatusHistoriesByOrderId/')) {
    return [{ orderStatus: 2, creationTime: '2026-10-08T10:01:00' }];
  }
  if (url.includes('/GetOrderCart/')) return { order: { id: 1334028, orderItems: [] } };
  if (url.includes('/GetFilteredOrders')) return [];
  if (url.includes('/GetfilteredCustomers'))
    return [{ id: 'u-guid', phoneNumber: '+966540041059' }];
  if (url.includes('/GetUserById/')) return { id: 'u-guid', phoneNumber: '+966540041059' };
  if (url.includes('/GetCouponByUser/')) return [{ id: 77, couponId: 9, couponCode: 'OPS-1' }];
  if (method === 'POST') return { isSuccess: true };
  return null;
}

let recorded: Recorded[] = [];
const fetchOriginal = global.fetch;

beforeEach(() => {
  recorded = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-08T12:00:00Z'));
  global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    recorded.push({
      url,
      method,
      headers: [...new Headers(init?.headers).entries()].sort(([a], [b]) => a.localeCompare(b)),
      body: typeof init?.body === 'string' ? init.body : null,
    });
    return new Response(JSON.stringify(respond(url, method)), { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = fetchOriginal;
  vi.useRealTimers();
});

const ORDER_API: YijiClientEnv = { apiUrl: 'https://order.example', token: 'order-key' };
const ADMIN = {
  adminApiUrl: 'https://admin.example',
  adminEmail: 'svc@example.com',
  adminPassword: 'pw',
};
/** ai-gateway: the commerce client carries the order-API token. */
const AI_GATEWAY_ENV: YijiClientEnv = { ...ORDER_API, ...ADMIN };
/** workers / socket-gateway: the readers were built WITHOUT the token. */
const NO_TOKEN_ENV: YijiClientEnv = { apiUrl: 'https://order.example', ...ADMIN };

async function capture(fn: () => Promise<unknown>): Promise<Recorded[]> {
  recorded = [];
  await fn();
  return recorded;
}

async function connector(env: YijiClientEnv): Promise<VendorConnector> {
  return createEnvConnectorRegistry({ vendorId: '1', yiji: { client: env } }).connectorFor('1');
}

const cases: Array<[string, (c: VendorConnector) => Promise<unknown>, () => Promise<unknown>]> = [
  [
    'getOrders',
    (c) => c.getOrders('u-guid', { limit: 2 }),
    () => createYijiClient(AI_GATEWAY_ENV).getOrders('1', 'u-guid', { limit: 2 }),
  ],
  [
    'getOrder',
    (c) => c.getOrder('1334028'),
    () => createYijiClient(AI_GATEWAY_ENV).getOrder('1', '1334028'),
  ],
  [
    'getOrderTimeline',
    (c) => c.getOrderTimeline('1334028'),
    () => createYijiClient(AI_GATEWAY_ENV).getOrderTimeline('1', '1334028'),
  ],
  [
    'getOrderTimeline (service-times sent an empty vendor)',
    (c) => c.getOrderTimeline('1334028'),
    () => createYijiClient(AI_GATEWAY_ENV).getOrderTimeline('', '1334028'),
  ],
  [
    'getOrderCart',
    (c) => c.getOrderCart('1334028'),
    () => createYijiClient(AI_GATEWAY_ENV).getOrderCart('1334028'),
  ],
  [
    'getPaymentStatus',
    (c) => c.getPaymentStatus('1334028'),
    () => createYijiClient(AI_GATEWAY_ENV).getPaymentStatus('1', '1334028'),
  ],
  [
    'getPurchaseActivity',
    (c) => c.getPurchaseActivity('u-guid'),
    () => createYijiClient(AI_GATEWAY_ENV).getPurchaseActivity('1', 'u-guid'),
  ],
  [
    'getLateDeliveryOrders (live queue)',
    (c) => c.getLateDeliveryOrders(45),
    () => createYijiClient(AI_GATEWAY_ENV).getLateDeliveryOrders(45),
  ],
  [
    'getLateDeliveryOrders (history window)',
    (c) =>
      c.getLateDeliveryOrders(60, {
        from: '2026-09-01',
        to: '2026-09-30',
        includeCompleted: true,
        maxPages: 200,
      }),
    () =>
      createYijiClient(AI_GATEWAY_ENV).getLateDeliveryOrders(60, {
        from: '2026-09-01',
        to: '2026-09-30',
        includeCompleted: true,
        maxPages: 200,
      }),
  ],
  [
    'findCustomerIdByPhone (customer-exists)',
    (c) => c.findCustomerIdByPhone!('0540041059'),
    () =>
      createYijiCustomerFinder({
        apiUrl: 'https://order.example',
        ...ADMIN,
      })!('0540041059'),
  ],
];

describe('YijiConnector request contract (ai-gateway commerce routes)', () => {
  for (const [name, viaConnector, legacy] of cases) {
    it(name, async () => {
      const before = await capture(legacy);
      const c = await connector(AI_GATEWAY_ENV);
      const after = await capture(() => viaConnector(c));
      expect(before.length).toBeGreaterThan(0);
      expect(after).toEqual(before);
    });
  }

  it('returns the same answers, not only the same requests', async () => {
    const c = await connector(AI_GATEWAY_ENV);
    expect(await c.getOrder('1334028')).toEqual(
      await createYijiClient(AI_GATEWAY_ENV).getOrder('1', '1334028'),
    );
    expect(await c.getOrders('u-guid')).toEqual(
      await createYijiClient(AI_GATEWAY_ENV).getOrders('1', 'u-guid'),
    );
  });
});

describe('YijiConnector request contract (workers: coupon + push)', () => {
  it('coupon create/assign POST: path, tenantid header, body', async () => {
    const body = { orderId: 1334028, code: 'OPS-1', value: 20 };
    const before = await capture(() =>
      createYijiAdminPoster(NO_TOKEN_ENV)!('/api/CouponUserOrder/CreateCouponUserFromOrder', body, {
        tenantid: '1',
      }),
    );
    const c = await connector(NO_TOKEN_ENV);
    const after = await capture(() =>
      c.adminPost!('/api/CouponUserOrder/CreateCouponUserFromOrder', body, { tenantid: '1' }),
    );
    expect(after).toEqual(before);
    const post = after.find((r) => r.method === 'POST' && r.url.includes('CreateCoupon'));
    expect(post?.headers).toContainEqual(['tenantid', '1']);
    expect(post?.body).toBe(JSON.stringify(body));
  });

  it('customer push POST to an absolute notification URL', async () => {
    const url = 'https://notify.example/api/NotificationData/SendCrmNotification';
    const body = { tenantId: 1, brandId: 1, title: 'Yiji Support' };
    const before = await capture(() =>
      createYijiAdminPoster(NO_TOKEN_ENV)!(url, body, { 'idempotency-key': 'k1' }),
    );
    const c = await connector(NO_TOKEN_ENV);
    const after = await capture(() => c.adminPost!(url, body, { 'idempotency-key': 'k1' }));
    expect(after).toEqual(before);
  });

  it('coupon order context (readOrder)', async () => {
    const before = await capture(() => createYijiOrderReader(NO_TOKEN_ENV)!('1334028'));
    const c = await connector(NO_TOKEN_ENV);
    expect(await capture(() => c.readCouponOrderContext!('1334028'))).toEqual(before);
  });

  it('customer by phone (order-less coupon, signup watch)', async () => {
    const before = await capture(() => createYijiCustomerFinder(NO_TOKEN_ENV)!('0540041059'));
    const c = await connector(NO_TOKEN_ENV);
    expect(await capture(() => c.findCustomerIdByPhone!('0540041059'))).toEqual(before);
  });

  it('coupon read-back (findUserCoupon)', async () => {
    const before = await capture(() =>
      createYijiUserCouponFinder(NO_TOKEN_ENV)!('u-guid', 'OPS-1'),
    );
    const c = await connector(NO_TOKEN_ENV);
    expect(await capture(() => c.findCustomerCoupon!('u-guid', 'OPS-1'))).toEqual(before);
  });

  it("push brand: the latest order's brand name", async () => {
    const before = await capture(() => createYijiLatestBrandReader(NO_TOKEN_ENV)!('1', 'u-guid'));
    const c = await connector(NO_TOKEN_ENV);
    expect(await capture(() => c.latestOrderBrandName!('u-guid'))).toEqual(before);
    expect(await c.latestOrderBrandName!('u-guid')).toBe('Casa Pasta');
  });
});

describe('YijiConnector request contract (socket-gateway)', () => {
  it('customer profile by the Yiji user id (app session token)', async () => {
    const before = await capture(() => createYijiUserReader(NO_TOKEN_ENV)!('u-guid'));
    const c = await connector(NO_TOKEN_ENV);
    expect(await capture(() => c.getCustomerProfile!('u-guid'))).toEqual(before);
  });

  it('latest order id (WhatsApp fallback)', async () => {
    const before = await capture(() => createYijiLatestOrderReader(NO_TOKEN_ENV)!('u-guid'));
    const c = await connector(NO_TOKEN_ENV);
    expect(await capture(() => c.latestOrderId!('u-guid'))).toEqual(before);
    // No order-API bearer on this path, before or after.
    expect(before[0]?.headers.some(([k]) => k === 'authorization')).toBe(false);
  });
});

/**
 * MV-7: THE SAME BYTES WITH THE SETTINGS COMING FROM THE VENDOR RECORD.
 *
 * The service env keeps only the credentials (URLs and tenant blank); the
 * Yiji vendor row supplies `api_base_url`, `admin_api_url` and `tenant_id`.
 * Every request must equal the legacy call built from the full env.
 */
const YIJI_ROW: VendorIntegrationRow = {
  id: 'uuid-yiji',
  yiji_vendor_id: '1',
  webhook_path_key: 'yiji',
  api_base_url: 'https://order.example',
  admin_api_url: 'https://admin.example',
  tenant_id: '1',
  brand_id: null,
  notify_settings: null,
};

function withoutUrls(env: YijiClientEnv): YijiClientEnv {
  const creds: YijiClientEnv = { ...env };
  delete creds.apiUrl;
  delete creds.adminApiUrl;
  return creds;
}

async function connectorFromRecord(
  env: YijiClientEnv,
  extra: Partial<Omit<YijiPlatformSettings, 'platform' | 'client'>> = {},
  row: VendorIntegrationRow = YIJI_ROW,
): Promise<VendorConnector> {
  return createEnvConnectorRegistry({
    vendorId: '1',
    loadVendors: async () => [
      { crmId: row.id, platformVendorId: '1', platform: 'yiji', status: 'active', name: 'Yiji' },
    ],
    loadIntegration: async () => [row],
    yiji: { client: withoutUrls(env), ...extra },
  }).connectorFor('1');
}

describe('YijiConnector request contract, settings from the vendor record (MV-7)', () => {
  for (const [name, viaConnector, legacy] of cases) {
    it(`ai-gateway: ${name}`, async () => {
      const before = await capture(legacy);
      const c = await connectorFromRecord(AI_GATEWAY_ENV);
      const after = await capture(() => viaConnector(c));
      expect(before.length).toBeGreaterThan(0);
      expect(after).toEqual(before);
    });
  }

  it('the record really is the source: env URLs are blank', async () => {
    const c = await connectorFromRecord(NO_TOKEN_ENV);
    expect(c.settings).toMatchObject({
      platform: 'yiji',
      client: { apiUrl: 'https://order.example', adminApiUrl: 'https://admin.example' },
      tenantId: '1',
    });
  });

  it('workers: coupon create/assign POST with the record tenant', async () => {
    const body = { orderId: 1334028, code: 'OPS-1', value: 20 };
    const before = await capture(() =>
      createYijiAdminPoster(NO_TOKEN_ENV)!('/api/CouponUserOrder/CreateCouponUserFromOrder', body, {
        tenantid: '1',
      }),
    );
    const c = await connectorFromRecord(NO_TOKEN_ENV);
    const tenant = (c.settings as YijiPlatformSettings).tenantId ?? '1';
    const after = await capture(() =>
      c.adminPost!('/api/CouponUserOrder/CreateCouponUserFromOrder', body, { tenantid: tenant }),
    );
    expect(after).toEqual(before);
  });

  it('workers: push, order context, phone lookup, coupon read-back, brand', async () => {
    const url = 'https://notify.example/api/NotificationData/SendCrmNotification';
    const push = { tenantId: 1, brandId: 1, title: 'Yiji Support' };
    const legacy = async () => {
      await createYijiAdminPoster(NO_TOKEN_ENV)!(url, push, { 'idempotency-key': 'k1' });
      await createYijiOrderReader(NO_TOKEN_ENV)!('1334028');
      await createYijiCustomerFinder(NO_TOKEN_ENV)!('0540041059');
      await createYijiUserCouponFinder(NO_TOKEN_ENV)!('u-guid', 'OPS-1');
      await createYijiLatestBrandReader(NO_TOKEN_ENV)!('1', 'u-guid');
    };
    const before = await capture(legacy);
    const c = await connectorFromRecord(NO_TOKEN_ENV);
    const after = await capture(async () => {
      await c.adminPost!(url, push, { 'idempotency-key': 'k1' });
      await c.readCouponOrderContext!('1334028');
      await c.findCustomerIdByPhone!('0540041059');
      await c.findCustomerCoupon!('u-guid', 'OPS-1');
      await c.latestOrderBrandName!('u-guid');
    });
    expect(after).toEqual(before);
  });

  it('socket-gateway paths: customer profile, latest order id', async () => {
    const before = await capture(async () => {
      await createYijiUserReader(NO_TOKEN_ENV)!('u-guid');
      await createYijiLatestOrderReader(NO_TOKEN_ENV)!('u-guid');
    });
    const c = await connectorFromRecord(NO_TOKEN_ENV);
    const after = await capture(async () => {
      await c.getCustomerProfile!('u-guid');
      await c.latestOrderId!('u-guid');
    });
    expect(after).toEqual(before);
  });

  it('a record with no settings leaves the env settings untouched', async () => {
    const env = { ...AI_GATEWAY_ENV };
    const c = await createEnvConnectorRegistry({
      vendorId: '1',
      loadIntegration: async () => [{ id: 'uuid-yiji', yiji_vendor_id: '1' }],
      yiji: { client: env, tenantId: '1', brandId: '3' },
    }).connectorFor('1');
    expect(c.settings).toEqual({ platform: 'yiji', client: env, tenantId: '1', brandId: '3' });
    const before = await capture(() => createYijiClient(AI_GATEWAY_ENV).getOrder('1', '1334028'));
    expect(await capture(() => c.getOrder('1334028'))).toEqual(before);
  });

  it('a failed record read falls back to env (logged), commerce unbroken', async () => {
    const onSettingsFallback = vi.fn();
    const c = await createEnvConnectorRegistry({
      vendorId: '1',
      loadIntegration: async () => {
        throw new Error('403 forbidden');
      },
      onSettingsFallback,
      yiji: { client: AI_GATEWAY_ENV },
    }).connectorFor('1');
    expect(onSettingsFallback).toHaveBeenCalledTimes(1);
    const before = await capture(() => createYijiClient(AI_GATEWAY_ENV).getOrder('1', '1334028'));
    expect(await capture(() => c.getOrder('1334028'))).toEqual(before);
  });
});
