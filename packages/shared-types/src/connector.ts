/**
 * VENDOR CONNECTORS (MV-2, EMA-69 / EMA-71).
 *
 * The CRM works in ONE standard format; each commerce platform a vendor runs
 * on gets a CONNECTOR that converts that platform's API into it. Today there is
 * one platform, Yiji, and its connector delegates to the code that already
 * talks to Yiji (`HttpYijiClient` and the `createYiji*` factories) — not one
 * request is built differently. What changes is HOW a caller reaches it: by
 * asking the `ConnectorRegistry` for the connector of a VENDOR, instead of
 * holding one process-wide Yiji client.
 *
 * THE STANDARD SHAPES are the existing `Yiji*` result types, re-exported here
 * under platform-neutral names. They were already the shape the portals and
 * workers consume; renaming them across the codebase would be churn with no
 * behaviour behind it, so a second platform maps INTO these and nothing above
 * the connector has to learn a new type.
 *
 * WHAT STAYS PLATFORM-SPECIFIC, inside the Yiji side: order/payment status
 * enums, the phone format Yiji indexes on, coupon type/category numbers, the
 * coupon and push PAYLOADS (built by the workers' coupon-push / customer-push
 * processors, which are the Yiji coupon and push implementations today), and
 * the `tenantid` header.
 */
import type {
  YijiCustomer,
  YijiOrder,
  YijiOrderItem,
  YijiOrderTimeline,
  YijiOrderTimelineEvent,
  YijiOrderCart,
  YijiCartLine,
  YijiPaymentStatus,
  YijiShipmentTracking,
  YijiPurchaseActivity,
  YijiClient,
} from './yiji.js';
import type { LateOrderQueryOptions, LateOrderRow } from './late-delivery.js';
import {
  createYijiAdminPoster,
  createYijiClient,
  createYijiCustomerFinder,
  createYijiLatestBrandReader,
  createYijiLatestOrderReader,
  createYijiOrderReader,
  createYijiUserCouponFinder,
  createYijiUserReader,
  type CouponOrderContext,
  type YijiAdminPoster,
  type YijiClientEnv,
  type YijiUserProfile,
} from './yiji-impl.js';

/* ── The CRM's standard commerce shapes ──────────────────────────── */

export type CrmCustomer = YijiCustomer;
export type CrmOrder = YijiOrder;
export type CrmOrderItem = YijiOrderItem;
export type CrmOrderTimeline = YijiOrderTimeline;
export type CrmOrderTimelineEvent = YijiOrderTimelineEvent;
export type CrmOrderCart = YijiOrderCart;
export type CrmCartLine = YijiCartLine;
export type CrmPaymentStatus = YijiPaymentStatus;
export type CrmShipmentTracking = YijiShipmentTracking;
export type CrmPurchaseActivity = YijiPurchaseActivity;
export type CrmLateOrder = LateOrderRow;
export type CrmLateOrderQuery = LateOrderQueryOptions;
/** A customer's identity on the platform, looked up by the platform's own id. */
export type CrmCustomerProfile = YijiUserProfile;
/** What a coupon needs to know about an order, in the platform's namespace. */
export type CrmCouponOrderContext = CouponOrderContext;
/** A coupon grant the customer already holds on the platform. */
export interface CrmCustomerCoupon {
  couponUserId: string;
  couponId: number | null;
}
/**
 * The platform's authenticated POST — the transport coupon create/assign and
 * customer push go over. Throws a refusal (`YijiRefusedError`, 4xx with a
 * body) or an unavailability (`YijiUnavailableError`); see `adminPost`.
 */
export type PlatformAdminPoster = YijiAdminPoster;

/* ── Vendors ─────────────────────────────────────────────────────── */

/** Every commerce platform the CRM has a connector for. */
export type CommercePlatform = 'yiji';

/**
 * A vendor as the registry knows it.
 *
 * Addressable two ways, because callers hold one or the other: the CRM's own
 * `vendors.id` (UUID) on conversations/contacts/tickets, and the vendor's id
 * ON ITS PLATFORM (`vendors.yiji_vendor_id`) in tokens, the portals' commerce
 * requests and job payloads.
 */
export interface ConnectorVendor {
  /** `vendors.id`. Absent when the directory cannot see the vendors table (env-only, pre-MV-1). */
  crmId?: string;
  /** The vendor's id on its platform — `vendors.yiji_vendor_id` today. */
  platformVendorId: string;
  platform: CommercePlatform;
  /** `vendors.status`; only `active` vendors resolve. */
  status: string;
  name?: string;
}

