import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

/**
 * End-to-end behaviour of the repeatable Restaurants import, at the hook level:
 * the pure key functions are covered in restaurants-dedupe.test.ts, but only
 * this proves the hook actually re-reads, filters, and inserts just the new
 * rows — which is where the 134-duplicate bug lived.
 *
 * The Directus SDK is mocked into tagged operations so a test can assert
 * exactly WHICH rows were written, and that nothing was updated or deleted.
 */
interface Op {
  op: string;
  collection: string;
  id?: string;
  items?: unknown;
}
vi.mock('@directus/sdk', () => ({
  readItems: (collection: string) => ({ op: 'readItems', collection }),
  createItems: (collection: string, items: unknown) => ({ op: 'createItems', collection, items }),
  createItem: (collection: string, items: unknown) => ({ op: 'createItem', collection, items }),
  updateItem: (collection: string, id: string, items: unknown) => ({
    op: 'updateItem',
    collection,
    id,
    items,
  }),
  deleteItem: (collection: string, id: string) => ({ op: 'deleteItem', collection, id }),
}));

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request } }));

import {
  useBulkCreateStores,
  useBulkCreateBrands,
  useUpdateStore,
  useDeleteStore,
  useUpdateBrand,
  type StoreInput,
} from '../src/features/restaurants/api.js';

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

/** Every op the hook sent, in order. */
const sent: Op[] = [];

/** Make `directus.request` answer reads with `existing` and record writes. */
function stubDirectus(existing: Record<string, unknown[]>) {
  sent.length = 0;
  request.mockImplementation(async (op: Op) => {
    sent.push(op);
    if (op.op === 'readItems') return existing[op.collection] ?? [];
    return op.items ?? { id: op.id ?? 'ok' };
  });
}

const inserted = (collection: string) =>
  sent
    .filter((o) => o.op === 'createItems' && o.collection === collection)
    .flatMap((o) => o.items as StoreInput[]);

const store = (code: string | null, name: string, extra: Partial<StoreInput> = {}): StoreInput => ({
  code,
  name,
  city: 'Riyadh',
  status: 'active',
  ...extra,
});

// Braces matter: an arrow that RETURNS `request.mockReset()` hands Vitest the
// mock itself, which it then treats as a teardown hook and invokes with no
// arguments at the end of every test.
beforeEach(() => {
  request.mockReset();
});

