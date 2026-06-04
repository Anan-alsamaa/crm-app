/**
 * Playwright globalSetup: seeds a test agent in Directus so the E2E specs
 * don't need to be skip-gated. Reads owner creds from env or falls back to
 * the local dev defaults; exports E2E_AGENT_* for the tests to consume.
 */
const DIRECTUS = process.env.DIRECTUS_URL ?? 'http://localhost:8055';
const OWNER_EMAIL = process.env.E2E_OWNER_EMAIL ?? 'e.habibi@anan.sa';
const OWNER_PASSWORD = process.env.E2E_OWNER_PASSWORD ?? '123456';
const AGENT_EMAIL = process.env.E2E_AGENT_EMAIL ?? 'e2e.agent@example.com';
const AGENT_PASSWORD = process.env.E2E_AGENT_PASSWORD ?? 'E2eAgentPass1!';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  return (await res.json()) as T;
}

/**
 * fetch with a hard timeout. A Directus that accepts the TCP connection but
 * never responds would otherwise leave the request pending forever, hanging
 * globalSetup (and the whole E2E job) with no per-test timeout to rescue it.
 */
async function fetchT(url: string, init: RequestInit = {}, ms = 15_000): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

export default async function globalSetup(): Promise<void> {
  // 1. Sign in as the project owner.
  const login = await json<{ data: { access_token: string } }>(
    await fetchT(`${DIRECTUS}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
    }),
  );
  const ownerToken = login.data.access_token;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` };

  // 2. Resolve the Agent role.
  const roles = await json<{ data: Array<{ id: string; name: string }> }>(
    await fetchT(`${DIRECTUS}/roles?filter[name][_eq]=Agent&fields=id,name&limit=1`, { headers }),
  );
  const agentRoleId = roles.data[0]?.id;
  if (!agentRoleId) throw new Error('Agent role not found in Directus — run the bootstrap first.');

  // 3. Ensure a test agent user exists with the known creds.
  const found = await json<{ data: Array<{ id: string }> }>(
    await fetchT(
      `${DIRECTUS}/users?filter[email][_eq]=${encodeURIComponent(AGENT_EMAIL)}&fields=id&limit=1`,
      { headers },
    ),
  );
  if (!found.data[0]) {
    await json(
      await fetchT(`${DIRECTUS}/users`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          email: AGENT_EMAIL,
          password: AGENT_PASSWORD,
          first_name: 'E2E',
          last_name: 'Agent',
          role: agentRoleId,
          status: 'active',
        }),
      }),
    );
    console.log(`[e2e-setup] created agent user ${AGENT_EMAIL}`);
  } else {
    await json(
      await fetchT(`${DIRECTUS}/users/${found.data[0].id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ password: AGENT_PASSWORD, role: agentRoleId, status: 'active' }),
      }),
    );
    console.log(`[e2e-setup] refreshed agent user ${AGENT_EMAIL}`);
  }

  // 4. Sign the agent in once to obtain a usable session for tests that need
  //    to pre-populate localStorage (skips the UI login).
  const agentSession = await json<{
    data: { access_token: string; refresh_token: string; expires: number };
  }>(
    await fetchT(`${DIRECTUS}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: AGENT_EMAIL, password: AGENT_PASSWORD }),
    }),
  );

  process.env.E2E_AGENT_EMAIL = AGENT_EMAIL;
  process.env.E2E_AGENT_PASSWORD = AGENT_PASSWORD;
  process.env.E2E_AGENT_ACCESS_TOKEN = agentSession.data.access_token;
  process.env.E2E_AGENT_REFRESH_TOKEN = agentSession.data.refresh_token;
  process.env.E2E_AGENT_EXPIRES = String(agentSession.data.expires);
}
