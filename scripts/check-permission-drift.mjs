#!/usr/bin/env node
/**
 * Does the LIVE permission set match what `roles.ts` says it should be?
 *
 * WHY THIS EXISTS. Schema and permissions do not ride a deploy — they reach an
 * environment only through a manual bootstrap apply, and a full apply has twice
 * taken production agent access down, so it is deliberately not run. The result
 * is a gap nobody can see: a grant added to `roles.ts`, reviewed, merged,
 * deployed green, and simply absent from the database.
 *
 * It has happened twice in one week and both times the symptom was silence:
 *
 *   - `tickets.customer_phone` — the field existed in code and not in Directus,
 *     so every read of it failed the WHOLE query (Directus refuses a query that
 *     names an inaccessible field).
 *   - `app_settings` for `svc-socket-gateway` — the release button worked,
 *     wrote nothing, and the banner came back for ever. "I clicked update now
 *     but nothing happens" (owner, 2026-09-16).
 *
 * Neither produced an error anybody could see. This reports them out loud.
 *
 * READ ONLY. It changes nothing, so it is safe to run against production at any
 * time; fixing a gap is a separate, deliberate act.
 *
 *   node scripts/check-permission-drift.mjs            # both environments
 *   node scripts/check-permission-drift.mjs --env prod
 */
import { readFileSync } from 'node:fs';

const ENVIRONMENTS = {
  prod: 'https://crm-api.anan.sa',
  staging: 'https://crm-api-staging.anan.sa',
};

const only = (() => {
  const i = process.argv.indexOf('--env');
  return i >= 0 ? process.argv[i + 1] : null;
})();

/** Read one value out of an env file without pulling in a dotenv dependency. */
function envValue(file, key) {
  try {
    const line = readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .find((l) => l.trim().startsWith(`${key}=`));
    return line
      ? line
          .slice(line.indexOf('=') + 1)
          .trim()
          .replace(/^["']|["']$/g, '')
      : null;
  } catch {
    return null;
  }
}

/*
 * What `roles.ts` declares, as a plain list.
 *
 * Deliberately NOT imported from the TypeScript: that file builds its
 * permissions from helpers and flags (PROVISION_COMPENSATION and friends), so
 * importing it would reproduce the same assumptions this is meant to check. A
 * short hand-written list of the grants that MATTER is more honest, and adding
 * to it is the thing somebody does when they add a grant.
 */
/*
 * A role that holds `view_all_tickets` must NOT carry a rule scoping tickets to
 * `$CURRENT_USER`. Six roles did (2026-09-17): the app granted the privilege
 * and Directus refused it, and because an unreadable relation comes back as
 * NULL the only symptom was a coupon approval claiming a ticket had no order
 * number. Agents are deliberately excluded — their scope is correct.
 */
const UNSCOPED_TICKET_ROLES = [
  'WeCare Admin',
  'WeCare Supervisor',
  'Department Manager',
  'Chain Manager',
  'Viewer',
];

const EXPECTED = [
  { role: 'svc-socket-gateway', collection: 'app_settings', actions: ['read', 'create', 'update'] },
  { role: 'svc-socket-gateway', collection: 'contacts', actions: ['create', 'read', 'update'] },
  { role: 'Agent', collection: 'contacts', actions: ['create', 'read', 'update'] },
  { role: 'Agent', collection: 'tickets', actions: ['create', 'read', 'update'] },
  { role: 'Agent', collection: 'app_settings', actions: ['read'] },
];

async function api(base, path, token) {
  const res = await fetch(`${base}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

async function login(base, email, password) {
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`login -> ${res.status}`);
  return (await res.json()).data.access_token;
}

async function checkEnvironment(name, base, email, password) {
  process.stdout.write(`\n[1m${name}[0m  ${base}\n`);
  let token;
  try {
    token = await login(base, email, password);
  } catch (err) {
    process.stdout.write(`  could not sign in: ${err.message}\n`);
    return 1;
  }

  const { data: roles } = await api(base, '/roles?fields=id,name&limit=-1', token);
  let gaps = 0;

  for (const want of EXPECTED) {
    const role = roles.find((r) => r.name === want.role);
    if (!role) {
      process.stdout.write(`  [31m✗[0m role ${want.role} does not exist here\n`);
      gaps += 1;
      continue;
    }
    const { data: withPolicies } = await api(
      base,
      `/roles/${role.id}?fields=policies.policy.id`,
      token,
    );
    const policyIds = (withPolicies.policies ?? []).map((p) => p.policy?.id).filter(Boolean);

    const have = new Set();
    for (const pid of policyIds) {
      const { data: perms } = await api(
        base,
        `/permissions?filter[policy][_eq]=${pid}&filter[collection][_eq]=${want.collection}&fields=action&limit=-1`,
        token,
      );
      for (const p of perms) have.add(p.action);
    }

    const missing = want.actions.filter((a) => !have.has(a));
    if (missing.length === 0) {
      process.stdout.write(`  [32m✓[0m ${want.role} · ${want.collection}\n`);
    } else {
      gaps += 1;
      process.stdout.write(
        `  [31m✗[0m ${want.role} · ${want.collection} — MISSING ${missing.join(', ')}` +
          ` (has: ${[...have].sort().join(', ') || 'nothing'})\n`,
      );
    }
  }
  /*
   * A role that may see every ticket must not carry a self-scoping rule.
   * Checked separately from EXPECTED because the fault is the PRESENCE of a
   * rule, not the absence of a grant — and it reads as empty data, never as an
   * error (see the comment on UNSCOPED_TICKET_ROLES).
   */
  for (const roleName of UNSCOPED_TICKET_ROLES) {
    const role = roles.find((r) => r.name === roleName);
    if (!role) continue;
    const { data: withPolicies } = await api(
      base,
      `/roles/${role.id}?fields=policies.policy.id`,
      token,
    );
    for (const p of withPolicies.policies ?? []) {
      const pid = p.policy?.id;
      if (!pid) continue;
      const { data: perms } = await api(
        base,
        `/permissions?filter[policy][_eq]=${pid}&filter[collection][_eq]=tickets&fields=id,action,permissions&limit=-1`,
        token,
      );
      for (const perm of perms) {
        if (JSON.stringify(perm.permissions ?? {}).includes('$CURRENT_USER')) {
          gaps += 1;
          process.stdout.write(
            `  [31m✗[0m ${roleName} · tickets.${perm.action} is SCOPED to` +
              ` $CURRENT_USER (permission ${perm.id}) but the role may see every ticket —` +
              ` an unreadable ticket returns null and renders as missing data
`,
          );
        }
      }
    }
  }

  return gaps;
}

const email = envValue('.env.prod.smoke', 'DIRECTUS_ADMIN_EMAIL');
const password = envValue('.env.prod.smoke', 'DIRECTUS_ADMIN_PASSWORD');
if (!email || !password) {
  process.stderr.write('no admin credentials in .env.prod.smoke\n');
  process.exit(2);
}

let total = 0;
for (const [name, base] of Object.entries(ENVIRONMENTS)) {
  if (only && only !== name) continue;
  total += await checkEnvironment(name, base, email, password);
}

if (total > 0) {
  process.stdout.write(
    `\n[31m${total} permission gap(s).[0m These do NOT reach an environment through a` +
      ` deploy — they are applied by hand, and until they are the feature that needs them fails silently.\n`,
  );
  process.exit(1);
}
process.stdout.write('\nEvery declared permission is present in every environment.\n');