describe('useBulkCreateStores — repeat safety', () => {
  it('fresh import: inserts every row', async () => {
    stubDirectus({ stores: [] });
    const { result } = renderHook(() => useBulkCreateStores(), { wrapper: wrapper() });

    const outcome = await result.current.mutateAsync([
      store('LCP-001', 'A'),
      store('LCP-002', 'B'),
      store('LCP-003', 'C'),
    ]);

    expect(outcome).toEqual({ added: 3, alreadyPresent: 0 });
    expect(inserted('stores').map((r) => r.code)).toEqual(['LCP-001', 'LCP-002', 'LCP-003']);
  });

  it('re-import of the identical file: adds nothing and writes nothing', async () => {
    stubDirectus({
      stores: [
        { code: 'LCP-001', name: 'A', brand: null },
        { code: 'LCP-002', name: 'B', brand: null },
        { code: 'LCP-003', name: 'C', brand: null },
      ],
    });
    const { result } = renderHook(() => useBulkCreateStores(), { wrapper: wrapper() });

    const outcome = await result.current.mutateAsync([
      store('LCP-001', 'A'),
      store('LCP-002', 'B'),
      store('LCP-003', 'C'),
    ]);

    expect(outcome).toEqual({ added: 0, alreadyPresent: 3 });
    // Not "inserted zero rows" — no write request is made at all.
    expect(sent.filter((o) => o.op === 'createItems')).toHaveLength(0);
  });

  it('mixed file: inserts only the new rows', async () => {
    stubDirectus({
      stores: [
        { code: 'LCP-001', name: 'A', brand: null },
        { code: 'LCP-002', name: 'B', brand: null },
      ],
    });
    const { result } = renderHook(() => useBulkCreateStores(), { wrapper: wrapper() });

    const outcome = await result.current.mutateAsync([
      store('LCP-001', 'A'),
      store('LCP-009', 'New One'),
      store('LCP-002', 'B'),
      store('LCP-010', 'New Two'),
    ]);

    expect(outcome).toEqual({ added: 2, alreadyPresent: 2 });
    expect(inserted('stores').map((r) => r.name)).toEqual(['New One', 'New Two']);
  });

  it('never updates or deletes an existing row', async () => {
    stubDirectus({ stores: [{ code: 'LCP-001', name: 'Old Name', brand: null }] });
    const { result } = renderHook(() => useBulkCreateStores(), { wrapper: wrapper() });

    // Same store, different name and city — an import must not overwrite a
    // correction someone made by hand in the UI.
    await result.current.mutateAsync([store('LCP-001', 'Renamed In Sheet', { city: 'Jeddah' })]);

    expect(sent.some((o) => o.op === 'updateItem' || o.op === 'deleteItem')).toBe(false);
    expect(sent.filter((o) => o.op === 'createItems')).toHaveLength(0);
  });

  it('matches a stored row even when the sheet packs the code into the name', async () => {
    stubDirectus({ stores: [{ code: 'LCP-058', name: 'ARAMCO', brand: null }] });
    const { result } = renderHook(() => useBulkCreateStores(), { wrapper: wrapper() });

    const outcome = await result.current.mutateAsync([store(null, 'LCP058-ARAMCO')]);
    expect(outcome).toEqual({ added: 0, alreadyPresent: 1 });
  });

  it('keeps a codeless branch of another brand as genuinely new', async () => {
    stubDirectus({
      stores: [{ code: null, name: 'Buhairah Plaza', brand: { code: 'LCP' } }],
    });
    const { result } = renderHook(() => useBulkCreateStores(), { wrapper: wrapper() });

    const outcome = await result.current.mutateAsync([
      store(null, 'Buhairah Plaza', { brand_code: 'PSK' }),
    ]);
    expect(outcome).toEqual({ added: 1, alreadyPresent: 0 });
  });

  it('strips the matching-only brand_code before writing to Directus', async () => {
    stubDirectus({ stores: [] });
    const { result } = renderHook(() => useBulkCreateStores(), { wrapper: wrapper() });

    await result.current.mutateAsync([store('LCP-001', 'A', { brand_code: 'LCP', brand: 'b1' })]);

    const row = inserted('stores')[0]!;
    expect(row).not.toHaveProperty('brand_code');
    expect(row.brand).toBe('b1');
  });

  it('reads existing rows fresh on every run, not from a cache', async () => {
    stubDirectus({ stores: [] });
    const { result } = renderHook(() => useBulkCreateStores(), { wrapper: wrapper() });
    await result.current.mutateAsync([store('LCP-001', 'A')]);
    await result.current.mutateAsync([store('LCP-002', 'B')]);
    expect(sent.filter((o) => o.op === 'readItems' && o.collection === 'stores')).toHaveLength(2);
  });

  it('chunks large imports but still counts them once', async () => {
    stubDirectus({ stores: [] });
    const { result } = renderHook(() => useBulkCreateStores(), { wrapper: wrapper() });

    const rows = Array.from({ length: 134 }, (_, i) =>
      store(`LCP-${String(i + 1).padStart(3, '0')}`, `Branch ${i + 1}`),
    );
    const outcome = await result.current.mutateAsync(rows);

    expect(outcome).toEqual({ added: 134, alreadyPresent: 0 });
    expect(inserted('stores')).toHaveLength(134);
    expect(sent.filter((o) => o.op === 'createItems').length).toBeGreaterThan(1);
  });
});

/**
 * The reason this feature exists: a new branch opens, and someone onboards it
 * by uploading a sheet instead of typing the store in by hand. The master is
 * already populated at that point, so the upload has to add the newcomer and
 * leave the existing branches completely alone.
 */
