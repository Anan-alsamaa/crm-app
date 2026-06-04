import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
  }),
}));

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request } }));

import { SlaPoliciesPage } from '../src/features/sla/SlaPoliciesPage.js';

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<SlaPoliciesPage />, { wrapper: Wrapper });
}

beforeEach(() => request.mockReset());

describe('SlaPoliciesPage', () => {
  it('shows empty state when there are no policies', async () => {
    request.mockResolvedValueOnce([]);
    renderPage();
    await waitFor(() => expect(screen.getByText('sla.empty')).toBeInTheDocument());
  });

  it('renders a policy card with its deadlines', async () => {
    request.mockResolvedValueOnce([
      {
        id: 's1',
        name: 'Gold',
        description: 'Premium SLA',
        applies_to_priority: ['high', 'urgent'],
        first_response_minutes: 15,
        resolution_minutes: 120,
        warning_threshold_percent: 75,
        active: true,
      },
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText('Gold')).toBeInTheDocument());
    expect(screen.getByText('Premium SLA')).toBeInTheDocument();
    // resolution deadline (120m) only appears on the card, not in the toolbar stats
    expect(screen.getByText((_c, el) => el?.textContent === '120m')).toBeInTheDocument();
    expect(screen.getByText((_c, el) => el?.textContent === '75%')).toBeInTheDocument();
  });

  it('opens the create drawer', async () => {
    request.mockResolvedValueOnce([]);
    renderPage();
    await waitFor(() => expect(screen.getByText('sla.empty')).toBeInTheDocument());
    await userEvent.click(screen.getAllByText('sla.create')[0]);
    expect(screen.getByText('sla.name')).toBeInTheDocument();
  });
});
