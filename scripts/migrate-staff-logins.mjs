/**
 * Give existing staff a login name (employee ID) and a display name.
 *
 * Sign-in identities used to be real email addresses. New accounts mint theirs
 * from the employee id instead (`4417` → `4417@staff.example.com`), and this brings
 * the accounts that predate that across so everyone signs in the same way.
 *
 * WHO IS MOVED, and who deliberately is not:
 *
 *   - Agent accounts: moved. Their employee id is taken from the local part of
 *     their existing address, so `ali@yiji.example.com` becomes login name
 *     `ali`. Passwords are untouched — they sign in with the same password and
 *     a shorter name.
 *   - The ADMINISTRATOR: left alone. Its address is referenced by every
 *     provisioning script, the bootstrap, and the seeders; changing it would
 *     break all of them to save one person a few keystrokes.
 *   - SERVICE accounts (`@svc.`): left alone. They are not people and never
 *     type anything.
 *   - The E2E runner: left alone. The test suite signs in as it by address.
 *
 * Names are untouched: the name shown in the portal is a person's FIRST name,
 * which every account already has.
 *
 * Dry-run by default.
 *   node scripts/migrate-staff-logins.mjs           # say what it would do
 *   node scripts/migrate-staff-logins.mjs --write   # do it
 */
const D = process.env.DIRECTUS_URL ?? 'http://localhost:8055';
const WRITE = process.argv.includes('--write');
const STAFF_DOMAIN = 'staff.example.com';

/** Addresses that must keep working exactly as they are — see above. */
const KEEP = [/@svc\./i, /^e\.habibi@/i, /^e2e-runner@/i, /^e2e\.agent@/i];

const login = await fetch(`${D}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: process.env.DIRECTUS_ADMIN_EMAIL,
    password: process.env.DIRECTUS_ADMIN_PASSWORD,
  }),
});
if (!login.ok) {
  console.error(`Could not sign in to Directus at ${D}. Set DIRECTUS_ADMIN_EMAIL/PASSWORD.`);
  process.exit(1);
}
const AT = (await login.json()).data.access_token;
const H = { authorization: `Bearer ${AT}`, 'content-type': 'application/json' };

const users = (
  await (
    await fetch(`${D}/users?fields=id,email,first_name,last_name,login_name&limit=-1`, {
      headers: H,
    })
  ).json()
).data;

let moved = 0;

for (const u of users) {
  const email = u.email ?? '';
  const patch = {};

  const keep = KEEP.some((re) => re.test(email));
  const already = email.toLowerCase().endsWith(`@${STAFF_DOMAIN}`);
  if (!keep && !already && email.includes('@') && !u.login_name) {
    const loginName = email.split('@')[0].toLowerCase();
    patch.login_name = loginName;
    patch.email = `${loginName}@${STAFF_DOMAIN}`;
    moved++;
    console.log(`  ${email}  ->  signs in as "${loginName}"`);
  }

  if (Object.keys(patch).length === 0) continue;
  if (WRITE) {
    const res = await fetch(`${D}/users/${u.id}`, {
      method: 'PATCH',
      headers: H,
      body: JSON.stringify(patch),
    });
    if (!res.ok) console.error(`  failed on ${email}: ${res.status} ${await res.text()}`);
  }
}

console.log(
  WRITE
    ? `Moved ${moved} account(s) to employee-ID sign-in. Passwords unchanged.`
    : `Dry run: would move ${moved} account(s). Add --write to apply.`,
);
