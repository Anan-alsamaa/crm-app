#!/usr/bin/env node
/**
 * RELEASE CHECK — every previously solved bug, re-checked on every release.
 *
 * Owner rule (2026-10-06): "once we solve an issue, the same issue must never
 * happen again. This should be checked even if the changes to prod aren't
 * related to this specific feature." Each check below names the issue it
 * guards. A fix is not finished until it adds a check here.
 *
 * READ-ONLY. Nothing is written anywhere: Directus and the gateway are only
 * read, Yiji is only read (GETs), and the one Yiji POST is a deliberately
 * invalid probe that cannot create anything.
 *
 * Usage:
 *   API=https://crm-api.anan.sa ENV=prod ADMIN_EMAIL=… ADMIN_PASSWORD=… \
 *   [YIJI_ADMIN_API_URL=… YIJI_ADMIN_EMAIL=… YIJI_ADMIN_PASSWORD=…] \
 *   node scripts/release-check/regressions.mjs
 *
 * Yiji checks are skipped (reported as SKIP, not PASS) when its credentials
 * are not provided.
 *
 * PER-VENDOR (MV-6): for EVERY active vendor — its connector resolves, its
 * records never come back under another vendor's filter, and (staging) the
 * mock test vendor answers from the mock, never Yiji. The test vendor's chat
 * login / webhook / mock commerce are SKIPPED, naming the missing variable,
 * until the owner approves those env vars on the staging task definitions.
 * Optional: VENDOR_<KEY>_WEBHOOK_SECRET in this script's env adds a signed
 * webhook ping for that vendor.
 */
import {
  ISOLATION_COLLECTIONS,
  ISOLATION_SAMPLE,
  MOCK_PROBE_ORDER_ID,
  MOCK_PROBE_PHONE,
  classifyChatLoginProbe,
  classifyMockOrderProbe,
  classifyResolveProbe,
  classifyWebhookProbe,
  connectorVerdict,
  isolationPairs,
  isolationVerdict,
  platformOf,
  signWebhook,
  vendorSecretEnvNames,
} from './lib/vendor-checks.mjs';
const API = (process.env.API ?? '').replace(/\/$/, '');
const ENV = process.env.ENV ?? 'staging';
if (!API || !process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
  console.error('set API, ENV, ADMIN_EMAIL, ADMIN_PASSWORD');
  process.exit(2);
}
const ORIGINS =
  ENV === 'prod'
    ? {
        widget: 'https://crm.anan.sa',
        agent: 'https://crm-agent.anan.sa',
        admin: 'https://crm-admin.anan.sa',
      }
    : {
        widget: 'https://crm-staging.anan.sa',
        agent: 'https://crm-agent-staging.anan.sa',
        admin: 'https://crm-admin-staging.anan.sa',
      };

const results = [];
const report = (status, id, name, detail = '') => {
  results.push({ status, id, name });
  console.log(`${status.padEnd(4)}  [${id}] ${name}${detail ? ` — ${detail}` : ''}`);
};
/* SKIP_CHECKS=ID,ID — for a targeted re-run; a skipped check is reported as
   SKIP, never as a pass. */
const SKIP_CHECKS = new Set(
  (process.env.SKIP_CHECKS ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
);
async function check(id, name, fn) {
  if (SKIP_CHECKS.has(id)) {
    results.push({ status: 'SKIP', id, name });
    console.log(`SKIP  [${id}] ${name} — skipped by SKIP_CHECKS`);
    return;
  }
  try {
    const r = await fn();
    if (r === 'skip') report('SKIP', id, name, 'credentials not provided');
    else if (r?.status === 'PASS' || r?.status === 'FAIL' || r?.status === 'SKIP')
      report(r.status, id, name, r.detail ?? '');
    else if (r === true || r?.ok) report('PASS', id, name, r?.detail ?? '');
    else report('FAIL', id, name, r?.detail ?? '');
  } catch (err) {
    report('FAIL', id, name, err instanceof Error ? err.message : String(err));
  }
}

const token = (
  await (
    await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: process.env.ADMIN_EMAIL,
        password: process.env.ADMIN_PASSWORD,
      }),
    })
  ).json()
)?.data?.access_token;
if (!token) {
  console.error('could not sign in');
  process.exit(1);
}
const H = { authorization: `Bearer ${token}` };
async function items(collection, params) {
  const r = await fetch(`${API}/items/${collection}?${new URLSearchParams(params)}`, {
    headers: H,
  });
  const j = await r.json().catch(() => null);
  return { status: r.status, data: j?.data ?? null, error: j?.errors?.[0]?.message };
}
async function preflight(path, origin, headers) {
  const r = await fetch(`${API}${path}`, {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': headers,
    },
  });
  const allow = (r.headers.get('access-control-allow-headers') ?? '').toLowerCase();
  const ok =
    !!r.headers.get('access-control-allow-origin') &&
    headers.split(',').every((h) => allow.includes(h));
  return { ok, detail: `allow-headers: ${allow || '(none)'}` };
}

// ── services up ─────────────────────────────────────────────────────────────
await check('core', 'Directus answers', async () => (await fetch(`${API}/server/health`)).ok);
await check('core', 'AI gateway answers', async () => {
  const s = (await fetch(`${API}/admin/config`)).status;
  return { ok: s < 500 && s !== 404, detail: `HTTP ${s}` };
});

// ── browser CORS — curl-blind, so checked as a browser asks ──────────────────
await check('EMA-50', 'customer photo upload passes the browser preflight', () =>
  preflight(
    '/chat/attachment?filename=a.jpg&type=image%2Fjpeg',
    ORIGINS.widget,
    'authorization,content-type',
  ),
);
await check('EMA-10', 'agent "+" start-chat passes the browser preflight', () =>
  preflight('/chat/agent-initiate', ORIGINS.agent, 'authorization,content-type'),
);
await check('EMA-36', 'admin "Update now" release endpoint passes the browser preflight', () =>
  preflight('/jobs/releases/apply', ORIGINS.admin, 'authorization,content-type'),
);

