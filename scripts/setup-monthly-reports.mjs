/**
 * Put every report on a monthly schedule, emailed on the 1st.
 *
 * Creates one saved report per type (or updates the one already there) with
 * `schedule.cron = '0 7 1 * *'` and the recipients you pass in. The workers'
 * `syncScheduledReports` registers a BullMQ scheduler per report at startup, so
 * the schedule is live from the next worker boot — no further wiring.
 *
 * 07:00 rather than midnight: a report generated at 00:00 on the 1st covers a
 * month that ended sixty seconds ago and lands in an inbox nobody opens until
 * morning anyway.
 *
 *   node scripts/setup-monthly-reports.mjs ops@example.com
 *   node scripts/setup-monthly-reports.mjs ops@example.com,manager@example.com --write
 *
 * Dry run by default. Idempotent: matched by name, so re-running updates rather
 * than stacking duplicates.
 *
 * NOTE: delivery needs SMTP configured on the workers service. Without it the
 * report still runs and still records last_run_at, and the email silently goes
 * nowhere — check EMAIL_* / SMTP_* before trusting the first of the month.
 */
const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const recipients = (args.find((a) => !a.startsWith('--')) ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (recipients.length === 0) {
  console.error('Usage: node scripts/setup-monthly-reports.mjs <email[,email]> [--write]');
  process.exit(1);
}

const DIRECTUS = process.env.DIRECTUS_URL ?? 'http://localhost:8055';
const EMAIL = process.env.DIRECTUS_ADMIN_EMAIL ?? 'e.habibi@anan.sa';
const PASSWORD = process.env.DIRECTUS_ADMIN_PASSWORD ?? '123456';

/** The 1st of every month at 07:00. */
const MONTHLY_CRON = '0 7 1 * *';

const REPORTS = [
  ['Monthly — conversation volume', 'conversation_volume', 'How many chats arrived, by day.'],
  ['Monthly — response time', 'response_time', 'How quickly the team answered.'],
  ['Monthly — SLA compliance', 'sla_compliance', 'Which tickets met the deadline they promised.'],
  ['Monthly — ticket resolution', 'ticket_resolution', 'How tickets were closed out.'],
  ['Monthly — agent productivity', 'agent_productivity', 'Work handled per agent.'],
  ['Monthly — CSAT', 'csat', 'What customers scored the team.'],
  ['Monthly — vendor activity', 'vendor_activity', 'Activity per vendor.'],
];

const login = await fetch(`${DIRECTUS}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!login.ok) throw new Error(`login failed: ${login.status}`);
const token = (await login.json()).data.access_token;
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

const existing = (
  await (
    await fetch(`${DIRECTUS}/items/reports?fields=id,name,type,schedule&limit=-1`, { headers: H })
  ).json()
).data;

console.log(
  `${REPORTS.length} monthly reports -> ${recipients.join(', ')} on the 1st at 07:00${
    WRITE ? '' : ' (dry run)'
  }\n`,
);

let created = 0;
let updated = 0;

for (const [name, type, description] of REPORTS) {
  const found = existing.find((r) => r.name === name);
  const payload = {
    name,
    description,
    type,
    filters: {},
    schedule: { email: recipients, cron: MONTHLY_CRON },
  };
  if (WRITE) {
    const res = found
      ? await fetch(`${DIRECTUS}/items/reports/${found.id}`, {
          method: 'PATCH',
          headers: H,
          body: JSON.stringify(payload),
        })
      : await fetch(`${DIRECTUS}/items/reports`, {
          method: 'POST',
          headers: H,
          body: JSON.stringify(payload),
        });
    if (!res.ok) {
      console.warn(`  ! ${name}: ${res.status} ${await res.text()}`);
      continue;
    }
  }
  if (found) updated += 1;
  else created += 1;
  console.log(`  ${found ? 'update' : 'create'}  ${name}`);
}

console.log(`\ncreated: ${created}\nupdated: ${updated}`);
if (WRITE) {
  console.log('\nRestart the workers service so it registers the schedulers:  pm2 restart workers');
} else {
  console.log('\nRe-run with --write to apply.');
}
