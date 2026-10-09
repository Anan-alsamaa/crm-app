/**
 * THE MOCK PLATFORM (MV-6, EMA-75): a vendor that talks to NOTHING.
 *
 * The owner wants the multi-vendor system PROVEN before a real second vendor
 * exists, and staging shares Yiji's PRODUCTION commerce, coupon and push APIs —
 * so a test vendor must never reach Yiji. This connector is that test vendor's
 * platform: deterministic simulated customers, orders (lines with modifiers),
 * carts and late orders, and a coupon/push transport that RECORDS what it was
 * sent in memory and answers like a platform that said yes.
 *
 * ZERO NETWORK. Nothing here imports an HTTP client or calls `fetch`; the
 * tests assert it with `fetch` stubbed to throw.
 *
 * GUARDED. A vendor on platform `mock` resolves only when the service was
 * started with `ALLOW_MOCK_VENDORS=true` (see `mockVendorsAllowed`), and never
 * against production Directus. Without the flag the registry refuses it with
 * `mock_not_allowed` — it is never answered by the Yiji connector.
 *
 * THE ADMIN TRANSPORT SPEAKS YIJI'S SHAPES. The workers' coupon and push
 * processors build Yiji payloads and read Yiji answers (`result: 1`, the new
 * coupon id in `exceptionMessage`, `extendedProperties.CouponUserId`). The mock
 * answers in those shapes so the real processors run end to end against it; a
 * real second platform gets its own coupon/push implementation instead.
 */
import type {
  CrmCouponOrderContext,
  CrmCustomer,
  CrmCustomerCoupon,
  CrmCustomerProfile,
  CrmLateOrder,
  CrmLateOrderQuery,
  CrmOrder,
  CrmOrderCart,
  CrmOrderTimeline,
  CrmPaymentStatus,
  CrmPurchaseActivity,
  CrmShipmentTracking,
  ConnectorVendor,
  MockPlatformSettings,
  PlatformAdminPoster,
  VendorConnector,
} from './connector.js';

/* ── Fixtures ────────────────────────────────────────────────────── */

interface MockLine {
  sku: string;
  name: string;
  qty: number;
  price: number;
  category: string;
  modifiers: string[];
}

interface MockOrderSeed {
  orderId: string;
  customerId: string;
  status: string;
  /** Live orders are placed `minutesAgo` before now; finished ones at `placedAt`. */
  minutesAgo?: number;
  placedAt?: string;
  live: boolean;
  deliveryType: 'delivery' | 'pickup';
  restaurantId: string;
  restaurantName: string;
  paymentMode: string;
  lines: MockLine[];
}

interface MockCustomerSeed {
  id: string;
  name: string;
  /** Canonical CRM form, `05XXXXXXXX`. */
  phone: string;
  email: string;
}

/** The catalogue. Every id carries `mock`, so nothing here can be mistaken for Yiji data. */
export const MOCK_CUSTOMERS: readonly MockCustomerSeed[] = [
  { id: 'mock-cust-1', name: 'Mock Customer One', phone: '0500000101', email: 'one@mock.test' },
  { id: 'mock-cust-2', name: 'Mock Customer Two', phone: '0500000102', email: 'two@mock.test' },
  { id: 'mock-cust-3', name: 'Mock Customer Three', phone: '0500000103', email: 'three@mock.test' },
];

