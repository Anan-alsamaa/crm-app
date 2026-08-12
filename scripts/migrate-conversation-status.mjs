/**
 * Migrate chat status from four values to two: open | solved.
 *
 *   pending  -> open      (still being worked)
 *   resolved -> solved
 *   closed   -> solved
 *
 * Run this whenever a database predates the two-state change. Narrowing the
 * enum without it leaves rows holding a value no filter matches, so those
 * conversations disappear from the inbox instead of erroring — the failure is
 * silent, which is why this is a script and not a note.
 *
 * Idempotent: rows already on open/solved are left alone, so re-running is
 * safe and reports 0.
 *
 *   node scripts/migrate-conversation-status.mjs           # dry run
 *   node scripts/migrate-conversation-status.mjs --write
 */
const D = process.env.DIRECTUS_URL || 'http://127.0.0.1:8055';
const WRITE = process.argv.includes('--write');
const MAP = { pending: 'open', resolved: 'solved', closed: 'solved' };

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

const rows = (await api('/items/conversations?limit=-1&fields=id,status', {}, token)).body.data;
const counts = {};
for (const r of rows) counts[r.status ?? 'null'] = (counts[r.status ?? 'null'] ?? 0) + 1;

console.log(`conversations: ${rows.length}`);
for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(10)} ${v}`);

const todo = rows.filter((r) => MAP[r.status]);
console.log(`\nto migrate: ${todo.length}`);
if (todo.length === 0) {
  console.log('nothing to do.');
  process.exit(0);
}
for (const [from, to] of Object.entries(MAP)) {
  const n = todo.filter((r) => r.status === from).length;
  if (n) console.log(`  ${from} -> ${to}: ${n}`);
}

if (!WRITE) {
  console.log('\nDRY RUN — nothing written. Re-run with --write.');
  process.exit(0);
}

let ok = 0;
let failed = 0;
for (const r of todo) {
  const res = await api(
    `/items/conversations/${r.id}`,
    { method: 'PATCH', body: JSON.stringify({ status: MAP[r.status] }) },
    token,
  );
  if (res.status < 400) ok++;
  else {
    failed++;
    console.log(`  ! ${r.id}: HTTP ${res.status}`);
  }
}
const after = (await api('/items/conversations?limit=-1&fields=status', {}, token)).body.data;
const left = after.filter((r) => MAP[r.status]).length;
console.log(`\nmigrated: ${ok}   failed: ${failed}   still on a retired value: ${left}`);
