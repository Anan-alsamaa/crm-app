import { describe, it, expect } from 'vitest';
import type { AuthUser } from '@yiji/shared-config';
import { isAdmin } from '../src/lib/auth/AuthContext.js';
import { defaultNotificationPreferences } from '../src/features/users/api.js';
import { NotificationType } from '@yiji/shared-types';

const base: Omit<AuthUser, 'role'> = {
  id: '1',
  email: 'x@y.com',
  first_name: null,
  last_name: null,
  status: 'active',
  admin_access: false,
};

describe('isAdmin (admin portal admin guard)', () => {
  it('admits users with admin_access regardless of role name', () => {
    // Directus 11 admin signal — the role need not be literally "Administrator".
    expect(isAdmin({ ...base, admin_access: true, role: { id: 'r', name: 'Owner' } })).toBe(true);
    expect(isAdmin({ ...base, admin_access: true, role: null })).toBe(true);
  });
  it('admits Administrator and Admin by name (fallback)', () => {
    expect(isAdmin({ ...base, role: { id: 'r', name: 'Administrator' } })).toBe(true);
    expect(isAdmin({ ...base, role: { id: 'r', name: 'Admin' } })).toBe(true);
  });
  it('rejects non-admins (no admin_access, non-admin role) and null', () => {
    expect(isAdmin({ ...base, role: { id: 'r', name: 'Agent' } })).toBe(false);
    expect(isAdmin({ ...base, role: { id: 'r', name: 'svc-workers' } })).toBe(false);
    expect(isAdmin(null)).toBe(false);
  });
});

describe('defaultNotificationPreferences (T037)', () => {
  it('sets every notification type to a channel', () => {
    const prefs = defaultNotificationPreferences();
    expect(Object.keys(prefs).sort()).toEqual([...NotificationType.options].sort());
    expect(new Set(Object.values(prefs))).toEqual(new Set(['both']));
  });
});
