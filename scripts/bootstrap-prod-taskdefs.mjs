/**
 * Register production's FIRST task definitions, derived from staging's live ones.
 *
 *   node scripts/bootstrap-prod-taskdefs.mjs           # dry run, prints the diff
 *   node scripts/bootstrap-prod-taskdefs.mjs --apply   # registers them
 *
 * WHY NOT `deploy/aws/ecs/*.json`. Those templates carry `{{SECRET:…}}`
 * placeholders for a secret store this account cannot use (SSM and Secrets
 * Manager are both denied), and they have drifted from what staging actually
 * runs. Staging's live revision is the honest source: it is the configuration
 * that is known to work.
 *
 * WHY NOT `deploy-service.sh`. That derives the new definition from the
 * DEPLOYED one, which is right for every subsequent deploy and impossible for
 * the first, when production has no task definition at all. This script exists
 * to be run once per service; after that, `deploy-service.sh prod <svc>` takes
 * over.
 *
 * WHAT IT CHANGES, and nothing else:
 *   - the family and log-group names, staging -> prod
 *   - the task ROLE (crm-task-role-prod), so production's permissions are its own
 *   - DB_DATABASE -> crm_prod, the whole point of the exercise
 *   - the uploads bucket and every public URL
 *   - every secret, to the fresh values in .env.prod.aws
 *   - a Redis key prefix, because the CLUSTER is shared with staging
 *   - YIJI_COUPON_DELIVERY -> off
 *
 * The image tag is carried over from staging deliberately: production runs the
 * image staging proved, not a newly built one.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const APPLY = process.argv.includes('--apply');
const REGION = 'us-east-2';
// `bootstrap` is a one-shot task, not a service: it builds the schema, roles
// and permissions, then exits. It needs a production task definition like the
// rest, and is run once (RunTask) before the services are useful.
const SERVICES = ['directus', 'socket-gateway', 'ai-gateway', 'workers', 'bootstrap'];

/** Production's public faces, from the distributions created for them. */
const PROD = {
  API_URL: 'https://d2ljjkmk6p5y4b.cloudfront.net',
  ADMIN_URL: 'https://d3sw1ca3dpsao0.cloudfront.net',
  AGENT_URL: 'https://d1feea9xuruu0v.cloudfront.net',
  WIDGET_URL: 'https://d6ww6tccn45er.cloudfront.net',
};
PROD.PORTAL_ORIGINS = `${PROD.ADMIN_URL},${PROD.AGENT_URL}`;

const aws = (args) =>
  execFileSync('aws', [...args, '--region', REGION, '--output', 'json'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });

function loadEnvFile(path) {
  if (!existsSync(path)) throw new Error(`${path} is missing — run gen-prod-secrets first`);
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
  );
}

const secrets = loadEnvFile(`${ROOT}/.env.prod.aws`);
for (const required of ['YIJI_JWT_SECRET', 'SVC_GATEWAY_TOKEN', 'DIRECTUS_KEY', 'DIRECTUS_SECRET']) {
  if (!secrets[required]) throw new Error(`.env.prod.aws is missing ${required}`);
}

/** The environment names whose values are credentials, and must never print. */
const SECRET_NAMES = new Set([
  'YIJI_JWT_SECRET',
  'SVC_GATEWAY_TOKEN',
  'SVC_WORKERS_TOKEN',
  'SVC_AI_TOKEN',
  'KEY',
  'SECRET',
  'ADMIN_PASSWORD',
  'DB_PASSWORD',
  'EMAIL_SMTP_PASSWORD',
  'GEMINI_API_KEY',
  'YIJI_ADMIN_PASSWORD',
  'YIJI_WEBHOOK_SECRET',
]);

