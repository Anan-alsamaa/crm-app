/**
 * Idempotent Directus bootstrap (T013).
 *
 * Creates all collections, fields, m2o relations, m2m junctions, roles, and
 * permissions defined in collections.ts / roles.ts, then applies raw-SQL
 * indexes + partial-unique constraints from constraints.ts.
 *
 * Run against a healthy Directus instance:  pnpm --filter @yiji/directus-bootstrap apply
 *
 * NOTE: requires Directus + Postgres reachable (docker compose up). Safe to
 * re-run — every step tolerates "already exists".
 */
import {
  authentication,
  createDirectus,
  createCollection,
  createField,
  createRelation,
  updateRelation,
  createRole,
  updateRole,
  createPolicy,
  createPermission,
  deletePermission,
  updatePermission,
  createUser,
  updateUser,
  readUsers,
  readSettings,
  updateSettings,
  readCollections,
  readRoles,
  readPolicies,
  readPermissions,
  rest,
} from '@directus/sdk';
import pg from 'pg';
import { collections, junctions, relations, type FieldSpec } from './collections.js';
import { applyCompensation, PROVISION_COMPENSATION } from './compensation.js';
import { applyCompensationFlows } from './compensation-flows.js';
import { constraintStatements } from './constraints.js';
import {
  applyConstraintsViaDocker,
  dockerPostgresAvailable,
  dockerPostgresContainer,
} from './constraints-via-docker.js';
import { roles } from './roles.js';
import { loadEnv } from './env.js';

type AnyClient = ReturnType<typeof makeClient>;

function makeClient(url: string) {
  return createDirectus(url).with(authentication('json')).with(rest());
}

/** Extract a human message from an Error or a Directus SDK error object. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'errors' in err) {
    const errors = (err as { errors?: Array<{ message?: string }> }).errors;
    if (Array.isArray(errors) && errors[0]?.message) return errors[0].message;
  }
  return String(err);
}

/** Swallow "already exists" / duplicate errors so the script is idempotent. */
async function idempotent(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    console.log(`  + ${label}`);
  } catch (err) {
    const msg = errorMessage(err);
    if (/exist|duplicate|unique|already/i.test(msg)) {
      console.log(`  = ${label} (exists)`);
    } else {
      console.error(`  ! ${label}: ${msg}`);
      throw err;
    }
  }
}

/**
 * For metadata-only operations that re-run every pass and are idempotent in
 * EFFECT rather than via an "already exists" error — e.g. `updateRelation`
 * (always succeeds; re-applying the same meta changes nothing). They must be
 * logged with the neutral `=` prefix, NOT `+`: the idempotence check
 * (check-idempotence.mjs) flags every `+` line on the second apply as drift, so
 * an always-succeeding update would falsely fail it.
 */
async function synced(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    console.log(`  = ${label} (synced)`);
  } catch (err) {
    console.error(`  ! ${label}: ${errorMessage(err)}`);
    throw err;
  }
}

/** Map our FieldType to a Directus field-creation payload. */
function fieldPayload(spec: FieldSpec) {
  const special: string[] = [];
  let directusType: string = spec.type;
  if (spec.type === 'json') special.push('cast-json');
  if (spec.type === 'boolean') special.push('cast-boolean');
  if (spec.type === 'dateTime') directusType = 'timestamp';

  return {
    field: spec.field,
    type: directusType,
    meta: {
      interface: spec.choices
        ? 'select-dropdown'
        : spec.type === 'json'
          ? 'input-code'
          : spec.type === 'boolean'
            ? 'boolean'
            : 'input',
      options: spec.choices ? { choices: spec.choices.map((c) => ({ text: c, value: c })) } : null,
      special: special.length ? special : null,
      required: spec.required ?? false,
      note: spec.note ?? null,
    },
    schema: {
      is_nullable: !spec.required,
      default_value: spec.defaultValue ?? null,
      is_unique: spec.unique ?? false,
      is_indexed: spec.index ?? false,
    },
  };
}

