/**
 * Local stand-in copies of the production compensation Flows, with the SAME flow
 * IDs as prod (so the portal — which triggers flows by id — works identically
 * against local and prod). Each stand-in mirrors the EXACT observable prod
 * pipeline "at all stages": the same status transitions and the same field
 * writes, staged through the same kinds of operations (item-read → exec →
 * item-update, item-create, …). The only things intentionally NOT replicated
 * are external calls — prod's Generate-Coupon flow also POSTs to the Yiji
 * `AddCoupon` HTTP API; locally we create + link the coupon record but make NO
 * outbound request. Snapshots of the real prod pipelines live in
 * schema/prod-flow-*.json (see extract-prod-flows.mjs, read-only).
 *
 * Exact prod status model (compensation_requests.status ∈
 * Pending | In Progress | Approved | Rejected):
 *   Acknowledge      → In Progress  (+ inprogress_at/by, SLA breach + minutes)
 *   Calculate        → (no status change) request_frequency + suggested/final value
 *   Generate Coupon  → (no status change) creates Com_Coupons, links coupons
 *   Assign Coupon    → (no status change) generate_coupon flag
 *   Approve ("Accept")→ Approved      (+ approved_at/by, solved SLA fields)
 *   Reject           → Rejected       (+ declined_at/by, decline_reason)
 *   Refund ("Close") → (no operations in prod — no effect)
 *
 * Idempotent: skips a flow if its id exists; pass --force to delete + recreate
 * (use after changing a pipeline/inputs so existing local flows pick it up).
 *
 *   node directus/compensation-clone/standin-flows.mjs [--force]
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { resolveAdmin } from './local-creds.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const { url: LOCAL, email: EMAIL, password: PASSWORD } = resolveAdmin();
const FORCE = process.argv.includes('--force');
const contract = JSON.parse(readFileSync(join(HERE, 'flow-contract.json'), 'utf8'));

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

// Map a contract input `type` to a Directus manual-trigger field definition, so
// the local admin's trigger dialog mirrors prod. (The manual trigger does NOT
// enforce these at the API level — the portal validates required inputs — but a
// faithful dialog keeps local ≈ prod for anyone poking at Directus directly.)
function triggerField(i) {
  const base = { field: i.field, name: i.label ?? i.field };
  switch (i.type) {
    case 'text':
      return {
        ...base,
        type: 'text',
        meta: { interface: 'input-multiline', required: !!i.required },
      };
    case 'dateTime':
      return { ...base, type: 'dateTime', meta: { interface: 'datetime', required: !!i.required } };
    case 'select':
      return {
        ...base,
        type: 'json',
        meta: {
          interface: 'select-dropdown',
          required: !!i.required,
          options: { choices: i.choices ?? [] },
        },
      };
    default:
      return { ...base, type: 'string', meta: { interface: 'input', required: !!i.required } };
  }
}

const CR = 'compensation_requests';
const KEY = '{{$trigger.body.keys}}';

// Exec that stamps a timestamp + elapsed/SLA figures from the read record. The
// SLA hours come from com_issue.sla when present (as in prod); when absent
// locally it degrades to no breach instead of throwing. `readKey` is the key of
// the preceding item-read op; `hoursField` is the sla field prod uses.
const slaExec = (readKey, hoursField) => `module.exports = async function (data) {
  const rec = (data && data.${readKey}) || {};
  const sla = (rec.com_issue && rec.com_issue.sla) || {};
  const hours = sla.${hoursField};
  const now = new Date();
  const created = rec.date_created ? new Date(rec.date_created) : now;
  const elapsedMinutes = Math.floor((now - created) / 60000);
  const slaMinutes = (hours == null) ? null : Number(hours) * 60;
  const slaBreached = (slaMinutes == null) ? false : elapsedMinutes > slaMinutes;
  return {
    current_timestamp: now.toISOString(),
    elapsed_minutes: String(elapsedMinutes),
    sla_breached: String(slaBreached),
  };
};`;

// Simplified compensation calculation. Prod runs frequency + a rules engine over
// com_issue.Com_Issues_c; locally we derive a plausible value from the claimed
// amount so the same fields land (frequency defaults to 1).
const calcExec = (readKey) => `module.exports = async function (data) {
  const rec = (data && data.${readKey}) || {};
  const base = Number(rec.user_complaint_amount != null ? rec.user_complaint_amount : (rec.order_total || 0));
  const amount = Math.round((isFinite(base) ? base : 0) * 100) / 100;
  return { frequency: 1, amount: String(amount) };
};`;

// Each flow's pipeline (ordered). item-update / item-create run with $full
// permissions because the triggering agent is read-only on these collections
// (mirrors prod, where flows run privileged and the agent only triggers them).
const upd = (payload) => ({
  type: 'item-update',
  options: { collection: CR, key: KEY, payload, permissions: '$full' },
});

const PIPELINES = {
  acknowledge: [
    {
      key: 'read_cr',
      type: 'item-read',
      options: { collection: CR, key: KEY, query: { fields: ['date_created', 'com_issue.sla.*'] } },
    },
    { key: 'calc_sla', type: 'exec', options: { code: slaExec('read_cr', 'response_hours') } },
    {
      key: 'apply',
      ...upd({
        status: 'In Progress',
        status_date: '{{calc_sla.current_timestamp}}',
        inprogress_at: '{{calc_sla.current_timestamp}}',
        inprogress_by: '{{$accountability.user}}',
        inprogress_sla_violation: '{{calc_sla.sla_breached}}',
        inprogress_sla_minutes: '{{calc_sla.elapsed_minutes}}',
        updated_at: '{{calc_sla.current_timestamp}}',
        date_updated: '{{calc_sla.current_timestamp}}',
      }),
    },
  ],
  calculate: [
    {
      key: 'read_cr',
      type: 'item-read',
      options: { collection: CR, key: KEY, query: { fields: ['*', 'com_issue.*'] } },
    },
    { key: 'calc', type: 'exec', options: { code: calcExec('read_cr') } },
    {
      key: 'apply',
      ...upd({
        request_frequency: '{{calc.frequency}}',
        suggested_compensation_value: '{{calc.amount}}',
        final_compensation_value: '{{calc.amount}}',
        calculate_compensation: true,
      }),
    },
  ],
  generate_coupon: [
    // Prod creates the coupon, links it, then POSTs to Yiji AddCoupon. Locally we
    // create + link the Com_Coupons row from the operator's inputs and STOP — no
    // outbound request. (Prod also sets `generate_coupon:true`, but that column
    // is NOT a real/readable field in prod — it's a phantom write dropped by
    // Directus — so we don't replicate it; it would just error the update.)
    {
      key: 'mk_coupon',
      type: 'item-create',
      options: {
        collection: 'Com_Coupons',
        payload: { Name: '{{$trigger.body.coupon_name}}', Code: '{{$trigger.body.coupon_code}}' },
        permissions: '$full',
      },
    },
    {
      // item-create returns an ARRAY of created keys — prod links via
      // {{$last[0]}}; the portal then reads the linked coupon's Code (coupons.Code).
      key: 'apply',
      ...upd({ coupons: '{{mk_coupon[0]}}' }),
    },
  ],
  // Prod re-links the (already-linked) coupon and sets the phantom
  // `generate_coupon` flag — so there's no distinct observable change. We mirror
  // the idempotent re-link and omit the phantom flag.
  assign_coupon: [
    {
      key: 'read_cr',
      type: 'item-read',
      options: { collection: CR, key: KEY, query: { fields: ['coupons'] } },
    },
    { key: 'apply', ...upd({ coupons: '{{read_cr.coupons}}' }) },
  ],
  approve: [
    {
      key: 'read_cr',
      type: 'item-read',
      options: { collection: CR, key: KEY, query: { fields: ['date_created', 'com_issue.sla.*'] } },
    },
    { key: 'calc_sla', type: 'exec', options: { code: slaExec('read_cr', 'resolution_hours') } },
    {
      key: 'apply',
      // Prod also writes `approved_by`, but that column is NOT a real/readable
      // field in prod (phantom write) — omitted here so the update doesn't error.
      ...upd({
        status: 'Approved',
        status_date: '{{calc_sla.current_timestamp}}',
        approved_at: '{{calc_sla.current_timestamp}}',
        solved_sla_violation: '{{calc_sla.sla_breached}}',
        solved_sla_minutes: '{{calc_sla.elapsed_minutes}}',
      }),
    },
  ],
  reject: [
    {
      key: 'ts',
      type: 'exec',
      options: {
        code: 'module.exports = async function () { return { current_timestamp: new Date().toISOString() }; };',
      },
    },
    {
      key: 'apply',
      ...upd({
        status: 'Rejected',
        status_date: '{{ts.current_timestamp}}',
        declined_at: '{{ts.current_timestamp}}',
        declined_by: '{{$accountability.user}}',
        decline_reason: '{{$trigger.body.reason}}',
      }),
    },
  ],
  // Prod's "CR->Refund amount" flow has zero operations — Close task has no
  // record effect. We keep the pipeline empty (only the terminal return-ok is
  // added below so the portal's SDK call resolves).
  refund: [],
};

await login();
for (const a of contract.actions) {
  const cur = await api('GET', `/flows/${a.flowId}?fields=id`);
  if (cur.ok) {
    if (!FORCE) {
      console.log(`= flow ${a.key} (${a.flowId}) exists — skip`);
      continue;
    }
    const del = await api('DELETE', `/flows/${a.flowId}`);
    console.log(
      del.ok ? `↻ recreating flow ${a.key} (${a.flowId})` : `✗ delete ${a.key} (${del.status})`,
    );
    if (!del.ok) continue;
  }
  // Create the flow with the production id preserved.
  const flow = await api('POST', '/flows', {
    id: a.flowId,
    name: `CR->${a.label} (local stand-in)`,
    icon: 'bolt',
    status: 'active',
    trigger: 'manual',
    accountability: 'all',
    options: {
      collections: [CR],
      requireConfirmation: true,
      ...(a.inputs.length ? { fields: a.inputs.map(triggerField) } : {}),
    },
  });
  if (!flow.ok) {
    console.log(`✗ flow ${a.key} (${flow.status}) ${JSON.stringify(flow.json).slice(0, 200)}`);
    continue;
  }

  // Create the pipeline ops in order, then a terminal return-ok transform so the
  // flow returns an OBJECT ({ ok: true }) — @directus/sdk v17 request() does
  // `'data' in <response>`, which throws on the bare id/string a flow would
  // otherwise return. Wire each op's resolve to the next; set the trigger entry.
  const specs = [
    ...PIPELINES[a.key],
    { key: 'return_ok', type: 'transform', options: { json: { ok: true } } },
  ];
  const ids = [];
  let x = 19;
  let failed = false;
  for (const spec of specs) {
    const op = await api('POST', '/operations', {
      flow: a.flowId,
      name: spec.key,
      key: spec.key,
      type: spec.type,
      position_x: x,
      position_y: 1,
      options: spec.options ?? {},
    });
    if (!op.ok) {
      console.log(
        `✗ op ${a.key}.${spec.key} (${op.status}) ${JSON.stringify(op.json).slice(0, 160)}`,
      );
      failed = true;
      break;
    }
    ids.push(op.json.data.id);
    x += 18;
  }
  if (failed) continue;
  // Chain resolve pointers.
  for (let i = 0; i < ids.length - 1; i++) {
    await api('PATCH', `/operations/${ids[i]}`, { resolve: ids[i + 1] });
  }
  // Wire the trigger to the first op.
  await api('PATCH', `/flows/${a.flowId}`, { operation: ids[0] });
  console.log(`+ stand-in flow ${a.key} (${a.flowId}) — ${ids.length - 1} stage(s) + return-ok`);
}
console.log('stand-in flows applied (mirroring prod transitions; no external calls).');
