#!/usr/bin/env node
/**
 * Bring `issuing_side` in line with who actually issues coupons.
 *
 *   Call Centre -> Customer Care          (a rename; the prefix stays CC)
 *   Delivery    -> Shadh | Taker | Shurouq | Leajlak | Parcel
 *
 * "Delivery" was one bucket for five companies. A coupon issued because Shadh
 * lost an order is not the same cost centre as one issued because Taker did,
 * and with a single value there was no way to tell them apart — or to bill
 * them apart.
 *
 * WHAT THIS DOES NOT DO: it does not reassign the existing coupons that say
 * "Delivery". Which courier each of those belongs to is a fact only the person
 * who raised it knows, and guessing would invent an attribution. "Delivery" is
 * therefore RETIRED (active=false) rather than deleted: old rows keep reading
 * correctly and reports do not lose them, but nobody can pick it again.
 *
 * Plain `fetch` and no SDK import, matching the other scripts here — these run
 * from the repo root where the workspace's node_modules is not resolvable.
 *
 * Dry by default:
 *   node scripts/migrate-issuing-sides.mjs           # show what would change
 *   node scripts/migrate-issuing-sides.mjs --write   # apply
 */

/** Renames: the value changes, every row already pointing at it stays valid. */
const RENAMES = new Map([['Call Centre', 'Customer Care']]);

/** Retired: kept for history, removed from the picker. */
const RETIRE = ['Delivery'];

/** The full list afterwards, in the order the dropdown should offer it. */
const FINAL = [
  'Customer Care',
  'Operations',
  'Marketing',
  'Shadh',
  'Taker',
  'Shurouq',
  'Leajlak',
  'Parcel',
];

const WRITE = process.argv.includes('--write');
const D = process.env.DIRECTUS_URL ?? 'http://localhost:8055';

async function token() {
  if (process.env.DIRECTUS_TOKEN) return process.env.DIRECTUS_TOKEN;
  const email = process.env.DIRECTUS_ADMIN_EMAIL;
  const password = process.env.DIRECTUS_ADMIN_PASSWORD;
  if (!email || !password) {
    console.error('Need DIRECTUS_TOKEN, or DIRECTUS_ADMIN_EMAIL + DIRECTUS_ADMIN_PASSWORD.');
    process.exit(1);
  }
  const res = await fetch(`${D}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!body?.data?.access_token) {
    console.error('Login failed:', JSON.stringify(body?.errors ?? body).slice(0, 200));
    process.exit(1);
  }
  return body.data.access_token;
}

const AT = await token();
const H = { authorization: `Bearer ${AT}`, 'content-type': 'application/json' };
const get = async (p) => (await (await fetch(`${D}${p}`, { headers: H })).json()).data ?? [];
const post = (p, body) =>
  fetch(`${D}${p}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
const patch = (p, body) =>
  fetch(`${D}${p}`, { method: 'PATCH', headers: H, body: JSON.stringify(body) });

console.log(`${WRITE ? 'APPLYING' : 'DRY RUN'} against ${D}\n`);

const rows = await get(
  '/items/option_lists?filter[list][_eq]=issuing_side&fields=id,value,sort,active&limit=-1',
);

console.log('option_lists:');
const seen = new Set();
for (const row of rows) {
  const renamed = RENAMES.get(row.value);
  const value = renamed ?? row.value;
  seen.add(value);

  if (RETIRE.includes(row.value)) {
    // Retired, not deleted: the coupons that name it must keep reading right.
    console.log(`  ⊘ ${row.value} retired (kept for history, off the picker)`);
    if (WRITE && row.active !== false) await patch(`/items/option_lists/${row.id}`, { active: false });
    continue;
  }

  const sort = FINAL.indexOf(value);
  const changes = {};
  if (renamed) changes.value = renamed;
  if (sort >= 0 && row.sort !== sort) changes.sort = sort;
  if (row.active !== true) changes.active = true;

  if (Object.keys(changes).length === 0) {
    console.log(`  = ${row.value}`);
    continue;
  }
  console.log(`  ${renamed ? '→' : '~'} ${row.value}${renamed ? ` becomes ${renamed}` : ''}`);
  if (WRITE) await patch(`/items/option_lists/${row.id}`, changes);
}

const missing = FINAL.filter((v) => !seen.has(v));
for (const value of missing) {
  console.log(`  + ${value}`);
  if (WRITE) {
    await post('/items/option_lists', {
      list: 'issuing_side',
      value,
      sort: FINAL.indexOf(value),
      active: true,
    });
  }
}

// Coupons still naming a renamed side. Their prefix does not change (CC either
// way), but the string has to match the list or the picker shows it blank.
console.log('\ncoupon_approvals:');
let moved = 0;
for (const [from, to] of RENAMES) {
  const hits = await get(
    `/items/coupon_approvals?filter[issuing_side][_eq]=${encodeURIComponent(from)}&fields=id&limit=-1`,
  );
  if (hits.length === 0) {
    console.log(`  = none on "${from}"`);
    continue;
  }
  console.log(`  → ${hits.length} coupon(s) "${from}" becomes "${to}"`);
  moved += hits.length;
  if (WRITE) {
    for (const h of hits) await patch(`/items/coupon_approvals/${h.id}`, { issuing_side: to });
  }
}

const stranded = await get(
  '/items/coupon_approvals?filter[issuing_side][_eq]=Delivery&fields=id&limit=-1',
);
if (stranded.length) {
  // Named out loud rather than guessed at: only whoever raised these knows
  // which courier they belong to.
  console.log(
    `\n  ${stranded.length} coupon(s) still say "Delivery" — reassign by hand to a courier.`,
  );
}

console.log(
  `\n${WRITE ? 'Applied' : 'Would change'}: ${moved} coupon(s).` +
    (WRITE ? '' : ' Re-run with --write to apply.'),
);
