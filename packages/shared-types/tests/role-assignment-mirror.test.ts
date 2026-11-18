import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ROLE_ASSIGNMENT, assignableRoleNames } from '../src/role-assignment.js';

/**
 * WHO MAY ASSIGN WHICH ROLE (owner, 2026-11-18) lives in two places: here, and
 * in the app-roles-sync extension, which turns it into Directus permissions.
 * A bare hook cannot import this package, so it carries a copy; these tests
 * fail the moment the copy drifts.
 */
const SYNC = readFileSync(
  fileURLToPath(new URL('../../../directus/extensions/app-roles-sync/index.js', import.meta.url)),
  'utf8',
);

function extensionMap(): Record<string, string[]> {
  const start = SYNC.indexOf('const ROLE_ASSIGNMENT = {');
  expect(start).toBeGreaterThan(0);
  const end = SYNC.indexOf('};', start) + 2;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${SYNC.slice(start, end)}; return ROLE_ASSIGNMENT;`)();
}

describe('ROLE_ASSIGNMENT: the extension agrees with shared-types', () => {
  it('is the same map', () => {
    expect(extensionMap()).toEqual(ROLE_ASSIGNMENT);
  });

  it('names roles lowercased and trimmed (they are compared case-insensitively)', () => {
    for (const [role, names] of Object.entries(ROLE_ASSIGNMENT)) {
      expect(role).toBe(role.trim().toLowerCase());
      for (const n of names) expect(n).toBe(n.trim().toLowerCase());
    }
  });
});

describe('assignableRoleNames', () => {
  it('a WeCare Supervisor may assign WeCare Agent and WeCare Supervisor - and nothing above', () => {
    const names = assignableRoleNames('WeCare Supervisor', false);
    expect(names).toEqual(['wecare agent', 'wecare supervisor']);
    expect(names).not.toContain('wecare admin');
    expect(names).not.toContain('administrator');
  });

  it('compares the role name case-insensitively', () => {
    expect(assignableRoleNames('  wecare SUPERVISOR ', false)).toEqual(
      assignableRoleNames('WeCare Supervisor', false),
    );
  });

  it('a manage_roles holder keeps "any non-protected role"', () => {
    expect(assignableRoleNames('WeCare Admin', true)).toBe('any');
    expect(assignableRoleNames('WeCare Supervisor', true)).toBe('any');
  });

  it('any other manage_users holder keeps its own role only', () => {
    expect(assignableRoleNames('Team Lead', false)).toEqual(['team lead']);
    expect(assignableRoleNames('', false)).toEqual([]);
  });
});
