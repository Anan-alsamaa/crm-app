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
  first_name: null,
  last_name: null,
  status: 'active',
  role: { id: 'r1', name: 'Agent' },
};

describe('ProtectedRoute (agent portal permission guard)', () => {
  beforeEach(() => useAuthMock.mockReset());

  it('redirects to /login when unauthenticated', () => {
    useAuthMock.mockReturnValue({ user: null, loading: false });
    renderGuard();
    expect(screen.getByText('login page')).toBeInTheDocument();
  });

  it('renders children for an Agent', () => {
    useAuthMock.mockReturnValue({ user: agent, loading: false });
    renderGuard();
    expect(screen.getByText('inbox')).toBeInTheDocument();
  });

  it('blocks a role outside the allowed set', () => {
    useAuthMock.mockReturnValue({
      user: { ...agent, role: { id: 'r9', name: 'svc-workers' } },
      loading: false,
    });
    renderGuard();
    expect(screen.queryByText('inbox')).not.toBeInTheDocument();
  });

  it('shows a spinner while loading', () => {
    useAuthMock.mockReturnValue({ user: null, loading: true });
    renderGuard();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
