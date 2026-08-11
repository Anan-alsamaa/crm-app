import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string; [x: string]: unknown }) => {
      const s = o?.defaultValue ?? k;
      // Interpolate {{n}} / {{cols}} so count-bearing copy is asserted as users see it.
      return typeof s === 'string'
        ? s.replace(/\{\{(\w+)\}\}/g, (_, key) => String(o?.[key] ?? ''))
        : s;
    },
  }),
}));

const api = vi.hoisted(() => ({
  useBrands: vi.fn(),
  useStores: vi.fn(),
  useCreateBrand: vi.fn(),
  useUpdateBrand: vi.fn(),
  useDeleteBrand: vi.fn(),
  useCreateStore: vi.fn(),
  useUpdateStore: vi.fn(),
  useDeleteStore: vi.fn(),
  useBulkCreateStores: vi.fn(),
  useBulkCreateBrands: vi.fn(),
  useStoreIndex: vi.fn(),
  toStoreRecord: vi.fn(),
}));
vi.mock('../src/features/restaurants/api.js', () => api);

import { BrandsPage } from '../src/features/restaurants/BrandsPage.js';
import { StoresPage } from '../src/features/restaurants/StoresPage.js';

const BRANDS = [
  {
    id: 'b1',
    code: 'LCP',
    name: 'Casa Pasta',
    yiji_brand_name: 'La Casa Pasta',
    status: 'active' as const,
  },
  {
    id: 'b2',
    code: 'OKA',
    name: 'Okashi',
    yiji_brand_name: null,
    status: 'inactive' as const,
  },
];

const STORES = [
  {
    id: 's1',
    code: 'LCP-041',
    name: 'Masief Plaza',
    city: 'Riyadh',
    area_manager: 'Ahmed Samir',
    chain_manager: 'Mo’men Elsharkawy',
    yiji_restaurant_id: null,
    status: 'active' as const,
    brand: { id: 'b1', code: 'LCP', name: 'Casa Pasta' },
  },
  {
    id: 's2',
    code: null,
    name: 'Orphan Branch',
    city: null,
    area_manager: null,
    chain_manager: null,
    yiji_restaurant_id: null,
    status: 'active' as const,
    brand: null,
  },
];

function renderPage(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(ui, { wrapper: Wrapper });
}

const mutation = () => ({ mutateAsync: vi.fn().mockResolvedValue({}) });

beforeEach(() => {
  vi.clearAllMocks();
  api.useCreateBrand.mockReturnValue(mutation());
  api.useUpdateBrand.mockReturnValue(mutation());
  api.useDeleteBrand.mockReturnValue(mutation());
  api.useCreateStore.mockReturnValue(mutation());
  api.useUpdateStore.mockReturnValue(mutation());
  api.useDeleteStore.mockReturnValue(mutation());
  api.useBulkCreateStores.mockReturnValue(mutation());
  api.useBulkCreateBrands.mockReturnValue(mutation());
  api.useBrands.mockReturnValue({ data: BRANDS, isLoading: false, isError: false });
  api.useStores.mockReturnValue({ data: STORES, isLoading: false, isError: false });
});

describe('BrandsPage', () => {
  it('renders the brands with their codes', () => {
    renderPage(<BrandsPage />);
    expect(screen.getByText('Casa Pasta')).toBeInTheDocument();
    expect(screen.getByText('Okashi')).toBeInTheDocument();
  });

  it('shows the order-system alias when it differs from the display name', () => {
    renderPage(<BrandsPage />);
    // Operations say "Casa Pasta", Yiji says "La Casa Pasta" — the difference is
    // the whole reason the alias field exists, so it has to be visible.
    expect(screen.getByText(/La Casa Pasta/)).toBeInTheDocument();
  });

  it('marks an inactive brand', () => {
    renderPage(<BrandsPage />);
    expect(screen.getByText('Inactive')).toBeInTheDocument();
  });

  it('shows the empty state when there are no brands', () => {
    api.useBrands.mockReturnValue({ data: [], isLoading: false, isError: false });
    renderPage(<BrandsPage />);
    expect(screen.getByText('No brands yet')).toBeInTheDocument();
  });

  it('shows an error state when the load fails', () => {
    api.useBrands.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: vi.fn(),
    });
    renderPage(<BrandsPage />);
    expect(screen.getByText('Could not load brands')).toBeInTheDocument();
  });

  it('opens the create drawer', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage(<BrandsPage />);
    await user.click(screen.getAllByRole('button', { name: 'Add brand' })[0]!);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});

describe('StoresPage', () => {
  it('renders a store row with brand, city and both managers', () => {
    renderPage(<StoresPage />);
    expect(screen.getByText('Masief Plaza')).toBeInTheDocument();
    expect(screen.getByText('LCP-041')).toBeInTheDocument();
    expect(screen.getByText('Riyadh')).toBeInTheDocument();
    expect(screen.getByText('Ahmed Samir')).toBeInTheDocument();
    expect(screen.getByText('Mo’men Elsharkawy')).toBeInTheDocument();
  });

  it('flags a store with no brand rather than showing a blank cell', () => {
    renderPage(<StoresPage />);
    expect(screen.getByText('No brand')).toBeInTheDocument();
  });

  it('filters by the search box across code, city, brand and manager', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage(<StoresPage />);
    const search = screen.getByPlaceholderText(/Search store/);
    await user.type(search, 'riyadh');
    expect(screen.getByText('Masief Plaza')).toBeInTheDocument();
    expect(screen.queryByText('Orphan Branch')).not.toBeInTheDocument();
  });

  it('shows a no-matches state for a search that hits nothing', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage(<StoresPage />);
    await user.type(screen.getByPlaceholderText(/Search store/), 'zzzznothing');
    expect(screen.getByText('No stores match that search')).toBeInTheDocument();
  });

  it('shows the empty state, offering the CSV import', () => {
    api.useStores.mockReturnValue({ data: [], isLoading: false, isError: false });
    renderPage(<StoresPage />);
    expect(screen.getByText('No stores yet')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Import CSV' }).length).toBeGreaterThan(0);
  });

  it('opens the edit drawer prefilled from a row', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage(<StoresPage />);
    await user.click(screen.getByText('Masief Plaza'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(screen.getByDisplayValue('Masief Plaza')).toBeInTheDocument();
    expect(screen.getByDisplayValue('LCP-041')).toBeInTheDocument();
  });
});
