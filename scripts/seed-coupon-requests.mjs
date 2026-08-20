/**
 * Put a realistic spread of coupon requests through the approval workflow.
 *
 * The coupon feature works end to end, but almost nothing has been through it:
 * the historical complaints carry their compensation on the TICKET (they were
 * paid out before this CRM existed), so `coupon_approvals` — which is what the
 * Coupon approvals report and the Compensation page read — is nearly empty and
 * the feature looks broken when it is only unused.
 *
 * This attaches requests to REAL tickets, with REAL agents and REAL branches,
 * and reuses the compensation each ticket already records so no monetary figure
 * is invented. What it does add is the WORKFLOW around them: who asked, who
 * decided, whether the terms were amended on the way through.
 *
 * Deterministic: the same tickets get the same outcomes every run, so a second
 * run changes nothing and a demo can be rebuilt identically.
 *
 * Dry-run by default.
 *   node scripts/seed-coupon-requests.mjs            # say what it would do
 *   node scripts/seed-coupon-requests.mjs --write    # do it
 *   node scripts/seed-coupon-requests.mjs --undo --write   # remove exactly these
 */
const D = process.env.DIRECTUS_URL ?? 'http://localhost:8055';
const WRITE = process.argv.includes('--write');
const UNDO = process.argv.includes('--undo');

/** Marks the rows this script owns, so --undo can never touch a real request. */
const MARKER = 'seeded:coupon-demo';

const login = await fetch(`${D}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: process.env.DIRECTUS_ADMIN_EMAIL,
    password: process.env.DIRECTUS_ADMIN_PASSWORD,
  }),
});
if (!login.ok) {
  console.error(`Could not sign in to Directus at ${D}. Set DIRECTUS_ADMIN_EMAIL/PASSWORD.`);
  process.exit(1);
}
const AT = (await login.json()).data.access_token;
const H = { authorization: `Bearer ${AT}`, 'content-type': 'application/json' };
const get = async (p) => (await (await fetch(`${D}${p}`, { headers: H })).json()).data ?? [];
const post = (p, body) =>
  fetch(`${D}${p}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
const del = (p) => fetch(`${D}${p}`, { method: 'DELETE', headers: H });

const mine = await get(
  `/items/coupon_approvals?filter[decision_note][_contains]=${MARKER}&fields=id&limit=-1`,
);

if (UNDO) {
  if (!WRITE) {
    console.log(`Dry run: would delete ${mine.length} seeded request(s). Add --write.`);
    process.exit(0);
  }
  for (const r of mine) await del(`/items/coupon_approvals/${r.id}`);
  console.log(`Deleted ${mine.length} seeded request(s). Real requests untouched.`);
  process.exit(0);
}

if (mine.length) {
  console.log(`${mine.length} seeded request(s) already present — nothing to do.`);
  process.exit(0);
}

/**
 * Real tickets that already record a compensation, newest first. Their coupon
 * code and value are reused verbatim: the money in the report is the money
 * operations actually recorded.
 */
const tickets = await get(
  '/items/tickets?filter[coupon_code][_nnull]=true&fields=id,subject,complaint_type,coupon_code,coupon_value,date_created,assigned_agent,contact,store.yiji_restaurant_id,store.brand.name,store.brand.yiji_brand_name&sort=-date_created&limit=18',
);
if (tickets.length === 0) {
  console.error('No compensated tickets found to attach requests to.');
  process.exit(1);
}

const admins = await get(
  '/users?filter[role][name][_eq]=Administrator&fields=id&limit=1&sort=date_created',
);
const decider = admins[0]?.id ?? null;

/**
 * The outcome spread, as a repeating pattern.
 *
 * Weighted the way a real queue looks: most requests go through as asked, a
 * few are amended down, a couple are refused, and some are still waiting. A
 * report where everything was approved says nothing about whether approving is
 * a real decision.
 */
const PATTERN = [
  { status: 'approved', edited: false },
  { status: 'approved', edited: false },
  { status: 'approved', edited: true, factor: 0.5 },
  { status: 'pending', edited: false },
  { status: 'approved', edited: false },
  { status: 'rejected', edited: false },
  { status: 'approved', edited: true, factor: 0.75 },
  { status: 'pending', edited: false },
  { status: 'approved', edited: false },
];

const NOTES = {
  approved: 'Within the compensation limit for this complaint type.',
  edited: 'Reduced to the standard amount for a single item.',
  rejected: 'Already compensated on an earlier ticket for the same order.',
  pending: '',
};

const addDays = (iso, days) =>
  new Date(new Date(iso).getTime() + days * 86_400_000).toISOString().slice(0, 10);

let planned = 0;
for (let i = 0; i < tickets.length; i++) {
  const t = tickets[i];
  const plan = PATTERN[i % PATTERN.length];
  const requested = Number(t.coupon_value) || 0;
  if (requested <= 0) continue; // the rules refuse a coupon worth nothing

  // The row holds the FINAL terms — what the customer actually got. An
  // amendment means the supervisor granted less than was asked for, so those
  // rows carry the reduced figure and `edited_by_admin` records that it moved.
  const granted = plan.edited ? Math.max(5, Math.round(requested * plan.factor)) : requested;
  const from = (t.date_created ?? new Date().toISOString()).slice(0, 10);

  const body = {
    ticket: t.id,
    contact: t.contact ?? null,
    requested_by: t.assigned_agent ?? null,
    decided_by: plan.status === 'pending' ? null : decider,
    status: plan.status,
    edited_by_admin: plan.edited,
    decided_at: plan.status === 'pending' ? null : new Date(t.date_created).toISOString(),
    title: t.subject ?? t.complaint_type ?? 'Compensation',
    coupon_code: t.coupon_code,
    // Only one money column is ever set; these are all flat amounts, so the
    // ceiling is the amount — see couponTermsProblems in shared-types.
    coupon_value: granted,
    coupon_percent: null,
    max_discount: granted,
    usage_limit: 1,
    discount_category: 'Amount',
    coupon_type: 'Private',
    issuing_side: 'Operations',
    delivery_type: 'All',
    valid_from: from,
    valid_to: addDays(from, 30),
    compensation: 'Compensated',
    reason: `${t.complaint_type ?? 'Complaint'} — compensation requested by the handling agent.`,
    // Yiji's identifiers, not ours — the same values the agent portal now sends.
    brand_id: t.store?.brand?.yiji_brand_name || t.store?.brand?.name || null,
    restaurant_id: t.store?.yiji_restaurant_id || null,
    decision_note: [plan.edited ? NOTES.edited : NOTES[plan.status], MARKER]
      .filter(Boolean)
      .join(' · '),
  };

  planned++;
  if (WRITE) {
    const res = await post('/items/coupon_approvals', body);
    if (!res.ok) console.error(`  failed on ${t.coupon_code}: ${res.status} ${await res.text()}`);
  }
}

console.log(
  WRITE
    ? `Created ${planned} coupon request(s) across ${new Set(tickets.map((t) => t.assigned_agent)).size} agent(s). Undo with --undo --write.`
    : `Dry run: would create ${planned} coupon request(s). Add --write to apply.`,
);
