import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ROLE_ASSIGNABLE_ROLES, assignableRoleNames } from '../src/role-assignment.js';

/**
 * WHICH ROLES A USER MANAGER MAY HAND OUT (owner, 18 Nov 2026): "Nada (WeCare
 * Supervisor) should be allowed to create a new user for the role WeCare
 * Agent." Order: WeCare Agent < WeCare Supervisor < WeCare Admin < Administrator.
 */
const SYNC = readFileSync(
  fileURLToPath(new URL('../../../directus/extensions/app-roles-sync/index.js', import.meta.url)),
  'utf8',
);

function extensionMap(): Record<string, string[]> {
  const start = SYNC.indexOf('const ROLE_ASSIGNABLE_ROLES = {');
  const end = SYNC.indexOf('};', start);
  expect(start).toBeGreaterThan(0);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${SYNC.slice(start, end + 2)} return ROLE_ASSIGNABLE_ROLES;`)();
}

/** The extension's grant builder, cut out of the source and run alone. */
function extensionBuildGrants() {
  const endLine = "  const readOnly = (c) => [g(c, 'read')];";
  const helpers = SYNC.slice(
    SYNC.indexOf('  const g = (collection'),
    SYNC.indexOf(endLine) + endLine.length,
  );
  const isWide = 'const isWide = (f) => !f || Object.keys(f).length === 0;';
  const start = SYNC.indexOf('  function buildGrants(');
  const body = SYNC.slice(
    start,
    SYNC.indexOf('\n  }\n', SYNC.indexOf('Branch restriction', start)) + 4,
  );
  // The real own-profile filter and grant, cut from the source like the rest.
  const selfLine = SYNC.slice(
    SYNC.indexOf('  const SELF_PROFILE = '),
    SYNC.indexOf('\n', SYNC.indexOf('  const SELF_PROFILE = ')),
  );
  const selfGrantStart = SYNC.indexOf("    g('directus_users', 'update', SELF_PROFILE, [");
  const selfGrant = SYNC.slice(selfGrantStart, SYNC.indexOf(']),', selfGrantStart) + 2);
  // A minimal stand-in for the real catalogue: only what this test needs.
  const prelude = `
    ${helpers}
    ${isWide}
    ${selfLine}
    const BASELINE = [${selfGrant}];
    const REPORT_ACCESS = [];
    const warn = () => {};
    const CATALOG = {
      manage_users: ['create', 'read', 'update'].map((a) => g('directus_users', a)),
      view_dashboard: [],
    };`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${prelude}\n${body}\nreturn buildGrants;`)() as (
    p: Record<string, boolean>,
    b: unknown,
    s: unknown,
    prot: string[],
    assignable: string[] | null,
  ) => Array<{
    collection: string;
    action: string;
    filter: Record<string, unknown>;
    fields: string[] | null;
    validation: Record<string, unknown> | null;
  }>;
}

describe('who may assign which roles', () => {
  it('the shared map and the extension copy are identical', () => {
    expect(extensionMap()).toEqual(ROLE_ASSIGNABLE_ROLES);
  });

  /* Owner, 26 Nov 2026: on 25 Nov a supervisor promoted an agent to WeCare
     Supervisor. Supervisors may now give the WeCare Agent role ONLY. */
  it('a WeCare Supervisor may assign WeCare Agent ONLY, never WeCare Supervisor', () => {
    expect(
      assignableRoleNames('WeCare Supervisor', { manage_users: true, manage_roles: false }),
    ).toEqual(['wecare agent']);
  });

  it('a role with manage_roles is not fenced (WeCare Admin, Department Manager)', () => {
    expect(
      assignableRoleNames('WeCare Admin', { manage_users: true, manage_roles: true }),
    ).toBeNull();
    expect(
      assignableRoleNames('Department Manager', { manage_users: true, manage_roles: true }),
    ).toBeNull();
  });

  it('a role that does not manage users is not fenced', () => {
    expect(assignableRoleNames('WeCare Agent', { manage_users: false })).toBeNull();
  });

  it('an unlisted user-managing role keeps only its own role (what its page offered)', () => {
    expect(assignableRoleNames('Some Manager', { manage_users: true })).toEqual(['some manager']);
  });
});

describe('the grants a WeCare Supervisor gets', () => {
  const buildGrants = extensionBuildGrants();
  const PROTECTED = ['admin-role', 'svc-role'];
  const ASSIGNABLE = ['agent-role', 'supervisor-role'];
  const grants = buildGrants({ manage_users: true }, null, null, PROTECTED, ASSIGNABLE);
  const isSelf = (x: { filter: Record<string, unknown> }) =>
    JSON.stringify(x.filter) === '{"id":{"_eq":"$CURRENT_USER"}}';
  /** The MANAGE grant (the own-profile grant is checked on its own below). */
  const users = (action: string) =>
    grants.find((x) => x.collection === 'directus_users' && x.action === action && !isSelf(x))!;

  it('can read exactly the roles it may assign, id and name only', () => {
    const roles = grants.filter((x) => x.collection === 'directus_roles');
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({
      action: 'read',
      filter: { id: { _in: ASSIGNABLE } },
      fields: ['id', 'name'],
    });
  });

  it('creates users only in those roles, and never in a protected role', () => {
    const v = JSON.stringify(users('create').validation);
    expect(v).toContain('"_nin":["admin-role","svc-role"]');
    expect(v).toContain('"_in":["agent-role","supervisor-role"]');
    expect(v).toContain('"_null":true');
  });

  it('edits only users in those roles (never a WeCare Admin), and never into a protected role', () => {
    const f = JSON.stringify(users('update').filter);
    expect(f).toContain('"_in":["agent-role","supervisor-role"]');
    expect(f).toContain('"_nin":["admin-role","svc-role"]');
    const v = JSON.stringify(users('update').validation);
    expect(v).toContain('"_in":["agent-role","supervisor-role"]');
  });

  /* Staging, 26 Nov 2026: once a supervisor could no longer give out the
     Supervisor role, the fence also wrapped the own-profile grant and every
     supervisor lost their own notification preferences. */
  it('still edits their OWN profile - four fields, never the role - outside the fence', () => {
    for (const assignable of [ASSIGNABLE, ['agent-role'], null]) {
      const self = buildGrants({ manage_users: true }, null, null, PROTECTED, assignable).filter(
        (x) => x.collection === 'directus_users' && x.action === 'update' && isSelf(x),
      );
      expect(self).toHaveLength(1);
      expect(self[0]!.filter).toEqual({ id: { _eq: '$CURRENT_USER' } });
      expect(self[0]!.validation).toBeNull();
      expect(self[0]!.fields).toEqual([
        'notification_preferences',
        'locale',
        'first_name',
        'last_name',
      ]);
      expect(self[0]!.fields).not.toContain('role');
    }
  });

  it('reads every user as before (the list is unchanged)', () => {
    expect(users('read').filter).toEqual({});
  });

  it('a role that is not fenced gets exactly what it got before', () => {
    const before = buildGrants({ manage_users: true }, null, null, PROTECTED, null);
    expect(before.some((x) => x.collection === 'directus_roles')).toBe(false);
    expect(
      before.find((x) => x.collection === 'directus_users' && x.action === 'create')!.validation,
    ).toEqual({ role: { _nin: PROTECTED } });
  });
});
