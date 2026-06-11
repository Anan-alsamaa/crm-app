import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
vi.mock('../src/features/vendors/api.js', () => ({
  useVendors: () => ({
    data: [{ id: 'v1', name: 'Acme', yiji_vendor_id: 'acme-1' }],
  }),
}));

import { ImportsPage } from '../src/features/imports/ImportsPage.js';

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<ImportsPage />, { wrapper: Wrapper });
}

beforeEach(() => request.mockReset());

describe('ImportsPage', () => {
  it('renders the heading and the empty state before upload', () => {
    renderPage();
    expect(screen.getByText('Import contacts')).toBeInTheDocument();
    expect(screen.getByText('Upload a CSV to begin')).toBeInTheDocument();
  });

  it('lists the available vendors in the select', () => {
    // SelectMenu renders its options in a portal only while open (unlike a
    // native <select>, which keeps every <option> in the DOM), so open it first.
    Element.prototype.scrollIntoView = vi.fn();
    renderPage();
    fireEvent.click(screen.getByRole('combobox', { name: 'Target vendor' }));
    expect(screen.getByText('Acme (acme-1)')).toBeInTheDocument();
  });

  it('disables the queue button until a vendor and file are set', () => {
    renderPage();
    expect(screen.getByText('Queue import').closest('button')).toBeDisabled();
  });
});