/** Directus system fields auto-populated per row (data-model.md mandates these). */
const SYSTEM_FIELDS: Array<Record<string, unknown>> = [
  {
    field: 'date_created',
    type: 'timestamp',
    meta: {
      interface: 'datetime',
      special: ['date-created'],
      readonly: true,
      hidden: true,
      width: 'half',
    },
    schema: { is_nullable: true },
  },
  {
    field: 'date_updated',
    type: 'timestamp',
    meta: {
      interface: 'datetime',
      special: ['date-updated'],
      readonly: true,
      hidden: true,
      width: 'half',
    },
    schema: { is_nullable: true },
  },
  {
    field: 'user_created',
    type: 'uuid',
    meta: {
      interface: 'select-dropdown-m2o',
      special: ['user-created'],
      readonly: true,
      hidden: true,
      width: 'half',
    },
    schema: { is_nullable: true },
  },
  {
    field: 'user_updated',
    type: 'uuid',
    meta: {
      interface: 'select-dropdown-m2o',
      special: ['user-updated'],
      readonly: true,
      hidden: true,
      width: 'half',
    },
    schema: { is_nullable: true },
  },
];

/** UUID primary key field spec (data-model.md). */
function uuidPrimaryKey(): Record<string, unknown> {
  return {
    field: 'id',
    type: 'uuid',
    meta: { interface: 'input', readonly: true, hidden: true, special: ['uuid'] },
    schema: { is_primary_key: true, has_auto_increment: false, length: 36 },
  };
}

async function applyCollections(client: AnyClient): Promise<void> {
  console.log('Collections & fields:');
  for (const spec of collections) {
    // Create with UUID primary key + system date/user fields up front.
    await idempotent(`collection ${spec.collection}`, () =>
      client.request(
        createCollection({
          collection: spec.collection,
          meta: { note: spec.note ?? null },
          schema: {},
          fields: [uuidPrimaryKey(), ...SYSTEM_FIELDS],
        } as never),
      ),
    );
    // If collection already existed, ensure the system fields are present too.
    for (const sys of SYSTEM_FIELDS) {
      await idempotent(`${spec.collection}.${sys.field as string}`, () =>
        client.request(createField(spec.collection, sys as never)),
      );
    }
    for (const field of spec.fields) {
      await idempotent(`${spec.collection}.${field.field}`, () =>
        client.request(createField(spec.collection, fieldPayload(field) as never)),
      );
    }
  }
}

async function applyRelations(client: AnyClient): Promise<void> {
  console.log('Relations:');
  for (const rel of relations) {
    // Ensure the FK field exists (uuid) on the owning collection.
    await idempotent(`field ${rel.collection}.${rel.field}`, () =>
      client.request(
        createField(rel.collection, {
          field: rel.field,
          type: 'uuid',
          meta: { interface: 'select-dropdown-m2o', special: ['m2o'] },
          schema: { is_nullable: true },
        } as never),
      ),
    );
    await idempotent(`relation ${rel.collection}.${rel.field} -> ${rel.related}`, () =>
      client.request(
        createRelation({
          collection: rel.collection,
          field: rel.field,
          related_collection: rel.related,
          schema: { on_delete: rel.onDelete ?? 'SET NULL' },
        } as never),
      ),
    );
  }
}

