import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

/* The SDK builders become plain descriptions, so `request` can answer by
   collection and the test can read exactly what was written. */
vi.mock('@directus/sdk', () => ({
  readItems: (collection: string, query: unknown) => ({ op: 'read', collection, query }),
  createItem: (collection: string, body: unknown) => ({ op: 'create', collection, body }),
  updateItem: (collection: string, id: unknown, body: unknown) => ({
    op: 'update',
    collection,
    id,
    body,
  }),
  deleteItem: (collection: string, id: unknown) => ({ op: 'delete', collection, id }),
}));

type Cmd = { op: string; collection: string; id?: unknown; body?: unknown };
const db = vi.hoisted(() => ({
  setting: null as { id: string; value: unknown } | null,
  writes: [] as Array<{ op: string; collection: string; id?: unknown; body?: unknown }>,
}));
const request = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/directus.js', () => ({ directus: { request } }));
/* The ready-replies section is its own editor and not under test here. */
vi.mock('../src/features/lists/QuickRepliesSection.js', () => ({
  QuickRepliesSection: () => null,
}));

import { OptionListsPage } from '../src/features/lists/OptionListsPage.js';

const OPTIONS = [
  { id: 'c1', list: 'complaint_type', value: 'Late order', sort: 0, active: true, group: null },
  {
    id: 'c2',
    list: 'complaint_type',
    value: 'Instore preparation late order',
    sort: 1,
    active: true,
    group: null,
  },
  { id: 'c3', list: 'complaint_type', value: 'Old type', sort: 2, active: false, group: null },
  {
    id: 'l1',
    list: 'late_order_cause',
    value: 'late preparation',
    sort: 0,
    active: true,
    group: 'operations',
  },
  {
    id: 'l2',
    list: 'late_order_cause',
    value: 'late driver',
    sort: 1,
    active: true,
    group: 'wecare',
  },
];

beforeEach(() => {
  /* jsdom has no scrollIntoView; SelectMenu calls it when a menu opens. */
  Element.prototype.scrollIntoView = vi.fn();
  db.setting = null;
  db.writes = [];
  request.mockReset();
  request.mockImplementation(async (cmd: Cmd) => {
    if (cmd.op === 'read' && cmd.collection === 'option_lists') return OPTIONS;
    if (cmd.op === 'read' && cmd.collection === 'app_settings')
      return db.setting ? [db.setting] : [];
    db.writes.push(cmd);
    if (cmd.op === 'create') return { id: 'new' };
    return {};
  });
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<OptionListsPage />, { wrapper: Wrapper });
}

async function openLateOrderCauses() {
  const user = userEvent.setup();
  renderPage();
  await user.click(await screen.findByRole('combobox', { name: 'List' }));
  await user.click(await screen.findByRole('button', { name: 'Late orders: Source of delay' }));
  return user;
}

/**
 * EMA-32 (owner, 2026-10-07): operations choose which complaint type each
 * late-order reason files under, beside the reasons on this page.
 */
describe('Lists page — late-order reason → complaint type', () => {
  it('offers no complaint-type select on other lists', async () => {
    renderPage();
    await screen.findByText('Late order');
    expect(screen.queryByRole('combobox', { name: /Files under complaint type for/ })).toBeNull();
  });

  it('shows a select beside each reason, offering the ACTIVE complaint types', async () => {
    const user = await openLateOrderCauses();
    const select = await screen.findByRole('combobox', {
      name: 'Files under complaint type for late preparation',
    });
    expect(
      screen.getByRole('combobox', { name: 'Files under complaint type for late driver' }),
    ).toBeTruthy();
    expect(screen.getByText(/filed under the complaint type chosen beside it/)).toBeTruthy();
    await waitFor(() => expect((select as HTMLButtonElement).disabled).toBe(false));
    await user.click(select);
    expect(
      screen.getByRole('button', { name: '(not set — uses the reason’s own name)' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Instore preparation late order' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Old type' })).toBeNull();
  });

  it('creates the app_settings row when none exists', async () => {
    const user = await openLateOrderCauses();
    const select = await screen.findByRole('combobox', {
      name: 'Files under complaint type for late preparation',
    });
    await waitFor(() => expect((select as HTMLButtonElement).disabled).toBe(false));
    await user.click(select);
    await user.click(screen.getByRole('button', { name: 'Instore preparation late order' }));
    await waitFor(() => expect(db.writes).toHaveLength(1));
    expect(db.writes[0]).toEqual({
      op: 'create',
      collection: 'app_settings',
      body: {
        key: 'late_order_complaint_type',
        value: JSON.stringify({ 'late preparation': 'Instore preparation late order' }),
      },
    });
  });

  it('MERGES into the existing row, keeping other reasons’ pairings', async () => {
    db.setting = { id: 's1', value: JSON.stringify({ 'Late Customer': 'Late order' }) };
    const user = await openLateOrderCauses();
    const select = await screen.findByRole('combobox', {
      name: 'Files under complaint type for late driver',
    });
    await waitFor(() => expect((select as HTMLButtonElement).disabled).toBe(false));
    await user.click(select);
    await user.click(screen.getByRole('button', { name: 'Late order' }));
    await waitFor(() => expect(db.writes).toHaveLength(1));
    const write = db.writes[0]!;
    expect(write.op).toBe('update');
    expect(write.id).toBe('s1');
    expect(JSON.parse((write.body as { value: string }).value)).toEqual({
      'Late Customer': 'Late order',
      'late driver': 'Late order',
    });
  });

  it('shows the stored pairing and un-pairs on "not set"', async () => {
    db.setting = {
      id: 's1',
      value: JSON.stringify({
        'Late Customer': 'Late order',
        'late preparation': 'Instore preparation late order',
      }),
    };
    const user = await openLateOrderCauses();
    const select = await screen.findByRole('combobox', {
      name: 'Files under complaint type for late preparation',
    });
    await waitFor(() => expect(select.textContent).toContain('Instore preparation late order'));
    await user.click(select);
    await user.click(
      screen.getByRole('button', { name: '(not set — uses the reason’s own name)' }),
    );
    await waitFor(() => expect(db.writes).toHaveLength(1));
    expect(JSON.parse((db.writes[0]!.body as { value: string }).value)).toEqual({
      'Late Customer': 'Late order',
    });
  });
});
