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

  // 5. Seed open conversations directly via the Directus API so the inbox/ticket
  //    specs have deterministic data and don't have to drive the (timing-flaky)
  //    chat widget just to create something to act on. Two conversations so the
  //    bulk-select spec has more than one row. demo-vendor is created by the CI
  //    "Seed demo vendor" step before this runs (and exists locally by hand).
  try {
    const vendorRes = await json<{ data: Array<{ id: string }> }>(
      await fetchT(
        `${DIRECTUS}/items/vendors?filter[yiji_vendor_id][_eq]=demo-vendor&fields=id&limit=1`,
        { headers },
      ),
    );
    const vendorId = vendorRes.data[0]?.id;
    if (!vendorId) {
      console.warn('[e2e-setup] demo-vendor not found — skipping conversation seed');
    } else {
      const stamp = process.env.E2E_AGENT_EXPIRES ?? '0';
      for (let i = 1; i <= 2; i++) {
        const contact = await json<{ data: { id: string } }>(
          await fetchT(`${DIRECTUS}/items/contacts`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              vendor: vendorId,
              external_customer_id: `e2e-seed-${i}-${stamp}`,
              name: `E2E Seed ${i}`,
            }),
          }),
        );
        const convo = await json<{ data: { id: string } }>(
          await fetchT(`${DIRECTUS}/items/conversations`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              vendor: vendorId,
              contact: contact.data.id,
              status: 'open',
              priority: 'medium',
              unread_count_agent: 1,
              last_message_at: new Date().toISOString(),
            }),
          }),
        );
        await json(
          await fetchT(`${DIRECTUS}/items/messages`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              conversation: convo.data.id,
              sender_type: 'customer',
              sender_contact: contact.data.id,
              content: `E2E seed message ${i}`,
              is_internal_note: false,
            }),
          }),
        );
      }
      console.log('[e2e-setup] seeded 2 open conversations for demo-vendor');

      // Canonical "Demo Customer" (external_customer_id 'demo-customer-1') used by
      // the US6 contact-profile + US7 custom-fields specs (gated on E2E_FULL_STACK).
      // MockYijiClient returns commerce data (lifetime value + orders) for this id
      // under demo-vendor, so the commerce panel renders without a real Yiji
      // backend. Idempotent: fixed external id, so create-once across runs.
      const demoExt = 'demo-customer-1';
      const demoFound = await json<{ data: Array<{ id: string }> }>(
        await fetchT(
          `${DIRECTUS}/items/contacts?filter[vendor][_eq]=${vendorId}&filter[external_customer_id][_eq]=${demoExt}&fields=id&limit=1`,
          { headers },
        ),
      );
      let demoContactId = demoFound.data[0]?.id;
      if (!demoContactId) {
        const demoContact = await json<{ data: { id: string } }>(
          await fetchT(`${DIRECTUS}/items/contacts`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              vendor: vendorId,
              external_customer_id: demoExt,
              name: 'Demo Customer',
              email: 'demo@example.com',
            }),
          }),
        );
        demoContactId = demoContact.data.id;
      }
      const demoConvo = await json<{ data: Array<{ id: string }> }>(
        await fetchT(
          `${DIRECTUS}/items/conversations?filter[contact][_eq]=${demoContactId}&fields=id&limit=1`,
          { headers },
        ),
      );
      if (!demoConvo.data[0]) {
        await json(
          await fetchT(`${DIRECTUS}/items/conversations`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              vendor: vendorId,
              contact: demoContactId,
              status: 'open',
              priority: 'medium',
              unread_count_agent: 1,
              last_message_at: new Date().toISOString(),
            }),
          }),
        );
      }
      console.log('[e2e-setup] ensured Demo Customer contact + conversation');
    }
  } catch (err) {
    console.warn('[e2e-setup] conversation seed failed (specs may fall back):', err);
  }
}
