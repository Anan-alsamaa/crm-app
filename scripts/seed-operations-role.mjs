/**
 * Create the Operations role.
 *
 *   node scripts/seed-operations-role.mjs            # dry run
 *   node scripts/seed-operations-role.mjs --write
 *
 * Operations is a NEW role alongside Area Manager and Chain Manager, not a
 * rename of either. Those two are territory roles — they own a brand or a set
 * of branches and read the tickets belonging to them. Operations is not fenced
 * to anywhere: it reads the whole register and takes a copy of it, and that is
 * all it does.
 *
 * Exactly three privileges, and the omissions are the design:
 *
 *   view_dashboard    the Operations tab of the dashboard.
 *   view_all_tickets  Reports -> Operational KPI -> Ticket breakdown, and the
 *                     Tickets entry in the top bar that leads to it.
 *   export_data       Export CSV.
 *
 * NOT edit_all_tickets, so no History button. NOT delete_tickets, so no Delete.
 * NOT import_data, so no Import file. NOT approve_coupons, so the Compensation
 * tab beside Ticket breakdown does not appear and neither does the approvals
 * queue. NOT manage_lists, so Scheduled reports, SLA and AI stay out of the nav.
 *
 * None of that is the security boundary — the app-roles-sync extension turns
 * this row into real Directus permissions, and those are. The privileges decide
 * what the portal OFFERS, so nobody is shown work their role cannot do.
 *
 * Idempotent: an existing Operations row is left alone unless --force is given,
 * because somebody may have adjusted it deliberately.
 */
const DIRECTUS = process.env.DIRECTUS_URL ?? 'http://127.0.0.1:8055';
const EMAIL = process.env.DIRECTUS_ADMIN_EMAIL ?? 'e.habibi@anan.sa';
const PASSWORD = process.env.DIRECTUS_ADMIN_PASSWORD ?? '123456';

const WRITE = process.argv.includes('--write');
const FORCE = process.argv.includes('--force');

const ROLE = {
  name: 'Operations',
  description:
    'Reads the ticket register and exports it. No editing, no deleting, no importing, no coupon decisions. Not fenced to a brand — for that use Area Manager or Chain Manager.',
  privileges: {
    view_dashboard: true,
    view_all_tickets: true,
    export_data: true,
  },
  brands: null,
  stores: null,
};

async function json(res) {
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

const login = await json(
  await fetch(`${DIRECTUS}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  }),
);
const headers = {
  authorization: `Bearer ${login.data.access_token}`,
  'content-type': 'application/json',
};

const existing = await json(
  await fetch(
    `${DIRECTUS}/items/app_roles?filter[name][_eq]=${encodeURIComponent(ROLE.name)}&fields=id,name,privileges,directus_role`,
    { headers },
  ),
);
const found = existing.data?.[0];

if (found && !FORCE) {
  const on = Object.entries(found.privileges ?? {})
    .filter(([, v]) => v)
    .map(([k]) => k);
  console.log(`Operations already exists (${found.id}).`);
  console.log(`  privileges: ${on.join(', ') || '(none)'}`);
  console.log(`  directus role: ${found.directus_role ?? 'NOT MATERIALISED'}`);
  console.log('Left as-is. Pass --force to overwrite it with the definition in this script.');
  process.exit(0);
}

if (!WRITE) {
  console.log(found ? 'Would OVERWRITE the Operations role with:' : 'Would CREATE the role:');
  console.log(JSON.stringify(ROLE, null, 2));
  console.log('\nRe-run with --write to apply.');
  process.exit(0);
}

const saved = found
  ? await json(
      await fetch(`${DIRECTUS}/items/app_roles/${found.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(ROLE),
      }),
    )
  : await json(
      await fetch(`${DIRECTUS}/items/app_roles`, {
        method: 'POST',
        headers,
        body: JSON.stringify(ROLE),
      }),
    );

console.log(`${found ? 'Updated' : 'Created'} Operations (${saved.data.id}).`);

/*
 * The extension materialises the row into a real Directus role + policy +
 * permissions. It does that in an ACTION hook, which Directus runs after the
 * response has already been sent — so reading straight back reports "not
 * materialised" on a run that worked perfectly. Poll instead of guessing.
 */
let materialised = null;
for (let i = 0; i < 20 && !materialised; i++) {
  const after = await json(
    await fetch(`${DIRECTUS}/items/app_roles/${saved.data.id}?fields=directus_role`, { headers }),
  );
  materialised = after.data.directus_role;
  if (!materialised) await new Promise((r) => setTimeout(r, 500));
}
console.log(
  materialised
    ? `Materialised as Directus role ${materialised}.`
    : 'WARNING: still no directus_role after 10s — the app-roles-sync extension did not run. Check the Directus logs.',
);