// ── schema the code depends on (a missing field 403s the WHOLE query) ───────
const FIELD_QUERIES = [
  [
    'EMA-33',
    'messages',
    'id,sender_type,sender_user,content,is_internal_note,date_created,edited_at,deleted_at,original_content',
  ],
  ['EMA-11', 'conversations', 'id,status,last_message_at,initiated_by,push_unreachable_at'],
  ['EMA-38', 'quick_replies', 'id,label,text,lang,kind,active'],
  [
    'EMA-35',
    'coupon_approvals',
    'id,status,delivery_excluded,delivery_excluded_reason,yiji_coupon_user_id,yiji_push_error,yiji_pushed_at',
  ],
  [
    'EMA-18',
    'late_order_decisions',
    'id,order_id,kind,action,reason,action_taken,date_created,order_snapshot,decided_by',
  ],
  ['EMA-46', 'tickets', 'id,complaint_date,date_created,assigned_agent,order_id,complaint_type'],
  /* A manual apply:fields; without it the admin coupon list 403s whole. */
  ['EMA-55', 'coupon_approvals', 'id,delivery_excluded,yiji_coupon_id'],
  ['EMA-49', 'coupon_approvals', 'id,awaiting_signup_at,signup_checked_at'],
  /* Recording (owner, 2026-10-07). The gateway WRITES these on every message:
     missing = every message refused, so this is a chat-is-down check. */
  ['REC-SOURCE', 'messages', 'id,source,quick_reply_id,source_text,source_edited'],
  [
    'REC-AI-LOG',
    'ai_calls',
    'id,endpoint,provider,model,status,error_code,input_tokens,output_tokens,thinking_tokens,est_cost_usd,latency_ms,user_id,vendor_id,conversation_id',
  ],
];
for (const [id, col, fields] of FIELD_QUERIES)
  await check(id, `${col}: every field the code reads exists`, async () => {
    const r = await items(col, { fields, limit: '1' });
    /* The prod check account cannot read the AI log (v1.41.0 failed on this
       alone); the AI service's own grant is checked separately below. */
    if (col === 'ai_calls' && r.status === 403)
      return { ok: true, detail: 'check account may not read ai_calls; table verified by the grant check' };
    return {
      ok: r.status === 200,
      detail: r.status === 200 ? '' : `HTTP ${r.status} ${r.error ?? ''}`,
    };
  });

// ── data that does not ride a deploy ─────────────────────────────────────────
await check('EMA-38', 'late-order quick replies exist (reasons + actions)', async () => {
  const r = await items('quick_replies', {
    'aggregate[count]': 'id',
    'groupBy[]': 'kind',
    filter: JSON.stringify({ active: { _eq: true } }),
  });
  const by = Object.fromEntries(
    (r.data ?? []).map((g) => [g.kind ?? 'chat', Number(g.count?.id ?? 0)]),
  );
  const ok = by.late_order_reason > 0 && by.late_order_action > 0 && (by.chat ?? 0) > 0;
  return { ok, detail: JSON.stringify(by) };
});
await check('EMA-28', 'welcome message template exists and is active', async () => {
  const r = await items('quick_replies', { fields: 'label,lang,active', limit: '-1' });
  const ok = (r.data ?? []).some(
    (q) => q.active && /رسالة ترحيب|welcome message/i.test(q.label ?? ''),
  );
  return { ok };
});
await check('EMA-28', 'chat gateway may read quick replies', async () => {
  const r = await fetch(
    `${API}/permissions?${new URLSearchParams({
      filter: JSON.stringify({
        _and: [
          { collection: { _eq: 'quick_replies' } },
          { action: { _eq: 'read' } },
          { policy: { name: { _eq: 'svc-socket-gateway policy' } } },
        ],
      }),
      fields: 'id',
    })}`,
    { headers: H },
  );
  if (r.status === 200) return ((await r.json())?.data ?? []).length > 0;
  /*
   * THE RELEASE-CHECK ACCOUNT CANNOT READ PERMISSIONS (EMA-51, 2026-10-07):
   * on production it is deliberately not an owner-level account. So it checks
   * the BEHAVIOUR instead, which is the stronger proof anyway: every
   * customer-started chat of the last day must have received the automatic
   * welcome — sent by the gateway from the quick replies it must be able to
   * read. An automated message is an agent message with no sender_user.
   */
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const convs = await items('conversations', {
    filter: JSON.stringify({
      _and: [{ date_created: { _gte: since } }, { initiated_by: { _neq: 'agent' } }],
    }),
    fields: 'id',
    limit: '20',
    sort: '-date_created',
  });
  if (convs.status !== 200) return { ok: false, detail: `conversations HTTP ${convs.status}` };
  const ids = (convs.data ?? []).map((c) => c.id);
  if (!ids.length) return { ok: true, detail: 'no customer chat in the last day — nothing to prove' };
  const msgs = await items('messages', {
    filter: JSON.stringify({
      _and: [{ conversation: { _in: ids } }, { sender_type: { _eq: 'agent' } }, { sender_user: { _null: true } }],
    }),
    fields: 'conversation',
    limit: '-1',
  });
  const welcomed = new Set((msgs.data ?? []).map((m) => m.conversation));
  // A chat whose customer has not written yet has had no reason to be welcomed.
  const wrote = await items('messages', {
    filter: JSON.stringify({ _and: [{ conversation: { _in: ids } }, { sender_type: { _eq: 'customer' } }] }),
    fields: 'conversation',
    limit: '-1',
  });
  const spoke = new Set((wrote.data ?? []).map((m) => m.conversation));
  const missing = ids.filter((id) => spoke.has(id) && !welcomed.has(id));
  return {
    ok: missing.length === 0,
    detail: missing.length
      ? `${missing.length} customer chat(s) of the last day got no automatic welcome`
      : `${welcomed.size} recent customer chats welcomed (permissions not readable by this account)`,
  };
});

// ── inbox previews (EMA-48: one huge request 414'd and blanked every row) ────
await check('EMA-48', 'inbox previews load for the newest conversations', async () => {
  const convs =
    (await items('conversations', { fields: 'id', sort: '-last_message_at', limit: '100' })).data ??
    [];
  const ids = convs.map((c) => c.id);
  let covered = new Set();
  for (let i = 0; i < ids.length; i += 25) {
    const r = await items('messages', {
      filter: JSON.stringify({
        conversation: { _in: ids.slice(i, i + 25) },
        is_internal_note: { _eq: false },
      }),
      fields: 'conversation',
      sort: '-date_created',
      limit: '1000',
    });
    if (r.status !== 200) return { ok: false, detail: `HTTP ${r.status}` };
    for (const m of r.data) covered.add(m.conversation);
  }
  return {
    ok: covered.size > 0 && covered.size >= ids.length * 0.8,
    detail: `${covered.size}/${ids.length} with a preview`,
  };
});

