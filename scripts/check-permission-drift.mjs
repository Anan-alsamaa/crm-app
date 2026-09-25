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
/*
 * Approving a coupon writes the coupon ONTO THE TICKET before it marks the
 * request approved — so a role that may approve must be able to write those
 * three ticket fields. None of them could (2026-09-17), and the only symptom
 * was "Could not record that decision": Directus refused the first of the two
 * writes and the decision was never recorded at all.
 */
const COUPON_APPROVER_ROLES = ['WeCare Admin', 'WeCare Supervisor', 'Department Manager'];
const COUPON_TICKET_FIELDS = ['coupon_code', 'coupon_value', 'coupon_percent', 'compensation'];

const UNSCOPED_TICKET_ROLES = [
  'WeCare Admin',
  'WeCare Supervisor',
  'Department Manager',
  'Chain Manager',
  'Viewer',
  /*
   * Area Manager was MISSING from this list until 2026-09-22, and carried the
   * identical fault on staging unreported for five days.
   *
   * It is the awkward one: its rule is an `_and` of the agent scope AND a
   * brand `_in`, so the fix is not "clear the rule" — the brand scope is
   * deliberate and must survive. The check below looks for `$CURRENT_USER`
   * ANYWHERE in the rule, which catches it nested, and the repair drops only
   * that clause.
   */
  'Area Manager',
];

