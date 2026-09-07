/*
 * Give each environment its own Redis namespace, explicitly.
 *
 * envNamespace() falls back to NODE_ENV, and BOTH environments run
 * NODE_ENV=production — staging is a production build, deliberately. So both
 * resolved to the same namespace `yiji` and shared every BullMQ queue and
 * rate-limit key on the shared cluster. A production job could be picked up by
 * a staging worker, which would do the work against the STAGING database and
 * report success. Nothing errors; the job simply happens in the wrong place.
 *
 * REDIS_NAMESPACE is the escape hatch the code already provides. Setting it
 * explicitly on both sides is better than relying on NODE_ENV, which means
 * "how is this built", not "which environment is this".
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
const APPLY = process.argv.includes('--apply');
const aws = (a) =>
  JSON.parse(
    execFileSync('aws', [...a, '--region', 'us-east-2', '--output', 'json'], {
      encoding: 'utf8',
      maxBuffer: 32e6,
    }),
  );
const PLAN = [
  ['staging', 'yiji-staging'],
  ['prod', 'yiji-prod'],
];
for (const [env, ns] of PLAN) {
  for (const svc of ['workers', 'socket-gateway', 'ai-gateway']) {
    const fam = `crm-${env}-${svc}`;
    const td = aws(['ecs', 'describe-task-definition', '--task-definition', fam]).taskDefinition;
    const cur = td.containerDefinitions[0].environment.find(
      (e) => e.name === 'REDIS_NAMESPACE',
    )?.value;
    if (cur === ns) {
      console.log(`${fam.padEnd(28)} already ${ns}`);
      continue;
    }
    console.log(`${fam.padEnd(28)} REDIS_NAMESPACE -> ${ns}`);
    if (!APPLY) continue;
    for (const k of [
      'taskDefinitionArn',
      'revision',
      'status',
      'requiresAttributes',
      'compatibilities',
      'registeredAt',
      'registeredBy',
      'deregisteredAt',
    ])
      delete td[k];
    const c = td.containerDefinitions[0];
    c.environment = [
      ...c.environment.filter((e) => e.name !== 'REDIS_NAMESPACE'),
      { name: 'REDIS_NAMESPACE', value: ns },
    ];
    const f = `.taskdef-ns-${env}-${svc}.json`;
    writeFileSync(f, JSON.stringify(td, null, 2));
    const out = aws(['ecs', 'register-task-definition', '--cli-input-json', `file://${f}`]);
    unlinkSync(f);
    console.log(`    registered ${fam}:${out.taskDefinition.revision}`);
  }
}
console.log(
  APPLY
    ? '\nRegistered. Services still run the OLD revision until updated.'
    : '\nDRY RUN — nothing changed.',
);