async function applyJunctions(client: AnyClient): Promise<void> {
  console.log('M2M junctions:');
  for (const j of junctions) {
    await idempotent(`junction ${j.junction}`, () =>
      client.request(
        createCollection({
          collection: j.junction,
          meta: { hidden: true, note: 'm2m junction' },
          schema: {},
          fields: [uuidPrimaryKey()],
        } as never),
      ),
    );
    for (const [field, related] of [
      [j.fieldA, j.collectionA],
      [j.fieldB, j.collectionB],
    ] as const) {
      await idempotent(`${j.junction}.${field}`, () =>
        client.request(
          createField(j.junction, {
            field,
            type: 'uuid',
            meta: { interface: 'select-dropdown-m2o', special: ['m2o'] },
            schema: { is_nullable: true },
          } as never),
        ),
      );
      await idempotent(`relation ${j.junction}.${field} -> ${related}`, () =>
        client.request(
          createRelation({
            collection: j.junction,
            field,
            related_collection: related,
            schema: { on_delete: 'CASCADE' },
          } as never),
        ),
      );
    }

    // Expose the M2M as a nested alias on collectionA (e.g. `conversations.tags`).
    // Without this the owning collection cannot read its related rows via a
    // nested field — the junction is only reachable directly. Two parts:
    //   1. an alias field on collectionA, and
    //   2. the A-side relation's one_field/junction_field so it resolves through
    //      the junction to collectionB.
    // updateRelation runs every pass (metadata-only, idempotent in effect).
    if (j.aliasA) {
      await idempotent(`alias ${j.collectionA}.${j.aliasA}`, () =>
        client.request(
          createField(j.collectionA, {
            field: j.aliasA,
            type: 'alias',
            meta: { interface: 'list-m2m', special: ['m2m'] },
          } as never),
        ),
      );
      await synced(`wire ${j.junction}.${j.fieldA} one_field=${j.aliasA}`, () =>
        client.request(
          updateRelation(j.junction, j.fieldA, {
            meta: { one_field: j.aliasA, junction_field: j.fieldB },
          } as never),
        ),
      );
    }
  }
}

/**
 * Provision custom fields on the built-in `directus_users` collection (#10).
 *
 * `notification_preferences` is referenced by the Agent policy in roles.ts
 * (self-service update) and read by the notification worker for per-user
 * channel prefs, but it is NOT a Directus system field — without creating it
 * here, the agent's preferences-save 403s ("field does not exist") and the
 * worker has nothing to read. Nullable (the app treats absent prefs as the
 * channel defaults). locale/first_name/last_name are built-in, so only this
 * one needs creating.
 */
async function applyUserFields(client: AnyClient): Promise<void> {
  console.log('User profile fields:');
  await idempotent('directus_users.notification_preferences', () =>
    client.request(
      createField('directus_users', {
        field: 'notification_preferences',
        type: 'json',
        meta: {
          interface: 'input-code',
          special: ['cast-json'],
          note: 'Per-user notification channel preferences (agent portal + workers).',
        },
        schema: { is_nullable: true, default_value: null },
      } as never),
    ),
  );
}

