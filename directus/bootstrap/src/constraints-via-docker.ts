/**
 * Apply the raw-SQL indexes and constraints THROUGH the Postgres container,
 * for machines where the host cannot reach it directly.
 *
 * WHY THIS EXISTS — `apply` connects to Postgres from the host, which needs a
 * published port that actually reaches the container. On a developer machine
 * that already runs its own PostgreSQL, it often does not: this one runs a
 * native PostgreSQL bound to 0.0.0.0:5433, so the container's published 5433 is
 * shadowed and `127.0.0.1:5433` answers from the wrong server entirely.
 *
 * That is the exact failure `assertSameDatabase` exists to catch, and it did —
 * it refused rather than writing indexes into an unrelated database. But
 * refusing leaves the step undone, and the operator is then stuck choosing
 * between stopping their native Postgres and republishing the container, both
 * of which restart services other people are using.
 *
 * `docker exec` sidesteps the whole problem: the SQL runs inside the container,
 * so it cannot reach the wrong server, and nothing is restarted.
 *
 * Every statement is `CREATE ... IF NOT EXISTS` or `CREATE OR REPLACE`, so this
 * is idempotent and safe to re-run.
 *
 * `apply` falls back to this automatically when it cannot reach Postgres, so
 * the normal bootstrap still completes. It can also be run on its own:
 *
 *   pnpm --filter @yiji/directus-bootstrap apply:constraints:docker
 *   DB_DOCKER_CONTAINER=my-pg pnpm --filter ... apply:constraints:docker
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { constraintStatements } from './constraints.js';

const CONTAINER = process.env.DB_DOCKER_CONTAINER ?? 'crm-app-infra-postgres-1';
const DB_USER = process.env.DB_USER ?? 'directus';
const DB_NAME = process.env.DB_DATABASE ?? 'yiji_crm';

/** The container this will use — worth naming in log messages. */
export const dockerPostgresContainer = CONTAINER;

/** True when the named container exists and is running. */
export function dockerPostgresAvailable(): boolean {
  try {
    const out = execFileSync('docker', ['inspect', '--format', '{{.State.Running}}', CONTAINER], {
      stdio: 'pipe',
      encoding: 'utf8',
    });
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

const INDEX_COUNT_SQL =
  "select count(*) from pg_indexes where schemaname='public' " +
  "and (indexname like 'uq_%' or indexname like 'idx_%');";

/**
 * Run every constraint statement inside the container, returning how many
 * uq_/idx_ indexes exist afterwards. Throws with psql's own output on failure,
 * in which case nothing was committed.
 */
export function applyConstraintsViaDocker(): number {
  // One transaction: a half-applied set of constraints is harder to reason
  // about than none, and every statement here is cheap.
  const sql = ['BEGIN;', ...constraintStatements, 'COMMIT;'].join('\n');

  const res = spawnSync(
    'docker',
    ['exec', '-i', CONTAINER, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', DB_USER, '-d', DB_NAME],
    { input: sql, encoding: 'utf8' },
  );
  if (res.status !== 0) {
    const detail = res.stderr || res.stdout || `docker exec exited ${String(res.status)}`;
    throw new Error(`${detail}\nFailed inside ${CONTAINER}. Nothing was committed.`);
  }

  // Report what is actually there now rather than trusting the exit code —
  // `IF NOT EXISTS` succeeds whether or not it created anything.
  const count = spawnSync(
    'docker',
    ['exec', CONTAINER, 'psql', '-U', DB_USER, '-d', DB_NAME, '-tAc', INDEX_COUNT_SQL],
    { encoding: 'utf8' },
  );
  return Number(count.stdout.trim()) || 0;
}

function main(): void {
  if (!dockerPostgresAvailable()) {
    console.error(
      `Container "${CONTAINER}" not found or not running.\n` +
        '  Set DB_DOCKER_CONTAINER to the Postgres container name (docker ps).',
    );
    process.exit(1);
  }
  try {
    const indexes = applyConstraintsViaDocker();
    console.log(`Indexes & constraints applied inside ${CONTAINER}.`);
    console.log(`  uq_/idx_ indexes now present: ${indexes}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

// Only when run as a script. `apply` imports the helpers above and must not
// trigger a second run just by importing them.
if (process.argv[1]?.endsWith('constraints-via-docker.ts')) main();
