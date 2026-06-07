/**
 * Isolated local E2E runner (Stream C).
 *
 * Runs the full Playwright suite against a THROWAWAY Directus — never the
 * seeded demo DB. No Docker required: it boots the SQLite `directus/local`
 * instance on a dedicated port, applies the Yiji schema, seeds the demo vendor,
 * starts the gateway + portals + widget pointed at it, runs Playwright, then
 * tears everything down and deletes the temp database.
 *
 *   pnpm test:e2e:local                # whole suite
 *   pnpm test:e2e:local -- <spec...>   # forwarded to `playwright test`
 *
 * Why isolated: full-stack E2E is verified in CI against a disposable Directus
 * container; locally we must not write into the demo data on :8055.
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const isWin = process.platform === 'win32';
const DIR_PORT = 8066;
const DIR_URL = `http://localhost:${DIR_PORT}`;
const GATEWAY_PORT = 8080;

const tmp = mkdtempSync(join(tmpdir(), 'yiji-e2e-'));
const DB_FILE = join(tmp, 'e2e.sqlite');

// Throwaway secrets. Admin creds match the specs' defaults so they run
// unchanged; the widget demo + gateway share dev-yiji-secret.
const SHARED = {
  YIJI_JWT_SECRET: 'dev-yiji-secret',
  SVC_GATEWAY_TOKEN: 'dev-gateway-token-for-local-only',
  SVC_WORKERS_TOKEN: 'dev-workers-token-for-local-only',
  SVC_AI_TOKEN: 'dev-ai-token-for-local-only',
  DIRECTUS_ADMIN_EMAIL: 'e.habibi@anan.sa',
  DIRECTUS_ADMIN_PASSWORD: '123456',
};

const children = [];
function run(cmd, args, opts = {}) {
  const env = { ...process.env, ...opts.env };
  // Directus must use its in-memory cache/rate-limiter, not a Redis. Strip every
  // inherited REDIS* var (e.g. REDIS_IP_ADDRESS) — a stray/empty one makes
  // Directus connect to a default Redis and crash (ECONNRESET on :6379).
  if (opts.stripRedis) for (const k of Object.keys(env)) if (/^REDIS/i.test(k)) delete env[k];
  const child = spawn(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    env,
    stdio: opts.quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit',
    shell: isWin, // resolve pnpm/npx .cmd shims on Windows
  });
  children.push(child);
  return child;
}
function once(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const c = run(cmd, args, opts);
    c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    c.on('error', reject);
  });
}
async function waitFor(url, label, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) {
        console.log(`  ✓ ${label} up`);
        return;
      }
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`${label} (${url}) did not come up`);
}

function killAll() {
  for (const c of children) {
    if (c.pid && !c.killed) {
      try {
        if (isWin) spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
        else process.kill(-c.pid, 'SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }
}
function cleanup() {
  killAll();
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

let exitCode = 1;
try {
  // 1. Boot a throwaway SQLite Directus (CORS on; no Redis cache → no stale reads).
  const directusEnv = {
    ...SHARED,
    DB_CLIENT: 'sqlite3',
    DB_FILENAME: DB_FILE,
    KEY: 'e2e-local-key',
    SECRET: 'e2e-local-secret',
    ADMIN_EMAIL: SHARED.DIRECTUS_ADMIN_EMAIL,
    ADMIN_PASSWORD: SHARED.DIRECTUS_ADMIN_PASSWORD,
    PORT: String(DIR_PORT),
    PUBLIC_URL: DIR_URL,
    CORS_ENABLED: 'true',
    CORS_ORIGIN: 'true',
    WEBSOCKETS_ENABLED: 'true',
    // Throwaway instance: in-memory cache/rate-limiter, no Redis. Strip any
    // inherited REDIS vars so Directus doesn't try to connect (and crash) on
    // a Redis the local box isn't running.
    CACHE_ENABLED: 'false',
    RATE_LIMITER_ENABLED: 'false',
    SYNCHRONIZATION_STORE: 'memory',
    WEBSOCKETS_HEARTBEAT_ENABLED: 'false',
    REDIS: '',
    REDIS_ENABLED: 'false',
  };
  delete directusEnv.REDIS_URL;
  const localDir = join(ROOT, 'directus', 'local');
  // directus/local is not part of the pnpm workspace; install it once on demand.
  if (!existsSync(join(localDir, 'node_modules'))) {
    console.log('Installing directus/local (one-time)…');
    await once(isWin ? 'npm.cmd' : 'npm', ['install'], { cwd: localDir });
  }
  console.log('Bootstrapping throwaway Directus (SQLite)…');
  await once(isWin ? 'npx.cmd' : 'npx', ['directus', 'bootstrap'], {
    cwd: localDir,
    env: directusEnv,
    stripRedis: true,
  });
  console.log(`Starting Directus on ${DIR_URL}…`);
  run(isWin ? 'npx.cmd' : 'npx', ['directus', 'start'], {
    cwd: localDir,
    env: directusEnv,
    stripRedis: true,
  });
  await waitFor(`${DIR_URL}/server/health`, 'Directus');

  // 2. Apply the Yiji schema/roles/service tokens, then seed the demo vendor.
  console.log('Applying Yiji schema…');
  await once('pnpm', ['--filter', '@yiji/directus-bootstrap', 'apply'], {
    env: { ...SHARED, DIRECTUS_URL: DIR_URL, DIRECTUS_INTERNAL_URL: DIR_URL, DB_CLIENT: 'sqlite3' },
  });
  console.log('Seeding demo vendor…');
  const token = (
    await (
      await fetch(`${DIR_URL}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: SHARED.DIRECTUS_ADMIN_EMAIL,
          password: SHARED.DIRECTUS_ADMIN_PASSWORD,
        }),
      })
    ).json()
  ).data.access_token;
  const vh = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const existing = await (
    await fetch(
      `${DIR_URL}/items/vendors?filter[yiji_vendor_id][_eq]=demo-vendor&fields=id&limit=1`,
      { headers: vh },
    )
  ).json();
  if (!existing.data?.[0]) {
    await fetch(`${DIR_URL}/items/vendors`, {
      method: 'POST',
      headers: vh,
      body: JSON.stringify({
        yiji_vendor_id: 'demo-vendor',
        name: 'Demo Vendor',
        status: 'active',
      }),
    });
  }

  // 3. Start gateway + portals + widget pointed at the throwaway Directus.
  const appEnv = {
    ...SHARED,
    REDIS_ENABLED: 'false',
    PORT: String(GATEWAY_PORT),
    DIRECTUS_INTERNAL_URL: DIR_URL,
    VITE_DIRECTUS_URL: DIR_URL,
    VITE_SOCKET_URL: `http://localhost:${GATEWAY_PORT}`,
    VITE_AI_GATEWAY_URL: 'http://localhost:8081',
  };
  console.log('Starting gateway + dev servers…');
  run('pnpm', ['--filter', '@yiji/socket-gateway', 'dev'], { env: appEnv, quiet: true });
  run('pnpm', ['--filter', '@yiji/agent-portal', 'dev'], { env: appEnv, quiet: true });
  run('pnpm', ['--filter', '@yiji/admin-portal', 'dev'], { env: appEnv, quiet: true });
  run('pnpm', ['--filter', '@yiji/chat-widget', 'dev'], { env: appEnv, quiet: true });
  for (const [port, name] of [
    [`${GATEWAY_PORT + 1}/health`, 'gateway-health'],
    ['5173', 'agent-portal'],
    ['5174', 'admin-portal'],
    ['5175', 'chat-widget'],
  ]) {
    await waitFor(`http://localhost:${port}`, name);
  }

  // 4. Run Playwright against the isolated stack.
  console.log('Running Playwright…');
  const extra = process.argv.slice(2);
  await once('pnpm', ['exec', 'playwright', 'test', ...extra], {
    env: { ...SHARED, DIRECTUS_URL: DIR_URL, E2E_BASE_URL: 'http://localhost:5173' },
  });
  exitCode = 0;
  console.log('\nE2E (isolated local) passed.');
} catch (err) {
  console.error('\nE2E (isolated local) failed:', err.message);
} finally {
  cleanup();
}
process.exit(exitCode);
