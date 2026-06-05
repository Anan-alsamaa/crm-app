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

// Mock the Directus SDK query builders so each returns a tagged descriptor.
// `request` can then route deterministically by collection instead of by call
// order (which is fragile under React effect timing).
vi.mock('@directus/sdk', () => ({
  readItems: (collection: string) => ({ kind: 'read', collection }),
  createItem: (collection: string) => ({ kind: 'create', collection }),
  updateItem: (collection: string) => ({ kind: 'update', collection }),
}));

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request } }));

import { CustomFieldsSection } from '../src/features/custom-fields/CustomFieldsSection.js';

type Descriptor = { kind: string; collection: string };

function route(handlers: {
  fields?: () => unknown;
  values?: () => unknown;
  write?: () => unknown;
}) {
  request.mockImplementation((d?: Descriptor) => {
    if (d?.kind === 'read' && d.collection === 'custom_fields')
      return Promise.resolve(handlers.fields ? handlers.fields() : []);
    if (d?.kind === 'read' && d.collection === 'custom_field_values')
      return Promise.resolve(handlers.values ? handlers.values() : []);
    return Promise.resolve(handlers.write ? handlers.write() : {});
  });
}

function renderSection() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<CustomFieldsSection entityType="contact" entityId="k1" />, { wrapper: Wrapper });
}

beforeEach(() => request.mockReset());

describe('CustomFieldsSection', () => {
  it('renders nothing when there are no field definitions', async () => {
    route({ fields: () => [], values: () => [] });
    const { container } = renderSection();
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(screen.queryByText('Custom fields')).not.toBeInTheDocument();
    expect(container.querySelector('h3')).toBeNull();
  });

  it('renders inputs for each defined field with existing values', async () => {
    route({
      fields: () => [
        {
          id: 'f1',
          name: 'Tier',
          key: 'tier',
          field_type: 'text',
          options: null,
          required: true,
          display_order: 0,
        },
      ],
      values: () => [
        { id: 'v1', custom_field: 'f1', entity_type: 'contact', entity_id: 'k1', value: 'gold' },
      ],
    });
    renderSection();
    await waitFor(() => expect(screen.getByText('Custom fields')).toBeInTheDocument());
    expect(screen.getByText('Tier *')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByDisplayValue('gold')).toBeInTheDocument());
  });

  it('saves edited values via the directus client', async () => {
    const writes: Descriptor[] = [];
    route({
      fields: () => [
        {
          id: 'f1',
          name: 'Tier',
          key: 'tier',
          field_type: 'text',
          options: null,
          required: false,
          display_order: 0,
        },
      ],
      values: () => [
        { id: 'v1', custom_field: 'f1', entity_type: 'contact', entity_id: 'k1', value: 'gold' },
      ],
    });
    request.mockImplementation((d?: Descriptor) => {
      if (d?.kind === 'read' && d.collection === 'custom_fields')
        return Promise.resolve([
          {
            id: 'f1',
            name: 'Tier',
            key: 'tier',
            field_type: 'text',
            options: null,
            required: false,
            display_order: 0,
          },
        ]);
      if (d?.kind === 'read' && d.collection === 'custom_field_values')
        return Promise.resolve([
          { id: 'v1', custom_field: 'f1', entity_type: 'contact', entity_id: 'k1', value: 'gold' },
        ]);
      if (d) writes.push(d);
      return Promise.resolve({});
    });
    renderSection();
    await waitFor(() => expect(screen.getByDisplayValue('gold')).toBeInTheDocument());
    await userEvent.click(screen.getByText('actions.save'));
    // The existing value row is updated.
    await waitFor(() =>
      expect(
        writes.some((w) => w.kind === 'update' && w.collection === 'custom_field_values'),
      ).toBe(true),
    );
  });
});