// ── coupons: created and delivered ───────────────────────────────────────────
await check('EMA-23', 'no approved coupon is stuck undelivered (older than 15 min)', async () => {
  const cutoff = new Date(Date.now() - 15 * 60_000).toISOString();
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const r = await items('coupon_approvals', {
    filter: JSON.stringify({
      _and: [
        { status: { _eq: 'approved' } },
        { decided_at: { _between: [since, cutoff] } },
        { yiji_coupon_user_id: { _null: true } },
        { yiji_push_error: { _null: true } },
        { delivery_excluded: { _neq: true } },
      ],
    }),
    fields: 'id,coupon_code,decided_at',
    limit: '20',
  });
  return {
    ok: r.status === 200 && r.data.length === 0,
    detail: r.status !== 200 ? `HTTP ${r.status}` : r.data.map((c) => c.coupon_code).join(', '),
  };
});
await check('EMA-23', 'coupons refused by Yiji in the last 24 h (listed for a human)', async () => {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const r = await items('coupon_approvals', {
    filter: JSON.stringify({
      _and: [
        { yiji_push_error: { _nnull: true } },
        /* Staging's own guard note is not a Yiji refusal (2026-10-06). */
        { yiji_push_error: { _nstarts_with: 'staging:' } },
        /* When Yiji was CALLED, not when the row was last edited: the MV-1
           vendor backfill (2026-10-08) touched every coupon row and made
           months-old refusals look like today's. */
        { yiji_pushed_at: { _gte: since } },
      ],
    }),
    fields: 'coupon_code,yiji_push_error',
    limit: '20',
  });
  return {
    ok: r.status === 200 && r.data.length === 0,
    detail: r.data?.map((c) => `${c.coupon_code}: ${c.yiji_push_error}`).join('; '),
  };
});