describe('useBulkCreateStores — onboarding a new branch', () => {
  /** The master as it stands before the new branch opens. */
  const MASTER = [
    { code: 'LCP-041', name: 'Masief Plaza', brand: { code: 'LCP' } },
    { code: 'LCP-006', name: 'Panorama Mall RYD', brand: { code: 'LCP' } },
    { code: 'PSK-002', name: 'Nakhil Mall DMM', brand: { code: 'PSK' } },
  ];

  it('adds a branch listed on its own, against a populated master', async () => {
    stubDirectus({ stores: MASTER });
    const { result } = renderHook(() => useBulkCreateStores(), { wrapper: wrapper() });

    // The operator uploads ONE row — just the branch that opened.
    const outcome = await result.current.mutateAsync([store('LCP-090', 'Riyadh Park')]);

    expect(outcome).toEqual({ added: 1, alreadyPresent: 0 });
    expect(inserted('stores').map((r) => r.code)).toEqual(['LCP-090']);
  });

  it('leaves every existing branch untouched while doing it', async () => {
    stubDirectus({ stores: MASTER });
    const { result } = renderHook(() => useBulkCreateStores(), { wrapper: wrapper() });

    await result.current.mutateAsync([store('LCP-090', 'Riyadh Park')]);

    // Nothing but the one insert — no update, no delete, nothing touching the
    // three branches that were already there.
    expect(sent.some((o) => o.op === 'updateItem' || o.op === 'deleteItem')).toBe(false);
    expect(inserted('stores')).toHaveLength(1);
  });

  it('onboards several new branches in one upload', async () => {
    stubDirectus({ stores: MASTER });
    const { result } = renderHook(() => useBulkCreateStores(), { wrapper: wrapper() });

    const outcome = await result.current.mutateAsync([
      store('LCP-090', 'Riyadh Park'),
      store('PSK-030', 'Granada Mall'),
    ]);

    expect(outcome).toEqual({ added: 2, alreadyPresent: 0 });
    expect(inserted('stores').map((r) => r.code)).toEqual(['LCP-090', 'PSK-030']);
  });

  it('still onboards the newcomer when the sheet is the whole master again', async () => {
    // The operator may not keep a "new branches only" sheet — re-exporting the
    // full master with one extra line has to work just as well.
    stubDirectus({ stores: MASTER });
    const { result } = renderHook(() => useBulkCreateStores(), { wrapper: wrapper() });

    const outcome = await result.current.mutateAsync([
      store('LCP-041', 'Masief Plaza'),
      store('LCP-006', 'Panorama Mall RYD'),
      store('PSK-002', 'Nakhil Mall DMM'),
      store('LCP-090', 'Riyadh Park'),
    ]);

    expect(outcome).toEqual({ added: 1, alreadyPresent: 3 });
    expect(inserted('stores').map((r) => r.code)).toEqual(['LCP-090']);
  });
});

describe('useBulkCreateBrands — repeat safety', () => {
  it('fresh import: creates every brand', async () => {
    stubDirectus({ brands: [] });
    const { result } = renderHook(() => useBulkCreateBrands(), { wrapper: wrapper() });

    const outcome = await result.current.mutateAsync([
      { code: 'LCP', name: 'LCP', status: 'active' },
      { code: 'PSK', name: 'PSK', status: 'active' },
    ]);

    expect(outcome).toEqual({ added: 2, alreadyPresent: 0 });
    expect(inserted('brands')).toHaveLength(2);
  });

  it('re-import: skips brands that already exist, whatever the case', async () => {
    stubDirectus({ brands: [{ code: 'lcp', name: 'Casa Pasta' }] });
    const { result } = renderHook(() => useBulkCreateBrands(), { wrapper: wrapper() });

    const outcome = await result.current.mutateAsync([
      { code: 'LCP', name: 'LCP', status: 'active' },
      { code: 'PSK', name: 'PSK', status: 'active' },
    ]);

    expect(outcome).toEqual({ added: 1, alreadyPresent: 1 });
    expect(inserted('brands').map((b) => (b as { code: string }).code)).toEqual(['PSK']);
  });

  it('never renames an existing brand', async () => {
    // Operations renamed LCP to "Casa Pasta" in the UI; the sheet still only
    // knows the code. Re-importing must not push the code back over the name.
    stubDirectus({ brands: [{ code: 'LCP', name: 'Casa Pasta' }] });
    const { result } = renderHook(() => useBulkCreateBrands(), { wrapper: wrapper() });

    await result.current.mutateAsync([{ code: 'LCP', name: 'LCP', status: 'active' }]);

    expect(sent.some((o) => o.op === 'updateItem')).toBe(false);
    expect(sent.filter((o) => o.op === 'createItems')).toHaveLength(0);
  });

  it('an empty brand list touches Directus not at all', async () => {
    stubDirectus({ brands: [] });
    const { result } = renderHook(() => useBulkCreateBrands(), { wrapper: wrapper() });
    const outcome = await result.current.mutateAsync([]);
    expect(outcome).toEqual({ added: 0, alreadyPresent: 0 });
    expect(sent).toHaveLength(0);
  });
});

/**
 * Editing a store must never rewrite what a past ticket reported. Tickets
 * normally record their own attribution when raised, so this guard is for the
 * one that slipped through — and it has to run BEFORE the store changes,
 * because afterwards the old values are gone for good.
 */
