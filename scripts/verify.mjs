#!/usr/bin/env node
/**
 * One-command verification gate — the single entry point for "test everything".
 *
 *   pnpm verify              # full static + unit/integration gate with coverage
 *   pnpm verify --e2e        # ...plus the isolated full-stack Playwright suite
 *   pnpm verify --bail       # stop at the first failing step
 *   pnpm verify --quiet      # only stream failing steps' output
 *
 * Unlike a chained `a && b && c`, this runs EVERY step (unless --bail), so a
 * single run surfaces every gap at once instead of stopping at the first. It
 * prints a summary table (status, duration, and coverage % where available) and
 * exits non-zero if any step failed — so CI and humans get the same verdict.
 *
 * Steps mirror CI (.github/workflows/ci.yml) so `pnpm verify` locally == green CI.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const BAIL = args.has('--bail');
const QUIET = args.has('--quiet');
const E2E = args.has('--e2e');

/** Each step: a label, the shell command, and (optionally) a coverage-summary
 *  file to read a headline line-% from for the summary table. */
const steps = [
  { key: 'format', label: 'Format check', cmd: 'pnpm format:check' },
  { key: 'lint', label: 'Lint (eslint)', cmd: 'pnpm lint' },
  { key: 'types', label: 'Typecheck (all projects)', cmd: 'pnpm typecheck' },
  { key: 'guard', label: 'Security call-site guard', cmd: 'pnpm guard:security-callsites' },
  {
    key: 'svc',
    label: 'Unit+coverage: services & packages',
    cmd: 'pnpm test:coverage',
    cov: 'coverage/coverage-summary.json',
  },
  {
    key: 'agent',
    label: 'Unit+coverage: agent-portal',
    cmd: 'pnpm --filter @yiji/agent-portal test:coverage',
    cov: 'apps/agent-portal/coverage/coverage-summary.json',
  },
  {
    key: 'admin',
    label: 'Unit+coverage: admin-portal',
    cmd: 'pnpm --filter @yiji/admin-portal test:coverage',
    cov: 'apps/admin-portal/coverage/coverage-summary.json',
  },
  {
    key: 'widget',
    label: 'Unit+coverage: chat-widget',
    cmd: 'pnpm --filter @yiji/chat-widget test:coverage',
    cov: 'apps/chat-widget/coverage/coverage-summary.json',
  },
];
if (E2E) {
  steps.push({ key: 'e2e', label: 'E2E: full-stack (isolated Directus)', cmd: 'pnpm test:e2e:local' });
}

const linePct = (rel) => {
  const p = join(ROOT, rel);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'))?.total?.lines?.pct ?? null;
  } catch {
    return null;
  }
};

const results = [];
for (const step of steps) {
  process.stdout.write(`\n\x1b[1m▶ ${step.label}\x1b[0m\n  ${step.cmd}\n`);
  const started = process.hrtime.bigint();
  const res = spawnSync(step.cmd, {
    cwd: ROOT,
    shell: true,
    stdio: QUIET ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
  });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const ok = res.status === 0;
  if (QUIET && !ok) process.stdout.write((res.stdout ?? '') + (res.stderr ?? ''));
  results.push({ ...step, ok, ms, pct: step.cov ? linePct(step.cov) : null });
  if (!ok && BAIL) break;
}

// ── Summary ────────────────────────────────────────────────────────────────
const pad = (s, n) => String(s).padEnd(n);
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
process.stdout.write(`\n\x1b[1m══ verify summary ══\x1b[0m\n`);
for (const r of results) {
  const mark = r.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  const cov = r.pct == null ? '' : `  ${r.pct.toFixed(1)}% lines`;
  process.stdout.write(`  ${mark} ${pad(r.label, 40)} ${pad(secs(r.ms), 7)}${cov}\n`);
}
const failed = results.filter((r) => !r.ok);
const skipped = steps.length - results.length;
if (skipped > 0) process.stdout.write(`  (${skipped} step(s) skipped after --bail)\n`);
if (failed.length === 0) {
  process.stdout.write(`\n\x1b[32m\x1b[1mALL ${results.length} STEPS PASSED\x1b[0m\n`);
  process.exit(0);
}
process.stdout.write(
  `\n\x1b[31m\x1b[1m${failed.length} STEP(S) FAILED:\x1b[0m ${failed.map((f) => f.key).join(', ')}\n`,
);
process.exit(1);
