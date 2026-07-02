/**
 * Idempotently clones the `compensation_requests` collection + its 4 dependency
 * collections (Com_Coupons, com_issues_list, Com_Issue_Categories,
 * Compensation_Request_items) into a LOCAL Directus, from the schema JSON in
 * ./schema/ (extracted read-only from production). Creates only these five
 * collections + their relations — nothing else is touched. Admin-form layout
 * fields (groups/tabs/header/links + o2m aliases) are intentionally skipped:
 * the agent portal renders its own UI, not the Directus form.
 *
 *   DIRECTUS_URL=http://localhost:8055 \
 *   DIRECTUS_ADMIN_EMAIL=... DIRECTUS_ADMIN_PASSWORD=... \
 *   node directus/compensation-clone/apply-local.mjs
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = join(HERE, 'schema');
const LOCAL = process.env.DIRECTUS_URL ?? 'http://localhost:8055';
const EMAIL = process.env.DIRECTUS_ADMIN_EMAIL ?? 'e.habibi@anan.sa';
const PASSWORD = process.env.DIRECTUS_ADMIN_PASSWORD ?? '123456';

const read = (n) => JSON.parse(fs.readFileSync(join(SCHEMA, `${n}.json`), 'utf8'));

let TOKEN;
async function login() {
  const r = await fetch(`${LOCAL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`login failed ${r.status}`);
  TOKEN = (await r.json()).data.access_token;
}
async function api(method, path, body) {
  const r = await fetch(`${LOCAL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let json;
  try { json = txt ? JSON.parse(txt) : null; } catch { json = txt; }
  return { ok: r.ok, status: r.status, json };
}
const exists = async (p) => (await api('GET', p)).ok;

const EXTERNAL_OK = new Set(['directus_users', 'directus_files', 'sla_policies']);
const CREATE = new Set([
  'Com_Issue_Categories', 'Com_Coupons', 'com_issues_list',
  'Compensation_Request_items', 'compensation_requests',
]);

function cleanField(f) {
  const meta = { ...(f.meta || {}) };
  delete meta.id;
  delete meta.group;
  const schema = f.schema ? { ...f.schema } : undefined;
  if (schema) { delete schema.foreign_key_table; delete schema.foreign_key_column; }
  return { field: f.field, type: f.type, meta, schema };
}

async function createCollection(name, fields, collMeta) {
  if (await exists(`/collections/${name}`)) { console.log(`= ${name} exists`); return; }
  const pk = fields.find((f) => f.schema?.is_primary_key) || fields.find((f) => f.field === 'id');
  const pkClean = cleanField(pk);
  pkClean.schema = { ...(pkClean.schema || {}), is_primary_key: true };
  const r = await api('POST', '/collections', {
    collection: name,
    meta: collMeta ? { ...collMeta, id: undefined } : { icon: 'receipt_long' },
    schema: { name },
    fields: [pkClean],
  });
  console.log(`${r.ok ? '+' : '✗'} collection ${name} (${r.status})`);
}
async function addFields(name, fields) {
  for (const f of fields) {
    if (f.type === 'alias' || f.schema?.is_primary_key) continue;
    if (await exists(`/fields/${name}/${f.field}`)) continue;
    const r = await api('POST', `/fields/${name}`, cleanField(f));
    if (!r.ok) console.log(`  ✗ ${name}.${f.field} (${r.status})`);
  }
}
async function createRelations(rels) {
  for (const rel of rels) {
    if (!CREATE.has(rel.collection)) continue;
    if (!(CREATE.has(rel.related_collection) || EXTERNAL_OK.has(rel.related_collection))) continue;
    if ((await api('GET', `/relations/${rel.collection}/${rel.field}`)).ok) continue;
    const r = await api('POST', '/relations', {
      collection: rel.collection,
      field: rel.field,
      related_collection: rel.related_collection,
      meta: rel.meta ? { ...rel.meta, id: undefined } : {},
      schema: rel.schema ? { on_delete: rel.schema.on_delete ?? 'SET NULL' } : {},
    });
    if (!r.ok) console.log(`  ✗ relation ${rel.collection}.${rel.field} (${r.status})`);
  }
}

await login();
const targetColl = read('collection');
const byColl = {
  Com_Issue_Categories: read('dep_Com_Issue_Categories_fields'),
  Com_Coupons: read('dep_Com_Coupons_fields'),
  com_issues_list: read('dep_com_issues_list_fields'),
  Compensation_Request_items: read('dep_Compensation_Request_items_fields'),
  compensation_requests: read('fields'),
};
for (const c of Object.keys(byColl)) {
  await createCollection(c, byColl[c], c === 'compensation_requests' ? targetColl.meta : null);
  await addFields(c, byColl[c]);
}
await createRelations([...read('relations'), ...read('dep_relations')]);
console.log('schema clone applied.');
