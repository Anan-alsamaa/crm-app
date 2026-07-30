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

  console.log(
    `OK: ${expectedCollections.length} collections + ${expectedRoles.length} custom roles + ` +
      `permissions verified.`,
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
