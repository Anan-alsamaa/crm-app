/**
 * Restores the production Directus ADMIN LAYOUT for compensation_requests into
 * local: the tab groups, the super-header, the action-button bar
 * (presentation-links → flow triggers), the items o2m, and each field's
 * group/sort placement. Run AFTER apply-local.mjs (needs the collection +
 * relations to exist) and standin-flows.mjs (the buttons trigger flow ids that
 * must resolve to the SAFE local stand-ins — no external calls).
 *
 * Idempotent. Local only.
 *   node directus/compensation-clone/layout-local.mjs
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCAL = process.env.DIRECTUS_URL ?? 'http://localhost:8055';
const EMAIL = process.env.DIRECTUS_ADMIN_EMAIL ?? 'e.habibi@anan.sa';
const PASSWORD = process.env.DIRECTUS_ADMIN_PASSWORD ?? '123456';
const COLL = 'compensation_requests';
const fields = JSON.parse(fs.readFileSync(join(HERE, 'schema', 'fields.json'), 'utf8'));

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
const exists = async (f) => (await api('GET', `/fields/${COLL}/${f}`)).ok;

await login();

// Alias fields, created group-tabs → groups → header/links → items o2m.
// (group is stripped on create, then restored in the layout pass below.)
const aliasOrder = [
  'tabs-ywz6wq',
  'complaint_group', 'Customer_tab', 'Order_Tab', 'Compensation_Tab',
  'header-crt4xp', 'links-ycdmfv',
  'items',
];
for (const name of aliasOrder) {
  const f = fields.find((x) => x.field === name);
  if (!f) { console.log(`? ${name} not in schema — skip`); continue; }
  if (await exists(name)) { console.log(`= ${name} exists`); continue; }
  const meta = { ...(f.meta || {}) };
  delete meta.id;
  delete meta.group;
  const r = await api('POST', `/fields/${COLL}`, { field: f.field, type: f.type, meta, schema: null });
  console.log(`${r.ok ? '+' : '✗'} ${name} (${r.status})${r.ok ? '' : ' ' + JSON.stringify(r.json).slice(0, 250)}`);
}

// Layout pass: restore group + sort + width for every field so the form matches
// production (tabs populated, buttons up top).
let patched = 0;
for (const f of fields) {
  if (f.field === 'id') continue;
  if (!(await exists(f.field))) continue;
  const meta = {};
  if (f.meta?.group !== undefined) meta.group = f.meta.group;
  if (f.meta?.sort !== undefined) meta.sort = f.meta.sort;
  if (f.meta?.width !== undefined) meta.width = f.meta.width;
  if (Object.keys(meta).length === 0) continue;
  const r = await api('PATCH', `/fields/${COLL}/${f.field}`, { meta });
  if (r.ok) patched++;
  else console.log(`✗ patch ${f.field} (${r.status})`);
}
console.log(`layout restored (${patched} fields grouped/sorted).`);
