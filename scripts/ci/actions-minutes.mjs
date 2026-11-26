#!/usr/bin/env node
/**
 * GITHUB ACTIONS MINUTES, PER WEEK (owner, 25 Nov 2026).
 *
 * The repo goes private on the Free plan: 2,000 Actions minutes a month. The
 * agreed budget is 400 a week for planned work (Tuesday release, staging
 * deploys, PR checks) and 400 a month kept for emergency fixes. This reports
 * what was actually used, so the budget is measured rather than guessed.
 *
 * Minutes are counted the way GitHub bills them on a private repo: per JOB,
 * each rounded UP to the whole minute. (While the repo is public nothing is
 * billed; the figure is what it WOULD cost.)
 *
 * Read-only: it only reads workflow runs through the `gh` CLI.
 *
 * Usage:
 *   node scripts/ci/actions-minutes.mjs            last 4 weeks
 *   node scripts/ci/actions-minutes.mjs --weeks 8  last 8 weeks
 *
 * Weeks start on Tuesday (the release day), in Riyadh time.
 */
import { execFileSync } from 'node:child_process';

const WEEKLY_BUDGET = 400;
const ALERT_AT = 0.75;
const RIYADH_MS = 3 * 60 * 60 * 1000;

const argWeeks = process.argv.indexOf('--weeks');
const weeks = argWeeks > -1 ? Math.max(1, Number(process.argv[argWeeks + 1]) || 4) : 4;

/** Every page of `path`, reduced by `jq` to one tab-separated line per item. */
function ghRows(path, jq) {
  const out = execFileSync('gh', ['api', '--paginate', path, '--jq', jq], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  return out
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => l.split('\t'));
}

const repo = execFileSync(
  'gh',
  ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
  {
    encoding: 'utf8',
  },
).trim();

/** Start of the current week (Tuesday 00:00 Riyadh), as a UTC timestamp. */
function weekStart(ms) {
  const local = new Date(ms + RIYADH_MS);
  const back = (local.getUTCDay() - 2 + 7) % 7; // 2 = Tuesday
  local.setUTCHours(0, 0, 0, 0);
  return local.getTime() - back * 86_400_000 - RIYADH_MS;
}

const now = Date.now();
const firstWeek = weekStart(now) - (weeks - 1) * 7 * 86_400_000;
const since = new Date(firstWeek).toISOString();

const runs = ghRows(
  `repos/${repo}/actions/runs?created=>=${since}&per_page=100`,
  '.workflow_runs[] | [.id, .name, .event, .status, .created_at] | @tsv',
).map(([id, name, event, status, created]) => ({ id, name, event, status, created }));

const buckets = new Map(); // weekStart -> Map(workflow -> minutes)
for (const run of runs) {
  if (run.status !== 'completed') continue;
  const jobs = ghRows(
    `repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`,
    '.jobs[] | [(.started_at // ""), (.completed_at // ""), (.conclusion // "")] | @tsv',
  );
  let minutes = 0;
  for (const [started, completed, conclusion] of jobs) {
    if (!started || !completed || conclusion === 'skipped') continue;
    const ms = Date.parse(completed) - Date.parse(started);
    if (ms > 0) minutes += Math.ceil(ms / 60_000);
  }
  const wk = weekStart(Date.parse(run.created));
  const name = `${run.name} (${run.event})`;
  if (!buckets.has(wk)) buckets.set(wk, new Map());
  const b = buckets.get(wk);
  b.set(name, (b.get(name) ?? 0) + minutes);
}

const day = (ms) => new Date(ms + RIYADH_MS).toISOString().slice(0, 10);
let monthTotal = 0;
for (let wk = firstWeek; wk <= weekStart(now); wk += 7 * 86_400_000) {
  const b = buckets.get(wk) ?? new Map();
  const total = [...b.values()].reduce((s, n) => s + n, 0);
  monthTotal += total;
  const flag =
    total > WEEKLY_BUDGET
      ? '  OVER BUDGET'
      : total >= WEEKLY_BUDGET * ALERT_AT
        ? '  ALERT: 75% used'
        : '';
  console.log(`\nWeek from Tue ${day(wk)}: ${total} min of ${WEEKLY_BUDGET}${flag}`);
  for (const [name, n] of [...b.entries()].sort((a, c) => c[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${name}`);
  }
}
console.log(
  `\nTotal over ${weeks} week(s): ${monthTotal} min (Free private plan: 2,000 a month; planned 1,600 + 400 reserve).`,
);
