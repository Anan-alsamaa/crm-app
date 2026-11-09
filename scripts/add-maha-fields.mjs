#!/usr/bin/env node
/**
 * Add Maha's fields to `conversations` (owner, 2026-11-09). Additive and
 * idempotent; dry run by default. Every service treats a missing field as
 * "no Maha here", so adding them changes nothing until Maha is switched on.
 *
 *   DIRECTUS_URL=... DIRECTUS_ADMIN_EMAIL=... DIRECTUS_ADMIN_PASSWORD=... \
 *     node scripts/add-maha-fields.mjs [--write]
 */
const WRITE = process.argv.includes('--write');
const D = process.env.DIRECTUS_URL ?? 'http://localhost:8055';

const FIELDS = [
  { field: 'ai_active', type: 'boolean', schema: { is_nullable: true, default_value: false }, meta: { interface: 'boolean', special: ['cast-boolean'], note: 'Maha is handling this chat.' } },
  { field: 'ai_replies', type: 'integer', schema: { is_nullable: true, default_value: 0 }, meta: { interface: 'input', note: "Maha's replies in this session." } },
  { field: 'ai_handover_at', type: 'timestamp', schema: { is_nullable: true }, meta: { interface: 'datetime', note: 'When Maha passed the chat to people.' } },
  { field: 'ai_handover_reason', type: 'string', schema: { is_nullable: true }, meta: { interface: 'input', note: 'Why Maha handed over.' } },
  { field: 'ai_handover_summary', type: 'text', schema: { is_nullable: true }, meta: { interface: 'input-multiline', note: "Maha's summary for the agent." } },
  { field: 'ai_agent_joined_at', type: 'timestamp', schema: { is_nullable: true }, meta: { interface: 'datetime', note: 'When the agent was introduced by name.' } },
];

const login = await (
  await fetch(`${D}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: process.env.DIRECTUS_ADMIN_EMAIL,
      password: process.env.DIRECTUS_ADMIN_PASSWORD,
    }),
  })
).json();
if (!login?.data?.access_token) {
  console.error('Login failed');
  process.exit(1);
}
const H = { authorization: `Bearer ${login.data.access_token}`, 'content-type': 'application/json' };
console.log(`${WRITE ? 'APPLYING' : 'DRY RUN'} against ${D}\n`);
for (const f of FIELDS) {
  if ((await fetch(`${D}/fields/conversations/${f.field}`, { headers: H })).ok) {
    console.log(`  = conversations.${f.field} exists`);
    continue;
  }
  console.log(`  + conversations.${f.field} (${f.type})`);
  if (!WRITE) continue;
  const res = await fetch(`${D}/fields/conversations`, { method: 'POST', headers: H, body: JSON.stringify(f) });
  if (!res.ok) {
    console.error('Failed:', (await res.text()).slice(0, 300));
    process.exit(1);
  }
}
console.log(WRITE ? '\nApplied.' : '\nRe-run with --write to apply.');
