/**
 * YIJI V2 - THE SECOND TENANT (owner, 2026-11-16, Yiji V2 decisions 0023/0024).
 *
 * Yiji v2 is a second commerce PLATFORM (`yiji2`) next to Yiji v1, served by
 * this connector through the same `VendorConnector` contract the inbox, the
 * order panel, the coupon processors and the late-orders board already use.
 * Nothing in the v1 path changes: a `yiji` vendor still resolves to
 * `YijiConnector`, and a `yiji2` vendor is refused everywhere until its own
 * row exists and is ACTIVE - never answered by v1's connector.
 *
 * WHAT V2 LOOKS LIKE (docs/YIJI-V2-TENANT.md, brief
 * `yiji-v2-second-tenant.md`): partner API under `<api_base_url>/partner/v1`,
 * client-credentials auth (`POST /auth/token`, 15-minute bearer), 600
 * requests a minute (429 + Retry-After), int64 ids answered as JSON numbers
 * OR strings (both parsed), money ALWAYS a pair `{ amount_minor, currency }`
 * (SAR = 2 decimals, BHD = 3), RFC 3339 UTC times, errors as
 * `{ error: { code, message } }`, writes idempotent on `Idempotency-Key`.
 *
 * THE ADMIN TRANSPORT TRANSLATES. The workers' coupon and push processors
 * build Yiji v1 payloads and read v1 answers (`result: 1`, the new coupon id
 * in `exceptionMessage`, `extendedProperties.CouponUserId`). Rather than a
 * second 2,000-line money path, this connector's `adminPost` takes those v1
 * paths and bodies, calls the v2 partner routes they map to (section 3 of the
 * brief: `AddCoupon` -> `POST /compensation-coupons`, `AddUserCoupon` ->
 * `POST /grants`, ...), and answers in v1's shapes - exactly what the mock
 * platform does in memory. The v1 processors therefore run unchanged against
 * v2, and every v1 safeguard (read-back on refusal, idempotency key, Private
 * check) still applies.
 *
 * TWO TRANSPORTS. `HttpYiji2Transport` is the real one. `MockYiji2Transport`
 * answers the same partner routes from memory with deterministic v2-shaped
 * data (`2611000000001`-style order numbers, minor-unit money, SA and BH
 * customers) and RECORDS every write, so the whole path - connector mapping,
 * coupon delivery, push, late-order events - is tested without a v2 host. The
 * mock is chosen only when the vendor's settings say `mock: true`, which
 * `RecordVendorSettingsSource` sets ONLY where `ALLOW_MOCK_VENDORS=true`
 * (never production) and the record names no API URL.
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
  PlatformAdminPoster,
  VendorConnector,
  YijiPlatformSettings,
} from './connector.js';
import { YIJI2_CLOSING_STATES, YIJI2_STATE_STATUS } from './order-events.js';
import { normalizePhone } from './phone.js';
import { YijiRefusedError } from './yiji-impl.js';

/* ── Settings ────────────────────────────────────────────────────── */

/**
 * Everything the v2 connector needs for ONE vendor. Non-secret fields come
 * from the vendor record (`api_base_url`, `tenant_id`, `brand_id`,
 * `notify_settings`); the client credentials come from the service env as
 * `VENDOR_<KEY>_CLIENT_ID` / `VENDOR_<KEY>_CLIENT_SECRET` (never Yiji v1's).
 */
export interface Yiji2PlatformSettings {
  platform: 'yiji2';
  /** `vendors.api_base_url`, e.g. `https://api.staging.yiji.app` (without `/partner/v1`). */
  apiBaseUrl?: string;
  clientId?: string;
  clientSecret?: string;
  tenantId?: string;
  brandId?: string;
  /** Same shape as v1's, so the push processor runs unchanged. `apiKey` is unused on v2. */
  push?: YijiPlatformSettings['push'];
  /** In-memory transport: tests, or staging with ALLOW_MOCK_VENDORS and no API URL. */
  mock?: boolean;
  /** Which v2 environment the vendor row names; informational (logged, echoed). */
  environment?: string;
  /** Money currency for coupon bodies: SAR (default) or BHD. Explicit only. */
  currency?: 'SAR' | 'BHD';
}

/** The partner API's base path. */
export const YIJI2_PARTNER_BASE_PATH = '/partner/v1';
/** The platform id the brief proposes for the v2 vendor row (owner to confirm). */
export const YIJI2_DEFAULT_VENDOR_ID = '2';
/** The webhook key the brief proposes (`/webhooks/yiji2/...`, `VENDOR_YIJI2_*`). */
export const YIJI2_VENDOR_KEY = 'yiji2';

/* ── Wire shapes (the subset the CRM reads) ───────────────────────── */

export interface Yiji2Money {
  amount_minor: number;
  currency: string;
}

/** Minor units per major unit, by ISO 4217 currency. BHD has three decimals. */
export function yiji2MinorUnits(currency: string | null | undefined): number {
  return String(currency ?? '')
    .trim()
    .toUpperCase() === 'BHD'
    ? 1000
    : 100;
}

/** A v2 money pair as the CRM's number in major units (SAR 12.50 -> 12.5). */
export function yiji2Amount(m: Partial<Yiji2Money> | null | undefined): number | undefined {
  const minor = num(m?.amount_minor);
  if (minor === undefined) return undefined;
  return minor / yiji2MinorUnits(m?.currency);
}

/** The CRM's number back into v2's pair, for the bodies this connector sends. */
export function yiji2Minor(amount: number, currency: string): Yiji2Money {
  return {
    amount_minor: Math.round(amount * yiji2MinorUnits(currency)),
    currency: currency.toUpperCase(),
  };
}

/** `order_number` = YYMM x 10^9 + sequence (e.g. 2611000000001). */
export function isYiji2OrderNumber(v: unknown): boolean {
  const s = String(v ?? '').trim();
  return (
    /^\d{13}$/.test(s) &&
    Number(s.slice(0, 2)) >= 26 &&
    Number(s.slice(2, 4)) >= 1 &&
    Number(s.slice(2, 4)) <= 12
  );
}

/** Ids are int64 and arrive as numbers or strings: always a trimmed string here. */
export function yiji2Id(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string' && v.trim()) return v.trim();
  return undefined;
}

export interface Yiji2CustomerWire {
  id: number | string;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  country?: string | null;
  /** The customer's coupons, when `GET /customers/{id}` includes them. */
  coupons?: Yiji2GrantWire[] | null;
  points?: { balance?: number | null } | null;
}

export interface Yiji2OrderItemWire {
  item_id?: number | string | null;
  sku?: string | null;
  name: string;
  quantity: number;
  unit_price: Yiji2Money;
  category?: string | null;
  modifiers?: Array<{
    group?: string | null;
    name: string;
    quantity?: number | null;
    unit_price?: Yiji2Money | null;
  }> | null;
}

export interface Yiji2OrderWire {
  order_number: number | string;
  customer_id?: number | string | null;
  customer?: { id?: number | string | null; name?: string | null; phone?: string | null } | null;
  state: string;
  is_open?: boolean | null;
  order_type?: string | null;
  country?: string | null;
  placed_at: string;
  restaurant_id?: number | string | null;
  restaurant_name?: string | null;
  brand_id?: number | string | null;
  brand_name?: string | null;
  address?: { text?: string | null } | string | null;
  payment?: { state?: string | null; method?: string | null; paid_at?: string | null } | null;
  money?: {
    items?: Yiji2Money | null;
    delivery_fee?: Yiji2Money | null;
    discount?: Yiji2Money | null;
    coupon?: Yiji2Money | null;
    points?: Yiji2Money | null;
    tax?: Yiji2Money | null;
    total: Yiji2Money;
  } | null;
  total?: Yiji2Money | null;
  coupon?: { id?: number | string | null; code?: string | null } | null;
  tracking_url?: string | null;
  items?: Yiji2OrderItemWire[] | null;
  /** A food-court order's parts; a sub-order names its master. */
  sub_orders?: Yiji2OrderWire[] | null;
  parent_order_number?: number | string | null;
  timeline?: Array<{ state: string; at?: string | null }> | null;
}

export interface Yiji2GrantWire {
  grant_id?: number | string | null;
  id?: number | string | null;
  coupon_id?: number | string | null;
  code?: string | null;
  state?: string | null;
  customer_id?: number | string | null;
}

/* ── Mapping (pure) ──────────────────────────────────────────────── */

const num = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

/**
 * v2 `state` -> the CRM's order status word (the board shows `in_delivery`
 * etc.). Exactly v2's 15 states (contract 2026-11-17), shared with the
 * events mapper (`order-events.ts`) so the two never disagree. An unknown
 * word passes through as itself.
 */
export const YIJI2_STATE_TO_STATUS: Record<string, string> = YIJI2_STATE_STATUS;
/** delivered, handed_over, closed, cancelled - nothing else closes an order. */
const CLOSED_STATES = YIJI2_CLOSING_STATES;

export function yiji2Status(state: string | null | undefined): string {
  const s = String(state ?? '')
    .trim()
    .toLowerCase();
  return YIJI2_STATE_TO_STATUS[s] ?? (s || 'unknown');
}

export function yiji2IsOpen(state: string | null | undefined, isOpen?: boolean | null): boolean {
  if (typeof isOpen === 'boolean') return isOpen;
  return !CLOSED_STATES.has(
    String(state ?? '')
      .trim()
      .toLowerCase(),
  );
}

