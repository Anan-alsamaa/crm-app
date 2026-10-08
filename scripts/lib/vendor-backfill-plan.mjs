/**
 * The PURE half of scripts/backfill-vendor.mjs (MV-1, EMA-70): given what the
 * database holds, decide what to write. No I/O here, so it is tested
 * (packages/shared-types/tests/vendor-backfill-plan.test.ts).
 *
 * Two rules it exists to enforce:
 *  - ONE active vendor, or nothing at all. With two, a NULL row cannot be
 *    attributed, and a wrong attribution would file one vendor's coupons and
 *    branches under another. The script REFUSES rather than guesses.
 *  - ONLY NULLs. A row that already names a vendor was written by MV-1 code
 *    (or by a human) and is never touched; a setting that already has a value
 *    is the owner's and is never overwritten.
 */

/**
 * Tables whose NULL vendor means "pre-MV-1 = the Yiji vendor". Mirrors
 * VENDOR_RECORD_COLLECTIONS in directus/bootstrap/src/collections.ts.
 * `quick_replies` and `sla_policies` are deliberately absent: there NULL means
 * "applies to every vendor".
 */
export const BACKFILL_TABLES = [
  'coupon_approvals',
  'late_order_decisions',
  'store_notifications',
  'store_notify_rules',
  'brands',
  'stores',
];

/** The Yiji vendor's known, NON-SECRET integration settings. */
export const YIJI_KNOWN_SETTINGS = {
  platform: 'yiji',
  webhook_path_key: 'yiji',
  api_base_url: 'https://order.yiji-app.com',
  admin_api_url: 'https://admin.yiji-app.com',
};

const blank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const isActive = (v) => (v.status ?? 'active') === 'active';
/** A row's vendor id, whether Directus returned it bare or expanded. */
const vendorOf = (row) =>
  row.vendor && typeof row.vendor === 'object' ? (row.vendor.id ?? null) : (row.vendor ?? null);

/**
 * Decide the backfill.
 *
 * @param {object} input
 * @param {Array<Record<string, unknown>>} input.vendors - every `vendors` row
 * @param {Record<string, Array<{id: string, vendor?: unknown}>>} input.rowsByTable
 * @param {string} [input.tenantId] - only when passed explicitly; never guessed
 * @param {string} [input.brandId] - only when passed explicitly; never guessed
 * @returns {{ refuse: string } | {
 *   vendor: { id: string, name?: string, yiji_vendor_id?: string },
 *   tables: Array<{ table: string, total: number, alreadySet: number, toSet: string[] }>,
 *   settings: Record<string, string>,
 * }}
 */
export function planVendorBackfill({ vendors, rowsByTable, tenantId, brandId }) {
  const active = (vendors ?? []).filter(isActive);
  if (active.length === 0) return { refuse: 'no active vendor - nothing to attribute rows to' };
  if (active.length > 1) {
    return {
      refuse:
        `${active.length} active vendors (${active.map((v) => v.name ?? v.id).join(', ')}) - ` +
        'a NULL row cannot be attributed without guessing. Backfill refused.',
    };
  }
  const vendor = active[0];
  if (!blank(vendor.platform) && vendor.platform !== 'yiji') {
    return {
      refuse: `the single active vendor is on platform "${vendor.platform}", not yiji - legacy rows are Yiji's`,
    };
  }

  const tables = BACKFILL_TABLES.map((table) => {
    const rows = rowsByTable?.[table] ?? [];
    const toSet = rows.filter((r) => blank(vendorOf(r))).map((r) => r.id);
    return { table, total: rows.length, alreadySet: rows.length - toSet.length, toSet };
  });

  const wanted = { ...YIJI_KNOWN_SETTINGS };
  if (!blank(tenantId)) wanted.tenant_id = String(tenantId).trim();
  if (!blank(brandId)) wanted.brand_id = String(brandId).trim();
  const settings = {};
  for (const [k, v] of Object.entries(wanted)) if (blank(vendor[k])) settings[k] = v;

  return {
    vendor: { id: vendor.id, name: vendor.name, yiji_vendor_id: vendor.yiji_vendor_id },
    tables,
    settings,
  };
}
