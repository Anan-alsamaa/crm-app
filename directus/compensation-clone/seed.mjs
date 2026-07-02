/**
 * Seeds SYNTHETIC sample data into the local compensation collections so the
 * agent-portal section renders during development. No production data / PII is
 * copied. Idempotent by request_code. Local only.
 *
 *   node directus/compensation-clone/seed.mjs
 */
const LOCAL = process.env.DIRECTUS_URL ?? 'http://localhost:8055';
const EMAIL = process.env.DIRECTUS_ADMIN_EMAIL ?? 'e.habibi@anan.sa';
const PASSWORD = process.env.DIRECTUS_ADMIN_PASSWORD ?? '123456';

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

await login();

// Issue categories + issues (referenced by requests).
const cats = [
  { id: 'missing-items', name: 'Missing items', name_ar: 'أصناف مفقودة' },
  { id: 'late-delivery', name: 'Late delivery', name_ar: 'تأخير في التوصيل' },
];
for (const c of cats) {
  if (!(await api('GET', `/items/Com_Issue_Categories/${c.id}`)).ok) {
    await api('POST', '/items/Com_Issue_Categories', c);
  }
}

const REQUESTS = [
  {
    request_code: 'CR-1001', status: 'Pending', customer_name: 'Sara A.', customer_mobile: '+966500000011',
    customer_id: 'cust-1001', order_id: 'ORD-77120', order_total: 86, delivery_fee: 12,
    brand_name: 'Burger Palace', restaurant_name: 'Burger Palace - Olaya', complaint_type: 'missing-items',
    description: 'Missing the fries and one drink from the order.', user_complaint_amount: 25,
    items: [{ name: 'Large Fries', quantity: 1, price: 15 }, { name: 'Cola 330ml', quantity: 1, price: 10 }],
  },
  {
    request_code: 'CR-1002', status: 'In Progress', customer_name: 'Khalid M.', customer_mobile: '+966500000022',
    customer_id: 'cust-1002', order_id: 'ORD-77088', order_total: 142, delivery_fee: 0,
    brand_name: 'Pasta House', restaurant_name: 'Pasta House - Malaz', complaint_type: 'late-delivery',
    description: 'Order arrived 50 minutes late and cold.', user_complaint_amount: 40,
    suggested_compensation_value: '20', items: [],
  },
  {
    request_code: 'CR-1003', status: 'Approved', customer_name: 'Noura F.', customer_mobile: '+966500000033',
    customer_id: 'cust-1003', order_id: 'ORD-76950', order_total: 60, delivery_fee: 10,
    brand_name: 'Sushi Bar', restaurant_name: 'Sushi Bar - Nakheel', complaint_type: 'missing-items',
    description: 'Wasabi and ginger missing.', final_compensation_value: 15, coupon_code: 'DEV-APPROVED-15', items: [],
  },
  {
    request_code: 'CR-1004', status: 'Rejected', customer_name: 'Omar T.', customer_mobile: '+966500000044',
    customer_id: 'cust-1004', order_id: 'ORD-76800', order_total: 30, delivery_fee: 8,
    brand_name: 'Coffee Co', restaurant_name: 'Coffee Co - Downtown', complaint_type: 'late-delivery',
    description: 'Claimed cold coffee but delivered on time.', decline_reason: 'Delivered within SLA; no valid issue.', items: [],
  },
];

for (const r of REQUESTS) {
  const found = await api('GET', `/items/compensation_requests?filter[request_code][_eq]=${r.request_code}&fields=id`);
  if (found.ok && found.json?.data?.length) { console.log(`= ${r.request_code} exists`); continue; }
  const { items, ...row } = r;
  const created = await api('POST', '/items/compensation_requests', { ...row, timestamp: undefined });
  if (!created.ok) { console.log(`✗ ${r.request_code} (${created.status}) ${JSON.stringify(created.json).slice(0, 200)}`); continue; }
  const id = created.json.data.id;
  for (const it of items ?? []) {
    await api('POST', '/items/Compensation_Request_items', { ...it, compensation_request_id: id });
  }
  console.log(`+ ${r.request_code} (${r.status}) with ${items?.length ?? 0} item(s)`);
}
console.log('seed done.');
