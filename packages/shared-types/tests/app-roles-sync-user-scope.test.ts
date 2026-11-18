import { describe, expect, it } from 'vitest';
// The real extension, run against an in-memory stand-in for Directus + knex.
// @ts-expect-error - plain JS Directus hook, no type declarations.
import registerAppRolesSync from '../../../directus/extensions/app-roles-sync/index.js';

/**
 * WHO A ROLE MAY GIVE A ROLE TO (owner, 2026-11-18).
 *
 * "Nada (WeCare Supervisor) should be allowed to create a new user for the
 * role WeCare Agent; right now she can only create WeCare Supervisor."
 *
 * The Supervisor held manage_users (create/read/update on directus_users,
 * fenced only from admin-access and svc roles) but could read no role but its
 * own, so the Users page offered nothing else - while the API let it make
 * someone a WeCare Admin. These tests materialize roles through the real hook
 * and read back the permission rows it writes.
 */

interface Grant {
  collection: string;
  action: string;
  permissions: Record<string, unknown>;
  validation: Record<string, unknown>;
  fields: string[];
}

const ROLES = [
  { id: 'r-administrator', name: 'Administrator', admin: true },
  { id: 'r-svc', name: 'svc-workers' },
  { id: 'r-agent', name: 'Agent' },
  { id: 'r-wa', name: 'WeCare Agent' },
  { id: 'r-ws', name: 'wecare SUPERVISOR' }, // case differs on purpose
  { id: 'r-wadmin', name: 'WeCare Admin' },
  { id: 'r-lead', name: 'Team Lead' },
];

const PEOPLE = { manage_users: true, use_chat: true, view_tickets: true };
const ROWS: Record<string, { name: string; role: string; privileges: Record<string, boolean> }> = {
  supervisor: { name: 'WeCare Supervisor', role: 'r-ws', privileges: PEOPLE },
  admin: { name: 'WeCare Admin', role: 'r-wadmin', privileges: { ...PEOPLE, manage_roles: true } },
  lead: { name: 'Team Lead', role: 'r-lead', privileges: PEOPLE },
  agent: { name: 'WeCare Agent', role: 'r-wa', privileges: { use_chat: true } },
};

type Where = Record<string, unknown>;

/** Just enough of knex for app-roles-sync's queries. */
function fakeDatabase() {
  return (table: string) => {
    const q: { where: Where; raw: string | null; bindings: string[]; join: boolean } = {
      where: {},
      raw: null,
      bindings: [],
      join: table.startsWith('directus_roles as'),
    };
    const rows = (): Array<Record<string, unknown>> => {
      if (table === 'app_roles') {
        return Object.entries(ROWS).map(([id, r]) => ({
          id,
          name: r.name,
          privileges: JSON.stringify(r.privileges),
          brands: null,
          stores: null,
          builtin: false,
          directus_role: r.role,
          directus_policy: `p-${id}`,
        }));
      }
      if (table.startsWith('directus_roles')) {
        if (q.join) return ROLES.filter((r) => r.admin);
        let out = ROLES;
        if (q.raw?.includes("LIKE 'svc-%'"))
          out = out.filter((r) => r.name.toLowerCase().startsWith('svc-'));
        else if (q.raw?.includes('IN ('))
          out = out.filter((r) => q.bindings.includes(r.name.trim().toLowerCase()));
        return out;
      }
      if (table === 'directus_policies') return [{ id: q.where.id }];
      if (table === 'directus_access') return [{ id: 'link' }];
      return [];
    };
    const match = () =>
      rows().filter((r) => Object.entries(q.where).every(([k, v]) => r[k] === v || q.join));
    const b = {
      where(w: Where | string) {
        if (typeof w === 'object') Object.assign(q.where, w);
        return b;
      },
      whereRaw(sql: string, bindings: string[] = []) {
        q.raw = sql;
        q.bindings = bindings;
        return b;
      },
      join: () => b,
      distinct: () => b,
      first: async () => match()[0],
      pluck: async (col: string) => match().map((r) => r[col.replace(/^r\./, '')]),
      update: async () => 1,
      insert: async () => 1,
    };
    return b;
  };
}

async function materialize(rowId: string): Promise<Grant[]> {
  const handlers: Record<string, (meta: unknown) => Promise<void>> = {};
  const warnings: string[] = [];
  let written: Grant[] = [];
  class Service {
    async createOne() {
      return 'new';
    }
    async updateOne() {}
    async readByQuery() {
      return [];
    }
    async createMany(rows: Grant[]) {
      written = rows;
    }
    async deleteMany() {}
  }
  registerAppRolesSync(
    { filter: () => {}, action: (event: string, fn: never) => (handlers[event] = fn) },
    {
      services: {
        RolesService: Service,
        PoliciesService: Service,
        PermissionsService: Service,
      },
      database: fakeDatabase(),
      getSchema: async () => ({ collections: new Proxy({}, { get: () => ({}) }) }),
      logger: { info: () => {}, warn: (m: string) => warnings.push(m) },
    },
  );
  await handlers['app_roles.items.update']!({ keys: [rowId] });
  expect(warnings).toEqual([]);
  return written;
}

