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

const api = vi.hoisted(() => ({
  useAutomationRules: vi.fn(),
  useCreateRule: vi.fn(),
  useUpdateRule: vi.fn(),
  useDeleteRule: vi.fn(),
}));
vi.mock('../src/features/automation/api.js', () => api);

import { AutomationPage } from '../src/features/automation/AutomationPage.js';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<AutomationPage />, { wrapper: Wrapper });
}

beforeEach(() => {
  api.useCreateRule.mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue({}),
    isPending: false,
  });
  api.useUpdateRule.mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue({}),
    isPending: false,
  });
  api.useDeleteRule.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}) });
});

describe('AutomationPage', () => {
  it('shows empty state when no rules', () => {
    api.useAutomationRules.mockReturnValue({ data: [], isLoading: false });
    renderPage();
    expect(screen.getByText('No automation rules yet.')).toBeInTheDocument();
  });

  it('renders a rule card', () => {
    api.useAutomationRules.mockReturnValue({
      data: [
        {
          id: 'a1',
          name: 'Auto assign',
          description: 'desc',
          trigger_event: 'message_received',
          conditions: [],
          actions: [],
          active: true,
          priority: 5,
          last_triggered_at: null,
          trigger_count: 0,
        },
      ],
      isLoading: false,
    });
    renderPage();
    expect(screen.getByText('Auto assign')).toBeInTheDocument();
    expect(screen.getByText('message_received')).toBeInTheDocument();
  });

  it('opens the create drawer', async () => {
    api.useAutomationRules.mockReturnValue({ data: [], isLoading: false });
    renderPage();
    await userEvent.click(screen.getAllByText('New rule')[0]!);
    expect(screen.getByText('Trigger')).toBeInTheDocument();
  });
});