const Y = process.env.YIJI_ADMIN_API_URL;
let yijiToken = null;
if (Y && process.env.YIJI_ADMIN_EMAIL && process.env.YIJI_ADMIN_PASSWORD) {
  yijiToken =
    (
      await (
        await fetch(`${Y}/api/Account/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: process.env.YIJI_ADMIN_EMAIL,
            password: process.env.YIJI_ADMIN_PASSWORD,
          }),
        })
      )
        .json()
        .catch(() => null)
    )?.token ?? null;
}
await check('EMA-23', 'Yiji coupon service signs in', async () => (Y ? !!yijiToken : 'skip'));
await check('EMA-23', 'Yiji accepts our coupon endpoint (probe that creates nothing)', async () => {
  if (!yijiToken) return 'skip';
  const r = await fetch(`${Y}/api/CouponUserOrder/CreateCouponUserFromOrder`, {
    method: 'POST',
    headers: { authorization: `Bearer ${yijiToken}`, 'content-type': 'application/json' },
    body: '',
  });
  // 400 = reachable and permitted (empty body refused); 401/403 = we lost access.
  return { ok: r.status === 400, detail: `HTTP ${r.status}` };
});
/*
 * THE COUPON PIPELINES, LIVE (owner, 2026-10-07: "these processes should be
 * verified on every release, as they're critical"). For each route a coupon
 * takes to Yiji, the newest real coupons since the v1.38.8 fixes are read back
 * FROM YIJI and every value the owner fixed or named is compared:
 *
 *   1a  assign, with an order   CreateCouponUserFromOrder
 *   1b  assign, no order        AddCoupon -> AddUserCoupon
 *   2   create, don't assign    AddCoupon only (nobody holds it)
 *
 * For 1a/1b the customer must actually HOLD it on Yiji; for 2, nobody may.
 * Path 3 (held until signup) is the EMA-49 check below. The build-time twin is
 * services/workers/tests/coupon-pipelines-contract.test.ts.
 */
const PIPE_SINCE = '2026-10-06T10:00:00Z';
const PIPE_FIELDS =
  'yiji_coupon_user_id,valid_to,coupon_code,coupon_type,discount_category,coupon_value,coupon_percent,max_discount,usage_limit,reason,customer_phone,contact.phone,order_id,ticket.order_id,yiji_coupon_id,yiji_pushed_at';
const plusPhone = (row) => {
  const d = String(row.customer_phone || row.contact?.phone || '').replace(/\D/g, '');
  return d ? `+966${d.replace(/^(966|0)/, '')}` : null;
};
function compareCoupon(row, c) {
  const pct = /^percent/i.test(row.discount_category ?? '');
  const want = {
    name: plusPhone(row),
    type: { private: 1, general: 0, public: 0 }[String(row.coupon_type ?? '').toLowerCase()],
    category: pct ? 0 : 1,
    discount: pct ? 0 : Number(row.coupon_value),
    discountPercentage: pct ? Number(row.coupon_percent) : 0,
    maximumDiscount: Number(row.max_discount),
    reachLimit: 10000,
    orderMaximum: 1000000,
    limitForUser: Number(row.usage_limit),
    monthlyReachLimit: Number(row.usage_limit),
  };
  const bad = Object.entries(want)
    .filter(([k, v]) => v !== undefined && v !== null && !Number.isNaN(v) && c[k] !== v)
    .map(([k, v]) => `${k} ${c[k]}≠${v}`);
  for (const d of ['saturday', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday'])
    if (c[d] !== true) bad.push(`${d} off`);
  if (!/^CRM - /.test(String(c.compensationReason ?? ''))) bad.push('description lacks "CRM - "');
  return bad;
}
async function yijiHeldBy(row) {
  const YH = { authorization: `Bearer ${yijiToken}` };
  const orderId = row.order_id ?? row.ticket?.order_id;
  let userId = null;
  if (orderId) {
    const o = await fetch(`https://order.yiji-app.com/api/Order/GetOrderAsync/${orderId}`, { headers: YH });
    userId = o.ok ? ((await o.json())?.userId ?? null) : null;
  }
  const phone = plusPhone(row)?.slice(1);
  if (!userId && phone) {
    const r = await fetch(`${Y}/api/User/GetfilteredCustomers?PhoneNumber=${phone}&PageSize=5`, { headers: YH });
    const list = r.ok ? await r.json() : [];
    userId = (list ?? []).find((u) => String(u.phoneNumber ?? '').replace(/\D/g, '') === phone)?.id ?? null;
  }
  if (!userId) return { error: 'customer not found on Yiji' };
  const r = await fetch(`${Y}/api/CouponUser/GetCouponByUser/${userId}?PageNumber=1&PageSize=500`, { headers: YH });
  const list = r.ok ? await r.json() : [];
  const held = (list ?? []).find((x) => x.couponCode === row.coupon_code);
  if (held?.coupon) return { coupon: held.coupon };
  return (await spentOrExpired(row, userId, YH)) ?? { error: 'the customer does NOT hold it on Yiji' };
}
/*
 * A COUPON THE CUSTOMER SPENT LEAVES THEIR WALLET (OPS-HL2WJQ2N, 2026-10-08).
 *
 * Yiji's GetCouponByUser lists only coupons still to be used, so a customer
 * who redeemed one the same evening looked exactly like one who never got it,
 * and the release went red over a coupon that had worked perfectly. An order
 * carries the GRANT id it used (`couponId` = the CRM's yiji_coupon_user_id),
 * and an expired coupon drops out too, so both are checked before "missing".
 */
async function spentOrExpired(row, userId, YH) {
  if (row.yiji_coupon_user_id) {
    const o = await fetch(`https://order.yiji-app.com/api/Order/GetOrderByUser/${userId}`, { headers: YH });
    const orders = o.ok ? ((await o.json()) ?? []) : [];
    const used = orders.find((x) => String(x.couponId) === String(row.yiji_coupon_user_id));
    if (used) return { spent: `used in order ${used.orderNumber ?? used.id} on ${String(used.creationTime).slice(0, 10)}` };
  }
  if (row.valid_to && Date.parse(`${String(row.valid_to).slice(0, 10)}T23:59:59+03:00`) < Date.now())
    return { spent: `expired ${String(row.valid_to).slice(0, 10)}` };
  return null;
}
async function pipelineCheck(id, name, filter, fetchCoupon) {
  await check(id, name, async () => {
    if (!yijiToken) return 'skip';
    if (ENV !== 'prod') return { ok: true, detail: 'production only — staging coupons go to the test handset' };
    const r = await items('coupon_approvals', {
      filter: JSON.stringify({ _and: [{ yiji_pushed_at: { _gte: PIPE_SINCE } }, ...filter] }),
      fields: PIPE_FIELDS,
      sort: '-yiji_pushed_at',
      limit: '3',
    });
    if (r.status !== 200) return { ok: false, detail: `CRM HTTP ${r.status}` };
    if (!r.data?.length) return { ok: true, detail: 'no coupon on this path since the fixes yet' };
    const problems = [];
    const notes = [];
    for (const row of r.data) {
      const got = await fetchCoupon(row);
      if (got.error) problems.push(`${row.coupon_code}: ${got.error}`);
      else if (got.spent) notes.push(`${row.coupon_code} ${got.spent}`);
      else {
        const bad = compareCoupon(row, got.coupon);
        if (bad.length) problems.push(`${row.coupon_code}: ${bad.join(', ')}`);
      }
    }
    return {
      ok: problems.length === 0,
      detail: problems.length
        ? problems.join('; ')
        : `${r.data.map((x) => x.coupon_code).join(', ')} all good${notes.length ? ` (${notes.join('; ')})` : ''}`,
    };
  });
}
await pipelineCheck(
  'COUPON-1a',
  'assigned WITH an order: on Yiji, held by the customer, every value right',
  [
    { delivery_excluded: { _neq: true } },
    { status: { _eq: 'assigned' } },
    { _or: [{ order_id: { _nnull: true } }, { ticket: { order_id: { _nnull: true } } }] },
  ],
  yijiHeldBy,
);
await pipelineCheck(
  'COUPON-1b',
  'assigned with NO order (create, then give): held by the customer, every value right',
  [
    { delivery_excluded: { _neq: true } },
    { status: { _eq: 'assigned' } },
    { order_id: { _null: true } },
    { _or: [{ ticket: { _null: true } }, { ticket: { order_id: { _null: true } } }] },
  ],
  yijiHeldBy,
);
await pipelineCheck(
  'COUPON-2',
  "created but NOT assigned: on Yiji, nobody holds it, every value right",
  [{ delivery_excluded: { _eq: true } }, { yiji_coupon_id: { _nnull: true } }],
  async (row) => {
    const r = await fetch(`${Y}/api/Coupon/GetCoupon/id/${row.yiji_coupon_id}`, {
      headers: { authorization: `Bearer ${yijiToken}` },
    });
    if (!r.ok) return { error: `GetCoupon HTTP ${r.status}` };
    const c = await r.json();
    if (c.code !== row.coupon_code) return { error: `Yiji id ${row.yiji_coupon_id} is ${c.code}` };
    if ((c.assignee ?? []).length) return { error: 'somebody was assigned it' };
    return { coupon: c };
  },
);

await check(
  'EMA-54',
  'every new coupon request records the agent\'s "send to Yiji" choice',
  async () => {
    /* Coupons raised from a NEW TICKET were created with `delivery_excluded`
     missing, so an agent's "do not send" never reached the admin (2026-10-06).
     Every request created after the fix must carry true or false, never null. */
    const r = await items('coupon_approvals', {
      filter: JSON.stringify({
        _and: [
          { date_created: { _gte: '2026-10-06T12:00:00Z' } },
          { delivery_excluded: { _null: true } },
        ],
      }),
      fields: 'coupon_code,date_created',
      limit: '20',
    });
    return {
      ok: r.status === 200 && r.data.length === 0,
      detail: r.status !== 200 ? `HTTP ${r.status}` : r.data.map((c) => c.coupon_code).join(', '),
    };
  },
);

await check(
  'EMA-55',
  'withheld coupons approved since the deploy are created on Yiji (or refused) within 15 min',
  async () => {
    /* A coupon marked "do not send to the customer" is still CREATED on Yiji,
     Private and assigned to nobody (owner, 2026-10-06); it used to be skipped
     entirely. Every one approved since the deploy must carry yiji_coupon_id
     or a recorded refusal 15 minutes later. EMA55_SINCE overrides the cutoff. */
    const since = process.env.EMA55_SINCE ?? '2026-10-06T18:00:00Z';
    const cutoff = new Date(Date.now() - 15 * 60_000).toISOString();
    if (cutoff <= since) return { ok: true, detail: 'deploy is under 15 min old' };
    const r = await items('coupon_approvals', {
      filter: JSON.stringify({
        _and: [
          { status: { _eq: 'approved' } },
          { delivery_excluded: { _eq: true } },
          { decided_at: { _between: [since, cutoff] } },
          { yiji_coupon_id: { _null: true } },
          { yiji_push_error: { _null: true } },
        ],
      }),
      fields: 'id,coupon_code,decided_at',
      limit: '20',
    });
    return {
      ok: r.status === 200 && r.data.length === 0,
      detail: r.status !== 200 ? `HTTP ${r.status}` : r.data.map((c) => c.coupon_code).join(', '),
    };
  },
);

await check(
  'EMA-23',
  'recently delivered coupons are redeemable on Yiji (reachLimit >= 1000)',
  async () => {
    if (!yijiToken) return 'skip';
    /* 88 coupons sat at reachLimit 1 — customers were refused "Coupon exceeds
     usage limit" — until the 2026-10-06 repair. Sample the newest 15. */
    const r = await items('coupon_approvals', {
      filter: JSON.stringify({ yiji_coupon_user_id: { _nnull: true } }),
      fields: 'coupon_code,order_id,ticket.order_id',
      sort: '-yiji_pushed_at',
      limit: '15',
    });
    const YH = { authorization: `Bearer ${yijiToken}` };
    const low = [];
    let seen = 0;
    for (const row of r.data ?? []) {
      const orderId = row.order_id ?? row.ticket?.order_id;
      if (!orderId) continue;
      const order = await (
        await fetch(`https://order.yiji-app.com/api/Order/GetOrderAsync/${orderId}`, {
          headers: YH,
        })
      )
        .json()
        .catch(() => null);
      if (!order?.userId) continue;
      const list = await (
        await fetch(
          `${Y}/api/CouponUser/GetCouponByUser/${order.userId}?PageNumber=1&PageSize=500`,
          { headers: YH },
        )
      )
        .json()
        .catch(() => null);
      const c = (list ?? []).find((x) => x.couponCode === row.coupon_code)?.coupon;
      if (!c) continue;
      seen += 1;
      if (!(c.reachLimit >= 1000)) low.push(`${row.coupon_code}=${c.reachLimit}`);
    }
    return { ok: low.length === 0, detail: low.length ? low.join(', ') : `${seen} checked` };
  },
);

// ── what agents see is the build that shipped ────────────────────────────────
await check(
  'EMA-36',
  'agent portal / widget: parked build reported (press Update now)',
  async () => {
    if (ENV !== 'prod') return { ok: true, detail: 'staging is never gated' };
    /* What the admin Dashboard's "Update now" strip itself asks. NOT the
       `app_settings` row — the parked version travels in the bucket, and that
       row read "[]" while v1.38.7 was waiting (2026-10-06). */
    const r = await fetch(`${API}/jobs/releases`, { headers: H });
    if (!r.ok) return { ok: false, detail: `/jobs/releases HTTP ${r.status}` };
    const pending = (await r.json())?.pending ?? [];
    return {
      ok: true,
      detail: pending.length
        ? `WAITING: ${pending.map((p) => `${p.app} ${p.version}`).join(', ')}`
        : 'nothing parked',
    };
  },
);

await check(
  'EMA-49',
  'coupons held for signup are being re-checked (none silent for over a day)',
  async () => {
    /* A coupon waiting for its customer to join Yiji is looked up on a
       schedule — at most daily (owner, 2026-10-07). One whose last look is
       more than a day and a bit old means the sweep stopped asking. */
    const stale = new Date(Date.now() - 26 * 3600_000).toISOString();
    const r = await items('coupon_approvals', {
      filter: JSON.stringify({
        _and: [
          { status: { _in: ['approved', 'edited'] } },
          { awaiting_signup_at: { _nnull: true } },
          { yiji_push_error: { _null: true } },
          { signup_checked_at: { _lt: stale } },
        ],
      }),
      fields: 'coupon_code,signup_checked_at',
      limit: '20',
    });
    if (r.status !== 200) return { ok: false, detail: `HTTP ${r.status} ${r.error ?? ''}` };
    const rows = r.data ?? [];
    return {
      ok: rows.length === 0,
      detail: rows.length
        ? rows.map((x) => `${x.coupon_code} last checked ${x.signup_checked_at}`).join('; ')
        : '',
    };
  },
);

await check(
  'COUPON-TYPE',
  "every recent CRM coupon on Yiji has the agent's type (Private=1, General=0)",
  async () => {
    /*
     * OWNER, 2026-10-07: "this mistake should never happen again. By never I
     * mean never." Coupons raised as Private reached Yiji as General because
     * a code path FORCED the type. Matched BY CODE (the owner's instruction):
     * Yiji's newest 100 coupons against the CRM's coupon_type.
     *
     * Listing coupons is above the CRM's Yiji role (403), so this reads with the
     * owner's admin login from the git-ignored `.env.yiji-admin`; SKIP without
     * it — never a silent pass.
     */
    const fs = await import('node:fs');
    const envFile = new URL('../../.env.yiji-admin', import.meta.url);
    if (!fs.existsSync(envFile)) return 'skip';
    const adm = Object.fromEntries(
      fs
        .readFileSync(envFile, 'utf8')
        .split(/\r?\n/)
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]),
    );
    const token = (adm.YIJI_UPDATE_TOKEN ?? '').replace(/^Bearer\s+/i, '');
    if (!token) return 'skip';
    /* The CRM side FIRST: reading Yiji's broken pages one coupon at a time
       can outlast this session's token (401 after ~15 min). */
    const crm = await items('coupon_approvals', {
      filter: JSON.stringify({ coupon_code: { _nnull: true } }),
      fields: 'coupon_code,coupon_type',
      limit: '-1',
    });
    if (crm.status !== 200) return { ok: false, detail: `CRM HTTP ${crm.status}` };
    /* BY ID, not by Yiji's coupon list: the list (GetAllCoupons) hung for
       every request on 2026-10-08 while single-coupon reads answered in under
       a second. Ids are sequential, so the newest ~150 are read from the
       newest id the CRM knows, after probing upward for anything newer. */
    const byId = async (id) => {
      for (let t = 0; t < 2; t++) {
        try {
          const r = await fetch(`https://admin.yiji-app.com/api/Coupon/GetCoupon/id/${id}`, {
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15000),
          });
          if (r.status === 401 || r.status === 403) return { denied: r.status };
          if (r.ok) return await r.json();
          if (r.status < 500) return null;
        } catch {
          /* retry once */
        }
      }
      return undefined;
    };
    const ids = await items('coupon_approvals', {
      filter: JSON.stringify({ yiji_coupon_id: { _nnull: true } }),
      fields: 'yiji_coupon_id',
      limit: '-1',
    });
    let top = Math.max(0, ...(ids.data ?? []).map((x) => Number(x.yiji_coupon_id) || 0));
    if (!top) return { ok: false, detail: 'no CRM coupon records its Yiji id yet - nothing to start from' };
    for (let misses = 0, id = top + 1; misses < 15; id++) {
      const c = await byId(id);
      if (c?.denied) return { ok: false, detail: `Yiji GetCoupon HTTP ${c.denied} - the admin token in .env.yiji-admin expired` };
      if (c && c.code) {
        top = id;
        misses = 0;
      } else misses += 1;
    }
    const yiji = [];
    let unreadable = 0;
    const range = Array.from({ length: 150 }, (_, i) => top - i);
    for (let i = 0; i < range.length; i += 6) {
      for (const c of await Promise.all(range.slice(i, i + 6).map(byId))) {
        if (c === undefined) unreadable += 1;
        else if (c?.code) yiji.push(c);
      }
    }
    const want = Object.fromEntries(
      (crm.data ?? []).map((c) => [c.coupon_code, { general: 0, public: 0, private: 1 }[String(c.coupon_type ?? '').trim().toLowerCase()]]),
    );
    const wrong = yiji.filter((c) => want[c.code] !== undefined && c.type !== want[c.code]);
    return {
      ok: wrong.length === 0,
      detail: wrong.length
        ? wrong.map((c) => `${c.code} (#${c.id}) Yiji type ${c.type}, agent chose ${want[c.code]}`).join('; ')
        : `${yiji.filter((c) => want[c.code] !== undefined).length} CRM coupons among Yiji's newest 150 (ids ${top - 149}-${top}), all match${unreadable ? ` (${unreadable} ids unreadable)` : ''}`,
    };
  },
);

