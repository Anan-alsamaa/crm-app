/**
 * YijiClient — read-only boundary to the host Yiji platform (commerce data).
 * A configurable mock is used in dev; the real HTTP impl is selected when
 * YIJI_API_URL is set. The CRM never writes to the Yiji platform.
 * Mirrors contracts/yiji-client.interface.md.
 */

export interface YijiCustomer {
  externalCustomerId: string;
  name?: string;
  phone?: string;
  email?: string;
  metadata?: Record<string, unknown>;
}

export interface YijiOrderItem {
  sku: string;
  name: string;
  qty: number;
  price: number;
  // Optional; the live single-order endpoint returns `itemCategory` per item.
  category?: string;
}

export interface YijiOrder {
  orderId: string;
  status: string; // placed | paid | shipped | delivered | cancelled | refunded
  total: number;
  currency: string;
  placedAt: string; // ISO 8601
  items: YijiOrderItem[];
  // The restaurant the order was placed with. `restaurantId` is present on both
  // the list and single-order endpoints; `restaurantName` only on the single
  // order (it is null in the list) — so it may be absent until an order is
  // fetched in detail.
  restaurantId?: string;
  restaurantName?: string;
  // The brand/eatery name (Yiji `brandName`), distinct from the branch/location
  // in `restaurantName` (e.g. brand "La Casa Pasta" at branch "Riyadh - Masief
  // Plaza"). Present on the single-order endpoint; kept separate so the UI can
  // show both rather than folding one into the other.
  brandName?: string;
  // Fulfilment method, mapped from Yiji's DeliveryType int to a human label
  // (e.g. 'delivery' | 'pickup'). Absent when the source value is unknown.
  deliveryType?: string;
  // Optional enrichment populated by the live Yiji API (absent in mock fixtures).
  deliveryAddress?: string;
  paymentStatus?: string;
  paymentMode?: string;
  customerPhone?: string;
  // Cart-level money facts from the single-order endpoint (Yiji `totalPoints`,
  // `totalCoupons`, `discount`). Present when the API returned them — 0 is a
  // real answer ("no points were used"), absent means the endpoint did not say.
  totalPointAmount?: number;
  totalCouponAmount?: number;
  totalDiscount?: number;
}

/** One step in an order's status timeline. */
export interface YijiOrderTimelineEvent {
  /** Machine status key, e.g. `in_kitchen`, `payment`, `pos_accepted`. */
  status: string;
  /** ISO 8601 instant, when known. */
  at: string | null;
}

/**
 * The order's life so far, step by step.
 *
 * Today this is DERIVED from the single-order endpoint (placed → payment →
 * current status), because Yiji exposes no status-history endpoint yet. When
 * the client provides one, only the gateway's implementation changes — the
 * shape here is already what the UI renders.
 */
export interface YijiOrderTimeline {
  orderId: string;
  /** The order's current status key. */
  current: string;
  /** True when this is the derived fallback, not a full upstream history. */
  derived: boolean;
  events: YijiOrderTimelineEvent[];
}

export interface YijiPaymentStatus {
  orderId: string;
  status: string; // pending | authorized | captured | failed | refunded
  method?: string;
  paidAt?: string;
}

export interface YijiShipmentEvent {
  at: string;
  description: string;
  location?: string;
}

export interface YijiShipmentTracking {
  orderId: string;
  carrier?: string;
  trackingNumber?: string;
  status: string; // label_created | in_transit | out_for_delivery | delivered
  events: YijiShipmentEvent[];
}

export interface YijiPurchaseActivity {
  externalCustomerId: string;
  lifetimeValue: number;
  orderCount: number;
  lastOrderAt?: string;
  recent: YijiOrder[];
}

export interface YijiClient {
  getCustomer(yijiVendorId: string, externalCustomerId: string): Promise<YijiCustomer | null>;
  getOrders(
    yijiVendorId: string,
    externalCustomerId: string,
    opts?: { limit?: number },
  ): Promise<YijiOrder[]>;
  /** Fetch a single order's full data by id. Returns null if not found. */
  getOrder(yijiVendorId: string, orderId: string): Promise<YijiOrder | null>;
  /**
   * The order's status timeline. Derived from the order itself until Yiji
   * provides a history endpoint — see YijiOrderTimeline.derived.
   */
  getOrderTimeline(yijiVendorId: string, orderId: string): Promise<YijiOrderTimeline | null>;
  getPaymentStatus(yijiVendorId: string, orderId: string): Promise<YijiPaymentStatus | null>;
  getShipmentTracking(yijiVendorId: string, orderId: string): Promise<YijiShipmentTracking | null>;
  getPurchaseActivity(
    yijiVendorId: string,
    externalCustomerId: string,
  ): Promise<YijiPurchaseActivity | null>;
}
