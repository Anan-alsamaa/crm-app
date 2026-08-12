/**
 * Stamp `conversations.last_order_id` on chats that predate the field.
 *
 * The inbox stamps a conversation the first time its order panel resolves, so
 * from now on every chat an agent opens becomes searchable by order id. This
 * fills in the ones already in the system — otherwise "find the chat about
 * 946641" works for new chats and silently fails for the whole backlog, which
 * is worse than not working at all because it looks like it works.
 *
 * Dry run by default; pass --write to apply.
 *
 *   node scripts/backfill-conversation-order.mjs
 *   node scripts/backfill-conversation-order.mjs --write
 *
 * Reads DIRECTUS_URL / AI_GATEWAY_URL / DIRECTUS_ADMIN_EMAIL / _PASSWORD, with
 * local defaults. Idempotent: a conversation that already carries an order id
 * is skipped, so it can be re-run safely.
 */
const WRITE = process.argv.includes('--write');
const DIRECTUS = process.env.DIRECTUS_URL ?? 'http://localhost:8055';
const GATEWAY = process.env.AI_GATEWAY_URL ?? 'http://localhost:8085';
const EMAIL = process.env.DIRECTUS_ADMIN_EMAIL ?? 'e.habibi@anan.sa';
const PASSWORD = process.env.DIRECTUS_ADMIN_PASSWORD ?? '123456';

const login = await fetch(`${DIRECTUS}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!login.ok) throw new Error(`login failed: ${login.status}`);
const token = (await login.json()).data.access_token;
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

const params = new URLSearchParams({
  limit: '-1',
  'filter[last_order_id][_null]': 'true',
  fields: 'id,contact.id,contact.external_customer_id,contact.vendor.yiji_vendor_id',
});
const res = await fetch(`${DIRECTUS}/items/conversations?${params}`, { headers: H });
if (!res.ok) throw new Error(`read failed: ${res.status}`);
const rows = (await res.json()).data ?? [];

console.log(`${rows.length} conversations without an order id${WRITE ? '' : ' (dry run)'}`);

let stamped = 0;
let noCustomer = 0;
let noOrders = 0;
let failed = 0;

for (const c of rows) {
  const customerId = c.contact?.external_customer_id;
  const vendorId = c.contact?.vendor?.yiji_vendor_id;
  if (!customerId || !vendorId) {
    noCustomer += 1;
    continue;
  }
  try {
    const q = new URLSearchParams({ vendorId, customerId, limit: '2' });
    const r = await fetch(`${GATEWAY}/commerce/inbox?${q}`, { headers: H });
    if (!r.ok) throw new Error(`commerce ${r.status}`);
    const { data } = await r.json();
    const order = data?.detail ?? data?.orders?.[0] ?? null;
    if (!order) {
      noOrders += 1;
      continue;
    }
    if (WRITE) {
      const patch = await fetch(`${DIRECTUS}/items/conversations/${c.id}`, {
        method: 'PATCH',
        headers: H,
        body: JSON.stringify({
          last_order_id: String(order.orderId),
          last_order_snapshot: order,
          last_order_at: new Date().toISOString(),
        }),
      });
      if (!patch.ok) throw new Error(`patch ${patch.status}`);
    }
    stamped += 1;
    console.log(`  ${WRITE ? 'stamped' : 'would stamp'} ${c.id} -> ${order.orderId}`);
  } catch (err) {
    failed += 1;
    console.warn(`  ! ${c.id}: ${err.message}`);
  }
}

console.log(
  `\n${WRITE ? 'stamped' : 'would stamp'}: ${stamped}` +
    `\nno linked commerce customer: ${noCustomer}` +
    `\ncustomer has no orders: ${noOrders}` +
    `\nfailed: ${failed}`,
);
if (!WRITE) console.log('\nRe-run with --write to apply.');
