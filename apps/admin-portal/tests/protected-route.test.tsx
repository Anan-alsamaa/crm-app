import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { AuthUser } from '@yiji/shared-config';

// Mock the auth context so the guard can be driven with different roles.
//
// The portal no longer admits administrators ONLY: it admits any role holding a
// privilege that unlocks a screen in here, and each route can additionally name
// the one privilege IT needs. So the guard is fed a `canUsePortal` (may this
// person be in here at all) and a `can` (may they have THIS page).
const useAuthMock = vi.fn();
vi.mock('../src/lib/auth/AuthContext.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/auth/AuthContext.js')>();
  return { ...actual, useAuth: () => useAuthMock() };
});

import { ProtectedRoute } from '../src/lib/auth/ProtectedRoute.js';

function renderGuard(requires?: 'manage_users') {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route
          path="/"
          element={
            <ProtectedRoute requires={requires}>
              <div>admin dashboard</div>
            </ProtectedRoute>
          }
        />
        <Route path="/login" element={<div>login page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** An admin: in the portal, and holding everything. */
const asAdmin = (user: AuthUser) => ({
  user,
  loading: false,
  canUsePortal: true,
  can: () => true,
});
/** Signed in, but no screen in this portal is open to them. */
const asOutsider = (user: AuthUser) => ({
  user,
  loading: false,
  canUsePortal: false,
  can: () => false,
});

const base: Omit<AuthUser, 'role'> = {
  id: '1',
  email: 'a@b.com',
  login_name: null,
  first_name: null,
  last_name: null,
  status: 'active',
  admin_access: false,
  team: null,
};

const agent: AuthUser = { ...base, role: { id: 'r1', name: 'Agent' } };
const administrator: AuthUser = { ...base, role: { id: 'r2', name: 'Administrator' } };
const admin: AuthUser = { ...base, role: { id: 'r3', name: 'Admin' } };
// Admin via Directus admin_access policy, on a non-"Administrator" role name.
const policyAdmin: AuthUser = { ...base, admin_access: true, role: { id: 'r4', name: 'Owner' } };

const NOT_FOR_YOU = /this portal is not for your role/i;
const NOT_THIS_PAGE = /do not have access to this page/i;

describe('ProtectedRoute (admin portal role-based access control)', () => {
  beforeEach(() => useAuthMock.mockReset());

  it('redirects to /login when unauthenticated', () => {
    useAuthMock.mockReturnValue({
      user: null,
      loading: false,
      canUsePortal: false,
      can: () => false,
    });
    renderGuard();
    expect(screen.getByText('login page')).toBeInTheDocument();
    expect(screen.queryByText('admin dashboard')).not.toBeInTheDocument();
  });

  it('turns away a role with no screen in this portal, and says which portal to use', () => {
    useAuthMock.mockReturnValue(asOutsider(agent));
    renderGuard();
    expect(screen.queryByText('admin dashboard')).not.toBeInTheDocument();
    // Not "wrong password" and not "administrator access required": the account
    // is fine, this is simply not its portal.
    expect(screen.getByText(NOT_FOR_YOU)).toBeInTheDocument();
  });

  it('grants access to an Administrator role', () => {
    useAuthMock.mockReturnValue(asAdmin(administrator));
    renderGuard();
    expect(screen.getByText('admin dashboard')).toBeInTheDocument();
    expect(screen.queryByText(NOT_FOR_YOU)).not.toBeInTheDocument();
  });

  it('grants access to an Admin role', () => {
    useAuthMock.mockReturnValue(asAdmin(admin));
    renderGuard();
    expect(screen.getByText('admin dashboard')).toBeInTheDocument();
  });

  it('grants access via admin_access even when the role is not named Administrator', () => {
    useAuthMock.mockReturnValue(asAdmin(policyAdmin));
    renderGuard();
    expect(screen.getByText('admin dashboard')).toBeInTheDocument();
  });

  it('denies an unrecognized service role', () => {
    useAuthMock.mockReturnValue(asOutsider({ ...base, role: { id: 'r9', name: 'svc-workers' } }));
    renderGuard();
    expect(screen.queryByText('admin dashboard')).not.toBeInTheDocument();
    expect(screen.getByText(NOT_FOR_YOU)).toBeInTheDocument();
  });

  it('lets a scoped role in, and still keeps it off a page it does not hold', () => {
    // An operations role belongs in the portal and does not belong in Users.
    // Hiding the menu item is not enough — a bookmark is not a closed door.
    useAuthMock.mockReturnValue({
      user: { ...base, role: { id: 'r5', name: 'Operations' } },
      loading: false,
      canUsePortal: true,
      can: (priv: string) => priv === 'view_all_tickets',
    });

    const allowed = renderGuard();
    expect(screen.getByText('admin dashboard')).toBeInTheDocument();
    allowed.unmount();

    renderGuard('manage_users');
    expect(screen.queryByText('admin dashboard')).not.toBeInTheDocument();
    expect(screen.getByText(NOT_THIS_PAGE)).toBeInTheDocument();
  });

  it('shows a spinner while the session is still loading', () => {
    useAuthMock.mockReturnValue({
      user: null,
      loading: true,
      canUsePortal: false,
      can: () => false,
    });
    renderGuard();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByText('admin dashboard')).not.toBeInTheDocument();
  });
});
