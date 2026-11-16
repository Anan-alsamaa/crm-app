import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import {
  ConnectorRegistry,
  EnvVendorSettingsSource,
  StaticVendorDirectory,
  MockYiji2Transport,
  Yiji2Connector,
  Yiji2RefusedError,
  asCouponPushConnector,
} from '@yiji/shared-types';
import {
  couponEndpointFor,
  processCouponPushJob,
  YIJI_COUPON_PATH,
  type CouponApprovalRow,
} from '../src/processors/coupon-push.js';
import { resolveCouponConnector } from '../src/processors/coupon-vendor.js';

/**
 * YIJI V2 (owner, 2026-11-16): a coupon for the v2 vendor runs through the
 * UNCHANGED v1 coupon processor; the v2 connector translates the v1 admin
 * calls into `POST /compensation-coupons` + `POST /grants` and the coupon
 * lands in v2's (mock) memory - never on v1, never on the network. An
 * INACTIVE v2 vendor (the morning state) gets nothing and the coupon stays
 * approved.
 */
vi.mock('@directus/sdk', () => ({
  readItems: (collection: string, opts: unknown) => ({ collection, opts }),
  readItem: (collection: string, id: string, opts: unknown) => ({ collection, id, opts }),
  updateItem: (collection: string, id: string, payload: unknown) => ({ collection, id, payload }),
}));

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const registry = (v2Status: 'active' | 'inactive') =>
  new ConnectorRegistry({
    directory: new StaticVendorDirectory([
      { crmId: 'uuid-yiji', platformVendorId: '1', platform: 'yiji', status: 'active' },
      {
        crmId: 'uuid-v2',
        platformVendorId: '2',
        platform: 'yiji2',
        status: v2Status,
        name: 'Yiji V2',
      },
    ]),
    settings: new EnvVendorSettingsSource(
      { platform: 'yiji', client: {} },
      { yiji2: { platform: 'yiji2', mock: true, tenantId: '2' } },
    ),
    legacyVendorKey: '1',
  });

const ROW = {
  id: 'ca-v2',
  status: 'approved',
  coupon_code: 'V2-0001',
  coupon_value: '10.00000',
  coupon_percent: null,
  max_discount: '10.00000',
  usage_limit: '1',
  total_discount_limit: '10000.00000',
  valid_from: '2026-11-16',
  valid_to: '2026-12-16',
  title: '0500000201',
  issuing_side: 'Operations',
  delivery_type: 'All',
  coupon_type: 'Private',
  discount_category: 'Amount',
  brand_id: 'V2 Kitchen',
  restaurant_id: '9101',
  item_name: null,
  no_other_discounts: false,
  reason: 'late order',
  customer_phone: null,
  contact: { id: 'k2', name: null, phone: '0500000201', external_customer_id: null },
  ticket: { order_id: null },
  order_id: null,
  yiji_coupon_user_id: null,
} as unknown as CouponApprovalRow;

afterEach(() => vi.unstubAllGlobals());

describe('coupon endpoint for the v2 platform', () => {
  it('is chosen by the platform, not by the tenant id', () => {
    expect(couponEndpointFor('2', 'yiji2')).toEqual({ path: YIJI_COUPON_PATH, platform: 'yiji2' });
    /* v1 is exactly what it was. */
    expect(couponEndpointFor('1', 'yiji')).toEqual({ path: YIJI_COUPON_PATH, platform: 'yiji' });
    expect(couponEndpointFor('1')).toEqual({ path: YIJI_COUPON_PATH, platform: 'yiji' });
    /* a v2 tenant id without the platform is still refused, never v1 */
    expect(couponEndpointFor('2')).toBeNull();
    expect(couponEndpointFor('2', 'yiji')).toBeNull();
  });
});

