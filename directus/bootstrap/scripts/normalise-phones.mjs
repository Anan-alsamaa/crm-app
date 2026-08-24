#!/usr/bin/env node
/**
 * Bring every stored phone number to the one canonical form: `05XXXXXXXX`.
 *
 * WHY THIS IS A SCRIPT AND NOT A ONE-LINE UPDATE. Contacts are matched by exact
 * phone equality, and the live table held four spellings of the same thing
 * (`+966…`, `966…`, `05…`, bare `5…`). Two customers were therefore sitting in
 * it TWICE — once as `+966540041059` and once as `966540041059`. Rewriting the
 * column alone would drive both rows to the same value and hit the
 * (vendor, phone) partial-unique index; worse, if the index were absent it
 * would leave two contacts for one person and split their history between them.
 *
 * So duplicates are MERGED first: everything that points at the loser is
 * repointed at the keeper, then the loser is deleted. The keeper is the row
 * with the most history behind it, not the oldest — the point of the merge is
 * to lose as little as possible, and `date_created` says nothing about that.
 *
 * The rule matches `normalizePhone()` in @yiji/shared-types exactly. A number
 * it does not recognise is left untouched rather than mangled: there is one
 * such value here, 18 digits from a mis-paste, and leaving it visibly wrong is
 * what lets somebody notice and fix it.
 *
 *   node scripts/normalise-phones.mjs              # report only
 *   node scripts/normalise-phones.mjs --write      # merge + rewrite
 */
import pg from 'pg';

const WRITE = process.argv.includes('--write');

const client = new pg.Client({
  host: process.env.PGHOST ?? '127.0.0.1',
  port: Number(process.env.PGPORT ?? 5434),
  user: process.env.PGUSER ?? 'directus',
  password: process.env.PGPASSWORD ?? 'directus',
  database: process.env.PGDATABASE ?? 'yiji_crm',
});

/** The SQL twin of normalizePhone(). Kept beside it in one function. */
const RULE = `
CREATE OR REPLACE FUNCTION crm_local_phone(raw text) RETURNS text AS $fn$
DECLARE d text;
BEGIN
  IF raw IS NULL OR btrim(raw) = '' THEN RETURN raw; END IF;
  d := regexp_replace(raw, '\\D', '', 'g');
  IF d = '' THEN RETURN raw; END IF;
  IF d LIKE '966%' THEN
    d := regexp_replace(substr(d, 4), '^0+', '');
    RETURN CASE WHEN d = '' THEN raw ELSE '0' || d END;
  END IF;
  IF d LIKE '0%' THEN
    d := regexp_replace(d, '^0+', '');
    RETURN CASE WHEN d = '' THEN raw ELSE '0' || d END;
  END IF;
  IF d LIKE '5%' AND length(d) = 9 THEN RETURN '0' || d; END IF;
  RETURN raw;
END;
$fn$ LANGUAGE plpgsql IMMUTABLE;
`;

/** Tables that point at a contact, and the column that does the pointing. */
const REFERENCES = [
  ['conversations', 'contact'],
  ['coupon_approvals', 'contact'],
  ['csat_responses', 'contact'],
  ['messages', 'sender_contact'],
  ['tickets', 'contact'],
];

async function main() {
  await client.connect();
  await client.query(RULE);

  const { rows: dupes } = await client.query(`
    SELECT vendor, crm_local_phone(phone) AS normalised,
           array_agg(id ORDER BY id) AS ids,
           array_agg(phone ORDER BY id) AS originals
    FROM contacts
    WHERE phone IS NOT NULL AND phone <> ''
    GROUP BY vendor, crm_local_phone(phone)
    HAVING count(*) > 1
  `);

  const {
    rows: [{ changing }],
  } = await client.query(`
    SELECT count(*)::int AS changing FROM contacts
    WHERE phone IS NOT NULL AND phone <> '' AND phone <> crm_local_phone(phone)
  `);

  const { rows: unrecognised } = await client.query(`
    SELECT id, phone FROM contacts
    WHERE phone IS NOT NULL AND phone <> '' AND crm_local_phone(phone) NOT LIKE '05%'
  `);

  console.log(`contacts to rewrite : ${changing}`);
  console.log(`duplicate groups    : ${dupes.length}`);
  console.log(`left untouched      : ${unrecognised.length}`);
  for (const u of unrecognised) console.log(`  ! ${u.phone} — not a recognisable Saudi mobile`);

  for (const d of dupes) {
    // Keep whichever row carries the most history. Losing the busier contact
    // is the one outcome a merge must not produce.
    const counts = new Map();
    for (const id of d.ids) {
      let n = 0;
      for (const [table, col] of REFERENCES) {
        const { rows } = await client.query(
          `SELECT count(*)::int AS n FROM ${table} WHERE ${col} = $1`,
          [id],
        );
        n += rows[0].n;
      }
      counts.set(id, n);
    }
    const ids = [...d.ids].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
    const keeper = ids[0];
    const losers = ids.slice(1);
    console.log(
      `\n  ${d.normalised}  (${d.originals.join(' | ')})` +
        `\n    keep  ${keeper} — ${counts.get(keeper)} linked rows` +
        losers.map((l) => `\n    merge ${l} — ${counts.get(l)} linked rows`).join(''),
    );

    if (!WRITE) continue;
    await client.query('BEGIN');
    try {
      for (const loser of losers) {
        for (const [table, col] of REFERENCES) {
          await client.query(`UPDATE ${table} SET ${col} = $1 WHERE ${col} = $2`, [keeper, loser]);
        }
        await client.query('DELETE FROM contacts WHERE id = $1', [loser]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }

  if (WRITE) {
    const { rowCount: c } = await client.query(
      `UPDATE contacts SET phone = crm_local_phone(phone)
       WHERE phone IS NOT NULL AND phone <> '' AND phone <> crm_local_phone(phone)`,
    );
    const { rowCount: m } = await client.query(
      `UPDATE compensation_requests SET customer_mobile = crm_local_phone(customer_mobile)
       WHERE customer_mobile IS NOT NULL AND customer_mobile <> ''
         AND customer_mobile <> crm_local_phone(customer_mobile)`,
    );
    console.log(`\nrewrote ${c} contact(s) and ${m} compensation request(s).`);
  } else {
    console.log('\nreport only — pass --write to merge and rewrite.');
  }

  await client.query('DROP FUNCTION IF EXISTS crm_local_phone(text)');
  await client.end();
}

main().catch(async (err) => {
  console.error(err);
  await client.end().catch(() => {});
  process.exit(1);
});
