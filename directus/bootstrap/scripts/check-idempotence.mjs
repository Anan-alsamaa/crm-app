/**
 * Bootstrap idempotence verification (parallel-work-plan Stream A #11).
 *
 * Runs `apply` twice against the SAME Directus + Postgres. The first run creates
 * everything; the second MUST be a pure no-op. apply.ts prefixes every created
 * object with `+ ` and every pre-existing one with `= `, so idempotence reduces
 * to: the second run emits zero `+` lines.
 *
 * Requires a healthy, FRESH Directus + Postgres reachable via the usual env
 * (DIRECTUS_URL, DB_*, SVC_* tokens). Intended for CI (see deploy-preflight.yml)
 * but runnable locally:  pnpm --filter @yiji/directus-bootstrap check-idempotence
 */
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const bootstrapDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function runApply(label) {
  console.log(`\n=== bootstrap apply (${label}) ===`);
  const res = spawnSync('pnpm', ['exec', 'tsx', 'src/apply.ts'], {
    cwd: bootstrapDir,
    encoding: 'utf8',
    env: process.env,
    shell: process.platform === 'win32',
  });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.status !== 0) {
    console.error(`\n✗ bootstrap apply (${label}) exited with code ${res.status}`);
    process.exit(res.status ?? 1);
  }
  return res.stdout ?? '';
}

runApply('first — creates the schema');
const second = runApply('second — must be a no-op');

const created = second.split(/\r?\n/).filter((line) => /^\s*\+\s/.test(line));

if (created.length > 0) {
  console.error(`\n✗ NOT idempotent — second apply created ${created.length} object(s):`);
  for (const line of created) console.error(line);
  process.exit(1);
}

console.log('\n✓ bootstrap is idempotent: the second apply created nothing.');
