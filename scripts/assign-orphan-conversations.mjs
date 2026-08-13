/**
 * Give every open conversation an owner.
 *
 * The routing ladder now never leaves a chat unassigned, but chats that arrived
 * before that change — or that the old ladder "released to all" — are still
 * sitting with nobody. Those are exactly the ones at risk: nobody is looking at
 * a queue they do not own.
 *
 * Each orphan goes to the agent (on its team, if it has one) currently holding
 * the fewest open conversations, and the counts update as it goes so a hundred
 * orphans spread across the team instead of landing on one person.
 *
 * Dry run by default; pass --write to apply.
 *
 *   node scripts/assign-orphan-conversations.mjs
 *   node scripts/assign-orphan-conversations.mjs --write
 */
const WRITE = process.argv.includes('--write');
const DIRECTUS = process.env.DIRECTUS_URL ?? 'http://localhost:8055';
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
const get = async (p) => (await (await fetch(`${DIRECTUS}${p}`, { headers: H })).json()).data;

const users = await get(
  '/users?filter[status][_eq]=active&fields=id,first_name,email,team&limit=-1',
);
if (users.length === 0) throw new Error('no active users — nobody to assign to');

const openConvos = await get(
  '/items/conversations?filter[status][_eq]=open&fields=id,assigned_agent,assigned_team&limit=-1',
);

// Current load, so the spread starts from reality rather than from zero.
const load = new Map(users.map((u) => [u.id, 0]));
for (const c of openConvos) {
  if (c.assigned_agent && load.has(c.assigned_agent)) {
    load.set(c.assigned_agent, load.get(c.assigned_agent) + 1);
  }
}

const orphans = openConvos.filter((c) => !c.assigned_agent);
console.log(
  `${openConvos.length} open conversations, ${orphans.length} with no owner${WRITE ? '' : ' (dry run)'}`,
);

const name = (id) => {
  const u = users.find((x) => x.id === id);
  return u?.first_name ?? u?.email ?? id;
};

let assigned = 0;
let noCandidate = 0;

for (const c of orphans) {
  const pool = c.assigned_team ? users.filter((u) => u.team === c.assigned_team) : users;
  if (pool.length === 0) {
    noCandidate += 1;
    console.warn(`  ! ${c.id}: team ${c.assigned_team} has no agents`);
    continue;
  }
  const pick = [...pool].sort(
    (a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0) || a.id.localeCompare(b.id),
  )[0];
  if (WRITE) {
    const res = await fetch(`${DIRECTUS}/items/conversations/${c.id}`, {
      method: 'PATCH',
      headers: H,
      body: JSON.stringify({ assigned_agent: pick.id }),
    });
    if (!res.ok) {
      console.warn(`  ! ${c.id}: PATCH ${res.status}`);
      continue;
    }
  }
  load.set(pick.id, (load.get(pick.id) ?? 0) + 1);
  assigned += 1;
  console.log(`  ${WRITE ? 'assigned' : 'would assign'} ${c.id} -> ${name(pick.id)}`);
}

console.log(`\n${WRITE ? 'assigned' : 'would assign'}: ${assigned}\nno candidate: ${noCandidate}`);
console.log('\nresulting open-chat load per agent:');
for (const [id, n] of [...load].sort((a, b) => b[1] - a[1])) {
  if (n > 0) console.log(`  ${name(id)}: ${n}`);
}
if (!WRITE) console.log('\nRe-run with --write to apply.');
