import type { FastifyInstance } from 'fastify';
import { SOCKET_EVENTS, rooms } from '@yiji/shared-types';

/**
 * THE LATE-ORDERS QUEUE CHANGED - tell every open screen (owner, 2026-10-12).
 *
 * The workers' poller asks Yiji once a minute and keeps the answer in Redis.
 * It holds no socket, so when what an agent would see has changed it calls
 * this, and every agent's portal refetches the page from that snapshot at
 * once instead of waiting for its slow safety-net poll.
 *
 * Broadcast to `agents:all` - the same room `inbox:activity` uses. The payload
 * names the vendor and the build time only; the rows are fetched through the
 * gateway, which checks the session, so this leaks nothing to a socket that
 * could not already read the queue.
 *
 * Service-token only, like `/jobs/notify-push`: it makes every agent's screen
 * refetch, which no agent may trigger for the others.
 */
export function registerLateOrdersPushRoute(
  app: FastifyInstance,
  opts: {
    serviceToken: string | undefined;
    emitToAgents: (event: string, payload: unknown) => void;
  },
): void {
  app.post('/jobs/late-orders-changed', async (req, reply) => {
    const raw = req.headers['authorization'];
    const header = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
    const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    if (!token || !opts.serviceToken || token !== opts.serviceToken)
      return reply.code(403).send({ ok: false, error: 'service token required' });
    const body = (req.body ?? {}) as { vendorKey?: unknown; builtAt?: unknown };
    opts.emitToAgents(SOCKET_EVENTS.lateOrdersChanged, {
      vendorKey: typeof body.vendorKey === 'string' ? body.vendorKey : null,
      builtAt: typeof body.builtAt === 'string' ? body.builtAt : null,
    });
    return reply.send({ ok: true });
  });
}

/** The room the push goes to, exported for the test. */
export const LATE_ORDERS_PUSH_ROOM = rooms.agentsAll();
