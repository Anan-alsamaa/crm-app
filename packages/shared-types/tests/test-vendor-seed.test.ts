import { describe, expect, it } from 'vitest';
// The pure planner behind scripts/seed-test-vendor.mjs (MV-6, EMA-75).
import {
  REMOVE_ORDER,
  TEST_STORES,
  TEST_VENDOR,
  assertStagingApi,
  planRemove,
  planSeed,
  resolveRefs,
} from '../../../scripts/lib/test-vendor-seed-plan.mjs';
import {
  VENDOR_RECORD_COLLECTIONS,
  VENDOR_SHARED_CONFIG_COLLECTIONS,
  relations,
} from '../../../directus/bootstrap/src/collections.js';

const GRANTED = [
  { fields: ['id', 'name', 'platform'], policy: { name: 'svc-ai-gateway policy' } },
  { fields: ['id', 'name', 'platform'], policy: { name: 'svc-workers policy' } },
];
const yiji = {
  id: 'uuid-yiji',
  name: 'Yiji',
  platform: 'yiji',
  yiji_vendor_id: '1',
  webhook_path_key: 'yiji',
  status: 'active',
};

type Plan = {
  refuse?: string;
  actions?: Array<{
    op: string;
    collection: string;
    id?: string;
    key: string;
    data?: Record<string, unknown>;
    ids?: string[];
  }>;
};

describe('assertStagingApi', () => {
  it('accepts only crm-api-staging.anan.sa', () => {
    expect(() => assertStagingApi('https://crm-api-staging.anan.sa')).not.toThrow();
    expect(() => assertStagingApi('https://crm-api-staging.anan.sa/')).not.toThrow();
    for (const bad of [
      'https://crm-api.anan.sa',
      'https://crm-api-staging.anan.sa.evil.com',
      'http://localhost:8055',
      '',
      'not a url',
    ]) {
      expect(() => assertStagingApi(bad), bad).toThrow(/refusing/);
    }
  });
});

describe('planSeed', () => {
  it('creates vendor, brand and stores on an empty staging', () => {
    const plan = planSeed({
      vendors: [yiji],
      brands: [],
      stores: [],
      vendorPermissions: GRANTED,
    }) as Plan;
    expect(plan.refuse).toBeUndefined();
    expect(plan.actions!.map((a) => `${a.op}:${a.collection}:${a.key}`)).toEqual([
      'create:vendors:test-1',
      'create:brands:TV-MOCK',
      'create:stores:TV-001',
      'create:stores:TV-002',
    ]);
    expect(plan.actions![0]!.data).toMatchObject({
      name: 'Test Vendor',
      platform: 'mock',
      yiji_vendor_id: 'test-1',
      webhook_path_key: 'test',
      status: 'active',
    });
    expect(plan.actions![2]!.data).toMatchObject({ vendor: '$vendor', brand: '$brand:TV-MOCK' });
  });

  it('is idempotent: a seeded staging plans nothing', () => {
    const v = { id: 'uuid-test', ...TEST_VENDOR };
    const brands = [
      {
        id: 'b1',
        code: 'TV-MOCK',
        name: 'Test Vendor Kitchen',
        yiji_brand_name: 'Test Vendor Kitchen',
        status: 'active',
        vendor: 'uuid-test',
      },
    ];
    const stores = TEST_STORES.map(({ brandCode: _b, ...s }, i) => ({
      id: `s${i}`,
      ...s,
      brand: { id: 'b1' },
      vendor: { id: 'uuid-test' },
    }));
    const plan = planSeed({
      vendors: [yiji, v],
      brands,
      stores,
      vendorPermissions: GRANTED,
    }) as Plan;
    expect(plan.actions).toEqual([]);
  });

  it('repairs drift only', () => {
    const v = { id: 'uuid-test', ...TEST_VENDOR, status: 'inactive' };
    const plan = planSeed({
      vendors: [v],
      brands: [],
      stores: [],
      vendorPermissions: GRANTED,
    }) as Plan;
    expect(plan.actions![0]).toMatchObject({
      op: 'update',
      id: 'uuid-test',
      data: { status: 'active' },
    });
    expect(plan.actions![1]!.data).toMatchObject({ vendor: 'uuid-test' });
  });

  it('REFUSES to adopt a real (non-mock) vendor holding test-1 or the test key', () => {
    for (const real of [
      { id: 'x', name: 'Real', platform: 'yiji', yiji_vendor_id: 'test-1' },
      { id: 'x', name: 'Real', platform: null, yiji_vendor_id: '9', webhook_path_key: 'test' },
    ]) {
      const plan = planSeed({
        vendors: [real],
        brands: [],
        stores: [],
        vendorPermissions: GRANTED,
      }) as Plan;
      expect(plan.refuse).toMatch(/NOT a mock vendor/);
    }
  });

  it('REFUSES while either registry cannot read vendors.platform (it would take the vendor for Yiji)', () => {
    const plan = planSeed({
      vendors: [],
      brands: [],
      stores: [],
      vendorPermissions: [
        GRANTED[0],
        { fields: ['id', 'name'], policy: { name: 'svc-workers policy' } },
      ],
    }) as Plan;
    expect(plan.refuse).toMatch(/svc-workers.*platform/);
  });

  it('refuses a TV- brand owned by another vendor', () => {
    const v = { id: 'uuid-test', ...TEST_VENDOR };
    const plan = planSeed({
      vendors: [v],
      brands: [{ id: 'b1', code: 'TV-MOCK', vendor: 'uuid-yiji' }],
      stores: [],
      vendorPermissions: GRANTED,
    }) as Plan;
    expect(plan.refuse).toMatch(/another vendor/);
  });

  it('resolveRefs swaps placeholders for created ids', () => {
    expect(
      resolveRefs(
        { vendor: '$vendor', brand: '$brand:TV-MOCK', name: 'x' },
        { $vendor: 'v1', '$brand:TV-MOCK': 'b1' },
      ),
    ).toEqual({
      vendor: 'v1',
      brand: 'b1',
      name: 'x',
    });
  });
});

describe('planRemove (--remove)', () => {
  it('deletes every vendor-scoped row first, the vendor last', () => {
    const v = { id: 'uuid-test', ...TEST_VENDOR };
    const plan = planRemove({
      vendors: [yiji, v],
      rowsByCollection: { coupon_approvals: ['c1'], stores: ['s1', 's2'], contacts: ['k1'] },
    }) as Plan;
    expect(plan.actions!.map((a) => a.collection)).toEqual([
      'coupon_approvals',
      'stores',
      'contacts',
      'vendors',
    ]);
    expect(plan.actions!.at(-1)!.ids).toEqual(['uuid-test']);
  });

  it('nothing to do without a test vendor; refuses a non-mock holder of test-1', () => {
    expect((planRemove({ vendors: [yiji], rowsByCollection: {} }) as Plan).actions).toEqual([]);
    const plan = planRemove({
      vendors: [{ id: 'x', name: 'Real', platform: 'yiji', yiji_vendor_id: 'test-1' }],
      rowsByCollection: {},
    }) as Plan;
    expect(plan.refuse).toMatch(/NOT mock/);
  });

  it('covers EVERY table with a vendor column, so nothing falls back to "legacy Yiji" or "every vendor"', () => {
    const vendorTables = new Set([
      ...VENDOR_RECORD_COLLECTIONS,
      ...VENDOR_SHARED_CONFIG_COLLECTIONS,
      ...relations.filter((r) => r.related === 'vendors').map((r) => r.collection),
    ]);
    for (const t of vendorTables) expect(REMOVE_ORDER, t).toContain(t);
  });
});