/** The CRM's canonical `05XXXXXXXX` for a Saudi number; other countries kept as sent. */
function crmPhone(raw: string | null | undefined): string | undefined {
  const s = str(raw);
  if (!s) return undefined;
  const n = normalizePhone(s);
  return n || s;
}

export function mapYiji2Customer(c: Yiji2CustomerWire | null | undefined): CrmCustomer | null {
  const id = yiji2Id(c?.id);
  if (!c || !id) return null;
  const out: CrmCustomer = { externalCustomerId: id };
  const name = str(c.name);
  const phone = crmPhone(c.phone);
  const email = str(c.email);
  if (name) out.name = name;
  if (phone) out.phone = phone;
  if (email) out.email = email;
  const country = str(c.country);
  if (country) out.metadata = { country };
  return out;
}

const deliveryType = (t: string | null | undefined): string | undefined => {
  const s = str(t)?.toLowerCase();
  if (!s) return undefined;
  if (s === 'delivery') return 'delivery';
  if (s === 'pickup' || s === 'takeaway' || s === 'takeout') return 'pickup';
  return s;
};

function mapItems(items: Yiji2OrderItemWire[] | null | undefined) {
  return (items ?? []).map((i) => {
    const groups = new Map<string, Array<{ name: string; qty: number; price: number }>>();
    for (const m of i.modifiers ?? []) {
      const g = str(m.group) ?? 'Options';
      const list = groups.get(g) ?? [];
      list.push({
        name: m.name,
        qty: num(m.quantity) ?? 1,
        price: yiji2Amount(m.unit_price ?? undefined) ?? 0,
      });
      groups.set(g, list);
    }
    const modifiers = (i.modifiers ?? []).map((m) => m.name);
    return {
      sku: str(i.sku) ?? yiji2Id(i.item_id) ?? i.name,
      name: i.name,
      qty: num(i.quantity) ?? 1,
      price: yiji2Amount(i.unit_price) ?? 0,
      ...(str(i.category) ? { category: str(i.category) } : {}),
      ...(modifiers.length ? { modifiers } : {}),
      ...(groups.size
        ? { modifierGroups: [...groups].map(([name, options]) => ({ name, options })) }
        : {}),
    };
  });
}

export function mapYiji2Order(o: Yiji2OrderWire | null | undefined): CrmOrder | null {
  const orderId = yiji2Id(o?.order_number);
  if (!o || !orderId) return null;
  const total = o.money?.total ?? o.total ?? null;
  const currency = str(total?.currency) ?? 'SAR';
  const out: CrmOrder = {
    orderId,
    status: yiji2Status(o.state),
    total: yiji2Amount(total) ?? 0,
    currency,
    placedAt: o.placed_at,
    items: mapItems(o.items),
  };
  const restaurantId = yiji2Id(o.restaurant_id);
  const restaurantName = str(o.restaurant_name);
  const brandName = str(o.brand_name);
  const dt = deliveryType(o.order_type);
  const address = typeof o.address === 'string' ? str(o.address) : str(o.address?.text);
  const phone = crmPhone(o.customer?.phone);
  if (restaurantId) out.restaurantId = restaurantId;
  if (restaurantName) out.restaurantName = restaurantName;
  if (brandName) out.brandName = brandName;
  if (dt) out.deliveryType = dt;
  if (address) out.deliveryAddress = address;
  if (str(o.payment?.state)) out.paymentStatus = str(o.payment?.state);
  if (str(o.payment?.method)) out.paymentMode = str(o.payment?.method);
  if (phone) out.customerPhone = phone;
  const points = yiji2Amount(o.money?.points ?? undefined);
  const coupon = yiji2Amount(o.money?.coupon ?? undefined);
  const discount = yiji2Amount(o.money?.discount ?? undefined);
  if (points !== undefined) out.totalPointAmount = points;
  if (coupon !== undefined) out.totalCouponAmount = coupon;
  if (discount !== undefined) out.totalDiscount = discount;
  const parent = yiji2Id(o.parent_order_number);
  if (parent) {
    out.groupRole = 'sub';
    out.groupMasterId = parent;
  } else if ((o.sub_orders ?? []).length > 0) {
    out.groupRole = 'master';
    out.groupMasterId = orderId;
  }
  return out;
}

export function mapYiji2Cart(o: Yiji2OrderWire | null | undefined): CrmOrderCart | null {
  const orderId = yiji2Id(o?.order_number);
  if (!o || !orderId) return null;
  const items = mapItems(o.items);
  const out: CrmOrderCart = {
    orderId,
    lines: items.map((i) => ({
      name: i.name,
      qty: i.qty,
      price: i.price,
      ...(i.category ? { category: i.category } : {}),
      modifiers: i.modifiers ?? [],
      ...(i.modifierGroups ? { modifierGroups: i.modifierGroups } : {}),
    })),
  };
  const m = o.money;
  const food = yiji2Amount(m?.items ?? undefined);
  const fee = yiji2Amount(m?.delivery_fee ?? undefined);
  const discount = yiji2Amount(m?.discount ?? undefined);
  const tax = yiji2Amount(m?.tax ?? undefined);
  const total = yiji2Amount(m?.total ?? o.total ?? undefined);
  if (food !== undefined) out.foodPrice = food;
  if (fee !== undefined) out.deliveryFee = fee;
  if (discount !== undefined) out.discount = discount;
  if (tax !== undefined) out.tax = tax;
  if (total !== undefined) out.total = total;
  if (str(o.coupon?.code)) out.couponCode = str(o.coupon?.code);
  if (str(o.restaurant_name)) out.restaurantName = str(o.restaurant_name);
  if (str(o.brand_name)) out.brandName = str(o.brand_name);
  const address = typeof o.address === 'string' ? str(o.address) : str(o.address?.text);
  if (address) out.deliveryAddress = address;
  if (str(o.tracking_url)) out.trackingUrl = str(o.tracking_url);
  return out;
}

/** `GET /orders/{n}/history` (or the order's own `timeline`) as the CRM's timeline. */
export function mapYiji2History(
  orderId: string,
  rows: Array<{ state: string; at?: string | null }> | null | undefined,
  currentState?: string | null,
): CrmOrderTimeline {
  const events = (rows ?? [])
    .map((r) => ({ status: yiji2Status(r.state), at: str(r.at) ?? null }))
    .sort((a, b) => (a.at && b.at ? Date.parse(a.at) - Date.parse(b.at) : 0));
  const current = currentState ? yiji2Status(currentState) : (events.at(-1)?.status ?? 'unknown');
  return { orderId, current, derived: false, events };
}

/** The order as a coupon needs it (v1's `CouponOrderContext`, in v2's ids). */
export function mapYiji2CouponContext(
  o: Yiji2OrderWire | null | undefined,
  tenantId?: string,
): CrmCouponOrderContext | null {
  if (!o) return null;
  const ctx: CrmCouponOrderContext = {};
  const userId = yiji2Id(o.customer_id) ?? yiji2Id(o.customer?.id);
  if (userId) ctx.userId = userId;
  const phone = str(o.customer?.phone);
  if (phone) ctx.customerPhone = phone;
  if (str(o.customer?.name)) ctx.customerName = str(o.customer?.name);
  const r = num(o.restaurant_id);
  const b = num(o.brand_id);
  const t = num(tenantId);
  if (r !== undefined) ctx.restaurantId = r;
  if (b !== undefined) ctx.brandId = b;
  if (t !== undefined) ctx.tenantId = t;
  return ctx;
}

/* ── Transport ───────────────────────────────────────────────────── */

export interface Yiji2RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  idempotencyKey?: string;
}

/**
 * The partner API, as the connector speaks to it. A 404 on a READ (GET)
 * answers `null` ("no such thing"); a 404 on a WRITE (POST/PUT/DELETE) is a
 * `Yiji2RefusedError` with code `not_found` (contract 2026-11-17: `DELETE
 * /grants/{id}` and `POST /grants` answer 404 for grants and coupons the CRM
 * did not create), so a write can never be mistaken for a silent success.
 */
export interface Yiji2Transport {
  request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    opts?: Yiji2RequestOptions,
  ): Promise<T | null>;
}

/**
 * v2 said no: a 4xx with `{ error: { code, message_key, trace_id } }` (the
 * v2 session, 2026-11-16: invalid input is HTTP 400 `VALIDATION_FAILED`, no
 * field list, the same shape as its customer and staff APIs). Never retried:
 * the same body gets the same answer. The connector's `adminPost` hands it
 * to the v1 coupon processor as the refusal it recognises (`yiji2RefusalAsV1`).
 */
export class Yiji2RefusedError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly traceId: string | null = null,
    /** The field v2 names on a 400 VALIDATION_FAILED (e.g. `category`), when it names one. */
    readonly field: string | null = null,
  ) {
    super(message);
    this.name = 'Yiji2RefusedError';
  }
}

/**
 * A v2 refusal in the shape the UNCHANGED v1 coupon processor records and
 * stops on (`isYijiRefused`: name + status; `describeRefusal`: the
 * `exceptionMessage`). Without this a 400 from v2 would be an unknown error
 * to that processor and BullMQ would retry it five times for the same answer.
 */
export function yiji2RefusalAsV1(err: Yiji2RefusedError): YijiRefusedError {
  const detail =
    `${err.code}${err.field ? ` [${err.field}]` : ''}: ${err.message}` +
    (err.traceId ? ` (trace ${err.traceId})` : '');
  return new YijiRefusedError(detail, err.status, { result: 2, exceptionMessage: detail });
}

