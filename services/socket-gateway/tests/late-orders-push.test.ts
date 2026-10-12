import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { SOCKET_EVENTS } from '@yiji/shared-types';
import { registerLateOrdersPushRoute, LATE_ORDERS_PUSH_ROOM } from '../src/late-orders-push.js';

/**
 * OPTION 2 (owner, 2026-10-12): the workers' poller calls this when today's
 * late-orders queue changed, and every agent's screen is told to refetch.
 */
async function build() {
  const emitToAgents = vi.fn();
  const app = Fastify();
  registerLateOrdersPushRoute(app, { serviceToken: 'svc-token', emitToAgents });
  await app.ready();
  return { app, emitToAgents };
}

describe('POST /jobs/late-orders-changed', () => {
  it('broadcasts late-orders:changed to every agent with the vendor and build time', async () => {
    const { app, emitToAgents } = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/jobs/late-orders-changed',
      headers: { authorization: 'Bearer svc-token' },
      payload: { vendorKey: 'yiji:1', builtAt: '2026-10-12T10:00:00.000Z' },
    });
    expect(res.statusCode).toBe(200);
    expect(emitToAgents).toHaveBeenCalledTimes(1);
    expect(emitToAgents).toHaveBeenCalledWith(SOCKET_EVENTS.lateOrdersChanged, {
      vendorKey: 'yiji:1',
      builtAt: '2026-10-12T10:00:00.000Z',
    });
    expect(SOCKET_EVENTS.lateOrdersChanged).toBe('late-orders:changed');
    expect(LATE_ORDERS_PUSH_ROOM).toBe('agents:all');
  });

  it('refuses anyone without the service token - an agent may not make every screen refetch', async () => {
    const { app, emitToAgents } = await build();
    for (const authorization of [undefined, 'Bearer agent-token']) {
      const res = await app.inject({
        method: 'POST',
        url: '/jobs/late-orders-changed',
        headers: authorization ? { authorization } : {},
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    }
    expect(emitToAgents).not.toHaveBeenCalled();
  });
});
