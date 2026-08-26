#!/usr/bin/env node
/**
 * Align `service_type` with the vocabulary the ORDERS actually carry.
 *
 * The CRM list was written by hand and drifted: it said "Drive Thru",
 * "Dinning" and "TakeOut" where Yiji's orders say carhop, in_restaurant and
 * takeout. So the one field an order could fill in for itself was the field
 * most likely to be left blank — the agent had to translate.
 *
 *   Drive Thru -> Carhop
 *   Dinning    -> Dine-in
 *   TakeOut    -> Takeout
 *   Delivery, Pickup — already correct, untouched.
 *
 * THREE THINGS MOVE TOGETHER or the data goes inconsistent:
 *   1. the `option_lists` rows (what the dropdown offers)
 *   2. `tickets.service_type` (rows already holding the old spelling)
 *   3. `serviceTypeFromOrder()` in the portal, which maps an order onto these
 *
 * (3) ships in the same commit. This script does (1) and (2), and only
 * together: renaming the list alone would leave existing tickets holding a
 * value the combobox no longer offers — it is locked to the list, so those
 * tickets would render blank and lose their service type on the next save.
 * Reports group by this string too, so a half-migration splits one service
 * across two names.
 *
 * Plain `fetch` and no SDK import, matching the other scripts here — these run
 * from the repo root where the workspace's node_modules is not resolvable.
 *
 * Dry by default:
 *   node scripts/migrate-service-types.mjs           # show what would change
 *   node scripts/migrate-service-types.mjs --write   # apply
 */

const RENAMES = new Map([
  ['Drive Thru', 'Carhop'],
  ['Dinning', 'Dine-in'],
  ['TakeOut', 'Takeout'],
]);

/** The complete set, in the order the dropdown should offer them. */
const FINAL = ['Delivery', 'Pickup', 'Carhop', 'Takeout', 'Dine-in'];

const WRITE = process.argv.includes('--write');
const D = process.env.DIRECTUS_URL ?? 'http://localhost:8055';

async function token() {
  if (process.env.DIRECTUS_TOKEN) return process.env.DIRECTUS_TOKEN;
  const email = process.env.DIRECTUS_ADMIN_EMAIL;
  const password = process.env.DIRECTUS_ADMIN_PASSWORD;
  if (!email || !password) {
    console.error(
      'Need DIRECTUS_TOKEN, or DIRECTUS_ADMIN_EMAIL + DIRECTUS_ADMIN_PASSWORD.',
    );
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
const patch = (p, body) =>
  fetch(`${D}${p}`, { method: 'PATCH', headers: H, body: JSON.stringify(body) });

console.log(`${WRITE ? 'APPLYING' : 'DRY RUN'} against ${D}\n`);

// ── 1. The option list ──────────────────────────────────────────────────────
const options = await get(
  '/items/option_lists?filter[list][_eq]=service_type&fields=id,value,sort,active&limit=-1',
);

console.log('option_lists:');
for (const row of options) {
  const next = RENAMES.get(row.value);
  const sort = FINAL.indexOf(next ?? row.value);
  const changes = {};
  if (next) changes.value = next;
  if (sort >= 0 && row.sort !== sort) changes.sort = sort;

  if (Object.keys(changes).length === 0) {
    console.log(`  = ${row.value}`);
    continue;
  }
  console.log(
    `  ${next ? '→' : '~'} ${row.value}${next ? ` becomes ${next}` : ''}` +
      (changes.sort != null ? ` (sort ${row.sort} → ${changes.sort})` : ''),
  );
  if (WRITE) await patch(`/items/option_lists/${row.id}`, changes);
}

const present = new Set(options.map((o) => RENAMES.get(o.value) ?? o.value));
const missing = FINAL.filter((v) => !present.has(v));
if (missing.length) {
  // Reported rather than created: a value nobody has ever used may be a
  // deliberate omission, and inventing one is not this script's call.
  console.log(`\n  NOT PRESENT (add by hand if wanted): ${missing.join(', ')}`);
}

// ── 2. The tickets already holding an old spelling ──────────────────────────
console.log('\ntickets:');
let moved = 0;
for (const [from, to] of RENAMES) {
  const rows = await get(
    `/items/tickets?filter[service_type][_eq]=${encodeURIComponent(from)}&fields=id&limit=-1`,
  );
  if (rows.length === 0) {
    console.log(`  = no tickets on "${from}"`);
    continue;
  }
  console.log(`  → ${rows.length} ticket(s) "${from}" becomes "${to}"`);
  moved += rows.length;
  if (WRITE) {
    for (const r of rows) await patch(`/items/tickets/${r.id}`, { service_type: to });
  }
}

console.log(
  `\n${WRITE ? 'Applied' : 'Would change'}: ${moved} ticket(s).` +
    (WRITE ? '' : ' Re-run with --write to apply.'),
);