/** v2 could not answer (5xx, network, timeout, 429). Retried by the caller's rules. */
export class Yiji2UnavailableError extends Error {
  /** The v1 helpers' shape test (`isYijiUnavailable`): an outage, not an answer. */
  readonly isYijiUnavailable = true;
  constructor(
    message: string,
    readonly retryAfterSec: number | null = null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'Yiji2UnavailableError';
  }
}

export interface HttpYiji2TransportOptions {
  apiBaseUrl: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * The real transport: client-credentials token (cached, refreshed a minute
 * before it expires, re-fetched once on a 401), bearer on every call,
 * `Idempotency-Key` on writes, 429 -> unavailable with `Retry-After`.
 */
export class HttpYiji2Transport implements Yiji2Transport {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: HttpYiji2TransportOptions) {
    this.base = opts.apiBaseUrl.replace(/\/+$/, '') + YIJI2_PARTNER_BASE_PATH;
    this.doFetch = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.now = opts.now ?? Date.now;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.doFetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      const reason =
        err instanceof Error && err.name === 'AbortError'
          ? `timed out after ${this.timeoutMs}ms`
          : `network error: ${err instanceof Error ? err.message : String(err)}`;
      throw new Yiji2UnavailableError(`${reason} for ${url}`, null, { cause: err });
    } finally {
      clearTimeout(timer);
    }
  }

  private async accessToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt - 60_000 > this.now()) return this.token.value;
    const res = await this.send(`${this.base}/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
      }),
    });
    /* A token the CRM cannot get is an OUTAGE, never a settled answer about
       the coupon: a rotated secret, a wrong host or a down auth server must
       leave the coupon retried, not parked under `yiji_push_error` (the v1
       client treats a refused login the same way; review 2026-11-16). */
    if (!res.ok) {
      throw new Yiji2UnavailableError(
        `yiji2 token endpoint answered ${res.status} - credentials or endpoint`,
      );
    }
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!body.access_token) throw new Yiji2UnavailableError('yiji2 token endpoint sent no token');
    const ttl = (num(body.expires_in) ?? 15 * 60) * 1000;
    this.token = { value: body.access_token, expiresAt: this.now() + ttl };
    return body.access_token;
  }

  async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    opts: Yiji2RequestOptions = {},
  ): Promise<T | null> {
    const q = Object.entries(opts.query ?? {}).filter(([, v]) => v !== undefined && v !== '');
    const url =
      `${this.base}${path.startsWith('/') ? path : `/${path}`}` +
      (q.length
        ? `?${new URLSearchParams(q.map(([k, v]) => [k, String(v)] as [string, string])).toString()}`
        : '');
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken(attempt > 0);
      const res = await this.send(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      });
      if (res.status === 401 && attempt === 0) continue;
      if (res.status === 404 && method === 'GET') return null;
      if (res.status === 429) {
        const ra = num(res.headers?.get?.('retry-after'));
        throw new Yiji2UnavailableError('yiji2 rate limited (429)', ra ?? null);
      }
      if (res.status >= 500) throw new Yiji2UnavailableError(`yiji2 answered ${res.status}`);
      if (res.status === 204) return {} as T;
      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        /* `{ error: { code, message_key, trace_id } }`; older drafts said
           `message`. 400 VALIDATION_FAILED lands here too: refused, not retried. */
        const e = obj(obj(body).error);
        /* A write that answers 404 is "not found / not ours" - a refusal
           with code not_found whatever the body says (or does not say). */
        const code = res.status === 404 ? 'not_found' : (str(e.code) ?? `http_${res.status}`);
        const key = str(e.message_key);
        throw new Yiji2RefusedError(
          code,
          str(e.message) ??
            (key
              ? `${code} (${key})`
              : res.status === 404
                ? `${method} ${path}: not found`
                : `yiji2 refused (${res.status})`),
          res.status,
          str(e.trace_id) ?? null,
          str(e.field) ?? null,
        );
      }
      return body as T;
    }
  }
}

/* ── The mock transport ──────────────────────────────────────────── */

export interface Yiji2MockCall {
  method: string;
  path: string;
  body: unknown;
  idempotencyKey?: string;
}

interface MockCustomerSeed {
  id: string;
  name: string;
  /** International, as v2 stores it. */
  phone: string;
  email: string;
  country: 'SA' | 'BH';
  /** False = no registered handset: `POST /customers/{id}/push` answers `no_device`. */
  device?: boolean;
}
interface MockOrderSeed {
  orderNumber: string;
  customerId: string;
  state: string;
  minutesAgo?: number;
  placedAt?: string;
  orderType: 'delivery' | 'pickup';
  restaurantId: string;
  restaurantName: string;
  brandId: string;
  brandName: string;
  currency: 'SAR' | 'BHD';
  items: Array<{
    sku: string;
    name: string;
    quantity: number;
    unitMinor: number;
    category: string;
    modifiers: Array<{ group: string; name: string; unitMinor: number }>;
  }>;
}

/** Every id carries a v2 shape (int64 customers, YYMM order numbers), never a v1 GUID. */
export const YIJI2_MOCK_CUSTOMERS: readonly MockCustomerSeed[] = [
  {
    id: '2000000001',
    name: 'V2 Customer One',
    phone: '+966500000201',
    email: 'one@v2.test',
    country: 'SA',
  },
  {
    id: '2000000002',
    name: 'V2 Customer Two',
    phone: '+966500000202',
    email: 'two@v2.test',
    country: 'SA',
  },
  {
    id: '2000000003',
    name: 'V2 Customer Manama',
    phone: '+97336000203',
    email: 'bh@v2.test',
    country: 'BH',
    device: false,
  },
];

/**
 * Restaurants the mock knows, for the coupon rules (contract 2026-11-17):
 * the brand must have an ACTIVE restaurant in the coupon's country, and a
 * named `restaurant_id` must belong to that brand and country. Brand 93 has
 * only an inactive restaurant, so it is refused everywhere.
 */
export const YIJI2_MOCK_RESTAURANTS: ReadonlyArray<{
  id: string;
  brandId: string;
  country: 'SA' | 'BH';
  active: boolean;
}> = [
  { id: '9101', brandId: '91', country: 'SA', active: true },
  { id: '9102', brandId: '91', country: 'SA', active: true },
  { id: '9201', brandId: '91', country: 'BH', active: true },
  { id: '9301', brandId: '93', country: 'SA', active: false },
];

/**
 * A coupon and grant NOT created by the CRM (the app's welcome coupon). Reads
 * return it like any other grant; `POST /grants` and `DELETE /grants/{id}`
 * answer 404 for it (contract 2026-11-17: writes work only on the CRM's own).
 */
export const YIJI2_MOCK_FOREIGN_GRANT = {
  grant_id: '600001',
  coupon_id: '400001',
  code: 'V2-APP-WELCOME',
  customer_id: '2000000001',
  order_number: null,
  removed: false,
} as const;

/** The country's own currency (contract 2026-11-17): SA -> SAR, BH -> BHD. */
export const YIJI2_COUNTRY_CURRENCY: Readonly<Record<string, 'SAR' | 'BHD'>> = {
  SA: 'SAR',
  BH: 'BHD',
};

/**
 * At or above this many MINOR units v2 raises an alert on its side (SAR 200 =
 * 20000 halalas, BHD 20 = 20000 fils). Never a refusal.
 */
export const YIJI2_LARGE_COUPON_ALERT_MINOR = 20_000;

export const YIJI2_MOCK_ORDERS: readonly MockOrderSeed[] = [
  {
    orderNumber: '2611000000001',
    customerId: '2000000001',
    state: 'out_for_delivery',
    minutesAgo: 95,
    orderType: 'delivery',
    restaurantId: '9101',
    restaurantName: 'V2 Kitchen - Olaya',
    brandId: '91',
    brandName: 'V2 Kitchen',
    currency: 'SAR',
    items: [
      {
        sku: 'V2-BG-01',
        name: 'Classic burger',
        quantity: 2,
        unitMinor: 3200,
        category: 'Burgers',
        modifiers: [
          { group: 'Extras', name: 'Extra cheese', unitMinor: 300 },
          { group: 'Extras', name: 'No onions', unitMinor: 0 },
        ],
      },
      {
        sku: 'V2-FR-02',
        name: 'Fries',
        quantity: 1,
        unitMinor: 1200,
        category: 'Sides',
        modifiers: [],
      },
    ],
  },
  {
    orderNumber: '2611000000002',
    customerId: '2000000001',
    state: 'delivered',
    placedAt: '2026-11-01T12:00:00.000Z',
    orderType: 'pickup',
    restaurantId: '9102',
    restaurantName: 'V2 Kitchen - Malqa',
    brandId: '91',
    brandName: 'V2 Kitchen',
    currency: 'SAR',
    items: [
      {
        sku: 'V2-SH-03',
        name: 'Shawarma platter',
        quantity: 1,
        unitMinor: 4500,
        category: 'Platters',
        modifiers: [{ group: 'Sauce', name: 'Garlic sauce', unitMinor: 0 }],
      },
    ],
  },
  {
    orderNumber: '2611000000003',
    customerId: '2000000003',
    state: 'preparing',
    minutesAgo: 70,
    orderType: 'delivery',
    restaurantId: '9201',
    restaurantName: 'V2 Kitchen - Seef',
    brandId: '91',
    brandName: 'V2 Kitchen',
    currency: 'BHD',
    items: [
      {
        sku: 'V2-PZ-04',
        name: 'Margherita pizza',
        quantity: 1,
        unitMinor: 5500,
        category: 'Pizza',
        modifiers: [{ group: 'Crust', name: 'Thin crust', unitMinor: 0 }],
      },
    ],
  },
];

const MOCK_DELIVERY_FEE_MINOR = { SAR: 800, BHD: 800 } as const;

export interface MockYiji2TransportOptions {
  now?: () => number;
  /** Largest page `GET /grants` answers (v2's own cap is 100); small in paging tests. */
  maxGrantPage?: number;
}

/**
 * Answers the partner routes from memory. ZERO NETWORK: nothing here calls
 * `fetch`. Writes are recorded in `calls`, grants in `grants`, coupons in
 * `coupons`, pushes in `pushes`; idempotency keys answer the stored result.
 */
export class MockYiji2Transport implements Yiji2Transport {
  readonly calls: Yiji2MockCall[] = [];
  readonly coupons: Array<{
    coupon_id: string;
    code: string;
    body: Record<string, unknown>;
    status: string;
  }> = [];
  readonly grants: Array<{
    grant_id: string;
    coupon_id: string | null;
    code: string | null;
    customer_id: string | null;
    order_number: string | null;
    removed: boolean;
  }> = [];
  readonly pushes: Array<{
    customer_id: string;
    body: Record<string, unknown>;
    result: 'delivered' | 'no_device';
  }> = [];
  /** Coupons at or above SAR 200 / BHD 20: v2 alerts on its side, never refuses. */
  readonly alerts: Array<{ code: string; amount_minor: number; currency: string }> = [];
  /** Grants that exist on v2 but were not created by the CRM (read-only to the CRM). */
  readonly foreignGrants: Array<{
    grant_id: string;
    coupon_id: string | null;
    code: string | null;
    customer_id: string | null;
    order_number: string | null;
    removed: boolean;
  }> = [{ ...YIJI2_MOCK_FOREIGN_GRANT }];
  private readonly idem = new Map<string, unknown>();
  private readonly now: () => number;
  private readonly maxGrantPage: number;
  private nextCoupon = 500_000;
  private nextGrant = 700_000;
  private nextNotification = 0;

  constructor(opts: MockYiji2TransportOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.maxGrantPage = Math.max(1, opts.maxGrantPage ?? 100);
  }

  /** Every grant v2 holds, the CRM's and the foreign ones (reads see all). */
  private allGrants() {
    return [...this.foreignGrants, ...this.grants];
  }

  private grantWire(g: MockYiji2Transport['grants'][number]): Yiji2GrantWire {
    return {
      grant_id: Number(g.grant_id),
      coupon_id: g.coupon_id ? Number(g.coupon_id) : null,
      code: g.code,
      customer_id: g.customer_id ? Number(g.customer_id) : null,
      state: g.removed ? 'removed' : 'active',
    };
  }

  /** v2's 400 VALIDATION_FAILED, naming the field. */
  private invalid(field: string, messageKey: string): never {
    throw new Yiji2RefusedError('VALIDATION_FAILED', messageKey, 400, null, field);
  }

  /**
   * The `POST /compensation-coupons` rules as v2 states them (2026-11-17):
   * AMOUNT only (400, field category); `total_discount_limit` >= value x
   * usage_limit; every money pair in the country's currency; the brand has an
   * active restaurant in the country and a named restaurant belongs to brand
   * and country. A large coupon is created and only alerted.
   */
  private checkCouponCreate(b: Record<string, unknown>): void {
    if (str(b.type) !== 'amount' || b.percent_bps !== undefined)
      this.invalid('category', 'coupon.category.amount_only');
    const country = str(b.country)?.toUpperCase() ?? '';
    const currency = YIJI2_COUNTRY_CURRENCY[country];
    if (!currency) this.invalid('country', 'coupon.country.unknown');
    for (const k of ['value', 'total_discount_limit', 'max']) {
      if (b[k] === undefined) continue;
      if (str(obj(b[k]).currency)?.toUpperCase() !== currency)
        this.invalid('currency', 'coupon.currency.not_country_currency');
    }
    const value = num(obj(b.value).amount_minor);
    if (value === undefined || value <= 0) this.invalid('value', 'coupon.value.required');
    const total = num(obj(b.total_discount_limit).amount_minor);
    if (total === undefined)
      this.invalid('total_discount_limit', 'coupon.total_discount_limit.required');
    const uses = num(b.usage_limit) ?? 1;
    if (total < value * Math.max(1, uses))
      this.invalid('total_discount_limit', 'coupon.total_discount_limit.below_value_times_usage');
    const restaurantId = yiji2Id(b.restaurant_id);
    const restaurant = restaurantId
      ? YIJI2_MOCK_RESTAURANTS.find((r) => r.id === restaurantId)
      : undefined;
    if (restaurantId && !restaurant) this.invalid('restaurant_id', 'coupon.restaurant.not_found');
    const brandId = yiji2Id(b.brand_id) ?? restaurant?.brandId;
    if (
      brandId &&
      !YIJI2_MOCK_RESTAURANTS.some(
        (r) => r.brandId === brandId && r.country === country && r.active,
      )
    )
      this.invalid('brand_id', 'coupon.brand.no_active_restaurant_in_country');
    if (restaurant && (restaurant.brandId !== brandId || restaurant.country !== country))
      this.invalid('restaurant_id', 'coupon.restaurant.not_in_brand_and_country');
    if (value >= YIJI2_LARGE_COUPON_ALERT_MINOR)
      this.alerts.push({ code: str(b.code) ?? '', amount_minor: value, currency: currency! });
  }

  private placedAt(s: MockOrderSeed): string {
    return s.minutesAgo != null
      ? new Date(this.now() - s.minutesAgo * 60_000).toISOString()
      : s.placedAt!;
  }

  private customerWire(c: MockCustomerSeed): Yiji2CustomerWire {
    return {
      id: Number(c.id),
      name: c.name,
      phone: c.phone,
      email: c.email,
      country: c.country,
      coupons: this.allGrants()
        .filter((g) => g.customer_id === c.id && !g.removed)
        .map((g) => this.grantWire(g)),
      points: { balance: 120 },
    };
  }

  private orderWire(s: MockOrderSeed, withItems: boolean): Yiji2OrderWire {
    const c = YIJI2_MOCK_CUSTOMERS.find((x) => x.id === s.customerId)!;
    const items = s.items.reduce(
      (sum, i) =>
        sum + i.quantity * (i.unitMinor + i.modifiers.reduce((m, x) => m + x.unitMinor, 0)),
      0,
    );
    const fee = s.orderType === 'delivery' ? MOCK_DELIVERY_FEE_MINOR[s.currency] : 0;
    const money = (amount_minor: number): Yiji2Money => ({ amount_minor, currency: s.currency });
    const closed = CLOSED_STATES.has(s.state);
    const placed = this.placedAt(s);
    return {
      order_number: Number(s.orderNumber),
      customer_id: Number(c.id),
      customer: { id: Number(c.id), name: c.name, phone: c.phone },
      state: s.state,
      is_open: !closed,
      order_type: s.orderType,
      country: c.country,
      placed_at: placed,
      restaurant_id: Number(s.restaurantId),
      restaurant_name: s.restaurantName,
      brand_id: Number(s.brandId),
      brand_name: s.brandName,
      ...(s.orderType === 'delivery' ? { address: { text: 'V2 Street 1' } } : {}),
      payment: {
        state: closed && s.state !== 'delivered' ? 'refunded' : 'captured',
        method: 'mada',
        paid_at: placed,
      },
      money: {
        items: money(items),
        delivery_fee: money(fee),
        discount: money(0),
        coupon: money(0),
        points: money(0),
        tax: money(0),
        total: money(items + fee),
      },
      ...(s.orderType === 'delivery'
        ? { tracking_url: `https://track.v2.test/${s.orderNumber}` }
        : {}),
      ...(withItems
        ? {
            items: s.items.map((i) => ({
              sku: i.sku,
              name: i.name,
              quantity: i.quantity,
              unit_price: money(i.unitMinor),
              category: i.category,
              modifiers: i.modifiers.map((m) => ({
                group: m.group,
                name: m.name,
                quantity: 1,
                unit_price: money(m.unitMinor),
              })),
            })),
            timeline: [
              { state: 'created', at: placed },
              { state: 'accepted', at: new Date(Date.parse(placed) + 2 * 60_000).toISOString() },
              ...(s.state !== 'created'
                ? [{ state: s.state, at: new Date(Date.parse(placed) + 20 * 60_000).toISOString() }]
                : []),
            ],
          }
        : {}),
    };
  }

  private customerByPhone(phone: string): MockCustomerSeed | undefined {
    const want = String(phone ?? '').replace(/\D/g, '');
    if (!want) return undefined;
    return YIJI2_MOCK_CUSTOMERS.find((c) => {
      const have = c.phone.replace(/\D/g, '');
      return (
        have === want || have.endsWith(want.replace(/^0/, '')) || want.endsWith(have.slice(-9))
      );
    });
  }

  async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    opts: Yiji2RequestOptions = {},
  ): Promise<T | null> {
    const key = opts.idempotencyKey ? `${method} ${path} ${opts.idempotencyKey}` : null;
    if (key && this.idem.has(key)) return this.idem.get(key) as T;
    const out = this.answer(method, path, opts) as T | null;
    /* Same rule as the HTTP transport: a 404 on a READ is null, on a WRITE a refusal. */
    if (out === null && method !== 'GET')
      throw new Yiji2RefusedError('not_found', `${method} ${path}: not found`, 404);
    if (key) this.idem.set(key, out);
    return out;
  }

  private answer(method: string, path: string, opts: Yiji2RequestOptions): unknown {
    if (method !== 'GET')
      this.calls.push({
        method,
        path,
        body: opts.body,
        ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
      });
    const b = obj(opts.body);
    let m: RegExpExecArray | null;
    if (method === 'POST' && path === '/auth/token')
      return { access_token: 'mock-token', expires_in: 900, token_type: 'Bearer' };
    if (method === 'GET' && path === '/customers') {
      const c = this.customerByPhone(String(opts.query?.phone ?? ''));
      return { items: c ? [this.customerWire(c)] : [] };
    }
    if (method === 'GET' && (m = /^\/customers\/(\d+)$/.exec(path))) {
      const c = YIJI2_MOCK_CUSTOMERS.find((x) => x.id === m![1]);
      return c ? this.customerWire(c) : null;
    }
    if (method === 'GET' && (m = /^\/customers\/(\d+)\/orders$/.exec(path))) {
      const rows = YIJI2_MOCK_ORDERS.filter((o) => o.customerId === m![1])
        .map((o) => this.orderWire(o, false))
        .sort((a, b) => Date.parse(b.placed_at) - Date.parse(a.placed_at));
      const limit = num(opts.query?.limit);
      return { items: limit ? rows.slice(0, limit) : rows };
    }
    if (method === 'GET' && (m = /^\/customers\/(\d+)\/points$/.exec(path))) {
      return YIJI2_MOCK_CUSTOMERS.some((x) => x.id === m![1])
        ? { balance: 120, currency: 'SAR' }
        : null;
    }
    if (method === 'POST' && (m = /^\/customers\/(\d+)\/push$/.exec(path))) {
      const c = YIJI2_MOCK_CUSTOMERS.find((x) => x.id === m![1]);
      if (!c) return null;
      /* v2 refuses the data keys `topic` and `action` (contract 2026-11-17). */
      for (const k of ['topic', 'action'])
        if (k in obj(b.data)) this.invalid(`data.${k}`, 'push.data.reserved_key');
      /* 202: `delivered` with a notification id, or `no_device`. */
      if (c.device === false) {
        this.pushes.push({ customer_id: c.id, body: b, result: 'no_device' });
        return { result: 'no_device' };
      }
      this.pushes.push({ customer_id: c.id, body: b, result: 'delivered' });
      return { result: 'delivered', notification_id: `ntf-${++this.nextNotification}` };
    }
    if (method === 'GET' && (m = /^\/orders\/(\d+)$/.exec(path))) {
      const o = YIJI2_MOCK_ORDERS.find((x) => x.orderNumber === m![1]);
      return o ? this.orderWire(o, true) : null;
    }
    if (method === 'GET' && (m = /^\/orders\/(\d+)\/history$/.exec(path))) {
      const o = YIJI2_MOCK_ORDERS.find((x) => x.orderNumber === m![1]);
      return o ? { items: this.orderWire(o, true).timeline } : null;
    }
    if (method === 'GET' && path === '/orders/changed') return { items: [] };
    if (method === 'GET' && (m = /^\/coupons\/(\d+)$/.exec(path))) {
      const c = this.coupons.find((x) => x.coupon_id === m![1]);
      return c
        ? { coupon_id: Number(c.coupon_id), code: c.code, status: c.status, ...c.body }
        : null;
    }
    if (method === 'POST' && path === '/compensation-coupons') {
      this.checkCouponCreate(b);
      const coupon_id = String(++this.nextCoupon);
      const code = str(b.code) ?? `V2-${coupon_id}`;
      this.coupons.push({ coupon_id, code, body: b, status: 'active' });
      /* CompensationCouponResult: granted in the same call when a customer
         (id or phone) or an order was named. */
      const order_number = yiji2Id(b.order_number) ?? null;
      let customer_id = yiji2Id(b.customer_id) ?? null;
      if (!customer_id && order_number) {
        customer_id =
          YIJI2_MOCK_ORDERS.find((o) => o.orderNumber === order_number)?.customerId ?? null;
      }
      if (!customer_id && str(b.phone))
        customer_id = this.customerByPhone(str(b.phone)!)?.id ?? null;
      if (customer_id) {
        const grant_id = String(++this.nextGrant);
        this.grants.push({ grant_id, coupon_id, code, customer_id, order_number, removed: false });
        return { coupon_id: Number(coupon_id), grant_id: Number(grant_id), code, state: 'active' };
      }
      return { coupon_id: Number(coupon_id), code, state: 'active' };
    }
    if (method === 'PUT' && (m = /^\/coupons\/(\d+)$/.exec(path))) {
      const c = this.coupons.find((x) => x.coupon_id === m![1]);
      if (!c) return null;
      c.body = { ...c.body, ...b };
      return { coupon_id: Number(c.coupon_id), code: c.code, status: c.status };
    }
    if (method === 'PUT' && (m = /^\/coupons\/(\d+)\/status$/.exec(path))) {
      const c = this.coupons.find((x) => x.coupon_id === m![1]);
      if (!c) return null;
      c.status = str(b.status) ?? c.status;
      return { coupon_id: Number(c.coupon_id), status: c.status };
    }
    if (method === 'POST' && path === '/grants') {
      const coupon_id = yiji2Id(b.coupon_id) ?? null;
      const byCode = str(b.code) ? this.coupons.find((c) => c.code === str(b.code)) : undefined;
      const coupon = coupon_id ? this.coupons.find((c) => c.coupon_id === coupon_id) : byCode;
      /* Only coupons the CRM created through the partner API; any other
         (an app coupon, an unknown id) answers 404. */
      if (!coupon)
        throw new Yiji2RefusedError('not_found', 'No such coupon created by this partner.', 404);
      let customer_id = yiji2Id(b.customer_id) ?? null;
      const order_number = yiji2Id(b.order_number) ?? null;
      if (!customer_id && order_number)
        customer_id =
          YIJI2_MOCK_ORDERS.find((o) => o.orderNumber === order_number)?.customerId ?? null;
      if (!customer_id && str(b.phone))
        customer_id = this.customerByPhone(str(b.phone)!)?.id ?? null;
      if (!customer_id) throw new Yiji2RefusedError('not_found', 'No such customer.', 404);
      const held = this.grants.filter(
        (g) => g.customer_id === customer_id && g.coupon_id === coupon.coupon_id,
      );
      const dup = held.find((g) => !g.removed);
      /* Re-granting a REMOVED grant: 409 COUPON_INVALID (contract 2026-11-17). */
      if (!dup && held.some((g) => g.removed))
        throw new Yiji2RefusedError(
          'COUPON_INVALID',
          'This grant was removed and cannot be granted again.',
          409,
        );
      if (dup)
        throw new Yiji2RefusedError(
          'already_granted',
          'The customer already holds this coupon.',
          409,
        );
      const grant_id = String(++this.nextGrant);
      this.grants.push({
        grant_id,
        coupon_id: coupon.coupon_id,
        code: coupon.code,
        customer_id,
        order_number,
        removed: false,
      });
      return {
        grant_id: Number(grant_id),
        coupon_id: Number(coupon.coupon_id),
        customer_id: Number(customer_id),
        state: 'active',
      };
    }
    if (method === 'DELETE' && (m = /^\/grants\/(\d+)$/.exec(path))) {
      /* Only the CRM's own, still active grants; a foreign, unknown or
         already removed grant answers 404. */
      const g = this.grants.find((x) => x.grant_id === m![1] && !x.removed);
      if (!g) return null;
      g.removed = true;
      return {};
    }
    if (method === 'GET' && path === '/grants') {
      /* A customer's grants, or by ids; newest first; paged by after_id. */
      const q = opts.query ?? {};
      const customer = yiji2Id(q.customer_id);
      const ids = String(q.ids ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      const after = num(q.after_id);
      const limit = Math.min(this.maxGrantPage, Math.max(1, num(q.limit) ?? this.maxGrantPage));
      const rows = this.allGrants()
        .filter((g) => (customer ? g.customer_id === customer : true))
        .filter((g) => (ids.length ? ids.includes(g.grant_id) : true))
        .filter((g) => (after !== undefined ? Number(g.grant_id) < after : true))
        .sort((a, b) => Number(b.grant_id) - Number(a.grant_id));
      const page = rows.slice(0, limit);
      return {
        items: page.map((g) => this.grantWire(g)),
        next_after_id: rows.length > limit ? Number(page.at(-1)!.grant_id) : null,
      };
    }
    throw new Yiji2RefusedError('not_found', `No such route: ${method} ${path}`, 404);
  }
}

