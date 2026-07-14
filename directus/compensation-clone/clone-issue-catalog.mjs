/**
 * Clones the production compensation ISSUE CATALOG into local so ops can pick a
 * real Issue from the agent portal (the Issue drives the SLA timers and the
 * compensation calculation for Acknowledge / Calculate / Approve). Copies, with
 * foreign-key remapping (local ids differ, so nothing collides):
 *
 *   sla_policies (4)  →  Com_Issue_Categories (6)  →  com_issues_list (24)
 *                                                  →  Com_Issues_c rules (20)
 *
 * Reads prod READ-ONLY (GET only). LOCAL sla_policies is the CRM's own collection
 * (different shape) so we map prod's response_hours/resolution_hours onto it and
 * fill the CRM's required first_response_minutes/resolution_minutes. Idempotent
 * by natural keys (category id, SLA/issue name, rule signature).
 *
 *   PROD_DIRECTUS_URL=… PROD_DIRECTUS_TOKEN=… node directus/compensation-clone/clone-issue-catalog.mjs
 */
const PROD_URL = process.env.PROD_DIRECTUS_URL;
const PROD_TOKEN = process.env.PROD_DIRECTUS_TOKEN;
const LOCAL = process.env.DIRECTUS_URL ?? 'http://localhost:8055';
const EMAIL = process.env.DIRECTUS_ADMIN_EMAIL ?? 'e.habibi@anan.sa';
const PASSWORD = process.env.DIRECTUS_ADMIN_PASSWORD ?? '123456';
if (!PROD_URL || !PROD_TOKEN) {
  console.error('Set PROD_DIRECTUS_URL and PROD_DIRECTUS_TOKEN (read-only source).');
  process.exit(1);
}

async function prod(path) {
  const r = await fetch(`${PROD_URL}${path}`, { headers: { Authorization: `Bearer ${PROD_TOKEN}` } });
  const j = await r.json();
  if (!r.ok) throw new Error(`PROD ${path} -> ${r.status}`);
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
async function api(method, path, body) {
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
const first = async (path) => (await api('GET', path)).json?.data?.[0] ?? null;

await login();

// 1 ── sla_policies (prod uuid -> local uuid) ────────────────────────────────
const slaMap = new Map();
for (const s of await prod('/items/sla_policies?fields=id,response_hours,resolution_hours&limit=-1')) {
  const name = `Compensation SLA ${s.response_hours}h/${s.resolution_hours}h (prod clone)`;
  const existing = await first(`/items/sla_policies?filter[name][_eq]=${encodeURIComponent(name)}&fields=id&limit=1`);
  let id = existing?.id;
  if (!id) {
    const r = await api('POST', '/items/sla_policies', {
      name,
      first_response_minutes: (s.response_hours ?? 0) * 60,
      resolution_minutes: (s.resolution_hours ?? 0) * 60,
      response_hours: s.response_hours,
      resolution_hours: s.resolution_hours,
    });
    if (!r.ok) {
      console.log(`✗ sla ${name} (${r.status})`);
      continue;
    }
    id = r.json.data.id;
  }
  slaMap.set(s.id, id);
}
console.log(`sla_policies: ${slaMap.size} mapped`);

// 2 ── Com_Issue_Categories (preserve prod id — string, no collision) ─────────
for (const c of await prod('/items/Com_Issue_Categories?fields=id,name&limit=-1')) {
  if (!(await first(`/items/Com_Issue_Categories?filter[id][_eq]=${encodeURIComponent(c.id)}&fields=id&limit=1`))) {
    const r = await api('POST', '/items/Com_Issue_Categories', { id: c.id, name: c.name });
    if (!r.ok) console.log(`✗ category ${c.id} ${c.name} (${r.status})`);
  }
}
console.log('Com_Issue_Categories: synced');

// 3 ── com_issues_list (prod uuid -> local uuid) ─────────────────────────────
const issueMap = new Map();
const prodIssues = await prod(
  '/items/com_issues_list?fields=id,name,name_ar,frequency_window_days,com_issue_category,sla&limit=-1',
);
for (const iss of prodIssues) {
  const existing = await first(`/items/com_issues_list?filter[name][_eq]=${encodeURIComponent(iss.name)}&fields=id&limit=1`);
  let id = existing?.id;
  if (!id) {
    const r = await api('POST', '/items/com_issues_list', {
      name: iss.name,
      name_ar: iss.name_ar,
      frequency_window_days: iss.frequency_window_days,
      com_issue_category: iss.com_issue_category,
      sla: iss.sla ? slaMap.get(iss.sla) : null,
    });
    if (!r.ok) {
      console.log(`✗ issue "${iss.name}" (${r.status}) ${JSON.stringify(r.json).slice(0, 120)}`);
      continue;
    }
    id = r.json.data.id;
  } else if (iss.sla && slaMap.get(iss.sla)) {
    // ensure the sla link is present on a pre-existing row
    await api('PATCH', `/items/com_issues_list/${id}`, { sla: slaMap.get(iss.sla) });
  }
  issueMap.set(iss.id, id);
}
console.log(`com_issues_list: ${issueMap.size} mapped`);

// 4 ── Com_Issues_c rules (link to the mapped issue) ─────────────────────────
const RULE_FIELDS = [
  'late_delivery_time', 'min_prep_time', 'min_order_value', 'max_order_value',
  'fixed_amount', 'fallback_amount', 'percentage', 'max_amount', 'validity_days',
  'compensation_type', 'components', 'frequency_from', 'frequency_to',
  'frequency_window_days', 'notification', 'status',
];
let rules = 0;
for (const rule of await prod(`/items/Com_Issues_c?fields=${RULE_FIELDS.join(',')},com_issue_list_item&limit=-1`)) {
  const localIssue = issueMap.get(rule.com_issue_list_item);
  if (!localIssue) continue;
  // signature guard so re-runs don't duplicate
  const sig = `filter[com_issue_list_item][_eq]=${localIssue}&filter[compensation_type][_eq]=${encodeURIComponent(rule.compensation_type ?? '')}&filter[min_order_value][_eq]=${rule.min_order_value ?? 0}&filter[max_order_value][_eq]=${rule.max_order_value ?? 0}`;
  if (await first(`/items/Com_Issues_c?${sig}&fields=id&limit=1`)) continue;
  const payload = { com_issue_list_item: localIssue };
  for (const f of RULE_FIELDS) payload[f] = rule[f];
  const r = await api('POST', '/items/Com_Issues_c', payload);
  if (r.ok) rules++;
  else console.log(`✗ rule for issue ${localIssue} (${r.status})`);
}
console.log(`Com_Issues_c rules: ${rules} created`);
console.log('\nIssue catalog cloned. Ops can now pick a real Issue in the portal.');
