/**
 * Teach the shared load balancer which environment a request is for.
 *
 *   node scripts/alb-split-environments.mjs           # dry run
 *   node scripts/alb-split-environments.mjs --apply   # change the rules
 *
 * THE PROBLEM. The ALB serves staging and production from one listener, and
 * every rule matches on PATH ONLY. A path rule cannot tell the environments
 * apart, so staging's rules — and the default — catch production's traffic
 * too. That is why `crm-api.anan.sa` already answers `{"status":"ok"}`: it is
 * answering from the STAGING database, and a health check cannot warn you,
 * because staging is genuinely healthy.
 *
 * THE FIX. Every rule gains a host condition. Staging's rules keep working
 * because their host list includes both the future `crm-api-staging.anan.sa`
 * and the CloudFront name in use today — the DNS is still pending, so removing
 * the CloudFront name would break staging immediately.
 *
 * THE DEFAULT RULE IS THE DANGEROUS ONE. It has no conditions and cannot be
 * given any: it is the catch-all. It currently sends everything unmatched to
 * staging's Directus, so production's Directus needs an explicit host rule at
 * a HIGHER priority (a lower number) than anything else, or production
 * requests fall through to staging.
 *
 * ONE RULE AT A TIME, with staging re-checked after each. A mistake then
 * announces itself on the rule that caused it rather than at the end of ten.
 */
import { execFileSync } from 'node:child_process';

const APPLY = process.argv.includes('--apply');
const REGION = 'us-east-2';
const LISTENER =
  'arn:aws:elasticloadbalancing:us-east-2:408568863712:listener/app/crm-alb/00f2bbf8fc852925/08d5acc44d75e44c';

/*
 * The hostnames each environment answers to: the future name AND today's.
 *
 * BOTH are required. CloudFront's origin request policy is `allViewer`, so it
 * forwards the VIEWER's Host header rather than its own — the ALB sees
 * `d2vi34f7wgjecb.cloudfront.net` today and will see
 * `crm-api-staging.anan.sa` once the DNS is published. Dropping either one
 * breaks that environment at a moment nobody chose.
 *
 * AWS ALLOWS ONLY 5 CONDITION VALUES PER RULE, counted across every condition
 * together. A rule with 5 paths therefore has no room for a host at all, which
 * is why the busier rules are SPLIT below rather than modified in place: each
 * half carries a few paths and one host, and both stay under the limit.
 */
const HOSTS = {
  staging: ['crm-api-staging.anan.sa', 'd2vi34f7wgjecb.cloudfront.net'],
  prod: ['crm-api.anan.sa', 'd2ljjkmk6p5y4b.cloudfront.net'],
};

/** AWS's hard limit: conditions + values, per rule. */
const MAX_VALUES = 5;

/** Split paths into groups that leave room for `hostCount` host values. */
function chunkPaths(paths, hostCount) {
  const room = MAX_VALUES - hostCount;
  if (room < 1) throw new Error('no room for any path alongside those hosts');
  const out = [];
  for (let i = 0; i < paths.length; i += room) out.push(paths.slice(i, i + room));
  return out;
}

/** The paths each service owns, taken from the rules already in place. */
const ROUTES = [
  { name: 'socketio', paths: ['/socket.io', '/socket.io/*'], tg: 'crm-prd-socketio', priority: 110 },
  {
    name: 'socket',
    paths: ['/webhooks/*', '/jobs/*', '/walk-in/*', '/teams/*', '/debug/*'],
    tg: 'crm-prd-socket',
    priority: 111,
  },
  {
    name: 'ai-1',
    paths: ['/commerce/*', '/admin/config', '/admin/usage'],
    tg: 'crm-prd-ai',
    priority: 120,
  },
  {
    name: 'ai-2',
    paths: [
      '/summarize-conversation',
      '/suggest-reply',
      '/analyze-sentiment',
      '/detect-intent',
      '/extract-entities',
    ],
    tg: 'crm-prd-ai',
    priority: 121,
  },
  {
    name: 'ai-3',
    paths: ['/semantic-search', '/score-lead', '/help-assistant'],
    tg: 'crm-prd-ai',
    priority: 122,
  },
  // Everything else for the production host. It must exist as a RULE, because
  // the listener's own default belongs to staging and cannot be conditioned.
  { name: 'directus', paths: ['/*'], tg: 'crm-prd-directus', priority: 190 },
];

const aws = (args) =>
  JSON.parse(
    execFileSync('aws', [...args, '--region', REGION, '--output', 'json'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    }),
  );

const tgArn = (name) =>
  aws(['elbv2', 'describe-target-groups', '--names', name]).TargetGroups[0].TargetGroupArn;