/** staging value -> production value, applied to every environment entry. */
function productionValue(name, value) {
  // Secrets first: a staging secret reaching production is the failure this
  // whole script exists to prevent.
  const secretMap = {
    YIJI_JWT_SECRET: secrets.YIJI_JWT_SECRET,
    SVC_GATEWAY_TOKEN: secrets.SVC_GATEWAY_TOKEN,
    SVC_WORKERS_TOKEN: secrets.SVC_WORKERS_TOKEN,
    SVC_AI_TOKEN: secrets.SVC_AI_TOKEN,
    KEY: secrets.DIRECTUS_KEY,
    SECRET: secrets.DIRECTUS_SECRET,
    ADMIN_PASSWORD: secrets.DIRECTUS_ADMIN_PASSWORD,
    // The SAME credential under a second name. Directus reads ADMIN_PASSWORD
    // to CREATE its first admin; the bootstrap job reads
    // DIRECTUS_ADMIN_PASSWORD to LOG IN as that admin. Substituting only the
    // first left bootstrap presenting staging's password to production's
    // Directus, which answered 401 — correctly, and confusingly, since the
    // job had otherwise reached the right service by name.
    DIRECTUS_ADMIN_PASSWORD: secrets.DIRECTUS_ADMIN_PASSWORD,
  };
  if (name in secretMap && secretMap[name]) return secretMap[name];

  switch (name) {
    case 'DB_DATABASE':
      return 'crm_prod';
    case 'NODE_ENV':
      return 'production';
    case 'STORAGE_S3_BUCKET':
      return 'crm-prod-uploads-408568863712';
    case 'PUBLIC_URL':
      return PROD.API_URL;
    case 'CORS_ORIGIN':
    case 'PASSWORD_RESET_URL_ALLOW_LIST':
      return PROD.PORTAL_ORIGINS;
    case 'DIRECTUS_INTERNAL_URL':
    case 'DIRECTUS_URL':
      /*
       * THE NAMESPACE IS SHARED, so the NAME must not be.
       *
       * `crm.local` holds one entry per service across BOTH environments, so
       * inheriting `directus.crm.local` would have pointed production's
       * gateway and workers at STAGING's Directus — writing production traffic
       * into the staging database and quietly undoing the separate database
       * this whole exercise exists to create. Nothing would have errored.
       */
      return 'http://prod-directus.crm.local:8055';
    case 'AI_GATEWAY_URL':
      // Reached inside the cluster on the task's own IP, not by name.
      return value;
    case 'YIJI_COUPON_DELIVERY':
      // Never inherited. Turning delivery on is a decision with a cost, and it
      // is the owner's to make deliberately, not a side effect of a deploy.
      return 'off';
    case 'REDIS_PREFIX':
      return 'prod:';
    case 'SMTP_FROM':
    case 'EMAIL_FROM':
      // Staging labels itself "(staging)" in the From line, which is right
      // there and wrong here: a production password-reset signed "Sara CRM
      // (staging)" reads as a phishing attempt to the person receiving it.
      return value.replace(/\s*\(staging\)/i, '');
    default:
      return value;
  }
}

const results = [];
for (const svc of SERVICES) {
  const staging = JSON.parse(
    aws(['ecs', 'describe-task-definition', '--task-definition', `crm-staging-${svc}`]),
  ).taskDefinition;

  for (const k of [
    'taskDefinitionArn',
    'revision',
    'status',
    'requiresAttributes',
    'compatibilities',
    'registeredAt',
    'registeredBy',
    'deregisteredAt',
  ]) {
    delete staging[k];
  }

  staging.family = `crm-prod-${svc}`;
  staging.taskRoleArn = staging.taskRoleArn?.replace('crm-task-role-staging', 'crm-task-role-prod');

  const container = staging.containerDefinitions[0];
  const changed = [];
  container.environment = (container.environment ?? []).map((entry) => {
    const next = productionValue(entry.name, entry.value);
    if (next !== entry.value) {
      // Redact by whether the value IS a credential, not by whether the name
      // contains "PASSWORD": PASSWORD_RESET_URL_ALLOW_LIST is a list of URLs,
      // and printing it as "<fresh secret>" hides what is actually being set.
      const secret = SECRET_NAMES.has(entry.name);
      changed.push(`${entry.name} -> ${secret ? '<fresh secret>' : next}`);
    }
    return { ...entry, value: next };
  });

  // The cluster's Redis is SHARED with staging. Without a prefix, a staging
  // worker and a production worker draw from the same BullMQ queues — the
  // production job disappears into a staging worker with no error anywhere.
  if (!container.environment.some((e) => e.name === 'REDIS_PREFIX')) {
    container.environment.push({ name: 'REDIS_PREFIX', value: 'prod:' });
    changed.push('REDIS_PREFIX -> prod: (added; the Redis cluster is shared)');
  }

  if (container.logConfiguration?.options?.['awslogs-group']) {
    const before = container.logConfiguration.options['awslogs-group'];
    container.logConfiguration.options['awslogs-group'] = before.replace('staging', 'prod');
    changed.push(`log group -> ${container.logConfiguration.options['awslogs-group']}`);
  }

  // A staging secret surviving into production is the one unrecoverable
  // mistake here, so it is checked rather than trusted.
  const stagingEnv = JSON.parse(
    aws(['ecs', 'describe-task-definition', '--task-definition', `crm-staging-${svc}`]),
  ).taskDefinition.containerDefinitions[0].environment;
  for (const name of ['YIJI_JWT_SECRET', 'SVC_GATEWAY_TOKEN', 'KEY', 'SECRET']) {
    const before = stagingEnv.find((e) => e.name === name)?.value;
    const after = container.environment.find((e) => e.name === name)?.value;
    if (before && after && before === after) {
      throw new Error(`${svc}: ${name} is still staging's value — refusing to register`);
    }
  }

  console.log(`\n=== crm-prod-${svc} (image ${container.image.split(':').pop().slice(0, 20)}…)`);
  for (const c of changed) console.log(`    ${c}`);

  if (APPLY) {
    const file = `${ROOT}/.taskdef-prod-${svc}.json`;
    writeFileSync(file, JSON.stringify(staging, null, 2));
    const out = JSON.parse(aws(['ecs', 'register-task-definition', '--cli-input-json', `file://${file}`]));
    console.log(`    registered revision ${out.taskDefinition.revision}`);
    results.push(`crm-prod-${svc}:${out.taskDefinition.revision}`);
  }
}

console.log(
  APPLY ? `\nRegistered: ${results.join(', ')}` : '\nDRY RUN — nothing registered. Re-run with --apply.',
);