const MOCK_ORDERS: readonly MockOrderSeed[] = [
  {
    orderId: 'MOCK-1001',
    customerId: 'mock-cust-1',
    status: 'in_delivery',
    minutesAgo: 95,
    live: true,
    deliveryType: 'delivery',
    restaurantId: 'mock-store-1',
    restaurantName: 'Mock Kitchen - Olaya',
    paymentMode: 'mada',
    lines: [
      {
        sku: 'MK-BG-01',
        name: 'Classic burger',
        qty: 2,
        price: 32,
        category: 'Burgers',
        modifiers: ['Extra cheese', 'No onions'],
      },
      {
        sku: 'MK-FR-02',
        name: 'Fries',
        qty: 1,
        price: 12,
        category: 'Sides',
        modifiers: ['Large'],
      },
    ],
  },
  {
    orderId: 'MOCK-1002',
    customerId: 'mock-cust-1',
    status: 'delivered',
    placedAt: '2026-09-01T12:00:00.000Z',
    live: false,
    deliveryType: 'pickup',
    restaurantId: 'mock-store-2',
    restaurantName: 'Mock Kitchen - Malqa',
    paymentMode: 'apple_pay',
    lines: [
      {
        sku: 'MK-SH-03',
        name: 'Shawarma platter',
        qty: 1,
        price: 45,
        category: 'Platters',
        modifiers: ['Garlic sauce'],
      },
    ],
  },
  {
    orderId: 'MOCK-1003',
    customerId: 'mock-cust-2',
    status: 'in_kitchen',
    minutesAgo: 70,
    live: true,
    deliveryType: 'delivery',
    restaurantId: 'mock-store-1',
    restaurantName: 'Mock Kitchen - Olaya',
    paymentMode: 'visa',
    lines: [
      {
        sku: 'MK-PZ-04',
        name: 'Margherita pizza',
        qty: 1,
        price: 55,
        category: 'Pizza',
        modifiers: ['Thin crust', 'Extra basil'],
      },
      {
        sku: 'MK-DR-05',
        name: 'Soft drink',
        qty: 2,
        price: 6,
        category: 'Drinks',
        modifiers: ['Pepsi'],
      },
    ],
  },
  {
    orderId: 'MOCK-1004',
    customerId: 'mock-cust-2',
    status: 'canceled',
    placedAt: '2026-08-15T18:30:00.000Z',
    live: false,
    deliveryType: 'delivery',
    restaurantId: 'mock-store-2',
    restaurantName: 'Mock Kitchen - Malqa',
    paymentMode: 'cash',
    lines: [
      {
        sku: 'MK-SL-06',
        name: 'Caesar salad',
        qty: 1,
        price: 30,
        category: 'Salads',
        modifiers: [],
      },
    ],
  },
];

/** The delivery fee on every mock delivery order. */
const MOCK_DELIVERY_FEE = 8;

/** The first id the mock hands out for a created coupon / an assignment. */
const MOCK_COUPON_ID_BASE = 900_000;
const MOCK_COUPON_USER_ID_BASE = 800_000;

/* ── The in-memory coupon / push ledger ──────────────────────────── */

/** One call the mock admin transport received. */
export interface MockAdminCall {
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

/** A coupon the mock "created" (`/Coupon/AddCoupon`). */
export interface MockCreatedCoupon {
  couponId: number;
  code: string;
}

/** A coupon the mock "assigned" to a customer. */
export interface MockAssignedCoupon {
  couponUserId: string;
  couponId: number | null;
  code: string;
  customerId: string | null;
  orderId: string | null;
}

export interface MockConnectorOptions {
  /** Injectable clock: live orders are placed relative to it. */
  now?: () => number;
}

/* ── Helpers ─────────────────────────────────────────────────────── */

const digits = (v: unknown): string => String(v ?? '').replace(/\D/g, '');

/** Any phone shape -> the 9 national digits `5XXXXXXXX`, or '' when not a Saudi mobile. */
function nationalMobile(phone: string): string {
  const d = digits(phone);
  const m = /^(?:00966|966|0)?(5\d{8})$/.exec(d);
  return m ? m[1]! : '';
}

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

const text = (...vs: unknown[]): string => {
  for (const v of vs) if (typeof v === 'string' && v.trim()) return v.trim();
  return '';
};

/* ── The connector ───────────────────────────────────────────────── */

export class MockConnector implements VendorConnector {
  readonly platform = 'mock' as const;
  readonly latestOrderId: VendorConnector['latestOrderId'];
  readonly latestOrderBrandName: VendorConnector['latestOrderBrandName'];
  readonly findCustomerIdByPhone: VendorConnector['findCustomerIdByPhone'];
  readonly getCustomerProfile: VendorConnector['getCustomerProfile'];
  readonly readCouponOrderContext: VendorConnector['readCouponOrderContext'];
  readonly findCustomerCoupon: VendorConnector['findCustomerCoupon'];
  readonly adminPost: PlatformAdminPoster;