const EXPECTED = [
  { role: 'svc-socket-gateway', collection: 'app_settings', actions: ['read', 'create', 'update'] },
  { role: 'svc-socket-gateway', collection: 'contacts', actions: ['create', 'read', 'update'] },
  { role: 'Agent', collection: 'contacts', actions: ['create', 'read', 'update'] },
  { role: 'Agent', collection: 'tickets', actions: ['create', 'read', 'update'] },
  { role: 'Agent', collection: 'app_settings', actions: ['read'] },
  /*
   * The late-order threshold (2026-09-21). `svc-ai-gateway` reads
   * `app_settings` for `late_delivery_minutes`, and WITHOUT this grant the
   * read 403s, the reader falls back to 60, and the queue reports a threshold
   * operations did not set — staging said 60 for several minutes while the
   * setting said 20, with nothing anywhere reporting a fault.
   */
  { role: 'svc-ai-gateway', collection: 'app_settings', actions: ['read'] },
  /* The late-orders queue and its report both read this; the agent also
     writes a row per decision. A missing read renders as an empty register,
     which reads as "nobody has handled anything". */
  { role: 'Agent', collection: 'late_order_decisions', actions: ['create', 'read'] },
  { role: 'Admin', collection: 'late_order_decisions', actions: ['read'] },
  /*
   * The dropdown lists the ops team edits (complaint types, service types,
   * sources...). Both roles are told they may manage these — the admin portal
   * offers Add/Edit/Delete to each — and until 2026-09-22 WeCare Supervisor
   * had READ only, so every attempt failed with "unable to modify". The
   * buttons were there; the database said no.
   */
  {
    role: 'WeCare Admin',
    collection: 'option_lists',
    actions: ['create', 'read', 'update', 'delete'],
  },
  {
    role: 'WeCare Supervisor',
    collection: 'option_lists',
    actions: ['create', 'read', 'update', 'delete'],
  },
  /*
   * The inbox's ready replies, on the SAME page as the dropdown lists and
   * managed by the same people. Every app role had READ only — so "Add"
   * failed with "Couldn't save your change" for a WeCare Admin who could
   * already manage the lists directly above it (owner, 2026-09-22).
   *
   * GRANTING THESE BY HAND DOES NOT HOLD. `quick_replies` was declared in the
   * app-roles-sync CATALOG as readOnly and NOWHERE else, so re-materializing
   * any role — which happens on every save of that role — rebuilt its policy
   * from the catalog and reset the collection to read-only. It was granted by
   * hand twice and vanished twice, each time looking like a fresh bug. The
   * durable fix was adding `crud('quick_replies')` to the `manage_lists`
   * block; this guard exists to catch it if that is ever undone (2026-09-24).
   *
   * Same trap for WeCare Supervisor and `option_lists`: the rows only survive
   * because the role now HOLDS `manage_lists`. A permission is durable when a
   * privilege produces it, never when it is inserted beside one.
   */
  {
    role: 'WeCare Admin',
    collection: 'quick_replies',
    actions: ['create', 'read', 'update', 'delete'],
  },
  {
    role: 'WeCare Supervisor',
    collection: 'quick_replies',
    actions: ['create', 'read', 'update', 'delete'],
  },
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
      /*
       * A scoped rule only NARROWS when it is the only rule for that action.
       *
       * Directus permissions are ADDITIVE - the widest duplicate wins - so a
       * `$CURRENT_USER` row sitting beside an unscoped `{}` row for the same
       * action restricts nothing. Every one of these roles had exactly that
       * pair, so the old check (fault = a scoped row EXISTS) reported six
       * failures on three healthy roles across both environments, on a guard
       * whose whole job is to be trusted when it goes red.
       *
       * The fault is a scoped rule with NO unscoped twin. A redundant scoped
       * row is still worth removing - it is confusing, and one deleted `{}`
       * row away from being a real restriction - but that is untidiness, not a
       * gap, so it prints as a note and does not fail the check.
       */
      const unscoped = new Set(
        perms
          .filter((p) => !JSON.stringify(p.permissions ?? {}).includes('$CURRENT_USER'))
          .map((p) => p.action),
      );
      for (const perm of perms) {
        if (!JSON.stringify(perm.permissions ?? {}).includes('$CURRENT_USER')) continue;
        if (unscoped.has(perm.action)) {
          process.stdout.write(
            `  [33m•[39m ${roleName} · tickets.${perm.action} has a redundant` +
              ` $CURRENT_USER rule (permission ${perm.id}) beside an unscoped one —` +
              ` access is unrestricted; the extra row is only noise
`,
          );
          continue;
        }
        gaps += 1;
        process.stdout.write(
          `  [31m✗[39m ${roleName} · tickets.${perm.action} is SCOPED to` +
            ` $CURRENT_USER (permission ${perm.id}) with NO unscoped rule, but the role may` +
            ` see every ticket — an unreadable ticket returns null and renders as missing data
`,
        );
      }
    }
  }

  /*
   * A role that may approve a coupon must be able to write it onto the ticket.
   * Checked as a FIELD list rather than a grant: `update` exists on all of
   * these, it simply excluded the coupon columns.
   */
  for (const roleName of COUPON_APPROVER_ROLES) {
    const role = roles.find((r) => r.name === roleName);
    if (!role) continue;
    const { data: withPolicies } = await api(
      base,
      `/roles/${role.id}?fields=policies.policy.id`,
      token,
    );
    const writable = new Set();
    let unrestricted = false;
    for (const p of withPolicies.policies ?? []) {
      const pid = p.policy?.id;
      if (!pid) continue;
      const { data: perms } = await api(
        base,
        `/permissions?filter[policy][_eq]=${pid}&filter[collection][_eq]=tickets&filter[action][_eq]=update&fields=fields&limit=-1`,
        token,
      );
      for (const perm of perms) {
        const f = perm.fields;
        if (!f || f.includes('*')) unrestricted = true;
        else for (const name of f) writable.add(name);
      }
    }
    if (unrestricted) continue;
    const missing = COUPON_TICKET_FIELDS.filter((f) => !writable.has(f));
    if (missing.length > 0) {
      gaps += 1;
      process.stdout.write(
        `  [31m✗[0m ${roleName} may approve coupons but CANNOT write` +
          ` tickets.${missing.join(', ')} — approving fails with "Could not record that decision"
`,
      );
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
