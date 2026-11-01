#!/usr/bin/env node
/**
 * ONE-OFF REPAIR: give CRM coupons on Yiji their BRAND and RESTAURANT.
 *
 * Owner, 2026-11-01: in Yiji's monthly coupon export "for all the CRM issued
 * coupons, the brand name and the restaurant name is not present". They were
 * only ever copied from Yiji's ORDER, and since coupons are granted by phone
 * (2026-10-11) no order is read, so coupons went out with neither. The fix for
 * new coupons is `couponBranchIds` in services/workers coupon-push.ts; this
 * fills the ones already on Yiji, using the SAME rule:
 *
 *   restaurantId  the coupon's `restaurant_id` (Yiji's own number), else the
 *                 ticket branch's `yiji_restaurant_id` - only when numeric;
 *   brandId       the coupon's brand NAME (else the branch's brand) mapped by
 *                 YIJI_BRAND_IDS - only when the name is known.
 *
 * Per coupon: find it on Yiji BY CODE (exact), confirm it is the CRM's (the
 * description starts "CRM -" or is word for word the agent's reason), and set
 * ONLY the field(s) Yiji holds EMPTY - a value already there is never changed.
 * PATCH /api/Coupon/UpdateCoupon with the coupon as read, then RE-READ it and
 * flag any other field that moved. Nothing is deleted or created.
 *
 * Write access: the owner's admin login in the git-ignored `.env.yiji-admin`
 * (the CRM's Yiji role is 403 on UpdateCoupon).
 *
 *   E=… P=… node scripts/repair-coupon-brand-restaurant.mjs            # dry run
 *   E=… P=… node scripts/repair-coupon-brand-restaurant.mjs --one      # one, verified
 *   E=… P=… node scripts/repair-coupon-brand-restaurant.mjs --write    # all, each verified
 *   add --cached to reuse the Yiji code index from the last run.
 *
 * E/P: the CRM (Directus) admin login. Yiji read credentials come from
 * $TEMP/wenv.json like the other coupon scripts.
 */
import fs from 'node:fs';
import path from 'node:path';

const WRITE = process.argv.includes('--write');
const ONE = process.argv.includes('--one');
const A = 'https://admin.yiji-app.com';
const API = process.env.API ?? 'https://crm-api.anan.sa';
const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')),
  '..',
);

/* Yiji's brand ids - keep in step with YIJI_BRAND_IDS (workers customer-push.ts). */
const YIJI_BRAND_IDS = [
  { id: 1, names: ['La Casa Pasta', 'Casa Pasta'] },
  { id: 3, names: ['Okashi'] },
  { id: 81, names: ['Chick n Dip', 'Chick N Dip', 'CND Casual'] },
  { id: 1004, names: ['Poshak'] },
];
const key = (s) => String(s).trim().replace(/\s+/g, ' ').toLowerCase();
const BRAND = new Map(YIJI_BRAND_IDS.flatMap((b) => b.names.map((n) => [key(n), b.id])));