async function applyRoles(client: AnyClient): Promise<void> {
  // Directus 11 access model: Role groups users; a Policy carries access flags
  // (admin_access / app_access) and Permissions; directus_access links them.
  // Truly idempotent: Directus permits duplicate role/policy NAMES, so we must
  // read-before-create by name rather than relying on create() to reject dupes.
  console.log('Roles, policies & permissions:');

  /**
   * Every collection any role here declares — the set this file is responsible
   * for. Used to decide what the revoke pass below is allowed to touch, so
   * grants made by other provisioning tools on the same policies survive.
   */
  const managedCollections = new Set(
    roles.flatMap((r) => (r.permissions ?? []).map((p) => p.collection)),
  );

  for (const role of roles) {
    if (role.name === 'Administrator') {
      console.log('  = Administrator (built-in)');
      continue;
    }

    // Role (find by name, else create).
    const existingRoles = (await client.request(
      // Pull the nested policy id (policies = directus_access junction rows);
      // without `.policy` the link check below never matches and re-links the
      // policy on every run (non-idempotent + duplicate access rows).
      readRoles({
        filter: { name: { _eq: role.name } },
        limit: 1,
        fields: ['id', 'policies.policy'],
      }),
    )) as Array<{ id: string; policies?: unknown[] }>;
    let roleId: string;
    if (existingRoles[0]) {
      roleId = existingRoles[0].id;
      console.log(`  = role ${role.name} (exists)`);
    } else {
      roleId = (
        (await client.request(
          createRole({ name: role.name, description: role.description } as never),
        )) as { id: string }
      ).id;
      console.log(`  + role ${role.name}`);
    }

    // Policy (find by name, else create).
    const policyName = `${role.name} policy`;
    const existingPolicies = (await client.request(
      readPolicies({ filter: { name: { _eq: policyName } }, limit: 1, fields: ['id'] }),
    )) as Array<{ id: string }>;
    let policyId: string;
    if (existingPolicies[0]) {
      policyId = existingPolicies[0].id;
      console.log(`  = policy ${policyName} (exists)`);
    } else {
      policyId = (
        (await client.request(
          createPolicy({
            name: policyName,
            description: role.description,
            admin_access: role.adminAccess,
            app_access: role.appAccess,
          } as never),
        )) as { id: string }
      ).id;
      console.log(`  + policy ${policyName}`);
    }

    // Link policy → role only if not already linked (avoid duplicate access rows).
    const linked = (existingRoles[0]?.policies ?? []) as Array<{ policy?: string } | string>;
    const alreadyLinked = linked.some((l) =>
      typeof l === 'string' ? l === policyId : l.policy === policyId,
    );
    if (!alreadyLinked) {
      await idempotent(`access ${role.name}`, () =>
        client.request(updateRole(roleId, { policies: [{ policy: policyId }] } as never)),
      );
    } else {
      console.log(`  = access ${role.name} (linked)`);
    }

    /* Permissions.
     *
     * Existence alone is NOT enough to call a permission correct: this used to
     * skip on (collection, action) and never look at `fields` or the row
     * filter, so tightening an EXISTING permission — say, restricting which
     * store columns a role may write — was declared in roles.ts, printed as
     * "(exists)", and never actually applied. The permission matrix could drift
     * from this file indefinitely with no symptom. Reconcile both. */
    if (!role.permissions) continue;
    const existingPerms = (await client.request(
      readPermissions({ filter: { policy: { _eq: policyId } }, limit: -1 }),
    )) as Array<{
      id: number;
      collection: string;
      action: string;
      fields: string[] | null;
      permissions: Record<string, unknown> | null;
    }>;
    const byKey = new Map(existingPerms.map((p) => [`${p.collection}|${p.action}`, p]));
    for (const p of role.permissions) {
      const current = byKey.get(`${p.collection}|${p.action}`);
      if (current) {
        const wantFields = p.fields ?? ['*'];
        const wantFilter = p.permissions ?? {};
        const sameFields =
          JSON.stringify([...(current.fields ?? [])].sort()) ===
          JSON.stringify([...wantFields].sort());
        const sameFilter = JSON.stringify(current.permissions ?? {}) === JSON.stringify(wantFilter);
        if (sameFields && sameFilter) {
          console.log(`  = perm ${role.name} ${p.action} ${p.collection} (exists)`);
          continue;
        }
        await idempotent(`perm ${role.name} ${p.action} ${p.collection} (reconciled)`, () =>
          client.request(
            updatePermission(current.id, {
              fields: wantFields,
              permissions: wantFilter,
            } as never),
          ),
        );
        continue;
      }
      await idempotent(`perm ${role.name} ${p.action} ${p.collection}`, () =>
        client.request(
          createPermission({
            policy: policyId,
            collection: p.collection,
            action: p.action,
            fields: p.fields ?? ['*'],
            permissions: p.permissions ?? {},
            validation: {},
          } as never),
        ),
      );
    }

    /**
     * REVOKE what roles.ts no longer declares — but only on collections this
     * file actually governs.
     *
     * Without any revocation the file is half a source of truth: it can grant,
     * and it can tighten an existing grant, but a permission DELETED from it
     * lives on in the database forever. Not a tidiness problem — the Agent role
     * kept an unfiltered `messages.update` long after the code stopped
     * declaring it and grew a comment (H-3) explaining that agents must never
     * be able to edit the chat record. roles.ts said the grant was gone; the
     * database disagreed, and the database is what answers the request.
     *
     * The scope matters as much as the sweep. Other provisioning tools grant on
     * this same Agent policy for collections this bootstrap does not own — the
     * compensation clone (`directus/compensation-clone/grant-agent-perms.mjs`)
     * is the live example, and an unscoped prune deletes its work on every run,
     * breaking /compensation until somebody re-runs it. So a permission is only
     * revoked when SOME role here declares that collection: that is the test for
     * "this file is responsible for this collection's access".
     *
     * Every removal is printed. Quietly dropping access is its own surprise.
     */
    const declared = new Set(role.permissions.map((p) => `${p.collection}|${p.action}`));
    for (const stale of existingPerms) {
      if (!managedCollections.has(stale.collection)) continue;
      if (declared.has(`${stale.collection}|${stale.action}`)) continue;
      await idempotent(`perm ${role.name} ${stale.action} ${stale.collection} (REVOKED)`, () =>
        client.request(deletePermission(stale.id)),
      );
    }
  }
}

