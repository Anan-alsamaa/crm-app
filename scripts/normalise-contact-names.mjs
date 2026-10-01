#!/usr/bin/env node
/**
 * Rewrite a contact NAME that is only a phone number into the canonical `05…`.
 *
 * WHY (owner, 2026-10-01): many customers have no name, so their number became
 * the name — and those were stored in whatever shape the source used. On live
 * production 44 of 77 contacts carry a numeric name and they disagree with each
 * other (`+966564490993`, `509040892`) while the `phone` column beside them is
 * correctly `05…`. The same customer reads two ways on one screen, and two
 * records of one number look like different people.
 *
 * The code fix stops NEW rows arriving that way and normalises every surface
 * that renders a name. This is the one-off for the rows already stored.
 *
 * SAFE BY DEFAULT: a dry run that writes nothing and prints exactly what it
 * would change. `--write` is required to touch the database, and production is
 * the owner's call, not this script's.
 *
 * WHAT IT WILL NOT DO:
 *  - touch a real name. `isDialablePhone` rejects anything with letters.
 *  - touch a foreign number. Only a value that normalises to `05XXXXXXXX` is
 *    rewritten; `+447…` is left exactly as it is.
 *  - invent a name for a contact that has none — a blank name stays blank.
 *  - change the `phone` column. That one is already right everywhere.
 *
 *   node scripts/normalise-contact-names.mjs                  # dry run
 *   node scripts/normalise-contact-names.mjs --write          # apply
 *   DIRECTUS_URL=… DIRECTUS_ADMIN_EMAIL=… DIRECTUS_ADMIN_PASSWORD=… node …
 */
/*
 * INLINED, not imported. Every script here is standalone — the repo root has no
 * dependency on the workspace packages, so importing `@yiji/shared-types` means
 * this cannot be run without building first. The rules below are a faithful copy
 * of `isDialablePhone` + `displayContactName`; `packages/shared-types/src/phone.ts`
 * remains the authority, and the unit tests there cover the behaviour.
 */
const SA_CODE = '966';

function normalizePhone(raw) {
  const input = (raw ?? '').trim();
  if (!input) return '';
  const digits = input.replace(/\D/g, '');
  if (!digits) return input;
  const dialled = digits.startsWith('00') ? digits.slice(2) : digits;
  if (dialled.startsWith(SA_CODE)) {
    const rest = dialled.slice(SA_CODE.length).replace(/^0+/, '');
    return rest ? `0${rest}` : input;
  }
  if (digits.startsWith('0')) {
    const rest = digits.replace(/^0+/, '');
    return rest ? `0${rest}` : input;
  }
  if (digits.startsWith('5') && digits.length === 9) return `0${digits}`;
  return input.startsWith('+') ? `+${digits}` : input;
}

/** A name is not a number: any letter disqualifies it outright. */
function isDialablePhone(raw) {
  const input = (raw ?? '').trim();
  if (!input) return false;
  if (/[A-Za-z؀-ۿ]/.test(input)) return false;
  const digits = input.replace(/\D/g, '');
  if (!digits) return false;
  if (/^05\d{8}$/.test(normalizePhone(input))) return true;
  if (input.startsWith('+') || input.startsWith('00')) {
    return digits.replace(/^0+/, '').length >= 8 && digits.length <= 15;
  }
  return false;
}

function displayContactName(name, fallbackPhone) {
  const raw = (name ?? '').trim();
  if (!raw) return normalizePhone(fallbackPhone) || '';
  if (!isDialablePhone(raw)) return raw;
  const local = normalizePhone(raw);
  return /^05\d{8}$/.test(local) ? local : raw;
}

const URL_ = process.env.DIRECTUS_URL ?? 'http://localhost:8055';
const EMAIL = process.env.DIRECTUS_ADMIN_EMAIL ?? '';
const PASSWORD = process.env.DIRECTUS_ADMIN_PASSWORD ?? '';
const WRITE = process.argv.includes('--write');

if (!EMAIL || !PASSWORD) {
  console.error('DIRECTUS_ADMIN_EMAIL and DIRECTUS_ADMIN_PASSWORD are required.');
  process.exit(1);
}

async function main() {
  const login = await fetch(`${URL_}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!login.ok) {
    console.error(`login failed: ${login.status}`);
    process.exit(1);
  }
  const token = (await login.json()).data.access_token;
  const auth = { authorization: `Bearer ${token}` };

  const res = await fetch(`${URL_}/items/contacts?limit=-1&fields=id,name,phone`, {
    headers: auth,
  });
  if (!res.ok) {
    console.error(`read failed: ${res.status}`);
    process.exit(1);
  }
  const contacts = (await res.json()).data ?? [];

  /* Only rows where the name IS a number AND the canonical form differs from
     what is stored. A name already reading `05…` is left alone — rewriting it
     to itself would be an audit-trail entry that records no change. */
  const todo = [];
  for (const c of contacts) {
    const name = (c.name ?? '').trim();
    if (!name || !isDialablePhone(name)) continue;
    const next = displayContactName(name, c.phone);
    if (next && next !== name) todo.push({ id: c.id, from: name, to: next, phone: c.phone });
  }

  console.log(`contacts: ${contacts.length}`);
  console.log(`names that are a number and need rewriting: ${todo.length}`);
  for (const t of todo) {
    /* The stored phone is printed beside it so a reviewer can see the rewrite
       agrees with the column it is being aligned to. */
    console.log(`  ${t.id}  "${t.from}"  ->  "${t.to}"   (phone: ${t.phone ?? '—'})`);
  }

  if (!todo.length) {
    console.log('\nnothing to do.');
    return;
  }
  if (!WRITE) {
    console.log('\nDRY RUN — nothing was written. Re-run with --write to apply.');
    return;
  }

  let ok = 0;
  for (const t of todo) {
    const patch = await fetch(`${URL_}/items/contacts/${t.id}`, {
      method: 'PATCH',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ name: t.to }),
    });
    if (patch.ok) ok += 1;
    else console.error(`  FAILED ${t.id}: ${patch.status}`);
  }
  console.log(`\nrewritten: ${ok}/${todo.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
