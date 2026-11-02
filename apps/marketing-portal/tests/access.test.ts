import { describe, expect, it } from 'vitest';
import type { AuthUser } from '@yiji/shared-config';
import { effectivePrivileges, opensPortal } from '@yiji/shared-types';
import { hasPortalAccess } from '../src/lib/auth/AuthContext.js';
import { marketingSections } from '../src/App.js';
import { navItemAllowed } from '../src/nav.js';

const user = (roleName: string, admin = false) =>
  ({
    id: 'u1',
    email: 'x@y.z',
    admin_access: admin,
    role: { id: 'r1', name: roleName },
  }) as unknown as AuthUser;
const t = (_k: string, o: { defaultValue: string }) => o.defaultValue;

describe('the Marketing portal door', () => {
  it('stays shut for every existing role: the marketing switches default to off', () => {
    for (const role of ['WeCare Agent', 'WeCare Supervisor', 'WeCare Admin', 'CEO', 'TV Screen']) {
      const p = effectivePrivileges({ use_chat: true, view_all_tickets: true }, role);
      expect(p.use_marketing_portal, role).toBe(false);
      expect(hasPortalAccess(user(role), p), role).toBe(false);
    }
  });

  it('opens for a role the owner ticked, and only this portal', () => {
    const p = effectivePrivileges({ use_marketing_portal: true }, 'Marketing User');
    expect(hasPortalAccess(user('Marketing User'), p)).toBe(true);
    expect(opensPortal(p, 'marketing')).toBe(true);
    expect(opensPortal(p, 'admin')).toBe(false);
    expect(opensPortal(p, 'agent')).toBe(false);
  });

  it('lets the Administrator in', () => {
    expect(hasPortalAccess(user('Administrator', true), null)).toBe(true);
  });
});

describe('what each marketing role is offered', () => {
  const visible = (privs: Record<string, boolean>) =>
    marketingSections(t)
      .flatMap((s) => s.items)
      .filter((it) => navItemAllowed(it, { can: (k) => privs[k] === true, isOwner: false }))
      .map((it) => it.to);

  it('a viewer sees the overview and the log only', () => {
    expect(visible({ use_marketing_portal: true })).toEqual(['/overview', '/activity']);
  });

  it('a marketing user prepares work but cannot approve it', () => {
    const v = visible({ use_marketing_portal: true, manage_marketing: true });
    expect(v).toEqual(['/overview', '/coupons', '/bulk', '/campaigns', '/points', '/activity']);
    expect(v).not.toContain('/approvals');
  });

  it('a marketing manager also has the approval queue', () => {
    expect(
      visible({ use_marketing_portal: true, manage_marketing: true, approve_marketing: true }),
    ).toContain('/approvals');
  });
});
