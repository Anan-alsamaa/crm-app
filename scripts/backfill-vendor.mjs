#!/usr/bin/env node
/**
 * MV-1 (EMA-70): give every pre-MV-1 record its vendor, and the Yiji vendor
 * its known integration settings.
 *
 * Sets `vendor` = the SINGLE active vendor on every row of coupon_approvals,
 * late_order_decisions, store_notifications, store_notify_rules, brands and
 * stores where it is NULL. Rows that already name a vendor are never touched.
 * REFUSES when more than one vendor is active: a NULL row cannot then be
 * attributed without guessing. quick_replies and sla_policies are NOT
 * backfilled - there NULL means "every vendor".
 *
 * Fills ONLY BLANK vendor settings: platform 'yiji', webhook_path_key 'yiji',
 * api_base_url https://order.yiji-app.com, admin_api_url
 * https://admin.yiji-app.com, and tenant_id / brand_id ONLY when passed - they
 * are never guessed. No secret is written anywhere (MV-3).
 *
 * PREREQUISITE: the MV-1 schema is applied (vendors.* settings and the
 * `vendor` fields). The script stops at the first missing field.
 *
 * Usage (dry run by default - prints counts, writes nothing):
 *   API=https://crm-api-staging.anan.sa ADMIN_EMAIL=… ADMIN_PASSWORD=… \
 *     node scripts/backfill-vendor.mjs [--tenant-id=1] [--brand-id=1]
 *   … --write      # apply
 */
import { planVendorBackfill, BACKFILL_TABLES } from './lib/vendor-backfill-plan.mjs';

const API = (process.env.API ?? '').replace(/\/$/, '');
if (!API || !process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
  console.error('set API, ADMIN_EMAIL, ADMIN_PASSWORD');
  process.exit(2);
}
const WRITE = process.argv.includes('--write');
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const CHUNK = 200;

async function api(path, init = {}, token) {
  const res = await fetch(API + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = body?.errors?.[0]?.message ?? String(text).slice(0, 300);
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status}: ${msg}`);
  }
  return body;
}

const login = await api('/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
});
const token = login?.data?.access_token;
if (!token) {
  console.error('login failed');
  process.exit(1);
}

const vendorFields = [
  'id',
  'name',
  'yiji_vendor_id',
  'status',
  'platform',
  'api_base_url',
  'admin_api_url',
  'tenant_id',
  'brand_id',
  'webhook_path_key',
].join(',');
const vendors = (await api(`/items/vendors?limit=-1&fields=${vendorFields}`, {}, token)).data;

const rowsByTable = {};
for (const table of BACKFILL_TABLES) {
  rowsByTable[table] = (await api(`/items/${table}?limit=-1&fields=id,vendor`, {}, token)).data;
}

const plan = planVendorBackfill({
  vendors,
  rowsByTable,
  tenantId: arg('tenant-id'),
  brandId: arg('brand-id'),
});
if ('refuse' in plan) {
  console.error(`REFUSED: ${plan.refuse}`);
  process.exit(1);
}

console.log(`API     : ${API}`);
console.log(
  `vendor  : ${plan.vendor.name ?? '?'} (id ${plan.vendor.id}, yiji_vendor_id ${plan.vendor.yiji_vendor_id ?? '?'})`,
);
console.log('');
console.log('table                  total  already  to set');
for (const t of plan.tables) {
  console.log(
    `${t.table.padEnd(22)} ${String(t.total).padStart(5)}  ${String(t.alreadySet).padStart(7)}  ${String(t.toSet.length).padStart(6)}`,
  );
}
console.log('');
const settingKeys = Object.keys(plan.settings);
console.log(
  settingKeys.length
    ? `vendor settings to fill (blank today): ${settingKeys.map((k) => `${k}=${plan.settings[k]}`).join(', ')}`
    : 'vendor settings: nothing blank to fill',
);
if (!arg('tenant-id') || !arg('brand-id')) {
  console.log('(tenant_id / brand_id are filled only when passed: --tenant-id=… --brand-id=…)');
}

const totalToSet = plan.tables.reduce((n, t) => n + t.toSet.length, 0);
if (!WRITE) {
  console.log(
    `\nDRY RUN - nothing written (${totalToSet} rows would change). Re-run with --write.`,
  );
  process.exit(0);
}

let failed = 0;
for (const t of plan.tables) {
  for (let i = 0; i < t.toSet.length; i += CHUNK) {
    const keys = t.toSet.slice(i, i + CHUNK);
    try {
      /* Body, not a URL filter: a few hundred ids in a query string is a
         CloudFront 414 before Directus sees it. */
      await api(
        `/items/${t.table}`,
        { method: 'PATCH', body: JSON.stringify({ keys, data: { vendor: plan.vendor.id } }) },
        token,
      );
    } catch (err) {
      failed += keys.length;
      console.error(`  ${t.table}: ${err.message}`);
    }
  }
  if (t.toSet.length) console.log(`  ${t.table}: ${t.toSet.length} set`);
}
if (settingKeys.length) {
  await api(
    `/items/vendors/${plan.vendor.id}`,
    { method: 'PATCH', body: JSON.stringify(plan.settings) },
    token,
  );
  console.log(`  vendors: ${settingKeys.join(', ')} filled`);
}
console.log(failed ? `\nDONE with ${failed} rows FAILED - re-run (idempotent).` : '\nDONE.');
process.exit(failed ? 1 : 0);
