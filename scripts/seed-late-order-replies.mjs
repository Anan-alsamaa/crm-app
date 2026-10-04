/**
 * Seed the two late-order libraries: ready REASONS and ready ACTIONS.
 *
 * Asked for by operations (2026-10-04): the "/" gesture the chat composer uses
 * should work in the late-order decision box too — *"the quick reply feature in
 * reason box in assign coupon for late orders should also be implemented for
 * action taken. the values in reason and action taken are new and isolated from
 * each other and the inbox quick replies."*
 *
 * THREE SEPARATE LIBRARIES, keyed by `quick_replies.kind`. They answer three
 * different questions — a chat reply is addressed to a CUSTOMER, a reason
 * explains why an order was late, an action says what was done about it — so
 * pooling them would offer an agent mostly wrong answers in all three places.
 *
 * The wording below is a STARTING POINT, not a specification. Operations own
 * this library and edit it in the admin portal; these exist so the feature can
 * be exercised the day it ships rather than showing an empty list.
 *
 * Dry run by default. Idempotent: matched by label WITHIN its kind, so a label
 * may legitimately repeat across libraries.
 *
 *   node scripts/seed-late-order-replies.mjs
 *   node scripts/seed-late-order-replies.mjs --write
 */
const WRITE = process.argv.includes('--write');
const DIRECTUS = process.env.DIRECTUS_URL ?? 'http://localhost:8055';
const EMAIL = process.env.DIRECTUS_ADMIN_EMAIL;
const PASSWORD = process.env.DIRECTUS_ADMIN_PASSWORD;
if (!EMAIL || !PASSWORD) throw new Error('set DIRECTUS_ADMIN_EMAIL and DIRECTUS_ADMIN_PASSWORD');

/** `{order}`, `{brand}` and `{restaurant}` are filled from the row at click time. */
const ROWS = [
  // WHY the order was late. Phrased as statements of fact, because they are
  // recorded against the order and read back months later in a report.
  ['late_order_reason', 'ar', 'تأخر المطعم', 'تأخر فرع {restaurant} في تجهيز الطلب.'],
  ['late_order_reason', 'ar', 'تأخر المندوب', 'تأخر وصول المندوب لاستلام الطلب.'],
  ['late_order_reason', 'ar', 'ضغط الطلبات', 'ضغط كبير على الفرع في وقت الذروة.'],
  ['late_order_reason', 'ar', 'صنف غير متوفر', 'عدم توفر أحد الأصناف أخّر تجهيز الطلب.'],
  [
    'late_order_reason',
    'en',
    'Kitchen delay',
    'The {restaurant} branch was slow to prepare the order.',
  ],
  ['late_order_reason', 'en', 'Driver delay', 'The driver was late collecting the order.'],
  ['late_order_reason', 'en', 'Peak load', 'The branch was under heavy load at peak time.'],
  ['late_order_reason', 'en', 'Item unavailable', 'An unavailable item held up preparation.'],
  // WHAT WAS DONE about it. Phrased in the past tense for the same reason.
  ['late_order_action', 'ar', 'تواصل مع الفرع', 'تم التواصل مع فرع {restaurant} والمتابعة معهم.'],
  ['late_order_action', 'ar', 'تواصل مع العميل', 'تم التواصل مع العميل والاعتذار عن التأخير.'],
  ['late_order_action', 'ar', 'صرف تعويض', 'تم صرف قسيمة تعويض للعميل.'],
  ['late_order_action', 'ar', 'تصعيد للإدارة', 'تم تصعيد الحالة لمدير المنطقة.'],
  [
    'late_order_action',
    'en',
    'Called the branch',
    'Called {restaurant} and followed up with them.',
  ],
  [
    'late_order_action',
    'en',
    'Called the customer',
    'Called the customer and apologised for the delay.',
  ],
  ['late_order_action', 'en', 'Compensated', 'Issued a compensation voucher to the customer.'],
  ['late_order_action', 'en', 'Escalated', 'Escalated the case to the area manager.'],
];

const login = await fetch(`${DIRECTUS}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!login.ok) throw new Error(`login failed: ${login.status}`);
const token = (await login.json()).data.access_token;
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

const existing =
  (
    await (
      await fetch(`${DIRECTUS}/items/quick_replies?fields=id,label,kind&limit=-1`, { headers: H })
    ).json()
  ).data ?? [];

console.log(`${DIRECTUS}`);
console.log(`${ROWS.length} rows${WRITE ? '' : ' (dry run)'}\n`);

let created = 0;
let updated = 0;
for (const [kind, lang, label, text] of ROWS) {
  /* Matched WITHIN its kind: "Compensated" could legitimately exist as both an
     action and a chat reply, and a global label check would refuse the second. */
  const found = existing.find((r) => r.label === label && (r.kind ?? 'chat') === kind);
  const payload = {
    label,
    text,
    lang,
    kind,
    sort: ROWS.findIndex((r) => r[2] === label),
    active: true,
  };
  if (WRITE) {
    const res = found
      ? await fetch(`${DIRECTUS}/items/quick_replies/${found.id}`, {
          method: 'PATCH',
          headers: H,
          body: JSON.stringify(payload),
        })
      : await fetch(`${DIRECTUS}/items/quick_replies`, {
          method: 'POST',
          headers: H,
          body: JSON.stringify(payload),
        });
    if (!res.ok) {
      console.warn(`  ! ${label}: ${res.status} ${await res.text()}`);
      continue;
    }
  }
  if (found) updated += 1;
  else created += 1;
  console.log(`  ${found ? 'update' : 'create'}  [${kind}/${lang}] ${label}`);
}

console.log(`\ncreated: ${created}\nupdated: ${updated}`);
if (!WRITE) console.log('\nRe-run with --write to apply.');