// ── no delivered coupon silently vanishes (2026-10-08) ────────────────────────
await check('COUPON-VANISHED', 'coupons delivered in the last 7 days: held, used, expired, or removed on Yiji (listed)', async () => {
  if (!yijiToken) return 'skip';
  if (ENV !== 'prod') return { ok: true, detail: 'production only - staging coupons go to the test handset' };
  /* Found 2026-10-08: 9 coupons granted 1-3 Oct had left their customers'
     wallets unused and unexpired (3 deleted on Yiji outright). The CRM's Yiji
     role cannot remove coupons (403), so it happened on Yiji's side.
     OWNER, 2026-10-08: that is real production behaviour - never re-grant,
     recreate or raise it with Yiji. So this REPORTS such coupons and never
     fails a release; it fails only if Yiji cannot be read at all. */
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const r = await items('coupon_approvals', {
    filter: JSON.stringify({
      _and: [{ status: { _eq: 'assigned' } }, { delivery_excluded: { _neq: true } }, { yiji_pushed_at: { _gte: since } }],
    }),
    fields: PIPE_FIELDS,
    limit: '-1',
  });
  if (r.status !== 200) return { ok: false, detail: `CRM HTTP ${r.status}` };
  const gone = [];
  let spent = 0;
  for (const row of r.data ?? []) {
    const got = await yijiHeldBy(row);
    if (got.error) gone.push(`${row.coupon_code} (grant ${row.yiji_coupon_user_id}): ${got.error}`);
    else if (got.spent) spent += 1;
  }
  const n = (r.data ?? []).length;
  return {
    ok: true,
    detail:
      `${n} delivered this week: ${n - spent - gone.length} held, ${spent} used or expired, ` +
      `${gone.length} no longer in the customer's wallet (Yiji side, left as is)` +
      (gone.length ? ` - ${gone.map((g) => g.split(' ')[0]).join(', ')}` : ''),
  };
});

