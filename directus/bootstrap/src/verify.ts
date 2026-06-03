/**
 * Verify bootstrap (T014): confirms every expected collection and role exists.
 * Exits non-zero if anything is missing. Run after `apply`.
 */
import { authentication, createDirectus, readCollections, readRoles, rest } from '@directus/sdk';
import { collections, junctions } from './collections.js';
import { roles } from './roles.js';
import { loadEnv } from './env.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const client = createDirectus(env.directusUrl).with(authentication('json')).with(rest());
  await client.login(env.adminEmail, env.adminPassword);

  const expectedCollections = [
    ...collections.map((c) => c.collection),
    ...junctions.map((j) => j.junction),
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

  if (missingCollections.length || missingRoles.length) {
    if (missingCollections.length)
      console.error(`Missing collections: ${missingCollections.join(', ')}`);
    if (missingRoles.length) console.error(`Missing roles: ${missingRoles.join(', ')}`);
    process.exit(1);
  }

  console.log(
    `OK: ${expectedCollections.length} collections + ${expectedRoles.length} custom roles verified.`,
  );
}

main().catch((err) => {
  console.error('Verify failed:', err);
  process.exit(1);
});
