import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { createYijiClient } from '@yiji/shared-types';
import { verifyCaller, AuthError, type CallerVerifierDeps } from '../auth/index.js';

/**
 * Commerce proxy (C-2).
 *
 * The agent portal used to call the Yiji commerce API directly from the browser
 * with a bundled API token (VITE_YIJI_API_TOKEN) — exposing that credential to
 * anyone who loaded the JS. These routes move the call server-side: a verified
 * agent session is required, and the Yiji API key lives only in this service's
 * env. Read-only; responses are wrapped in `{ data }` so JSON is always valid
 * (including `null`).
 */

type Yiji = ReturnType<typeof createYijiClient>;

export interface CommerceDeps {
  directus: CallerVerifierDeps;
  yiji: Yiji;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export async function registerCommerceRoutes(
  app: FastifyInstance,
  deps: CommerceDeps,
): Promise<void> {
  /** Require a verified Directus agent session; replies + returns false on fail. */
  async function requireAgent(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    try {
      await verifyCaller(req, deps.directus);
      return true;
    } catch (err) {
      if (err instanceof AuthError) {
        app.log.warn({ ip: req.ip, reason: err.message }, 'commerce auth rejected');
        void reply.code(err.status).send({ error: err.message });
        return false;
      }
      throw err;
    }
  }

  app.get('/commerce/activity', async (req, reply) => {
    if (!(await requireAgent(req, reply))) return;
    const q = req.query as Record<string, string | undefined>;
    const vendorId = str(q.vendorId);
    const customerId = str(q.customerId);
    if (!vendorId || !customerId) return reply.code(400).send({ error: 'missing_params' });
    return reply.send({ data: await deps.yiji.getPurchaseActivity(vendorId, customerId) });
  });

  app.get('/commerce/orders', async (req, reply) => {
    if (!(await requireAgent(req, reply))) return;
    const q = req.query as Record<string, string | undefined>;
    const vendorId = str(q.vendorId);
    const customerId = str(q.customerId);
    if (!vendorId || !customerId) return reply.code(400).send({ error: 'missing_params' });
    const parsed = Number.parseInt(str(q.limit) || '6', 10);
    const limit = Math.min(Math.max(Number.isFinite(parsed) ? parsed : 6, 1), 50);
    return reply.send({ data: await deps.yiji.getOrders(vendorId, customerId, { limit }) });
  });

  app.get('/commerce/order', async (req, reply) => {
    if (!(await requireAgent(req, reply))) return;
    const q = req.query as Record<string, string | undefined>;
    const vendorId = str(q.vendorId);
    const orderId = str(q.orderId);
    if (!vendorId || !orderId) return reply.code(400).send({ error: 'missing_params' });
    return reply.send({ data: await deps.yiji.getOrder(vendorId, orderId) });
  });

  app.get('/commerce/payment', async (req, reply) => {
    if (!(await requireAgent(req, reply))) return;
    const q = req.query as Record<string, string | undefined>;
    const vendorId = str(q.vendorId);
    const orderId = str(q.orderId);
    if (!vendorId || !orderId) return reply.code(400).send({ error: 'missing_params' });
    return reply.send({ data: await deps.yiji.getPaymentStatus(vendorId, orderId) });
  });

  app.get('/commerce/shipment', async (req, reply) => {
    if (!(await requireAgent(req, reply))) return;
    const q = req.query as Record<string, string | undefined>;
    const vendorId = str(q.vendorId);
    const orderId = str(q.orderId);
    if (!vendorId || !orderId) return reply.code(400).send({ error: 'missing_params' });
    return reply.send({ data: await deps.yiji.getShipmentTracking(vendorId, orderId) });
  });
}
