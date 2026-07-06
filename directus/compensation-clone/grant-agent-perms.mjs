/**
 * Grants the Agent role READ access to the compensation collections so ops
 * agents (non-admin) can see requests in the portal. Without this, the new
 * collections are admin-only and the portal shows an empty queue for agents.
 * Idempotent; looks the Agent role → policy up by name so it works in any env.
 * Flows run with their own accountability, so no per-flow grant is needed —
 * read on the 5 collections is what the portal needs.
 *
 *   node directus/compensation-clone/grant-agent-perms.mjs
 */
const LOCAL = process.env.DIRECTUS_URL ?? 'http://localhost:8055';
const EMAIL = process.env.DIRECTUS_ADMIN_EMAIL ?? 'e.habibi@anan.sa';
const PASSWORD = process.env.DIRECTUS_ADMIN_PASSWORD ?? '123456';
const ROLE_NAME = process.env.AGENT_ROLE_NAME ?? 'Agent';

const COLLECTIONS = [
  'compensation_requests',
  'Compensation_Request_items',
  'Com_Coupons',
  'com_issues_list',
  'Com_Issue_Categories',
];

let TOKEN;
async function login() {
  const r = await fetch(`${LOCAL}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  TOKEN = (await r.json()).data.access_token;
}
async function api(method, path, body) {
  const r = await fetch(`${LOCAL}${path}`, {
    method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let json; try { json = txt ? JSON.parse(txt) : null; } catch { json = txt; }
  return { ok: r.ok, status: r.status, json };
}

await login();

// Agent role → its (non-admin) policy.
const roles = (await api('GET', `/roles?fields=id,name&filter[name][_eq]=${encodeURIComponent(ROLE_NAME)}&limit=1`)).json.data;
if (!roles?.length) { console.log(`role "${ROLE_NAME}" not found — nothing to do`); process.exit(0); }
const roleId = roles[0].id;
const role = (await api('GET', `/roles/${roleId}?fields=name,policies.policy.id,policies.policy.admin_access`)).json.data;
const policy = (role.policies || []).map((p) => p.policy).find((p) => p && !p.admin_access) || (role.policies || [])[0]?.policy;
if (!policy) { console.log('no policy on Agent role'); process.exit(1); }
console.log(`Agent policy: ${policy.id}`);

// Existing read perms for this policy.
const existing = (await api('GET', `/permissions?fields=collection,action&filter[policy][_eq]=${policy.id}&limit=-1`)).json.data || [];
const has = (c) => existing.some((p) => p.collection === c && p.action === 'read');

for (const collection of COLLECTIONS) {
  if (has(collection)) { console.log(`= read ${collection} already granted`); continue; }
  const r = await api('POST', '/permissions', {
    policy: policy.id,
    collection,
    action: 'read',
    fields: ['*'],
    permissions: {},
    validation: {},
  });
  console.log(`${r.ok ? '+' : '✗'} read ${collection} (${r.status})${r.ok ? '' : ' ' + JSON.stringify(r.json).slice(0, 200)}`);
}
console.log('agent read permissions applied.');
