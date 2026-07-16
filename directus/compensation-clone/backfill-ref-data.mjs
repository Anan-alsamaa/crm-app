import { resolveAdmin } from './local-creds.mjs';
/**
 * Backfills the prod-like REFERENCE DATA the exact cloned flows (clone-prod-flows.mjs)
 * need to actually execute locally. The verbatim prod exec code reads
 * `com_issue.sla.response_hours` / `resolution_hours`, `com_issue.frequency_window_days`
 * and `com_issue.Com_Issues_c` (compensation rules) — none of which the initial
 * local clone set up (it reused the CRM's own sla_policies and never cloned the
 * rules collection). This script adds all of that, additively and idempotently:
 *
 *   1. sla_policies.response_hours + resolution_hours   (nullable int fields)
 *   2. Com_Issues_c collection + fields + o2m from com_issues_list
 *   3. one SLA policy, one com_issue (linked to the SLA + one FIXED rule)
 *   4. links every compensation_request that has no com_issue to that com_issue
 *
 * Values mirror a real prod issue (response 7h / resolution 60h; FIXED 10 SAR).
 * LOCAL only — makes no prod calls. Safe to re-run.
 *
 *   node directus/compensation-clone/backfill-ref-data.mjs
 */
const { url: LOCAL, email: EMAIL, password: PASSWORD } = resolveAdmin();
const MARK = 'compensation reference (prod clone)';

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
const exists = async (path) => (await api('GET', path)).ok;

await login();

// 1 ── SLA fields the exec reads (additive; the CRM ignores them) ────────────
for (const field of ['response_hours', 'resolution_hours']) {
  if (await exists(`/fields/sla_policies/${field}`)) {
    console.log(`= sla_policies.${field} exists`);
    continue;
  }
  const r = await api('POST', '/fields/sla_policies', {
    field,
    type: 'integer',
    schema: { is_nullable: true },
    meta: { interface: 'input', note: 'Compensation flow SLA (prod clone)' },
  });
  console.log(`${r.ok ? '+' : '✗'} sla_policies.${field} (${r.status})`);
}

// 2 ── Com_Issues_c rules collection + o2m from com_issues_list ───────────────
const RULE_FIELDS = [
  ['late_delivery_time', 'integer'],
  ['min_prep_time', 'integer'],
  ['min_order_value', 'integer'],
  ['max_order_value', 'integer'],
  ['fixed_amount', 'float'],
  ['fallback_amount', 'float'],
  ['percentage', 'integer'],
  ['max_amount', 'integer'],
  ['validity_days', 'integer'],
  ['compensation_type', 'string'],
  ['components', 'json'],
  ['frequency_from', 'integer'],
  ['frequency_to', 'integer'],
  ['frequency_window_days', 'integer'],
  ['notification', 'text'],
  ['status', 'string'],
];
if (!(await exists('/collections/Com_Issues_c'))) {
  const r = await api('POST', '/collections', {
    collection: 'Com_Issues_c',
    fields: [
      {
        field: 'id',
        type: 'integer',
        schema: { is_primary_key: true, has_auto_increment: true },
        meta: { hidden: true },
      },
    ],
    schema: {},
    meta: { icon: 'gavel', note: 'Compensation rules (prod Com_Issues_c clone)' },
  });
  console.log(`${r.ok ? '+' : '✗'} collection Com_Issues_c (${r.status})`);
  for (const [field, type] of RULE_FIELDS) {
    const f = await api('POST', '/fields/Com_Issues_c', {
      field,
      type,
      ...(type === 'json' ? { meta: { special: ['cast-json'] } } : {}),
    });
    if (!f.ok) console.log(`  ✗ Com_Issues_c.${field} (${f.status})`);
  }
  // M2O back-reference + the o2m alias on com_issues_list + the relation.
  await api('POST', '/fields/Com_Issues_c', { field: 'com_issue_list_item', type: 'uuid' });
  if (!(await exists('/fields/com_issues_list/Com_Issues_c'))) {
    await api('POST', '/fields/com_issues_list', {
      field: 'Com_Issues_c',
      type: 'alias',
      meta: { special: ['o2m'], interface: 'list-o2m' },
    });
  }
  const rel = await api('POST', '/relations', {
    collection: 'Com_Issues_c',
    field: 'com_issue_list_item',
    related_collection: 'com_issues_list',
    meta: { one_field: 'Com_Issues_c', one_deselect_action: 'nullify', sort_field: null },
    schema: { on_delete: 'SET NULL' },
  });
  console.log(
    `${rel.ok ? '+' : '✗'} relation Com_Issues_c.com_issue_list_item -> com_issues_list (${rel.status})`,
  );
} else {
  console.log('= collection Com_Issues_c exists');
}

// 3 ── The rows: SLA policy -> com_issue (+ rule) ────────────────────────────
async function findOrCreate(collection, filterPath, payload) {
  const found = (await api('GET', `/items/${collection}?${filterPath}&limit=1&fields=id`)).json
    ?.data?.[0];
  if (found) return found.id;
  const r = await api('POST', `/items/${collection}`, payload);
  if (!r.ok) {
    console.log(`✗ create ${collection} (${r.status}) ${JSON.stringify(r.json).slice(0, 160)}`);
    return null;
  }
  return r.json.data.id;
}

const slaId = await findOrCreate(
  'sla_policies',
  `filter[name][_eq]=${encodeURIComponent(MARK)}`,
  // first_response_minutes / resolution_minutes are the CRM sla_policies' own
  // required fields (unrelated to compensation); the flows read the *_hours ones.
  {
    name: MARK,
    first_response_minutes: 420,
    resolution_minutes: 3600,
    response_hours: 7,
    resolution_hours: 60,
  },
);
console.log(`sla_policies: ${slaId}`);

const issueId = await findOrCreate(
  'com_issues_list',
  `filter[name][_eq]=${encodeURIComponent(MARK)}`,
  { name: MARK, frequency_window_days: 60, sla: slaId },
);
// Ensure the link even if the issue pre-existed from a partial earlier run.
if (issueId && slaId) await api('PATCH', `/items/com_issues_list/${issueId}`, { sla: slaId });
console.log(`com_issues_list: ${issueId} (sla=${slaId})`);

// one FIXED rule on that issue (mirrors a real prod Com_Issues_c row)
if (issueId) {
  const hasRule = (
    await api(
      'GET',
      `/items/Com_Issues_c?filter[com_issue_list_item][_eq]=${issueId}&limit=1&fields=id`,
    )
  ).json?.data?.[0];
  if (!hasRule) {
    const r = await api('POST', '/items/Com_Issues_c', {
      com_issue_list_item: issueId,
      compensation_type: 'FIXED',
      fixed_amount: 10,
      min_order_value: 0,
      max_order_value: 1000,
      late_delivery_time: 30,
      min_prep_time: 30,
      validity_days: 0,
      status: 'active',
    });
    console.log(`${r.ok ? '+' : '✗'} Com_Issues_c rule (${r.status})`);
  } else {
    console.log('= Com_Issues_c rule exists');
  }
}

// 4 ── Link sample requests that have no com_issue ───────────────────────────
if (issueId) {
  const rows = (await api('GET', '/items/compensation_requests?fields=id,com_issue&limit=-1')).json
    .data;
  let linked = 0;
  for (const row of rows) {
    if (!row.com_issue) {
      const r = await api('PATCH', `/items/compensation_requests/${row.id}`, {
        com_issue: issueId,
      });
      if (r.ok) linked++;
    }
  }
  console.log(`linked com_issue on ${linked} request(s)`);
}
console.log('\nBackfill complete. The exact cloned flows can now execute locally.');