/** The same rule as couponBranchIds in coupon-push.ts. */
function branchIds(row) {
  const store = row.ticket?.store ?? null;
  const restaurantId = [row.restaurant_id, store?.yiji_restaurant_id]
    .map((v) => (v === null || v === undefined ? NaN : Number(String(v).trim())))
    .find((n) => Number.isInteger(n) && n > 0);
  const brandName = [row.brand_id, store?.brand?.yiji_brand_name, store?.brand?.name].find(
    (v) => typeof v === 'string' && v.trim() && BRAND.has(key(v)),
  );
  return { restaurantId, brandId: brandName ? BRAND.get(key(brandName)) : undefined };
}

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
async function yijiLogin(email, password) {
  const r = await fetch(`${A}/api/Account/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json().catch(() => null);
  if (!j?.token) throw new Error(`yiji login failed (HTTP ${r.status})`);
  return j.token;
}

// ── the CRM side: every coupon that was sent to Yiji ───────────────────────
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
const crmRows = (
  await (
    await fetch(
      `${API}/items/coupon_approvals?${new URLSearchParams({
        filter: JSON.stringify({
          _or: [
            { yiji_coupon_user_id: { _nnull: true } },
            { yiji_coupon_id: { _nnull: true } },
            { yiji_pushed_at: { _nnull: true } },
          ],
        }),
        fields:
          'coupon_code,status,yiji_coupon_id,reason,brand_id,restaurant_id,ticket.store.yiji_restaurant_id,ticket.store.brand.name,ticket.store.brand.yiji_brand_name',
        limit: '-1',
      })}`,
      { headers: { authorization: `Bearer ${crmToken}` } },
    )
  ).json()
).data;

// ── the Yiji side ───────────────────────────────────────────────────────────
const wenv = Object.fromEntries(
  JSON.parse(fs.readFileSync(path.join(process.env.TEMP, 'wenv.json'), 'utf8')).map((v) => [
    v.name,
    v.value,
  ]),
);
const adminEnv = readEnvFile(path.join(ROOT, '.env.yiji-admin'));
const adminToken = adminEnv.YIJI_UPDATE_TOKEN
  ? adminEnv.YIJI_UPDATE_TOKEN.replace(/^Bearer\s+/i, '')
  : adminEnv.YIJI_UPDATE_EMAIL
    ? await yijiLogin(adminEnv.YIJI_UPDATE_EMAIL, adminEnv.YIJI_UPDATE_PASSWORD)
    : null;
const readToken = adminToken ?? (await yijiLogin(wenv.YIJI_ADMIN_EMAIL, wenv.YIJI_ADMIN_PASSWORD));
const yget = async (url) => {
  const r = await fetch(url, { headers: { authorization: `Bearer ${readToken}` } });
  if (r.status !== 200) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
};

/* Every CRM coupon BY ITS CODE: known ids first, then Yiji's list, newest
   first, until all are found (same walk as repair-coupon-type.mjs). */
const yijiByCode = new Map();
/* CACHE_FILE: another index to work from - e.g. the coupons located through
   GetAllUserCoupons when Yiji's coupon LIST does not show them. */
const CACHE = process.env.CACHE_FILE ?? path.join(process.env.TEMP, 'yiji-coupons-by-code-br.json');
/*
 * GENTLE BY DEFAULT (incident 2026-10-26: never flood Yiji). START_PAGE=n
 * continues the walk from page n on top of the cached index; MAX_PAGES caps
 * it; PAGE_DELAY_MS paces it (one page at a time).
 */
const START_PAGE = Number(process.env.START_PAGE ?? 0);
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 120);
const PAGE_DELAY_MS = Number(process.env.PAGE_DELAY_MS ?? 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if ((process.argv.includes('--cached') || START_PAGE) && fs.existsSync(CACHE)) {
  for (const [k, v] of JSON.parse(fs.readFileSync(CACHE, 'utf8'))) yijiByCode.set(k, v);
}
if (!process.argv.includes('--cached')) {
  const wanted = new Set(crmRows.map((r) => r.coupon_code));
  const knownIds = new Map();
  for (const r of crmRows) if (r.yiji_coupon_id) knownIds.set(r.coupon_code, r.yiji_coupon_id);
  const ids = [...knownIds];
  for (let i = 0; !START_PAGE && i < ids.length; i += 8) {
    await Promise.all(
      ids.slice(i, i + 8).map(async ([code, id]) => {
        try {
          const c = await yget(`${A}/api/Coupon/GetCoupon/id/${id}`);
          if (c?.code === code) yijiByCode.set(code, [c]);
        } catch {
          /* left for the list walk */
        }
      }),
    );
  }
  console.log(`found by known id: ${yijiByCode.size} of ${wanted.size}`);
  const PAGE = 50;
  const listPage = (n, size) =>
    yget(
      `${A}/api/Coupon/GetAllCoupons?${new URLSearchParams({ PageNumber: String(n), PageSize: String(size) })}`,
    );
  const unreadable = [];
  const readPage = async (page) => {
    try {
      return await listPage(page, PAGE);
    } catch {
      const one = await Promise.all(
        Array.from({ length: PAGE }, (_, i) => (page - 1) * PAGE + i + 1).map(async (n) => {
          try {
            return await listPage(n, 1);
          } catch {
            unreadable.push(n);
            return [];
          }
        }),
      );
      return one.flat();
    }
  };
  const BATCH = PAGE_DELAY_MS ? 1 : 4;
  walk: for (let first = START_PAGE || 1; first <= MAX_PAGES; first += BATCH) {
    if (PAGE_DELAY_MS) await sleep(PAGE_DELAY_MS);
    const pages = await Promise.all(Array.from({ length: BATCH }, (_, i) => readPage(first + i)));
    for (const list of pages) {
      if (!Array.isArray(list) || list.length === 0) break walk;
      for (const c of list) {
        if (!c?.code || (yijiByCode.get(c.code) ?? []).some((h) => h.id === c.id)) continue;
        const hits = yijiByCode.get(c.code) ?? [];
        hits.push(c);
        yijiByCode.set(c.code, hits);
      }
    }
    const found = [...wanted].filter((code) => yijiByCode.has(code)).length;
    if ((first + BATCH - 1) % 20 === 0)
      console.log(
        `list read to page ${first + BATCH - 1}: ${found} of ${wanted.size} CRM codes found`,
      );
    if (found === wanted.size || first + BATCH > MAX_PAGES) break;
  }
  if (unreadable.length)
    console.log(
      `Yiji could not return ${unreadable.length} list position(s): ${unreadable.join(',')}`,
    );
  fs.writeFileSync(CACHE, JSON.stringify([...yijiByCode]));
}

let writeToken = null;
if (WRITE || ONE) {
  writeToken = adminToken;
  if (!writeToken) {
    console.error('no admin credentials in .env.yiji-admin - refusing to write');
    process.exit(2);
  }
}

const isCrmCoupon = (c, row) => {
  const desc = String(c?.compensationReason ?? '').trim();
  return /^crm\s*-/i.test(desc) || (!!desc && desc === String(row?.reason ?? '').trim());
};
const empty = (v) => v === null || v === undefined || v === 0 || v === '';

const report = {
  checked: 0,
  complete: 0,
  toFix: [],
  noData: [],
  notFound: [],
  duplicate: [],
  notCrm: [],
};
let fixed = 0;
let failed = 0;
for (const row of crmRows) {
  const want = branchIds(row);
  const hits = yijiByCode.get(row.coupon_code) ?? [];
  if (hits.length === 0) {
    report.notFound.push(row.coupon_code);
    continue;
  }
  if (hits.length > 1) report.duplicate.push(`${row.coupon_code} x${hits.length}`);
  for (const hit of hits) {
    report.checked += 1;
    const patch = {};
    if (empty(hit.brandId) && want.brandId !== undefined) patch.brandId = want.brandId;
    if (empty(hit.restaurantId) && want.restaurantId !== undefined)
      patch.restaurantId = want.restaurantId;
    const stillMissing = [
      empty(hit.brandId) && want.brandId === undefined ? 'brand' : null,
      empty(hit.restaurantId) && want.restaurantId === undefined ? 'restaurant' : null,
    ].filter(Boolean);
    if (stillMissing.length)
      report.noData.push(`${row.coupon_code} (#${hit.id}) no CRM ${stillMissing.join('+')}`);
    if (Object.keys(patch).length === 0) {
      if (!stillMissing.length) report.complete += 1;
      continue;
    }
    if (!isCrmCoupon(hit, row)) {
      report.notCrm.push(
        `${row.coupon_code} (#${hit.id}) "${String(hit.compensationReason ?? '').slice(0, 40)}"`,
      );
      continue;
    }
    report.toFix.push({ code: row.coupon_code, id: hit.id, ...patch });
    if (!WRITE && !(ONE && fixed === 0)) continue;
    /* Paced (incident 2026-10-26): three Yiji calls per coupon. */
    if (WRITE) await sleep(Number(process.env.WRITE_DELAY_MS ?? 4000));
    try {
      const coupon = await yget(`${A}/api/Coupon/GetCoupon/id/${hit.id}`);
      if (coupon.code !== row.coupon_code || !isCrmCoupon(coupon, row)) {
        throw new Error(`fresh read no longer matches (code ${coupon.code})`);
      }
      /* Re-decided on the fresh read: only what is STILL empty. */
      const fresh = {};
      if (empty(coupon.brandId) && patch.brandId !== undefined) fresh.brandId = patch.brandId;
      if (empty(coupon.restaurantId) && patch.restaurantId !== undefined)
        fresh.restaurantId = patch.restaurantId;
      if (Object.keys(fresh).length === 0) {
        console.log(`skip ${row.coupon_code} (#${hit.id}): already filled`);
        continue;
      }
      const r = await fetch(`${A}/api/Coupon/UpdateCoupon`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${writeToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...coupon, ...fresh }),
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`UpdateCoupon -> HTTP ${r.status} ${text.slice(0, 200)}`);
      const after = await yget(`${A}/api/Coupon/GetCoupon/id/${hit.id}`);
      for (const [k, v] of Object.entries(fresh)) {
        if (after[k] !== v) throw new Error(`re-read shows ${k}=${after[k]}, wanted ${v}`);
      }
      const moved = Object.keys(coupon).filter(
        (k) => !(k in fresh) && JSON.stringify(coupon[k]) !== JSON.stringify(after[k]),
      );
      console.log(
        `fixed ${row.coupon_code} (#${hit.id}) ${JSON.stringify(fresh)}${moved.length ? `  WARNING other fields differ: ${moved.join(',')}` : ''}`,
      );
      fixed += 1;
    } catch (err) {
      failed += 1;
      console.log(`FAIL ${row.coupon_code} (#${hit.id}): ${err.message}`);
    }
  }
}

