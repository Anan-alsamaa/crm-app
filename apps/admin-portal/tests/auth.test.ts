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
};

describe('isAdmin (admin portal role guard)', () => {
  it('admits Administrator and Admin', () => {
    expect(isAdmin({ ...base, role: { id: 'r', name: 'Administrator' } })).toBe(true);
    expect(isAdmin({ ...base, role: { id: 'r', name: 'Admin' } })).toBe(true);
  });
  it('rejects Agent, service roles, and null', () => {
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