/* ── Platform settings ───────────────────────────────────────────── */

/**
 * Everything the Yiji connector needs for ONE vendor.
 *
 * `client` is exactly the `YijiClientEnv` each service passes to the factories
 * today. The rest are kept as the RAW strings the env holds and parsed where
 * they are used, so the parsing — `?? '1'` here, `? Number(x) : 1` there —
 * stays byte-for-byte what it was.
 */
export interface YijiPlatformSettings {
  platform: 'yiji';
  client: YijiClientEnv;
  /** `YIJI_TENANT_ID` — the `tenantid` header / `tenantId` field. */
  tenantId?: string;
  /** `YIJI_BRAND_ID` — fallback push brand. */
  brandId?: string;
  /** Customer push (`YIJI_NOTIFY_*`, `YIJI_OPEN_CHAT_ACTION`, `YIJI_API_KEY`). */
  push?: {
    notifyUrl?: string;
    notifyTopic?: string;
    notifyTitle?: string;
    openChatAction?: string;
    apiKey?: string;
  };
}

/** One entry per platform; a union as soon as a second platform exists. */
export type VendorPlatformSettings = YijiPlatformSettings;

/* ── The connector contract ──────────────────────────────────────── */

/**
 * Every operation the CRM performs against a vendor's commerce platform.
 *
 * Methods are always present (a platform without the data answers null/[]).
 * The CAPABILITIES below them are `null` when the vendor's settings do not
 * enable them — exactly the `null` the `createYiji*` factories return today —
 * so "not configured" stays distinguishable from "configured and failing",
 * which callers depend on (e.g. `/commerce/customer-exists` reports
 * `configured: false`, the coupon push stays `approved`).
 */
export interface VendorConnector {
  readonly platform: CommercePlatform;
  readonly vendor: ConnectorVendor;
  readonly settings: VendorPlatformSettings;

  /* Orders & customers — the inbox, contact profile, ticket and report panels. */
  getCustomer(externalCustomerId: string): Promise<CrmCustomer | null>;
  getOrders(externalCustomerId: string, opts?: { limit?: number }): Promise<CrmOrder[]>;
  getOrder(orderId: string): Promise<CrmOrder | null>;
  /** Tracking: the order's status history (derived when no history exists). */
  getOrderTimeline(orderId: string): Promise<CrmOrderTimeline | null>;
  /** The cart: every line with its add-ons, and the money. */
  getOrderCart(orderId: string): Promise<CrmOrderCart | null>;
  getPaymentStatus(orderId: string): Promise<CrmPaymentStatus | null>;
  getShipmentTracking(orderId: string): Promise<CrmShipmentTracking | null>;
  getPurchaseActivity(externalCustomerId: string): Promise<CrmPurchaseActivity | null>;
  /** The late-orders queue / register. */
  getLateDeliveryOrders(
    thresholdMinutes: number,
    opts?: CrmLateOrderQuery,
  ): Promise<CrmLateOrder[]>;

  /** The customer's most recent order id (WhatsApp fallback prefill). */
  readonly latestOrderId: ((externalCustomerId: string) => Promise<string | null>) | null;
  /** The BRAND name on the customer's latest order (push credential choice). Never throws. */
  readonly latestOrderBrandName: ((externalCustomerId: string) => Promise<string | null>) | null;
  /** Customer lookup by phone (coupon without an order, signup watch, customer-exists). */
  readonly findCustomerIdByPhone: ((phone: string) => Promise<string | null>) | null;
  /** Customer lookup by the platform's own id (app session token -> phone). */
  readonly getCustomerProfile: ((customerId: string) => Promise<CrmCustomerProfile | null>) | null;
  /** The order as a coupon needs it (customer id, phone, brand/restaurant ids). */
  readonly readCouponOrderContext:
    | ((orderId: string) => Promise<CrmCouponOrderContext | null>)
    | null;
  /** Coupon read-back: does this customer already hold this code? */
  readonly findCustomerCoupon:
    | ((customerId: string, code: string) => Promise<CrmCustomerCoupon | null>)
    | null;
  /** Coupon create/assign/withhold and customer push transport. */
  readonly adminPost: PlatformAdminPoster | null;
}

/* ── Yiji ────────────────────────────────────────────────────────── */

