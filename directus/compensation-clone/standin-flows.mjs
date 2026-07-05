/**
 * Creates SAFE local stand-in copies of the 7 agent compensation flows, with the
 * SAME flow IDs as production (so the portal — which triggers flows by id — works
 * identically against local and prod). Each stand-in performs only the visible
 * status/field transition via a single item-update; it makes NO external calls
 * (the production flows call the real Yiji CreateCoupon API — never replicated
 * locally). Idempotent: skips a flow if its id already exists.
 *
 *   node directus/compensation-clone/standin-flows.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCAL = process.env.DIRECTUS_URL ?? 'http://localhost:8055';
const EMAIL = process.env.DIRECTUS_ADMIN_EMAIL ?? 'e.habibi@anan.sa';
const PASSWORD = process.env.DIRECTUS_ADMIN_PASSWORD ?? '123456';
const contract = JSON.parse(readFileSync(join(HERE, 'flow-contract.json'), 'utf8'));

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

// The item-update payload each stand-in applies (mirrors the prod status effect).
// Each action sets its OWN status so the workflow stage is always visible.
// (The UI's Accept button uses the `approve` flow; Close uses the `refund` flow.)
const PAYLOAD = {
  acknowledge: { status: 'Acknowledged', inprogress_at: '$NOW' },
  calculate: {
    status: 'Calculating Compensation',
    suggested_compensation_value: '5',
    request_frequency: 1,
  },
  generate_coupon: { status: 'Generating Coupon', coupon_code: 'LOCAL-DEV-COUPON' },
  assign_coupon: { status: 'Assign Coupon to User' },
  approve: { status: 'Accepted', approved_at: '$NOW' },
  reject: { status: 'Rejected', declined_at: '$NOW' },
  refund: { status: 'Closed' },
};

await login();
for (const a of contract.actions) {
  const cur = await api('GET', `/flows/${a.flowId}?fields=id`);
  if (cur.ok) { console.log(`= flow ${a.key} (${a.flowId}) exists — skip`); continue; }
  // Create the flow with the production id preserved.
  const flow = await api('POST', '/flows', {
    id: a.flowId,
    name: `CR->${a.label} (local stand-in)`,
    icon: 'bolt',
    status: 'active',
    trigger: 'manual',
    accountability: 'all',
    options: {
      collections: ['compensation_requests'],
      requireConfirmation: true,
      ...(a.inputs.length
        ? { fields: a.inputs.map((i) => ({ field: i.field, type: i.type === 'text' ? 'text' : 'string', name: i.field, meta: { interface: i.type === 'text' ? 'input-multiline' : 'input', required: !!i.required } })) }
        : {}),
    },
  });
  if (!flow.ok) { console.log(`✗ flow ${a.key} (${flow.status}) ${JSON.stringify(flow.json).slice(0, 200)}`); continue; }
  // One item-update operation that applies the transition to the triggered keys.
  const op = await api('POST', '/operations', {
    flow: a.flowId,
    name: 'Apply transition',
    key: 'apply_transition',
    type: 'item-update',
    position_x: 19,
    position_y: 1,
    options: {
      collection: 'compensation_requests',
      key: '{{$trigger.body.keys}}',
      payload: PAYLOAD[a.key] ?? {},
      // Run the write with full access, not the triggering agent's perms.
      // The agent is granted READ-only on compensation_requests (see
      // grant-agent-perms.mjs); without this the update is FORBIDDEN and the
      // action silently no-ops. Mirrors prod, where the real flows run
      // privileged and the agent only triggers them.
      permissions: '$full',
    },
  });
  if (!op.ok) { console.log(`✗ op ${a.key} (${op.status})`); continue; }
  // A terminal transform op so the flow returns an OBJECT ({ ok: true }), not the
  // bare updated id. @directus/sdk v17's request() does `'data' in <response>`,
  // which throws a TypeError on a string primitive — the trigger 200s and the
  // write lands, but the portal's SDK call throws and shows "Action failed".
  // Returning an object keeps the SDK's response parsing happy.
  const ret = await api('POST', '/operations', {
    flow: a.flowId,
    name: 'Return OK',
    key: 'return_ok',
    type: 'transform',
    position_x: 37,
    position_y: 1,
    options: { json: { ok: true } },
  });
  if (ret.ok) await api('PATCH', `/operations/${op.json.data.id}`, { resolve: ret.json.data.id });
  // Wire the trigger to the entry (item-update) operation.
  await api('PATCH', `/flows/${a.flowId}`, { operation: op.json.data.id });
  console.log(`+ stand-in flow ${a.key} (${a.flowId})`);
}
console.log('stand-in flows applied.');
