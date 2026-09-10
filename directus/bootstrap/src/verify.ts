/**
 * Verify bootstrap (T014): confirms every expected collection, role, and
 * PERMISSION exists. Exits non-zero if anything is missing. Run after `apply`.
 *
 * Permissions are checked as well as collections because that is the failure
 * mode this project keeps hitting: the schema is there, the role is there, and
 * the feature still 403s for everyone because nothing granted the policy access
 * to a collection. A missing grant is invisible until an agent clicks the tab.
 */
import {
  authentication,
  createDirectus,
  readCollections,
  readFlows,
  readPermissions,
  readPolicies,
  readRoles,
  rest,
} from '@directus/sdk';
import { collections, junctions } from './collections.js';
import {
  COMPENSATION_COLLECTIONS,
  compensationFlows,
  compensationSnapshotsPresent,
  PROVISION_COMPENSATION,
} from './compensation.js';
import { roles } from './roles.js';
import { loadEnv } from './env.js';

type Client = { request: (options: never) => Promise<unknown> };

/**
 * Every (collection, action) roles.ts declares must exist on that role's policy.
 * Returns human-readable descriptions of the grants that are missing.
 */
async function missingPermissions(client: Client): Promise<string[]> {
  const missing: string[] = [];
  for (const role of roles) {
    if (!role.permissions) continue; // Administrator: admin_access, no rows.
    const policyName = `${role.name} policy`;
    const policies = (await client.request(
      readPolicies({ filter: { name: { _eq: policyName } }, limit: 1, fields: ['id'] }) as never,
    )) as Array<{ id: string }>;
    if (!policies[0]) {
      missing.push(`policy "${policyName}"`);
      continue;
    }
    const granted = new Set(
      (
        (await client.request(
          readPermissions({ filter: { policy: { _eq: policies[0].id } }, limit: -1 }) as never,
        )) as Array<{ collection: string; action: string }>
      ).map((p) => `${p.collection}|${p.action}`),
    );
    for (const perm of role.permissions) {
      if (!granted.has(`${perm.collection}|${perm.action}`)) {
        missing.push(`${role.name}: ${perm.action} ${perm.collection}`);
      }
    }
  }
  return missing;
}

/**
 * Is this environment actually able to SERVE customers?
 *
 * Structure being correct is not the same as being usable, and every failure
 * reported from production on 2026-09-10 was of the second kind: the schema was
 * perfect and the behaviour was wrong.
 *
 *   - `option_lists` was EMPTY, so every dropdown silently fell back to a
 *     reduced hard-coded list and the coupon screen was missing values.
 *   - `app_roles` was EMPTY, so every portal answered "This portal is not for
 *     your role" to everyone except the owner.
 *   - exactly ONE user held a routable role, so auto-assignment assigned that
 *     one agent and could escalate to nobody — which the team testing it
 *     reasonably read as "escalation is broken".
 *
 * None of those is a code bug and none would fail a schema check. They are
 * reported here as WARNINGS: an empty table is legitimate on a fresh install,
 * so this must not block a bootstrap — it must simply stop the emptiness being
 * invisible until a customer or a tester finds it.
 */