/* ── The translating admin poster ────────────────────────────────── */

/** v1 answer shapes the workers read; produced here from v2's. */
export interface Yiji2V1Answer {
  result: number;
  exceptionMessage?: string;
  extendedProperties?: Record<string, unknown>;
  transactionStatus?: number;
}

/**
 * v1 coupon dates are zone-less Riyadh wall clock (`2026-12-16T23:59:00`,
 * `couponWindow`); v2 wants RFC 3339. Both tenants' countries (SA, BH) are
 * UTC+3, so the offset is fixed. Anything already zoned passes through.
 */
export function yiji2Rfc3339(s: string | undefined): string | undefined {
  if (!s) return s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00+03:00`;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?(\.\d+)?$/.exec(s);
  if (m) return `${m[1]}T${m[2]}${m[3] ?? ':00'}+03:00`;
  return s;
}

/**
 * The v1 coupon body as v2's `CompensationCouponCreate` (partner-v1.yaml
 * draft, agreed with the v2 session on 2026-11-16): `code` is the CRM's
 * coupon code and the idempotency key; `title` is bilingual (the same text
 * in both when the CRM has one); `type` amount|percent; `category`
 * general|private (v1 type 0/1); money is `{ amount_minor, currency }`;
 * a percent coupon carries `percent_bps` (percent x 100) and `max`;
 * `country` SA|BH. A customer (`customer_id` or E.164 `phone`) and an
 * `order_number` may be named on creation, in which case v2 grants the
 * coupon in the same call and answers `grant_id`.
 */
export function v1CouponDraft(
  body: Record<string, unknown>,
  opts: { currency: string; country: string },
): Record<string, unknown> {
  const { currency, country } = opts;
  const cu = obj(body.couponUser);
  const coupon = obj(body.coupon ?? cu.coupon ?? body);
  const discount = num(coupon.discount);
  const pct = num(coupon.discountPercentage);
  const cap = num(coupon.maximumDiscount);
  const reach = num(coupon.reachLimit);
  const isPercent = !!pct && pct > 0;
  const title = str(coupon.name) ?? str(cu.couponName) ?? str(body.couponName);
  const customerId = yiji2Id(body.userId ?? cu.userId);
  const phone = str(body.customerPhone ?? cu.customerPhone);
  const orderNumber = yiji2Id(body.orderId ?? cu.orderId);
  return {
    code: str(body.code) ?? str(coupon.code) ?? str(cu.couponCode) ?? str(body.couponCode),
    ...(title ? { title: { ar: title, en: title } } : {}),
    type: isPercent ? 'percent' : 'amount',
    /* v1 type 0 = General, 1 = Private. */
    category: num(coupon.type) === 1 ? 'private' : num(coupon.type) === 0 ? 'general' : undefined,
    ...(isPercent
      ? {
          percent_bps: Math.round(pct! * 100),
          ...(cap != null ? { max: yiji2Minor(cap, currency) } : {}),
        }
      : discount != null
        ? { value: yiji2Minor(discount, currency) }
        : {}),
    usage_limit: num(coupon.limitForUser),
    ...(reach != null ? { total_discount_limit: yiji2Minor(reach, currency) } : {}),
    valid_from: yiji2Rfc3339(str(coupon.activationDateTime) ?? str(coupon.activationDate)),
    valid_to: yiji2Rfc3339(str(coupon.expirationDateTime) ?? str(coupon.expirationDate)),
    reason:
      str(cu.compensationReason) ??
      str(body.compensationReason) ??
      str(coupon.compensationReason) ??
      str(coupon.compensation),
    ...(num(coupon.brandId) != null ? { brand_id: num(coupon.brandId) } : {}),
    ...(num(coupon.restaurantId) != null ? { restaurant_id: num(coupon.restaurantId) } : {}),
    country,
    ...(customerId ? { customer_id: customerId } : phone ? { phone } : {}),
    ...(orderNumber ? { order_number: orderNumber } : {}),
  };
}

/**
 * THE V2 COUPON RULES, CHECKED HERE BEFORE ANY NETWORK CALL (contract of
 * 2026-11-17). Each failure is a `Yiji2RefusedError` - status 400, a code
 * naming the rule - which `adminPost` hands to the v1 processor as the
 * refusal it RECORDS on the row and never retries. Refusing locally gives the
 * supervisor a clear reason instead of v2's bare VALIDATION_FAILED, and
 * spends no call on an answer known in advance.
 *
 *  - `percent_not_supported_on_v2`: v2 creates AMOUNT coupons only (a
 *    percentage coupon is refused by v2 with 400, field `category`).
 *  - `total_limit_missing_on_v2` / `total_limit_below_uses_on_v2`: v2 wants
 *    `total_discount_limit` >= value x usage_limit. The CRM's total
 *    (`reachLimit`, the agent's / approver's "Total given discount limit") is
 *    the most the coupon may EVER give. Raising it to fit v2's rule would
 *    send a coupon MORE GENEROUS than the CRM approved, so it is never
 *    raised: the coupon is refused with the numbers in the reason and an
 *    admin re-approves it with a total that covers every use.
 *  - `currency_not_country_on_v2`: every money pair is in the vendor country's
 *    currency (SA -> SAR, BH -> BHD).
 *
 * Not checked here (v2 knows its restaurants, the CRM does not): the brand
 * must have an active restaurant in the country and `restaurant_id` must
 * belong to that brand and country - v2 answers 400 and that refusal is
 * recorded the same way. Coupons at or above SAR 200 / BHD 20 are created
 * and only alerted on v2's side, so nothing here caps the value.
 *
 * `partial` is for `PUT /coupons/{id}` (an edit may name only what changes):
 * only rules whose fields are present are checked.
 */
export function v2CouponProblem(
  draft: Record<string, unknown>,
  opts: { partial?: boolean } = {},
): Yiji2RefusedError | null {
  const refuse = (code: string, message: string, field: string) =>
    new Yiji2RefusedError(code, message, 400, null, field);
  if (draft.type === 'percent' || draft.percent_bps !== undefined) {
    return refuse(
      'percent_not_supported_on_v2',
      'Yiji v2 creates amount coupons only; a percentage coupon is refused by v2 (field category). Approve it as an amount coupon.',
      'category',
    );
  }
  const country = String(draft.country ?? '').toUpperCase();
  const currency = YIJI2_COUNTRY_CURRENCY[country];
  if (!currency) {
    return refuse(
      'currency_not_country_on_v2',
      `Yiji v2 coupons are for SA (SAR) or BH (BHD); the vendor country "${country}" is neither.`,
      'currency',
    );
  }
  for (const k of ['value', 'total_discount_limit', 'max']) {
    const m = draft[k];
    if (m === undefined) continue;
    const cur = String(obj(m).currency ?? '').toUpperCase();
    if (cur !== currency)
      return refuse(
        'currency_not_country_on_v2',
        `Yiji v2 wants ${country} coupons in ${currency}; this coupon's ${k} is in ${cur || 'no currency'}.`,
        'currency',
      );
  }
  const value = num(obj(draft.value).amount_minor);
  const total = num(obj(draft.total_discount_limit).amount_minor);
  const uses = num(draft.usage_limit);
  if (total === undefined) {
    if (opts.partial) return null;
    return refuse(
      'total_limit_missing_on_v2',
      'Yiji v2 needs a total discount limit on every coupon; this coupon has none.',
      'total_discount_limit',
    );
  }
  if (value !== undefined && uses !== undefined && uses > 0 && total < value * uses) {
    const units = yiji2MinorUnits(currency);
    return refuse(
      'total_limit_below_uses_on_v2',
      `Yiji v2 needs the total discount limit (${total / units} ${currency}) to cover every use: ` +
        `value ${value / units} ${currency} x ${uses} uses = ${(value * uses) / units} ${currency}. ` +
        'The CRM never raises an approved limit; re-approve with a total that covers every use.',
      'total_discount_limit',
    );
  }
  return null;
}