/** Pre-built parts, for tests and for callers that already hold a client. */
export interface YijiConnectorParts {
  client: YijiClient;
  latestOrderId?: VendorConnector['latestOrderId'];
  latestBrandName?:
    | ((vendorId: string, externalCustomerId: string) => Promise<string | null>)
    | null;
  findCustomerIdByPhone?: VendorConnector['findCustomerIdByPhone'];
  getCustomerProfile?: VendorConnector['getCustomerProfile'];
  readCouponOrderContext?: VendorConnector['readCouponOrderContext'];
  findCustomerCoupon?: VendorConnector['findCustomerCoupon'];
  adminPost?: PlatformAdminPoster | null;
}

/**
 * The Yiji connector: a thin adapter over the existing Yiji code.
 *
 * Each capability is built by the SAME factory, from the SAME `YijiClientEnv`,
 * that the service used to call directly — so the instances, their token
 * caches and every request they make are what they were. The vendor's own
 * platform id is passed where the client takes one (`HttpYijiClient` ignores
 * it; the mock keys its fixtures on it).
 */
export class YijiConnector implements VendorConnector {
  readonly platform = 'yiji' as const;
  readonly latestOrderId: VendorConnector['latestOrderId'];
  readonly latestOrderBrandName: VendorConnector['latestOrderBrandName'];
  readonly findCustomerIdByPhone: VendorConnector['findCustomerIdByPhone'];
  readonly getCustomerProfile: VendorConnector['getCustomerProfile'];
  readonly readCouponOrderContext: VendorConnector['readCouponOrderContext'];
  readonly findCustomerCoupon: VendorConnector['findCustomerCoupon'];
  readonly adminPost: PlatformAdminPoster | null;
  private readonly client: YijiClient;

  constructor(
    readonly vendor: ConnectorVendor,
    readonly settings: YijiPlatformSettings,
    parts?: YijiConnectorParts,
  ) {
    const env = settings.client;
    const p: YijiConnectorParts = parts ?? {
      client: createYijiClient(env),
      latestOrderId: createYijiLatestOrderReader(env),
      latestBrandName: createYijiLatestBrandReader(env),
      findCustomerIdByPhone: createYijiCustomerFinder(env),
      getCustomerProfile: createYijiUserReader(env),
      readCouponOrderContext: createYijiOrderReader(env),
      findCustomerCoupon: createYijiUserCouponFinder(env),
      adminPost: createYijiAdminPoster(env),
    };
    this.client = p.client;
    this.latestOrderId = p.latestOrderId ?? null;
    const brand = p.latestBrandName ?? null;
    this.latestOrderBrandName = brand
      ? (externalCustomerId) => brand(vendor.platformVendorId, externalCustomerId)
      : null;
    this.findCustomerIdByPhone = p.findCustomerIdByPhone ?? null;
    this.getCustomerProfile = p.getCustomerProfile ?? null;
    this.readCouponOrderContext = p.readCouponOrderContext ?? null;
    this.findCustomerCoupon = p.findCustomerCoupon ?? null;
    this.adminPost = p.adminPost ?? null;
  }

  private get vid(): string {
    return this.vendor.platformVendorId;
  }

  getCustomer(externalCustomerId: string) {
    return this.client.getCustomer(this.vid, externalCustomerId);
  }
  getOrders(externalCustomerId: string, opts?: { limit?: number }) {
    return this.client.getOrders(this.vid, externalCustomerId, opts);
  }
  getOrder(orderId: string) {
    return this.client.getOrder(this.vid, orderId);
  }
  getOrderTimeline(orderId: string) {
    return this.client.getOrderTimeline(this.vid, orderId);
  }
  getOrderCart(orderId: string) {
    return this.client.getOrderCart(orderId);
  }
  getPaymentStatus(orderId: string) {
    return this.client.getPaymentStatus(this.vid, orderId);
  }
  getShipmentTracking(orderId: string) {
    return this.client.getShipmentTracking(this.vid, orderId);
  }
  getPurchaseActivity(externalCustomerId: string) {
    return this.client.getPurchaseActivity(this.vid, externalCustomerId);
  }
  getLateDeliveryOrders(thresholdMinutes: number, opts?: CrmLateOrderQuery) {
    return this.client.getLateDeliveryOrders(thresholdMinutes, opts);
  }
}

/* ── Errors ──────────────────────────────────────────────────────── */

export type UnknownVendorReason =
  | 'unknown'
  | 'inactive'
  | 'unsupported_platform'
  | 'no_legacy_default'
  | 'ambiguous_legacy_default';

