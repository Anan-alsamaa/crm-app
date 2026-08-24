import type {
  YijiClient,
  YijiCustomer,
  YijiOrder,
  YijiOrderTimeline,
  YijiOrderTimelineEvent,
  YijiPaymentStatus,
  YijiPurchaseActivity,
  YijiShipmentTracking,
} from './yiji.js';

/**
 * YijiClient implementations.
 *
 * The CRM never writes to the Yiji platform — every method here is a
 * read-only lookup. Two impls ship:
 *
 *   - MockYijiClient: seeded in-memory fixtures. Used for local dev and
 *     tests so the agent portal renders rich profiles without a Yiji
 *     instance up. Deterministic across calls.
 *
 *   - HttpYijiClient: fetch-based; honors a configurable timeout; never
 *     throws on network failure — returns null/[] so the UI can show a
 *     "data unavailable" state rather than crash.
 *
 * `createYijiClient()` picks between them by env. In Vite (browser) we read
 * `import.meta.env.VITE_YIJI_API_URL`; in Node we read `process.env.YIJI_API_URL`.
 * Empty/unset → mock.
 */

/* ── Mock ────────────────────────────────────────────────────────── */

interface MockFixtures {
  customers: Map<string, YijiCustomer>;
  ordersByCustomer: Map<string, YijiOrder[]>;
  paymentsByOrder: Map<string, YijiPaymentStatus>;
  shipmentsByOrder: Map<string, YijiShipmentTracking>;
  activityByCustomer: Map<string, YijiPurchaseActivity>;
}

function key(vendorId: string, id: string): string {
  return `${vendorId}::${id}`;
}

/**
 * Build the default fixture set. The `1` + `demo-customer-1`
 * shapes match the chat widget demo so opening the demo customer's profile
 * in the agent portal shows realistic data end-to-end.
 */
