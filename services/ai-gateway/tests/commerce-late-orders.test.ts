import { describe, expect, it, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerCommerceRoutes } from '../src/commerce/index.js';
import type { CommerceDeps } from '../src/commerce/index.js';
import { YijiUnavailableError } from '@yiji/shared-types';

const AGENT_TOKEN = 'agent-session-token';

function deps(over: Partial<CommerceDeps> = {}, threshold = 60): CommerceDeps {
  return {
    directus: {
      async whoAmI(token: string) {
        return token === AGENT_TOKEN ? { id: 'u-1', role: 'role-agent' } : null;
      },
      async adminRoleIds() {
        return new Set(['role-admin']);
      },
      async lateDeliveryThreshold() {
        return threshold;
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    yiji: { getLateDeliveryOrders: async () => [] } as any,
    ...over,
  };
}

async function buildApp(d: CommerceDeps): Promise<FastifyInstance> {
  const app = Fastify();
  await registerCommerceRoutes(app, d);
  return app;
}

const auth = { authorization: `Bearer ${AGENT_TOKEN}` };

describe('GET /commerce/late-orders', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp(deps());
  });

  it('refuses a caller with no valid agent session', async () => {
    const res = await app.inject({ method: 'GET', url: '/commerce/late-orders' });
    expect(res.statusCode).toBe(401);
  });

  it('answers with the rows AND the threshold they were selected by', async () => {
    const row = {
      orderId: '1313926',
      status: 'in_delivery',
      minutesElapsed: 61,
      placedAt: '2026-09-21T13:27:39',
      brandName: 'Okashi',
    };
    const one = await buildApp(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deps({ yiji: { getLateDeliveryOrders: async () => [row] } as any }, 60),
    );
    const res = await one.inject({ method: 'GET', url: '/commerce/late-orders', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: { rows: unknown[]; thresholdMinutes: number; builtAt: string };
    };
    expect(body.data.rows).toEqual([row]);
    // The screen states the rule it actually filtered by, so it can never
    // claim "over 60" while showing a queue built at 45.
    expect(body.data.thresholdMinutes).toBe(60);
    expect(Date.parse(body.data.builtAt)).not.toBeNaN();
  });

  it('asks upstream for the CONFIGURED threshold, not a hardcoded 60', async () => {
    let asked: number | null = null;
    const custom = await buildApp(
      deps(
        {
          yiji: {
            getLateDeliveryOrders: async (m: number) => {
              asked = m;
              return [];
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
        },
        45,
      ),
    );
    await custom.inject({ method: 'GET', url: '/commerce/late-orders', headers: auth });
    expect(asked).toBe(45);
  });

  /*
   * An empty queue and a queue we could not fetch look identical on screen and
   * mean opposite things. The 504 is the only thing that lets the panel say
   * "we cannot see what is late" rather than "nothing is late".
   */
  it('reports an unreachable upstream as 504, never as an empty queue', async () => {
    const failing = await buildApp(
      deps({
        yiji: {
          getLateDeliveryOrders: async () => {
            // The REAL error class: `isYijiUnavailable` keys off a marker
            // property, not the name, so a hand-rolled look-alike is treated
            // as an ordinary crash (500) and would not prove anything.
            throw new YijiUnavailableError('yiji is down');
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      }),
    );
    const res = await failing.inject({
      method: 'GET',
      url: '/commerce/late-orders',
      headers: auth,
    });
    expect(res.statusCode).toBe(504);
    expect(res.json()).toEqual({ error: 'commerce_unavailable' });
  });
});
