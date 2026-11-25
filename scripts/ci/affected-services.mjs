#!/usr/bin/env node
/**
 * Decide what a push to main deploys to staging. See lib/affected-services.mjs
 * for the rules; this file only gathers the changed files and writes the
 * workflow outputs.
 *
 *   node scripts/ci/affected-services.mjs <base-sha|''> <head-sha>
 *
 * <base-sha> is the commit of the LAST SUCCESSFUL staging deploy (not the
 * previous push): a failed or cancelled run must not let its changes be
 * skipped by the next one. Empty, unknown, or not an ancestor of <head-sha>
 * (history rewritten) => everything is deployed, as before this script.
 *
 * Writes to $GITHUB_OUTPUT (when set) and always prints the decision.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { affectedUnits } from './lib/affected-services.mjs';

const DOCKERFILES = {
  directus: 'directus/Dockerfile',
  'socket-gateway': 'services/socket-gateway/Dockerfile',
  'ai-gateway': 'services/ai-gateway/Dockerfile',
  workers: 'services/workers/Dockerfile',
  bootstrap: 'directus/bootstrap/Dockerfile',
};

const [base = '', head = 'HEAD'] = process.argv.slice(2);
const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function changedFiles() {
  if (!/^[0-9a-f]{7,40}$/i.test(base)) return null;
  try {
    git('cat-file', '-e', `${base}^{commit}`);
    // Must be an ancestor: a diff against an unrelated commit proves nothing.
    execFileSync('git', ['merge-base', '--is-ancestor', base, head], { stdio: 'ignore' });
    return git('diff', '--name-only', base, head)
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

const files = changedFiles();
const plan = affectedUnits(files);
const buildMatrix = plan.images.map((name) => ({ name, dockerfile: DOCKERFILES[name] }));
const nothing = plan.images.length === 0 && !plan.portals;

const out = {
  build_matrix: JSON.stringify(buildMatrix),
  deploy_services: JSON.stringify(plan.services),
  portals: String(plan.portals),
  nothing: String(nothing),
};
console.log(`base=${base || '(none)'} head=${head} files=${files ? files.length : 'n/a'}`);
for (const r of plan.reasons) console.log(`reason: ${r}`);
for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(out)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n',
  );
}