function defaultFixtures(): MockFixtures {
  const f: MockFixtures = {
    customers: new Map(),
    ordersByCustomer: new Map(),
    paymentsByOrder: new Map(),
    shipmentsByOrder: new Map(),
    activityByCustomer: new Map(),
  };

  const vendorId = '1';
  const cust: YijiCustomer = {
    externalCustomerId: 'demo-customer-1',
    name: 'Demo Customer',
    phone: '+966500000001',
    email: 'demo.customer@example.com',
    metadata: { tier: 'gold', joinedAt: '2024-03-12' },
  };
  f.customers.set(key(vendorId, cust.externalCustomerId), cust);

  const orders: YijiOrder[] = [
    {
      orderId: 'O-5921',
      status: 'in_delivery',
      total: 84.5,
      currency: 'SAR',
      placedAt: '2026-05-30T11:42:00Z',
      // The live API maps Yiji's PaymentStatus enum (0 not_paid / 1 paid) onto
      // every order inline; mirror that here so the mock exercises the same
      // rendering path as production.
      paymentStatus: 'paid',
      restaurantId: '312',
      restaurantName: 'Burger Boutique',
      deliveryType: 'delivery',
      items: [
        { sku: 'BG-001', name: 'Classic cheeseburger', qty: 2, price: 32.0, category: 'Burgers' },
        { sku: 'FR-014', name: 'Loaded fries', qty: 1, price: 20.5, category: 'Sides' },
      ],
    },
    {
      orderId: 'O-5780',
      status: 'delivered',
      total: 129.0,
      currency: 'SAR',
      placedAt: '2026-04-12T09:10:00Z',
      restaurantId: '208',
      restaurantName: 'Shawarma House',
      deliveryType: 'pickup',
      items: [{ sku: 'SH-220', name: 'Chicken shawarma platter', qty: 3, price: 43.0 }],
    },
    {
      orderId: 'O-5410',
      status: 'refunded',
      total: 79.0,
      currency: 'SAR',
      placedAt: '2026-02-20T16:25:00Z',
      restaurantId: '312',
      restaurantName: 'Burger Boutique',
      deliveryType: 'delivery',
      items: [{ sku: 'CB-099', name: 'Double bacon burger', qty: 1, price: 79.0 }],
    },
  ];
  f.ordersByCustomer.set(key(vendorId, cust.externalCustomerId), orders);

  f.paymentsByOrder.set(key(vendorId, 'O-5921'), {
    orderId: 'O-5921',
    status: 'captured',
    method: 'mada',
    paidAt: '2026-05-30T11:42:30Z',
  });
  f.paymentsByOrder.set(key(vendorId, 'O-5780'), {
    orderId: 'O-5780',
    status: 'captured',
    method: 'apple_pay',
    paidAt: '2026-04-12T09:10:50Z',
  });
  f.paymentsByOrder.set(key(vendorId, 'O-5410'), {
    orderId: 'O-5410',
    status: 'refunded',
    method: 'visa',
    paidAt: '2026-02-20T16:25:10Z',
  });

  f.shipmentsByOrder.set(key(vendorId, 'O-5921'), {
    orderId: 'O-5921',
    carrier: 'SMSA',
    trackingNumber: 'SM-A82F3E',
    status: 'in_transit',
    events: [
      { at: '2026-05-30T13:00:00Z', description: 'Label created', location: 'Riyadh hub' },
      { at: '2026-05-31T07:20:00Z', description: 'Picked up by carrier', location: 'Riyadh hub' },
      { at: '2026-06-01T09:14:00Z', description: 'In transit', location: 'Jeddah hub' },
    ],
  });
  f.shipmentsByOrder.set(key(vendorId, 'O-5780'), {
    orderId: 'O-5780',
    carrier: 'Aramex',
    trackingNumber: 'AR-91220',
    status: 'delivered',
    events: [
      { at: '2026-04-12T10:00:00Z', description: 'Label created' },
      { at: '2026-04-14T13:42:00Z', description: 'Out for delivery', location: 'Riyadh' },
      { at: '2026-04-14T17:08:00Z', description: 'Delivered', location: 'Riyadh' },
    ],
  });

  // Derive activity from `orders` (same reduction the HttpYijiClient uses) so
  // the fixtures can never drift out of agreement with getOrders — editing an
  // order's total automatically flows through to the lifetime value.
  f.activityByCustomer.set(key(vendorId, cust.externalCustomerId), {
    externalCustomerId: cust.externalCustomerId,
    lifetimeValue: orders.reduce((sum, o) => sum + o.total, 0),
    orderCount: orders.length,
    lastOrderAt: orders[0]?.placedAt,
    recent: orders.slice(0, 3),
  });

  return f;
}

export class MockYijiClient implements YijiClient {
  private readonly fixtures: MockFixtures;

  constructor(fixtures: MockFixtures = defaultFixtures()) {
    this.fixtures = fixtures;
  }

  async getCustomer(vendorId: string, externalCustomerId: string): Promise<YijiCustomer | null> {
    return this.fixtures.customers.get(key(vendorId, externalCustomerId)) ?? null;
  }

  async getOrders(
    vendorId: string,
    externalCustomerId: string,
    opts: { limit?: number } = {},
  ): Promise<YijiOrder[]> {
    const all = this.fixtures.ordersByCustomer.get(key(vendorId, externalCustomerId)) ?? [];
    return opts.limit ? all.slice(0, opts.limit) : all;
  }

  async getOrder(vendorId: string, orderId: string): Promise<YijiOrder | null> {
    const prefix = `${vendorId}::`;
    for (const [k, orders] of this.fixtures.ordersByCustomer) {
      if (!k.startsWith(prefix)) continue;
      const found = orders.find((o) => o.orderId === orderId);
      if (found) return found;
    }
    return null;
  }

  async getPaymentStatus(vendorId: string, orderId: string): Promise<YijiPaymentStatus | null> {
    return this.fixtures.paymentsByOrder.get(key(vendorId, orderId)) ?? null;
  }

