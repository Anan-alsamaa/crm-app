#!/usr/bin/env node
/**
 * RELEASE CHECK — Yiji v2 must not reach production (owner, 17 Nov 2026).
 *
 * READ-ONLY. `git grep` on the checked-out tree, or `aws ecs describe-*` on the
 * production cluster. Nothing is written anywhere, and variable VALUES are
 * never read out or printed — only names.
 *
 * Usage:
 *   node scripts/release-check/yiji2-prod-guard.mjs tree [REF]
 *       the release tree (or the commit REF): fails if
 *       packages/shared-types/src/yiji2-connector.ts exists or any file under
 *       services/ or packages/ mentions the token.
 *   node scripts/release-check/yiji2-prod-guard.mjs taskdef /tmp/taskdef.json
 *       one rendered task definition (the deploy job, before it registers).
 *   CLUSTER=crm-prod node scripts/release-check/yiji2-prod-guard.mjs ecs
 *       every service's RUNNING task definition on the cluster (default
 *       crm-prod): fails on any VENDOR_YIJI2_* / YIJI2_* env var or secret.
 *
 * Override: ALLOW_YIJI2_ON_PROD=true turns a FAIL into a WARN. The workflow
 * passes the repository variable vars.ALLOW_YIJI2_ON_PROD — not set today.
 * The decisions live in ./lib/prod-tenant-guard.mjs (unit-tested).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import {
  V2_CONNECTOR_PATH,
  V2_GUARDED_DIRS,
  V2_TOKEN,
  allowV2OnProd,
  v2TaskDefVerdict,
  v2TreeVerdict,
} from './lib/prod-tenant-guard.mjs';

const ID = 'YIJI2-PROD';
const NAME = 'Yiji v2 must not reach production (owner, 17 Nov)';
const allow = allowV2OnProd(process.env.ALLOW_YIJI2_ON_PROD);
const gha = process.env.GITHUB_ACTIONS === 'true';

function finish(verdict, what) {
  console.log(`${verdict.status.padEnd(4)}  [${ID}] ${NAME} (${what}) — ${verdict.detail}`);
  for (const o of verdict.offenders) console.log(`        ${o}`);
  if (gha && verdict.status === 'FAIL')
    console.log(
      `::error title=${NAME}::${verdict.detail}. Remove the v2 tenant from this release, or the owner sets the repository variable ALLOW_YIJI2_ON_PROD=true (docs/YIJI-V2-TENANT.md).`,
    );
  if (gha && verdict.status === 'WARN') console.log(`::warning title=${NAME}::${verdict.detail}`);
  process.exit(verdict.status === 'FAIL' ? 1 : 0);
}

function aws(...args) {
  return JSON.parse(execFileSync('aws', [...args, '--output', 'json'], { encoding: 'utf8' }));
}

const mode = process.argv[2];

if (mode === 'tree') {
  // Optional REF: check a commit instead of the working tree (the workflow
  // passes origin/main when the release PROMOTES the `:main` image rather than
  // building the tagged tree — then main's code is what would ship).
  const ref = process.argv[3];
  let files = [];
  try {
    files = execFileSync(
      'git',
      ['grep', '-il', '-e', V2_TOKEN, ...(ref ? [ref] : []), '--', ...V2_GUARDED_DIRS],
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean)
      .map((f) => (ref && f.startsWith(`${ref}:`) ? f.slice(ref.length + 1) : f));
  } catch (e) {
    // git grep exits 1 when nothing matches; anything else is a real error.
    if (e.status !== 1) throw e;
  }
  let connector = false;
  if (ref) {
    try {
      execFileSync('git', ['cat-file', '-e', `${ref}:${V2_CONNECTOR_PATH}`], { stdio: 'ignore' });
      connector = true;
    } catch {
      connector = false;
    }
  } else connector = existsSync(V2_CONNECTOR_PATH);
  if (connector) files.push(V2_CONNECTOR_PATH);
  finish(v2TreeVerdict(files, { allow }), ref ? `tree at ${ref}` : 'release tree');
} else if (mode === 'taskdef') {
  const file = process.argv[3];
  if (!file) {
    console.error('usage: yiji2-prod-guard.mjs taskdef <task-definition.json>');
    process.exit(2);
  }
  const td = JSON.parse(readFileSync(file, 'utf8'));
  const service = process.env.SERVICE || td.family || file;
  finish(v2TaskDefVerdict([{ service, taskDefinition: td }], { allow }), 'task definition');
} else if (mode === 'ecs') {
  const cluster = process.env.CLUSTER || 'crm-prod';
  const arns = aws('ecs', 'list-services', '--cluster', cluster).serviceArns ?? [];
  const services = [];
  for (let i = 0; i < arns.length; i += 10) {
    const page = aws(
      'ecs',
      'describe-services',
      '--cluster',
      cluster,
      '--services',
      ...arns.slice(i, i + 10),
    );
    for (const s of page.services ?? []) {
      if (!s.taskDefinition) continue;
      const td = aws('ecs', 'describe-task-definition', '--task-definition', s.taskDefinition);
      services.push({ service: s.serviceName, taskDefinition: td.taskDefinition });
    }
  }
  finish(v2TaskDefVerdict(services, { allow }), `ECS ${cluster}`);
} else {
  console.error('usage: yiji2-prod-guard.mjs tree | taskdef <file> | ecs');
  process.exit(2);
}
