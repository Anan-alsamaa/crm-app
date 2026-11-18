import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

/**
 * THE ROLE PICKER OFFERS WHAT THE CALLER MAY ASSIGN (owner, 2026-11-18).
 *
 * A WeCare Supervisor reads (from Directus) only WeCare Agent and WeCare
 * Supervisor, so those are the choices. Editing someone whose role is outside
 * that set - a WeCare Admin, whose role comes back unreadable - shows the role
 * read-only, and the save never sends `role`.
 */
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
vi.mock('../src/features/teams/api.js', () => ({ useTeams: () => ({ data: [] }) }));
const held = vi.hoisted(() => ({ privileges: {} as Record<string, boolean> }));
vi.mock('../src/lib/auth/AuthContext.js', () => ({
  useAuth: () => ({
    user: { id: 'me', email: 'nada@b.com', role: { name: 'WeCare Supervisor' } },
    can: (p: string) => held.privileges[p] === true,
  }),
}));

import { UsersPage } from '../src/features/users/UsersPage.js';

const AGENT = { id: 'r-wa', name: 'WeCare Agent' };
const SUPERVISOR = { id: 'r-ws', name: 'WeCare Supervisor' };
const ADMIN = { id: 'r-wadmin', name: 'WeCare Admin' };

const person = (id: string, first: string, role: { id: string; name: string } | null) => ({
  id,
  email: `${id}@staff.example.com`,
  login_name: id,
  contact_email: null,
  first_name: first,
  last_name: null,
  status: 'active',
  role,
  team: null,
});

let update: ReturnType<typeof vi.fn>;

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<UsersPage />, { wrapper: Wrapper });
}

const roleChoices = async () => {
  await userEvent.click(screen.getByRole('combobox', { name: 'users.role' }));
  return within(screen.getByRole('listbox'))
    .getAllByRole('option')
    .map((o) => o.textContent?.trim());
};

beforeEach(() => {
  // jsdom has no layout; the menu scrolls its active option into view.
  Element.prototype.scrollIntoView = vi.fn();
  held.privileges = { manage_users: true };
  update = vi.fn().mockResolvedValue({});
  usersApi.useUsers.mockReturnValue({
    data: [person('a1', 'Agnes', AGENT), person('w1', 'Wafa', null)],
    isLoading: false,
  });
  // What Directus returns to a WeCare Supervisor after app-roles-sync.
  usersApi.useRoles.mockReturnValue({ data: [AGENT, SUPERVISOR] });
  usersApi.useCreateUser.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}) });
  usersApi.useUpdateUser.mockReturnValue({ mutateAsync: update });
  usersApi.useDeleteUser.mockReturnValue({ mutateAsync: vi.fn() });
});

describe('Users page role picker', () => {
  it('a WeCare Supervisor creating a user is offered WeCare Agent and WeCare Supervisor', async () => {
    renderPage();
    await userEvent.click(screen.getAllByText('users.create')[0]!);
    expect(await roleChoices()).toEqual(['WeCare Agent', 'WeCare Supervisor']);
  });

  it('editing someone in scope keeps the picker, and the save sends the role', async () => {
    renderPage();
    await userEvent.click(screen.getByText('Agnes'));
    expect(screen.queryByTestId('role-locked')).toBeNull();
    expect(await roleChoices()).toEqual(['WeCare Agent', 'WeCare Supervisor']);
    await userEvent.click(
      within(screen.getByRole('option', { name: 'WeCare Supervisor' })).getByRole('button'),
    );
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0]![0].patch.role).toBe('r-ws');
  });

  it('editing someone whose role is outside the set shows it read-only and never sends it', async () => {
    renderPage();
    await userEvent.click(screen.getByText('Wafa'));
    expect(screen.getByTestId('role-locked')).toBeInTheDocument();
    expect(screen.getByText("You can't change this person's role.")).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'users.role' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0]![0].patch).not.toHaveProperty('role');
  });

  it('a visible role that is not offered is read-only too, shown by name', async () => {
    usersApi.useUsers.mockReturnValue({
      data: [person('x1', 'Xena', ADMIN)],
      isLoading: false,
    });
    renderPage();
    await userEvent.click(screen.getByText('Xena'));
    expect(screen.getByTestId('role-locked')).toBeInTheDocument();
    expect(screen.getByDisplayValue('WeCare Admin')).toBeInTheDocument();
  });

  it('a manage_roles holder sees every role and can give a role-less person one', async () => {
    held.privileges = { manage_users: true, manage_roles: true };
    usersApi.useRoles.mockReturnValue({ data: [AGENT, SUPERVISOR, ADMIN] });
    renderPage();
    await userEvent.click(screen.getByText('Wafa'));
    expect(screen.queryByTestId('role-locked')).toBeNull();
    expect(await roleChoices()).toEqual(['WeCare Agent', 'WeCare Supervisor', 'WeCare Admin']);
  });
});
