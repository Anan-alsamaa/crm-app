#!/usr/bin/env node
/**
 * ONE-OFF: make every CRM coupon's TYPE on Yiji match what the agent chose.
 *
 * Owner, 2026-10-07: "I see so many coupons issued from the CRM with the coupon
 * type General in Yiji, while the coupon type while issuing was Private."
 * Cause: until v1.38.8 (2026-10-06) the order-less path created the coupon
 * with `type` FORCED to General (0), whatever the agent chose. Yiji's `type`:
 * 0 = General, 1 = Private (confirmed by the owner from Yiji's own console).
 *
 * For every CRM coupon that reached Yiji: find it BY CODE
 * (`GET /api/Coupon/GetFilteredData?Code=`, exact match only), compare its
 * `type` with the CRM's `coupon_type`, and — only with --write — PATCH ONLY
 * `type` back with /api/Coupon/UpdateCoupon, then RE-READ it and flag any
 * other field that moved. Nothing is deleted or created.
 *
 * Write access uses the owner's admin login in the git-ignored
 * `.env.yiji-admin` (the CRM's own Yiji role is 403 on UpdateCoupon).
 *
 *   E=… P=… node scripts/repair-coupon-type.mjs           # dry run, read-only
 *   E=… P=… node scripts/repair-coupon-type.mjs --one     # one coupon, verified
 *   E=… P=… node scripts/repair-coupon-type.mjs --write   # all, each verified
 *
 * E/P: the CRM (Directus) admin login. Reads the Yiji read credentials from
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
const TYPE = { general: 0, public: 0, private: 1 };
const NAME = { 0: 'General', 1: 'Private' };

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
        fields: 'coupon_code,coupon_type,status,yiji_pushed_at,yiji_coupon_id,reason',
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
/* The SEARCH by code is above the CRM's Yiji role (403), so the owner's admin
   login in `.env.yiji-admin` reads too when it is there — read-only unless
   --write / --one. */
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
/*
 * EVERY COUPON BY ITS CODE (owner: "use the coupon code to identify the
 * coupons on Yiji and CRM both"). Yiji's own search, GetFilteredData, answers
 * 500 to every query (2026-10-07), so the list is read instead — newest first —
 * until it is past the oldest CRM coupon, and indexed by code.
 */
