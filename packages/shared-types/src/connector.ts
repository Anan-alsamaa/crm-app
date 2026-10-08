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
   * Answers the platform id of the SINGLE active Yiji vendor, and REFUSES
   * (typed error) the moment there are two: from then on a vendor-less record
   * cannot be attributed, and guessing would hand one vendor's coupons to
   * another vendor's platform.
   */
  async defaultVendorForLegacyRecords(): Promise<string> {
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
 * Today's setup, as a registry: ONE active Yiji vendor, settings from env.
 *
 * `vendorId` is the platform id of that vendor (`yiji_vendor_id`) — the value
 * each service already uses (`DEFAULT_VENDOR_ID`, `YIJI_VENDOR_ID`, or `'1'`).
 * Any other vendor key resolves to `UnknownVendorError`.
 */
export function createEnvConnectorRegistry(opts: {
  vendorId?: string;
  crmVendorId?: string;
  yiji: Omit<YijiPlatformSettings, 'platform'>;
  factories?: ConnectorRegistryOptions['factories'];
}): ConnectorRegistry {
  const vendor: ConnectorVendor = {
    platformVendorId: opts.vendorId?.trim() || LEGACY_YIJI_VENDOR_ID,
    ...(opts.crmVendorId ? { crmId: opts.crmVendorId } : {}),
    platform: 'yiji',
    status: 'active',
    name: 'Yiji',
  };
  return new ConnectorRegistry({
    directory: new StaticVendorDirectory([vendor]),
    settings: new EnvVendorSettingsSource({ platform: 'yiji', ...opts.yiji }),
    ...(opts.factories ? { factories: opts.factories } : {}),
  });
}
