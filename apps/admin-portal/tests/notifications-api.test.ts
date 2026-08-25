import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

/*
 * The admin bell reads ONE person's notifications.
 *
 * An admin's Directus policy grants a broad read on the collection — against
 * the live database `a.dawoud` could read all 99 rows and not one was addressed
 * to them. So the permission cannot be the filter, and this asserts the query
 * carries its own.
 */

/* All three via vi.hoisted: vi.mock factories are hoisted above these
   declarations, so a plain `const` would be in its temporal dead zone. */
const { request, readItems } = vi.hoisted(() => ({
  request: vi.fn(async () => []),
  readItems: vi.fn((collection: string, opts: unknown) => ({ collection, opts })),
}));
vi.mock('../src/lib/directus.js', () => ({ directus: { request } }));
vi.mock('@directus/sdk', () => ({ readItems, updateItem: vi.fn() }));

const auth = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock('../src/lib/auth/AuthContext.js', () => auth);

import { useNotifications } from '../src/features/notifications/api.js';

function run() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
  return renderHook(() => useNotifications(), { wrapper });
}

beforeEach(() => {
  request.mockClear();
  readItems.mockClear();
});

describe('admin notifications query', () => {
  it('asks only for rows addressed to the signed-in admin', async () => {
    auth.useAuth.mockReturnValue({ user: { id: 'admin-1' } });
    run();
    // The query runs on mount; wait a tick for react-query to fire it.
    await new Promise((r) => setTimeout(r, 0));

    expect(readItems).toHaveBeenCalled();
    const [, opts] = readItems.mock.calls[0] as [string, { filter?: unknown }];
    expect(opts.filter).toEqual({ recipient: { _eq: 'admin-1' } });
  });

  it('asks for NOTHING until the user id is known', async () => {
    /*
     * Not merely an optimisation. Firing unfiltered and narrowing afterwards
     * would put every agent's notifications into the badge for one render —
     * exactly the wrong number, briefly shown.
     */
    auth.useAuth.mockReturnValue({ user: null });
    run();
    await new Promise((r) => setTimeout(r, 0));

    expect(request).not.toHaveBeenCalled();
  });
});
