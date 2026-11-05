import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * GLOBAL SETTINGS -> "Coupons under maintenance" (owner, 2026-11-05).
 *
 * One switch for EVERY user at once, on Roles & privileges. Only the
 * Administrator may flip it; it is one `app_settings` row, written as
 * "true"/"false"; no row reads as ON (paused) - the fail-safe direction.
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
    i18n: { language: 'en', changeLanguage: vi.fn(), dir: () => 'ltr' },
  }),
}));
const sdk = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request: sdk.request } }));
const auth = vi.hoisted(() => ({ isOwner: true }));
vi.mock('../src/lib/auth/AuthContext.js', () => ({
  useAuth: () => ({ isOwner: auth.isOwner, can: () => true, user: { role: { id: 'r' } } }),
}));
vi.mock('@directus/sdk', () => ({
  readItems: (collection: string, query: unknown) => ({ kind: 'items', collection, query }),
  createItem: (collection: string, body: unknown) => ({ kind: 'create', collection, body }),
  updateItem: (collection: string, id: string, body: unknown) => ({
    kind: 'update',
    collection,
    id,
    body,
  }),
}));

import { GlobalSettingsCard } from '../src/features/app-roles/GlobalSettings.js';

let rows: Array<{ id: string; value: unknown }> = [];
beforeEach(() => {
  auth.isOwner = true;
  rows = [];
  sdk.request.mockReset();
  sdk.request.mockImplementation(async (req: { kind: string }) =>
    req.kind === 'items' ? rows : {},
  );
});

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<GlobalSettingsCard />, { wrapper: Wrapper });
}

describe('Global settings: coupons under maintenance', () => {
  it('no row reads as ON (paused) - the safe direction', async () => {
    renderCard();
    const sw = await screen.findByTestId('coupons-maintenance-switch');
    await waitFor(() => expect(sw).not.toBeDisabled());
    expect(sw).toBeChecked();
  });

  it('the Administrator turns coupons back on: the row is written "false"', async () => {
    rows = [{ id: 's1', value: 'true' }];
    renderCard();
    const sw = await screen.findByTestId('coupons-maintenance-switch');
    await waitFor(() => expect(sw).not.toBeDisabled());
    fireEvent.click(sw);
    await waitFor(() =>
      expect(sdk.request).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'update', id: 's1', body: { value: 'false' } }),
      ),
    );
  });

  it('creates the row the first time it is set', async () => {
    rows = [];
    renderCard();
    const sw = await screen.findByTestId('coupons-maintenance-switch');
    await waitFor(() => expect(sw).not.toBeDisabled());
    fireEvent.click(sw);
    await waitFor(() =>
      expect(sdk.request).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'create',
          collection: 'app_settings',
          body: { key: 'coupons_under_maintenance', value: 'false' },
        }),
      ),
    );
  });

  it('anyone but the Administrator sees it, and cannot change it', async () => {
    auth.isOwner = false;
    rows = [{ id: 's1', value: 'false' }];
    renderCard();
    const sw = await screen.findByTestId('coupons-maintenance-switch');
    await waitFor(() => expect(sw).not.toBeChecked());
    expect(sw).toBeDisabled();
    expect(screen.getByText('Only the Administrator can change this.')).toBeInTheDocument();
  });
});
