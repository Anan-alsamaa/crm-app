import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, o?: Record<string, unknown> & { defaultValue?: string }) =>
      String(o?.defaultValue ?? _k).replace(/\{\{(\w+)\}\}/g, (_, n) => String(o?.[n] ?? '')),
  }),
}));

import { CustomerReach } from '../src/features/dashboard/CustomerReach.js';

function renderCard(scoped?: { total: number; withYiji: number } | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<CustomerReach scoped={scoped ?? null} />, { wrapper: Wrapper });
}

beforeEach(() => request.mockReset());

/*
 * THE CARD FOLLOWS THE DASHBOARD'S FILTERS (owner, 2026-10-26).
 * With a filter applied it shows the customers behind the filtered tickets and
 * never asks for the whole customer base.
 */
describe('CustomerReach', () => {
  it('shows the filtered customers and says so', () => {
    renderCard({ total: 40, withYiji: 30 });
    expect(screen.getByText('of 40')).toBeInTheDocument();
    expect(
      screen.getByText('Customers behind the tickets matching these filters'),
    ).toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
  });

  it('counts the whole customer base when no filter is applied', async () => {
    request.mockResolvedValueOnce([{ count: 100 }]).mockResolvedValueOnce([{ count: 60 }]);
    renderCard(null);
    expect(await screen.findByText('of 100')).toBeInTheDocument();
    expect(screen.getByText('All customers — not the selected range')).toBeInTheDocument();
  });
});