/**
 * The `data` of a v2 push. v2 REFUSES the keys `topic` and `action`
 * (contract 2026-11-17). The v1 CRM payload carries the agreed tap action in
 * `data.prop1` (`crm.openchat`, from `openChatAction`) plus `conversationId`
 * and `source` - none of them refused, so they travel as they are. `notifyTopic`
 * belongs to v1's template endpoint (`SendNotification`), which v2 does not
 * map, so no topic ever reaches here from the CRM; a `topic` that does is
 * dropped (a v1 template number means nothing on v2), and an `action` is
 * renamed to `prop1` (the key the app reads) unless `prop1` is already set.
 * Values are sent as strings.
 */
export function v2PushData(b: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (k: string, v: unknown) => {
    if (v === undefined || v === null || v === '') return;
    out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  };
  for (const [k, v] of Object.entries(obj(b.data))) put(k, v);
  for (const [k, v] of Object.entries(b)) if (/^prop\d+$/.test(k) || k === 'url') put(k, v);
  const action = out.action ?? (typeof b.action === 'string' ? b.action : undefined);
  delete out.action;
  delete out.topic;
  if (action && !out.prop1) out.prop1 = action;
  return out;
}

/**
 * Translate ONE v1 admin call (path + body) into v2 partner calls and answer
 * in v1's shape. Exported so the mapping is tested on its own.
 */