  async getOrderTimeline(vendorId: string, orderId: string): Promise<YijiOrderTimeline | null> {
    const order = await this.getOrder(vendorId, orderId);
    if (!order) return null;
    // Same derivation as the live client, from the mapped shape.
    const events: YijiOrderTimelineEvent[] = [{ status: 'placed', at: order.placedAt || null }];
    if (order.paymentStatus === 'paid' && order.status !== 'paid') {
      events.push({ status: 'payment', at: null });
    }
    if (order.status !== 'placed') events.push({ status: order.status, at: null });
    return { orderId: order.orderId, current: order.status, derived: true, events };
  }

  async getShipmentTracking(
    vendorId: string,
    orderId: string,
  ): Promise<YijiShipmentTracking | null> {
    return this.fixtures.shipmentsByOrder.get(key(vendorId, orderId)) ?? null;
  }

  async getPurchaseActivity(
    vendorId: string,
    externalCustomerId: string,
  ): Promise<YijiPurchaseActivity | null> {
    return this.fixtures.activityByCustomer.get(key(vendorId, externalCustomerId)) ?? null;
  }
}

/* ── HTTP ────────────────────────────────────────────────────────── */

export interface HttpYijiClientOptions {
  baseUrl: string;
  /** Optional bearer token. */
  token?: string;
  /** Request timeout in ms. Default 6 000. */
  timeoutMs?: number;
  /**
   * The Yiji ADMIN API (https://admin.yiji-app.com) — a separate host from the
   * order API, carrying the status-history endpoint. It requires a login of its
   * own: CRM users do not have Yiji accounts, so the SERVICE authenticates with
   * one credential held in the gateway's env, and no Yiji login ever reaches a
   * browser. All three fields must be set for the real timeline; otherwise
   * getOrderTimeline falls back to the derived placed→payment→current shape.
   */
  adminUrl?: string;
  adminEmail?: string;
  adminPassword?: string;
}

/**
 * Live Yiji order API (https://order.yiji-app.com). The platform is food
 * delivery, so the order carries restaurant/items/payment/delivery inline and
 * there is no separate payment- or parcel-tracking endpoint. Two endpoints:
 *   GET /api/Order/GetOrderAsync/{orderId}   → one order
 *   GET /api/Order/GetOrderByUser/{userId}   → all of a user's orders
 * `userId` here is the contact's external_customer_id (the customer_id the
 * widget passes). `vendorId` is unused by this API (kept for interface parity).
 */

/** Yiji OrderStatus enum (provided by Yiji — exact values). */
const YIJI_ORDER_STATUS: Record<number, string> = {
  0: 'initial',
  1: 'pending_payment',
  2: 'received',
  3: 'finding_driver',
  4: 'driver_accepted',
  5: 'in_kitchen',
  6: 'manual',
  7: 'ready_to_pickup',
  8: 'in_delivery',
  9: 'delivered',
  10: 'closed',
  11: 'canceled',
  12: 'force_cancel',
  13: 'force_closed',
  14: 'not_valid',
  15: 'paid',
  16: 'pos_accepted',
  17: 'pending_pos_accepted',
  65: 'arrived',
};
/** Yiji PaymentStatus enum (provided by Yiji). */
const YIJI_PAYMENT_STATUS: Record<number, string> = {
  0: 'not_paid',
  1: 'paid',
};
/** Yiji PaymentMode enum (provided by Yiji). */
const YIJI_PAYMENT_MODE: Record<number, string> = {
  1: 'cash',
  2: 'credit_card',
  3: 'apple_pay',
  4: 'pay_later',
  5: 'mada',
  6: 'visa',
  7: 'master',
};
/**
 * Yiji DeliveryType enum (confirmed by the client's mobile-dev contract). Maps
 * the raw int onto a human label the UI titleizes (and can translate). Unknown
 * values fall back to `type_N` in the mapper.
 */
