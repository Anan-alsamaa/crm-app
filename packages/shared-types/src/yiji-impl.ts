import type {
  YijiClient,
  YijiCustomer,
  YijiOrder,
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
 * Build the default fixture set. The `demo-vendor` + `demo-customer-1`
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

  const vendorId = 'demo-vendor';
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
      status: 'shipped',
      total: 348.5,
      currency: 'SAR',
      placedAt: '2026-05-30T11:42:00Z',
      items: [
        { sku: 'BG-001', name: 'Linen tote', qty: 1, price: 199.0 },
        { sku: 'CR-014', name: 'Hand cream', qty: 3, price: 49.5 },
      ],
    },
    {
      orderId: 'O-5780',
      status: 'delivered',
      total: 129.0,
      currency: 'SAR',
      placedAt: '2026-04-12T09:10:00Z',
      items: [{ sku: 'TS-220', name: 'Cotton tee', qty: 1, price: 129.0 }],
    },
    {
      orderId: 'O-5410',
      status: 'refunded',
      total: 79.0,
      currency: 'SAR',
      placedAt: '2026-02-20T16:25:00Z',
      items: [{ sku: 'CD-099', name: 'Candle', qty: 1, price: 79.0 }],
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

  f.activityByCustomer.set(key(vendorId, cust.externalCustomerId), {
    externalCustomerId: cust.externalCustomerId,
    lifetimeValue: 556.5,
    orderCount: 3,
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

/** Numeric status codes → readable labels. Best-effort — confirm with Yiji. */
const YIJI_ORDER_STATUS: Record<number, string> = {
  0: 'created',
  1: 'confirmed',
  2: 'preparing',
  3: 'ready',
  4: 'dispatched',
  5: 'on_the_way',
  6: 'delivered',
  10: 'delivered',
  11: 'cancelled',
  12: 'refunded',
};
const YIJI_PAYMENT_STATUS: Record<number, string> = {
  0: 'pending',
  1: 'paid',
  2: 'failed',
  3: 'refunded',
};
const YIJI_PAYMENT_MODE: Record<number, string> = {
  1: 'cash',
  2: 'card',
  3: 'apple_pay',
  4: 'wallet',
};

interface RawYijiOrder {
  id: number;
  orderStatus?: number;
  paymentStatus?: number;
  paymentMode?: number;
  total?: number;
  creationTime?: string;
  orderStatusDate?: string;
  restaurantName?: string | null;
  brandName?: string | null;
  customerPhoneNumber?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  deliveryAddress?: { fullAddress?: string | null } | null;
  orderItems?: Array<{
    id?: number;
    idChooseableItem?: number;
    itemName?: string;
    quantity?: number;
    itemPrice?: number;
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
    })),
    restaurantName: raw.restaurantName ?? raw.brandName ?? undefined,
    deliveryAddress: raw.deliveryAddress?.fullAddress ?? undefined,
    paymentStatus:
      raw.paymentStatus != null
        ? (YIJI_PAYMENT_STATUS[raw.paymentStatus] ?? `payment_${raw.paymentStatus}`)
        : undefined,
    customerPhone: raw.customerPhoneNumber ?? undefined,
  };
}

/** Newest-first by placed date (ISO strings sort chronologically). */
function byNewest(a: YijiOrder, b: YijiOrder): number {
  return a.placedAt < b.placedAt ? 1 : a.placedAt > b.placedAt ? -1 : 0;
}

export class HttpYijiClient implements YijiClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly timeoutMs: number;

  constructor(opts: HttpYijiClientOptions) {
    if (!opts.baseUrl) throw new Error('HttpYijiClient: baseUrl is required');
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 6_000;
  }

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
      if (res.status === 404) return null;
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      // Network error / abort — never throw, surface as "unavailable" via null.
      return null;
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
          ? (YIJI_PAYMENT_STATUS[raw.paymentStatus] ?? `payment_${raw.paymentStatus}`)
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
  /** Override the mock fixtures (tests only). */
  mockFixtures?: MockFixtures;
}

/**
 * Build a YijiClient. Pass env explicitly — callers in Vite pass
 * `import.meta.env.VITE_YIJI_API_URL`; Node callers pass `process.env.YIJI_API_URL`.
 */
export function createYijiClient(env: YijiClientEnv = {}): YijiClient {
  if (env.apiUrl && env.apiUrl.trim()) {
    return new HttpYijiClient({ baseUrl: env.apiUrl, token: env.token });
  }
  return new MockYijiClient(env.mockFixtures);
}
