import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isUnknownVendor, isYijiUnavailable } from '@yiji/shared-types';
import type { ConnectorRegistry, VendorConnector } from '@yiji/shared-types';
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

/**
 * What the routes need from the connector registry (MV-2): the connector of a
 * request's vendor, and - for the routes whose records carry no vendor yet -
 * the one legacy vendor.
 */
export type CommerceConnectors = Pick<
  ConnectorRegistry,
  'connectorFor' | 'defaultVendorForLegacyRecords'
>;

export interface CommerceDeps {
  /**
   * Verifies the caller AND reads the late-order threshold.
   *
   * Widened from `CallerVerifierDeps` for the threshold read. Still the
   * narrowest thing that works: the routes get two named capabilities, not a
   * Directus client they could write through.
   */
  directus: CallerVerifierDeps & { lateDeliveryThreshold(): Promise<number> };
  /**
   * Resolves the `vendorId` each request names (the vendor's `yiji_vendor_id`,
   * or its CRM UUID) to that vendor's commerce connector. An unknown vendor is
   * a 404 `unknown_vendor`, never another vendor's data.
   *
   * `/commerce/customer-exists` reads the connector's `findCustomerIdByPhone`:
   * null without the admin credential, and the route then reports
   * `configured: false` rather than claiming the customer does not exist.
   */
  connectors: CommerceConnectors;
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
  /** The connector for the vendor a request names. */
  const connectorFor = (vendorKey: string): Promise<VendorConnector> =>
    deps.connectors.connectorFor(vendorKey);