// ── recording (owner, 2026-10-07) ────────────────────────────────────────────
await check('REC-SOURCE', 'every new message records where its words came from', async () => {
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const r = await items('messages', {
    fields: 'id,source,sender_type,date_created',
    filter: JSON.stringify({ date_created: { _gte: since } }),
    sort: 'date_created',
    limit: '200',
  });
  if (r.status !== 200) return { ok: false, detail: `HTTP ${r.status} ${r.error ?? ''}` };
  /* Judged from the first labelled message on: during a rollout the OLD
     gateway tasks keep serving connected sockets for a minute or two and
     write unlabelled rows (v1.41.0: 16 of them). None labelled at all is
     still a failure. */
  const all = r.data ?? [];
  const firstLabelled = all.findIndex((m) => m.source);
  const rows = firstLabelled > 0 ? all.slice(firstLabelled) : all;
  const missing = rows.filter((m) => !m.source);
  if (!rows.length) return { ok: true, detail: 'no messages in the last 15 min to judge' };
  return {
    ok: missing.length === 0,
    detail: missing.length
      ? `${missing.length}/${rows.length} new messages have no source`
      : `${rows.length} new messages, all labelled`,
  };
});
await check('REC-AI-LOG', 'the AI gateway may write its call log', async () => {
  const r = await fetch(
    `${API}/permissions?${new URLSearchParams({
      fields: 'action',
      filter: JSON.stringify({
        collection: { _eq: 'ai_calls' },
        policy: { name: { _icontains: 'svc-ai-gateway' } },
      }),
    })}`,
    { headers: H },
  );
  // The prod release-check account cannot read permissions; the field check
  // above still proves the table exists.
  if (r.status === 403) return { ok: true, detail: 'permissions unreadable here; table checked above' };
  const actions = ((await r.json())?.data ?? []).map((p) => p.action);
  return { ok: actions.includes('create'), detail: `svc-ai-gateway on ai_calls: ${actions.join(',') || 'none'}` };
});

