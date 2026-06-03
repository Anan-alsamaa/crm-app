# Contract: YijiClient interface

Defined in `packages/shared-types` (or `packages/yiji-client`). A configurable **mock** implementation is used in dev; the **real** HTTP implementation is selected when `YIJI_API_URL` is set. All methods are read-only (the CRM never writes to the Yiji platform).

```ts
export interface YijiCustomer {
  externalCustomerId: string;
  name?: string;
  phone?: string;
  email?: string;
  metadata?: Record<string, unknown>;
}

export interface YijiOrder {
  orderId: string;
  status: string;          // e.g. placed | paid | shipped | delivered | cancelled | refunded
  total: number;
  currency: string;
  placedAt: string;        // ISO 8601
  items: Array<{ sku: string; name: string; qty: number; price: number }>;
}

export interface YijiPaymentStatus {
  orderId: string;
  status: string;          // e.g. pending | authorized | captured | failed | refunded
  method?: string;
  paidAt?: string;
}

export interface YijiShipmentTracking {
  orderId: string;
  carrier?: string;
  trackingNumber?: string;
  status: string;          // e.g. label_created | in_transit | out_for_delivery | delivered
  events: Array<{ at: string; description: string; location?: string }>;
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
  getOrders(yijiVendorId: string, externalCustomerId: string, opts?: { limit?: number }): Promise<YijiOrder[]>;
  getPaymentStatus(yijiVendorId: string, orderId: string): Promise<YijiPaymentStatus | null>;
  getShipmentTracking(yijiVendorId: string, orderId: string): Promise<YijiShipmentTracking | null>;
  getPurchaseActivity(yijiVendorId: string, externalCustomerId: string): Promise<YijiPurchaseActivity | null>;
}
```

## Selection
- `YIJI_API_URL` **unset** → `MockYijiClient` (configurable seed fixtures for dev/tests).
- `YIJI_API_URL` **set** → `HttpYijiClient` (authenticated via `YIJI_API_KEY`), with timeout + graceful failure so a Yiji outage degrades the order panel rather than blocking support.

## Consumer
Agent Portal renders the commerce **side panel** (orders, payment, shipment, purchase activity) alongside a conversation (FR-024). Failures show an inline "commerce data unavailable" state, never a hang.
