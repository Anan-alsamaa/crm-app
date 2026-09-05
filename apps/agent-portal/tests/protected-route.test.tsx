import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { AuthUser } from '@yiji/shared-config';

// Mock the auth context so we can drive the guard with different states.
const useAuthMock = vi.fn();
vi.mock('../src/lib/auth/AuthContext.js', () => ({ useAuth: () => useAuthMock() }));

import { ProtectedRoute } from '../src/lib/auth/ProtectedRoute.js';

function renderGuard() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <div>inbox</div>
            </ProtectedRoute>
          }
        />
        <Route path="/login" element={<div>login page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const agent: AuthUser = {
  id: '1',
  email: 'a@b.com',
  login_name: null,
  first_name: null,
  last_name: null,
  status: 'active',
  role: { id: 'r1', name: 'Agent' },
  admin_access: false,
  team: null,
};

describe('ProtectedRoute (agent portal permission guard)', () => {
  beforeEach(() => useAuthMock.mockReset());

  it('redirects to /login when unauthenticated', () => {
    useAuthMock.mockReturnValue({ user: null, loading: false });
    renderGuard();
    expect(screen.getByText('login page')).toBeInTheDocument();
  });

  // The guard reads PRIVILEGES now, not role names: `canUsePortal` says whether
  // this portal has anything for the role, `can` whether a page is open to it.
  it('renders children for a role whose privileges open this portal', () => {
    useAuthMock.mockReturnValue({
      user: agent,
      loading: false,
      canUsePortal: true,
      can: () => true,
      isOwner: false,
    });
    renderGuard();
    expect(screen.getByText('inbox')).toBeInTheDocument();
  });

  it('blocks a role whose privileges open nothing here (e.g. operations)', () => {
    useAuthMock.mockReturnValue({
      user: { ...agent, role: { id: 'r9', name: 'Operations' } },
      loading: false,
      canUsePortal: false,
      can: () => false,
      isOwner: false,
    });
    renderGuard();
    expect(screen.queryByText('inbox')).not.toBeInTheDocument();
  });

  it('blocks a page the role is admitted to the portal for but does not hold', () => {
    useAuthMock.mockReturnValue({
      user: agent,
      loading: false,
      canUsePortal: true,
      can: (p: string) => p === 'use_chat', // may chat, may not create tickets
      isOwner: false,
    });
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route
            path="/"
            element={
              <ProtectedRoute requires="create_tickets">
                <div>add ticket</div>
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.queryByText('add ticket')).not.toBeInTheDocument();
  });

  it('shows a spinner while loading', () => {
    useAuthMock.mockReturnValue({ user: null, loading: true });
    renderGuard();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