/**
 * Set directus_settings.project_owner to the admin user. Dismisses the BSL 1.1
 * "set project owner" dialog and locks in the canonical owner. The
 * lock-project-owner hook extension then rejects any later attempt to change
 * it (so it survives even an admin trying to reassign via the UI/API).
 */
async function applyProjectOwner(client: AnyClient, ownerEmail: string): Promise<void> {
  console.log('Project owner:');
  const users = (await client.request(
    readUsers({ filter: { email: { _eq: ownerEmail } }, limit: 1, fields: ['id'] }),
  )) as Array<{ id: string }>;
  if (!users[0]) {
    console.log(`  ! owner ${ownerEmail} not found — skipped`);
    return;
  }
  const current = (await client.request(readSettings({ fields: ['project_owner'] }))) as {
    project_owner: string | null;
  };
  if (current.project_owner === users[0].id) {
    console.log(`  = project_owner already ${ownerEmail} (locked)`);
    return;
  }
  try {
    await client.request(
      updateSettings({ project_owner: users[0].id, project_use_case: 'internal-tool' } as never),
    );
    // Log as an "ensure" (=) not a create (+): this re-sets the SAME canonical
    // owner, and the lock-project-owner hook guarantees it can't drift. The guard
    // above can miss when Directus serves a cached (stale-null) settings read, so
    // logging `=` here keeps the idempotence check honest for the no-op re-set.
    console.log(`  = project_owner ensured -> ${ownerEmail}`);
  } catch (err) {
    // A 403/forbidden here is NON-FATAL and must not abort the bootstrap (#11):
    // the lock-project-owner hook rejects re-assignment once an owner is set,
    // and under BSL the admin policy can lack settings-update. The canonical
    // owner is unchanged either way, so warn and let the run complete. (This
    // step is also sequenced last in main() so constraints can't be gated
    // behind it.) Re-throw only genuinely unexpected errors.
    const msg = errorMessage(err);
    if (/403|forbidden|permission|not allowed|locked|owner/i.test(msg)) {
      console.warn(`  ~ project_owner not updated (${msg}) — continuing`);
    } else {
      throw err;
    }
  }
}

async function applyServiceUsers(client: AnyClient): Promise<void> {
  // Seed one user per service role, holding the static token from env so the
  // Node services authenticate as their least-privilege account (spec §7/§14).
  // Tokens are read from env and never hard-coded; missing env => skip with warn.
  console.log('Service-account users:');
  for (const role of roles) {
    if (!role.serviceTokenEnv) continue;
    const token = process.env[role.serviceTokenEnv];
    if (!token) {
      console.log(`  ~ ${role.name}: ${role.serviceTokenEnv} not set — skipped`);
      continue;
    }
    const existingRole = (await client.request(
      readRoles({ filter: { name: { _eq: role.name } }, limit: 1, fields: ['id'] }),
    )) as Array<{ id: string }>;
    const roleId = existingRole[0]?.id;
    if (!roleId) {
      console.log(`  ! ${role.name}: role not found — skipped`);
      continue;
    }
    const email = `${role.name}@svc.example.com`;
    const existingUser = (await client.request(
      readUsers({ filter: { email: { _eq: email } }, limit: 1, fields: ['id'] }),
    )) as Array<{ id: string }>;
    if (existingUser[0]) {
      // "Ensure" the token/role (same value on re-run). Log as unchanged rather
      // than created so the idempotence check stays honest — an unconditional
      // update is a no-op at the data level here.
      await client.request(updateUser(existingUser[0].id, { token, role: roleId } as never));
      console.log(`  = service user ${email} (token ensured)`);
    } else {
      await idempotent(`service user ${email}`, () =>
        client.request(
          createUser({
            email,
            first_name: role.name,
            role: roleId,
            token,
            status: 'active',
          } as never),
        ),
      );
    }
  }
}

