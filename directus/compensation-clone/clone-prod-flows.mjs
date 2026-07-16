/**
 * EXACT clone of the production compensation Flows into the local Directus.
 * Unlike standin-flows.mjs (which builds observable-equivalent stand-ins), this
 * reproduces prod's real operation graph verbatim — same operation keys, types,
 * names, canvas positions, exec code, collection/payload/query options, and
 * resolve/reject wiring — so the local Directus admin shows an IDENTICAL flow.
 *
 * Reads prod READ-ONLY (only GET) and writes to local. Exactly THREE local
 * adaptations are applied, and nothing else changes:
 *   1. write/read ops: `permissions: '$trigger'` -> `'$full'`. Prod runs these as
 *      the triggering user (an admin in the Directus UI); the portal triggers as
 *      the READ-ONLY Agent, so without $full every write would be FORBIDDEN.
 *   2. the Generate-Coupon `request` op (POST to the real Yiji AddCoupon API) is
 *      CLONED for fidelity but DISABLED: its bearer token is neutralised and it
 *      is bypassed in the wiring, so triggering locally never hits Yiji.
 *   3. a terminal `return_ok` transform is appended so the flow returns an object
 *      — @directus/sdk (the portal) throws on a flow's bare-id response.
 *
 * Creds via env (nothing embedded, nothing committed):
 *   PROD_DIRECTUS_URL=… PROD_DIRECTUS_TOKEN=… \
 *   [DIRECTUS_URL=http://localhost:8055 DIRECTUS_ADMIN_EMAIL=… DIRECTUS_ADMIN_PASSWORD=…] \
 *     node directus/compensation-clone/clone-prod-flows.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { resolveAdmin } from './local-creds.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROD_URL = process.env.PROD_DIRECTUS_URL;
const PROD_TOKEN = process.env.PROD_DIRECTUS_TOKEN;
const { url: LOCAL, email: EMAIL, password: PASSWORD } = resolveAdmin();
if (!PROD_URL || !PROD_TOKEN) {
  console.error('Set PROD_DIRECTUS_URL and PROD_DIRECTUS_TOKEN (read-only source).');
  process.exit(1);
}
const contract = JSON.parse(readFileSync(join(HERE, 'flow-contract.json'), 'utf8'));

async function prodGet(path) {
  const r = await fetch(`${PROD_URL}${path}`, {
    headers: { Authorization: `Bearer ${PROD_TOKEN}` },
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`PROD GET ${path} -> ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j.data;
}
let TOKEN;
async function login() {
  const r = await fetch(`${LOCAL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  TOKEN = (await r.json()).data.access_token;
}
async function local(method, path, body) {
  const r = await fetch(`${LOCAL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let json;
  try {
    json = txt ? JSON.parse(txt) : null;
  } catch {
    json = txt;
  }
  return { ok: r.ok, status: r.status, json };
}

// Adaptation #1 + #2: privilege the write/read ops for the read-only agent, and
// neutralise the Yiji bearer token on the request op.
function adaptOptions(op) {
  const o = JSON.parse(JSON.stringify(op.options ?? {}));
  if (o.permissions === '$trigger') o.permissions = '$full';
  if (op.type === 'request' && Array.isArray(o.headers)) {
    o.headers = o.headers.map((h) =>
      /^authorization$/i.test(h.header)
        ? { ...h, value: 'Bearer DISABLED-LOCAL-NO-EXTERNAL-CALLS' }
        : h,
    );
  }
  if (op.type === 'request' && typeof o.body === 'string') {
    o.body = o.body.replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer DISABLED');
  }
  return o;
}

await login();
for (const a of contract.actions) {
  const flow = await prodGet(
    `/flows/${a.flowId}?fields=id,name,icon,color,description,status,trigger,accountability,options,operation`,
  );
  const ops = await prodGet(
    `/operations?filter[flow][_eq]=${a.flowId}&fields=id,name,key,type,position_x,position_y,resolve,reject,options&limit=-1`,
  );
  const reqOps = new Set(ops.filter((o) => o.type === 'request').map((o) => o.id));

  // Replace the local flow.
  if ((await local('GET', `/flows/${a.flowId}?fields=id`)).ok)
    await local('DELETE', `/flows/${a.flowId}`);
  const created = await local('POST', '/flows', {
    id: flow.id,
    name: flow.name,
    icon: flow.icon,
    color: flow.color,
    description: flow.description,
    status: flow.status,
    trigger: flow.trigger,
    accountability: flow.accountability,
    options: flow.options,
  });
  if (!created.ok) {
    console.log(
      `✗ flow ${a.key} (${created.status}) ${JSON.stringify(created.json).slice(0, 160)}`,
    );
    continue;
  }

  // Recreate every prod op verbatim (options adapted per #1/#2). Map prod id -> local id.
  const map = new Map();
  let ok = true;
  for (const op of ops) {
    const res = await local('POST', '/operations', {
      flow: a.flowId,
      key: op.key,
      type: op.type,
      name: op.name,
      position_x: op.position_x,
      position_y: op.position_y,
      options: adaptOptions(op),
    });
    if (!res.ok) {
      console.log(
        `✗ op ${a.key}.${op.key} (${res.status}) ${JSON.stringify(res.json).slice(0, 160)}`,
      );
      ok = false;
      break;
    }
    map.set(op.id, res.json.data.id);
  }
  if (!ok) continue;

  // Adaptation #3: terminal return_ok.
  const ret = await local('POST', '/operations', {
    flow: a.flowId,
    key: 'return_ok',
    type: 'transform',
    name: 'Return OK',
    position_x: 55,
    position_y: 1,
    options: { json: { ok: true } },
  });
  const retId = ret.json.data.id;

  // Reproduce prod wiring verbatim — but a resolve/reject that points INTO a
  // `request` op is redirected to return_ok, so the disabled Yiji call is never
  // reached (the request node stays present but unwired, for fidelity).
  const wire = (target) =>
    target == null ? undefined : reqOps.has(target) ? retId : map.get(target);
  for (const op of ops) {
    if (reqOps.has(op.id)) continue; // leave the request node dangling
    const patch = {};
    const rslv = wire(op.resolve);
    const rjct = wire(op.reject);
    if (rslv) patch.resolve = rslv;
    if (rjct) patch.reject = rjct;
    if (Object.keys(patch).length) await local('PATCH', `/operations/${map.get(op.id)}`, patch);
  }

  // Any entry-reachable op that terminates the chain (resolve null and not a
  // request) should resolve into return_ok so the portal gets an object.
  for (const op of ops) {
    if (reqOps.has(op.id)) continue;
    if (op.resolve == null)
      await local('PATCH', `/operations/${map.get(op.id)}`, { resolve: retId });
  }

  // Entry: prod's entry op, or return_ok if the flow had no ops (e.g. refund).
  const entry = flow.operation && map.has(flow.operation) ? map.get(flow.operation) : retId;
  await local('PATCH', `/flows/${a.flowId}`, { operation: entry });
  console.log(
    `✓ cloned ${a.key} (${a.flowId}) — ${ops.length} prod op(s) + return_ok${reqOps.size ? ' (request op disabled)' : ''}`,
  );
}
console.log(
  '\nExact clone complete. Local flows mirror prod op-for-op (3 documented adaptations).',
);
