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
    await userEvent.click(screen.getAllByText('sla.create')[0]!);
    expect(screen.getByText('sla.name')).toBeInTheDocument();
  });

  it('says what a policy covers, in full', async () => {
    request.mockResolvedValueOnce([
      {
        id: 's2',
        name: 'Roach, Herfy',
        description: null,
        applies_to_priority: ['urgent'],
        applies_to_type: ['Roach found'],
        applies_to_brand: ['Herfy'],
        first_response_minutes: 5,
        resolution_minutes: 60,
        warning_threshold_percent: 50,
        business_hours: null,
        active: true,
      },
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText('Roach, Herfy')).toBeInTheDocument());
    expect(screen.getByText('Roach found')).toBeInTheDocument();
    expect(screen.getByText('Herfy')).toBeInTheDocument();
    // No working hours set means the clock never stops, and the card says so
    // rather than leaving the reader to assume office hours.
    expect(screen.getAllByText(/Round the clock/).length).toBeGreaterThan(0);
  });

  /*
   * The failure this whole feature suffered from: a policy that is switched on,
   * listed, and governs nothing. It rendered identically to a working one, so
   * five of them sat inert in the compensation clone without anybody noticing.
   */
  it('calls out an active policy that covers no tickets', async () => {
    request.mockResolvedValueOnce([
      {
        id: 's3',
        name: 'Inert',
        description: null,
        applies_to_priority: null,
        applies_to_type: null,
        applies_to_source: null,
        applies_to_brand: null,
        first_response_minutes: 30,
        resolution_minutes: 240,
        warning_threshold_percent: 80,
        business_hours: null,
        active: true,
      },
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText('Inert')).toBeInTheDocument());
    expect(screen.getByText(/Covers no tickets/)).toBeInTheDocument();
    expect(screen.getByText(/active policy covers no tickets/)).toBeInTheDocument();
  });

  it('reads working hours back as one line', async () => {
    request.mockResolvedValueOnce([
      {
        id: 's4',
        name: 'Office',
        description: null,
        applies_to_priority: ['medium'],
        applies_to_type: null,
        applies_to_source: null,
        applies_to_brand: null,
        first_response_minutes: 30,
        resolution_minutes: 240,
        warning_threshold_percent: 80,
        business_hours: {
          timezone: 'Asia/Riyadh',
          days: Object.fromEntries([0, 1, 2, 3, 4].map((d) => [String(d), [['09:00', '17:00']]])),
        },
        active: true,
      },
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText('Office')).toBeInTheDocument());
    expect(screen.getAllByText(/Sun-Thu 09:00-17:00/).length).toBeGreaterThan(0);
    // The zone is part of the promise: 09:00 is a different instant in Riyadh.
    expect(screen.getAllByText(/Asia\/Riyadh/).length).toBeGreaterThan(0);
  });
});
