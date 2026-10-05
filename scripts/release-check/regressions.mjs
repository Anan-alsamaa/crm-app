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
 */
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
async function check(id, name, fn) {
  try {
    const r = await fn();
    if (r === 'skip') report('SKIP', id, name, 'credentials not provided');
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
];
for (const [id, col, fields] of FIELD_QUERIES)
  await check(id, `${col}: every field the code reads exists`, async () => {
    const r = await items(col, { fields, limit: '1' });
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
  return ((await r.json())?.data ?? []).length > 0;
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
      _and: [{ yiji_push_error: { _nnull: true } }, { date_updated: { _gte: since } }],
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
await check(
  'EMA-39/45',
  'newest delivered coupon on Yiji: +966 name, reason in compensation, fixed limits',
  async () => {
    if (!yijiToken) return 'skip';
    const r = await items('coupon_approvals', {
      filter: JSON.stringify({
        _and: [
          { yiji_coupon_user_id: { _nnull: true } },
          { yiji_pushed_at: { _gte: '2026-10-05T12:30:00Z' } },
        ],
      }),
      fields: 'coupon_code,order_id,ticket.order_id,yiji_pushed_at',
      sort: '-yiji_pushed_at',
      limit: '1',
    });
    const row = r.data?.[0];
    if (!row)
      return { ok: true, detail: 'no coupon delivered since v1.38.5 yet — nothing to compare' };
    const orderId = row.order_id ?? row.ticket?.order_id;
    if (!orderId) return { ok: true, detail: `${row.coupon_code} has no order; skipped` };
    const YH = { authorization: `Bearer ${yijiToken}` };
    const order = await (
      await fetch(`https://order.yiji-app.com/api/Order/GetOrderAsync/${orderId}`, { headers: YH })
    ).json();
    const list = await (
      await fetch(`${Y}/api/CouponUser/GetCouponByUser/${order.userId}?PageNumber=1&PageSize=500`, {
        headers: YH,
      })
    ).json();
    const c = (list ?? []).find((x) => x.couponCode === row.coupon_code)?.coupon;
    if (!c)
      return { ok: false, detail: `${row.coupon_code} not found on the customer's Yiji account` };
    const ok =
      /^\+9665\d{8}$/.test(c.name) &&
      c.reachLimit === 10000 &&
      c.orderMaximum === 1000000 &&
      !!c.compensation;
    return {
      ok,
      detail: `${row.coupon_code}: name=${c.name} reachLimit=${c.reachLimit} orderMaximum=${c.orderMaximum}`,
    };
  },
);

// ── what agents see is the build that shipped ────────────────────────────────
await check(
  'EMA-36',
  'agent portal / widget: parked build reported (press Update now)',
  async () => {
    if (ENV !== 'prod') return { ok: true, detail: 'staging is never gated' };
    const r = await fetch(
      `${API}/items/app_settings?${new URLSearchParams({ filter: JSON.stringify({ key: { _eq: 'release.pending' } }), fields: 'value' })}`,
      { headers: H },
    );
    const pending = JSON.parse((await r.json())?.data?.[0]?.value ?? '[]');
    return {
      ok: true,
      detail: pending.length
        ? `WAITING: ${pending.map((p) => `${p.app} ${p.version}`).join(', ')}`
        : 'nothing parked',
    };
  },
);

const failed = results.filter((r) => r.status === 'FAIL').length;
const skipped = results.filter((r) => r.status === 'SKIP').length;
console.log(`\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
