import { describe, expect, it, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerCommerceRoutes } from '../src/commerce/index.js';
import type { CallerVerifierDeps } from '../src/auth/index.js';
import { createEnvConnectorRegistry, YijiConnector } from '@yiji/shared-types';
import { connectorsFor, dbConnectorsFor } from './connectors-fixture.js';

const AGENT_TOKEN = 'agent-session-token';

const directus: CallerVerifierDeps = {
  async whoAmI(token: string) {
    return token === AGENT_TOKEN ? { id: 'u-1', role: 'role-agent' } : null;
  },
  async adminRoleIds() {
    return new Set(['role-admin']);
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const yiji: any = {
  getPurchaseActivity: async () => ({ lifetimeValue: 100, orderCount: 2, lastOrderAt: null }),
  getOrders: async (_v: string, _c: string, opts: { limit?: number }) =>
    Array.from({ length: opts.limit ?? 6 }, (_, i) => ({ orderId: `O-${i}` })),
  getOrder: async (_v: string, orderId: string) =>
    orderId === 'O-1'
      ? {
          orderId: 'O-1',
          status: 'shipped',
          total: 50,
          currency: 'SAR',
          placedAt: '2026-01-01T00:00:00Z',
          items: [],
        }
      : null,
  getPaymentStatus: async () => ({ status: 'captured' }),
  getShipmentTracking: async () => null,
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerCommerceRoutes(app, { directus, connectors: connectorsFor(yiji) });
  return app;
}

const auth = { authorization: `Bearer ${AGENT_TOKEN}` };

describe('commerce proxy', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildApp();
  });

  it('rejects requests without a valid session (no browser token)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/commerce/orders?vendorId=v1&customerId=c1',
    });
    expect(res.statusCode).toBe(401);

    const bad = await app.inject({
      method: 'GET',
      url: '/commerce/orders?vendorId=v1&customerId=c1',
      headers: { authorization: 'Bearer nope' },
    });
    expect(bad.statusCode).toBe(401);
  });

  it('400s on missing params', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/commerce/orders?vendorId=v1',
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns wrapped data for a verified agent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/commerce/activity?vendorId=v1&customerId=c1',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.lifetimeValue).toBe(100);
  });

  it('clamps the orders limit to [1,50]', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/commerce/orders?vendorId=v1&customerId=c1&limit=999',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(50);
  });

  it('GET /commerce/order returns a single order by id (400 without orderId)', async () => {
    const ok = await app.inject({
      method: 'GET',
      url: '/commerce/order?vendorId=v1&orderId=O-1',
      headers: auth,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.orderId).toBe('O-1');

    const missing = await app.inject({
      method: 'GET',
      url: '/commerce/order?vendorId=v1',
      headers: auth,
    });
    expect(missing.statusCode).toBe(400);
  });

  /*
   * MV-2: a vendor the registry does not know is a 404, never another
   * vendor's orders. Before the connector layer every vendorId was silently
   * answered from Yiji.
   */
  it('answers an unknown vendor with 404 unknown_vendor on every vendor route', async () => {
    for (const url of [
      '/commerce/orders?vendorId=v2&customerId=c1',
      '/commerce/activity?vendorId=v2&customerId=c1',
      '/commerce/order?vendorId=v2&orderId=O-1',
      '/commerce/inbox?vendorId=v2&customerId=c1',
      '/commerce/tracking?vendorId=v2&orderId=O-1',
      '/commerce/payment?vendorId=v2&orderId=O-1',
      '/commerce/shipment?vendorId=v2&orderId=O-1',
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: auth });
      expect(res.statusCode, url).toBe(404);
      expect(res.json(), url).toEqual({ error: 'unknown_vendor' });
    }
  });

  /*
   * The portals send BOTH forms: the late-orders page and the new-ticket page
   * pass the vendor's CRM UUID (`vendors.data[0].id`), the inbox and tickets
   * pass `yiji_vendor_id`. Old bundles stay live behind "Update now", so the
   * server must answer both.
   */
  describe('with the vendors table (production shape)', () => {
    const UUID = '0b6f9a52-7c1e-4a8e-9f3e-2f6d1c0a9e11';
    const rows = [{ id: UUID, yiji_vendor_id: '1', status: 'active', name: 'Yiji' }];

    async function dbApp(onFallback?: (err: unknown) => void) {
      const a = Fastify();
      await registerCommerceRoutes(a, {
        directus,
        connectors: dbConnectorsFor(yiji, rows, onFallback),
      });
      return a;
    }

    it('answers the CRM UUID and the yiji_vendor_id alike (not 404)', async () => {
      const a = await dbApp();
      for (const v of [UUID, '1']) {
        const order = await a.inject({
          method: 'GET',
          url: `/commerce/order?vendorId=${v}&orderId=O-1`,
          headers: auth,
        });
        expect(order.statusCode, v).toBe(200);
        expect(order.json().data.orderId, v).toBe('O-1');
        const orders = await a.inject({
          method: 'GET',
          url: `/commerce/orders?vendorId=${v}&customerId=c1&limit=2`,
          headers: auth,
        });
        expect(orders.statusCode, v).toBe(200);
        expect(orders.json().data, v).toHaveLength(2);
      }
    });

    it('a failing vendors read still serves "1" (env fallback) and logs it', async () => {
      const a = Fastify();
      const errors: unknown[] = [];
      await registerCommerceRoutes(a, {
        directus,
        connectors: createEnvConnectorRegistry({
          yiji: { client: {} },
          loadVendors: async () => {
            throw new Error('403 FORBIDDEN on vendors');
          },
          onDirectoryFallback: (e) => errors.push(e),
          factories: {
            yiji: (v, s) => new YijiConnector(v, s, { client: yiji }),
          },
        }),
      });
      const res = await a.inject({
        method: 'GET',
        url: '/commerce/order?vendorId=1&orderId=O-1',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  it('customer-exists reports configured:false when the vendor has no phone lookup', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/commerce/customer-exists?phone=0540041059',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ configured: false, exists: false, customerId: null });
  });
});
