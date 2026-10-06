#!/usr/bin/env node
/**
 * ONE-OFF: add "CRM - " to the description of every coupon the CRM already
 * issued on Yiji, so operations can tell CRM coupons apart in Yiji's admin
 * portal (owner, 2026-10-06; new coupons carry it from the worker).
 *
 * For each coupon: READ it, set ONLY `compensationReason` and `compensation`
 * to "CRM - <existing text>" (never doubled; empty -> "CRM - Compensation"),
 * PATCH it back with /api/Coupon/UpdateCoupon, then RE-READ and flag any
 * other field that moved. Nothing is deleted or created; name, limits, dates
 * and type are untouched.
 *
 * Write access uses the owner's admin login in the git-ignored
 * `.env.yiji-admin` (the CRM's own Yiji role is 403 on UpdateCoupon).
 *
 *   node scripts/repair-coupon-crm-prefix.mjs           # dry run, read-only
 *   node scripts/repair-coupon-crm-prefix.mjs --one     # one coupon, verified
 *   node scripts/repair-coupon-crm-prefix.mjs --write   # all, each verified
 *
 * Input: $TEMP/coupon-scan.json from the read-only coupon scan
 * ([{code, couponId, ...}]).
 */
import fs from 'node:fs';
import path from 'node:path';

const WRITE = process.argv.includes('--write');
const ONE = process.argv.includes('--one');
const A = 'https://admin.yiji-app.com';
const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')),
  '..',
);
const PREFIX = 'CRM - ';

const withPrefix = (text) => {
  const t = (text ?? '').trim();
  if (!t) return `${PREFIX}Compensation`;
  return /^crm\s*-\s*/i.test(t) ? t : `${PREFIX}${t}`;
};

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

const crm = Object.fromEntries(
  JSON.parse(fs.readFileSync(path.join(process.env.TEMP, 'wenv.json'), 'utf8')).map((v) => [
    v.name,
    v.value,
  ]),
);
const readToken = await login(crm.YIJI_ADMIN_EMAIL, crm.YIJI_ADMIN_PASSWORD);
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
const targets = scan.filter((c) => c.couponId);
console.log(`${targets.length} CRM coupons found on Yiji`);

let done = 0;
let skipped = 0;
let failed = 0;
for (const t of targets) {
  if (ONE && done >= 1) break;
  try {
    const coupon = await get(t.couponId);
    if (coupon.code !== t.code)
      throw new Error(`code mismatch on Yiji: ${coupon.code} != ${t.code}`);
    const reason = withPrefix(coupon.compensationReason ?? coupon.compensation);
    const comp = withPrefix(coupon.compensation ?? coupon.compensationReason);
    /* Judged by the description alone: Yiji's GetCoupon does not return
       `compensation`, so comparing it never matched and every run rewrote
       every coupon (harmless — the prefix is never doubled — but noisy). */
    if (coupon.compensationReason === reason) {
      skipped += 1;
      continue;
    }
    if (!WRITE && !ONE) {
      console.log(
        `would set ${t.code} (#${t.couponId}): "${(coupon.compensationReason ?? '').slice(0, 40)}" -> "${reason.slice(0, 46)}"`,
      );
      continue;
    }
    const r = await fetch(`${A}/api/Coupon/UpdateCoupon`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${writeToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...coupon, compensationReason: reason, compensation: comp }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`UpdateCoupon -> HTTP ${r.status} ${text.slice(0, 200)}`);
    const after = await get(t.couponId);
    const changed = Object.keys(coupon).filter(
      (k) =>
        !['compensationReason', 'compensation'].includes(k) &&
        JSON.stringify(coupon[k]) !== JSON.stringify(after[k]),
    );
    if (!String(after.compensationReason ?? '').startsWith(PREFIX))
      throw new Error(`re-read shows "${after.compensationReason}"`);
    console.log(
      `fixed ${t.code} (#${t.couponId}) -> "${after.compensationReason.slice(0, 46)}"${changed.length ? `  WARNING other fields differ: ${changed.join(',')}` : ''}`,
    );
    done += 1;
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${t.code} (#${t.couponId}): ${err instanceof Error ? err.message : err}`);
  }
}
console.log(
  WRITE || ONE
    ? `\n${done} fixed, ${skipped} already prefixed, ${failed} failed`
    : `\ndry run — nothing changed (${skipped} already prefixed)`,
);
process.exit(failed ? 1 : 0);
