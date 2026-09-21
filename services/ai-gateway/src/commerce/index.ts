import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isYijiUnavailable } from '@yiji/shared-types';
import type { createYijiClient } from '@yiji/shared-types';
import { verifyCaller, AuthError, type CallerVerifierDeps } from '../auth/index.js';
import { COMMERCE_TTL, type CommerceCache } from './cache.js';

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
  /**
   * Verifies the caller AND reads the late-order threshold.
   *
   * Widened from `CallerVerifierDeps` for the threshold read. Still the
   * narrowest thing that works: the routes get two named capabilities, not a
   * Directus client they could write through.
   */
  directus: CallerVerifierDeps & { lateDeliveryThreshold(): Promise<number> };
  yiji: Yiji;
  /** Read-through cache. Optional so existing tests construct deps unchanged. */
  cache?: CommerceCache;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * How long `/commerce/inbox` will wait for the bonus order detail.
 *
 * Chosen against what it replaces: the caller used to fetch the detail itself
 * in a second round trip. Anything longer than that is a regression dressed as
 * an optimisation.
 */
const DETAIL_BUDGET_MS = 1_500;

/**
 * The whole endpoint's budget.
 *
 * Upstream is an external API with its own timeouts, and a bad day there has
 * been measured at 30 seconds — long enough that an agent opens a chat, sees a
 * spinner, and goes to look somewhere else. Past this point the useful answer
 * is "commerce is not responding", which the panel already renders as
 * "unavailable" beside the manual order box the agent can type into.
 *
 * A timeout is reported as 504, NOT as an empty list: `orders: []` would read
 * as "this customer has never ordered", which is a different and much worse
 * claim than "we could not ask".
 */
