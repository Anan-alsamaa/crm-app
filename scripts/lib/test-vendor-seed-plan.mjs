/**
 * The PURE half of scripts/seed-test-vendor.mjs (MV-6, EMA-75): given what the
 * staging database holds, decide what to write. No I/O, so it is tested
 * (packages/shared-types/tests/test-vendor-seed.test.ts).
 *
 * Rules it enforces:
 *  - STAGING ONLY. The API host must be exactly crm-api-staging.anan.sa.
 *  - IDEMPOTENT. Rows are found by their natural keys (vendor by
 *    yiji_vendor_id, brands by code, stores by code) and only what is missing
 *    or different is written; a second run plans nothing.
 *  - NEVER ADOPTS A REAL VENDOR. A vendor already holding `test-1` or the
 *    `test` webhook key that is not on the `mock` platform is refused — it is
 *    somebody's real vendor and must not become a mock.
 *  - SAFE ORDER. Only once the two connector registries can read
 *    `vendors.platform` (MV-6 deployed + permission applied): before that, a
 *    service reads the vendor without its platform, takes it for YIJI, and
 *    would send its lookups and coupons to Yiji's production API.
 *  - --remove deletes EVERY record of the vendor before the vendor itself.
 *    Deleting the vendor alone would SET NULL on coupon_approvals & co, and a
 *    NULL vendor means "legacy Yiji" — an approved test coupon would then be
 *    pushed to real Yiji by the delivery sweep, and a vendor-scoped quick
 *    reply / SLA policy would start applying to EVERY vendor.
 */

export const STAGING_API_HOST = 'crm-api-staging.anan.sa';

export const TEST_VENDOR = Object.freeze({
  name: 'Test Vendor',
  platform: 'mock',
  yiji_vendor_id: 'test-1',
  webhook_path_key: 'test',
  status: 'active',
  colors: { primary: '#0E7C66', secondary: '#F2B705' },
});

/** Brand/store codes all start `TV-`, so nothing collides with real master data. */
export const TEST_BRANDS = Object.freeze([
  {
    code: 'TV-MOCK',
    name: 'Test Vendor Kitchen',
    yiji_brand_name: 'Test Vendor Kitchen',
    status: 'active',
  },
]);

/** `yiji_restaurant_id` = the MockConnector's restaurant ids, so mock orders map to these stores. */
export const TEST_STORES = Object.freeze([
  {
    code: 'TV-001',
    name: 'Mock Kitchen - Olaya',
    city: 'Riyadh',
    yiji_restaurant_id: 'mock-store-1',
    status: 'active',
    brandCode: 'TV-MOCK',
  },
  {
    code: 'TV-002',
    name: 'Mock Kitchen - Malqa',
    city: 'Riyadh',
    yiji_restaurant_id: 'mock-store-2',
    status: 'active',
    brandCode: 'TV-MOCK',
  },
]);

/**
 * Collections deleted by vendor on --remove, CHILDREN FIRST. Every
 * vendor-scoped table (VENDOR_RECORD_COLLECTIONS + VENDOR_SHARED_CONFIG_COLLECTIONS
 * in directus/bootstrap/src/collections.ts, plus the CASCADE ones), so nothing
 * is left to be orphaned into "legacy Yiji" or "every vendor".
 */
export const REMOVE_ORDER = [
  'coupon_approvals',
  'late_order_decisions',
  'store_notifications',
  'store_notify_rules',
  'quick_replies',
  'sla_policies',
  'stores',
  'brands',
  'tickets',
  'walk_in_links',
  'conversations',
  'contacts',
];

/** Throws unless `api` is the staging Directus. */
export function assertStagingApi(api) {
  let host = '';
  try {
    host = new URL(String(api ?? '')).host.toLowerCase();
  } catch {
    /* fall through */
  }
  if (host !== STAGING_API_HOST) {
    throw new Error(
      `refusing: API host is "${host || api}", not ${STAGING_API_HOST}. The test vendor is staging-only.`,
    );
  }
}

const idOf = (v) => (v && typeof v === 'object' ? (v.id ?? null) : (v ?? null));
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The fields of `want` that differ on `have`. */
function drift(have, want) {
  const out = {};
  for (const [k, v] of Object.entries(want)) if (!same(have?.[k], v)) out[k] = v;
  return out;
}

/** Do both registries' policies let them read `vendors.platform`? */
export function platformReadableByServices(permissionRows) {
  const missing = [];
  for (const svc of ['svc-ai-gateway', 'svc-workers']) {
    const row = (permissionRows ?? []).find((p) => String(p?.policy?.name ?? '').includes(svc));
    const f = row?.fields ?? [];
    if (!(f.includes('*') || f.includes('platform'))) missing.push(svc);
  }
  return missing;
}

/**
 * What --write would do.
 *
 * @param {{
 *   vendors: Array<Record<string, unknown>>,   // every vendors row (id, name, platform, yiji_vendor_id, webhook_path_key, status, colors)
 *   brands: Array<Record<string, unknown>>,    // brands with code TV-* (id, code, name, yiji_brand_name, status, vendor)
 *   stores: Array<Record<string, unknown>>,    // stores with code TV-* (id, code, ..., brand, vendor)
 *   vendorPermissions: Array<Record<string, unknown>>, // vendors read permissions (fields, policy.name)
 * }} state
 * @returns {{ refuse: string } | { actions: Array<{ op: string, collection: string, id?: string, key: string, data?: object }> }}
 */
