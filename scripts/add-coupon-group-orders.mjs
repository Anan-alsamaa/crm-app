#!/usr/bin/env node
/**
 * GROUP ORDERS (owner, 2026-11-11): add `coupon_approvals.group_order_id` and
 * `coupon_approvals.order_breakdown`, and fill them in for coupons already
 * delivered on a group (food-court) order.
 *
 * Uses the SAME code as the coupon worker (`@yiji/shared-types`
 * order-group.ts: getOrderGroup, groupBelongsTo, breakdownBasis,
 * buildOrderBreakdown), so an old coupon gets exactly what a new one gets:
 * the master order and an equal, unrounded share per suborder.
 *
 * What it does NOT do: change anything on Yiji, or move an old coupon's link
 * on Yiji. It only records the group on the CRM's own row.
 *
 * Gentle on Yiji (incident 2026-10-26): it does not read every coupon's order.
 * It lists each day's orders once (Yiji's day list shows group MASTERS only),
 * and reads a group only for coupons whose order is a master or sits just
 * after one (suborder ids follow their master). One call at a time, spaced.
 *
 * Dry run by default (prints what it would write):
 *   DIRECTUS_URL=... DIRECTUS_ADMIN_EMAIL=... DIRECTUS_ADMIN_PASSWORD=... \
 *   YIJI_ADMIN_API_URL=... YIJI_API_URL=... YIJI_ADMIN_EMAIL=... YIJI_ADMIN_PASSWORD=... \
 *     node scripts/add-coupon-group-orders.mjs [--write]
 *
 * Build `@yiji/shared-types` first (pnpm --filter @yiji/shared-types build).
 */
import {
  breakdownBasis,
  buildOrderBreakdown,
  createYijiOrderGroupReader,
  groupBelongsTo,
  groupOrderIds,
} from '../packages/shared-types/dist/index.js';

const WRITE = process.argv.includes('--write');
const D = process.env.DIRECTUS_URL ?? 'http://localhost:8055';
const Y = process.env.YIJI_ADMIN_API_URL;
const SPACING_MS = 1200;
/** Suborder ids follow their master's: the furthest seen is +3. */
const SUB_WINDOW = 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const k of ['YIJI_ADMIN_API_URL', 'YIJI_API_URL', 'YIJI_ADMIN_EMAIL', 'YIJI_ADMIN_PASSWORD']) {
  if (!process.env[k]) {
    console.error(`Need ${k}.`);
    process.exit(1);
  }
}

async function directusToken() {
  if (process.env.DIRECTUS_TOKEN) return process.env.DIRECTUS_TOKEN;
  const res = await fetch(`${D}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: process.env.DIRECTUS_ADMIN_EMAIL,
      password: process.env.DIRECTUS_ADMIN_PASSWORD,
    }),
  });
  const body = await res.json();
  if (!body?.data?.access_token) {
    console.error('Directus login failed:', JSON.stringify(body?.errors ?? body).slice(0, 200));
    process.exit(1);
  }
  return body.data.access_token;
}
const H = { authorization: `Bearer ${await directusToken()}`, 'content-type': 'application/json' };
const get = async (p) => {
  const r = await (await fetch(D + p, { headers: H })).json();
  if (r.errors) throw new Error(`${p}: ${r.errors[0].message}`);
  return r.data;
};

console.log(`${WRITE ? 'APPLYING' : 'DRY RUN'} against ${D}\n`);

// ── 1. The two fields ─────────────────────────────────────────────────────
const FIELDS = [
  {
    field: 'group_order_id',
    type: 'string',
    schema: { is_nullable: true, is_indexed: true },
    meta: {
      interface: 'input',
      width: 'half',
      note: 'For a group (food-court) order: the MASTER order the coupon is linked to on Yiji. Empty for an ordinary order.',
    },
  },
  {
    field: 'order_breakdown',
    type: 'json',
    schema: { is_nullable: true },
    meta: {
      interface: 'input-code',
      options: { language: 'json' },
      width: 'full',
      note: 'For a group order: { master_order_id, basis (amount | max_discount), amount, lines: [{ order_id, restaurant_id, brand_id, restaurant_name, brand_name, share }] } - equal shares, never rounded.',
    },
  },
];
let fieldsReady = true;
for (const f of FIELDS) {
  const has = (await fetch(`${D}/fields/coupon_approvals/${f.field}`, { headers: H })).ok;
  if (has) {
    console.log(`  = coupon_approvals.${f.field} already exists`);
    continue;
  }
  console.log(`  + coupon_approvals.${f.field} (${f.type})`);
  if (!WRITE) {
    fieldsReady = false;
    continue;
  }
  const res = await fetch(`${D}/fields/coupon_approvals`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify(f),
  });
  if (!res.ok) {
    console.error('Field create failed:', (await res.text()).slice(0, 300));
    process.exit(1);
  }
}

// ── 2. The coupons to look at ─────────────────────────────────────────────
const rows = await get(
  '/items/coupon_approvals?limit=-1&sort=date_created' +
    '&fields=id,coupon_code,status,date_created,discount_category,coupon_value,max_discount,title,customer_phone,contact.phone,order_id,ticket.order_id' +
    (fieldsReady ? ',group_order_id' : '') +
    '&filter[status][_eq]=assigned',
);
const orderOf = (r) => String(r.ticket?.order_id ?? r.order_id ?? '').trim();
const todo = rows.filter((r) => /^\d+$/.test(orderOf(r)) && !r.group_order_id);
console.log(
  `\n${rows.length} delivered coupons, ${todo.length} with an order number and no group recorded.`,
);
if (!todo.length) process.exit(0);

// ── 3. Group masters, one day list at a time ──────────────────────────────
const login = await (
  await fetch(`${Y}/api/Account/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: process.env.YIJI_ADMIN_EMAIL,
      password: process.env.YIJI_ADMIN_PASSWORD,
    }),
  })
).json();
if (!login?.token) {
  console.error('Yiji login failed.');
  process.exit(1);
}
const YH = { authorization: `Bearer ${login.token}` };
const day = (d) => d.toISOString().slice(0, 10);
const first = new Date(Date.parse(todo[0].date_created) - 30 * 864e5);
const masters = new Set();
let listed = 0;
for (let d = new Date(day(first)); d <= new Date(); d = new Date(d.getTime() + 864e5)) {
  const next = day(new Date(d.getTime() + 864e5));
  for (let page = 1; page <= 10; page++) {
    await sleep(SPACING_MS);
    const r = await fetch(
      `${Y}/api/Order/GetFilteredOrders?OrderFromDateFilter=${day(d)}&OrderToDateFilter=${next}&PageSize=500&PageNumber=${page}`,
      { headers: YH },
    );
    if (!r.ok) throw new Error(`GetFilteredOrders ${day(d)} p${page}: HTTP ${r.status}`);
    const a = JSON.parse((await r.text()) || '[]');
    listed += a.length;
    for (const x of a) if (x?.order?.restaurantGroupId != null) masters.add(Number(x.order.id));
    if (a.length < 500) break;
  }
  process.stdout.write(
    `\r  listed ${listed} orders up to ${day(d)}, ${masters.size} group masters`,
  );
}
console.log();