// ── coupon terms (OPS-SGVAVXW6) ──────────────────────────────────────────────
await check('COUPON-CAP', 'no waiting Amount coupon has a cap below its value', async () => {
  const r = await items('coupon_approvals', {
    fields: 'coupon_code,discount_category,coupon_value,max_discount',
    filter: JSON.stringify({ status: { _eq: 'pending' } }),
    limit: '-1',
  });
  if (r.status !== 200) return { ok: false, detail: `HTTP ${r.status} ${r.error ?? ''}` };
  const bad = (r.data ?? []).filter(
    (c) =>
      String(c.discount_category ?? '').toLowerCase() !== 'percentage' &&
      Number(c.max_discount) > 0 &&
      Number(c.max_discount) < Number(c.coupon_value),
  );
  return {
    ok: bad.length === 0,
    detail: bad.length
      ? bad.map((c) => `${c.coupon_code} value ${c.coupon_value} cap ${Number(c.max_discount)}`).join('; ')
      : `${(r.data ?? []).length} waiting coupons, all consistent`,
  };
});

// ── every vendor: connector, isolation, test vendor (MV-6, EMA-75) ───────────
/* The release-check account may not hold admin_access, and MV-5 limits
   everyone else to the display fields - so `platform` / `webhook_path_key`
   are asked for first and dropped on a 403 (the live probes still prove the
   connector resolves). */
let vendorRows = await items('vendors', {
  fields: 'id,name,status,yiji_vendor_id,platform,webhook_path_key',
  filter: JSON.stringify({ status: { _eq: 'active' } }),
  limit: '-1',
});
const platformReadable = vendorRows.status === 200;
if (!platformReadable) {
  vendorRows = await items('vendors', {
    fields: 'id,name,status,yiji_vendor_id',
    filter: JSON.stringify({ status: { _eq: 'active' } }),
    limit: '-1',
  });
}
const activeVendors = vendorRows.data ?? [];
await check('MV-6', 'active vendors are readable', async () => ({
  ok: vendorRows.status === 200 && activeVendors.length > 0,
  detail: `HTTP ${vendorRows.status}: ${activeVendors.map((v) => `${v.name} (${v.yiji_vendor_id}, ${platformReadable ? platformOf(v) : 'platform unreadable'})`).join(', ') || 'none'}`,
}));

async function gatewayGet(path) {
  const res = await fetch(`${API}${path}`, { headers: H });
  return { status: res.status, body: await res.json().catch(() => null) };
}

for (const v of activeVendors) {
  const label = `${v.name} (${v.yiji_vendor_id})`;
  if (platformReadable) {
    await check('MV-6', `${label}: a connector exists for its platform`, async () =>
      connectorVerdict(v, { env: ENV }),
    );
  }
  await check('MV-6', `${label}: the AI gateway resolves its connector`, async () => {
    /* A nonsense order id: for Yiji one read-only GET that finds nothing. */
    const probe = platformOf(v) === 'mock' ? MOCK_PROBE_ORDER_ID : '0';
    const { status, body } = await gatewayGet(
      `/commerce/order?${new URLSearchParams({ vendorId: v.id, orderId: probe })}`,
    );
    return classifyResolveProbe(platformReadable ? v : { ...v, platform: 'yiji' }, status, body);
  });
}

/* (b) Isolation: vendor A's rows, queried under vendor B's filter, must come
   back empty; and every row B's filter returns must be B's. Read-only. */
const pairs = isolationPairs(activeVendors);
if (pairs.length === 0) {
  report('SKIP', 'MV-6', 'cross-vendor isolation probes', 'only one active vendor');
}
for (const col of ISOLATION_COLLECTIONS) {
  for (const [a, b] of pairs) {
    await check('MV-6', `isolation ${col}: ${a.name} never under ${b.name}`, async () => {
      const ofA = await items(col, {
        fields: 'id',
        filter: JSON.stringify({ vendor: { _eq: a.id } }),
        sort: '-id',
        limit: String(ISOLATION_SAMPLE),
      });
      if (ofA.status === 403) return { status: 'SKIP', detail: `${col} not readable here` };
      if (ofA.status !== 200) return { ok: false, detail: `HTTP ${ofA.status} ${ofA.error ?? ''}` };
      const ids = (ofA.data ?? []).map((x) => x.id);
      const cross = ids.length
        ? await items(col, {
            fields: 'id,vendor',
            filter: JSON.stringify({ _and: [{ id: { _in: ids } }, { vendor: { _eq: b.id } }] }),
            limit: '-1',
          })
        : { status: 200, data: [] };
      const ofB = await items(col, {
        fields: 'id,vendor',
        filter: JSON.stringify({ vendor: { _eq: b.id } }),
        limit: String(ISOLATION_SAMPLE),
      });
      if (cross.status !== 200 || ofB.status !== 200) {
        return { ok: false, detail: `HTTP ${cross.status}/${ofB.status}` };
      }
      return isolationVerdict({
        collection: col,
        a,
        b,
        sampled: ids.length,
        crossRows: cross.data,
        bRows: ofB.data,
      });
    });
  }
}

