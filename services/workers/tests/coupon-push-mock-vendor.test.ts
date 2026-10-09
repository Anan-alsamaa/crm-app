import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import {
  ConnectorRegistry,
  EnvVendorSettingsSource,
  MockConnector,
  StaticVendorDirectory,
  asCouponPushConnector,
} from '@yiji/shared-types';
import { processCouponPushJob, type CouponApprovalRow } from '../src/processors/coupon-push.js';
import { resolveCouponConnector } from '../src/processors/coupon-vendor.js';

/**
 * MV-6 (EMA-75): a coupon for the MOCK test vendor runs through the REAL
 * coupon processor and lands in the mock's memory — never on Yiji, never on
 * the network. Without ALLOW_MOCK_VENDORS it is not sent anywhere.
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

const VENDORS = [
  { crmId: 'uuid-yiji', platformVendorId: '1', platform: 'yiji' as const, status: 'active' },
  {
    crmId: 'uuid-test',
    platformVendorId: 'test-1',
    platform: 'mock' as const,
    status: 'active',
    name: 'Test Vendor',
  },
];
const registry = (allowMock: boolean) =>
  new ConnectorRegistry({
    directory: new StaticVendorDirectory(VENDORS),
    settings: new EnvVendorSettingsSource({ platform: 'yiji', client: {} }, { allowMock }),
    legacyVendorKey: '1',
    allowMockVendors: allowMock,
  });

const ROW = {
  id: 'ca-mock',
  status: 'approved',
  coupon_code: 'TEST-0001',
  coupon_value: '10.00000',
  coupon_percent: null,
  max_discount: '10.00000',
  usage_limit: '1',
  valid_from: '2026-10-09',
  valid_to: '2026-11-09',
  title: '0500000101',
  issuing_side: 'Operations',
  delivery_type: 'All',
  coupon_type: 'Private',
  discount_category: 'Amount',
  brand_id: 'Test Vendor Kitchen',
  restaurant_id: 'mock-store-1',
  item_name: null,
  no_other_discounts: false,
  reason: 'release check',
  customer_phone: null,
  contact: { id: 'k1', name: null, phone: '0500000101', external_customer_id: null },
  ticket: { order_id: null },
  order_id: null,
  yiji_coupon_user_id: null,
} as unknown as CouponApprovalRow;

afterEach(() => vi.unstubAllGlobals());

describe('coupon for the mock test vendor', () => {
  it('resolves to the MockConnector with the flag, to nothing without it', async () => {
    const on = await resolveCouponConnector({
      connectors: registry(true),
      couponApprovalId: 'ca-mock',
      vendor: 'uuid-test',
      logger,
    });
    expect(asCouponPushConnector(on!)).toBeInstanceOf(MockConnector);
    const off = await resolveCouponConnector({
      connectors: registry(false),
      couponApprovalId: 'ca-mock',
      vendor: 'uuid-test',
      logger,
    });
    expect(off).toBeNull();
  });

  it('is delivered into the mock’s memory by the real processor, with zero network calls', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('network');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const mock = asCouponPushConnector(
      (await registry(true).connectorFor('uuid-test')) as never,
    ) as MockConnector;
    const directus = {
      request: vi.fn(async (arg: unknown) =>
        arg && typeof arg === 'object' && 'payload' in (arg as object) ? {} : ROW,
      ),
    };
    const outcome = await processCouponPushJob(
      { data: { couponApprovalId: 'ca-mock' } } as Job<{ couponApprovalId: string }>,
      {
        directus: directus as never,
        logger,
        postCoupon: mock.adminPost,
        findCustomer: mock.findCustomerIdByPhone ?? undefined,
        findUserCoupon: mock.findCustomerCoupon ?? undefined,
        yijiTenantId: mock.settings.tenantId ?? '1',
      },
    );
    expect(outcome).toBe('delivered');
    expect(mock.assignedCoupons).toHaveLength(1);
    expect(mock.assignedCoupons[0]).toMatchObject({ customerId: 'mock-cust-1', code: 'TEST-0001' });
    expect(await mock.findCustomerCoupon!('mock-cust-1', 'TEST-0001')).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
