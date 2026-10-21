import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { TFunction } from 'i18next';
import type { AuthUser } from '@yiji/shared-config';

/**
 * REPORTS -> ADMIN KPI is the OWNER's (owner, 2026-10-21): the nav entry is
 * hidden from everyone else and the route refuses them - even a role that
 * holds every privilege, because owner-only is not a privilege.
 */

const useAuthMock = vi.fn();
vi.mock('../src/lib/auth/AuthContext.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/auth/AuthContext.js')>();
  return { ...actual, useAuth: () => useAuthMock() };
});

import { navItemAllowed } from '../src/nav.js';
import { ADMIN_KPI_PATH, AdminKpiGate, adminKpiNavItem } from '../src/features/admin-kpi/route.js';

const t = ((_k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? _k) as TFunction;

const user: AuthUser = {
  id: '1',
  email: 'a@b.com',
  login_name: null,
  first_name: null,
  last_name: null,
  status: 'active',
  admin_access: false,
  team: null,
  role: { id: 'r3', name: 'Admin' },
};

function renderRoute() {
  return render(
    <MemoryRouter initialEntries={[ADMIN_KPI_PATH]}>
      <Routes>
        <Route
          path={ADMIN_KPI_PATH}
          element={
            <AdminKpiGate>
              <div>admin kpi page</div>
            </AdminKpiGate>
          }
        />
        <Route path="/login" element={<div>login page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Admin KPI nav entry', () => {
  const item = adminKpiNavItem(t);

  it('is owner-only, under Reports', () => {
    expect(item.to).toBe('/reports/admin-kpi');
    expect(item.ownerOnly).toBe(true);
    expect(item.label).toBe('Admin KPI');
  });

  it('is hidden from a role that holds EVERY privilege but is not the owner', () => {
    expect(navItemAllowed(item, { can: () => true, isOwner: false })).toBe(false);
  });

  it('is shown to the owner', () => {
    expect(navItemAllowed(item, { can: () => true, isOwner: true })).toBe(true);
  });

  it('leaves the other items to their privileges, as before', () => {
    expect(
      navItemAllowed({ requires: 'view_all_tickets' }, { can: () => false, isOwner: false }),
    ).toBe(false);
    expect(
      navItemAllowed({ requires: 'view_all_tickets' }, { can: () => true, isOwner: false }),
    ).toBe(true);
    expect(
      navItemAllowed(
        { requiresAny: ['view_all_tickets', 'manage_users'] },
        { can: (p) => p === 'manage_users', isOwner: false },
      ),
    ).toBe(true);
  });
});

describe('Admin KPI route', () => {
  beforeEach(() => useAuthMock.mockReset());

  it('refuses a non-owner even with every privilege (a bookmark is not a back door)', () => {
    useAuthMock.mockReturnValue({
      user,
      loading: false,
      canUsePortal: true,
      can: () => true,
      isOwner: false,
    });
    renderRoute();
    expect(screen.queryByText('admin kpi page')).not.toBeInTheDocument();
    expect(screen.getByText(/only the project owner can open this page/i)).toBeInTheDocument();
  });

  it('opens for the owner', () => {
    useAuthMock.mockReturnValue({
      user: { ...user, admin_access: true, role: { id: 'r2', name: 'Administrator' } },
      loading: false,
      canUsePortal: true,
      can: () => true,
      isOwner: true,
    });
    renderRoute();
    expect(screen.getByText('admin kpi page')).toBeInTheDocument();
  });

  it('sends a signed-out visitor to login', () => {
    useAuthMock.mockReturnValue({
      user: null,
      loading: false,
      canUsePortal: false,
      can: () => false,
      isOwner: false,
    });
    renderRoute();
    expect(screen.getByText('login page')).toBeInTheDocument();
  });
});