/**
 * The registry cannot serve this vendor.
 *
 * Deliberately NOT answered with the Yiji connector. Sending a vendor's order
 * lookup — or worse, a coupon — to another vendor's platform is the failure
 * this whole layer exists to make impossible.
 */
export class UnknownVendorError extends Error {
  readonly isUnknownVendor = true;
  constructor(
    readonly vendorKey: string,
    readonly reason: UnknownVendorReason,
  ) {
    super(
      reason === 'unknown'
        ? `no vendor "${vendorKey}" is configured for a commerce connector`
        : reason === 'inactive'
          ? `vendor "${vendorKey}" is not active`
          : reason === 'unsupported_platform'
            ? `vendor "${vendorKey}" is on a platform with no connector`
            : reason === 'no_legacy_default'
              ? 'no active Yiji vendor to own legacy (vendor-less) records'
              : 'more than one active Yiji vendor: legacy (vendor-less) records cannot be attributed',
    );
    this.name = 'UnknownVendorError';
  }
}

/** By shape, not `instanceof` — see `isYijiRefused` for why. */
export function isUnknownVendor(err: unknown): err is UnknownVendorError {
  return (
    err instanceof UnknownVendorError ||
    (typeof err === 'object' && err !== null && 'isUnknownVendor' in err)
  );
}

/* ── Registry ────────────────────────────────────────────────────── */

/** Where the registry learns which vendors exist. MV-1: the vendors table. */
export interface VendorDirectory {
  list(): Promise<ConnectorVendor[]>;
}

/** Where a vendor's platform settings (URLs, credentials, tenant) come from. */
export interface VendorSettingsSource {
  settingsFor(vendor: ConnectorVendor): Promise<VendorPlatformSettings>;
}

/** A fixed vendor list. */
export class StaticVendorDirectory implements VendorDirectory {
  constructor(private readonly vendors: readonly ConnectorVendor[]) {}
  async list(): Promise<ConnectorVendor[]> {
    return [...this.vendors];
  }
}

/** A `vendors` row as the directory reads it. */
export interface VendorRow {
  id: string;
  yiji_vendor_id: string | null;
  status: string | null;
  name?: string | null;
}

/**
 * `vendors` rows as connector vendors.
 *
 * Every vendor is on the Yiji platform today — the table has no platform
 * column yet (MV-1 adds one), and before MV-2 every vendor's commerce request
 * was answered by Yiji. A row without a platform id is skipped: there is no id
 * to call the platform with.
 */
export function vendorsFromRows(rows: readonly VendorRow[]): ConnectorVendor[] {
  const out: ConnectorVendor[] = [];
  for (const r of rows) {
    const platformVendorId = r.yiji_vendor_id?.trim();
    if (!r.id || !platformVendorId) continue;
    out.push({
      crmId: r.id,
      platformVendorId,
      platform: 'yiji',
      status: r.status ?? '',
      ...(r.name ? { name: r.name } : {}),
    });
  }
  return out;
}

export interface CachedVendorDirectoryOptions {
  /** Reads the vendors (e.g. the `vendors` collection). */
  load: () => Promise<ConnectorVendor[]>;
  /** Answers when `load` fails and nothing was ever loaded — today's env vendor. */
  fallback: VendorDirectory;
  /** How long a successful read is trusted. Default 5 minutes. */
  ttlMs?: number;
  /** How long to wait before asking again after a failure. Default 30 s. */
  retryMs?: number;
  /** Told about every failed read, so a fallback is never silent. */
  onFallback?: (err: unknown) => void;
  /** Injectable clock, for tests. */
  now?: () => number;
}

/**
 * The vendors table, cached — with the env vendor behind it.
 *
 * A Directus hiccup must never become a commerce outage, so a failed read
 * answers with the LAST GOOD list when there is one, else the fallback (the
 * env vendor, which still resolves `yiji_vendor_id` '1'), and reports it
 * through `onFallback`. An EMPTY answer counts as a failure: a vendors read
 * that returns nothing is a permission or filter problem, not a CRM with no
 * vendors, and treating it as truth would 404 every commerce request.
 */