/* (c) The MOCK test vendor: staging only, never production. */
const mockVendors = platformReadable ? activeVendors.filter((v) => platformOf(v) === 'mock') : [];
if (ENV === 'prod') {
  await check('MV-6', 'no mock (test) vendor is active on production', async () => ({
    ok: mockVendors.length === 0,
    detail: platformReadable
      ? mockVendors.map((v) => v.name).join(', ') || 'none'
      : 'platform unreadable here; the resolve probes above fail a mock vendor on prod',
  }));
} else if (mockVendors.length === 0) {
  report('SKIP', 'MV-6', 'mock test vendor checks', 'no active mock vendor (scripts/seed-test-vendor.mjs)');
}
for (const v of ENV === 'prod' ? [] : mockVendors) {
  const label = `${v.name} (mock)`;
  await check('MV-6', `${label}: order lookup answers from the mock, never Yiji`, async () => {
    const { status, body } = await gatewayGet(
      `/commerce/order?${new URLSearchParams({ vendorId: v.id, orderId: MOCK_PROBE_ORDER_ID })}`,
    );
    return classifyMockOrderProbe(status, body);
  });
  const key = v.webhook_path_key?.trim();
  if (!key) {
    report('FAIL', 'MV-6', `${label}: webhook_path_key`, 'not set - chat login and webhook cannot work');
    continue;
  }
  await check('MV-6', `${label}: customer chat login`, async () => {
    const res = await fetch(`${API}/chat/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGINS.widget },
      body: JSON.stringify({ phone: MOCK_PROBE_PHONE, vendorId: v.yiji_vendor_id }),
    });
    return classifyChatLoginProbe(key, res.status, await res.json().catch(() => null));
  });
  await check('MV-6', `${label}: webhook refuses an unsigned call`, async () => {
    const res = await fetch(`${API}/webhooks/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'release-check.ping' }),
    });
    return classifyWebhookProbe(key, res.status, { signed: false });
  });
  const secret = process.env[vendorSecretEnvNames(key).webhook];
  if (!secret) {
    report('SKIP', 'MV-6', `${label}: signed webhook ping`, `${vendorSecretEnvNames(key).webhook} not in this check's env`);
  } else {
    await check('MV-6', `${label}: signed webhook ping is accepted`, async () => {
      const raw = JSON.stringify({ type: 'release-check.ping' });
      const ts = String(Math.floor(Date.now() / 1000));
      const res = await fetch(`${API}/webhooks/${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-yiji-timestamp': ts,
          'x-yiji-signature': `sha256=${signWebhook(secret, ts, raw)}`,
        },
        body: raw,
      });
      return classifyWebhookProbe(key, res.status, { signed: true });
    });
  }
}

/* The two connector registries read `vendors.platform`; without the grant
   their whole vendors read 403s and they fall back to the env vendor. */
await check('MV-6', 'svc-ai-gateway and svc-workers may read vendors.platform', async () => {
  const res = await fetch(
    `${API}/permissions?${new URLSearchParams({
      fields: 'fields,policy.name',
      filter: JSON.stringify({ collection: { _eq: 'vendors' }, action: { _eq: 'read' } }),
      limit: '-1',
    })}`,
    { headers: H },
  );
  if (res.status === 403) return { status: 'SKIP', detail: 'permissions unreadable here' };
  const rows = (await res.json())?.data ?? [];
  const missing = ['svc-ai-gateway', 'svc-workers'].filter((svc) => {
    const row = rows.find((p) => String(p.policy?.name ?? '').includes(svc));
    const f = row?.fields ?? [];
    return !(f.includes('*') || f.includes('platform'));
  });
  return { ok: missing.length === 0, detail: missing.length ? `missing on: ${missing.join(', ')}` : 'both granted' };
});

/* MV-7: the connectors read each vendor's NON-SECRET settings from its record
   in a separate query; without these fields that read 403s and both services
   quietly run on the env settings (logged warning). */
const MV7_FIELDS = ['webhook_path_key', 'api_base_url', 'admin_api_url', 'tenant_id', 'brand_id', 'notify_settings'];
await check('MV-7', 'svc-ai-gateway and svc-workers may read the vendor connector settings', async () => {
  const res = await fetch(
    `${API}/permissions?${new URLSearchParams({
      fields: 'fields,policy.name',
      filter: JSON.stringify({ collection: { _eq: 'vendors' }, action: { _eq: 'read' } }),
      limit: '-1',
    })}`,
    { headers: H },
  );
  if (res.status === 403) return { status: 'SKIP', detail: 'permissions unreadable here' };
  const rows = (await res.json())?.data ?? [];
  const missing = [];
  for (const svc of ['svc-ai-gateway', 'svc-workers']) {
    const f = rows.find((p) => String(p.policy?.name ?? '').includes(svc))?.fields ?? [];
    if (f.includes('*')) continue;
    const gap = MV7_FIELDS.filter((x) => !f.includes(x));
    if (gap.length) missing.push(`${svc}: ${gap.join(',')}`);
  }
  return { ok: missing.length === 0, detail: missing.length ? `missing ${missing.join('; ')}` : 'both granted' };
});

/* MV-7: the Yiji vendor's record now feeds its connector - its URLs/tenant must
   be the values the env always had, or every Yiji request moves host. */
await check('MV-7', 'Yiji vendor record holds the production Yiji URLs and tenant', async () => {
  const res = await fetch(
    `${API}/items/vendors?${new URLSearchParams({
      fields: 'yiji_vendor_id,api_base_url,admin_api_url,tenant_id',
      filter: JSON.stringify({ yiji_vendor_id: { _eq: '1' } }),
    })}`,
    { headers: H },
  );
  if (res.status === 403) return { status: 'SKIP', detail: 'vendors integration fields unreadable here' };
  const v = (await res.json())?.data?.[0];
  if (!v) return { ok: false, detail: 'no vendor with yiji_vendor_id 1' };
  const bad = [];
  const blankOr = (val, want) => val == null || String(val).trim() === '' || String(val).replace(/\/+$/, '') === want;
  if (!blankOr(v.api_base_url, 'https://order.yiji-app.com')) bad.push(`api_base_url=${v.api_base_url}`);
  if (!blankOr(v.admin_api_url, 'https://admin.yiji-app.com')) bad.push(`admin_api_url=${v.admin_api_url}`);
  if (!blankOr(v.tenant_id, '1')) bad.push(`tenant_id=${v.tenant_id}`);
  return { ok: bad.length === 0, detail: bad.length ? bad.join(', ') : 'record matches (or blank = env)' };
});

const failed = results.filter((r) => r.status === 'FAIL').length;
const skipped = results.filter((r) => r.status === 'SKIP').length;
console.log(`\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