const INBOX_BUDGET_MS = 8_000;

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

  /**
   * Reply 504 when the upstream could not be asked, rather than letting the
   * rejection become a bare 500 — or worse, an empty success. Every commerce
   * route goes through this: "we could not reach the order system" must never
   * reach an agent looking like "this customer has no orders".
   */
  const answering = async (
    reply: FastifyReply,
    what: Record<string, unknown>,
    fn: () => Promise<unknown>,
  ) => {
    try {
      return reply.send({ data: await fn() });
    } catch (err) {
      if (!isYijiUnavailable(err)) throw err;
      app.log.warn({ ...what, err }, 'commerce upstream unavailable');
      return reply.code(504).send({ error: 'commerce_unavailable' });
    }
  };

  /** Through the cache when there is one; straight upstream when there is not. */
  const cached = <T>(parts: readonly string[], ttl: number, fn: () => Promise<T>): Promise<T> =>
    deps.cache ? deps.cache.wrap(parts, ttl, fn) : fn();

  const listOrders = (vendorId: string, customerId: string, limit: number) =>
    cached(['orders', vendorId, customerId, String(limit)], COMMERCE_TTL.orders, () =>
      deps.yiji.getOrders(vendorId, customerId, { limit }),
    );

  const orderDetail = (vendorId: string, orderId: string) =>
    cached(['order', vendorId, orderId], COMMERCE_TTL.order, () =>
      deps.yiji.getOrder(vendorId, orderId),
    );

  app.get('/commerce/activity', async (req, reply) => {
    if (!(await requireAgent(req, reply))) return;
    const q = req.query as Record<string, string | undefined>;
    const vendorId = str(q.vendorId);
    const customerId = str(q.customerId);
    if (!vendorId || !customerId) return reply.code(400).send({ error: 'missing_params' });
    return answering(reply, { route: 'activity', vendorId, customerId }, () =>
      cached(['activity', vendorId, customerId], COMMERCE_TTL.activity, () =>
        deps.yiji.getPurchaseActivity(vendorId, customerId),
      ),
    );
  });

  app.get('/commerce/orders', async (req, reply) => {
    if (!(await requireAgent(req, reply))) return;
    const q = req.query as Record<string, string | undefined>;
    const vendorId = str(q.vendorId);
    const customerId = str(q.customerId);
    if (!vendorId || !customerId) return reply.code(400).send({ error: 'missing_params' });
    const parsed = Number.parseInt(str(q.limit) || '6', 10);
    const limit = Math.min(Math.max(Number.isFinite(parsed) ? parsed : 6, 1), 50);
    return answering(reply, { route: 'orders', vendorId, customerId }, () =>
      listOrders(vendorId, customerId, limit),
    );
  });

  app.get('/commerce/order', async (req, reply) => {
    if (!(await requireAgent(req, reply))) return;
    const q = req.query as Record<string, string | undefined>;
    const vendorId = str(q.vendorId);
    const orderId = str(q.orderId);
    if (!vendorId || !orderId) return reply.code(400).send({ error: 'missing_params' });
    return answering(reply, { route: 'order', vendorId, orderId }, () =>
      orderDetail(vendorId, orderId),
    );
  });

  /**
   * Everything the inbox sidebar needs, in ONE request.
   *
   * The panel used to make two calls in sequence — list the orders, then fetch
   * the newest one's detail because the list carries no line items — with a
   * React Query mount between them. Two client round trips, two auth checks and
   * two cold upstream calls is how a 500ms answer becomes a second and a half.
   *
   * Here the second call is made server-side the moment the first returns, and
   * both sides of it are cached, so a warm open costs one local round trip.
   *
   * The gateway does not write: recording the resolved order back onto the
   * conversation is the caller's job (Directus stays the sole writer, and the
   * agent's own token is what scopes which chats may be stamped at all).
   */
  app.get('/commerce/inbox', async (req, reply) => {
    if (!(await requireAgent(req, reply))) return;
    const q = req.query as Record<string, string | undefined>;
    const vendorId = str(q.vendorId);
    const customerId = str(q.customerId);
    if (!vendorId || !customerId) return reply.code(400).send({ error: 'missing_params' });
    const parsed = Number.parseInt(str(q.limit) || '2', 10);
    const limit = Math.min(Math.max(Number.isFinite(parsed) ? parsed : 2, 1), 10);

    const TIMED_OUT = Symbol('timed-out');
    let orders: Awaited<ReturnType<typeof listOrders>> | typeof TIMED_OUT;
    try {
      orders = await Promise.race([
        listOrders(vendorId, customerId, limit),
        new Promise<typeof TIMED_OUT>((r) => setTimeout(() => r(TIMED_OUT), INBOX_BUDGET_MS)),
      ]);
    } catch (err) {
      /**
       * The client REJECTS when it could not ask — a 5xx, a network error, its
       * own abort. That has to arrive here as a 504 for the same reason the
       * timeout above does: `orders: []` is a positive claim that the customer
       * has never ordered, and the panel would print it beside the agent's
       * chat while the truth is that nobody knows.
       *
       * The client's own abort fires before INBOX_BUDGET_MS, so in practice
       * this branch is what handles a hanging upstream and the race below it
       * only covers a stalled cache.
       */
      if (!isYijiUnavailable(err)) throw err;
      app.log.warn({ vendorId, customerId, err }, 'commerce inbox upstream unavailable');
      return reply.code(504).send({ error: 'commerce_unavailable' });
    }
    if (orders === TIMED_OUT) {
      app.log.warn({ vendorId, customerId }, 'commerce inbox timed out upstream');
      return reply.code(504).send({ error: 'commerce_timeout' });
    }
    const newest = orders[0] ?? null;

    /**
     * The detail is a BONUS, on a deadline.
     *
     * It exists to save the caller a second round trip, so it must never cost
     * more time than that round trip would have. Upstream is an external API
     * whose cold latency has been measured anywhere from 300ms to 30 SECONDS;
     * without a budget here, a slow day upstream becomes an order panel that
     * hangs, which is worse than the two-call version this replaced.
     *
     * Losing the race is not an error and not cached as one: the caller gets
     * the summaries immediately and fetches the detail lazily when the agent
     * expands the order, exactly as it did before. The in-flight promise keeps
     * running and still populates the cache, so the next open is instant.
     */
    const detail = newest
      ? await Promise.race([
          orderDetail(vendorId, newest.orderId),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), DETAIL_BUDGET_MS)),
        ]).catch(() => null)
      : null;

    return reply.send({ data: { orders, detail } });
  });

  /**
   * The order's status timeline for the inbox Tracking view. Derived from the
   * single-order payload until Yiji provides a history endpoint — the response
   * says so (`derived: true`) and the panel labels it.
   */
  app.get('/commerce/tracking', async (req, reply) => {
    if (!(await requireAgent(req, reply))) return;
    const q = req.query as Record<string, string | undefined>;
    const vendorId = str(q.vendorId);
    const orderId = str(q.orderId);
    if (!vendorId || !orderId) return reply.code(400).send({ error: 'missing_params' });
    return answering(reply, { route: 'tracking', vendorId, orderId }, () =>
      cached(['tracking', vendorId, orderId], COMMERCE_TTL.order, () =>
        deps.yiji.getOrderTimeline(vendorId, orderId),
      ),
    );
  });

  /**
   * THE LATE-ORDERS QUEUE: live delivery orders past the threshold.
   *
   * Cached for 20s and coalesced in flight, which is what makes this cheap
   * enough to poll. Every agent watching the queue refetches every 30s; without
   * the cache that is one upstream call per agent per poll, against an external
   * API we do not control. With it, ten agents cost one call — and the answer
   * is never more than a third of a minute behind.
   *
   * Not `answering(...)`'s 504-on-unavailable by accident: an empty queue and a
   * queue we could not fetch look identical on screen and mean opposite things
   * ("nothing is late" vs "we cannot see what is late"). The 504 is what lets
   * the panel say which.
   */
  app.get('/commerce/late-orders', async (req, reply) => {
    if (!(await requireAgent(req, reply))) return;
    const q = req.query as Record<string, string | undefined>;
    const thresholdMinutes = await deps.directus.lateDeliveryThreshold();
    /*
     * A DATE RANGE turns the queue into a register.
     *
     * Without `from`/`to` this answers today's live queue, unchanged. With
     * them it walks pages and includes finished orders — which it must: of 631
     * late orders in the last month, none were still running, so a history
     * view that kept the live filter would render empty and read as "nothing
     * was ever late".
     */
    const from = str(q.from);
    const to = str(q.to);
    const history = !!from || !!to;
    const opts = history
      ? {
          from: from || to,
          to: to || from,
          includeCompleted: true,
          // 500 per page; a month measured 631 rows, so three pages covers the
          // widest window the UI offers with room to spare.
          maxPages: 3,
        }
      : {};
    const ttl = history ? COMMERCE_TTL.order : COMMERCE_TTL.lateOrders;
    return answering(reply, { route: 'late-orders', thresholdMinutes, from, to }, async () => {
      const rows = await cached(
        ['late-orders', String(thresholdMinutes), from || 'today', to || 'today'],
        ttl,
        () => deps.yiji.getLateDeliveryOrders(thresholdMinutes, opts),
      );
      return { rows, thresholdMinutes, builtAt: new Date().toISOString() };
    });
  });

  /**
   * The order's CART: every line with the choices behind it.
   *
   * Cached for the order TTL — a placed order's contents do not change, so
   * this is the cheapest thing here to hold. Takes no vendor: the cart lives
   * on the admin API, which is keyed by order id alone.
   */
  app.get('/commerce/cart', async (req, reply) => {
    if (!(await requireAgent(req, reply))) return;
    const q = req.query as Record<string, string | undefined>;
    const orderId = str(q.orderId);
    if (!orderId) return reply.code(400).send({ error: 'missing_params' });
    return answering(reply, { route: 'cart', orderId }, () =>
      cached(['cart', orderId], COMMERCE_TTL.order, () => deps.yiji.getOrderCart(orderId)),
    );
  });

  app.get('/commerce/payment', async (req, reply) => {
    if (!(await requireAgent(req, reply))) return;
    const q = req.query as Record<string, string | undefined>;
    const vendorId = str(q.vendorId);
    const orderId = str(q.orderId);
    if (!vendorId || !orderId) return reply.code(400).send({ error: 'missing_params' });
    return answering(reply, { route: 'payment', vendorId, orderId }, () =>
      deps.yiji.getPaymentStatus(vendorId, orderId),
    );
  });

  app.get('/commerce/shipment', async (req, reply) => {
    if (!(await requireAgent(req, reply))) return;
    const q = req.query as Record<string, string | undefined>;
    const vendorId = str(q.vendorId);
    const orderId = str(q.orderId);
    if (!vendorId || !orderId) return reply.code(400).send({ error: 'missing_params' });
    return answering(reply, { route: 'shipment', vendorId, orderId }, () =>
      deps.yiji.getShipmentTracking(vendorId, orderId),
    );
  });
}
