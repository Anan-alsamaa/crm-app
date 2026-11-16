#!/usr/bin/env node
/**
 * CREATE THE YIJI V2 VENDOR ROW - INACTIVE (owner, 2026-11-16).
 *
 * Idempotently creates vendor "Yiji V2" on the `yiji2` platform
 * (yiji_vendor_id `2`, webhook key `yiji2`, placeholder API host,
 * status INACTIVE) so Yiji v2 is wired as a second tenant without serving a
 * single request: the registry refuses an inactive vendor, the inbound API
 * answers 503, the tenant filter stays hidden until the owner activates it on
 * the Vendors page (staging first, then production on the owner's word).
 *
 * NEVER activates, NEVER deletes, NEVER touches the Yiji (v1) row, NEVER
 * writes a credential (the row holds none; see docs/YIJI-V2-TENANT.md for the
 * VENDOR_YIJI2_* names).
 *
 * DRY RUN by default; `--write` applies. Local and staging hosts by default;
 * production needs `--allow-prod`.
 *
 * Usage:
 *   API=https://crm-api-staging.anan.sa ADMIN_EMAIL=… ADMIN_PASSWORD=… \
 *     node scripts/seed-yiji2-vendor.mjs [--write] [--allow-prod]
 */
import {
  YIJI2_VENDOR,
  assertAllowedApi,
  planYiji2Seed,
  yiji2EnvNames,
} from './lib/yiji2-vendor-seed-plan.mjs';

const API = (process.env.API ?? 'http://localhost:8092').replace(/\/$/, '');
const WRITE = process.argv.includes('--write');
const ALLOW_PROD = process.argv.includes('--allow-prod');

try {
  assertAllowedApi(API, { allowProd: ALLOW_PROD });
} catch (err) {
  console.error(err.message);
  process.exit(2);
}
if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
  console.error('set ADMIN_EMAIL and ADMIN_PASSWORD (an Administrator)');
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
  if (!res.ok) {
    throw new Error(
      `${method} ${path}: HTTP ${res.status} ${JSON.stringify(j.errors ?? j).slice(0, 300)}`,
    );
  }
  return j.data;
}

const vendors = await call(
  'GET',
  `/items/vendors?${new URLSearchParams({
    limit: '-1',
    fields: 'id,name,platform,yiji_vendor_id,webhook_path_key,api_base_url,status,colors',
  })}`,
);

const plan = planYiji2Seed({ vendors });
if ('refuse' in plan) {
  console.error(`REFUSED: ${plan.refuse}`);
  process.exit(1);
}
for (const a of plan.actions) {
  console.log(`${a.op.padEnd(7)} ${a.collection.padEnd(8)} ${a.key}  ${a.note ?? ''}`);
  if (a.data) console.log(`        ${JSON.stringify(a.data)}`);
}
console.log('\nEnvironment variable NAMES the deployment needs (values never in the repo):');
for (const [svc, names] of Object.entries(yiji2EnvNames(YIJI2_VENDOR.webhook_path_key))) {
  console.log(`  ${svc.padEnd(15)} ${names.join(', ')}`);
}
if (!WRITE) {
  console.log('\nDRY RUN - nothing written. Re-run with --write.');
  process.exit(0);
}
for (const a of plan.actions) {
  if (a.op === 'create') await call('POST', '/items/vendors', a.data);
  else if (a.op === 'update') await call('PATCH', `/items/vendors/${a.id}`, a.data);
}
console.log('done. The vendor is INACTIVE; the owner activates it on the Vendors page.');
