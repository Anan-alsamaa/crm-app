import { describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerCommerceRoutes } from '../src/commerce/index.js';
import {
  ConnectorRegistry,
  EnvVendorSettingsSource,
  StaticVendorDirectory,
  YijiConnector,
  type YijiClient,
} from '@yiji/shared-types';

/**
 * YIJI V2 (owner, 2026-11-16): the commerce routes serve the v2 vendor
 * through its own connector, the cache keys carry the platform so v1 and v2
 * answers never mix, and the late-orders threshold is read per platform
 * (`late_delivery_minutes_yiji2`), v1's untouched.
 */
const AGENT_TOKEN = 'agent-session-token';
const auth = { authorization: `Bearer ${AGENT_TOKEN}` };

const v1Client = {
  getOrderCart: async (orderId: string) => ({ orderId, answeredBy: 'v1', lines: [] }),
  getOrder: async (_v: string, orderId: string) => ({
    orderId,
    status: 'v1',
    total: 1,
    currency: 'SAR',
    placedAt: '',
    items: [],
  }),
  getLateDeliveryOrders: async () => [],
} as unknown as YijiClient;

function build() {
  const lateDeliveryThreshold = vi.fn(async (platform?: string | null) =>
    platform === 'yiji2' ? 45 : 60,
  );
  const directus = {
    async whoAmI(token: string) {
      return token === AGENT_TOKEN ? { id: 'u-1', role: 'role-agent' } : null;
    },
    async adminRoleIds() {
      return new Set(['role-admin']);
    },
    lateDeliveryThreshold,
  };
  const connectors = new ConnectorRegistry({
    directory: new StaticVendorDirectory([
      { crmId: 'uuid-1', platformVendorId: '1', platform: 'yiji', status: 'active' },
      {
        crmId: 'uuid-2',
        platformVendorId: '2',
        platform: 'yiji2',
        status: 'active',
        name: 'Yiji V2',
      },
      {
        crmId: 'uuid-3',
        platformVendorId: '3',
        platform: 'yiji2',
        status: 'inactive',
        name: 'Yiji V2 BH',
      },
    ]),
    settings: new EnvVendorSettingsSource(
      { platform: 'yiji', client: {} },
      { yiji2: { platform: 'yiji2', mock: true, tenantId: '2' } },
    ),
    legacyVendorKey: '1',
    factories: {
      yiji: (vendor, settings) => new YijiConnector(vendor, settings, { client: v1Client }),
    },
  });
  const app: FastifyInstance = Fastify();
  return registerCommerceRoutes(app, { directus, connectors }).then(() => ({
    app,
    lateDeliveryThreshold,
  }));
}

describe('commerce routes with the v2 tenant', () => {
  it('answers a v2 order from the v2 connector (v2 shapes: string order number, major-unit money)', async () => {
    const { app } = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/commerce/order?vendorId=2&orderId=2611000000001',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      orderId: '2611000000001',
      status: 'in_delivery',
      currency: 'SAR',
      total: 90,
    });
    await app.close();
  });

  it('keeps v1 and v2 answers for the same order id in different cache entries', async () => {
    const { app } = await build();
    const v1 = await app.inject({
      method: 'GET',
      url: '/commerce/cart?vendorId=1&orderId=2611000000001',
      headers: auth,
    });
    const v2 = await app.inject({
      method: 'GET',
      url: '/commerce/cart?vendorId=2&orderId=2611000000001',
      headers: auth,
    });
    expect(v1.json().data).toMatchObject({ answeredBy: 'v1' });
    expect(v2.json().data.answeredBy).toBeUndefined();
    expect(v2.json().data.lines[0]).toMatchObject({ name: 'Classic burger', price: 32 });
    await app.close();
  });

  it('reads the late threshold for the request’s PLATFORM; a request with no vendor is v1’s', async () => {
    const { app, lateDeliveryThreshold } = await build();
    const v2 = await app.inject({
      method: 'GET',
      url: '/commerce/late-orders?vendorId=2',
      headers: auth,
    });
    expect(v2.statusCode).toBe(200);
    expect(v2.json().data.thresholdMinutes).toBe(45);
    const v1 = await app.inject({
      method: 'GET',
      url: '/commerce/late-orders?vendorId=1',
      headers: auth,
    });
    expect(v1.json().data.thresholdMinutes).toBe(60);
    const legacy = await app.inject({ method: 'GET', url: '/commerce/late-orders', headers: auth });
    expect(legacy.json().data.thresholdMinutes).toBe(60);
    expect(lateDeliveryThreshold.mock.calls.map((c) => c[0])).toEqual(['yiji2', 'yiji', undefined]);
    await app.close();
  });

  it('an inactive v2 vendor is a 404 unknown_vendor, never another vendor’s data', async () => {
    const { app } = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/commerce/order?vendorId=3&orderId=2611000000001',
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('unknown_vendor');
    await app.close();
  });
});