async function readinessWarnings(client: Client): Promise<string[]> {
  const warn: string[] = [];
  const count = async (collection: string, query = ''): Promise<number | null> => {
    try {
      const rows = (await client.request({
        method: 'GET',
        path: `/items/${collection}`,
        params: { limit: -1, fields: 'id', ...(query ? { filter: query } : {}) },
      } as never)) as Array<unknown>;
      return Array.isArray(rows) ? rows.length : null;
    } catch {
      /*
       * NULL IS NOT ZERO, and conflating them is how a false alarm is born.
       * An unreadable collection (permissions, an expired session) must not be
       * reported as "empty" — that is a different fault with a different fix,
       * and crying wolf here would train people to ignore the warning that
       * matters. Callers check `=== 0`, never falsiness.
       */
      return null;
    }
  };

  const lists = await count('option_lists');
  if (lists === 0) {
    warn.push(
      'option_lists is EMPTY — every dropdown (issuing side, complaint type, ' +
        'source…) will fall back to a reduced built-in list. Seed it or copy it ' +
        'from a working environment.',
    );
  }

  const appRoles = await count('app_roles');
  if (appRoles === 0) {
    warn.push(
      'app_roles is EMPTY — no role carries any privilege, so BOTH portals will ' +
        'answer "This portal is not for your role" to every non-owner account.',
    );
  }

  /*
   * The routable roster. Two agents is the minimum for the ladder to mean
   * anything: with one, `assign` works and `escalate` has nowhere to go, which
   * is indistinguishable from a broken escalation to anyone watching.
   */
  try {
    const agents = (await client.request({
      method: 'GET',
      path: '/users',
      params: {
        limit: -1,
        fields: 'id',
        'filter[status][_eq]': 'active',
        'filter[role][name][_in]': 'Agent,WeCare Agent',
      },
    } as never)) as Array<unknown>;
    const n = Array.isArray(agents) ? agents.length : 0;
    if (n === 0) {
      warn.push(
        'NO active user holds a routable role (Agent / WeCare Agent) — every ' +
          'customer chat will be left unowned.',
      );
    } else if (n === 1) {
      warn.push(
        `Only ONE routable agent exists — auto-assignment will assign to them ` +
          `and then have nobody to escalate to. The ladder needs at least two ` +
          `to do anything visible.`,
      );
    }
  } catch {
    /* Permission to read users is verified separately. */
  }

  return warn;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const client = createDirectus(env.directusUrl).with(authentication('json')).with(rest());
  await client.login(env.adminEmail, env.adminPassword);

  const expectedCollections = [
    ...collections.map((c) => c.collection),
    ...junctions.map((j) => j.junction),
    // Expected here ONLY if this instance owns compensation.
    ...(PROVISION_COMPENSATION ? COMPENSATION_COLLECTIONS : []),
  ];
  const actualCollections = new Set(
    ((await client.request(readCollections())) as Array<{ collection: string }>).map(
      (c) => c.collection,
    ),
  );
  const missingCollections = expectedCollections.filter((c) => !actualCollections.has(c));

  const expectedRoles = roles.filter((r) => r.name !== 'Administrator').map((r) => r.name);
  const actualRoles = new Set(
    ((await client.request(readRoles())) as Array<{ name: string }>).map((r) => r.name),
  );
  const missingRoles = expectedRoles.filter((r) => !actualRoles.has(r));

  const missingPerms = await missingPermissions(client as unknown as Client);

  if (missingCollections.length || missingRoles.length || missingPerms.length) {
    if (missingCollections.length)
      console.error(`Missing collections: ${missingCollections.join(', ')}`);
    if (missingRoles.length) console.error(`Missing roles: ${missingRoles.join(', ')}`);
    if (missingPerms.length) console.error(`Missing permissions: ${missingPerms.join(', ')}`);
    process.exit(1);
  }

  // WARNING, not a failure: the compensation workflow buttons trigger Directus
  // manual flows by fixed id. The bootstrap deliberately does not create them
  // (production owns the real ones, which call the Yiji API; the local stand-ins
  // must never ship). Report the gap so it is not discovered by an ops agent
  // clicking a button that silently 404s.
  if (PROVISION_COMPENSATION && compensationSnapshotsPresent()) {
    const expectedFlows = compensationFlows();
    const actualFlows = new Set(
      (
        (await client.request(readFlows({ limit: -1, fields: ['id'] }))) as Array<{ id: string }>
      ).map((f) => f.id),
    );
    const missingFlows = expectedFlows.filter((f) => !actualFlows.has(f.flowId));
    if (missingFlows.length) {
      console.warn(
        `WARN: ${missingFlows.length}/${expectedFlows.length} compensation flows missing — ` +
          `these buttons will fail: ${missingFlows.map((f) => f.label).join(', ')}. ` +
          `See directus/compensation-clone/README.md.`,
      );
    }
  }

  /*
   * Structure is sound; is the environment USABLE? These are warnings on
   * purpose — an empty table is normal on a fresh install — but they must be
   * said out loud, because each of them previously reached production and was
   * found by a person rather than by a check.
   */
  const readiness = await readinessWarnings(client as unknown as Client);
  for (const w of readiness) console.warn(`WARN: ${w}`);

  console.log(
    `OK: ${expectedCollections.length} collections + ${expectedRoles.length} custom roles + ` +
      `permissions verified.` +
      (readiness.length ? ` ${readiness.length} readiness warning(s) above.` : ''),
  );
}

main()
  .then(() => {
    // Same reason apply.ts exits explicitly: the Directus SDK (undici) leaves
    // keep-alive sockets open, which keeps the event loop alive and hangs the
    // process after the last check passes — stalling CI on a SUCCESSFUL verify.
    process.exit(0);
  })
  .catch((err) => {
    console.error('Verify failed:', err);
    process.exit(1);
  });