const near = (id) => {
  for (let k = 0; k <= SUB_WINDOW; k++) if (masters.has(id - k)) return true;
  return false;
};
const candidates = todo.filter((r) => near(Number(orderOf(r))));
console.log(`${candidates.length} coupons on (or next to) a group order - reading those groups.\n`);

// ── 4. The same code as the worker ────────────────────────────────────────
const readGroup = createYijiOrderGroupReader({
  apiUrl: process.env.YIJI_API_URL,
  adminApiUrl: Y,
  adminEmail: process.env.YIJI_ADMIN_EMAIL,
  adminPassword: process.env.YIJI_ADMIN_PASSWORD,
});
const byMaster = new Map();
let written = 0;
for (const r of candidates) {
  await sleep(SPACING_MS);
  const entered = orderOf(r);
  const group = await readGroup(entered);
  if (!group) continue;
  if (!groupBelongsTo(group, r.customer_phone, r.contact?.phone, r.title)) {
    console.log(
      `  - ${r.coupon_code}: order ${entered} is another customer's group order - left alone`,
    );
    continue;
  }
  const basis = breakdownBasis(r);
  const breakdown = basis ? buildOrderBreakdown(group, basis) : null;
  byMaster.set(group.masterId, [...(byMaster.get(group.masterId) ?? []), r.coupon_code]);
  const shares = breakdown?.lines
    .map((l) => `#${l.order_id} ${l.brand_name ?? ''} ${l.share}`)
    .join(' · ');
  console.log(
    `  ${WRITE ? '✓' : '→'} ${r.coupon_code}: entered #${entered} → group #${group.masterId} (${groupOrderIds(group).length - 1} suborders) ${shares ?? '(no amount to split)'}`,
  );
  if (WRITE) {
    const res = await fetch(`${D}/items/coupon_approvals/${r.id}`, {
      method: 'PATCH',
      headers: H,
      body: JSON.stringify({ group_order_id: group.masterId, order_breakdown: breakdown }),
    });
    if (!res.ok) throw new Error(`PATCH ${r.coupon_code}: ${(await res.text()).slice(0, 200)}`);
    written++;
  }
}

const doubles = [...byMaster].filter(([, codes]) => codes.length > 1);
console.log(
  `\n${byMaster.size} group orders found, ${WRITE ? `${written} coupons written` : 'nothing written (dry run)'}.`,
);
if (doubles.length) {
  console.log('\nGROUP ORDERS WITH MORE THAN ONE COUPON (left as they are - for review):');
  for (const [m, codes] of doubles) console.log(`  #${m}: ${codes.join(', ')}`);
}
