import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isUserAdminBlocked } from '../src/role-assignment.js';

/**
 * THE PER-PERSON BLOCK ON MANAGING USERS (owner, 26 Nov 2026).
 *
 * On 25 Nov a WeCare Supervisor promoted an agent to WeCare Supervisor. The
 * owner asked to block that ONE person from managing users for 10 days without
 * touching the role colleagues share. These tests load the real app-roles-sync
 * extension with fake Directus hooks and call the user hooks it registers.
 */

const BLOCKED = 'user-mohamed';
const FREE = 'user-nada';
const FUTURE = new Date(Date.now() + 10 * 86_400_000).toISOString();
const PAST = new Date(Date.now() - 86_400_000).toISOString();

type Hook = (payload: unknown, meta: unknown, context: unknown) => Promise<unknown>;
const filters = new Map<string, Hook>();
let blockedUntil: Record<string, string | null> = {};
let columnMissing = false;

function fakeDatabase(table: string) {
  return {
    where(q: { id: string }) {
      return {
        async first(field: string) {
          if (table !== 'directus_users') return undefined;
          if (columnMissing) throw new Error(`column "${field}" does not exist`);
          const v = blockedUntil[q.id];
          return v === undefined ? undefined : { [field]: v };
        },
      };
    },
  };
}

beforeAll(async () => {
  const path = fileURLToPath(
    new URL('../../../directus/extensions/app-roles-sync/index.js', import.meta.url),
  );
  const mod = (await import(pathToFileURL(path).href)) as {
    default: (hooks: unknown, ctx: unknown) => void;
  };
  mod.default(
    {
      filter: (event: string, fn: Hook) => filters.set(event, fn),
      action: () => {},
    },
    {
      services: { RolesService: class {}, PoliciesService: class {}, PermissionsService: class {} },
      database: fakeDatabase,
      getSchema: async () => ({}),
      logger: { info: () => {}, warn: () => {} },
    },
  );
});

const as = (user: string | null, admin = false) => ({
  accountability: user ? { user, admin } : null,
});
const run = (event: string, payload: unknown, meta: unknown, ctx: unknown) =>
  filters.get(event)!(payload, meta, ctx);

describe('isUserAdminBlocked', () => {
  it('is blocked only while the date is in the future', () => {
    expect(isUserAdminBlocked(FUTURE)).toBe(true);
    expect(isUserAdminBlocked(PAST)).toBe(false);
    expect(isUserAdminBlocked(null)).toBe(false);
    expect(isUserAdminBlocked('not a date')).toBe(false);
  });
});

describe('the server refuses a blocked person, and only them', () => {
  beforeAll(() => {
    blockedUntil = { [BLOCKED]: FUTURE, [FREE]: null };
  });

  it('registers the three user hooks', () => {
    for (const e of ['users.create', 'users.update', 'users.delete'])
      expect(filters.has(e)).toBe(true);
  });

  it('a blocked person cannot CREATE a user, and is told until when', async () => {
    await expect(run('users.create', { role: 'agent' }, {}, as(BLOCKED))).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining(FUTURE.slice(0, 10)),
    });
  });

  it('a blocked person cannot EDIT or DELETE someone else', async () => {
    await expect(
      run('users.update', { role: 'x' }, { keys: [FREE] }, as(BLOCKED)),
    ).rejects.toMatchObject({ status: 403 });
    await expect(run('users.delete', [FREE], {}, as(BLOCKED))).rejects.toMatchObject({
      status: 403,
    });
  });

  it('a blocked person can still edit their OWN profile', async () => {
    await expect(
      run('users.update', { first_name: 'M' }, { keys: [BLOCKED] }, as(BLOCKED)),
    ).resolves.toBeTruthy();
  });

  it('a colleague in the same role is not affected', async () => {
    await expect(run('users.create', { role: 'agent' }, {}, as(FREE))).resolves.toBeTruthy();
  });

  it('a block whose date has passed lifts by itself', async () => {
    blockedUntil[BLOCKED] = PAST;
    await expect(run('users.create', { role: 'agent' }, {}, as(BLOCKED))).resolves.toBeTruthy();
    blockedUntil[BLOCKED] = FUTURE;
  });

  it('the Administrator and internal calls are never blocked', async () => {
    blockedUntil['user-admin'] = FUTURE;
    await expect(run('users.create', {}, {}, as('user-admin', true))).resolves.toBeTruthy();
    await expect(run('users.create', {}, {}, as(null))).resolves.toBeTruthy();
  });

  it('only the Administrator can set the block - anyone else has it stripped', async () => {
    const byOther = (await run(
      'users.update',
      { user_admin_blocked_until: null },
      { keys: [BLOCKED] },
      as(BLOCKED),
    )) as Record<string, unknown>;
    expect(byOther).not.toHaveProperty('user_admin_blocked_until');
    const byAdmin = (await run(
      'users.update',
      { user_admin_blocked_until: FUTURE },
      { keys: [BLOCKED] },
      as('user-admin', true),
    )) as Record<string, unknown>;
    expect(byAdmin.user_admin_blocked_until).toBe(FUTURE);
  });

  it('a database without the column yet blocks nobody', async () => {
    columnMissing = true;
    await expect(run('users.create', {}, {}, as(BLOCKED))).resolves.toBeTruthy();
    columnMissing = false;
  });
});