describe('coupon for the v2 vendor', () => {
  it('an inactive v2 vendor gets nothing: the coupon stays approved', async () => {
    const off = await resolveCouponConnector({
      connectors: registry('inactive'),
      couponApprovalId: 'ca-v2',
      vendor: 'uuid-v2',
      logger,
    });
    expect(off).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ vendor: 'uuid-v2', reason: 'inactive' }),
      expect.stringContaining('not sent'),
    );
  });

  it('an active v2 vendor is delivered into v2 (mock) by the real processor, zero network', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('network');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const connector = await resolveCouponConnector({
      connectors: registry('active'),
      couponApprovalId: 'ca-v2',
      vendor: 'uuid-v2',
      logger,
    });
    const v2 = asCouponPushConnector(connector!) as Yiji2Connector;
    expect(v2).toBeInstanceOf(Yiji2Connector);
    const directus = {
      request: vi.fn(async (arg: unknown) =>
        arg && typeof arg === 'object' && 'payload' in (arg as object) ? {} : ROW,
      ),
    };
    const outcome = await processCouponPushJob(
      { data: { couponApprovalId: 'ca-v2' } } as Job<{ couponApprovalId: string }>,
      {
        directus: directus as never,
        logger,
        platform: v2.platform,
        postCoupon: v2.adminPost ?? undefined,
        findCustomer: v2.findCustomerIdByPhone ?? undefined,
        findUserCoupon: v2.findCustomerCoupon ?? undefined,
        yijiTenantId: v2.settings.tenantId ?? '1',
      },
    );
    expect(outcome).toBe('delivered');
    const t = v2.transport as MockYiji2Transport;
    expect(t.coupons).toHaveLength(1);
    expect(t.coupons[0]).toMatchObject({ code: 'V2-0001' });
    expect(t.coupons[0]?.body).toMatchObject({
      category: 'private',
      type: 'amount',
      value: { amount_minor: 1000, currency: 'SAR' },
      country: 'SA',
    });
    expect(t.grants).toHaveLength(1);
    expect(t.grants[0]).toMatchObject({ customer_id: '2000000001', code: 'V2-0001' });
    /* the row got v2's grant id as its receipt, and the Yiji v1 path was never used */
    const update = directus.request.mock.calls
      .map((c) => c[0] as { payload?: Record<string, unknown> })
      .find((a) => a.payload)?.payload;
    expect(update).toMatchObject({ status: 'assigned', yiji_coupon_user_id: '700001' });
    expect(t.calls.map((c) => c.path)).toEqual(['/compensation-coupons', '/grants']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a 400 VALIDATION_FAILED from v2 is recorded on the row and NOT retried (the job finishes)', async () => {
    /* v2 session, 2026-11-16: invalid input is HTTP 400 { error: { code:
       "VALIDATION_FAILED", message_key, trace_id } }, no field list. */
    const inner = new MockYiji2Transport();
    const transport = {
      request: async <T>(
        method: 'GET' | 'POST' | 'PUT' | 'DELETE',
        path: string,
        opts?: Parameters<MockYiji2Transport['request']>[2],
      ): Promise<T | null> => {
        if (method === 'POST' && path === '/compensation-coupons')
          throw new Yiji2RefusedError('VALIDATION_FAILED', 'coupon.valid_to.past', 400, 'tr-400');
        return inner.request<T>(method, path, opts);
      },
    };
    const v2 = new Yiji2Connector(
      { crmId: 'uuid-v2', platformVendorId: '2', platform: 'yiji2', status: 'active' },
      { platform: 'yiji2', mock: true, tenantId: '2' },
      { transport },
    );
    const directus = {
      request: vi.fn(async (arg: unknown) =>
        arg && typeof arg === 'object' && 'payload' in (arg as object) ? {} : ROW,
      ),
    };
    const outcome = await processCouponPushJob(
      { data: { couponApprovalId: 'ca-v2' } } as Job<{ couponApprovalId: string }>,
      {
        directus: directus as never,
        logger,
        platform: v2.platform,
        postCoupon: v2.adminPost ?? undefined,
        findCustomer: v2.findCustomerIdByPhone ?? undefined,
        findUserCoupon: v2.findCustomerCoupon ?? undefined,
        yijiTenantId: '2',
      },
    );
    /* refused, not thrown: BullMQ sees a finished job, never a retry */
    expect(outcome).toBe('refused');
    const update = directus.request.mock.calls
      .map((c) => c[0] as { payload?: Record<string, unknown> })
      .find((a) => a.payload)?.payload;
    expect(update).toMatchObject({
      yiji_push_error: 'VALIDATION_FAILED: coupon.valid_to.past (trace tr-400)',
    });
    expect(update).not.toHaveProperty('status');
    expect(inner.coupons).toHaveLength(0);
    expect(inner.grants).toHaveLength(0);
  });
});