  /** Every admin call, in order — for tests and for "what would have been sent". */
  readonly calls: MockAdminCall[] = [];
  readonly createdCoupons: MockCreatedCoupon[] = [];
  readonly assignedCoupons: MockAssignedCoupon[] = [];

  private readonly now: () => number;

  constructor(
    readonly vendor: ConnectorVendor,
    readonly settings: MockPlatformSettings,
    opts: MockConnectorOptions = {},
  ) {
    this.now = opts.now ?? Date.now;

    this.latestOrderId = async (customerId) => this.ordersOf(customerId)[0]?.orderId ?? null;
    this.latestOrderBrandName = async (customerId) =>
      this.ordersOf(customerId)[0]?.brandName ?? null;
    this.findCustomerIdByPhone = async (phone) =>
      this.customerByPhone(phone)?.externalCustomerId ?? null;
    this.getCustomerProfile = async (customerId) => {
      const c = this.customer(customerId);
      if (!c?.phone) return null;
      const profile: CrmCustomerProfile = {
        id: c.externalCustomerId,
        phone: `+966${c.phone.slice(1)}`,
      };
      if (c.name) profile.name = c.name;
      if (c.email) profile.email = c.email;
      return profile;
    };
    this.readCouponOrderContext = async (orderId) => {
      const seed = MOCK_ORDERS.find((o) => o.orderId === orderId);
      if (!seed) return null;
      const c = this.customer(seed.customerId)!;
      const ctx: CrmCouponOrderContext = {
        userId: c.externalCustomerId,
        customerPhone: `+966${c.phone!.slice(1)}`,
        restaurantId: 9001,
        brandId: 1,
        tenantId: 1,
      };
      if (c.name) ctx.customerName = c.name;
      return ctx;
    };
    this.findCustomerCoupon = async (customerId, code): Promise<CrmCustomerCoupon | null> => {
      const held = this.assignedCoupons.find((a) => a.customerId === customerId && a.code === code);
      return held ? { couponUserId: held.couponUserId, couponId: held.couponId } : null;
    };
    this.adminPost = (async (path: string, body: unknown, headers?: Record<string, string>) =>
      this.post(path, body, headers ?? {})) as PlatformAdminPoster;
  }

  /* ── The simulated admin transport ─────────────────────────────── */

  private post(path: string, body: unknown, headers: Record<string, string>): unknown {
    this.calls.push({ path, body, headers });
    const b = obj(body);
    const cu = obj(b.couponUser);
    const coupon = obj(b.coupon ?? cu.coupon);

    /* Create a coupon: the new id travels in `exceptionMessage`, as Yiji's does. */
    if (/\/coupon\/addcoupon$/i.test(path)) {
      const couponId = MOCK_COUPON_ID_BASE + this.createdCoupons.length + 1;
      this.createdCoupons.push({ couponId, code: text(b.code, coupon.code, b.couponCode) });
      return { result: 1, exceptionMessage: String(couponId), transactionStatus: 1 };
    }

    /* Assign a coupon (by order, or to a user): answers with the grant id. */
    if (/\/couponuser/i.test(path)) {
      const rawOrder = b.orderId ?? cu.orderId;
      const orderId = rawOrder != null && String(rawOrder).trim() ? String(rawOrder).trim() : null;
      const byOrder = orderId ? MOCK_ORDERS.find((o) => o.orderId === orderId) : undefined;
      const couponIdRaw = Number(b.couponId ?? cu.couponId);
      const assigned: MockAssignedCoupon = {
        couponUserId: String(MOCK_COUPON_USER_ID_BASE + this.assignedCoupons.length + 1),
        couponId: Number.isFinite(couponIdRaw) && couponIdRaw > 0 ? couponIdRaw : null,
        code: text(b.couponCode, cu.couponCode, coupon.code),
        customerId:
          text(b.userId, cu.userId) ||
          byOrder?.customerId ||
          this.customerByPhone(text(b.customerPhone, cu.customerPhone))?.externalCustomerId ||
          null,
        orderId,
      };
      this.assignedCoupons.push(assigned);
      return { result: 1, extendedProperties: { CouponUserId: assigned.couponUserId } };
    }

    /* Anything else (customer push): a no-op that succeeded. */
    return { result: 1 };
  }

