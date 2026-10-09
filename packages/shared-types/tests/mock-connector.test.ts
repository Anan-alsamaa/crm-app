import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  COMMERCE_PLATFORMS,
  ConnectorRegistry,
  EnvVendorSettingsSource,
  MockConnector,
  StaticVendorDirectory,
  UnknownVendorError,
  YijiConnector,
  asCouponPushConnector,
  asYijiConnector,
  createEnvConnectorRegistry,
  mockVendorsAllowed,
  vendorsFromRows,
  type ConnectorVendor,
} from '../src/index.js';

const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const testVendor: ConnectorVendor = {
  crmId: 'uuid-test',
  platformVendorId: 'test-1',
  platform: 'mock',
  status: 'active',
  name: 'Test Vendor',
};
const yijiVendor: ConnectorVendor = {
  crmId: 'uuid-yiji',
  platformVendorId: '1',
  platform: 'yiji',
  status: 'active',
  name: 'Yiji',
};
const mock = () => new MockConnector(testVendor, { platform: 'mock' }, { now: () => NOW });

describe('MockConnector makes ZERO network calls', () => {
  const fetchSpy = vi.fn(() => {
    throw new Error('network call from the mock connector');
  });
  beforeEach(() => {
    fetchSpy.mockClear();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('every method and capability answers without fetch', async () => {
    const c = mock();
    await c.getCustomer('mock-cust-1');
    await c.getOrders('mock-cust-1');
    await c.getOrder('MOCK-1001');
    await c.getOrderTimeline('MOCK-1001');
    await c.getOrderCart('MOCK-1001');
    await c.getPaymentStatus('MOCK-1001');
    await c.getShipmentTracking('MOCK-1001');
    await c.getPurchaseActivity('mock-cust-1');
    await c.getLateDeliveryOrders(60, { includeCompleted: true });
    await c.latestOrderId!('mock-cust-1');
    await c.latestOrderBrandName!('mock-cust-1');
    await c.findCustomerIdByPhone!('0500000101');
    await c.getCustomerProfile!('mock-cust-1');
    await c.readCouponOrderContext!('MOCK-1001');
    await c.findCustomerCoupon!('mock-cust-1', 'X');
    await c.adminPost('/api/Coupon/AddCoupon', { code: 'X' });
    await c.adminPost('/api/CouponUser/AddUserCoupon', { couponCode: 'X', userId: 'mock-cust-1' });
    await c.adminPost('/api/Notification/Send', { title: 't' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the module imports no HTTP client and never calls fetch', () => {
    const src = readFileSync(resolve(import.meta.dirname, '../src/mock-connector.ts'), 'utf8');
    expect(src).not.toMatch(/\bfetch\(/);
    expect(src).not.toMatch(/from ['"](node:)?(http|https|net|undici)['"]/);
    expect(src).not.toMatch(/from ['"]\.\/yiji-impl\.js['"]/);
  });
});

describe('MockConnector simulated data', () => {
  it('is deterministic for the same clock', async () => {
    expect(await mock().getOrders('mock-cust-1')).toEqual(await mock().getOrders('mock-cust-1'));
  });

  it('customers, newest-first orders with modifiers, and a cart that adds up', async () => {
    const c = mock();
    expect(await c.getCustomer('mock-cust-1')).toMatchObject({ phone: '0500000101' });
    expect(await c.getCustomer('nobody')).toBeNull();
    const orders = await c.getOrders('mock-cust-1');
    expect(orders.map((o) => o.orderId)).toEqual(['MOCK-1001', 'MOCK-1002']);
    expect(await c.getOrders('mock-cust-1', { limit: 1 })).toHaveLength(1);
    expect(orders[0]!.items[0]!.modifiers).toEqual(['Extra cheese', 'No onions']);
    expect(orders[0]!.brandName).toBe('Test Vendor Kitchen');
    const cart = (await c.getOrderCart('MOCK-1001'))!;
    expect(cart.lines.flatMap((l) => l.modifiers)).toContain('Large');
    expect(cart.foodPrice! + cart.deliveryFee!).toBe(cart.total);
    expect(await c.getOrder('123456')).toBeNull();
  });

  it('late orders: live delivery orders past the threshold, longest first', async () => {
    const c = mock();
    const rows = await c.getLateDeliveryOrders(60);
    expect(rows.map((r) => [r.orderId, r.minutesElapsed])).toEqual([
      ['MOCK-1001', 95],
      ['MOCK-1003', 70],
    ]);
    expect(await c.getLateDeliveryOrders(80)).toHaveLength(1);
    const all = await c.getLateDeliveryOrders(60, { includeCompleted: true });
    expect(all.map((r) => r.orderId)).toContain('MOCK-1004');
    expect(all.find((r) => r.orderId === 'MOCK-1002')).toBeUndefined(); // pickup
  });

  it('phone lookup: catalogue customer, else a deterministic mock-<digits> customer', async () => {
    const c = mock();
    expect(await c.findCustomerIdByPhone!('+966500000102')).toBe('mock-cust-2');
    expect(await c.findCustomerIdByPhone!('0551234567')).toBe('mock-551234567');
    expect(await c.getCustomer('mock-551234567')).toMatchObject({ phone: '0551234567' });
    expect(await c.findCustomerIdByPhone!('12')).toBeNull();
    expect(await c.getCustomerProfile!('mock-cust-1')).toMatchObject({ phone: '+966500000101' });
  });

  it('coupon create -> assign -> read-back is recorded in memory with ids', async () => {
    const c = mock();
    const created = await c.adminPost<{ result: number; exceptionMessage: string }>(
      '/api/Coupon/AddCoupon',
      { coupon: { code: 'CRM-1' } },
      { tenantid: '1' },
    );
    expect(created.result).toBe(1);
    const couponId = Number(created.exceptionMessage);
    expect(couponId).toBeGreaterThan(0);
    const assigned = await c.adminPost<{
      result: number;
      extendedProperties: { CouponUserId: string };
    }>('/api/CouponUser/AddUserCoupon', { couponId, userId: 'mock-cust-1', couponCode: 'CRM-1' });
    expect(assigned.result).toBe(1);
    expect(await c.findCustomerCoupon!('mock-cust-1', 'CRM-1')).toEqual({
      couponUserId: assigned.extendedProperties.CouponUserId,
      couponId,
    });
    expect(await c.findCustomerCoupon!('mock-cust-2', 'CRM-1')).toBeNull();
    expect(c.calls.map((x) => x.path)).toEqual([
      '/api/Coupon/AddCoupon',
      '/api/CouponUser/AddUserCoupon',
    ]);
  });

  it('an order-based grant is attributed to the order customer', async () => {
    const c = mock();
    await c.adminPost('/api/CouponUserOrder/CreateCouponUserFromOrder', {
      orderId: 'MOCK-1003',
      couponUser: { couponCode: 'CRM-2' },
    });
    expect(c.assignedCoupons[0]).toMatchObject({ customerId: 'mock-cust-2', code: 'CRM-2' });
  });

  it('push notify is a no-op success', async () => {
    expect(await mock().adminPost('/api/Notification/Push', {})).toEqual({ result: 1 });
  });
});

describe('the registry picks the connector by vendor.platform', () => {
  const settings = (allowMock: boolean) =>
    new EnvVendorSettingsSource({ platform: 'yiji', client: {} }, { allowMock });
  const registry = (allowMock: boolean) =>
    new ConnectorRegistry({
      directory: new StaticVendorDirectory([yijiVendor, testVendor]),
      settings: settings(allowMock),
      allowMockVendors: allowMock,
    });

  it('mock vendor -> MockConnector, yiji vendor -> YijiConnector (flag on)', async () => {
    const r = registry(true);
    expect(await r.connectorFor('test-1')).toBeInstanceOf(MockConnector);
    expect(await r.connectorFor('uuid-test')).toBeInstanceOf(MockConnector);
    expect(await r.connectorFor('1')).toBeInstanceOf(YijiConnector);
    expect(r.mockVendorsAllowed).toBe(true);
  });

  it('without the flag a mock vendor is REFUSED (mock_not_allowed), never Yiji', async () => {
    const r = registry(false);
    const err = await r.connectorFor('test-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnknownVendorError);
    expect((err as UnknownVendorError).reason).toBe('mock_not_allowed');
    expect(await r.connectorFor('1')).toBeInstanceOf(YijiConnector);
  });

  it('a caller-supplied mock factory is dropped when the flag is off', async () => {
    const r = new ConnectorRegistry({
      directory: new StaticVendorDirectory([testVendor]),
      settings: settings(true),
      factories: { mock: (v) => new MockConnector(v, { platform: 'mock' }) },
    });
    await expect(r.connectorFor('test-1')).rejects.toMatchObject({ reason: 'mock_not_allowed' });
  });

  it('the settings source alone refuses mock without the flag', async () => {
    await expect(settings(false).settingsFor(testVendor)).rejects.toMatchObject({
      reason: 'mock_not_allowed',
    });
    expect(await settings(true).settingsFor(testVendor)).toEqual({ platform: 'mock' });
  });

  it('a platform with no connector stays unsupported, even a prototype key', async () => {
    const r = new ConnectorRegistry({
      directory: new StaticVendorDirectory([{ ...testVendor, platform: 'toString' as never }]),
      settings: settings(true),
      allowMockVendors: true,
    });
    await expect(r.connectorFor('test-1')).rejects.toMatchObject({
      reason: 'unsupported_platform',
    });
  });

  it('a mock vendor never becomes the legacy default', async () => {
    const r = new ConnectorRegistry({
      directory: new StaticVendorDirectory([testVendor]),
      settings: settings(true),
      allowMockVendors: true,
    });
    await expect(r.defaultVendorForLegacyRecords()).rejects.toMatchObject({
      reason: 'no_legacy_default',
    });
  });

  it('createEnvConnectorRegistry reads platform from the vendors rows', async () => {
    const rows = [
      { id: 'uuid-yiji', yiji_vendor_id: '1', status: 'active', platform: 'yiji' },
      { id: 'uuid-test', yiji_vendor_id: 'test-1', status: 'active', platform: 'mock' },
    ];
    const on = createEnvConnectorRegistry({
      yiji: { client: {} },
      loadVendors: async () => vendorsFromRows(rows),
      allowMockVendors: true,
    });
    expect((await on.connectorFor('uuid-test')).platform).toBe('mock');
    const off = createEnvConnectorRegistry({
      yiji: { client: {} },
      loadVendors: async () => vendorsFromRows(rows),
    });
    await expect(off.connectorFor('uuid-test')).rejects.toMatchObject({
      reason: 'mock_not_allowed',
    });
    expect((await off.connectorFor('1')).platform).toBe('yiji');
  });

  it('coupon/push narrowing: Yiji and mock pass, mock is never "Yiji"', async () => {
    const r = registry(true);
    const m = await r.connectorFor('test-1');
    expect(asCouponPushConnector(m)).toBe(m);
    expect(() => asYijiConnector(m)).toThrow(UnknownVendorError);
    const other = { ...m, platform: 'shopify', vendor: testVendor } as never;
    expect(() => asCouponPushConnector(other)).toThrow(UnknownVendorError);
  });

  it('platform list matches the schema choices', () => {
    expect([...COMMERCE_PLATFORMS]).toEqual(['yiji', 'mock']);
  });
});

describe('mockVendorsAllowed (the env flag)', () => {
  it('off unless ALLOW_MOCK_VENDORS=true', () => {
    expect(mockVendorsAllowed({})).toBe(false);
    expect(mockVendorsAllowed({ ALLOW_MOCK_VENDORS: '1' })).toBe(false);
    expect(mockVendorsAllowed({ ALLOW_MOCK_VENDORS: 'false' })).toBe(false);
    expect(
      mockVendorsAllowed({
        ALLOW_MOCK_VENDORS: 'true',
        DIRECTUS_INTERNAL_URL: 'http://staging-directus.crm.local:8055',
      }),
    ).toBe(true);
  });

  it('throws when the flag meets production Directus', () => {
    for (const url of ['http://prod-directus.crm.local:8055', 'https://crm-api.anan.sa']) {
      expect(() =>
        mockVendorsAllowed({ ALLOW_MOCK_VENDORS: 'true', DIRECTUS_INTERNAL_URL: url }),
      ).toThrow(/PRODUCTION/);
    }
    // Off is off, whatever the Directus.
    expect(mockVendorsAllowed({ DIRECTUS_INTERNAL_URL: 'https://crm-api.anan.sa' })).toBe(false);
  });
});
