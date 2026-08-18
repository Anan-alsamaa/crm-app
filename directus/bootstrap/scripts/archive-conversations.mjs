/**
 * Put finished conversations away, so the inbox stops carrying them.
 *
 *   node scripts/archive-conversations.mjs                    # report only
 *   node scripts/archive-conversations.mjs --write
 *   node scripts/archive-conversations.mjs --months=6 --write
 *   node scripts/archive-conversations.mjs --restore --write   # bring them all back
 *
 * Archiving here is a FLAG, not a move to a cold table. The conversations
 * themselves are small — measured on this system, a message averages 133 bytes
 * — so the cost of a two-year-old chat is not the space it occupies, it is that
 * it sits in the working set every inbox query scans. Setting `archived_at`
 * takes it out of that set via the partial index in constraints.ts, which is
 * the entire win, and writing null puts it straight back. Moving rows between
 * tables would buy nothing at this size and could lose them; that trade only
 * starts to make sense past tens of millions of rows.
 *
 * Only SOLVED chats are eligible, and only ones nobody has touched since. An
 * open conversation is somebody's unfinished work no matter how old it looks,
 * and a chat that was reopened last week is live again whatever its age.
 */
const DB = {
  host: process.env.PGHOST ?? '127.0.0.1',
  port: Number(process.env.PGPORT ?? 5434),
  user: process.env.PGUSER ?? 'directus',
  password: process.env.PGPASSWORD ?? 'directus',
  database: process.env.PGDATABASE ?? 'yiji_crm',
};

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const RESTORE = args.includes('--restore');
const MONTHS = Number((args.find((a) => a.startsWith('--months=')) ?? '--months=12').split('=')[1]);

if (!Number.isFinite(MONTHS) || MONTHS < 1) {
  console.error('--months must be a positive number of months.');
  process.exit(1);
}

const { default: pg } = await import('pg');
const db = new pg.Client(DB);
await db.connect();

const counts = async () => {
  const { rows } = await db.query(`
    select count(*) filter (where archived_at is null)     as live,
           count(*) filter (where archived_at is not null)  as archived
      from conversations`);
  return rows[0];
};

/**
 * Solved, old enough, and untouched since — see the note above on why all three
 * conditions are needed rather than age alone.
 */
const ELIGIBLE = `
  status = 'solved'
  and archived_at is null
  and solved_at is not null
  and solved_at < now() - ($1 || ' months')::interval
  and coalesce(last_message_at, solved_at) < now() - ($1 || ' months')::interval`;

const before = await counts();
console.log(`conversations: ${before.live} live, ${before.archived} archived`);

if (RESTORE) {
  const { rows } = await db.query(
    'select count(*) as n from conversations where archived_at is not null',
  );
  console.log(`\n${rows[0].n} archived conversation(s) would return to the inbox.`);
  if (!WRITE) {
    console.log('Report only. Re-run with --write.');
    await db.end();
    process.exit(0);
  }
  const res = await db.query(
    'update conversations set archived_at = null where archived_at is not null',
  );
  console.log(`Restored ${res.rowCount}.`);
  console.log('conversations:', await counts());
  await db.end();
  process.exit(0);
}

const { rows: preview } = await db.query(
  `select count(*) as n, min(solved_at)::date as oldest, max(solved_at)::date as newest
     from conversations where ${ELIGIBLE}`,
  [MONTHS],
);
const { n, oldest, newest } = preview[0];
console.log(
  `\nSolved and untouched for more than ${MONTHS} month(s): ${n}` +
    (Number(n) > 0 ? `\n  solved between ${oldest} and ${newest}` : ''),
);

if (!WRITE) {
  console.log('\nReport only. Re-run with --write to archive them.');
  console.log('Nothing is deleted — archiving sets a date, and --restore clears it.');
  await db.end();
  process.exit(0);
}

const res = await db.query(`update conversations set archived_at = now() where ${ELIGIBLE}`, [
  MONTHS,
]);
console.log(`\nArchived ${res.rowCount} conversation(s).`);
const after = await counts();
console.log(`conversations: ${after.live} live, ${after.archived} archived`);
await db.end();
