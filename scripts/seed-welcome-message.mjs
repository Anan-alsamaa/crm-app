/**
 * Seed the automatic welcome message — `رسالة ترحيب`.
 *
 * Asked for by operations (2026-10-04): the greeting a customer sees on their
 * first message should come from a named template they maintain, not from
 * strings compiled into the widget.
 *
 * It lives in `quick_replies`, the library operations already edit in the admin
 * portal (Lists -> Quick replies), because that collection already carries
 * exactly what this needs: a `lang` so Arabic and English are separate rows,
 * and an `active` flag so a greeting can be withdrawn without losing its
 * wording. A new collection for one string would be a second place to look.
 *
 * SEPARATE FROM `seed-quick-replies.mjs` on purpose. That script overwrites the
 * whole reply library, and its own header warns to run it only once unless you
 * mean to reset — which is exactly what you do NOT want when all you are doing
 * is adding a greeting to a CRM that is live.
 *
 * `{name}` is substituted by the widget when the customer is known. With no
 * name on file the placeholder AND the punctuation clinging to it are removed,
 * so a customer never receives "Welcome {name}, how can we help?" — see
 * `welcomeLine` in apps/chat-widget/src/Widget.tsx.
 *
 * Dry run by default. Idempotent: matched by label, so re-running updates
 * rather than stacking duplicates.
 *
 *   node scripts/seed-welcome-message.mjs
 *   node scripts/seed-welcome-message.mjs --write
 *
 * Against staging or production, pass the environment explicitly:
 *
 *   DIRECTUS_URL=https://crm-api-staging.anan.sa \
 *   DIRECTUS_ADMIN_EMAIL=... DIRECTUS_ADMIN_PASSWORD=... \
 *   node scripts/seed-welcome-message.mjs --write
 */
const WRITE = process.argv.includes('--write');
const DIRECTUS = process.env.DIRECTUS_URL ?? 'http://localhost:8055';
const EMAIL = process.env.DIRECTUS_ADMIN_EMAIL ?? 'e.habibi@anan.sa';
const PASSWORD = process.env.DIRECTUS_ADMIN_PASSWORD ?? '123456';

/*
 * THE LABEL IS THE CONTRACT. The gateway finds this row by label — `رسالة
 * ترحيب`, or "Welcome message" for an English-speaking admin — so renaming it
 * in the portal silently turns the feature off and the widget falls back to its
 * built-in wording. Said here because the label looks like a caption and is
 * actually a key.
 */
const ROWS = [
  {
    label: 'رسالة ترحيب',
    lang: 'ar',
    text: 'مرحبًا {name} 👋 معك خدمة عملاء يجي، كيف يمكننا مساعدتك؟',
  },
  {
    label: 'Welcome message',
    lang: 'en',
    text: 'Hi {name} 👋 This is Yiji customer care — how can we help you today?',
  },
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
      await fetch(`${DIRECTUS}/items/quick_replies?fields=id,label,lang,text&limit=-1`, {
        headers: H,
      })
    ).json()
  ).data ?? [];

console.log(`${DIRECTUS}`);
console.log(`${ROWS.length} welcome rows${WRITE ? '' : ' (dry run)'}\n`);

let created = 0;
let updated = 0;
for (const row of ROWS) {
  const found = existing.find((r) => r.label?.trim() === row.label);
  /*
   * `sort` is deliberately high. These rows live in the same library agents
   * pick canned replies from, and a greeting is not something an agent sends by
   * hand — so it sorts to the bottom of their list rather than the top.
   *
   * `active: true` because the gateway only reads active rows: that flag is how
   * operations withdraw the greeting without deleting the wording.
   */
  const payload = { ...row, sort: 900, active: true };
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
      console.warn(`  ! ${row.label}: ${res.status} ${await res.text()}`);
      continue;
    }
  }
  if (found) updated += 1;
  else created += 1;
  console.log(`  ${found ? 'update' : 'create'}  [${row.lang}] ${row.label}`);
  console.log(`            ${row.text}`);
}

console.log(`\ncreated: ${created}\nupdated: ${updated}`);
if (!WRITE) console.log('\nRe-run with --write to apply.');
else console.log('\nThe gateway caches the wording for 5 minutes.');