  /* ── Customers ─────────────────────────────────────────────────── */

  /** A catalogue customer, or one synthesised for a `mock-<9 digits>` id. */
  private customer(id: string): CrmCustomer | null {
    const seed = MOCK_CUSTOMERS.find((c) => c.id === id);
    if (seed) {
      return { externalCustomerId: seed.id, name: seed.name, phone: seed.phone, email: seed.email };
    }
    const m = /^mock-(5\d{8})$/.exec(id ?? '');
    return m ? { externalCustomerId: id, name: 'Mock Customer', phone: `0${m[1]}` } : null;
  }

  /**
   * Phone -> customer. A catalogue phone is that customer; any other Saudi
   * mobile is a deterministic `mock-5XXXXXXXX` customer with no orders, so a
   * coupon for any test phone resolves without a real account anywhere.
   */
  private customerByPhone(phone: string): CrmCustomer | null {
    const national = nationalMobile(phone);
    if (!national) return null;
    const seed = MOCK_CUSTOMERS.find((c) => c.phone === `0${national}`);
    return this.customer(seed ? seed.id : `mock-${national}`);
  }

  /* ── Orders ────────────────────────────────────────────────────── */

  private placedAt(seed: MockOrderSeed): string {
    return seed.minutesAgo != null
      ? new Date(this.now() - seed.minutesAgo * 60_000).toISOString()
      : seed.placedAt!;
  }

  private brandName(): string {
    return `${this.vendor.name?.trim() || 'Mock'} Kitchen`;
  }

  private order(seed: MockOrderSeed): CrmOrder {
    const food = seed.lines.reduce((s, l) => s + l.qty * l.price, 0);
    const fee = seed.deliveryType === 'delivery' ? MOCK_DELIVERY_FEE : 0;
    const customer = this.customer(seed.customerId);
    return {
      orderId: seed.orderId,
      status: seed.status,
      total: food + fee,
      currency: 'SAR',
      placedAt: this.placedAt(seed),
      items: seed.lines.map((l) => ({
        sku: l.sku,
        name: l.name,
        qty: l.qty,
        price: l.price,
        category: l.category,
        modifiers: [...l.modifiers],
      })),
      restaurantId: seed.restaurantId,
      restaurantName: seed.restaurantName,
      brandName: this.brandName(),
      deliveryType: seed.deliveryType,
      ...(seed.deliveryType === 'delivery' ? { deliveryAddress: 'Mock Street 1, Riyadh' } : {}),
      paymentStatus: seed.status === 'canceled' ? 'not_paid' : 'paid',
      paymentMode: seed.paymentMode,
      ...(customer?.phone ? { customerPhone: customer.phone } : {}),
      totalPointAmount: 0,
      totalCouponAmount: 0,
      totalDiscount: 0,
    };
  }

  /** Newest first. */
  private ordersOf(customerId: string): CrmOrder[] {
    return MOCK_ORDERS.filter((o) => o.customerId === customerId)
      .map((o) => this.order(o))
      .sort((a, b) => Date.parse(b.placedAt) - Date.parse(a.placedAt));
  }

  private seed(orderId: string): MockOrderSeed | undefined {
    return MOCK_ORDERS.find((o) => o.orderId === orderId);
  }

  async getCustomer(externalCustomerId: string): Promise<CrmCustomer | null> {
    return this.customer(externalCustomerId);
  }

  async getOrders(externalCustomerId: string, opts?: { limit?: number }): Promise<CrmOrder[]> {
    const all = this.ordersOf(externalCustomerId);
    return opts?.limit ? all.slice(0, opts.limit) : all;
  }

  async getOrder(orderId: string): Promise<CrmOrder | null> {
    const s = this.seed(orderId);
    return s ? this.order(s) : null;
  }