const yijiByCode = new Map();
const CACHE = path.join(process.env.TEMP, 'yiji-coupons-by-code.json');
if (process.argv.includes('--cached') && fs.existsSync(CACHE)) {
  for (const [k, v] of JSON.parse(fs.readFileSync(CACHE, 'utf8'))) yijiByCode.set(k, v);
} else {
  const wanted = new Set(crmRows.map((r) => r.coupon_code));
  /*
   * KNOWN IDS FIRST. The list is slow and fails on some pages, so every coupon
   * whose Yiji id is already known — `yiji_coupon_id` on the CRM row, or the
   * earlier by-customer scan in $TEMP/coupon-scan.json — is read by id and
   * kept only if its code matches EXACTLY. The list is then walked only until
   * the rest are found.
   */
  const knownIds = new Map();
  for (const r of crmRows) if (r.yiji_coupon_id) knownIds.set(r.coupon_code, r.yiji_coupon_id);
  const scanFile = path.join(process.env.TEMP, 'coupon-scan.json');
  if (fs.existsSync(scanFile)) {
    for (const x of JSON.parse(fs.readFileSync(scanFile, 'utf8'))) {
      if (x.code && x.couponId && !knownIds.has(x.code)) knownIds.set(x.code, x.couponId);
    }
  }
  const ids = [...knownIds];
  for (let i = 0; i < ids.length; i += 8) {
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
  /* Small pages, and a page Yiji fails to serialise (HTTP 500 — one bad
     coupon in it) is re-read one coupon at a time so only that one is lost. */
  const PAGE = 50;
  const listPage = (n, size) =>
    yget(`${A}/api/Coupon/GetAllCoupons?${new URLSearchParams({ PageNumber: String(n), PageSize: String(size) })}`);
  const unreadable = [];
  const readPage = async (page) => {
    try {
      return await listPage(page, PAGE);
    } catch {
      // One bad coupon breaks the page: read its 50 positions one by one.
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
  const BATCH = 4;
  walk: for (let first = 1; first <= 400; first += BATCH) {
    const pages = await Promise.all(
      Array.from({ length: BATCH }, (_, i) => readPage(first + i)),
    );
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
    const minId = Math.min(...pages.flat().map((c) => c.id));
    console.log(`list read to Yiji id ${minId}: ${found} of ${wanted.size} CRM codes found`);
    // Not by id: Yiji lists older ids among new ones. 120 pages = 6000 coupons.
    if (found === wanted.size || first + BATCH > 120) break;
  }
  if (unreadable.length) console.log(`Yiji could not return ${unreadable.length} list position(s): ${unreadable.join(',')}`);
  fs.writeFileSync(CACHE, JSON.stringify([...yijiByCode]));
}
const byCode = async (code) => yijiByCode.get(code) ?? [];

let writeToken = null;
if (WRITE || ONE) {
  const adm = readEnvFile(path.join(ROOT, '.env.yiji-admin'));
  writeToken = adm.YIJI_UPDATE_TOKEN
    ? adm.YIJI_UPDATE_TOKEN.replace(/^Bearer\s+/i, '')
    : adm.YIJI_UPDATE_EMAIL
      ? await yijiLogin(adm.YIJI_UPDATE_EMAIL, adm.YIJI_UPDATE_PASSWORD)
      : null;
  if (!writeToken) {
    console.error('no admin credentials in .env.yiji-admin — refusing to write');
    process.exit(2);
  }
}

const report = {
  checked: 0,
  ok: 0,
  wrong: [],
  notFound: [],
  duplicate: [],
  noChoice: [],
  notCrm: [],
  skippedGeneral: [],
};
/*
 * Issued by the CRM (owner, 2026-10-07): "verify using the coupon code,
 * description would be the 2nd confirmation." The code is matched EXACTLY
 * before this is asked; the description must then confirm it — either it
 * starts "CRM - ", or it is word for word the reason the agent wrote.
 */
const isCrmCoupon = (c, row) => {
  const desc = String(c?.compensationReason ?? '').trim();
  return /^crm\s*-/i.test(desc) || (!!desc && desc === String(row?.reason ?? '').trim());
};
let fixed = 0;
let failed = 0;
for (const row of crmRows) {
  const want = TYPE[String(row.coupon_type ?? '').trim().toLowerCase()];
  if (want === undefined) {
    report.noChoice.push(row.coupon_code);
    continue;
  }
  let hits;
  try {
    hits = await byCode(row.coupon_code);
  } catch (err) {
    report.notFound.push(`${row.coupon_code} (${err.message})`);
    continue;
  }
  if (hits.length === 0) {
    report.notFound.push(row.coupon_code);
    continue;
  }
  if (hits.length > 1) report.duplicate.push(`${row.coupon_code} x${hits.length}`);
  for (const hit of hits) {
    report.checked += 1;
    if (hit.type === want) {
      report.ok += 1;
      continue;
    }
    report.wrong.push({ code: row.coupon_code, id: hit.id, yiji: hit.type, want });
    /*
     * THE OWNER'S TWO FENCES (2026-10-07):
     *   - ONLY Private: a coupon is changed only when the agent chose Private
     *     and Yiji holds General — never to General, never a General choice;
     *   - ONLY the CRM's: Yiji's description must start "CRM - ".
     * Anything else is reported and left exactly as it is.
     */
    if (!(want === 1 && hit.type === 0)) {
      report.skippedGeneral.push(`${row.coupon_code} (#${hit.id}) Yiji ${NAME[hit.type]}, CRM ${NAME[want]}`);
      continue;
    }
    if (!isCrmCoupon(hit, row)) {
      report.notCrm.push(`${row.coupon_code} (#${hit.id}) "${String(hit.compensationReason ?? '').slice(0, 40)}"`);
      continue;
    }
    if (!WRITE && !(ONE && fixed === 0)) continue;
    try {
      const coupon = await yget(`${A}/api/Coupon/GetCoupon/id/${hit.id}`);
      // Re-checked on the fresh read, not the list: the fences hold at write time.
      if (coupon.code !== row.coupon_code || coupon.type !== 0 || !isCrmCoupon(coupon, row)) {
        throw new Error(`fresh read no longer matches (code ${coupon.code}, type ${coupon.type})`);
      }
      const r = await fetch(`${A}/api/Coupon/UpdateCoupon`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${writeToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...coupon, type: want }),
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`UpdateCoupon -> HTTP ${r.status} ${text.slice(0, 200)}`);
      const after = await yget(`${A}/api/Coupon/GetCoupon/id/${hit.id}`);
      if (after.type !== want) throw new Error(`re-read shows type ${after.type}`);
      const moved = Object.keys(coupon).filter(
        (k) => k !== 'type' && JSON.stringify(coupon[k]) !== JSON.stringify(after[k]),
      );
      console.log(
        `fixed ${row.coupon_code} (#${hit.id}) ${NAME[hit.type]} -> ${NAME[want]}${moved.length ? `  WARNING other fields differ: ${moved.join(',')}` : ''}`,
      );
      fixed += 1;
    } catch (err) {
      failed += 1;
      console.log(`FAIL ${row.coupon_code} (#${hit.id}): ${err.message}`);
    }
  }
}

console.log(`\nCRM coupons sent to Yiji: ${crmRows.length}`);
console.log(`found on Yiji and checked: ${report.checked} — type already right: ${report.ok}`);
console.log(`type WRONG on Yiji: ${report.wrong.length}`);
for (const w of report.wrong)
  console.log(`  ${w.code} (#${w.id}): Yiji ${NAME[w.yiji]} (${w.yiji}), agent chose ${NAME[w.want]} (${w.want})`);
if (report.notFound.length)
  console.log(`not found on Yiji by code (${report.notFound.length}): ${report.notFound.join(', ')}`);
if (report.duplicate.length) console.log(`same code twice on Yiji: ${report.duplicate.join(', ')}`);
if (report.noChoice.length) console.log(`no coupon type in the CRM: ${report.noChoice.join(', ')}`);
if (report.skippedGeneral.length)
  console.log(`NOT changed — not a Private->General mismatch: ${report.skippedGeneral.join('; ')}`);
if (report.notCrm.length)
  console.log(`NOT changed — description confirms neither "CRM -" nor the CRM reason: ${report.notCrm.join('; ')}`);
console.log(WRITE || ONE ? `\n${fixed} fixed, ${failed} failed` : '\ndry run — nothing changed');
fs.writeFileSync(
  path.join(process.env.TEMP, 'coupon-type-report.json'),
  JSON.stringify(report, null, 1),
);
process.exit(failed ? 1 : 0);
