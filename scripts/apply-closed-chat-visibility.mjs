/**
 * Apply the closed-chat visibility rule to a live environment.
 *
 * Permissions do NOT travel through a deploy: the Directus image is built but
 * the bootstrap never runs, and the app-roles-sync extension only re-materialises
 * a role's rows when that role is saved. So a code change to
 * `ASSIGNED_UNASSIGNED_OR_SOLVED` reaches nothing until the existing permission
 * rows are rewritten — which is what this does.
 *
 * WHAT IT CHANGES, and nothing else: every `conversations.read` and
 * `messages.read` row whose filter is the three-way live scope gains a fourth
 * clause, `status _in [solved, resolved, closed]`.
 *
 *   - A row whose filter is already `{}` (unrestricted — `view_all_chats`, the
 *     service policies, Admin) is LEFT ALONE. It is already wider than this.
 *   - A row that already carries the status clause is LEFT ALONE, so re-running
 *     is safe and reports zero changes.
 *   - `update` rows are NEVER touched. The owner's call (2026-10-04) is that a
 *     closed chat must be fully workable, and the unscoped update already
 *     allows that; the live-scoped update rows stay exactly as they are.
 *
 * Dry run by default. ALWAYS run it dry first and read the plan — this edits
 * access control on a system that is in use.
 *
 *   DIRECTUS_URL=https://crm-api-staging.anan.sa \
 *   DIRECTUS_ADMIN_EMAIL=... DIRECTUS_ADMIN_PASSWORD=... \
 *   node scripts/apply-closed-chat-visibility.mjs
 *
 * Then again with --write.
 *
 * It prints the row COUNT before and after. A count that did not move when the
 * plan said it would is the signal that something silently refused — this
 * codebase has had a permission PATCH return 200 and change nothing.
 */
const WRITE = process.argv.includes('--write');
const DIRECTUS = process.env.DIRECTUS_URL ?? 'http://localhost:8055';
const EMAIL = process.env.DIRECTUS_ADMIN_EMAIL;
const PASSWORD = process.env.DIRECTUS_ADMIN_PASSWORD;
if (!EMAIL || !PASSWORD) throw new Error('set DIRECTUS_ADMIN_EMAIL and DIRECTUS_ADMIN_PASSWORD');

/** The clause being added. Must match the source in both declaring files. */
const SOLVED = { status: { _in: ['solved', 'resolved', 'closed'] } };

const login = await fetch(`${DIRECTUS}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!login.ok) throw new Error(`login failed: ${login.status}`);
const token = (await login.json()).data.access_token;
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

const get = async (path) => {
  const res = await fetch(`${DIRECTUS}${path}`, { headers: H });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()).data ?? [];
};

const policies = await get('/policies?fields=id,name&limit=-1');
const nameOf = new Map(policies.map((p) => [p.id, p.name]));

const perms = await get(
  '/permissions?filter[collection][_in]=conversations,messages&fields=id,collection,action,policy,permissions&limit=-1',
);

console.log(`${DIRECTUS}`);
console.log(`conversations+messages permission rows: ${perms.length}\n`);

/** Does this filter already carry the status clause anywhere in its `_or`? */
const hasSolved = (f) =>
  JSON.stringify(f ?? {}).includes('"status"') && JSON.stringify(f ?? {}).includes('solved');

/**
 * The three-way live scope, recognised by shape rather than by deep equality:
 * `conversations.read` carries it directly and `messages.read` carries it
 * nested under `conversation`, and both must gain the clause.
 */
const isLiveScope = (f) => {
  const s = JSON.stringify(f ?? {});
  return s.includes('assigned_agent') && s.includes('$CURRENT_USER') && !hasSolved(f);
};

const plan = [];
for (const p of perms) {
  if (p.action !== 'read') continue; // update rows are deliberately untouched
  const f = p.permissions;
  if (!f || Object.keys(f).length === 0) continue; // already unrestricted
  if (!isLiveScope(f)) continue;

  let next;
  if (Array.isArray(f._or)) {
    /* conversations.read — the clause is a sibling of the three existing ones. */
    next = { _or: [...f._or, SOLVED] };
  } else if (f.conversation && Array.isArray(f.conversation._or)) {
    /* messages.read — the scope is reached THROUGH the parent conversation, so
       the clause goes inside it. Without this a closed chat lists but opens
       empty, which reads as a broken chat rather than a permission. */
    next = { conversation: { _or: [...f.conversation._or, SOLVED] } };
  } else {
    console.warn(`  ? ${p.collection}.${p.action} (${p.id}) unrecognised shape — SKIPPED`);
    continue;
  }
  plan.push({ id: p.id, collection: p.collection, policy: p.policy, next });
}

if (plan.length === 0) {
  console.log('Nothing to change — every scoped read already carries the clause.');
  process.exit(0);
}

console.log(`${plan.length} row(s) to widen${WRITE ? '' : ' (dry run)'}:\n`);
for (const r of plan) {
  console.log(`  ${r.collection}.read  ${nameOf.get(r.policy) ?? r.policy}  (${r.id})`);
}

if (!WRITE) {
  console.log('\nRe-run with --write to apply.');
  process.exit(0);
}

let ok = 0;
for (const r of plan) {
  const res = await fetch(`${DIRECTUS}/permissions/${r.id}`, {
    method: 'PATCH',
    headers: H,
    body: JSON.stringify({ permissions: r.next }),
  });
  if (!res.ok) {
    console.warn(`  ! ${r.id}: ${res.status} ${await res.text()}`);
    continue;
  }
  ok += 1;
}

/*
 * VERIFY BY READING THE ROWS BACK, not by trusting the PATCH status. A 200 that
 * changed nothing is a failure mode this codebase has actually produced.
 */
const after = await get(
  '/permissions?filter[collection][_in]=conversations,messages&fields=id,collection,action,policy,permissions&limit=-1',
);
const carrying = after.filter((p) => p.action === 'read' && hasSolved(p.permissions));
console.log(`\npatched: ${ok}/${plan.length}`);
console.log(`read rows now carrying the clause: ${carrying.length}`);
for (const p of carrying) {
  console.log(`  ${p.collection}.read  ${nameOf.get(p.policy) ?? p.policy}`);
}
if (ok !== plan.length) process.exitCode = 1;