export class CachedVendorDirectory implements VendorDirectory {
  private good: { vendors: ConnectorVendor[]; at: number } | null = null;
  private retryAt = 0;
  private inflight: Promise<ConnectorVendor[]> | null = null;
  private readonly ttlMs: number;
  private readonly retryMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: CachedVendorDirectoryOptions) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.retryMs = opts.retryMs ?? 30_000;
    this.now = opts.now ?? Date.now;
  }

  async list(): Promise<ConnectorVendor[]> {
    const t = this.now();
    if (this.good && t - this.good.at < this.ttlMs) return [...this.good.vendors];
    if (t < this.retryAt) return this.degraded();
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async refresh(): Promise<ConnectorVendor[]> {
    try {
      const vendors = await this.opts.load();
      if (vendors.length === 0) throw new Error('vendors read returned no rows');
      this.good = { vendors, at: this.now() };
      this.retryAt = 0;
      return [...vendors];
    } catch (err) {
      this.retryAt = this.now() + this.retryMs;
      this.opts.onFallback?.(err);
      return this.degraded();
    }
  }

  private async degraded(): Promise<ConnectorVendor[]> {
    return this.good ? [...this.good.vendors] : this.opts.fallback.list();
  }
}

/**
 * Every Yiji vendor gets the SAME settings — today's single env config.
 *
 * The first `VendorSettingsSource`. MV-1 replaces it with one that reads each
 * vendor's own URLs/credentials; no call site changes.
 */
export class EnvVendorSettingsSource implements VendorSettingsSource {
  constructor(private readonly yiji: YijiPlatformSettings) {}
  async settingsFor(vendor: ConnectorVendor): Promise<VendorPlatformSettings> {
    if (vendor.platform === 'yiji') return this.yiji;
    throw new UnknownVendorError(vendor.platformVendorId, 'unsupported_platform');
  }
}

export type ConnectorFactory = (
  vendor: ConnectorVendor,
  settings: VendorPlatformSettings,
) => VendorConnector;

export interface ConnectorRegistryOptions {
  directory: VendorDirectory;
  settings: VendorSettingsSource;
  /** Per-platform builders. Defaults to the built-in Yiji connector. */
  factories?: Partial<Record<CommercePlatform, ConnectorFactory>>;
  /**
   * The vendor that owns records written before vendors were distinguished —
   * see `defaultVendorForLegacyRecords`. Unset = the single active Yiji vendor.
   */
  legacyVendorKey?: string;
}

const DEFAULT_FACTORIES: Record<CommercePlatform, ConnectorFactory> = {
  yiji: (vendor, settings) => new YijiConnector(vendor, settings),
};

/**
 * Resolves a vendor to its connector.
 *
 * `vendorKey` is either the CRM vendor UUID or the vendor's platform id
 * (`yiji_vendor_id`). One connector per vendor, built once and reused, so its
 * clients' cached admin tokens survive across calls exactly as the old
 * process-wide singletons' did.
 */
export class ConnectorRegistry {
  private readonly factories: Record<CommercePlatform, ConnectorFactory>;
  private readonly connectors = new Map<string, Promise<VendorConnector>>();

  constructor(private readonly opts: ConnectorRegistryOptions) {
    this.factories = { ...DEFAULT_FACTORIES, ...(opts.factories ?? {}) };
  }

  /** The vendor behind a key, or a typed error. Never a guess. */
  async resolveVendor(vendorKey: string): Promise<ConnectorVendor> {
    const key = (vendorKey ?? '').trim();
    if (!key) throw new UnknownVendorError(key, 'unknown');
    const vendors = await this.opts.directory.list();
    const vendor =
      vendors.find((v) => v.crmId && v.crmId === key) ??
      vendors.find((v) => v.platformVendorId === key);
    if (!vendor) throw new UnknownVendorError(key, 'unknown');
    if (vendor.status !== 'active') throw new UnknownVendorError(key, 'inactive');
    if (!(vendor.platform in this.factories)) {
      throw new UnknownVendorError(key, 'unsupported_platform');
    }
    return vendor;
  }

  async connectorFor(vendorKey: string): Promise<VendorConnector> {
    const vendor = await this.resolveVendor(vendorKey);
    const cacheKey = `${vendor.platform}:${vendor.platformVendorId}`;
    let pending = this.connectors.get(cacheKey);
    if (!pending) {
      pending = this.opts.settings
        .settingsFor(vendor)
        .then((settings) => this.factories[vendor.platform](vendor, settings));
      // A failed build is not cached: the next call tries again.
      pending.catch(() => this.connectors.delete(cacheKey));
      this.connectors.set(cacheKey, pending);
    }
    return pending;
  }