  async getOrderTimeline(orderId: string): Promise<CrmOrderTimeline | null> {
    const s = this.seed(orderId);
    if (!s) return null;
    const placed = Date.parse(this.placedAt(s));
    const step = (status: string, minutes: number) => ({
      status,
      at: new Date(placed + minutes * 60_000).toISOString(),
    });
    const events = [step('placed', 0), step('payment', 1), step('received', 2)];
    if (s.status !== 'received') events.push(step(s.status, 20));
    return { orderId, current: s.status, derived: false, events };
  }

  async getOrderCart(orderId: string): Promise<CrmOrderCart | null> {
    const s = this.seed(orderId);
    if (!s) return null;
    const o = this.order(s);
    const food = s.lines.reduce((sum, l) => sum + l.qty * l.price, 0);
    return {
      orderId,
      lines: s.lines.map((l) => ({
        name: l.name,
        qty: l.qty,
        price: l.price,
        category: l.category,
        modifiers: [...l.modifiers],
      })),
      foodPrice: food,
      deliveryFee: o.total - food,
      discount: 0,
      tax: 0,
      total: o.total,
      ...(o.restaurantName ? { restaurantName: o.restaurantName } : {}),
      ...(o.brandName ? { brandName: o.brandName } : {}),
      ...(o.deliveryAddress ? { deliveryAddress: o.deliveryAddress } : {}),
    };
  }

  async getPaymentStatus(orderId: string): Promise<CrmPaymentStatus | null> {
    const s = this.seed(orderId);
    if (!s) return null;
    const paid = s.status !== 'canceled';
    return {
      orderId,
      status: paid ? 'captured' : 'failed',
      method: s.paymentMode,
      ...(paid ? { paidAt: this.placedAt(s) } : {}),
    };
  }

  async getShipmentTracking(orderId: string): Promise<CrmShipmentTracking | null> {
    const s = this.seed(orderId);
    if (!s || s.deliveryType !== 'delivery') return null;
    const placed = Date.parse(this.placedAt(s));
    return {
      orderId,
      carrier: 'Mock Fleet',
      trackingNumber: `MF-${orderId}`,
      status: s.status === 'delivered' ? 'delivered' : 'in_transit',
      events: [
        {
          at: new Date(placed + 30 * 60_000).toISOString(),
          description: 'Picked up',
          location: 'Mock Kitchen',
        },
      ],
    };
  }

  async getPurchaseActivity(externalCustomerId: string): Promise<CrmPurchaseActivity | null> {
    if (!this.customer(externalCustomerId)) return null;
    const orders = this.ordersOf(externalCustomerId);
    return {
      externalCustomerId,
      lifetimeValue: orders.reduce((s, o) => s + o.total, 0),
      orderCount: orders.length,
      ...(orders[0] ? { lastOrderAt: orders[0].placedAt } : {}),
      recent: orders.slice(0, 3),
    };
  }

  /**
   * The live delivery orders running past the threshold (with
   * `includeCompleted`, the finished delivery orders too, clock stopped).
   */
  async getLateDeliveryOrders(
    thresholdMinutes: number,
    opts: CrmLateOrderQuery = {},
  ): Promise<CrmLateOrder[]> {
    const out: CrmLateOrder[] = [];
    for (const s of MOCK_ORDERS) {
      if (s.deliveryType !== 'delivery') continue;
      if (!s.live && !opts.includeCompleted) continue;
      const o = this.order(s);
      const minutesElapsed = s.live ? (s.minutesAgo ?? 0) : 60 + thresholdMinutes;
      if (minutesElapsed < thresholdMinutes) continue;
      const c = this.customer(s.customerId);
      out.push({
        orderId: o.orderId,
        status: o.status,
        minutesElapsed,
        live: s.live,
        placedAt: o.placedAt,
        ...(o.brandName ? { brandName: o.brandName } : {}),
        ...(o.restaurantName ? { restaurantName: o.restaurantName } : {}),
        ...(o.restaurantId ? { restaurantId: o.restaurantId } : {}),
        ...(c?.name ? { customerName: c.name } : {}),
        ...(c?.phone ? { customerPhone: c.phone } : {}),
        total: o.total,
        externalCustomerId: s.customerId,
      });
    }
    return out.sort((a, b) => b.minutesElapsed - a.minutesElapsed);
  }
}