/**
 * Prove the direct Postgres connection is the SAME database Directus writes to,
 * before running a single line of raw SQL.
 *
 * Everything above this point goes through the Directus HTTP API, so it always
 * lands on the right database. The constraints step is the one place we open our
 * own socket — and a connection to the WRONG Postgres does not error. It
 * connects, it runs `CREATE INDEX IF NOT EXISTS`, it succeeds, and the bootstrap
 * prints a clean run while the live database gained nothing. That is exactly
 * what happened here: `postgres` was not published to the host, so DB_PORT fell
 * back to 5432 — an unrelated native PostgreSQL install with an old copy of the
 * schema — and every index went there, silently, for as long as it had been set
 * up that way.
 *
 * The check: every field this file just declared through the API must be visible
 * over the direct connection. Table names alone are too weak (a stale copy has
 * those too); a freshly added column is the thing only the real database can
 * have. Mismatch = abort, because writing to the wrong database is worse than
 * not writing at all.
 */
/** What to change when the direct connection is wrong or absent. */
const DIRECT_DB_HINT =
  `  Set DB_HOST_EXTERNAL/DB_PORT_EXTERNAL to the Postgres BEHIND DIRECTUS.\n` +
  `  Locally that is the compose container, published by docker-compose.yml on\n` +
  `  127.0.0.1:\${DB_PORT_EXTERNAL:-5434}. If nothing is listening there, the\n` +
  `  container predates that mapping — recreate it with:  docker compose up -d postgres\n` +
  `  Do NOT reach for 5432/5433 because something answers: on a machine with a\n` +
  `  native PostgreSQL install those are a DIFFERENT database, and writing this\n` +
  `  schema's indexes into it succeeds silently.`;