export async function translateV1AdminCall(
  transport: Yiji2Transport,
  path: string,
  body: unknown,
  headers: Record<string, string>,
  opts: { currency: string; country?: string },
): Promise<Yiji2V1Answer> {
  const b = obj(body);
  const cu = obj(b.couponUser);
  const idem = headers['idempotency-key'] ?? headers['Idempotency-Key'];
  const withIdem = (suffix: string) => (idem ? { idempotencyKey: `${idem}:${suffix}` } : {});
  const grantAnswer = (g: Yiji2GrantWire | null): Yiji2V1Answer => {
    const id = yiji2Id(g?.grant_id) ?? yiji2Id(g?.id);
    if (!id) return { result: 2, exceptionMessage: 'grant not created' };
    return { result: 1, extendedProperties: { CouponUserId: id } };
  };
  const country = opts.country ?? (opts.currency.toUpperCase() === 'BHD' ? 'BH' : 'SA');
  const draft = v1CouponDraft(b, { currency: opts.currency, country });
  /** Refused locally (never sent) when it breaks a v2 coupon rule. */
  const preflight = (partial = false) => {
    const problem = v2CouponProblem(draft, { partial });
    if (problem) throw problem;
  };

  if (/\/api\/CouponUser\/AddCompensationCoupon\b/i.test(path)) {
    throw new Yiji2RefusedError(
      'not_provided',
      'AddCompensationCoupon is not provided on v2.',
      403,
    );
  }
  if (/\/api\/Coupon\/AddCoupon$/i.test(path)) {
    preflight();
    const c = await transport.request<{ coupon_id?: unknown }>('POST', '/compensation-coupons', {
      body: draft,
      ...withIdem('coupon'),
    });
    const id = yiji2Id(c?.coupon_id);
    return id
      ? { result: 1, exceptionMessage: id, transactionStatus: 1 }
      : { result: 2, exceptionMessage: 'coupon not created' };
  }
  if (/\/api\/CouponUserOrder\/CreateCouponUserFromOrder$/i.test(path)) {
    const orderNumber = yiji2Id(b.orderId ?? cu.orderId);
    preflight();
    const c = await transport.request<{ coupon_id?: unknown; grant_id?: unknown }>(
      'POST',
      '/compensation-coupons',
      { body: draft, ...withIdem('coupon') },
    );
    const couponId = yiji2Id(c?.coupon_id);
    if (!couponId) return { result: 2, exceptionMessage: 'coupon not created' };
    /* v2 grants in the same call when the creation named a customer or an order. */
    const granted = yiji2Id(c?.grant_id);
    if (granted) return { result: 1, extendedProperties: { CouponUserId: granted } };
    const g = await transport.request<Yiji2GrantWire>('POST', '/grants', {
      body: {
        coupon_id: couponId,
        ...(orderNumber ? { order_number: orderNumber } : {}),
        ...(yiji2Id(b.userId ?? cu.userId) ? { customer_id: yiji2Id(b.userId ?? cu.userId) } : {}),
        ...(str(b.customerPhone ?? cu.customerPhone)
          ? { phone: str(b.customerPhone ?? cu.customerPhone) }
          : {}),
      },
      ...withIdem('grant'),
    });
    return grantAnswer(g);
  }
  if (/\/api\/CouponUser\/AddUserCoupon$/i.test(path)) {
    const g = await transport.request<Yiji2GrantWire>('POST', '/grants', {
      body: {
        coupon_id: yiji2Id(b.couponId ?? cu.couponId),
        ...(yiji2Id(b.userId ?? cu.userId) ? { customer_id: yiji2Id(b.userId ?? cu.userId) } : {}),
        ...(yiji2Id(b.orderId ?? cu.orderId)
          ? { order_number: yiji2Id(b.orderId ?? cu.orderId) }
          : {}),
      },
      ...withIdem('grant'),
    });
    return grantAnswer(g);
  }
  /* v1 sends the ids IN THE PATH (`AddCouponToUserByCode/<userId>/<code>`,
     body `{}`); a body form is accepted too. */
  const byCode = /\/api\/CouponUser\/AddCouponToUserByCode(?:\/([^/?]+)\/([^/?]+))?\/?$/i.exec(
    path,
  );
  if (byCode) {
    const pathUser = byCode[1] ? decodeURIComponent(byCode[1]) : undefined;
    const pathCode = byCode[2] ? decodeURIComponent(byCode[2]) : undefined;
    const customerId = yiji2Id(b.userId) ?? pathUser;
    const g = await transport.request<Yiji2GrantWire>('POST', '/grants', {
      body: {
        code: str(b.code) ?? str(b.couponCode) ?? pathCode,
        ...(customerId ? { customer_id: customerId } : {}),
      },
      ...withIdem('grant'),
    });
    return grantAnswer(g);
  }
  let m: RegExpExecArray | null;
  if ((m = /\/api\/CouponUser\/RemoveUserCoupon\/?(\d+)?/i.exec(path))) {
    const id = m[1] ?? yiji2Id(b.couponUserId ?? b.id);
    if (!id) return { result: 2, exceptionMessage: 'no grant id' };
    /* 404 = not found OR not the CRM's (v2 deletes only grants the CRM
       created): the transport throws `not_found`, recorded as a refusal -
       never read as "removed". */
    await transport.request('DELETE', `/grants/${id}`);
    return { result: 1 };
  }
  if (/\/api\/Coupon\/UpdateStatusCoupon/i.test(path)) {
    const id = yiji2Id(b.id ?? b.couponId);
    if (!id) return { result: 2, exceptionMessage: 'no coupon id' };
    const status = num(b.status);
    await transport.request('PUT', `/coupons/${id}/status`, {
      body: {
        status: status === 1 ? 'active' : status === 0 ? 'inactive' : (str(b.status) ?? 'inactive'),
      },
    });
    return { result: 1 };
  }
  if (/\/api\/Coupon\/UpdateCoupon/i.test(path)) {
    const id = yiji2Id(b.id ?? obj(b.coupon).id);
    if (!id) return { result: 2, exceptionMessage: 'no coupon id' };
    preflight(true);
    await transport.request('PUT', `/coupons/${id}`, { body: draft });
    return { result: 1 };
  }
  if ((m = /\/api\/Coupon\/GetCoupon\/id\/(\d+)/i.exec(path))) {
    const c = await transport.request<Record<string, unknown>>('GET', `/coupons/${m[1]}`);
    return c
      ? { result: 1, extendedProperties: c }
      : { result: 2, exceptionMessage: 'coupon not found' };
  }
  if (/\/api\/NotificationData\/SendCrmNotification\b/i.test(path)) {
    const customerId = yiji2Id(b.userId);
    const phone = str(b.phoneNumber);
    let target = customerId;
    if (!target && phone) {
      const found = await transport.request<{ items?: Yiji2CustomerWire[] }>('GET', '/customers', {
        query: { phone },
      });
      target = yiji2Id(found?.items?.[0]?.id);
    }
    /* "Customer not found" is the phrase the v1 push processor treats as a
       settled fact about the person (`isTerminalRefusal`): not retried. */
    const noCustomer = () =>
      new Yiji2RefusedError(
        'customer_not_found',
        'Customer not found (no v2 customer for this push).',
        404,
      );
    if (!target) throw noCustomer();
    let r: { result?: unknown; notification_id?: unknown } | null;
    try {
      r = await transport.request<{ result?: unknown; notification_id?: unknown }>(
        'POST',
        `/customers/${target}/push`,
        {
          /* No top-level `action` and no `data.topic` / `data.action`: v2
             refuses those keys (contract 2026-11-17); see v2PushData. */
          body: { title: str(b.title), body: str(b.body), data: v2PushData(b) },
          ...withIdem('push'),
        },
      );
    } catch (err) {
      if (err instanceof Yiji2RefusedError && err.status === 404) throw noCustomer();
      throw err;
    }
    /* 202 `no_device`: the customer has no registered handset. Answered in
       the words of v1's own refusal ("Customer has no registered FCM device
       token."), which the v1 push processor records on the conversation as
       unreachable and never retries - exactly as for a v1 customer without
       an FCM token. */
    if (str(r?.result) === 'no_device')
      throw new Yiji2RefusedError('no_device', 'Customer has no registered FCM device token.', 422);
    /* 202 `delivered` (with `notification_id`) is v1's success. */
    const notificationId = str(r?.notification_id) ?? yiji2Id(r?.notification_id);
    return notificationId
      ? { result: 1, extendedProperties: { NotificationId: notificationId } }
      : { result: 1 };
  }
  throw new Yiji2RefusedError(
    'unsupported_call',
    `The v2 connector has no mapping for ${path}.`,
    400,
  );
}

