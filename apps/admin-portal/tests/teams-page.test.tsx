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

const teamsApi = vi.hoisted(() => ({
  useTeams: vi.fn(),
  useCreateTeam: vi.fn(),
}));
vi.mock('../src/features/teams/api.js', () => teamsApi);
vi.mock('../src/features/users/api.js', () => ({
  useUsers: () => ({ data: [{ id: 'u1', team: { id: 't1' } }] }),
}));

import { TeamsPage } from '../src/features/teams/TeamsPage.js';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<TeamsPage />, { wrapper: Wrapper });
}

beforeEach(() => {
  teamsApi.useCreateTeam.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}) });
});

describe('TeamsPage', () => {
  it('shows empty state with no teams', () => {
    teamsApi.useTeams.mockReturnValue({ data: [], isLoading: false });
    renderPage();
    expect(screen.getByText('teams.empty')).toBeInTheDocument();
  });

  it('renders team cards', () => {
    teamsApi.useTeams.mockReturnValue({
      data: [{ id: 't1', name: 'Sales', description: 'Sells things' }],
      isLoading: false,
    });
    renderPage();
    expect(screen.getByText('Sales')).toBeInTheDocument();
    expect(screen.getByText('Sells things')).toBeInTheDocument();
  });

  it('opens the create drawer', async () => {
    teamsApi.useTeams.mockReturnValue({ data: [], isLoading: false });
    renderPage();
    await userEvent.click(screen.getAllByText('teams.create')[0]);
    expect(screen.getByText('teams.name')).toBeInTheDocument();
  });
});
