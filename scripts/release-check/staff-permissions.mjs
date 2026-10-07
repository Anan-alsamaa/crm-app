#!/usr/bin/env node
/**
 * RELEASE CHECK (STAGING ONLY) — what a real WeCare Agent can and cannot do.
 *
 * EMA-56 (2026-10-06) moved every action onto the Roles page and split the
 * database grants; a gateway endpoint gated on old role NAMES once refused
 * every WeCare user for weeks without anybody noticing (notify-assignment,
 * least-loaded — fixed 2026-10-07). This signs in as a THROWAWAY WeCare Agent
 * and checks the everyday actions still work and the forbidden ones stay
 * refused. Everything it creates is deleted at the end.
 *
 * Refuses to run against anything but staging: it creates a user.
 *
 *   E=<admin email> P=<admin password> node scripts/release-check/staff-permissions.mjs
 */
import crypto from 'node:crypto';

const API = 'https://crm-api-staging.anan.sa';
const GW = API; // the gateway is path-routed on the same host
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const login = async (email, password) =>
  (
    await (
      await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
    ).json()
  )?.data?.access_token;
const call = async (token, method, path, body) => {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => null);
  return { status: r.status, data: j?.data, err: j?.errors?.[0]?.message };
};

const admin = await login(process.env.E, process.env.P);
if (!admin) throw new Error('admin login failed');
const role = (await call(admin, 'GET', '/roles?filter[name][_eq]=WeCare%20Agent&fields=id')).data[0];
const vendor = (await call(admin, 'GET', '/items/vendors?limit=1&fields=id')).data[0];
const pw = crypto.randomBytes(12).toString('hex') + 'A1!';
const email = `perm-check-${Date.now()}@staff.example.com`;
const user = await call(admin, 'POST', '/users', {
  email,
  password: pw,
  role: role.id,
  first_name: 'Permission',
  last_name: 'Check',
  status: 'active',
});
const created = { user: user.data?.id, contacts: [], conv: null };
try {
  const agent = await login(email, pw);
  check('test WeCare Agent signs in', !!agent);
  const contact = await call(admin, 'POST', '/items/contacts', {
    vendor: vendor.id,
    name: 'Permission check',
    phone: '0500000' + String(Date.now()).slice(-3),
  });
  created.contacts.push(contact.data?.id);
  const conv = await call(admin, 'POST', '/items/conversations', {
    vendor: vendor.id,
    contact: contact.data?.id,
    status: 'open',
  });
  created.conv = conv.data?.id;

  const c = created.conv;
  let r = await call(agent, 'PATCH', `/items/conversations/${c}`, { assigned_agent: created.user });
  check('agent assigns a chat (assign_chats)', r.status === 200, `HTTP ${r.status} ${r.err ?? ''}`);
  r = await call(agent, 'PATCH', `/items/conversations/${c}`, { priority: 'high' });
  check('agent sets priority (base columns)', r.status === 200, `HTTP ${r.status} ${r.err ?? ''}`);
  r = await call(agent, 'PATCH', `/items/conversations/${c}`, {
    status: 'solved',
    solved_at: new Date().toISOString(),
  });
  check('agent closes a chat (close_chats)', r.status === 200, `HTTP ${r.status} ${r.err ?? ''}`);
  r = await call(agent, 'PATCH', `/items/conversations/${c}`, { status: 'open', solved_at: null });
  check('agent reopens a chat (close_chats)', r.status === 200, `HTTP ${r.status} ${r.err ?? ''}`);
  r = await call(agent, 'PATCH', `/items/conversations/${c}`, { vendor: vendor.id });
  check('a column no portal writes is refused', r.status === 403, `HTTP ${r.status}`);
  r = await call(agent, 'DELETE', `/items/conversations/${c}`);
  check('agent cannot delete a chat (delete_chats off)', r.status === 403, `HTTP ${r.status}`);

  r = await call(agent, 'POST', '/items/contacts', {
    vendor: vendor.id,
    name: 'Permission check 2',
    phone: '0500001' + String(Date.now()).slice(-3),
  });
  created.contacts.push(r.data?.id);
  check('agent adds a customer (create_contacts)', r.status === 200, `HTTP ${r.status} ${r.err ?? ''}`);
  r = await call(agent, 'PATCH', `/items/contacts/${created.contacts[0]}`, { name: 'Permission check (edited)' });
  check('agent edits a customer (edit_contacts)', r.status === 200, `HTTP ${r.status} ${r.err ?? ''}`);

  r = await call(agent, 'DELETE', `/users/${created.user}`);
  check('agent cannot delete users', r.status === 403, `HTTP ${r.status}`);

  // The gateway now decides by permission. A WeCare Agent holds no import_data.
  const imp = await fetch(`${GW}/jobs/import`, {
    method: 'POST',
    headers: { authorization: `Bearer ${agent}`, 'content-type': 'application/json' },
    body: '{}',
  });
  check('gateway refuses import to a role without import_data', imp.status === 403, `HTTP ${imp.status}`);
  const impAdmin = await fetch(`${GW}/jobs/import`, {
    method: 'POST',
    headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
    body: '{}',
  });
  check(
    'gateway lets the Administrator past the permission check (400 = payload, not 403)',
    impAdmin.status === 400,
    `HTTP ${impAdmin.status}`,
  );

  // Endpoints that used to name roles (fixed 2026-10-07): a WeCare Agent may
  // notify an assignee and ask who on a team should take a chat.
  const notify = await fetch(`${GW}/jobs/notify-assignment`, {
    method: 'POST',
    headers: { authorization: `Bearer ${agent}`, 'content-type': 'application/json' },
    body: JSON.stringify({ entityType: 'conversation', entityId: created.conv }),
  });
  check('agent may notify an assignee (not 403)', notify.status === 200, `HTTP ${notify.status}`);
  const team = (await call(admin, 'GET', '/items/teams?limit=1&fields=id')).data?.[0];
  if (team) {
    const ll = await fetch(`${GW}/teams/${team.id}/least-loaded`, {
      headers: { authorization: `Bearer ${agent}` },
    });
    check('agent may ask who on a team takes a chat (not 403)', ll.status === 200, `HTTP ${ll.status}`);
  }
} finally {
  if (created.conv) await call(admin, 'DELETE', `/items/conversations/${created.conv}`);
  for (const id of created.contacts.filter(Boolean)) await call(admin, 'DELETE', `/items/contacts/${id}`);
  if (created.user) await call(admin, 'DELETE', `/users/${created.user}`);
  console.log('cleaned up');
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
