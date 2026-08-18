/**
 * Put the agent portal login back to what the docs say it is.
 *
 *   node scripts/fix-agent-login.mjs
 *
 * Why this exists: the agent account's password has repeatedly stopped working,
 * and the cause is not yet understood — the password stops matching with no
 * `update` row in `directus_activity` to explain it. Until that is found, this
 * is a ten-second fix instead of a blocked afternoon.
 *
 * The symptom is unmistakable: every route in the agent portal bounces to
 * /login. `node tools/ui-audit/index.mjs` names it directly.
 *
 * Test runs can no longer be the cause — the Playwright suite owns
 * `e2e-runner@example.com` and never touches this account.
 */
const DIRECTUS = process.env.DIRECTUS_URL ?? 'http://127.0.0.1:8055';
const OWNER_EMAIL = process.env.DIRECTUS_ADMIN_EMAIL ?? 'e.habibi@anan.sa';
const OWNER_PASSWORD = process.env.DIRECTUS_ADMIN_PASSWORD ?? '123456';
const AGENT_EMAIL = process.env.AGENT_EMAIL ?? 'e2e.agent@example.com';
const AGENT_PASSWORD = process.env.AGENT_PASSWORD ?? 'Agent12345!';

async function json(res) {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const login = await json(
  await fetch(`${DIRECTUS}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
  }),
);
const headers = {
  authorization: `Bearer ${login.data.access_token}`,
  'content-type': 'application/json',
};

const found = await json(
  await fetch(
    `${DIRECTUS}/users?filter[email][_eq]=${encodeURIComponent(AGENT_EMAIL)}&fields=id,status&limit=1`,
    { headers },
  ),
);
const user = found.data[0];
if (!user) {
  console.error(`No such user: ${AGENT_EMAIL}`);
  process.exit(1);
}

// Status as well as password: an inactive account fails login the same way, and
// checking one without the other sends you round the loop twice.
await json(
  await fetch(`${DIRECTUS}/users/${user.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ password: AGENT_PASSWORD, status: 'active' }),
  }),
);

// Prove it, rather than reporting success because the write returned 200.
const check = await fetch(`${DIRECTUS}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: AGENT_EMAIL, password: AGENT_PASSWORD }),
});
if (!check.ok) {
  console.error(`Reset was written but the login still fails (${check.status}).`);
  console.error('Something other than the password is wrong — check the account in Directus.');
  process.exit(1);
}
console.log(`${AGENT_EMAIL} can sign in again.`);
