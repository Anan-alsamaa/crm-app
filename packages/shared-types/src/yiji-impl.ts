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

  getCustomer(vendorId: string, externalCustomerId: string): Promise<YijiCustomer | null> {
    return this.fetch<YijiCustomer>(
      `/v1/vendors/${encodeURIComponent(vendorId)}/customers/${encodeURIComponent(externalCustomerId)}`,
    );
  }

  async getOrders(
    vendorId: string,
    externalCustomerId: string,
    opts: { limit?: number } = {},
  ): Promise<YijiOrder[]> {
    const q = opts.limit ? `?limit=${opts.limit}` : '';
    return (
      (await this.fetch<YijiOrder[]>(
        `/v1/vendors/${encodeURIComponent(vendorId)}/customers/${encodeURIComponent(externalCustomerId)}/orders${q}`,
      )) ?? []
    );
  }

  getOrder(vendorId: string, orderId: string): Promise<YijiOrder | null> {
    return this.fetch<YijiOrder>(
      `/v1/vendors/${encodeURIComponent(vendorId)}/orders/${encodeURIComponent(orderId)}`,
    );
  }

  getPaymentStatus(vendorId: string, orderId: string): Promise<YijiPaymentStatus | null> {
    return this.fetch<YijiPaymentStatus>(
      `/v1/vendors/${encodeURIComponent(vendorId)}/orders/${encodeURIComponent(orderId)}/payment`,
    );
  }

  getShipmentTracking(vendorId: string, orderId: string): Promise<YijiShipmentTracking | null> {
    return this.fetch<YijiShipmentTracking>(
      `/v1/vendors/${encodeURIComponent(vendorId)}/orders/${encodeURIComponent(orderId)}/shipment`,
    );
  }

  getPurchaseActivity(
    vendorId: string,
    externalCustomerId: string,
  ): Promise<YijiPurchaseActivity | null> {
    return this.fetch<YijiPurchaseActivity>(
      `/v1/vendors/${encodeURIComponent(vendorId)}/customers/${encodeURIComponent(externalCustomerId)}/activity`,
    );
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
