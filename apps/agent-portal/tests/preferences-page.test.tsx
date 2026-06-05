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

const hooks = vi.hoisted(() => ({
  useNotificationPreferences: vi.fn(),
  useUpdateNotificationPreferences: vi.fn(),
  // Real channel list mirrored so the Select options render.
  CHANNELS: ['in_app', 'email', 'both', 'none'],
}));
vi.mock('../src/features/notifications/api.js', () => hooks);

import { PreferencesPage } from '../src/features/notifications/PreferencesPage.js';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<PreferencesPage />, { wrapper: Wrapper });
}

beforeEach(() => {
  hooks.useNotificationPreferences.mockReset();
  hooks.useUpdateNotificationPreferences.mockReset();
  hooks.useUpdateNotificationPreferences.mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue({}),
    isPending: false,
  });
});

describe('PreferencesPage', () => {
  it('shows a spinner while preferences load', () => {
    hooks.useNotificationPreferences.mockReturnValue({ data: undefined, isLoading: true });
    renderPage();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders preference groups with channel selects', () => {
    hooks.useNotificationPreferences.mockReturnValue({
      data: { sla_warning: 'email', assignment: 'both', mention: 'none', automation: 'in_app' },
      isLoading: false,
    });
    renderPage();
    expect(screen.getByText('SLA')).toBeInTheDocument();
    expect(screen.getByText('Tickets')).toBeInTheDocument();
    // Each notification type renders a labelled select.
    expect(screen.getByLabelText('sla_warning')).toBeInTheDocument();
    expect(screen.getByLabelText('assignment')).toBeInTheDocument();
  });

  it('saves the draft when Save is clicked', async () => {
    const mutateAsync = vi.fn().mockResolvedValue({});
    hooks.useUpdateNotificationPreferences.mockReturnValue({ mutateAsync, isPending: false });
    hooks.useNotificationPreferences.mockReturnValue({
      data: { sla_warning: 'email' },
      isLoading: false,
    });
    renderPage();
    await userEvent.click(screen.getByText('actions.save'));
    expect(mutateAsync).toHaveBeenCalled();
  });
});
