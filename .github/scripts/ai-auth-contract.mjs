/**
 * AI/commerce auth-contract integration test (C-1 / C-2).
 *
 * Runs against a REAL Directus + a running ai-gateway (see the `auth-contract`
 * CI job). Verifies the post-fix contract end-to-end — the parts unit tests with
 * mocks can't cover: the gateway actually verifying a Directus session token
 * (/users/me) and resolving admin roles (/roles) against live Directus.
 *
 * Asserts:
 *   1. No / bad Bearer token              → 401 (no static browser token works)
 *   2. Valid agent SESSION token          → not 401 (404 conversation_not_found)
 *   3. Commerce proxy, agent session      → 200 (key stays server-side)
 *   4. Agent session hitting /admin/config → 403 (role derived server-side)
 *   5. Admin/owner session → /admin/config → 200 (admin role detected via /roles)
 *
 * Exits non-zero on any failed assertion.
 */
const DIRECTUS = process.env.DIRECTUS_URL ?? 'http://localhost:8055';
const AI = process.env.AI_URL ?? 'http://localhost:8091';
const OWNER_EMAIL = process.env.DIRECTUS_ADMIN_EMAIL ?? 'e.habibi@anan.sa';
const OWNER_PASSWORD = process.env.DIRECTUS_ADMIN_PASSWORD ?? '123456';
const AGENT_EMAIL = 'ai-contract.agent@example.com';
const AGENT_PASSWORD = 'AiContractPass1!';
const SOME_UUID = '00000000-0000-0000-0000-000000000000';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function login(email, password) {
  const res = await fetch(`${DIRECTUS}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login ${email} failed: ${res.status} ${await res.text()}`);
  return (await res.json()).data.access_token;
}

async function ensureAgent(ownerToken) {
  const h = { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` };
  const roleRes = await fetch(`${DIRECTUS}/roles?filter[name][_eq]=Agent&fields=id&limit=1`, {
    headers: h,
  });
  const roleId = (await roleRes.json()).data?.[0]?.id;
  if (!roleId) throw new Error('Agent role not found — run the bootstrap first');
  const found = await fetch(
    `${DIRECTUS}/users?filter[email][_eq]=${encodeURIComponent(AGENT_EMAIL)}&fields=id&limit=1`,
    { headers: h },
  );
  const existing = (await found.json()).data?.[0]?.id;
  const body = JSON.stringify({
    email: AGENT_EMAIL,
    password: AGENT_PASSWORD,
    role: roleId,
    status: 'active',
    first_name: 'AI',
    last_name: 'Contract',
  });
  if (existing) {
    await fetch(`${DIRECTUS}/users/${existing}`, { method: 'PATCH', headers: h, body });
  } else {
    const c = await fetch(`${DIRECTUS}/users`, { method: 'POST', headers: h, body });
    if (!c.ok) throw new Error(`create agent failed: ${c.status} ${await c.text()}`);
  }
}

async function status(path, init = {}) {
  const res = await fetch(`${AI}${path}`, init);
  return res.status;
}
const bearer = (t) => ({ authorization: `Bearer ${t}` });
const postJson = (t, body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(t ? bearer(t) : {}) },
  body: JSON.stringify(body),
});

async function main() {
  console.log(`AI auth-contract test → Directus ${DIRECTUS}, ai-gateway ${AI}`);
  const ownerToken = await login(OWNER_EMAIL, OWNER_PASSWORD);
  await ensureAgent(ownerToken);
  const agentToken = await login(AGENT_EMAIL, AGENT_PASSWORD);

  // 1. No / bad token → 401
  check(
    'no token → 401',
    (await status('/summarize-conversation', postJson(null, { conversationId: SOME_UUID }))) ===
      401,
  );
  check(
    'bad token → 401',
    (await status(
      '/summarize-conversation',
      postJson('not-a-session', { conversationId: SOME_UUID }),
    )) === 401,
  );

  // 2. Valid agent session → past auth (404 conversation_not_found, NOT 401)
  const s = await status(
    '/summarize-conversation',
    postJson(agentToken, { conversationId: SOME_UUID }),
  );
  check('agent session accepted (not 401)', s !== 401, `status=${s}`);
  check('agent session → 404 conversation_not_found', s === 404, `status=${s}`);

  // 3. Commerce proxy with agent session → 200 (mock client; no token in browser)
  const c = await status(`/commerce/activity?vendorId=v1&customerId=c1`, {
    headers: bearer(agentToken),
  });
  check('commerce proxy agent session → 200', c === 200, `status=${c}`);
  check(
    'commerce proxy no token → 401',
    (await status('/commerce/activity?vendorId=v1&customerId=c1')) === 401,
  );

  // 4. Agent (non-admin) → /admin/config → 403 (spoofing a header can't help)
  const a1 = await status('/admin/config', {
    headers: { ...bearer(agentToken), 'x-yiji-admin': '1' },
  });
  check('agent → /admin/config → 403 (header ignored)', a1 === 403, `status=${a1}`);

  // 5. Owner (admin role) → /admin/config → 200 (proves /roles lookup works)
  const a2 = await status('/admin/config', { headers: bearer(ownerToken) });
  check('admin → /admin/config → 200', a2 === 200, `status=${a2}`);

  console.log(
    failures === 0 ? '\nAll auth-contract checks passed.' : `\n${failures} check(s) FAILED.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('auth-contract test error:', err);
  process.exit(1);
});
