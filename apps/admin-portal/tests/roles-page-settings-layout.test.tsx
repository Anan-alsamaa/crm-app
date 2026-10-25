import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown> & { defaultValue?: string }) => {
      let s = (o?.defaultValue ?? k) as string;
      if (o) {
        for (const [key, val] of Object.entries(o)) {
          if (key === 'defaultValue') continue;
          s = s.replace(new RegExp(`{{\\s*${key}\\s*}}`, 'g'), String(val));
        }
      }
      return s;
    },
    i18n: { language: 'en', changeLanguage: vi.fn(), dir: () => 'ltr' },
  }),
}));

const sdk = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request: sdk.request } }));
const auth = vi.hoisted(() => ({ isOwner: false }));
vi.mock('../src/lib/auth/AuthContext.js', () => ({
  useAuth: () => ({
    can: () => true,
    isOwner: auth.isOwner,
    user: { role: { id: 'r-mine' } },
  }),
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
  deleteItem: (collection: string, id: string) => ({ kind: 'delete', collection, id }),
}));

import { RolesPage, splitLabel } from '../src/features/app-roles/RolesPage.js';

const roles = [
  {
    id: 'sup',
    name: 'Supervisor',
    description: 'Line one\nLine two',
    privileges: { use_chat: true, view_tickets: true },
    brands: null,
    stores: null,
    directus_role: 'd-sup',
    builtin: false,
  },
  {
    id: 'agent',
    name: 'Agent',
    description: 'Defined in code',
    privileges: {},
    brands: null,
    stores: null,
    directus_role: 'd-agent',
    builtin: true,
  },
];

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<RolesPage />, { wrapper: Wrapper });
}

const openRole = async (name: string) => {
  const btn = await screen.findByRole('button', { name: new RegExp(name) });
  fireEvent.click(btn);
};

beforeEach(() => {
  auth.isOwner = false;
  sdk.request.mockReset();
  sdk.request.mockImplementation((req: { kind: string; collection?: string }) => {
    if (req.collection === 'app_roles') return Promise.resolve(roles);
    if (req.collection === 'brands') return Promise.resolve([{ id: 'b1', name: 'Yiji' }]);
    return Promise.resolve([]);
  });
});

describe('splitLabel', () => {
  it('reads a trailing parenthetical as the help line', () => {
    expect(splitLabel('Edit or delete own messages (15 min)')).toEqual([
      'Edit or delete own messages',
      '15 min',
    ]);
    expect(splitLabel('Export to Excel/CSV')).toEqual(['Export to Excel/CSV', null]);
  });
});

describe('RolesPage settings layout', () => {
  it('opens on an empty state, not a dead form', async () => {
    renderPage();
    expect(await screen.findByText('No role open')).toBeInTheDocument();
    expect(screen.queryByRole('tablist', { name: 'Privilege areas' })).toBeNull();
  });

  it('shows ONE area at a time, and the arrow keys move between areas', async () => {
    renderPage();
    await openRole('Supervisor');
    const areas = await screen.findByRole('tablist', { name: 'Privilege areas' });
    const chat = within(areas).getByRole('tab', { name: /Customer chat/ });
    expect(chat).toHaveAttribute('aria-selected', 'true');
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText('Work the chat inbox')).toBeInTheDocument();
    expect(within(panel).queryByText('View own tickets')).toBeNull();

    fireEvent.keyDown(chat, { key: 'ArrowDown' });
    const next = within(areas).getAllByRole('tab')[1]!;
    expect(next).toHaveAttribute('aria-selected', 'true');
    expect(within(screen.getByRole('tabpanel')).queryByText('Work the chat inbox')).toBeNull();

    // End lands on the brand & branch fence, which lives in the same list.
    fireEvent.keyDown(next, { key: 'End' });
    expect(within(areas).getByRole('tab', { name: /Brand & branch access/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByText('Brand access')).toBeInTheDocument();
  });

  it('says when there is something to save, and saves what the switches show', async () => {
    sdk.request.mockImplementation((req: { kind: string; collection?: string }) => {
      if (req.kind === 'update') return Promise.resolve({ id: 'sup' });
      if (req.collection === 'app_roles') return Promise.resolve(roles);
      return Promise.resolve([]);
    });
    renderPage();
    await openRole('Supervisor');
    expect(await screen.findByText('All changes saved')).toBeInTheDocument();
    // The whole description, multi-line.
    expect(screen.getByLabelText('Description')).toHaveValue('Line one\nLine two');

    fireEvent.click(screen.getByRole('checkbox', { name: /See every agent's chats/ }));
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save role' }));
    await waitFor(() =>
      expect(sdk.request).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'update',
          id: 'sup',
          body: expect.objectContaining({
            privileges: expect.objectContaining({ use_chat: true, view_all_chats: true }),
          }),
        }),
      ),
    );
  });

  it('keeps a built-in role read-only', async () => {
    renderPage();
    await openRole('Agent');
    expect(await screen.findByText(/Built-in roles are defined in code/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save role' })).toBeNull();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });
});
