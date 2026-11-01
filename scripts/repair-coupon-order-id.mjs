#!/usr/bin/env node
/**
 * ONE-OFF REPAIR: put the ORDER ID back on the customer's coupon on Yiji.
 *
 * Owner, 2026-11-01: "coupon associated with an order must contain the order
 * id too". Since coupons are granted by phone (2026-10-11) the AddUserCoupon
 * attach went without one, so customers' coupons on Yiji hold no orderId
 * although the CRM knows it. The fix for new coupons is in coupon-push.ts;
 * this fills the existing ones IN PLACE.
 *
 * Owner rule (same day): modify the EXISTING coupon only - never create a new
 * one, never remove and re-issue, creation dates untouched.
 *
 * Per coupon: read the customer's coupon (GET /api/CouponUser/GetUserCoupon/id/
 * {yiji_coupon_user_id}), confirm the code matches EXACTLY, and only when its
 * orderId is EMPTY send it back with the CRM's order id via
 * PATCH /api/CouponUser/UpdateUserCoupon. Re-read, and flag ANY other field
 * that moved (dates included). An orderId already there is never changed.
 * Only a real order number is used ("N/A", "0", "0_79" are skipped).
 *
 * Write access: the owner's admin login in the git-ignored `.env.yiji-admin`.
 *
 *   E=… P=… node scripts/repair-coupon-order-id.mjs           # dry run
 *   E=… P=… node scripts/repair-coupon-order-id.mjs --one     # one, verified
 *   E=… P=… node scripts/repair-coupon-order-id.mjs --write   # all, paced, each verified
 */
import fs from 'node:fs';
import path from 'node:path';

const WRITE = process.argv.includes('--write');
const ONE = process.argv.includes('--one');
const A = 'https://admin.yiji-app.com';
const API = process.env.API ?? 'https://crm-api.anan.sa';
const DELAY = Number(process.env.DELAY_MS ?? 1500);
const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')),
  '..',
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tok = fs
  .readFileSync(path.join(ROOT, '.env.yiji-admin'), 'utf8')
  .split(/\r?\n/)
  .find((l) => l.startsWith('YIJI_UPDATE_TOKEN='))
  ?.split('=')
  .slice(1)
  .join('=')
  .trim()
  .replace(/^["']|["']$/g, '')
  .replace(/^Bearer\s+/i, '');
if (!tok) {
  console.error('no YIJI_UPDATE_TOKEN in .env.yiji-admin');
  process.exit(2);
}
const yget = async (url) => {
  const r = await fetch(url, { headers: { authorization: `Bearer ${tok}` } });
  if (r.status !== 200) throw new Error(`GET ${url.replace(A, '')} -> HTTP ${r.status}`);
  return r.json();
};

// ── the CRM side ────────────────────────────────────────────────────────────
const crmToken = (
  await (
    await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: process.env.E, password: process.env.P }),
    })
  ).json()
)?.data?.access_token;
if (!crmToken) throw new Error('CRM login failed (set E and P)');
const rows = (
  await (
    await fetch(
      `${API}/items/coupon_approvals?${new URLSearchParams({
        filter: JSON.stringify({ yiji_coupon_user_id: { _nnull: true } }),
        fields: 'coupon_code,yiji_coupon_user_id,order_id,ticket.order_id',
        limit: '-1',
      })}`,
      { headers: { authorization: `Bearer ${crmToken}` } },
    )
  ).json()
).data;

const realOrder = (v) => {
  const n = Number(String(v ?? '').trim());
  return Number.isInteger(n) && n > 0 ? n : null;
};

const report = {
  withOrder: 0,
  alreadySet: 0,
  differs: [],
  noOrder: 0,
  mismatch: [],
  unreadable: [],
};
let fixed = 0;
let failed = 0;
for (const row of rows) {
  const want = realOrder(row.ticket?.order_id ?? row.order_id);
  if (!want) {
    report.noOrder += 1;
    continue;
  }
  report.withOrder += 1;
  if (DELAY) await sleep(DELAY);
  let cu;
  try {
    cu = await yget(`${A}/api/CouponUser/GetUserCoupon/id/${row.yiji_coupon_user_id}`);
  } catch (err) {
    report.unreadable.push(`${row.coupon_code} (${err.message})`);
    continue;
  }
  const code = cu?.couponCode ?? cu?.coupon?.code;
  if (code !== row.coupon_code) {
    report.mismatch.push(`${row.coupon_code} -> Yiji #${row.yiji_coupon_user_id} is ${code}`);
    continue;
  }
  if (cu.orderId) {
    if (Number(cu.orderId) === want) report.alreadySet += 1;
    else report.differs.push(`${row.coupon_code}: Yiji ${cu.orderId}, CRM ${want} (left as is)`);
    continue;
  }
  if (!WRITE && !(ONE && fixed === 0)) {
    console.log(`would set ${row.coupon_code} (#${cu.id}) orderId -> ${want}`);
    continue;
  }
  try {
    const r = await fetch(`${A}/api/CouponUser/UpdateUserCoupon`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...cu, orderId: want }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`UpdateUserCoupon -> HTTP ${r.status} ${text.slice(0, 200)}`);
    try {
      const j = JSON.parse(text);
      if (j && j.result !== undefined && Number(j.result) !== 1)
        throw new Error(`Yiji said result ${j.result}: ${j.exceptionMessage ?? ''}`);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Yiji said')) throw e;
    }
    const after = await yget(`${A}/api/CouponUser/GetUserCoupon/id/${row.yiji_coupon_user_id}`);
    if (Number(after.orderId) !== want) throw new Error(`re-read shows orderId ${after.orderId}`);
    const moved = [];
    const cmp = (a, b, p) => {
      if (a && typeof a === 'object' && b && typeof b === 'object') {
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
          cmp(a[k], b[k], p ? `${p}.${k}` : k);
      } else if (JSON.stringify(a) !== JSON.stringify(b) && p !== 'orderId') moved.push(p);
    };
    cmp(cu, after, '');
    console.log(
      `fixed ${row.coupon_code} (#${cu.id}) orderId -> ${want}${moved.length ? `  WARNING other fields differ: ${moved.join(',')}` : ''}`,
    );
    fixed += 1;
    if (ONE) break;
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${row.coupon_code} (#${cu.id}): ${err.message}`);
    if (ONE) break;
  }
}

console.log(`\nCRM coupons held by a customer on Yiji: ${rows.length}`);
console.log(
  `with a real order number in the CRM: ${report.withOrder} (none/placeholder: ${report.noOrder})`,
);
console.log(`Yiji already holds the same orderId: ${report.alreadySet}`);
if (report.differs.length)
  console.log(`Yiji holds a DIFFERENT orderId (not changed): ${report.differs.join('; ')}`);
if (report.mismatch.length)
  console.log(`code does not match (not changed): ${report.mismatch.join('; ')}`);
if (report.unreadable.length) console.log(`could not be read: ${report.unreadable.join('; ')}`);
console.log(WRITE || ONE ? `\n${fixed} fixed, ${failed} failed` : '\ndry run - nothing changed');
process.exit(failed ? 1 : 0);