const YIJI_DELIVERY_TYPE: Record<number, string> = {
  0: 'delivery',
  1: 'pickup',
  2: 'carhop',
  3: 'in_restaurant',
};

interface RawYijiOrder {
  id: number;
  orderStatus?: number;
  paymentStatus?: number;
  paymentMode?: number;
  deliveryType?: number | null;
  total?: number;
  creationTime?: string;
  orderStatusDate?: string;
  // `restaurantId` is on both list + detail responses; `restaurantName` only
  // on detail (null in the list). The API may send the id as a number.
  restaurantId?: number | string | null;
  restaurantName?: string | null;
  brandName?: string | null;
  customerPhoneNumber?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  // Cart-level money facts (single-order endpoint; confirmed live field names).
  totalPoints?: number | null;
  totalCoupons?: number | null;
  discount?: number | null;
  deliveryAddress?: { fullAddress?: string | null } | null;
  orderItems?: Array<{
    id?: number;
    idChooseableItem?: number;
    itemName?: string;
    quantity?: number;
    itemPrice?: number;
    itemCategory?: string | null;
  }> | null;
}

function mapYijiOrder(raw: RawYijiOrder): YijiOrder {
  return {
    orderId: String(raw.id),
    status:
      raw.orderStatus != null
        ? (YIJI_ORDER_STATUS[raw.orderStatus] ?? `status_${raw.orderStatus}`)
        : 'unknown',
    total: raw.total ?? 0,
    currency: 'SAR', // Yiji amounts are SAR; the API returns no currency code.
    placedAt: raw.creationTime ?? raw.orderStatusDate ?? '',
    items: (raw.orderItems ?? []).map((it) => ({
      sku: String(it.idChooseableItem ?? it.id ?? ''),
      name: it.itemName ?? 'item',
      qty: it.quantity ?? 1,
      price: it.itemPrice ?? 0,
      category: it.itemCategory ?? undefined,
    })),
    restaurantId: raw.restaurantId != null ? String(raw.restaurantId) : undefined,
    restaurantName: raw.restaurantName ?? undefined,
    brandName: raw.brandName ?? undefined,
    deliveryType:
      raw.deliveryType != null
        ? (YIJI_DELIVERY_TYPE[raw.deliveryType] ?? `type_${raw.deliveryType}`)
        : undefined,
    deliveryAddress: raw.deliveryAddress?.fullAddress ?? undefined,
    paymentStatus:
      raw.paymentStatus != null
        ? (YIJI_PAYMENT_STATUS[raw.paymentStatus] ?? `status_${raw.paymentStatus}`)
        : undefined,
    paymentMode:
      raw.paymentMode != null
        ? (YIJI_PAYMENT_MODE[raw.paymentMode] ?? `mode_${raw.paymentMode}`)
        : undefined,
    customerPhone: raw.customerPhoneNumber ?? undefined,
    totalPointAmount: raw.totalPoints ?? undefined,
    totalCouponAmount: raw.totalCoupons ?? undefined,
    totalDiscount: raw.discount ?? undefined,
  };
}

/** One row of the admin API's GetOrderStatusHistoriesByOrderId response. */
interface RawYijiStatusHistory {
  orderStatus?: number | null;
  creationTime?: string | null;
}

/**
 * Map the admin API's status-history rows to the timeline the UI renders.
 *
 * Only `orderStatus` and `creationTime` matter (per the client's contract);
 * rows are ordered by time so the steps read in the order they happened, and
 * the last row is the current status. `derived: false`: this is the REAL
 * history, so the tracking panel drops its "built from the order record"
 * caption.
 */
export function mapStatusHistory(orderId: string, rows: RawYijiStatusHistory[]): YijiOrderTimeline {
  const events: YijiOrderTimelineEvent[] = rows
    .filter((r) => r.orderStatus != null)
    .map((r) => ({
      status: YIJI_ORDER_STATUS[r.orderStatus as number] ?? `status_${r.orderStatus}`,
      at: r.creationTime ?? null,
    }))
    .sort((a, b) => ((a.at ?? '') < (b.at ?? '') ? -1 : (a.at ?? '') > (b.at ?? '') ? 1 : 0));
  return {
    orderId,
    current: events[events.length - 1]?.status ?? 'unknown',
    derived: false,
    events,
  };
}