export function planSeed({ vendors, brands, stores, vendorPermissions }) {
  const missing = platformReadableByServices(vendorPermissions);
  if (missing.length) {
    return {
      refuse:
        `the vendors read of ${missing.join(' and ')} does not include \`platform\`: ` +
        'that service would take the test vendor for YIJI. Deploy MV-6 and apply the ' +
        'permission first (see docs/MULTI-VENDOR.md).',
    };
  }
  const byId = (vendors ?? []).find((v) => v.yiji_vendor_id === TEST_VENDOR.yiji_vendor_id);
  const byKey = (vendors ?? []).find((v) => v.webhook_path_key === TEST_VENDOR.webhook_path_key);
  for (const v of [byId, byKey]) {
    if (v && (v.platform ?? 'yiji') !== 'mock') {
      return {
        refuse: `vendor "${v.name}" (${v.id}) already holds ${v === byId ? `yiji_vendor_id ${TEST_VENDOR.yiji_vendor_id}` : `webhook key "${TEST_VENDOR.webhook_path_key}"`} and is NOT a mock vendor - refusing to touch a real vendor`,
      };
    }
  }
  if (byId && byKey && byId.id !== byKey.id) {
    return {
      refuse: 'test-1 and webhook key "test" belong to two different vendors - fix by hand',
    };
  }

  const actions = [];
  const VENDOR_REF = '$vendor';
  const vendor = byId ?? byKey ?? null;
  const vendorRef = vendor?.id ?? VENDOR_REF;
  if (!vendor) {
    actions.push({
      op: 'create',
      collection: 'vendors',
      key: TEST_VENDOR.yiji_vendor_id,
      data: { ...TEST_VENDOR },
    });
  } else {
    const d = drift(vendor, TEST_VENDOR);
    if (Object.keys(d).length) {
      actions.push({
        op: 'update',
        collection: 'vendors',
        id: vendor.id,
        key: TEST_VENDOR.yiji_vendor_id,
        data: d,
      });
    }
  }

  const brandRef = {};
  for (const want of TEST_BRANDS) {
    const have = (brands ?? []).find((b) => b.code === want.code);
    if (have && vendor && idOf(have.vendor) && idOf(have.vendor) !== vendor.id) {
      return { refuse: `brand ${want.code} belongs to another vendor - refusing` };
    }
    const data = { ...want, vendor: vendorRef };
    if (!have) {
      actions.push({ op: 'create', collection: 'brands', key: want.code, data });
      brandRef[want.code] = `$brand:${want.code}`;
    } else {
      brandRef[want.code] = have.id;
      const d = drift({ ...have, vendor: idOf(have.vendor) }, data);
      if (Object.keys(d).length)
        actions.push({ op: 'update', collection: 'brands', id: have.id, key: want.code, data: d });
    }
  }

  for (const { brandCode, ...want } of TEST_STORES) {
    const have = (stores ?? []).find((s) => s.code === want.code);
    if (have && vendor && idOf(have.vendor) && idOf(have.vendor) !== vendor.id) {
      return { refuse: `store ${want.code} belongs to another vendor - refusing` };
    }
    const data = { ...want, vendor: vendorRef, brand: brandRef[brandCode] };
    if (!have) {
      actions.push({ op: 'create', collection: 'stores', key: want.code, data });
    } else {
      const d = drift({ ...have, vendor: idOf(have.vendor), brand: idOf(have.brand) }, data);
      if (Object.keys(d).length)
        actions.push({ op: 'update', collection: 'stores', id: have.id, key: want.code, data: d });
    }
  }
  return { actions };
}

/**
 * What --remove would do: every row of the TEST vendor, children first, then
 * the vendor. `rowsByCollection[c]` = ids of rows in `c` whose vendor is it.
 */
export function planRemove({ vendors, rowsByCollection }) {
  const v = (vendors ?? []).find((x) => x.yiji_vendor_id === TEST_VENDOR.yiji_vendor_id);
  if (!v) return { actions: [] };
  if ((v.platform ?? 'yiji') !== 'mock') {
    return {
      refuse: `vendor ${v.name} holds ${TEST_VENDOR.yiji_vendor_id} but is NOT mock - refusing to delete it`,
    };
  }
  const actions = [];
  for (const c of REMOVE_ORDER) {
    const ids = rowsByCollection?.[c] ?? [];
    if (ids.length)
      actions.push({ op: 'delete', collection: c, ids: [...ids], key: `${ids.length} rows` });
  }
  actions.push({ op: 'delete', collection: 'vendors', ids: [v.id], key: v.name });
  return { actions, vendorId: v.id };
}

/** Swap the `$vendor` / `$brand:<code>` placeholders for ids created earlier in the run. */
export function resolveRefs(data, refs) {
  const out = {};
  for (const [k, val] of Object.entries(data ?? {})) {
    out[k] = typeof val === 'string' && val.startsWith('$') && val in refs ? refs[val] : val;
  }
  return out;
}
