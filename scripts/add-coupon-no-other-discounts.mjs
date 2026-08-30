#!/usr/bin/env node
/**
 * Add `coupon_approvals.no_other_discounts`.
 *
 * One CRM answer driving Yiji's `dontApplyLoyality` AND `dontApplyOffer`, which
 * always move together (owner, 2026-08-29):
 *
 *   true  -> the customer CANNOT use this coupon on an already-discounted item
 *   false -> it stacks on top of an existing discount
 *
 * Phrased as a NEGATIVE deliberately. Yiji's own fields are negatives — "do NOT
 * apply" — so a positively-named CRM field ("allow with other offers") would
 * have to default to Yes and then be inverted on the way out. Two inversions is
 * how a flag ends up meaning its own opposite. Sharing their polarity means
 * No -> false and Yes -> true with nothing to reason about at either end.
 *
 * DEFAULT FALSE, and nullable. Existing rows get null, which the payload treats
 * as false via `=== true` — an apology that cannot be used during a promotion is
 * a worse apology, so the permissive reading is the one to fall into.
 *
 * Plain `fetch` and no SDK import, matching the other scripts here.
 *
 * Idempotent — safe to re-run:
 *   node scripts/add-coupon-no-other-discounts.mjs           # show
 *   node scripts/add-coupon-no-other-discounts.mjs --write   # apply
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

const existing = await fetch(`${D}/fields/coupon_approvals/no_other_discounts`, { headers: H });
if (existing.ok) {
  console.log('  = coupon_approvals.no_other_discounts already exists — nothing to do.');
  process.exit(0);
}

console.log('  + coupon_approvals.no_other_discounts (boolean, default false)');
if (!WRITE) {
  console.log('\nRe-run with --write to apply.');
  process.exit(0);
}

const res = await fetch(`${D}/fields/coupon_approvals`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({
    field: 'no_other_discounts',
    type: 'boolean',
    schema: { is_nullable: true, default_value: false },
    meta: {
      interface: 'boolean',
      width: 'half',
      note: 'Yes = the customer cannot use this coupon on an item that is already discounted. Drives Yiji dontApplyLoyality + dontApplyOffer, which always move together.',
    },
  }),
});

if (!res.ok) {
  console.error('Failed:', (await res.text()).slice(0, 300));
  process.exit(1);
}
console.log('\nApplied.');