  /**
   * THE ONLY ALLOWED DEFAULT VENDOR: for records that carry no vendor yet.
   *
   * TODO(MV-1): `coupon_approvals`, the late-orders queue, the cart and the
   * service-time batch have no vendor column / parameter today. MV-1 adds one
   * and every caller of this helper must pass the record's vendor instead —
   * then this method is deleted.
   *
   * With `legacyVendorKey` (the services pass today's env vendor, '1'): that
   * vendor, which must exist and be active — it is the vendor every
   * vendor-less record was in fact written for, the same rule the coupon
   * push's `couponEndpointFor` fallback already applies. It is pinned rather
   * than inferred because a vendors table read whole can hold more than one
   * active row (e.g. showcase vendors on staging), and that must not take the
   * late-orders queue down.
   *
   * Without it: the platform id of the SINGLE active Yiji vendor, and a typed
   * REFUSAL the moment there are two — guessing would hand one vendor's
   * coupons to another vendor's platform.
   */
  async defaultVendorForLegacyRecords(): Promise<string> {
    if (this.opts.legacyVendorKey) {
      const legacy = await this.resolveVendor(this.opts.legacyVendorKey).catch((err: unknown) => {
        if (isUnknownVendor(err)) throw new UnknownVendorError('', 'no_legacy_default');
        throw err;
      });
      if (legacy.platform !== 'yiji') throw new UnknownVendorError('', 'no_legacy_default');
      return legacy.platformVendorId;
    }
    const yiji = (await this.opts.directory.list()).filter(
      (v) => v.platform === 'yiji' && v.status === 'active',
    );
    if (yiji.length === 0) throw new UnknownVendorError('', 'no_legacy_default');
    if (yiji.length > 1) throw new UnknownVendorError('', 'ambiguous_legacy_default');
    return yiji[0]!.platformVendorId;
  }
}

/** Narrow a connector to Yiji, for the Yiji-only coupon/push processors. */
export function asYijiConnector(connector: VendorConnector): YijiConnector {
  if (connector instanceof YijiConnector || connector.platform === 'yiji') {
    return connector as YijiConnector;
  }
  throw new UnknownVendorError(connector.vendor.platformVendorId, 'unsupported_platform');
}

/** The vendor id the Yiji app sends and the seeded vendor carries. */
export const LEGACY_YIJI_VENDOR_ID = '1';

/**
 * Today's setup, as a registry: Yiji vendors, settings from env.
 *
 * `vendorId` is the platform id of the env vendor (`yiji_vendor_id`) — the
 * value each service already uses (`DEFAULT_VENDOR_ID`, `YIJI_VENDOR_ID`, or
 * `'1'`). It owns the legacy (vendor-less) records.
 *
 * Without `loadVendors` that is the ONLY vendor: any other key resolves to
 * `UnknownVendorError`. With it (a service that can read the `vendors`
 * table), every vendor there resolves by its CRM UUID or its
 * `yiji_vendor_id`, cached for `vendorsTtlMs`; the env vendor answers only
 * while that read is failing, reported through `onDirectoryFallback`.
 */
export function createEnvConnectorRegistry(opts: {
  vendorId?: string;
  crmVendorId?: string;
  yiji: Omit<YijiPlatformSettings, 'platform'>;
  factories?: ConnectorRegistryOptions['factories'];
  loadVendors?: () => Promise<ConnectorVendor[]>;
  onDirectoryFallback?: (err: unknown) => void;
  vendorsTtlMs?: number;
}): ConnectorRegistry {
  const vendor: ConnectorVendor = {
    platformVendorId: opts.vendorId?.trim() || LEGACY_YIJI_VENDOR_ID,
    ...(opts.crmVendorId ? { crmId: opts.crmVendorId } : {}),
    platform: 'yiji',
    status: 'active',
    name: 'Yiji',
  };
  const envDirectory = new StaticVendorDirectory([vendor]);
  return new ConnectorRegistry({
    directory: opts.loadVendors
      ? new CachedVendorDirectory({
          load: opts.loadVendors,
          fallback: envDirectory,
          ...(opts.vendorsTtlMs != null ? { ttlMs: opts.vendorsTtlMs } : {}),
          ...(opts.onDirectoryFallback ? { onFallback: opts.onDirectoryFallback } : {}),
        })
      : envDirectory,
    settings: new EnvVendorSettingsSource({ platform: 'yiji', ...opts.yiji }),
    legacyVendorKey: vendor.platformVendorId,
    ...(opts.factories ? { factories: opts.factories } : {}),
  });
}