/** `GET /grants` page size asked for (v2's own maximum). */
export const YIJI2_GRANTS_PAGE_SIZE = 100;
/** At most this many pages per lookup (5,000 grants): a cursor that never ends cannot spin. */
export const YIJI2_GRANTS_MAX_PAGES = 50;

const grantIsActive = (g: Yiji2GrantWire) => (str(g.state) ?? 'active') !== 'removed';

/**
 * A customer's ACTIVE grant of `code`, found by paging `GET /grants`
 * (contract 2026-11-17: a customer's grants, newest first, paged by
 * `after_id`). Follows `next_after_id` - or, when v2 sends none, the last id
 * of a FULL page - until a page comes back short or empty, at most
 * `YIJI2_GRANTS_MAX_PAGES` pages, and stops if the cursor does not move.
 * Reads see every grant (the CRM's and the app's). Where `GET /grants`
 * answers 404 (an older v2), the customer's embedded `coupons` are read.
 */
export async function findGrantByCode(
  t: Yiji2Transport,
  customerId: string,
  code: string,
): Promise<Yiji2GrantWire | null> {
  let after: string | undefined;
  for (let page = 0; page < YIJI2_GRANTS_MAX_PAGES; page++) {
    const r = await t.request<{ items?: Yiji2GrantWire[]; next_after_id?: unknown }>(
      'GET',
      '/grants',
      {
        query: {
          customer_id: customerId,
          limit: YIJI2_GRANTS_PAGE_SIZE,
          ...(after ? { after_id: after } : {}),
        },
      },
    );
    if (r === null) {
      if (page > 0) return null;
      const c = await t.request<Yiji2CustomerWire>(
        'GET',
        `/customers/${encodeURIComponent(customerId)}`,
      );
      return (c?.coupons ?? []).find((g) => str(g.code) === code && grantIsActive(g)) ?? null;
    }
    const items = r.items ?? [];
    const hit = items.find((g) => str(g.code) === code && grantIsActive(g));
    if (hit) return hit;
    const next =
      yiji2Id(r.next_after_id) ??
      (r.next_after_id === undefined && items.length >= YIJI2_GRANTS_PAGE_SIZE
        ? (yiji2Id(items.at(-1)?.grant_id) ?? yiji2Id(items.at(-1)?.id))
        : undefined);
    if (!next || next === after || items.length === 0) return null;
    after = next;
  }
  return null;
}

