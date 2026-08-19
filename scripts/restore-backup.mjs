/**
 * Restore a portal-made backup file into Directus.
 *
 *   node scripts/restore-backup.mjs <backup.json>            # dry run: says what it WOULD do
 *   node scripts/restore-backup.mjs <backup.json> --write    # actually writes
 *
 * Upserts by id — existing rows are updated, missing rows created, and rows
 * that exist in the database but not in the file are LEFT ALONE. This is a
 * recovery tool ("that list got emptied", "those tickets were mangled"), not a
 * point-in-time reset: deleting live data a backup doesn't mention is how a
 * restore becomes the second incident. For a true reset, restore Postgres from
 * pg_dump instead.
 *
 * Collections are written parents-first so foreign keys resolve. Runs with the
 * admin credentials from .env — an operator action, on purpose.
 */
import { readFileSync } from 'node:fs';

const D = process.env.DIRECTUS_URL ?? 'http://localhost:8055';
const WRITE = process.argv.includes('--write');
const file = process.argv[2];
if (!file || file.startsWith('--')) {
  console.error('usage: node scripts/restore-backup.mjs <backup.json> [--write]');
  process.exit(1);
}

/** Parents before children, so FKs land. Anything not listed goes last. */
const ORDER = [
  'vendors',
  'teams',
  'brands',
  'stores',
  'contacts',
  'tags',
  'sla_policies',
  'option_lists',
  'app_settings',
  'app_roles',
  'quick_replies',
  'conversations',
  'messages',
  'tickets',
  'ticket_events',
  'conversations_tags',
  'contacts_tags',
  'tickets_tags',
  'coupon_approvals',
  'store_notify_rules',
  'store_notifications',
  'routing_events',
  'csat_responses',
  'reports',
  'custom_fields',
  'custom_field_values',
  'automation_rules',
  'notifications',
];

const backup = JSON.parse(readFileSync(file, 'utf8'));
if (!backup?.manifest?.version || !backup?.data) {
  console.error('Not a portal backup file (missing manifest/data).');
  process.exit(1);
}
console.log(`backup from ${backup.manifest.exportedAt}, version ${backup.manifest.version}`);

const login = await fetch(`${D}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: process.env.DIRECTUS_ADMIN_EMAIL,
    password: process.env.DIRECTUS_ADMIN_PASSWORD,
  }),
});
const AT = (await login.json()).data?.access_token;
if (!AT) {
  console.error('Admin login failed — check DIRECTUS_ADMIN_EMAIL/PASSWORD in env.');
  process.exit(1);
}
const H = { authorization: `Bearer ${AT}`, 'content-type': 'application/json' };

const collections = [
  ...ORDER.filter((c) => c in backup.data),
  ...Object.keys(backup.data).filter((c) => !ORDER.includes(c)),
];

let totals = { created: 0, updated: 0, failed: 0 };
for (const collection of collections) {
  const rows = backup.data[collection] ?? [];
  if (rows.length === 0) continue;
  const existing = await (
    await fetch(`${D}/items/${collection}?fields=id&limit=-1`, { headers: H })
  ).json();
  const have = new Set((existing.data ?? []).map((r) => String(r.id)));
  let created = 0,
    updated = 0,
    failed = 0;
  for (const row of rows) {
    if (!WRITE) {
      have.has(String(row.id)) ? updated++ : created++;
      continue;
    }
    const isUpdate = have.has(String(row.id));
    const res = await fetch(
      isUpdate ? `${D}/items/${collection}/${row.id}` : `${D}/items/${collection}`,
      { method: isUpdate ? 'PATCH' : 'POST', headers: H, body: JSON.stringify(row) },
    );
    if (res.ok) isUpdate ? updated++ : created++;
    else failed++;
  }
  totals.created += created;
  totals.updated += updated;
  totals.failed += failed;
  console.log(
    `${collection}: ${created} create, ${updated} update${failed ? `, ${failed} FAILED` : ''}`,
  );
}
console.log(
  `\n${WRITE ? 'RESTORED' : 'DRY RUN'} — ${totals.created} created, ${totals.updated} updated, ${totals.failed} failed`,
);
if (!WRITE) console.log('re-run with --write to apply');