/**
 * The order's life so far, DERIVED from the single-order payload — the
 * FALLBACK when the admin API (which owns the real status history) is not
 * configured or cannot be reached: the order carries only `creationTime`,
 * `paymentStatus` and the current `orderStatus` with its `orderStatusDate`, so
 * the honest fallback timeline is placed → payment → current status, flagged
 * `derived: true` so the UI can say the middle steps are not recorded.
 */
export function deriveOrderTimeline(raw: RawYijiOrder): YijiOrderTimeline {
  const events: YijiOrderTimelineEvent[] = [{ status: 'placed', at: raw.creationTime ?? null }];
  const current =
    raw.orderStatus != null
      ? (YIJI_ORDER_STATUS[raw.orderStatus] ?? `status_${raw.orderStatus}`)
      : 'unknown';
  if (raw.paymentStatus === 1 && current !== 'paid') {
    events.push({ status: 'payment', at: null });
  }
  if (current !== 'placed') {
    events.push({ status: current, at: raw.orderStatusDate ?? null });
  }
  return { orderId: String(raw.id), current, derived: true, events };
}

/** Newest-first by placed date (ISO strings sort chronologically). */
function byNewest(a: YijiOrder, b: YijiOrder): number {
  return a.placedAt < b.placedAt ? 1 : a.placedAt > b.placedAt ? -1 : 0;
}

/**
 * The upstream could not be asked — as distinct from it answering "nothing".
 *
 * Callers must never render this as an empty result. "This customer has no
 * orders" is a claim about the customer; "we could not reach the order system"
 * is a claim about us, and an agent needs to know which one they are reading
 * before they say it out loud to somebody.
 */
export class YijiUnavailableError extends Error {
  readonly isYijiUnavailable = true;
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message, opts as ErrorOptions);
    this.name = 'YijiUnavailableError';
  }
}

/** True for an error meaning "we could not ask", from any realm. */
export function isYijiUnavailable(err: unknown): boolean {
  return (
    err instanceof YijiUnavailableError ||
    (typeof err === 'object' && err !== null && 'isYijiUnavailable' in err)
  );
}

