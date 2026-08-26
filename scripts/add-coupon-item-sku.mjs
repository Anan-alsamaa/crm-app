#!/usr/bin/env node
/**
 * Add `coupon_approvals.item_sku` — Yiji's item id beside the item NAME.
 *
 * The name cannot be the key. This database already holds `Vegetable Pasta.yy`
 * in `item_name`: one typo, now permanently its own distinct value. So
 * "which customers complained about the pasta" splits across spellings and
 * quietly under-reports — the failure mode that looks like a smaller number
 * rather than an error.
 *
 * The id has no spellings. It comes from the order line
 * (`idChooseableItem`, e.g. 1047 = Water), which the portal already parses as
 * `sku` and now carries through the coupon dialog.
 *
 * NULLABLE and never backfilled. A coupon raised from a typed item name has no
 * id — a phoned-in complaint with no order attached — and inventing one from
 * the name would recreate exactly the problem this column exists to solve.
 * Null means "not captured", never "no item".
 *
 * Plain `fetch` and no SDK import, matching the other scripts here.
 *
 * Idempotent — safe to re-run:
 *   node scripts/add-coupon-item-sku.mjs           # show what it would do
 *   node scripts/add-coupon-item-sku.mjs --write   # apply
 */

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

console.log(`${WRITE ? 'APPLYING' : 'DRY RUN'} against ${D}\n`);

const existing = await fetch(`${D}/fields/coupon_approvals/item_sku`, { headers: H });
if (existing.ok) {
  console.log('  = coupon_approvals.item_sku already exists — nothing to do.');
  process.exit(0);
}

console.log('  + coupon_approvals.item_sku (string, nullable)');
if (!WRITE) {
  console.log('\nRe-run with --write to apply.');
  process.exit(0);
}

const res = await fetch(`${D}/fields/coupon_approvals`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({
    field: 'item_sku',
    type: 'string',
    schema: { is_nullable: true },
    meta: {
      interface: 'input',
      // Read-only in the console: it is set by the portal from the order line,
      // and a hand-typed id is worse than none — it looks authoritative and
      // groups a coupon under the wrong item.
      readonly: true,
      width: 'half',
      note: "Yiji's item id for the line this coupon is about. Set from the order; blank when the item was typed by hand.",
    },
  }),
});

if (!res.ok) {
  console.error('Failed:', (await res.text()).slice(0, 300));
  process.exit(1);
}
console.log('\nApplied.');