describe('editing a store cannot rewrite history', () => {
  const STORES = [
    {
      id: 's1',
      code: 'LCP-041',
      name: 'Masief Plaza',
      city: 'Riyadh',
      area_manager: 'Ahmed Samir',
      chain_manager: 'Medhat Sayed',
      yiji_restaurant_id: null,
      status: 'active',
      brand: { id: 'b1', code: 'LCP', name: 'Casa Pasta', yiji_brand_name: null },
    },
  ];
  const EXPOSED = [
    {
      id: 't1',
      order_snapshot: { restaurantName: 'LCP-041 Masief Plaza', brandName: 'Casa Pasta' },
    },
  ];

  it('freezes an exposed ticket before writing the store, not after', async () => {
    stubDirectus({ tickets: EXPOSED, stores: STORES });
    const { result } = renderHook(() => useUpdateStore(), { wrapper: wrapper() });

    await result.current.mutateAsync({
      id: 's1',
      name: 'Masief Plaza',
      area_manager: 'Someone New',
    });

    const ticketWrite = sent.findIndex((o) => o.op === 'updateItem' && o.collection === 'tickets');
    const storeWrite = sent.findIndex((o) => o.op === 'updateItem' && o.collection === 'stores');
    expect(ticketWrite).toBeGreaterThanOrEqual(0);
    expect(storeWrite).toBeGreaterThanOrEqual(0);
    // Order is the whole point: freeze first, then edit.
    expect(ticketWrite).toBeLessThan(storeWrite);
  });

  it('freezes the values as they are BEFORE the edit', async () => {
    stubDirectus({ tickets: EXPOSED, stores: STORES });
    const { result } = renderHook(() => useUpdateStore(), { wrapper: wrapper() });

    await result.current.mutateAsync({
      id: 's1',
      name: 'Masief Plaza',
      area_manager: 'Someone New',
    });

    const frozen = sent.find((o) => o.op === 'updateItem' && o.collection === 'tickets')!.items as {
      store_snapshot: { areaManager: string };
    };
    expect(frozen.store_snapshot.areaManager).toBe('Ahmed Samir');
  });

  it('does nothing when every ticket already carries its own attribution', async () => {
    // The normal case — one cheap read and no writes to tickets at all.
    stubDirectus({ tickets: [], stores: STORES });
    const { result } = renderHook(() => useUpdateStore(), { wrapper: wrapper() });

    await result.current.mutateAsync({ id: 's1', name: 'Renamed' });

    expect(sent.some((o) => o.op === 'updateItem' && o.collection === 'tickets')).toBe(false);
    expect(sent.some((o) => o.op === 'updateItem' && o.collection === 'stores')).toBe(true);
  });

  it('guards deleting a store too — the most destructive case', async () => {
    stubDirectus({ tickets: EXPOSED, stores: STORES });
    const { result } = renderHook(() => useDeleteStore(), { wrapper: wrapper() });

    await result.current.mutateAsync('s1');

    const ticketWrite = sent.findIndex((o) => o.op === 'updateItem' && o.collection === 'tickets');
    const del = sent.findIndex((o) => o.op === 'deleteItem');
    expect(ticketWrite).toBeGreaterThanOrEqual(0);
    expect(ticketWrite).toBeLessThan(del);
  });

  it('guards renaming a brand, which changes the brand column on every report', async () => {
    stubDirectus({ tickets: EXPOSED, stores: STORES });
    const { result } = renderHook(() => useUpdateBrand(), { wrapper: wrapper() });

    await result.current.mutateAsync({ id: 'b1', code: 'LCP', name: 'Renamed Brand' });

    const ticketWrite = sent.findIndex((o) => o.op === 'updateItem' && o.collection === 'tickets');
    const brandWrite = sent.findIndex((o) => o.op === 'updateItem' && o.collection === 'brands');
    expect(ticketWrite).toBeLessThan(brandWrite);
  });

  it('still lets the edit through if the safety net itself fails', async () => {
    // Blocking a legitimate correction because a guard broke would be worse
    // than the guard not running.
    sent.length = 0;
    request.mockImplementation(async (op: Op) => {
      sent.push(op);
      if (op.op === 'readItems' && op.collection === 'tickets')
        throw new Error('tickets unreadable');
      if (op.op === 'readItems') return [];
      return op.items ?? { id: op.id ?? 'ok' };
    });
    const { result } = renderHook(() => useUpdateStore(), { wrapper: wrapper() });

    await expect(result.current.mutateAsync({ id: 's1', name: 'Renamed' })).resolves.toBeDefined();
    expect(sent.some((o) => o.op === 'updateItem' && o.collection === 'stores')).toBe(true);
  });
});
