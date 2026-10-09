#!/usr/bin/env node
/**
 * SEED THE STAGING TEST VENDOR (MV-6, EMA-75).
 *
 * Creates — idempotently — vendor "Test Vendor" on the `mock` platform
 * (yiji_vendor_id `test-1`, webhook key `test`, active) plus one brand and two
 * stores for it, so multi-vendor can be exercised end to end on staging
 * without a real second vendor and without ever calling Yiji (the mock
 * connector makes no network calls; see docs/MULTI-VENDOR.md).
 *
 * STAGING ONLY: refuses unless API is https://crm-api-staging.anan.sa.
 * DRY RUN by default; `--write` applies; `--remove` deletes everything the
 * test vendor owns (every vendor-scoped table, children first) and then the
 * vendor (dry run unless `--write` too).
 *
 * Refuses to write until svc-ai-gateway and svc-workers may read
 * `vendors.platform` — before that they would take the test vendor for Yiji.
 *
 * Usage:
 *   API=https://crm-api-staging.anan.sa ADMIN_EMAIL=… ADMIN_PASSWORD=… \
 *     node scripts/seed-test-vendor.mjs [--write] [--remove]
 */
import {
  REMOVE_ORDER,
  TEST_VENDOR,
  assertStagingApi,
  planRemove,
  planSeed,
  resolveRefs,
} from './lib/test-vendor-seed-plan.mjs';

const API = (process.env.API ?? 'https://crm-api-staging.anan.sa').replace(/\/$/, '');
const WRITE = process.argv.includes('--write');
const REMOVE = process.argv.includes('--remove');

try {
  assertStagingApi(API);
} catch (err) {
  console.error(err.message);
  process.exit(2);
}
if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
  console.error('set ADMIN_EMAIL and ADMIN_PASSWORD (a staging Administrator)');
  process.exit(2);
}

const login = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
}).then((r) => r.json());
const token = login?.data?.access_token;
if (!token) {
  console.error('could not sign in');
  process.exit(1);
}
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: H,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 204) return null;
  const j = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(
      `${method} ${path}: HTTP ${res.status} ${JSON.stringify(j.errors ?? j).slice(0, 300)}`,
    );
  return j.data;
}
const get = (collection, params) =>
  call('GET', `/items/${collection}?${new URLSearchParams({ limit: '-1', ...params })}`);

const vendors = await get('vendors', {
  fields: 'id,name,platform,yiji_vendor_id,webhook_path_key,status,colors',
});

if (REMOVE) {
  const v = vendors.find((x) => x.yiji_vendor_id === TEST_VENDOR.yiji_vendor_id);
  const rowsByCollection = {};
  if (v) {
    for (const c of REMOVE_ORDER) {
      const rows = await get(c, {
        fields: 'id',
        filter: JSON.stringify({ vendor: { _eq: v.id } }),
      });
      rowsByCollection[c] = rows.map((r) => r.id);
    }
  }
  const plan = planRemove({ vendors, rowsByCollection });
  if ('refuse' in plan) {
    console.error(`REFUSED: ${plan.refuse}`);
    process.exit(1);
  }
  if (!plan.actions.length) console.log('nothing to remove: no test vendor');
  for (const a of plan.actions) console.log(`delete ${a.collection.padEnd(22)} ${a.key}`);
  if (!WRITE) {
    console.log('\nDRY RUN - nothing deleted. Re-run with --remove --write.');
    process.exit(0);
  }
  for (const a of plan.actions) {
    for (let i = 0; i < a.ids.length; i += 100) {
      await call('DELETE', `/items/${a.collection}`, a.ids.slice(i, i + 100));
    }
  }
  console.log('removed.');
  process.exit(0);
}

const brands = await get('brands', {
  fields: 'id,code,name,yiji_brand_name,status,vendor',
  filter: JSON.stringify({ code: { _starts_with: 'TV-' } }),
});
const stores = await get('stores', {
  fields: 'id,code,name,city,yiji_restaurant_id,status,brand,vendor',
  filter: JSON.stringify({ code: { _starts_with: 'TV-' } }),
});
const vendorPermissions = await call(
  'GET',
  `/permissions?${new URLSearchParams({
    fields: 'fields,policy.name',
    filter: JSON.stringify({ collection: { _eq: 'vendors' }, action: { _eq: 'read' } }),
    limit: '-1',
  })}`,
);

const plan = planSeed({ vendors, brands, stores, vendorPermissions });
if ('refuse' in plan) {
  console.error(`REFUSED: ${plan.refuse}`);
  process.exit(1);
}
if (!plan.actions.length) console.log('up to date: nothing to write');
for (const a of plan.actions) {
  console.log(`${a.op.padEnd(6)} ${a.collection.padEnd(8)} ${a.key}  ${JSON.stringify(a.data)}`);
}
if (!WRITE) {
  console.log('\nDRY RUN - nothing written. Re-run with --write.');
  process.exit(0);
}
const refs = {};
for (const a of plan.actions) {
  const data = resolveRefs(a.data, refs);
  if (a.op === 'create') {
    const made = await call('POST', `/items/${a.collection}`, data);
    if (a.collection === 'vendors') refs.$vendor = made.id;
    if (a.collection === 'brands') refs[`$brand:${a.key}`] = made.id;
  } else {
    await call('PATCH', `/items/${a.collection}/${a.id}`, data);
  }
}
console.log('done.');