async function assertSameDatabase(pool: pg.Pool, where: string): Promise<void> {
  let rows: Array<{ table_name: string; column_name: string }>;
  try {
    ({ rows } = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`,
    ));
  } catch (err) {
    // A raw ECONNREFUSED/auth stack here reads as "the bootstrap is broken".
    // It is not — the schema and roles are already applied; only the direct
    // socket is misconfigured. Say which address failed and what to do.
    throw new Error(
      `Cannot reach ${where} for the raw-SQL step: ${errorMessage(err)}\n` +
        `  (Collections, fields, roles and permissions applied fine — those go\n` +
        `  through the Directus API. Only the direct Postgres connection failed.)\n` +
        DIRECT_DB_HINT,
    );
  }
  const present = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
  const missing: string[] = [];
  for (const spec of collections) {
    for (const field of spec.fields) {
      if (!present.has(`${spec.collection}.${field.field}`)) {
        missing.push(`${spec.collection}.${field.field}`);
      }
    }
  }
  if (missing.length === 0) return;
  const shown = missing.slice(0, 8).join(', ');
  const more = missing.length > 8 ? ` (+${missing.length - 8} more)` : '';
  throw new Error(
    `Refusing to run raw SQL: ${where} is NOT the database Directus is using.\n` +
      `  ${missing.length} field(s) applied via the API a moment ago are missing there: ${shown}${more}\n` +
      DIRECT_DB_HINT,
  );
}

async function applyConstraints(): Promise<void> {
  // Raw-SQL partial-unique indexes target the Postgres deployment. The local
  // SQLite dev instance skips them (Directus + the app layer still enforce the
  // schema; dedup is additionally guarded in app code).
  const dbClient = process.env.DB_CLIENT ?? 'pg';
  if (dbClient !== 'pg' && dbClient !== 'postgres') {
    console.log(`Indexes & constraints (raw SQL): skipped (DB_CLIENT=${dbClient}, not Postgres)`);
    return;
  }
  console.log('Indexes & constraints (raw SQL):');
  const env = loadEnv();
  const pool = new pg.Pool(env.db);
  const where = `${env.db.host}:${env.db.port}/${env.db.database}`;
  try {
    try {
      await assertSameDatabase(pool, where);
    } catch (err) {
      // The host cannot reach the database behind Directus — either nothing is
      // listening on that port, or (worse, and why assertSameDatabase exists)
      // something ELSE is. A developer machine running its own PostgreSQL
      // shadows the container's published port and answers in its place.
      //
      // Rather than leave the schema half-applied, run the same SQL inside the
      // container, where it cannot reach the wrong server. Nothing is
      // restarted and no port has to be freed.
      if (dockerPostgresAvailable()) {
        console.log(`  ! ${where} is not the database behind Directus`);
        const why = err instanceof Error ? (err.message.split(/\r?\n/)[0] ?? '') : String(err);
        console.log(`    (${why})`);
        console.log(`  → applying inside container ${dockerPostgresContainer} instead`);
        const indexes = applyConstraintsViaDocker();
        console.log(`  = applied via docker; uq_/idx_ indexes present: ${indexes}`);
        return;
      }
      throw err;
    }
    console.log(`  = target ${where} confirmed as the database behind Directus`);
    for (const sql of constraintStatements) {
      // Log `=` vs `+` honestly so the idempotence check (check-idempotence.mjs)
      // can assert "second apply created nothing" — `CREATE ... IF NOT EXISTS`
      // succeeds either way, so we must probe pg_indexes to know which happened.
      const name = sql.match(/INDEX\s+(?:IF NOT EXISTS\s+)?(\w+)/i)?.[1];
      let existed = false;
      if (name) {
        const { rowCount } = await pool.query('SELECT 1 FROM pg_indexes WHERE indexname = $1', [
          name,
        ]);
        existed = (rowCount ?? 0) > 0;
      }
      await pool.query(sql);
      const label = name ?? sql.split('\n')[0]?.trim();
      // Index statements were probed above (existed?). Everything else here is
      // CREATE OR REPLACE FUNCTION / DROP TRIGGER IF EXISTS — idempotent in
      // EFFECT (re-running changes nothing), so report it as synced, not created;
      // otherwise the always-run DDL trips the idempotence check on the 2nd pass.
      if (!name) {
        console.log(`  = ${label} (synced)`);
      } else {
        console.log(existed ? `  = ${label} (exists)` : `  + ${label}`);
      }
    }
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  console.log(`Bootstrapping Directus at ${env.directusUrl} ...`);
  const client = makeClient(env.directusUrl);
  await client.login(env.adminEmail, env.adminPassword);

  await applyCollections(client);
  await applyUserFields(client);
  await applyRelations(client);
  await applyJunctions(client);
  // After the CRM schema (the compensation issue catalog has an m2o onto
  // `sla_policies`) and before roles — the Agent policy grants read/update on
  // these collections, and a permission on a collection that doesn't exist yet
  // is a silent dead grant.
  if (PROVISION_COMPENSATION) {
    await applyCompensation(client, idempotent);
    // Flows AFTER the collections they act on: a manual flow is scoped to
    // `compensation_requests`, so the collection must exist first.
    await applyCompensationFlows(client, idempotent);
  } else {
    console.log(
      'Compensation: skipped — it lives in a separate Directus. ' +
        'Set PROVISION_COMPENSATION=true if THIS instance owns it.',
    );
  }
  await applyRoles(client);
  await applyServiceUsers(client);
  // Constraints run BEFORE project-owner so the dedup indexes are never gated
  // behind it (#11): project-owner is now tolerant, but keeping it last means
  // even an unexpected failure there can't skip the raw-SQL constraints.
  await applyConstraints();
  await applyProjectOwner(client, env.adminEmail);

  const cols = (await client.request(readCollections())) as Array<{ collection: string }>;
  console.log(`Done. Directus reports ${cols.length} collections.`);
}

main()
  .then(() => {
    // Force a clean exit: the Directus SDK (undici) and pg can leave keep-alive
    // sockets open, which otherwise keeps the event loop alive and hangs the
    // process — stalling CI's bootstrap step + the idempotence check.
    process.exit(0);
  })
  .catch((err) => {
    console.error('Bootstrap failed:', err);
    process.exit(1);
  });
