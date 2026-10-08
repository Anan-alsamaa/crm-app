import { describe, expect, it } from 'vitest';
// The pure planner behind scripts/backfill-vendor.mjs (MV-1, EMA-70).
import {
  BACKFILL_TABLES,
  planVendorBackfill,
  YIJI_KNOWN_SETTINGS,
} from '../../../scripts/lib/vendor-backfill-plan.mjs';
import { VENDOR_RECORD_COLLECTIONS } from '../../../directus/bootstrap/src/collections.js';

const yiji = { id: 'uuid-yiji', name: 'Yiji', yiji_vendor_id: '1', status: 'active' };

describe('planVendorBackfill', () => {
  it('REFUSES when more than one vendor is active', () => {
    const plan = planVendorBackfill({
      vendors: [yiji, { id: 'uuid-2', name: 'Second', status: 'active' }],
      rowsByTable: { coupon_approvals: [{ id: 'c1', vendor: null }] },
    });
    expect(plan).toHaveProperty('refuse');
    expect((plan as { refuse: string }).refuse).toMatch(/2 active vendors/);
  });

  it('REFUSES with no active vendor', () => {
    expect(
      planVendorBackfill({ vendors: [{ ...yiji, status: 'inactive' }], rowsByTable: {} }),
    ).toHaveProperty('refuse');
  });

  it('ignores inactive vendors when picking the one', () => {
    const plan = planVendorBackfill({
      vendors: [yiji, { id: 'old', status: 'inactive' }],
      rowsByTable: {},
    });
    expect(plan).toMatchObject({ vendor: { id: 'uuid-yiji' } });
  });

  it('targets ONLY rows whose vendor is NULL', () => {
    const plan = planVendorBackfill({
      vendors: [yiji],
      rowsByTable: {
        coupon_approvals: [
          { id: 'c1', vendor: null },
          { id: 'c2', vendor: 'uuid-yiji' },
          { id: 'c3' },
          { id: 'c4', vendor: { id: 'someone-else' } },
        ],
        stores: [{ id: 's1', vendor: null }],
      },
    });
    if ('refuse' in plan) throw new Error(plan.refuse);
    const coupons = plan.tables.find((t) => t.table === 'coupon_approvals')!;
    expect(coupons).toEqual({
      table: 'coupon_approvals',
      total: 4,
      alreadySet: 2,
      toSet: ['c1', 'c3'],
    });
    expect(plan.tables.find((t) => t.table === 'stores')!.toSet).toEqual(['s1']);
    expect(plan.tables.find((t) => t.table === 'brands')!.toSet).toEqual([]);
  });

  it('fills only BLANK settings, and tenant/brand only when passed', () => {
    const fresh = planVendorBackfill({ vendors: [yiji], rowsByTable: {} });
    if ('refuse' in fresh) throw new Error(fresh.refuse);
    expect(fresh.settings).toEqual(YIJI_KNOWN_SETTINGS);
    expect(fresh.settings).not.toHaveProperty('tenant_id');

    const owned = planVendorBackfill({
      vendors: [{ ...yiji, api_base_url: 'https://custom', webhook_path_key: 'mine' }],
      rowsByTable: {},
      tenantId: '1',
      brandId: ' 7 ',
    });
    if ('refuse' in owned) throw new Error(owned.refuse);
    expect(owned.settings).toEqual({
      platform: 'yiji',
      admin_api_url: 'https://admin.yiji-app.com',
      tenant_id: '1',
      brand_id: '7',
    });
  });

  it('refuses a single vendor on another platform', () => {
    expect(
      planVendorBackfill({ vendors: [{ ...yiji, platform: 'other' }], rowsByTable: {} }),
    ).toHaveProperty('refuse');
  });

  it('covers exactly the schema’s record tables (shared config is never backfilled)', () => {
    expect([...BACKFILL_TABLES].sort()).toEqual([...VENDOR_RECORD_COLLECTIONS].sort());
    expect(BACKFILL_TABLES).not.toContain('quick_replies');
    expect(BACKFILL_TABLES).not.toContain('sla_policies');
  });
});
