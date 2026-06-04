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
  useCustomFields: vi.fn(),
  useCreateField: vi.fn(),
  useUpdateField: vi.fn(),
  useDeleteField: vi.fn(),
}));
vi.mock('../src/features/custom-fields/api.js', () => api);

import { CustomFieldsPage } from '../src/features/custom-fields/CustomFieldsPage.js';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<CustomFieldsPage />, { wrapper: Wrapper });
}

beforeEach(() => {
  api.useCreateField.mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue({}),
    isPending: false,
  });
  api.useUpdateField.mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue({}),
    isPending: false,
  });
  api.useDeleteField.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}) });
});

describe('CustomFieldsPage', () => {
  it('shows empty state when no fields for entity', () => {
    api.useCustomFields.mockReturnValue({ data: [], isLoading: false });
    renderPage();
    expect(screen.getByText('No custom fields for this entity yet.')).toBeInTheDocument();
  });

  it('renders a field row for the active entity tab', () => {
    api.useCustomFields.mockReturnValue({
      data: [
        {
          id: 'f1',
          entity_type: 'contact',
          name: 'Tier',
          key: 'tier',
          field_type: 'text',
          options: null,
          required: true,
          display_order: 1,
        },
      ],
      isLoading: false,
    });
    renderPage();
    expect(screen.getByText('Tier')).toBeInTheDocument();
    expect(screen.getByText('tier')).toBeInTheDocument();
  });

  it('opens the create drawer', async () => {
    api.useCustomFields.mockReturnValue({ data: [], isLoading: false });
    renderPage();
    await userEvent.click(screen.getAllByText('New field')[0]);
    expect(screen.getByText('Entity')).toBeInTheDocument();
  });
});