export class HttpYijiClient implements YijiClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly adminUrl?: string;
  private readonly adminEmail?: string;
  private readonly adminPassword?: string;
  /** Cached admin-API bearer token; refreshed on 401 via re-login. */
  private adminToken: string | null = null;

  constructor(opts: HttpYijiClientOptions) {
    if (!opts.baseUrl) throw new Error('HttpYijiClient: baseUrl is required');
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 6_000;
    this.adminUrl = opts.adminUrl?.replace(/\/+$/, '') || undefined;
    this.adminEmail = opts.adminEmail || undefined;
    this.adminPassword = opts.adminPassword || undefined;
  }

  private get adminConfigured(): boolean {
    return !!(this.adminUrl && this.adminEmail && this.adminPassword);
  }

  /**
   * Sign into the Yiji ADMIN API with the service credential and cache the
   * token. CRM logins are not Yiji logins — the CRM's users don't exist there —
   * so the service authenticates as ITSELF, server-side, and the browser only
   * ever talks to our own gateway.
   */
  private async adminLogin(): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.adminUrl}/api/Account/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ email: this.adminEmail, password: this.adminPassword }),
        signal: controller.signal,
      });
      if (!res.ok) throw new YijiUnavailableError(`admin login failed (${res.status})`);
      const body = (await res.json()) as { token?: string };
      if (!body.token) throw new YijiUnavailableError('admin login returned no token');
      this.adminToken = body.token;
      return body.token;
    } catch (err) {
      if (err instanceof YijiUnavailableError) throw err;
      throw new YijiUnavailableError(
        `admin login: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * GET from the admin API with the cached token; one re-login on 401 so an
   * expired token costs a round trip, never an outage. 404 = "nothing there".
   */
  private async adminFetch<T>(path: string): Promise<T | null> {
    let token = this.adminToken ?? (await this.adminLogin());
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(`${this.adminUrl}${path}`, {
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
          signal: controller.signal,
        });
        if (res.status === 401 && attempt === 0) {
          this.adminToken = null;
          token = await this.adminLogin();
          continue;
        }
        if (res.status === 404) return null;
        if (!res.ok) throw new YijiUnavailableError(`admin upstream ${res.status} for ${path}`);
        return (await res.json()) as T;
      } catch (err) {
        if (err instanceof YijiUnavailableError) throw err;
        const reason =
          err instanceof Error && err.name === 'AbortError'
            ? `timed out after ${this.timeoutMs}ms`
            : `network error: ${err instanceof Error ? err.message : String(err)}`;
        throw new YijiUnavailableError(`${reason} for admin ${path}`, { cause: err });
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  }

  /**
   * POST to the admin API with the service credential, refreshing the token
   * once on a 401.
   *
   * Separate from `adminFetch` because the failure rules are not the same. A
   * GET that 404s means "nothing there" and answers `null`; a POST that fails
   * has changed nothing and must say so loudly, because the caller is about to
   * record that it succeeded. Nothing here interprets the RESPONSE BODY either
   * — Yiji answers 200 whether it granted or refused, and only the caller knows
   * which field carries the verdict for its endpoint.
   *
   * The point of routing coupon delivery through here is the credential. A
   * long-lived bearer token pasted into an env file is a secret with no expiry,
   * no rotation and no owner; this signs in as the service, caches the token in
   * memory only, and re-signs when it expires — the same way the status-history
   * integration already talks to this exact host.
   */
  async adminPost<T>(
    path: string,
    body: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    if (!this.adminConfigured) {
      throw new YijiUnavailableError('admin API is not configured');
    }
    let token = this.adminToken ?? (await this.adminLogin());
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(`${this.adminUrl}${path}`, {
          method: 'POST',
          headers: {
            ...extraHeaders,
            // Last, so a caller cannot accidentally override the credential.
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (res.status === 401 && attempt === 0) {
          this.adminToken = null;
          token = await this.adminLogin();
          continue;
        }
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          throw new YijiUnavailableError(
            `admin upstream ${res.status} for ${path}: ${detail.slice(0, 300)}`,
          );
        }
        return (await res.json()) as T;
      } catch (err) {
        if (err instanceof YijiUnavailableError) throw err;
        const reason =
          err instanceof Error && err.name === 'AbortError'
            ? `timed out after ${this.timeoutMs}ms`
            : `network error: ${err instanceof Error ? err.message : String(err)}`;
        throw new YijiUnavailableError(`${reason} for admin ${path}`, { cause: err });
      } finally {
        clearTimeout(timer);
      }
    }
    // Only reachable if both attempts 401'd, which is a credential problem.
    throw new YijiUnavailableError(`admin ${path} refused the service credential twice`);
  }

  /**
   * `null` means the upstream ANSWERED and there is nothing there (404).
   * Anything else throws.
   *
   * This used to swallow aborts, network errors and every non-ok status into
   * the same `null`, which `getOrders` then mapped to `[]` — so a timeout, a
   * 503 and a DNS failure all reached the agent as "No orders found for this
   * contact". A positive claim about the customer, made from no information,
   * and cached for 45 seconds because a resolved empty array looks exactly like
   * a real answer to the cache. Measured: a hanging upstream returned 200
   * {"orders":[]} at 6.4s; a 503 returned the same body at 0.32s.
   *
   * Distinguishing the two at this boundary is what makes everything above it
   * work: the cache already declines to store a rejected fetcher, the inbox
   * route can turn a rejection into its 504, and the portal can say "we could
   * not ask" instead of "they never ordered".
   */
  private async fetch<T>(path: string): Promise<T | null> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        headers: this.token
          ? { authorization: `Bearer ${this.token}`, accept: 'application/json' }
          : { accept: 'application/json' },
        signal: controller.signal,
      });
      // The one honest "nothing there": the upstream looked and found none.
      if (res.status === 404) return null;
      if (!res.ok) throw new YijiUnavailableError(`upstream ${res.status} for ${path}`);
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof YijiUnavailableError) throw err;
      const reason =
        err instanceof Error && err.name === 'AbortError'
          ? `timed out after ${this.timeoutMs}ms`
          : `network error: ${err instanceof Error ? err.message : String(err)}`;
      throw new YijiUnavailableError(`${reason} for ${path}`, { cause: err });
    } finally {
      clearTimeout(timer);
    }
  }

  async getOrder(_vendorId: string, orderId: string): Promise<YijiOrder | null> {
    const raw = await this.fetch<RawYijiOrder>(
      `/api/Order/GetOrderAsync/${encodeURIComponent(orderId)}`,
    );
    return raw && raw.id != null ? mapYijiOrder(raw) : null;
  }

  async getOrderTimeline(_vendorId: string, orderId: string): Promise<YijiOrderTimeline | null> {
    // The REAL history, from the admin API's OrderStatusHistories endpoint —
    // every status transition with its time (the contract: `orderStatus` +
    // `creationTime`). Falls back to the derived shape when the admin API is
    // not configured or cannot be asked, so tracking degrades rather than dies.
    if (this.adminConfigured) {
      try {
        const rows = await this.adminFetch<RawYijiStatusHistory[]>(
          `/api/OrderStatusHistories/GetOrderStatusHistoriesByOrderId/${encodeURIComponent(orderId)}`,
        );
        if (Array.isArray(rows) && rows.length > 0) return mapStatusHistory(orderId, rows);
      } catch {
        // Admin API unreachable — fall through to the derived timeline.
      }
    }
    const raw = await this.fetch<RawYijiOrder>(
      `/api/Order/GetOrderAsync/${encodeURIComponent(orderId)}`,
    );
    return raw && raw.id != null ? deriveOrderTimeline(raw) : null;
  }

  async getOrders(
    _vendorId: string,
    externalCustomerId: string,
    opts: { limit?: number } = {},
  ): Promise<YijiOrder[]> {
    const raw = await this.fetch<RawYijiOrder[]>(
      `/api/Order/GetOrderByUser/${encodeURIComponent(externalCustomerId)}`,
    );
    if (!Array.isArray(raw)) return [];
    const mapped = raw.map(mapYijiOrder).sort(byNewest);
    return opts.limit ? mapped.slice(0, opts.limit) : mapped;
  }

  async getPaymentStatus(_vendorId: string, orderId: string): Promise<YijiPaymentStatus | null> {
    const raw = await this.fetch<RawYijiOrder>(
      `/api/Order/GetOrderAsync/${encodeURIComponent(orderId)}`,
    );
    if (!raw || raw.id == null) return null;
    return {
      orderId: String(raw.id),
      status:
        raw.paymentStatus != null
          ? (YIJI_PAYMENT_STATUS[raw.paymentStatus] ?? `status_${raw.paymentStatus}`)
          : 'unknown',
      method:
        raw.paymentMode != null
          ? (YIJI_PAYMENT_MODE[raw.paymentMode] ?? `mode_${raw.paymentMode}`)
          : undefined,
    };
  }

  async getShipmentTracking(
    _vendorId: string,
    _orderId: string,
  ): Promise<YijiShipmentTracking | null> {
    // Food delivery — no parcel-tracking endpoint; the order status conveys
    // fulfillment. Return null so the UI degrades gracefully.
    return null;
  }

  async getPurchaseActivity(
    _vendorId: string,
    externalCustomerId: string,
  ): Promise<YijiPurchaseActivity | null> {
    const raw = await this.fetch<RawYijiOrder[]>(
      `/api/Order/GetOrderByUser/${encodeURIComponent(externalCustomerId)}`,
    );
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const mapped = raw.map(mapYijiOrder).sort(byNewest);
    return {
      externalCustomerId,
      lifetimeValue: mapped.reduce((sum, o) => sum + (o.total || 0), 0),
      orderCount: mapped.length,
      lastOrderAt: mapped[0]?.placedAt,
      recent: mapped.slice(0, 3),
    };
  }

  async getCustomer(_vendorId: string, externalCustomerId: string): Promise<YijiCustomer | null> {
    const raw = await this.fetch<RawYijiOrder[]>(
      `/api/Order/GetOrderByUser/${encodeURIComponent(externalCustomerId)}`,
    );
    const first = Array.isArray(raw)
      ? raw.find((o) => o.customerPhoneNumber || o.customerName || o.customerEmail)
      : null;
    if (!first) return null;
    return {
      externalCustomerId,
      name: first.customerName ?? undefined,
      phone: first.customerPhoneNumber ?? undefined,
      email: first.customerEmail ?? undefined,
    };
  }
}

/* ── Factory ─────────────────────────────────────────────────────── */

export interface YijiClientEnv {
  /** Base URL. Empty/unset = use mock. */
  apiUrl?: string;
  /** Optional bearer token for HTTP impl. */
  token?: string;
  /**
   * The Yiji ADMIN API + its service credential (status history lives there).
   * Server-side env only — never shipped to a browser.
   */
  adminApiUrl?: string;
  adminEmail?: string;
  adminPassword?: string;
  /** Override the mock fixtures (tests only). */
  mockFixtures?: MockFixtures;
}

/**
 * A function that POSTs to the Yiji ADMIN API as the service account, or null
 * when no service credential is configured.
 *
 * Exists so a caller — the coupon-push worker — can talk to that API without
 * holding a client instance or knowing how the token is obtained. The
 * alternative was a long-lived bearer token pasted into an env file: a secret
 * with no expiry, no rotation and no owner, sitting in a file that gets copied
 * between machines. This signs in with the same credential the status-history
 * integration already uses, keeps the token in memory only, and re-signs when
 * it expires.
 *
 * `null` rather than a throwing stub, so the caller can tell "not configured"
 * from "configured and failing" — those two need opposite handling, and
 * conflating them is how a disabled integration comes to look like an outage.
 */
export type YijiAdminPoster = <T>(
  path: string,
  body: unknown,
  headers?: Record<string, string>,
) => Promise<T>;

export function createYijiAdminPoster(env: YijiClientEnv = {}): YijiAdminPoster | null {
  if (!env.adminApiUrl?.trim() || !env.adminEmail?.trim() || !env.adminPassword?.trim()) {
    return null;
  }
  const client = new HttpYijiClient({
    // The order API is irrelevant here but the constructor wants a base; the
    // admin half is what this poster uses.
    baseUrl: env.apiUrl || env.adminApiUrl,
    token: env.token,
    adminUrl: env.adminApiUrl,
    adminEmail: env.adminEmail,
    adminPassword: env.adminPassword,
  });
  return (path, body, headers) => client.adminPost(path, body, headers);
}

/**
 * Build a YijiClient. Pass env explicitly — callers in Vite pass
 * `import.meta.env.VITE_YIJI_API_URL`; Node callers pass `process.env.YIJI_API_URL`.
 */
export function createYijiClient(env: YijiClientEnv = {}): YijiClient {
  if (env.apiUrl && env.apiUrl.trim()) {
    return new HttpYijiClient({
      baseUrl: env.apiUrl,
      token: env.token,
      adminUrl: env.adminApiUrl,
      adminEmail: env.adminEmail,
      adminPassword: env.adminPassword,
    });
  }
  return new MockYijiClient(env.mockFixtures);
}
