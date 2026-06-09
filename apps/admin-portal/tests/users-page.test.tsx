import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
  }),
}));

const usersApi = vi.hoisted(() => ({
  useUsers: vi.fn(),
  useRoles: vi.fn(),
  useCreateUser: vi.fn(),
  useUpdateUser: vi.fn(),
  useDeleteUser: vi.fn(),
}));
vi.mock('../src/features/users/api.js', () => usersApi);
vi.mock('../src/features/teams/api.js', () => ({
  useTeams: () => ({ data: [{ id: 't1', name: 'Sales' }] }),
}));
// UsersPage reads the current user (to guard self/owner deletion).
vi.mock('../src/lib/auth/AuthContext.js', () => ({
  useAuth: () => ({ user: { id: 'me', email: 'me@b.com', role: { name: 'Administrator' } } }),
}));

import { UsersPage } from '../src/features/users/UsersPage.js';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<UsersPage />, { wrapper: Wrapper });
}

beforeEach(() => {
  usersApi.useRoles.mockReturnValue({ data: [{ id: 'r1', name: 'Administrator' }] });
  usersApi.useCreateUser.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}) });
  usersApi.useUpdateUser.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}) });
  usersApi.useDeleteUser.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}) });
});

describe('UsersPage', () => {
  it('shows empty state when there are no users', () => {
    usersApi.useUsers.mockReturnValue({ data: [], isLoading: false });
    renderPage();
    expect(screen.getByText('users.empty')).toBeInTheDocument();
  });

  it('renders user cards with data', () => {
    usersApi.useUsers.mockReturnValue({
      data: [
        {
          id: 'u1',
          email: 'a@b.com',
          first_name: 'Ann',
          last_name: 'Lee',
          status: 'active',
          role: { id: 'r1', name: 'Administrator' },
          team: { id: 't1', name: 'Sales' },
        },
      ],
      isLoading: false,
    });
    renderPage();
    expect(screen.getByText('Ann Lee')).toBeInTheDocument();
  });

  it('opens the create drawer on button click', async () => {
    usersApi.useUsers.mockReturnValue({ data: [], isLoading: false });
    renderPage();
    await userEvent.click(screen.getAllByText('users.create')[0]!);
    expect(screen.getByText('users.email')).toBeInTheDocument();
  });
});
