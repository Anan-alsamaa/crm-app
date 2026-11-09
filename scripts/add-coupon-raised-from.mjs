#!/usr/bin/env node
/**
 * Add `coupon_approvals.raised_from` and fill it in for every existing coupon
 * (owner, 2026-11-09: "it should be saved in the compensation data that it was
 * raised by late orders page"; chats and tickets count as one place).
 *
 *   late_orders  the Late Orders page
 *   ticket       a ticket (or a chat)
 *   yiji_api     the Yiji ticket API's compensation rules
 *
 * How an existing coupon is classified, in this order:
 *   1. external_id set, or requested by the Yiji API user    -> yiji_api
 *   2. no ticket but an order id (a late DELIVERY coupon)     -> late_orders
 *   3. its ticket was raised by the Late Orders page, or
 *      a Late Orders decision on the same order, by the same
 *      person, within 30 minutes of the coupon (a late
 *      PREPARATION coupon, which has a ticket beside it)       -> late_orders
 *   4. everything else                                        -> ticket
 * Only rows whose raised_from is still empty are written: a re-run never
 * overwrites a value.
 *
 * Dry run by default (prints the counts and every late_orders / yiji_api row):
 *   node scripts/add-coupon-raised-from.mjs
 *   node scripts/add-coupon-raised-from.mjs --write
 */

const WRITE = process.argv.includes('--write');
const D = process.env.DIRECTUS_URL ?? 'http://localhost:8055';
const WINDOW_MS = 30 * 60 * 1000;

async function token() {
  if (process.env.DIRECTUS_TOKEN) return process.env.DIRECTUS_TOKEN;
  const email = process.env.DIRECTUS_ADMIN_EMAIL;
  const password = process.env.DIRECTUS_ADMIN_PASSWORD;
  if (!email || !password) {
    console.error('Need DIRECTUS_TOKEN, or DIRECTUS_ADMIN_EMAIL + DIRECTUS_ADMIN_PASSWORD.');
    process.exit(1);
  }
  const res = await fetch(`${D}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!body?.data?.access_token) {
    console.error('Login failed:', JSON.stringify(body?.errors ?? body).slice(0, 200));
    process.exit(1);
  }
  return body.data.access_token;
}

const AT = await token();
const H = { authorization: `Bearer ${AT}`, 'content-type': 'application/json' };
const get = async (p) => {
  const r = await (await fetch(D + p, { headers: H })).json();
  if (r.errors) throw new Error(`${p}: ${r.errors[0].message}`);
  return r.data;
};

console.log(`${WRITE ? 'APPLYING' : 'DRY RUN'} against ${D}\n`);

// 1. The field.
const has = (await fetch(`${D}/fields/coupon_approvals/raised_from`, { headers: H })).ok;
if (has) console.log('  = coupon_approvals.raised_from already exists');
else {
  console.log('  + coupon_approvals.raised_from (string, choices, indexed, nullable)');
  if (WRITE) {
    const res = await fetch(`${D}/fields/coupon_approvals`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        field: 'raised_from',
        type: 'string',
        schema: { is_nullable: true, is_indexed: true },
        meta: {
          interface: 'select-dropdown',
          options: {
            choices: [
              { text: 'Late Orders page', value: 'late_orders' },
              { text: 'Ticket', value: 'ticket' },
              { text: 'Yiji API', value: 'yiji_api' },
            ],
          },
          width: 'half',
          note: 'Where this coupon was raised: late_orders (Late Orders page), ticket (a ticket or chat), yiji_api (Yiji ticket API rule). A replacement keeps its original value.',
        },
      }),
    });
    if (!res.ok) {
      console.error('Field create failed:', (await res.text()).slice(0, 300));
      process.exit(1);
    }
  }
}

// 2. The existing coupons.
const fieldNow = WRITE || has;
const coupons = await get(
  `/items/coupon_approvals?limit=-1&sort=date_created&fields=id,coupon_code,date_created,order_id,external_id,ticket.id,ticket.order_id,requested_by.id,requested_by.email${fieldNow ? ',raised_from' : ''}`,
);
const decisions = await get(
  '/items/late_order_decisions?limit=-1&fields=order_id,date_created,decided_by,action,ticket',
);
const yijiUsers = new Set(
  (await get('/users?limit=-1&fields=id,email,first_name&filter[email][_icontains]=yiji')).map(
    (u) => u.id,
  ),
);
const lateTickets = new Set(decisions.map((d) => d.ticket).filter(Boolean));
const byOrder = new Map();
for (const d of decisions) {
  const k = String(d.order_id ?? '').trim();
  if (!k) continue;
  if (!byOrder.has(k)) byOrder.set(k, []);
  byOrder.get(k).push(d);
}

function classify(c) {
  if (c.external_id || yijiUsers.has(c.requested_by?.id)) return ['yiji_api', 'Yiji API'];
  const order = String(c.order_id ?? c.ticket?.order_id ?? '').trim();
  if (!c.ticket?.id && order) return ['late_orders', 'no ticket, order ' + order];
  if (c.ticket?.id && lateTickets.has(c.ticket.id))
    return ['late_orders', 'ticket raised by the Late Orders page'];
  const t = Date.parse(c.date_created);
  const near = (byOrder.get(order) ?? []).find(
    (d) =>
      d.decided_by === c.requested_by?.id && Math.abs(Date.parse(d.date_created) - t) <= WINDOW_MS,
  );
  if (near)
    return ['late_orders', `ticket + Late Orders decision on ${order} (${near.action ?? '-'})`];
  return ['ticket', ''];
}

const todo = coupons.filter((c) => !c.raised_from);
const counts = { late_orders: 0, ticket: 0, yiji_api: 0 };
const plan = [];
for (const c of todo) {
  const [v, why] = classify(c);
  counts[v]++;
  plan.push({ id: c.id, v });
  if (v !== 'ticket')
    console.log(
      `  ${v.padEnd(11)} ${String(c.coupon_code ?? c.id).padEnd(20)} ${c.date_created.slice(0, 10)}  ${why}`,
    );
}
console.log(`\n${coupons.length} coupons, ${todo.length} without raised_from:`, counts);

if (!WRITE) {
  console.log('\nRe-run with --write to apply.');
  process.exit(0);
}
for (const v of Object.keys(counts)) {
  const ids = plan.filter((p) => p.v === v).map((p) => p.id);
  for (let i = 0; i < ids.length; i += 100) {
    const res = await fetch(`${D}/items/coupon_approvals`, {
      method: 'PATCH',
      headers: H,
      body: JSON.stringify({ keys: ids.slice(i, i + 100), data: { raised_from: v } }),
    });
    if (!res.ok) {
      console.error(`PATCH ${v} failed:`, (await res.text()).slice(0, 300));
      process.exit(1);
    }
  }
}
console.log('\nApplied.');
