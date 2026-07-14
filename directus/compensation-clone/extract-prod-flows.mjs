/**
 * READ-ONLY extraction of the production compensation Flows — every stage.
 * For each flow id in flow-contract.json it GETs the flow + all its operations
 * and writes a normalized snapshot to schema/prod-flow-<key>.json, then prints:
 *   - the manual-trigger fields the operator fills (what the portal UI collects)
 *   - the full operation chain in execution order (type, key, and the salient
 *     options — item-update payloads, request URLs, conditions), so the local
 *     stand-ins can mirror the exact visible transitions.
 *
 * Makes ONLY GET requests. Never writes to prod. Creds come from env — nothing
 * is embedded here, nothing is committed:
 *
 *   PROD_DIRECTUS_URL=https://…run.app PROD_DIRECTUS_TOKEN=xxxx \
 *     node directus/compensation-clone/extract-prod-flows.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const URL = process.env.PROD_DIRECTUS_URL;
const TOKEN = process.env.PROD_DIRECTUS_TOKEN;
if (!URL || !TOKEN) {
  console.error('Set PROD_DIRECTUS_URL and PROD_DIRECTUS_TOKEN (read-only extraction).');
  process.exit(1);
}
const contract = JSON.parse(readFileSync(join(HERE, 'flow-contract.json'), 'utf8'));
const OUT = join(HERE, 'schema');
mkdirSync(OUT, { recursive: true });

// Redact secrets before anything is written to disk — the prod Generate-Coupon
// flow embeds a Yiji API bearer token in a request op's headers/body. Never let
// that reach a committed snapshot.
function redact(value) {
  if (typeof value === 'string') {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer <REDACTED>')
      .replace(/eyJ[A-Za-z0-9._-]{20,}/g, '<REDACTED_JWT>');
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /^(authorization|token|secret|api[-_]?key)$/i.test(k) ? '<REDACTED>' : redact(v);
    }
    return out;
  }
  return value;
}

async function get(path) {
  const r = await fetch(`${URL}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const txt = await r.text();
  let json;
  try {
    json = txt ? JSON.parse(txt) : null;
  } catch {
    json = txt;
  }
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status} ${JSON.stringify(json).slice(0, 300)}`);
  return json.data;
}

// Order operations by following resolve/reject from the flow's entry operation.
function chain(entryId, ops) {
  const byId = new Map(ops.map((o) => [o.id, o]));
  const order = [];
  const seen = new Set();
  const walk = (id, branch) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    const op = byId.get(id);
    if (!op) return;
    order.push({ ...op, _branch: branch });
    walk(op.resolve, 'resolve');
    walk(op.reject, 'reject');
  };
  walk(entryId, 'entry');
  // Append any operations not reachable from the entry (defensive).
  for (const o of ops) if (!seen.has(o.id)) order.push({ ...o, _branch: 'orphan' });
  return order;
}

const salient = (op) => {
  const o = op.options ?? {};
  switch (op.type) {
    case 'item-update':
    case 'item-create':
      return { collection: o.collection, key: o.key, payload: o.payload };
    case 'item-read':
      return { collection: o.collection, key: o.key, query: o.query };
    case 'request':
      return { method: o.method, url: o.url, headers: o.headers, body: o.body };
    case 'condition':
      return { filter: o.filter };
    case 'transform':
      return { json: o.json };
    case 'exec':
      return { code: (o.code ?? '').slice(0, 400) };
    case 'mail':
      return { to: o.to, subject: o.subject };
    case 'notification':
      return { recipient: o.recipient, subject: o.subject };
    case 'log':
      return { message: o.message };
    default:
      return o;
  }
};

for (const a of contract.actions) {
  const flow = await get(
    `/flows/${a.flowId}?fields=id,name,icon,status,trigger,accountability,options,operation`,
  );
  const ops = await get(
    `/operations?filter[flow][_eq]=${a.flowId}&fields=id,name,key,type,position_x,position_y,resolve,reject,options&limit=-1`,
  );
  const ordered = chain(flow.operation, ops);

  writeFileSync(
    join(OUT, `prod-flow-${a.key}.json`),
    JSON.stringify(
      redact({ flow, operations: ops, ordered_keys: ordered.map((o) => o.key) }),
      null,
      2,
    ),
  );

  const fields = (flow.options?.fields ?? []).map((f) => ({
    field: f.field,
    type: f.type,
    interface: f.meta?.interface,
    required: !!f.meta?.required,
    label: f.name ?? f.field,
    choices: f.meta?.options?.choices,
  }));

  console.log(`\n══════════════════════════════════════════════════════════`);
  console.log(`FLOW  ${a.key}  "${flow.name}"  (${a.flowId})`);
  console.log(`trigger=${flow.trigger}  requireConfirmation=${flow.options?.requireConfirmation}`);
  console.log(`MANUAL FIELDS (${fields.length}):`);
  for (const f of fields) {
    console.log(
      `  - ${f.field}  [${f.type}/${f.interface}]  ${f.required ? 'REQUIRED' : 'optional'}  "${f.label}"` +
        (f.choices ? `  choices=${JSON.stringify(f.choices)}` : ''),
    );
  }
  console.log(`PIPELINE (${ordered.length} ops, execution order):`);
  for (let i = 0; i < ordered.length; i++) {
    const op = ordered[i];
    console.log(
      `  ${i + 1}. [${op._branch}] ${op.type}  key=${op.key}  ->resolve=${op.resolve ?? '∅'} ->reject=${op.reject ?? '∅'}`,
    );
    console.log(`       ${JSON.stringify(salient(op))}`);
  }
}
console.log(`\nWrote snapshots to ${OUT}\\prod-flow-*.json`);
