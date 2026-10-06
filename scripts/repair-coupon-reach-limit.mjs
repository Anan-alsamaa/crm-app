#!/usr/bin/env node
/**
 * ONE-OFF REPAIR: raise `reachLimit` on CRM coupons Yiji still holds at 1.
 *
 * Before the 2026-10-03 fix (EMA-23) the CRM sent the per-customer "Number of
 * uses" as `reachLimit` — the TOTAL across all holders — so a 1-use coupon
 * had a pool of 1 and customers were refused with "Coupon exceeds usage
 * limit". Measured 2026-10-06: 88 delivered, unused, unexpired coupons still
 * carry reachLimit 1, 3, 10 or 16. New coupons get 10000 (EMA-45).
 *
 * WHAT IT DOES: for each affected coupon, READ it from Yiji, change ONLY
 * `reachLimit` to 10000, and send the same coupon back with
 * PATCH /api/Coupon/UpdateCoupon. Nothing is deleted, nothing is created,
 * no other field changes. Owner, 2026-10-06: never delete coupons.
 *
 * Our CRM account (role `agent 1`) is 403 on UpdateCoupon, so the WRITE uses
 * an admin login the owner provides in `.env.yiji-admin` (git-ignored, never
 * pasted in chat):
 *   YIJI_UPDATE_EMAIL=… and YIJI_UPDATE_PASSWORD=…   (preferred)
 *   or YIJI_UPDATE_TOKEN=…
 *
 *   node scripts/repair-coupon-reach-limit.mjs            # dry run, read-only
 *   node scripts/repair-coupon-reach-limit.mjs --one      # write ONE, then re-read it
 *   node scripts/repair-coupon-reach-limit.mjs --write    # write all, re-reading each
 *
 * Input: the scan written by the read-only coupon scan ($TEMP/coupon-scan.json:
 * [{code, couponId, reachLimit, isUsed, expires}]).
 */
import fs from 'node:fs';
import path from 'node:path';

const TARGET = 10000;
const WRITE = process.argv.includes('--write');
const ONE = process.argv.includes('--one');
const A = 'https://admin.yiji-app.com';
const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')),
  '..',
);

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [
        l.slice(0, l.indexOf('=')),
        l
          .slice(l.indexOf('=') + 1)
          .trim()
          .replace(/^["']|["']$/g, ''),
      ]),
  );
}

async function login(email, password) {
  const r = await fetch(`${A}/api/Account/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json().catch(() => null);
  if (!j?.token) throw new Error(`login failed (HTTP ${r.status})`);
  return j.token;
}

// READ token: the CRM's own account (can read coupons).
const crmEnv = JSON.parse(fs.readFileSync(path.join(process.env.TEMP, 'wenv.json'), 'utf8'));
const crm = Object.fromEntries(crmEnv.map((v) => [v.name, v.value]));
const readToken = await login(crm.YIJI_ADMIN_EMAIL, crm.YIJI_ADMIN_PASSWORD);

// WRITE token: only when writing.
let writeToken = null;
if (WRITE || ONE) {
  const adm = readEnvFile(path.join(ROOT, '.env.yiji-admin'));
  writeToken = adm.YIJI_UPDATE_TOKEN
    ? adm.YIJI_UPDATE_TOKEN.replace(/^Bearer\s+/i, '')
    : adm.YIJI_UPDATE_EMAIL
      ? await login(adm.YIJI_UPDATE_EMAIL, adm.YIJI_UPDATE_PASSWORD)
      : null;
  if (!writeToken) {
    console.error('no admin credentials in .env.yiji-admin — refusing to write');
    process.exit(2);
  }
}

const get = async (id) => {
  const r = await fetch(`${A}/api/Coupon/GetCoupon/id/${id}`, {
    headers: { authorization: `Bearer ${readToken}` },
  });
  if (r.status !== 200) throw new Error(`GetCoupon ${id} -> HTTP ${r.status}`);
  return r.json();
};

const scan = JSON.parse(fs.readFileSync(path.join(process.env.TEMP, 'coupon-scan.json'), 'utf8'));
const now = Date.now();
const targets = scan.filter(
  (c) =>
    c.couponId &&
    c.reachLimit !== null &&
    c.reachLimit < 1000 &&
    !c.isUsed &&
    (!c.expires || Date.parse(c.expires) > now),
);
console.log(`${targets.length} coupons to repair (reachLimit < 1000, unused, not expired)`);

let done = 0;
let failed = 0;
for (const t of ONE ? targets.slice(0, 1) : targets) {
  try {
    const coupon = await get(t.couponId);
    if (coupon.code !== t.code)
      throw new Error(`code mismatch on Yiji: ${coupon.code} != ${t.code}`);
    if (coupon.reachLimit >= 1000) {
      console.log(`skip ${t.code} (#${t.couponId}): already ${coupon.reachLimit}`);
      continue;
    }
    if (!WRITE && !ONE) {
      console.log(
        `would set ${t.code} (#${t.couponId}) reachLimit ${coupon.reachLimit} -> ${TARGET}`,
      );
      continue;
    }
    const body = { ...coupon, reachLimit: TARGET };
    const r = await fetch(`${A}/api/Coupon/UpdateCoupon`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${writeToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`UpdateCoupon -> HTTP ${r.status} ${text.slice(0, 200)}`);
    // Re-read: the coupon must now carry the new limit and nothing else changed.
    const after = await get(t.couponId);
    const changed = Object.keys(coupon).filter(
      (k) => k !== 'reachLimit' && JSON.stringify(coupon[k]) !== JSON.stringify(after[k]),
    );
    if (after.reachLimit !== TARGET)
      throw new Error(`re-read shows reachLimit ${after.reachLimit}`);
    console.log(
      `fixed ${t.code} (#${t.couponId}) ${coupon.reachLimit} -> ${after.reachLimit}` +
        (changed.length ? `  WARNING other fields differ: ${changed.join(',')}` : ''),
    );
    done += 1;
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${t.code} (#${t.couponId}): ${err instanceof Error ? err.message : err}`);
  }
}
console.log(WRITE || ONE ? `\n${done} fixed, ${failed} failed` : '\ndry run — nothing changed');
process.exit(failed ? 1 : 0);
