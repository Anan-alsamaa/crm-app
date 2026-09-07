/**
 * Copy the app ROLES and their POLICIES from staging into production.
 *
 *   node scripts/copy-roles-to-prod.mjs           # dry run
 *   node scripts/copy-roles-to-prod.mjs --apply   # write them
 *
 * WHY THIS EXISTS. The bootstrap job creates the base roles — Administrator,
 * Admin, Agent and the three service accounts — but the ten APP roles (WeCare
 * Admin, WeCare Agent, Supervisor, Operations, Department Manager, the manager
 * tiers, Viewer) were created through the admin portal's roles editor and live
 * only in staging's database. Nothing in the repo recreates them.
 *
 * Recreating ten roles and their policies by hand in production is how a
 * permission ends up subtly different from the one it was tested against, and
 * a role that grants slightly too much is not visible until it matters.
 *
 * WHAT IT COPIES: the role's name, icon, description, and the policies
 * attached to it, with each policy's permissions.
 *
 * WHAT IT DOES NOT COPY: users. Production's staff accounts are created
 * deliberately, not inherited from a test environment — see
 * docs/PRODUCTION-PLAN.md.
 *
 * IDEMPOTENT: a role that already exists in production is left alone, so this
 * can be re-run after the production database moves to its own instance.
 */
import { readFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const STAGING = 'https://d2vi34f7wgjecb.cloudfront.net';
const PROD = 'https://d2ljjkmk6p5y4b.cloudfront.net';

/** Roles that exist only to test staging, and have no business in production. */
const STAGING_ONLY = new Set(['Probe Reporter']);

/** Roles the bootstrap already owns; copying them would fight it. */
const BOOTSTRAP_OWNED = new Set([
  'Administrator',
  'Admin',
  'Agent',
  'svc-workers',
  'svc-socket-gateway',
  'svc-ai-gateway',
]);

function envOf(file) {
  return Object.fromEntries(
    readFileSync(`${ROOT}/${file}`, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
  );
}

async function connect(api, email, password) {
  const login = await fetch(`${api}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }).then((r) => r.json());
  if (!login?.data?.access_token) {
    throw new Error(`${api}: login failed — ${JSON.stringify(login).slice(0, 160)}`);
  }
  const H = {
    Authorization: `Bearer ${login.data.access_token}`,
    'Content-Type': 'application/json',
  };
  return {
    get: async (path) => {
      const r = await fetch(`${api}${path}`, { headers: H }).then((x) => x.json());
      if (r.errors) throw new Error(`${path}: ${JSON.stringify(r.errors).slice(0, 200)}`);
      return r.data ?? [];
    },
    post: async (path, body) => {
      const r = await fetch(`${api}${path}`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${JSON.stringify(j.errors ?? j).slice(0, 200)}`);
      return j.data;
    },
  };
}

const stgEnv = envOf('.env');
const prdEnv = envOf('.env.prod.aws');
const stg = await connect(STAGING, stgEnv.DIRECTUS_ADMIN_EMAIL, stgEnv.DIRECTUS_ADMIN_PASSWORD);
const prd = await connect(PROD, prdEnv.DIRECTUS_ADMIN_EMAIL, prdEnv.DIRECTUS_ADMIN_PASSWORD);

const stagingRoles = await stg.get('/roles?fields=id,name,icon,description&limit=-1');
const prodRoles = await prd.get('/roles?fields=id,name&limit=-1');
const haveProd = new Map(prodRoles.map((r) => [r.name, r.id]));

const toCopy = stagingRoles.filter(
  (r) => !BOOTSTRAP_OWNED.has(r.name) && !STAGING_ONLY.has(r.name) && !haveProd.has(r.name),
);
console.log(`staging roles: ${stagingRoles.length}   production: ${prodRoles.length}`);
console.log(`to copy: ${toCopy.length}\n`);

for (const role of toCopy) {
  // A role's permissions live on the POLICIES attached to it, not on the role.
  const links = await stg.get(
    `/access?filter[role][_eq]=${role.id}&fields=policy.id,policy.name,policy.icon,policy.description,policy.app_access,policy.admin_access,policy.enforce_tfa&limit=-1`,
  );
  const policies = links.map((l) => l.policy).filter(Boolean);
  console.log(`${role.name}  (${policies.length} polic${policies.length === 1 ? 'y' : 'ies'})`);

  if (!APPLY) {
    for (const p of policies) {
      const perms = await stg.get(
        `/permissions?filter[policy][_eq]=${p.id}&fields=collection,action&limit=-1`,
      );
      console.log(`    ${p.name}: ${perms.length} permissions`);
    }
    continue;
  }

  const newRole = await prd.post('/roles', {
    name: role.name,
    icon: role.icon ?? 'supervised_user_circle',
    description: role.description ?? null,
  });

  for (const p of policies) {
    const perms = await stg.get(
      `/permissions?filter[policy][_eq]=${p.id}&fields=collection,action,permissions,validation,presets,fields&limit=-1`,
    );
    const newPolicy = await prd.post('/policies', {
      name: p.name,
      icon: p.icon ?? 'badge',
      description: p.description ?? null,
      app_access: p.app_access ?? false,
      admin_access: p.admin_access ?? false,
      enforce_tfa: p.enforce_tfa ?? false,
    });
    await prd.post('/access', { role: newRole.id, policy: newPolicy.id });
    if (perms.length) {
      await prd.post(
        '/permissions',
        perms.map((x) => ({
          policy: newPolicy.id,
          collection: x.collection,
          action: x.action,
          permissions: x.permissions ?? null,
          validation: x.validation ?? null,
          presets: x.presets ?? null,
          fields: x.fields ?? null,
        })),
      );
    }
    console.log(`    ${p.name}: ${perms.length} permissions copied`);
  }
}

console.log(APPLY ? '\nDone.' : '\nDRY RUN — nothing written. Re-run with --apply.');
