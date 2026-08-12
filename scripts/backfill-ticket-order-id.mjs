/**
 * Copy order_snapshot.orderId into the new tickets.order_id column.
 *
 * Tickets raised before that column existed carry the id only inside the JSON
 * snapshot, which Directus cannot filter on. Without this backfill those
 * tickets are invisible to an order-id search: the search returns nothing and
 * looks like "no such order" rather than "not indexed".
 *
 * Idempotent — rows whose order_id already matches are skipped.
 *
 *   node scripts/backfill-ticket-order-id.mjs           # dry run
 *   node scripts/backfill-ticket-order-id.mjs --write
 */
const D = process.env.DIRECTUS_URL || 'http://127.0.0.1:8055';
const WRITE = process.argv.includes('--write');

const api = async (path, init = {}, token) => {
  const res = await fetch(D + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const login = await api('/auth/login', {
  method: 'POST',
  body: JSON.stringify({
    email: process.env.DIRECTUS_ADMIN_EMAIL,
    password: process.env.DIRECTUS_ADMIN_PASSWORD,
  }),
});
if (!login.body?.data?.access_token) {
  console.error('login failed — set DIRECTUS_ADMIN_EMAIL / DIRECTUS_ADMIN_PASSWORD');
  process.exit(1);
}
const token = login.body.data.access_token;

const rows = (await api('/items/tickets?limit=-1&fields=id,order_id,order_snapshot', {}, token))
  .body.data;

const todo = [];
let already = 0;
let noOrder = 0;
for (const t of rows) {
  const fromSnapshot = t.order_snapshot?.orderId;
  if (!fromSnapshot) {
    noOrder++;
    continue;
  }
  if (String(t.order_id ?? '') === String(fromSnapshot)) {
    already++;
    continue;
  }
  todo.push({ id: t.id, orderId: String(fromSnapshot) });
}

console.log(`tickets            : ${rows.length}`);
console.log(`already indexed    : ${already}`);
console.log(`no order attached  : ${noOrder}`);
console.log(`to backfill        : ${todo.length}`);

if (todo.length === 0) {
  console.log('\nnothing to do.');
  process.exit(0);
}
if (!WRITE) {
  console.log('\nDRY RUN — nothing written. Re-run with --write.');
  process.exit(0);
}

let ok = 0;
let failed = 0;
for (const t of todo) {
  const res = await api(
    `/items/tickets/${t.id}`,
    { method: 'PATCH', body: JSON.stringify({ order_id: t.orderId }) },
    token,
  );
  if (res.status < 400) ok++;
  else {
    failed++;
    console.log(`  ! ${t.id}: HTTP ${res.status}`);
  }
}
const after = (await api('/items/tickets?limit=-1&fields=order_id,order_snapshot', {}, token)).body
  .data;
const missed = after.filter((t) => t.order_snapshot?.orderId && !t.order_id).length;
console.log(`\nbackfilled: ${ok}   failed: ${failed}   still unindexed: ${missed}`);
