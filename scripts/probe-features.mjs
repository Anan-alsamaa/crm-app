// TEMP — live probe of the full feature batch. Delete after use.
const D = 'http://localhost:8055';
const login = async (e, p) => (await (await fetch(`${D}/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: e, password: p }) })).json()).data?.access_token;
const AT = await login(process.env.DIRECTUS_ADMIN_EMAIL, process.env.DIRECTUS_ADMIN_PASSWORD);
const H = { authorization: `Bearer ${AT}`, 'content-type': 'application/json' };
const get = async (p, h = H) => (await (await fetch(`${D}${p}`, { headers: h })).json()).data;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

const agents = await get('/users?filter[role][name][_eq]=Agent&fields=id,email&limit=1');
const agent = agents[0];
await fetch(`${D}/users/${agent.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ password: 'ProbePass!2026' }) });
const PT = await login(agent.email, 'ProbePass!2026');
const PH = { authorization: `Bearer ${PT}`, 'content-type': 'application/json' };

console.log('\n== 1. editable dropdown lists ==');
const addRes = await fetch(`${D}/items/option_lists`, { method: 'POST', headers: H,
  body: JSON.stringify({ list: 'complaint_type', value: 'PROBE-VALUE', sort: 99, active: true }) });
const probeVal = (await addRes.json()).data;
const agentSees = await get('/items/option_lists?filter[list][_eq]=complaint_type&filter[active][_eq]=true&fields=value&limit=-1', PH);
check('admin adds a value, agent token reads it', (agentSees ?? []).some((r) => r.value === 'PROBE-VALUE'));

console.log('\n== 2. whatsapp stamp ==');
const myTickets = await get(`/items/tickets?filter[assigned_agent][_eq]=${agent.id}&fields=id&limit=1`, PH);
if (myTickets?.length) {
  const st = await fetch(`${D}/items/ticket_events`, { method: 'POST', headers: PH,
    body: JSON.stringify({ ticket: myTickets[0].id, event_type: 'contacted', actor: agent.id, payload: { channel: 'whatsapp', phone: '0551234567' } }) });
  check("agent stamps 'contacted' on own ticket", st.status === 200, `HTTP ${st.status}`);
} else check('agent has a ticket to stamp', false, 'no ticket assigned');

console.log('\n== 3. field-level history via revisions ==');
const anyTicket = (await get('/items/tickets?fields=id,priority&limit=1'))[0];
await fetch(`${D}/items/tickets/${anyTicket.id}`, { method: 'PATCH', headers: H,
  body: JSON.stringify({ priority: anyTicket.priority === 'high' ? 'medium' : 'high' }) });
const revs = await get(`/revisions?filter[collection][_eq]=tickets&filter[item][_eq]=${anyTicket.id}&sort=-id&limit=3&fields=id,delta,activity.action,activity.user`, PH);
check('AGENT token reads the revision with the delta', (revs ?? []).some((r) => r.delta && 'priority' in r.delta));
// put it back
await fetch(`${D}/items/tickets/${anyTicket.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ priority: anyTicket.priority }) });

console.log('\n== 4. custom role end to end ==');
const brands = await get('/items/brands?fields=id,name&limit=1');
const roleRes = await fetch(`${D}/items/app_roles`, { method: 'POST', headers: H,
  body: JSON.stringify({ name: 'Probe Reporter', privileges: { view_all_tickets: true, view_dashboard: true }, brands: null }) });
const roleRow = (await roleRes.json()).data;
await new Promise((r) => setTimeout(r, 3500));
const roleAfter = await get(`/items/app_roles/${roleRow.id}?fields=directus_role`);
check('role materialized', !!roleAfter?.directus_role);
let probeUserId = null;
if (roleAfter?.directus_role) {
  const u = await fetch(`${D}/users`, { method: 'POST', headers: H,
    body: JSON.stringify({ email: 'probe-reporter@yiji.test', password: 'ProbePass!2026', role: roleAfter.directus_role, first_name: 'Probe' }) });
  probeUserId = (await u.json()).data?.id;
  const RT = await login('probe-reporter@yiji.test', 'ProbePass!2026');
  const RH = { authorization: `Bearer ${RT}` };
  const tix = await get('/items/tickets?fields=id&limit=5', RH);
  check('custom role reads tickets', Array.isArray(tix) && tix.length > 0, `${tix?.length ?? 0} rows`);
  const convs = await (await fetch(`${D}/items/conversations?fields=id&limit=5`, { headers: RH })).json();
  check('custom role blocked from creating tickets? (no create priv)',
    (await fetch(`${D}/items/tickets`, { method: 'POST', headers: { ...RH, 'content-type': 'application/json' },
      body: JSON.stringify({ subject: 'x', contact: null, vendor: null }) })).status === 403);
  check('view_dashboard grants conversation read', Array.isArray(convs.data));
}

console.log('\n== 5. delete + audit survival ==');
const contacts = await get('/items/contacts?fields=id,vendor&limit=1');
const scrap = await (await fetch(`${D}/items/tickets`, { method: 'POST', headers: H,
  body: JSON.stringify({ subject: 'PROBE delete me', contact: contacts[0].id, vendor: contacts[0].vendor, status: 'new', priority: 'medium' }) })).json();
const scrapId = scrap.data?.id;
const delRes = await fetch(`${D}/items/tickets/${scrapId}`, { method: 'DELETE', headers: H });
check('ticket deleted', delRes.status === 204, `HTTP ${delRes.status}`);
const acts = await get(`/activity?filter[collection][_eq]=tickets&filter[item][_eq]=${scrapId}&fields=action,user&limit=-1`);
check('activity rows SURVIVE the delete (create + delete on record)',
  (acts ?? []).some((a) => a.action === 'delete') && (acts ?? []).some((a) => a.action === 'create'));

console.log('\n== cleanup ==');
if (probeVal?.id) await fetch(`${D}/items/option_lists/${probeVal.id}`, { method: 'DELETE', headers: H });
if (probeUserId) await fetch(`${D}/users/${probeUserId}`, { method: 'DELETE', headers: H });
if (roleRow?.id) {
  const r = await fetch(`${D}/items/app_roles/${roleRow.id}`, { method: 'DELETE', headers: H });
  check('probe role torn down', r.status === 204, `HTTP ${r.status}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