/** Staging must still answer after every single change. */
async function stagingHealthy() {
  const res = await fetch('https://d2vi34f7wgjecb.cloudfront.net/server/health', {
    signal: AbortSignal.timeout(20000),
  }).catch(() => null);
  if (!res?.ok) return false;
  const body = await res.json().catch(() => null);
  return body?.status === 'ok';
}

async function assertStagingHealthy(afterWhat) {
  if (!APPLY) return;
  // The rule takes a moment to propagate; try briefly before declaring failure.
  for (let i = 0; i < 6; i++) {
    if (await stagingHealthy()) {
      console.log(`      staging still healthy after ${afterWhat}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error(
    `STAGING IS DOWN after ${afterWhat}. Restore from alb-rules-backup.json before continuing.`,
  );
}

const rules = aws(['elbv2', 'describe-rules', '--listener-arn', LISTENER]).Rules;
const used = new Set(rules.filter((r) => !r.IsDefault).map((r) => Number(r.Priority)));
/** The next free priority at or after `from`, so a split never collides. */
function freePriority(from) {
  let p = from;
  while (used.has(p)) p += 1;
  used.add(p);
  return p;
}

console.log('=== 1. Scope each STAGING rule to staging hostnames ===');
for (const rule of rules) {
  if (rule.IsDefault) continue;
  const pathCond = rule.Conditions.find((c) => c.Field === 'path-pattern');
  if (!pathCond) continue;
  if (rule.Conditions.some((c) => c.Field === 'host-header')) {
    console.log(`  priority ${rule.Priority}: already host-scoped, skipping`);
    continue;
  }
  const paths = pathCond.Values ?? pathCond.PathPatternConfig?.Values ?? [];
  const groups = chunkPaths(paths, HOSTS.staging.length);
  const target = rule.Actions[0].TargetGroupArn;

  // The first group REPLACES this rule; any remainder becomes new rules, so a
  // rule that cannot fit its paths beside a host is split rather than dropped.
  console.log(
    `  priority ${rule.Priority}: ${paths.length} paths -> ${groups.length} rule(s), + staging hosts`,
  );
  if (APPLY) {
    aws([
      'elbv2', 'modify-rule', '--rule-arn', rule.RuleArn,
      '--conditions', JSON.stringify([
        { Field: 'path-pattern', PathPatternConfig: { Values: groups[0] } },
        { Field: 'host-header', HostHeaderConfig: { Values: HOSTS.staging } },
      ]),
    ]);
    await assertStagingHealthy(`scoping priority ${rule.Priority}`);
    for (const extra of groups.slice(1)) {
      const p = freePriority(Number(rule.Priority) + 1);
      aws([
        'elbv2', 'create-rule', '--listener-arn', LISTENER, '--priority', String(p),
        '--conditions', JSON.stringify([
          { Field: 'path-pattern', PathPatternConfig: { Values: extra } },
          { Field: 'host-header', HostHeaderConfig: { Values: HOSTS.staging } },
        ]),
        '--actions', JSON.stringify([{ Type: 'forward', TargetGroupArn: target }]),
      ]);
      console.log(`      split: priority ${p} <- ${extra.join(' ')}`);
      await assertStagingHealthy(`splitting priority ${rule.Priority}`);
    }
  } else {
    groups.forEach((g, i) => console.log(`      ${i === 0 ? 'keep ' : 'split'} ${g.join(' ')}`));
  }
}

console.log('\n=== 2. Add the PRODUCTION rules ===');
for (const route of ROUTES) {
  const groups = chunkPaths(route.paths, HOSTS.prod.length);
  for (const [i, group] of groups.entries()) {
    // Reserve in the dry run too, or the preview prints one priority twice and
    // stops being a faithful account of what --apply will do.
    const p = freePriority(route.priority + i);
    console.log(`  priority ${p}: ${route.tg} <- ${group.join(' ')}`);
    if (!APPLY) continue;
    aws([
      'elbv2', 'create-rule', '--listener-arn', LISTENER, '--priority', String(p),
      '--conditions', JSON.stringify([
        { Field: 'path-pattern', PathPatternConfig: { Values: group } },
        { Field: 'host-header', HostHeaderConfig: { Values: HOSTS.prod } },
      ]),
      '--actions', JSON.stringify([{ Type: 'forward', TargetGroupArn: tgArn(route.tg) }]),
    ]);
    await assertStagingHealthy(`adding ${route.name}`);
  }
}

console.log(
  APPLY
    ? '\nDone. Staging verified after every change.'
    : '\nDRY RUN — nothing changed. Re-run with --apply.',
);
