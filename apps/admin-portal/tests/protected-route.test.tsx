import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { AuthUser } from '@yiji/shared-config';

// Mock the auth context so we can drive the guard with different roles. The
// real ProtectedRoute calls isAdmin(user) (AuthContext.tsx) which only admits
// the Administrator/Admin role names — this is the admin portal's UI-level RBAC.
const useAuthMock = vi.fn();
vi.mock('../src/lib/auth/AuthContext.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/auth/AuthContext.js')>();
  return { ...actual, useAuth: () => useAuthMock() };
});

import { ProtectedRoute } from '../src/lib/auth/ProtectedRoute.js';

function renderGuard() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <div>admin dashboard</div>
            </ProtectedRoute>
          }
        />
        <Route path="/login" element={<div>login page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const base: Omit<AuthUser, 'role'> = {
  id: '1',
  email: 'a@b.com',
  first_name: null,
  last_name: null,
  status: 'active',
  admin_access: false,
};

const agent: AuthUser = { ...base, role: { id: 'r1', name: 'Agent' } };
const administrator: AuthUser = { ...base, role: { id: 'r2', name: 'Administrator' } };
const admin: AuthUser = { ...base, role: { id: 'r3', name: 'Admin' } };
// Admin via Directus admin_access policy, on a non-"Administrator" role name.
const policyAdmin: AuthUser = { ...base, admin_access: true, role: { id: 'r4', name: 'Owner' } };

const DENIED = /does not have administrator access/i;

describe('ProtectedRoute (admin portal role-based access control)', () => {
  beforeEach(() => useAuthMock.mockReset());

  it('redirects to /login when unauthenticated', () => {
    useAuthMock.mockReturnValue({ user: null, loading: false });
    renderGuard();
    expect(screen.getByText('login page')).toBeInTheDocument();
    expect(screen.queryByText('admin dashboard')).not.toBeInTheDocument();
  });

  it('denies an authenticated Agent (non-admin role) the admin capability', () => {
    useAuthMock.mockReturnValue({ user: agent, loading: false });
    renderGuard();
    // The Agent is signed in but must NOT see admin content; instead the
    // role-denial message is shown.
    expect(screen.queryByText('admin dashboard')).not.toBeInTheDocument();
    expect(screen.getByText(DENIED)).toBeInTheDocument();
  });

  it('grants access to an Administrator role', () => {
    useAuthMock.mockReturnValue({ user: administrator, loading: false });
    renderGuard();
    expect(screen.getByText('admin dashboard')).toBeInTheDocument();
    expect(screen.queryByText(DENIED)).not.toBeInTheDocument();
  });

  it('grants access to an Admin role', () => {
    useAuthMock.mockReturnValue({ user: admin, loading: false });
    renderGuard();
    expect(screen.getByText('admin dashboard')).toBeInTheDocument();
  });

  it('grants access via admin_access even when the role is not named Administrator', () => {
    useAuthMock.mockReturnValue({ user: policyAdmin, loading: false });
    renderGuard();
    expect(screen.getByText('admin dashboard')).toBeInTheDocument();
    expect(screen.queryByText(DENIED)).not.toBeInTheDocument();
  });

  it('denies an unrecognized service role', () => {
    useAuthMock.mockReturnValue({
      user: { ...base, role: { id: 'r9', name: 'svc-workers' } },
      loading: false,
    });
    renderGuard();
    expect(screen.queryByText('admin dashboard')).not.toBeInTheDocument();
    expect(screen.getByText(DENIED)).toBeInTheDocument();
  });

  it('shows a spinner while the session is still loading', () => {
    useAuthMock.mockReturnValue({ user: null, loading: true });
    renderGuard();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByText('admin dashboard')).not.toBeInTheDocument();
  });
});
