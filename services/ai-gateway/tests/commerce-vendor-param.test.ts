import { describe, expect, it } from 'vitest';
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
 * MV-1 (EMA-70): the four commerce routes that named no vendor - the
 * late-orders queue, the cart, the service-time batch and customer-exists -
 * take an OPTIONAL `vendorId`. Named, it picks that vendor's connector (an
 * unknown one is a 404, never another vendor's data). Absent, the legacy
 * vendor answers, so a portal bundle parked behind "Update now" is unchanged.
 */

const AGENT_TOKEN = 'agent-session-token';
const auth = { authorization: `Bearer ${AGENT_TOKEN}` };

const directus = {
  async whoAmI(token: string) {
    return token === AGENT_TOKEN ? { id: 'u-1', role: 'role-agent' } : null;
  },
  async adminRoleIds() {
    return new Set(['role-admin']);
  },
  async lateDeliveryThreshold() {
    return 60;
  },
};

/** A fake platform client that says which vendor answered. */
function clientFor(tag: string) {
  return {
    getOrderCart: async (orderId: string) => ({ orderId, answeredBy: tag, lines: [] }),
    getLateDeliveryOrders: async () => [{ orderId: `late-${tag}` }],
    getOrderTimeline: async (_v: string, orderId: string) => ({
      orderId,
      derived: false,
      events: [{ status: `seen-by-${tag}`, at: '2026-10-08T10:00:00Z' }],
    }),
  } as unknown as YijiClient;
}

function twoVendorApp(): Promise<FastifyInstance> {
  const clients: Record<string, YijiClient> = { '1': clientFor('yiji'), '2': clientFor('second') };
  const connectors = new ConnectorRegistry({
    directory: new StaticVendorDirectory([
      { crmId: 'uuid-1', platformVendorId: '1', platform: 'yiji', status: 'active' },
      { crmId: 'uuid-2', platformVendorId: '2', platform: 'yiji', status: 'active' },
    ]),
    settings: new EnvVendorSettingsSource({ platform: 'yiji', client: {} }),
    legacyVendorKey: '1',
    factories: {
      yiji: (vendor, settings) =>
        new YijiConnector(vendor, settings, {
          client: clients[vendor.platformVendorId]!,
          findCustomerIdByPhone: async () => `cust-of-${vendor.platformVendorId}`,
        }),
    },
  });
  const app = Fastify();
  return registerCommerceRoutes(app, { directus, connectors }).then(() => app);
}

const get = async (app: FastifyInstance, url: string) =>
  app.inject({ method: 'GET', url, headers: auth });

describe('commerce routes honour an explicit vendorId (MV-1)', () => {
  it('cart: the named vendor answers; no vendor = the legacy vendor', async () => {
    const app = await twoVendorApp();
    expect(
      (await get(app, '/commerce/cart?orderId=O-1&vendorId=uuid-2')).json().data,
    ).toMatchObject({ answeredBy: 'second' });
    expect((await get(app, '/commerce/cart?orderId=O-1&vendorId=2')).json().data).toMatchObject({
      answeredBy: 'second',
    });
    expect((await get(app, '/commerce/cart?orderId=O-1')).json().data).toMatchObject({
      answeredBy: 'yiji',
    });
  });

  it('cart: the vendor is part of the cache key, so one vendor never sees another’s cart', async () => {
    const app = await twoVendorApp();
    await get(app, '/commerce/cart?orderId=O-1');
    expect((await get(app, '/commerce/cart?orderId=O-1&vendorId=2')).json().data.answeredBy).toBe(
      'second',
    );
  });

  it('late-orders: the named vendor’s queue', async () => {
    const app = await twoVendorApp();
    const named = await get(app, '/commerce/late-orders?vendorId=uuid-2');
    expect(named.statusCode).toBe(200);
    expect(named.json().data.rows).toEqual([{ orderId: 'late-second' }]);
    const legacy = await get(app, '/commerce/late-orders');
    expect(legacy.json().data.rows).toEqual([{ orderId: 'late-yiji' }]);
  });

  it('service-times: the named vendor’s order history', async () => {
    const app = await twoVendorApp();
    const named = await get(app, '/commerce/service-times?orderIds=A,B&vendorId=2');
    expect(named.json().data).toEqual({
      A: { 'seen-by-second': '2026-10-08T10:00:00Z' },
      B: { 'seen-by-second': '2026-10-08T10:00:00Z' },
    });
    const legacy = await get(app, '/commerce/service-times?orderIds=A');
    expect(legacy.json().data).toEqual({ A: { 'seen-by-yiji': '2026-10-08T10:00:00Z' } });
  });

  it('customer-exists: looks the phone up on the named vendor’s platform', async () => {
    const app = await twoVendorApp();
    const named = await get(app, '/commerce/customer-exists?phone=0540000000&vendorId=uuid-2');
    expect(named.json().data).toEqual({ configured: true, exists: true, customerId: 'cust-of-2' });
    const legacy = await get(app, '/commerce/customer-exists?phone=0540000000');
    expect(legacy.json().data.customerId).toBe('cust-of-1');
  });

  it('an unknown vendorId is a 404 on all four, never the legacy vendor’s data', async () => {
    const app = await twoVendorApp();
    for (const url of [
      '/commerce/cart?orderId=O-1&vendorId=nope',
      '/commerce/late-orders?vendorId=nope',
      '/commerce/service-times?orderIds=A&vendorId=nope',
      '/commerce/customer-exists?phone=0540000000&vendorId=nope',
    ]) {
      const res = await get(app, url);
      expect(res.statusCode, url).toBe(404);
      expect(res.json(), url).toEqual({ error: 'unknown_vendor' });
    }
  });
});
