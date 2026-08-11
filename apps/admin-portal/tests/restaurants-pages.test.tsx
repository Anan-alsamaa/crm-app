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

/**
 * Who is signed in. `admin_access` is the Directus signal that separates the
 * built-in Administrator from the CRM "Admin" role, and it gates whether the
 * Yiji restaurant id is editable.
 */
const session = vi.hoisted(() => ({ user: { admin_access: true } as { admin_access: boolean } }));
vi.mock('../src/lib/auth/AuthContext.js', () => ({
  useAuth: () => session,
}));

/** Capture toast copy — the import result is reported only through it. */
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@yiji/ui', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, toast: toasts };
});

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
/** The bulk hooks report `{ added, alreadyPresent }`, not a bare count. */
const importMutation = (added: number, alreadyPresent: number) => ({
  mutateAsync: vi.fn().mockResolvedValue({ added, alreadyPresent }),
});

beforeEach(() => {
  vi.clearAllMocks();
  session.user = { admin_access: true };
  api.useCreateBrand.mockReturnValue(mutation());
  api.useUpdateBrand.mockReturnValue(mutation());
  api.useDeleteBrand.mockReturnValue(mutation());
  api.useCreateStore.mockReturnValue(mutation());
  api.useUpdateStore.mockReturnValue(mutation());
  api.useDeleteStore.mockReturnValue(mutation());
  api.useBulkCreateStores.mockReturnValue(importMutation(0, 0));
  api.useBulkCreateBrands.mockReturnValue(importMutation(0, 0));
  // `refetch` is part of every real useQuery result, and the import calls it
  // after creating brands so the new ids are available for the store rows.
  api.useBrands.mockReturnValue({
    data: BRANDS,
    isLoading: false,
    isError: false,
    refetch: vi.fn().mockResolvedValue({ data: BRANDS }),
  });
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

  it('lets the Administrator edit the Yiji restaurant id', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage(<StoresPage />);
    await user.click(screen.getByText('Masief Plaza'));
    await screen.findByRole('dialog');
    expect(screen.getByLabelText(/Restaurant ID/)).not.toBeDisabled();
  });

  it('shows the restaurant id as the first column, and can search by it', async () => {
    api.useStores.mockReturnValue({
      data: [{ ...STORES[0], yiji_restaurant_id: '39' }, STORES[1]],
      isLoading: false,
      isError: false,
    });
    const user = userEvent.setup({ delay: null });
    renderPage(<StoresPage />);
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers[0]).toBe('Restaurant ID');
    // Searching by id is the fastest way to check a branch against the order
    // system, so it must hit even though no other column contains "39".
    await user.type(screen.getByPlaceholderText(/Search store/), '39');
    expect(screen.getByText('Masief Plaza')).toBeInTheDocument();
    expect(screen.queryByText('Orphan Branch')).not.toBeInTheDocument();
  });

  it('locks the Yiji restaurant id for anyone below Administrator', async () => {
    // The CRM "Admin" role maintains stores but must not touch the join key:
    // a wrong id does not error, it silently reports against the wrong branch.
    session.user = { admin_access: false };
    const user = userEvent.setup({ delay: null });
    renderPage(<StoresPage />);
    await user.click(screen.getByText('Masief Plaza'));
    await screen.findByRole('dialog');
    expect(screen.getByLabelText(/Restaurant ID/)).toBeDisabled();
    expect(screen.getByText(/Only the Administrator can change this/)).toBeInTheDocument();
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

describe('StoresPage — repeatable CSV import', () => {
  /**
   * This jsdom has no `Blob.prototype.text()`, which every real browser has and
   * which the import uses to read the chosen file. Without the polyfill the
   * upload throws before any of this is exercised.
   */
  beforeEach(() => {
    if (typeof Blob.prototype.text !== 'function') {
      Blob.prototype.text = function text(this: Blob) {
        return new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result ?? ''));
          reader.onerror = () => reject(reader.error);
          reader.readAsText(this);
        });
      };
    }
  });

  /** The operations sheet's own header row, three branches. */
  const SHEET = [
    'Restaurant,City,Area Manager,Chain Manager,Brand',
    'LCP-041 Masief Plaza,Riyadh,Ahmed Samir,Medhat Sayed,LCP',
    'LCP-006 Panorama Mall,Riyadh,Ahmed Samir,Medhat Sayed,LCP',
    'PSK-002 Nakhil Mall DMM,Dammam,Khaled Abdellah,Ahmed Sami,PSK',
  ].join('\n');

  const upload = async (csv: string) => {
    const user = userEvent.setup({ delay: null });
    const { container } = renderPage(<StoresPage />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File([csv], 'stores.csv', { type: 'text/csv' }));
    return user;
  };

  /** The single toast the import produced. */
  const lastToast = () => String(toasts.success.mock.calls.at(-1)?.[0] ?? '');

  it('fresh import reports everything as added', async () => {
    api.useBulkCreateStores.mockReturnValue(importMutation(3, 0));
    await upload(SHEET);
    await vi.waitFor(() => expect(toasts.success).toHaveBeenCalled());
    expect(lastToast()).toContain('3 added');
    expect(lastToast()).toContain('0 already present');
  });

  it('re-import of the identical file reports 0 added, not a failure', async () => {
    // The toast is the ONLY signal the user gets. If a repeat upload said
    // nothing, "did it work?" would be unanswerable without opening the table.
    api.useBulkCreateStores.mockReturnValue(importMutation(0, 3));
    await upload(SHEET);
    await vi.waitFor(() => expect(toasts.success).toHaveBeenCalled());
    expect(lastToast()).toContain('0 added');
    expect(lastToast()).toContain('3 already present');
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it('a mixed file reports added and already-present separately', async () => {
    api.useBulkCreateStores.mockReturnValue(importMutation(1, 2));
    await upload(SHEET);
    await vi.waitFor(() => expect(toasts.success).toHaveBeenCalled());
    expect(lastToast()).toContain('1 added');
    expect(lastToast()).toContain('2 already present');
  });

  it('passes the brand code through for duplicate matching', async () => {
    const bulk = importMutation(3, 0);
    api.useBulkCreateStores.mockReturnValue(bulk);
    await upload(SHEET);
    await vi.waitFor(() => expect(bulk.mutateAsync).toHaveBeenCalled());
    const rows = bulk.mutateAsync.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.brand_code)).toEqual(['LCP', 'LCP', 'PSK']);
    // And the code stays split out of the name, as the master stores it.
    expect(rows.map((r) => r.code)).toEqual(['LCP-041', 'LCP-006', 'PSK-002']);
  });

  it('offers every referenced brand to the hook and reports only new ones', async () => {
    // The page no longer pre-filters against a possibly stale brand cache —
    // the hook re-reads and decides, so both brands are handed over.
    const brandBulk = importMutation(1, 1);
    api.useBulkCreateBrands.mockReturnValue(brandBulk);
    api.useBulkCreateStores.mockReturnValue(importMutation(3, 0));
    await upload(SHEET);
    await vi.waitFor(() => expect(brandBulk.mutateAsync).toHaveBeenCalled());
    const brands = brandBulk.mutateAsync.mock.calls[0]![0] as Array<{ code: string }>;
    expect(brands.map((b) => b.code).sort()).toEqual(['LCP', 'PSK']);
    expect(lastToast()).toContain('1 brands created');
  });

  it('says nothing about brands when none were created', async () => {
    api.useBulkCreateBrands.mockReturnValue(importMutation(0, 2));
    api.useBulkCreateStores.mockReturnValue(importMutation(0, 3));
    await upload(SHEET);
    await vi.waitFor(() => expect(toasts.success).toHaveBeenCalled());
    expect(lastToast()).not.toContain('brands created');
  });
});