console.log(`\nCRM coupons sent to Yiji: ${crmRows.length}`);
console.log(`found on Yiji and checked: ${report.checked} - already complete: ${report.complete}`);
console.log(`to fill: ${report.toFix.length}`);
for (const f of report.toFix.slice(0, 15)) console.log(`  ${JSON.stringify(f)}`);
if (report.toFix.length > 15) console.log(`  ... and ${report.toFix.length - 15} more`);
if (report.noData.length)
  console.log(`CRM has no value for (${report.noData.length}): ${report.noData.join('; ')}`);
if (report.notFound.length)
  console.log(
    `not found on Yiji by code (${report.notFound.length}): ${report.notFound.join(', ')}`,
  );
if (report.duplicate.length) console.log(`same code twice on Yiji: ${report.duplicate.join(', ')}`);
if (report.notCrm.length)
  console.log(
    `NOT changed - description does not confirm a CRM coupon: ${report.notCrm.join('; ')}`,
  );
console.log(WRITE || ONE ? `\n${fixed} fixed, ${failed} failed` : '\ndry run - nothing changed');
fs.writeFileSync(
  path.join(process.env.TEMP, 'coupon-brand-restaurant-report.json'),
  JSON.stringify(report, null, 1),
);
process.exit(failed ? 1 : 0);
