import { describe, expect, it, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerCommerceRoutes } from '../src/commerce/index.js';
import type { CallerVerifierDeps } from '../src/auth/index.js';

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
  getPaymentStatus: async () => ({ status: 'captured' }),
  getShipmentTracking: async () => null,
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerCommerceRoutes(app, { directus, yiji });
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
});
