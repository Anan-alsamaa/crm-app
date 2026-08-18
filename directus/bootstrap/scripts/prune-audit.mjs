/**
 * Keep Directus' audit trail from becoming the database.
 *
 *   node scripts/prune-audit.mjs                 # report only, changes nothing
 *   node scripts/prune-audit.mjs --write         # actually delete
 *   node scripts/prune-audit.mjs --days=180 --write
 *
 * Why this exists: Directus writes a row to `directus_revisions` AND a row to
 * `directus_activity` for every change to a tracked collection — including the
 * ones nobody asked for, like the SLA sweep touching a timer or the gateway
 * stamping a conversation. Nothing prunes them. Measured on this database, that
 * trail was 95% of everything stored: 126,000 audit rows against 150 real ones.
 * The chats are small; the bookkeeping about the chats is not.
 *
 * WHAT THIS DELIBERATELY DOES NOT DELETE
 *
 * Ticket revisions are load-bearing. The ticket field history and the "last
 * modified by" line are both DERIVED from `directus_revisions` — `user_updated`
 * records whichever background job wrote last, so the human was recovered from
 * the revision trail instead. Pruning those would silently empty two features
 * that look fine in the code and return nothing on screen, which is the exact
 * failure mode that took a full audit to find last time. So tickets are held
 * regardless of age, and only everything else ages out.
 *
 * Deleting in batches rather than one statement: a single DELETE over millions
 * of rows takes a long lock and bloats the table it is trying to shrink.
 */
const DIRECTUS_DB = {
  host: process.env.PGHOST ?? '127.0.0.1',
  port: Number(process.env.PGPORT ?? 5434),
  user: process.env.PGUSER ?? 'directus',
  password: process.env.PGPASSWORD ?? 'directus',
  database: process.env.PGDATABASE ?? 'yiji_crm',
};

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const DAYS = Number((args.find((a) => a.startsWith('--days=')) ?? '--days=90').split('=')[1]);
/**
 * Collections whose history is a product feature, not bookkeeping.
 *
 * tickets: field history + "last modified by" are DERIVED from revisions.
 * coupon_approvals: the money trail — who asked, who amended, who approved —
 * lives in the revision rows; the CRM is also the long-term store of customer
 * behaviour (compensation included), so its edit history is data, not noise.
 */
const KEEP_FOREVER = ['tickets', 'coupon_approvals'];
const BATCH = 10_000;

if (!Number.isFinite(DAYS) || DAYS < 1) {
  console.error('--days must be a positive number of days.');
  process.exit(1);
}

const { default: pg } = await import('pg');
const db = new pg.Client(DIRECTUS_DB);
await db.connect();

const bytes = (b) => `${(Number(b) / 1024 / 1024).toFixed(1)} MB`;

async function sizes() {
  const { rows } = await db.query(`
    select relname,
           n_live_tup as rows,
           pg_total_relation_size(relid) as bytes
      from pg_stat_user_tables
     where relname in ('directus_revisions', 'directus_activity')`);
  return rows;
}

async function report() {
  const { rows } = await db.query(
    `select
       (select count(*) from directus_revisions) as revisions,
       (select count(*) from directus_activity) as activity,
       (select count(*) from directus_revisions r
          join directus_activity a on a.id = r.activity
         where a.timestamp < now() - ($1 || ' days')::interval
           and r.collection <> all($2::text[])) as prunable_revisions,
       (select count(*) from directus_activity a
         where a.timestamp < now() - ($1 || ' days')::interval
           and a.collection <> all($2::text[])) as prunable_activity`,
    [DAYS, KEEP_FOREVER],
  );
  return rows[0];
}

console.log(`Retention: ${DAYS} days. Held regardless of age: ${KEEP_FOREVER.join(', ')}.`);
for (const t of await sizes()) console.log(`  ${t.relname}: ${t.rows} rows, ${bytes(t.bytes)}`);

const before = await report();
console.log(
  `\n  revisions ${before.revisions} total, ${before.prunable_revisions} older than ${DAYS} days` +
    `\n  activity  ${before.activity} total, ${before.prunable_activity} older than ${DAYS} days`,
);

if (!WRITE) {
  console.log('\nReport only. Re-run with --write to delete.');
  await db.end();
  process.exit(0);
}

/** Delete in batches so the lock is short and the table can be reused between. */
async function pruneBatched(label, sql) {
  let total = 0;
  for (;;) {
    const { rowCount } = await db.query(sql, [DAYS, KEEP_FOREVER, BATCH]);
    total += rowCount;
    if (rowCount > 0) process.stdout.write(`\r  ${label}: ${total} deleted`);
    if (rowCount < BATCH) break;
  }
  if (total > 0) process.stdout.write('\n');
  return total;
}

// Revisions first: they reference activity, so removing them the other way
// round would either fail or cascade further than intended.
const revs = await pruneBatched(
  'revisions',
  `delete from directus_revisions
    where id in (
      select r.id from directus_revisions r
        join directus_activity a on a.id = r.activity
       where a.timestamp < now() - ($1 || ' days')::interval
         and r.collection <> all($2::text[])
       limit $3)`,
);
const acts = await pruneBatched(
  'activity',
  `delete from directus_activity
    where id in (
      select a.id from directus_activity a
       where a.timestamp < now() - ($1 || ' days')::interval
         and a.collection <> all($2::text[])
         and not exists (select 1 from directus_revisions r where r.activity = a.id)
       limit $3)`,
);

// The space is not returned to the filesystem until the dead rows are cleared,
// so a prune with no vacuum looks like it did nothing at all.
console.log('\nReclaiming space…');
await db.query('vacuum (analyze) directus_revisions');
await db.query('vacuum (analyze) directus_activity');

console.log(`\nDeleted ${revs} revisions and ${acts} activity rows.`);
for (const t of await sizes()) console.log(`  ${t.relname}: ${t.rows} rows, ${bytes(t.bytes)}`);
await db.end();