  /*
   * TODO(MV-1): the late-orders queue, the cart, the service-time batch and
   * the customer-exists check carry no vendor today, so they are answered by
   * the single legacy Yiji vendor. MV-1 gives them one and this goes.
   */
  const legacyConnector = async (): Promise<VendorConnector> =>
    deps.connectors.connectorFor(await deps.connectors.defaultVendorForLegacyRecords());

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
      if (isUnknownVendor(err)) {
        app.log.warn({ ...what, reason: err.reason }, 'commerce request for an unknown vendor');
        return reply.code(404).send({ error: 'unknown_vendor' });
      }
      if (!isYijiUnavailable(err)) throw err;
      app.log.warn({ ...what, err }, 'commerce upstream unavailable');
      return reply.code(504).send({ error: 'commerce_unavailable' });
    }
  };

  /** Through the cache when there is one; straight upstream when there is not. */
  const cached = <T>(parts: readonly string[], ttl: number, fn: () => Promise<T>): Promise<T> =>
    deps.cache ? deps.cache.wrap(parts, ttl, fn) : fn();

  /* Cache keys are unchanged (the vendor id as the request named it), so a
     deploy of this layer does not cold-start the cache. */
  const listOrders = (
    connector: VendorConnector,
    vendorId: string,
    customerId: string,
    limit: number,
  ) =>
    cached(['orders', vendorId, customerId, String(limit)], COMMERCE_TTL.orders, () =>
      connector.getOrders(customerId, { limit }),
    );

  const orderDetail = (connector: VendorConnector, vendorId: string, orderId: string) =>
    cached(['order', vendorId, orderId], COMMERCE_TTL.order, () => connector.getOrder(orderId));

  app.get('/commerce/activity', async (req, reply) => {
    if (!(await requireAgent(req, reply))) return;
    const q = req.query as Record<string, string | undefined>;
    const vendorId = str(q.vendorId);
    const customerId = str(q.customerId);
    if (!vendorId || !customerId) return reply.code(400).send({ error: 'missing_params' });
    return answering(reply, { route: 'activity', vendorId, customerId }, async () => {
      const connector = await connectorFor(vendorId);
      return cached(['activity', vendorId, customerId], COMMERCE_TTL.activity, () =>
        connector.getPurchaseActivity(customerId),
      );
    });
  });

  app.get('/commerce/orders', async (req, reply) => {
    if (!(await requireAgent(req, reply))) return;
    const q = req.query as Record<string, string | undefined>;
    const vendorId = str(q.vendorId);
    const customerId = str(q.customerId);
    if (!vendorId || !customerId) return reply.code(400).send({ error: 'missing_params' });
    const parsed = Number.parseInt(str(q.limit) || '6', 10);
    const limit = Math.min(Math.max(Number.isFinite(parsed) ? parsed : 6, 1), 50);
    return answering(reply, { route: 'orders', vendorId, customerId }, async () =>
      listOrders(await connectorFor(vendorId), vendorId, customerId, limit),
    );
  });

  /**
   * DOES THIS PHONE BELONG TO A YIJI CUSTOMER?
   *
   * For the coupon approval card (owner, 2026-10-01). A coupon with no order is
   * delivered by resolving the customer from their number — see
   * `AddCompensationCoupon` in the coupon worker — so the only honest question
   * before approving one is whether that resolution will succeed.
   *
   * The card used to carry a permanent caveat on every order-less coupon
   * ("if they have never used the app it cannot be delivered"), which is noise
   * on the great majority that CAN be delivered. Asking the real question lets
   * the warning appear only when it is true.
   *
   * Returns a BOOLEAN and the id, never a profile: the card needs to know
   * whether delivery will work, and a lookup endpoint that hands back customer
   * records to any signed-in agent is a different, wider thing.
   */
  app.get('/commerce/customer-exists', async (req, reply) => {
    if (!(await requireAgent(req, reply))) return;
    const q = req.query as Record<string, string | undefined>;
    const phone = str(q.phone);
    if (!phone) return reply.code(400).send({ error: 'missing_params' });
    return answering(reply, { route: 'customer-exists', phone }, async () => {
      const findCustomer = (await legacyConnector()).findCustomerIdByPhone;
      const id = findCustomer ? await findCustomer(phone) : null;
      /* `configured: false` is NOT "they do not exist" — without the credential
         nothing was asked, and the caller must not render a warning off it. */
      return { configured: Boolean(findCustomer), exists: Boolean(id), customerId: id ?? null };
    });
  });

  app.get('/commerce/order', async (req, reply) => {
    if (!(await requireAgent(req, reply))) return;
    const q = req.query as Record<string, string | undefined>;
    const vendorId = str(q.vendorId);
    const orderId = str(q.orderId);
    if (!vendorId || !orderId) return reply.code(400).send({ error: 'missing_params' });
    return answering(reply, { route: 'order', vendorId, orderId }, async () =>
      orderDetail(await connectorFor(vendorId), vendorId, orderId),
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

    let connector: VendorConnector;
    try {
      connector = await connectorFor(vendorId);
    } catch (err) {
      if (!isUnknownVendor(err)) throw err;
      app.log.warn({ vendorId, reason: err.reason }, 'commerce inbox for an unknown vendor');
      return reply.code(404).send({ error: 'unknown_vendor' });
    }

    const TIMED_OUT = Symbol('timed-out');
    let orders: Awaited<ReturnType<typeof listOrders>> | typeof TIMED_OUT;
    try {
      orders = await Promise.race([
        listOrders(connector, vendorId, customerId, limit),
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
          orderDetail(connector, vendorId, newest.orderId),
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
    return answering(reply, { route: 'tracking', vendorId, orderId }, async () => {
      const connector = await connectorFor(vendorId);
      return cached(['tracking', vendorId, orderId], COMMERCE_TTL.order, () =>
        connector.getOrderTimeline(orderId),
      );
    });
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
          /*
           * 500 per page, and the walk runs until the pages run out.
           *
           * It was capped at 6 pages — 3,000 orders — which silently truncated
           * a long range (owner, 2026-09-29: paginate through Yiji as needed
           * rather than restricting the dates). A short answer that looks
           * complete is the worst shape a report can take, and it is the one
           * this codebase keeps producing.
           *
           * The walk STOPS EARLY on a short page, so a small range still costs
           * one call: the ceiling is a guard against a runaway loop, not a
           * budget. 200 pages is 100,000 orders — far past anything real, and
           * still finite if Yiji ever returns full pages forever.
           */
          maxPages: 200,
        }
      : {};
    /*
     * TODAY IS A RANGE THAT IS STILL MOVING.
     *
     * A past window is a fixed set of finished orders and deserves the long
     * order TTL. But the portal's "Today" button now asks for the CURRENT
     * business day as a range — so that a delivered order stays on the list —
     * and that answer changes every minute: new orders cross the threshold and
     * live rows' elapsed time is the whole point.
     *
     * Cached for 300s it would have sat frozen for five minutes behind a screen
     * that polls every 30, which is exactly the shape of bug that reads as "the
     * page is stuck". `live=1` says which it is; the client sends it with the
     * day it is asking about, and nothing else changes.
     */
    const live = str(q.live) === '1';
    const ttl = history && !live ? COMMERCE_TTL.order : COMMERCE_TTL.lateOrders;
    return answering(reply, { route: 'late-orders', thresholdMinutes, from, to }, async () => {
      // TODO(MV-1): the queue is not per-vendor yet - see `legacyConnector`.
      const connector = await legacyConnector();
      const rows = await cached(
        /* `live` is part of the KEY: the same dates asked for both ways are two
           different cache entries, so a long-lived historical answer can never
           be served to the live view or vice versa. */
        [
          'late-orders',
          String(thresholdMinutes),
          from || 'today',
          to || 'today',
          live ? 'live' : 'hist',
        ],
        ttl,
        () => connector.getLateDeliveryOrders(thresholdMinutes, opts),
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
    return answering(reply, { route: 'cart', orderId }, async () => {
      // TODO(MV-1): the portal names no vendor for a cart - see `legacyConnector`.
      const connector = await legacyConnector();
      return cached(['cart', orderId], COMMERCE_TTL.order, () => connector.getOrderCart(orderId));
    });
  });

  /**
   * DRIVER-ACCEPT TIMES for a batch of orders — the basis of SERVICE TIME.
   *
   * Service time is driver-accept → close (or → now while running), and the
   * late-orders LIST does not carry the driver-accept moment: it lives only in
   * the per-order status history. Fetching that for a 600-row queue would be
   * 600 calls into Yiji's production API on every page load, so the portal asks
   * only for the rows a human is actually looking at and this answers them in
   * one request.
   *
   * Capped at 50 ids. A cap rather than paging because the caller is a viewport
   * — nobody reads 600 rows at once — and an uncapped batch is how a screen
   * quietly becomes a load test against somebody else's API.
   *
   * Each order is cached on the ORDER ttl and resolved in parallel; a failure
   * for one id yields null for that id rather than failing the batch, so one
   * unreachable order cannot blank the whole column.
   */
  app.get('/commerce/service-times', async (req, reply) => {
    if (!(await requireAgent(req, reply))) return;
    const q = req.query as Record<string, string | undefined>;
    const ids = str(q.orderIds)
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 50);
    if (ids.length === 0) return reply.code(400).send({ error: 'missing_params' });
    return answering(reply, { route: 'service-times', count: ids.length }, async () => {
      // TODO(MV-1): the batch names no vendor - see `legacyConnector`.
      const connector = await legacyConnector();
      const entries = await Promise.all(
        ids.map(async (orderId) => {
          try {
            const timeline = await cached(['timeline', orderId], COMMERCE_TTL.order, () =>
              connector.getOrderTimeline(orderId),
            );
            /*
             * THE WHOLE HISTORY, flattened to `status -> first timestamp`.
             *
             * This used to pick `driver_accepted` out and throw the rest away,
             * having already paid for the entire timeline. That cost nothing to
             * keep and made four questions unanswerable — the owner's spec
             * (2026-09-29) asks for driver arrival, delivery and preparation
             * times beside the service time, and every one of them is two
             * stamps from this same response.
             *
             * FIRST occurrence wins: an order can re-enter a status (a driver
             * reassigned, a kitchen re-accepting), and the question is always
             * when it FIRST reached it. `closed` is the exception that matters
             * most — see `orderEventTimes`, which prefers it over `force_closed`
             * rather than taking whichever came last.
             */
            const at: Record<string, string | null> = {};
            for (const ev of timeline?.events ?? []) {
              if (!ev.status || at[ev.status] !== undefined) continue;
              at[ev.status] = ev.at ?? null;
            }
            return [orderId, at] as const;
          } catch {
            /* One unreachable order must not blank the columns for the rest. */
            return [orderId, {}] as const;
          }
        }),
      );
      return Object.fromEntries(entries);
    });
  });

  app.get('/commerce/payment', async (req, reply) => {
    if (!(await requireAgent(req, reply))) return;
    const q = req.query as Record<string, string | undefined>;
    const vendorId = str(q.vendorId);
    const orderId = str(q.orderId);
    if (!vendorId || !orderId) return reply.code(400).send({ error: 'missing_params' });
    return answering(reply, { route: 'payment', vendorId, orderId }, async () =>
      (await connectorFor(vendorId)).getPaymentStatus(orderId),
    );
  });

  app.get('/commerce/shipment', async (req, reply) => {
    if (!(await requireAgent(req, reply))) return;
    const q = req.query as Record<string, string | undefined>;
    const vendorId = str(q.vendorId);
    const orderId = str(q.orderId);
    if (!vendorId || !orderId) return reply.code(400).send({ error: 'missing_params' });
    return answering(reply, { route: 'shipment', vendorId, orderId }, async () =>
      (await connectorFor(vendorId)).getShipmentTracking(orderId),
    );
  });
}