const on = (grants: Grant[], collection: string, action?: string) =>
  grants.filter((g) => g.collection === collection && (!action || g.action === action));

const NOT_PROTECTED = { role: { _nin: ['r-administrator', 'r-svc'] } };
const SELF = { id: { _eq: '$CURRENT_USER' } };

describe('WeCare Supervisor: assigns WeCare Agent and WeCare Supervisor only', () => {
  const SCOPE = { role: { _in: ['r-wa', 'r-ws'] } };

  it('reads exactly those roles (id, name) - its own included - so the picker offers them', async () => {
    const reads = on(await materialize('supervisor'), 'directus_roles', 'read');
    expect(reads).toEqual([
      expect.objectContaining({
        permissions: { id: { _in: ['r-wa', 'r-ws'] } },
        fields: ['id', 'name'],
      }),
    ]);
  });

  it('may create a user only into those roles (never WeCare Admin, never protected)', async () => {
    const creates = on(await materialize('supervisor'), 'directus_users', 'create');
    expect(creates).toHaveLength(1);
    expect(creates[0]!.validation).toEqual(SCOPE);
    expect(creates[0]!.permissions).toEqual({});
  });

  it('may edit - and move people into - only those roles', async () => {
    const updates = on(await materialize('supervisor'), 'directus_users', 'update');
    expect(updates).toHaveLength(2);
    for (const u of updates) expect(u.validation).toEqual(SCOPE);
    expect(updates.map((u) => u.permissions)).toEqual(
      expect.arrayContaining([SCOPE, { _and: [SELF, SCOPE] }]),
    );
    expect(JSON.stringify(updates)).not.toContain('r-wadmin');
  });

  it('still reads every user (the list itself is unchanged)', async () => {
    const reads = on(await materialize('supervisor'), 'directus_users', 'read');
    expect(reads.map((r) => r.permissions)).toEqual([{}]);
  });
});

describe('WeCare Admin (holds manage_roles): unchanged', () => {
  it('reads every role and fences only the protected ones', async () => {
    const grants = await materialize('admin');
    expect(on(grants, 'directus_roles')).toEqual([
      expect.objectContaining({ action: 'read', permissions: {}, fields: ['*'] }),
    ]);
    expect(on(grants, 'directus_users', 'create')[0]!.validation).toEqual(NOT_PROTECTED);
    const updates = on(grants, 'directus_users', 'update');
    for (const u of updates) expect(u.validation).toEqual(NOT_PROTECTED);
    expect(updates.map((u) => u.permissions)).toEqual(
      expect.arrayContaining([NOT_PROTECTED, { _and: [SELF, NOT_PROTECTED] }]),
    );
    const deletes = on(grants, 'directus_users', 'delete');
    expect(deletes.map((d) => d.permissions)).toEqual([NOT_PROTECTED]);
  });
});

describe('Administrator: unchanged', () => {
  it('is admin_access and is never materialized by this hook', async () => {
    ROWS.administrator = { name: 'Administrator', role: 'r-administrator', privileges: {} };
    try {
      // `Administrator` is a reserved name: the hook refuses it outright.
      const handlers: Record<string, (m: unknown) => Promise<void>> = {};
      const warnings: string[] = [];
      let wrote = false;
      class Service {
        async readByQuery() {
          return [];
        }
        async createMany() {
          wrote = true;
        }
      }
      registerAppRolesSync(
        { filter: () => {}, action: (e: string, fn: never) => (handlers[e] = fn) },
        {
          services: {
            RolesService: Service,
            PoliciesService: Service,
            PermissionsService: Service,
          },
          database: fakeDatabase(),
          getSchema: async () => ({ collections: {} }),
          logger: { info: () => {}, warn: (m: string) => warnings.push(m) },
        },
      );
      await handlers['app_roles.items.update']!({ keys: ['administrator'] });
      expect(wrote).toBe(false);
    } finally {
      delete ROWS.administrator;
    }
  });
});

describe('any other manage_users holder: its own role, as its Users page always offered', () => {
  it('reads and assigns its own role only', async () => {
    const grants = await materialize('lead');
    const own = { role: { _in: ['r-lead'] } };
    expect(on(grants, 'directus_roles', 'read')[0]!.permissions).toEqual({
      id: { _in: ['r-lead'] },
    });
    expect(on(grants, 'directus_users', 'create')[0]!.validation).toEqual(own);
    for (const u of on(grants, 'directus_users', 'update')) expect(u.validation).toEqual(own);
  });
});

describe('a role without manage_users: unchanged', () => {
  it('reads no roles, updates only itself, fenced from the protected roles', async () => {
    const grants = await materialize('agent');
    expect(on(grants, 'directus_roles')).toEqual([]);
    expect(on(grants, 'directus_users', 'create')).toEqual([]);
    const updates = on(grants, 'directus_users', 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0]!.permissions).toEqual({ _and: [SELF, NOT_PROTECTED] });
    expect(updates[0]!.validation).toEqual(NOT_PROTECTED);
  });
});