/* ── The connector ───────────────────────────────────────────────── */

export interface Yiji2ConnectorOptions {
  transport?: Yiji2Transport;
  now?: () => number;
  /** Told about calls that could not be made (no credentials). Once per process. */
  onUnconfigured?: (what: string) => void;
}

export class Yiji2Connector implements VendorConnector {
  readonly platform = 'yiji2' as const;
  readonly latestOrderId: VendorConnector['latestOrderId'];
  readonly latestOrderBrandName: VendorConnector['latestOrderBrandName'];
  readonly findCustomerIdByPhone: VendorConnector['findCustomerIdByPhone'];
  readonly getCustomerProfile: VendorConnector['getCustomerProfile'];
  readonly readCouponOrderContext: VendorConnector['readCouponOrderContext'];
  readonly findCustomerCoupon: VendorConnector['findCustomerCoupon'];
  readonly adminPost: PlatformAdminPoster | null;
  /** The transport in use; a `MockYiji2Transport` in tests and on a mock vendor. */
  readonly transport: Yiji2Transport | null;
  private warned = false;

  constructor(
    readonly vendor: ConnectorVendor,
    readonly settings: Yiji2PlatformSettings,
    opts: Yiji2ConnectorOptions = {},
  ) {
    const configured =
      !!settings.apiBaseUrl?.trim() &&
      !!settings.clientId?.trim() &&
      !!settings.clientSecret?.trim();
    this.transport =
      opts.transport ??
      (settings.mock
        ? new MockYiji2Transport({ ...(opts.now ? { now: opts.now } : {}) })
        : configured
          ? new HttpYiji2Transport({
              apiBaseUrl: settings.apiBaseUrl!,
              clientId: settings.clientId!,
              clientSecret: settings.clientSecret!,
            })
          : null);
    const t = this.transport;
    const warn = (what: string) => {
      if (this.warned) return;
      this.warned = true;
      opts.onUnconfigured?.(what);
    };
    /* Capabilities are null without a transport - "not configured", which
       every caller already tells apart from "failing" (the coupon stays
       approved, customer-exists reports configured: false). */
    this.latestOrderId = t
      ? async (customerId) => (await this.getOrders(customerId, { limit: 1 }))[0]?.orderId ?? null
      : null;
    this.latestOrderBrandName = t
      ? async (customerId) => {
          try {
            return (await this.getOrders(customerId, { limit: 1 }))[0]?.brandName ?? null;
          } catch {
            return null;
          }
        }
      : null;
    this.findCustomerIdByPhone = t
      ? async (phone) => {
          const found = await t.request<{ items?: Yiji2CustomerWire[] }>('GET', '/customers', {
            query: { phone },
          });
          return yiji2Id(found?.items?.[0]?.id) ?? null;
        }
      : null;
    this.getCustomerProfile = t
      ? async (customerId) => {
          const c = await t.request<Yiji2CustomerWire>(
            'GET',
            `/customers/${encodeURIComponent(customerId)}`,
          );
          const id = yiji2Id(c?.id);
          const phone = str(c?.phone);
          if (!c || !id || !phone) return null;
          const profile: CrmCustomerProfile = { id, phone };
          if (str(c.name)) profile.name = str(c.name);
          if (str(c.email)) profile.email = str(c.email);
          return profile;
        }
      : null;
    this.readCouponOrderContext = t
      ? async (orderId) =>
          mapYiji2CouponContext(
            await t.request<Yiji2OrderWire>('GET', `/orders/${encodeURIComponent(orderId)}`),
            settings.tenantId,
          )
      : null;
    this.findCustomerCoupon = t
      ? async (customerId, code): Promise<CrmCustomerCoupon | null> => {
          const held = await findGrantByCode(t, customerId, code);
          if (!held) return null;
          const grant = yiji2Id(held.grant_id) ?? yiji2Id(held.id);
          if (!grant) return null;
          return { couponUserId: grant, couponId: num(held.coupon_id) ?? null };
        }
      : null;
    this.adminPost = t
      ? ((async (path: string, body: unknown, headers?: Record<string, string>) => {
          try {
            return await translateV1AdminCall(t, path, body, headers ?? {}, {
              currency: this.currency(),
            });
          } catch (err) {
            /* A refusal (400 VALIDATION_FAILED, 403, 409, ...) reaches the v1
               processor as the refusal IT recognises: recorded once, never
               retried. An outage (429, 5xx, network) passes through: retried. */
            if (err instanceof Yiji2RefusedError) throw yiji2RefusalAsV1(err);
            throw err;
          }
        }) as PlatformAdminPoster)
      : null;
    if (!t)
      warn(
        'yiji2 connector without API URL + client credentials: commerce reads answer empty, coupon/push capabilities are null',
      );
  }

  /**
   * The currency for bodies this connector builds: `settings.currency` when
   * set (env vendor, or a `vendors.currency` column once one exists), else
   * SAR. NEVER guessed from the vendor's name (review 2026-11-16: a vendor
   * called "Yiji V2 Abha" would have sent 10 SAR as 10 BHD).
   */
  private currency(): string {
    const c = (this.settings.currency ?? '').toUpperCase();
    return c === 'BHD' ? 'BHD' : 'SAR';
  }

  private async get<T>(path: string, query?: Yiji2RequestOptions['query']): Promise<T | null> {
    if (!this.transport) return null;
    return this.transport.request<T>('GET', path, query ? { query } : {});
  }

  async getCustomer(externalCustomerId: string): Promise<CrmCustomer | null> {
    return mapYiji2Customer(
      await this.get<Yiji2CustomerWire>(`/customers/${encodeURIComponent(externalCustomerId)}`),
    );
  }

  async getOrders(externalCustomerId: string, opts?: { limit?: number }): Promise<CrmOrder[]> {
    const r = await this.get<{ items?: Yiji2OrderWire[] }>(
      `/customers/${encodeURIComponent(externalCustomerId)}/orders`,
      {
        limit: opts?.limit,
      },
    );
    return (r?.items ?? []).map((o) => mapYiji2Order(o)).filter((o): o is CrmOrder => !!o);
  }

  async getOrder(orderId: string): Promise<CrmOrder | null> {
    return mapYiji2Order(await this.get<Yiji2OrderWire>(`/orders/${encodeURIComponent(orderId)}`));
  }

  async getOrderTimeline(orderId: string): Promise<CrmOrderTimeline | null> {
    const order = await this.get<Yiji2OrderWire>(`/orders/${encodeURIComponent(orderId)}`);
    if (!order) return null;
    const h = await this.get<{ items?: Array<{ state: string; at?: string | null }> }>(
      `/orders/${encodeURIComponent(orderId)}/history`,
    );
    return mapYiji2History(orderId, h?.items ?? order.timeline ?? [], order.state);
  }

  async getOrderCart(orderId: string): Promise<CrmOrderCart | null> {
    return mapYiji2Cart(await this.get<Yiji2OrderWire>(`/orders/${encodeURIComponent(orderId)}`));
  }

  async getPaymentStatus(orderId: string): Promise<CrmPaymentStatus | null> {
    const o = await this.get<Yiji2OrderWire>(`/orders/${encodeURIComponent(orderId)}`);
    if (!o) return null;
    const out: CrmPaymentStatus = { orderId, status: str(o.payment?.state) ?? 'unknown' };
    if (str(o.payment?.method)) out.method = str(o.payment?.method);
    if (str(o.payment?.paid_at)) out.paidAt = str(o.payment?.paid_at);
    return out;
  }

  async getShipmentTracking(orderId: string): Promise<CrmShipmentTracking | null> {
    const o = await this.get<Yiji2OrderWire>(`/orders/${encodeURIComponent(orderId)}`);
    if (!o || deliveryType(o.order_type) !== 'delivery') return null;
    const status = yiji2Status(o.state);
    return {
      orderId,
      status:
        status === 'delivered'
          ? 'delivered'
          : status === 'in_delivery'
            ? 'out_for_delivery'
            : 'label_created',
      events: (o.timeline ?? [])
        .filter((t) => t.at)
        .map((t) => ({ at: t.at!, description: yiji2Status(t.state) })),
      ...(str(o.tracking_url) ? { trackingNumber: str(o.tracking_url) } : {}),
    };
  }

  async getPurchaseActivity(externalCustomerId: string): Promise<CrmPurchaseActivity | null> {
    if (!(await this.getCustomer(externalCustomerId))) return null;
    const orders = await this.getOrders(externalCustomerId);
    return {
      externalCustomerId,
      lifetimeValue: orders.reduce((s, o) => s + o.total, 0),
      orderCount: orders.length,
      ...(orders[0] ? { lastOrderAt: orders[0].placedAt } : {}),
      recent: orders.slice(0, 3),
    };
  }

  /**
   * NO POLLER FOR V2 (brief section 3): `GetFilteredOrders` is gone; v2 pushes
   * `order.late` / `order.status_changed` events and the board is built from
   * the CRM's own live table. This answers nothing so the poll never asks;
   * `GET /orders/changed?since=` is reconciliation only and not wired yet.
   */
  async getLateDeliveryOrders(
    _thresholdMinutes: number,
    _opts?: CrmLateOrderQuery,
  ): Promise<CrmLateOrder[]> {
    return [];
  }
}
