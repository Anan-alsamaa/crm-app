/**
 * Seed the ready-reply library agents pick from above the composer.
 *
 * The wording is lifted from the operations portal's own canned replies, in
 * both languages, because agents already say these sentences — the point of the
 * feature is that they stop retyping them, not that they learn new ones.
 *
 * Dry run by default; pass --write to apply. Idempotent: matched by label, so
 * re-running updates rather than stacking duplicates. Safe to run after
 * operations have edited the wording — it will overwrite, so only run it once
 * unless you mean to reset.
 *
 *   node scripts/seed-quick-replies.mjs
 *   node scripts/seed-quick-replies.mjs --write
 */
const WRITE = process.argv.includes('--write');
const DIRECTUS = process.env.DIRECTUS_URL ?? 'http://localhost:8055';
const EMAIL = process.env.DIRECTUS_ADMIN_EMAIL ?? 'e.habibi@anan.sa';
const PASSWORD = process.env.DIRECTUS_ADMIN_PASSWORD ?? '123456';

/** {order} {name} {brand} {restaurant} are filled from the conversation. */
const REPLIES = [
  [
    'افتتاحية',
    'ar',
    'مرحباً عزيزي، معك خدمة عملاء تطبيق يجي، تواصلنا بخصوص شكواكم على الطلب رقم {order}',
  ],
  ['قيد المتابعة', 'ar', 'شكراً لتواصلكم. جاري التحقق مع فرع {restaurant} وسنوافيكم بالرد.'],
  ['تعويض', 'ar', 'نعتذر عن هذه التجربة. تم صرف قسيمة تعويض لحسابكم.'],
  ['إغلاق', 'ar', 'سعدنا بخدمتكم. في حال احتجتم أي مساعدة أخرى لا تترددوا بالتواصل.'],
  ['Opening', 'en', 'Hello, this is Yiji customer care about your order {order}.'],
  ['Checking', 'en', "Thanks for letting us know — I'm checking with {restaurant} now."],
  ['Voucher', 'en', 'A voucher has been added to your account. Sorry again for the trouble.'],
  ['Closing', 'en', 'Glad we could help. Reach out any time if you need anything else.'],
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
      await fetch(`${DIRECTUS}/items/quick_replies?fields=id,label&limit=-1`, { headers: H })
    ).json()
  ).data ?? [];

console.log(`${REPLIES.length} ready replies${WRITE ? '' : ' (dry run)'}\n`);

let created = 0;
let updated = 0;
for (const [label, lang, text] of REPLIES) {
  const found = existing.find((r) => r.label === label);
  const payload = {
    label,
    lang,
    text,
    sort: REPLIES.findIndex((r) => r[0] === label),
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
  console.log(`  ${found ? 'update' : 'create'}  [${lang}] ${label}`);
}

console.log(`\ncreated: ${created}\nupdated: ${updated}`);
if (!WRITE) console.log('\nRe-run with --write to apply.');
