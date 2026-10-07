import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactNode } from 'react';
import React from 'react';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request } }));
vi.mock('../src/lib/commerce-client.js', () => ({ commerce: {} }));

import { lateOrderTicket, useLateOrderComplaintTypes } from '../src/features/late-orders/api.js';

/**
 * EMA-32 (owner, 2026-10-07): operations renamed every late-order cause, so the
 * built-in two-entry map matched nothing and tickets were filed under the raw
 * cause ("late preparation") — a complaint type the dropdown does not have.
 * Operations now pair each cause with a complaint type in `app_settings`, and
 * the ticket a late order raises must use that pairing.
 */
function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const row = {
  orderId: '1323291',
  status: 'in_kitchen',
  minutesElapsed: 75,
  placedAt: '2026-10-07T12:00:00',
  customerPhone: '+966545808075',
};

function ticketFor(kind: string, complaintTypes?: Record<string, string> | null) {
  return lateOrderTicket({
    row,
    kind,
    reason: 'Kitchen backed up',
    contactId: null,
    vendorId: null,
    agentId: null,
    complaintTypes,
  });
}

beforeEach(() => request.mockReset());

describe('useLateOrderComplaintTypes', () => {
  it('reads the pairing stored as JSON text', async () => {
    request.mockResolvedValueOnce([
      { value: '{"late preparation":"Instore preparation late order"}' },
    ]);
    const { result } = renderHook(() => useLateOrderComplaintTypes(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({
      'late preparation': 'Instore preparation late order',
    });
  });

  /* Never blocks the page: a refused or failed read is the built-in behaviour. */
  it('resolves to no pairing when the read fails', async () => {
    request.mockRejectedValueOnce(new Error('403'));
    const { result } = renderHook(() => useLateOrderComplaintTypes(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({});
  });

  it('resolves to no pairing when the row does not exist yet', async () => {
    request.mockResolvedValueOnce([]);
    const { result } = renderHook(() => useLateOrderComplaintTypes(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({});
  });
});

describe('the late-order ticket uses operations’ pairing', () => {
  it('files a paired cause under the chosen complaint type', async () => {
    request.mockResolvedValueOnce([
      { value: '{"late preparation":"Instore preparation late order"}' },
    ]);
    const { result } = renderHook(() => useLateOrderComplaintTypes(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const ticket = ticketFor('late preparation', result.current.data);
    expect(ticket.complaint_type).toBe('Instore preparation late order');
    expect(ticket.subject).toBe('Instore preparation late order');
  });

  it('falls back to the built-in map, then the cause’s own name, without a pairing', () => {
    expect(ticketFor('late_preparation').complaint_type).toBe('Instore preparation late order');
    expect(ticketFor('late preparation', {}).complaint_type).toBe('late preparation');
    expect(ticketFor('late preparation', null).complaint_type).toBe('late preparation');
  });

  /* Both callers on the page pass the pairing — the ticket AND the warning
     that names the type before the agent confirms, so the two cannot disagree. */
  it('the page passes the pairing to both callers', () => {
    const page = readFileSync(
      resolve(import.meta.dirname, '../src/features/late-orders/LateOrdersPage.tsx'),
      'utf8',
    );
    expect(page).toMatch(/useLateOrderComplaintTypes\(\)/);
    expect(page).toMatch(/complaintTypes: complaintTypes\.data/);
    expect(page).toMatch(/lateOrderComplaintType\(kindOf\(draft\.row\), complaintTypes\.data\)/);
  });
});
