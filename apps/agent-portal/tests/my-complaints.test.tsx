import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

const request = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/directus.js', () => ({ directus: { request } }));

import { toComplaintRow, useMyComplaints } from '../src/features/complaints/api.js';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

/** Directus SDK commands are thunks resolving to {path, params, ...}. */
async function sentParams(call = 0): Promise<Record<string, unknown>> {
  const cmd = request.mock.calls[call]![0] as (c: unknown) => Promise<{
    params?: Record<string, unknown>;
  }>;
  return (await cmd({ globals: {} })).params ?? {};
}

const ticket = {
  id: 'tk-1',
  status: 'open',
  subject: 'Cold delivery',
  complaint_date: '2026-07-30T18:05:00',
  first_responded_at: null,
  first_response_due_at: null,
  date_created: '2026-08-01T10:30:00',
  description: 'Order arrived cold',
  complaint_type: 'Food quality',
  service_type: 'Delivery',
  complaint_source: 'Chat',
  communication_method: 'WhatsApp',
  response_desc: 'Refunded',
  compensation: 'Coupon',
  coupon_code: 'SORRY10',
  coupon_value: '25 SR',
  coupon_percent: 10,
  order_snapshot: {
    orderId: 946641,
    total: '102.85 SR',
    brandName: 'La Casa Pasta',
    restaurantName: 'Riyadh - Masief Plaza',
  },
  store_snapshot: null,
  contact: { name: 'Alice', phone: '+966501234567' },
};

beforeEach(() => request.mockReset());

describe('an agent reads their OWN complaints', () => {
  it('states the scope in the query rather than relying on the role', async () => {
    request.mockResolvedValueOnce([]);
    renderHook(() => useMyComplaints(30, 'Sara'), { wrapper });
    await waitFor(() => expect(request).toHaveBeenCalled());

    const params = await sentParams();
    // Directus already scopes the Agent role to assigned_agent = $CURRENT_USER,
    // so this is belt-and-braces — but the page PROMISES "my complaints", and a
    // table that silently widens when a role permission is loosened, while still
    // titled "mine", is the failure this pins shut.
    expect(JSON.stringify(params.filter)).toContain('$CURRENT_USER');
    expect(JSON.stringify(params.filter)).toContain('assigned_agent');
  });

  it('asks only for the window it displays', async () => {
    request.mockResolvedValueOnce([]);
    renderHook(() => useMyComplaints(7, 'Sara'), { wrapper });
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(JSON.stringify(await sentParams())).toContain('_gte');
  });

  it('maps a ticket into the ops report row', async () => {
    request.mockResolvedValueOnce([ticket]);
    const { result } = renderHook(() => useMyComplaints(30, 'Sara'), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());

    const r = result.current.data![0]!;
    // Dated by when the complaint HAPPENED (30 Jul), not when the ticket was
    // typed in (1 Aug). Getting this backwards files a Friday complaint under
    // Sunday in every ops report.
    expect(r.date).toBe('2026-07-30');
    expect(r.time).toBe('18:05');
    expect(r.orderNumber).toBe('946641');
    // "102.85 SR" must land as a number Excel can sum, not a string.
    expect(r.orderAmount).toBe(102.85);
    expect(r.couponValue).toBe(25);
    expect(r.customerMobile).toBe('+966501234567');
    expect(r.agent).toBe('Sara');
    // Store columns stay blank until the page joins them, so an unjoined row
    // is visibly unjoined rather than confidently wrong.
    expect(r.city).toBe('');
    expect(r.storeMapped).toBe(false);
  });
});

describe('dating a complaint', () => {
  it('falls back to the creation date for tickets raised before the field existed', async () => {
    request.mockResolvedValueOnce([{ ...ticket, complaint_date: null }]);
    const { result } = renderHook(() => useMyComplaints(30, 'Sara'), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    // Blank would drop the row out of every date-grouped report.
    expect(result.current.data![0]!.date).toBe('2026-08-01');
  });
});

describe('toComplaintRow', () => {
  it('survives a ticket with nothing filled in', () => {
    const bare = toComplaintRow(
      {
        id: 'tk-2',
        status: 'pending',
        subject: null,
        complaint_date: null,
        first_responded_at: null,
        first_response_due_at: null,
        date_created: null,
        description: null,
        complaint_type: null,
        service_type: null,
        complaint_source: null,
        communication_method: null,
        response_desc: null,
        compensation: null,
        coupon_code: null,
        coupon_value: null,
        coupon_percent: null,
        order_snapshot: null,
        store_snapshot: null,
        contact: null,
      },
      'Sara',
    );
    expect(bare.orderAmount).toBeNull();
    expect(bare.orderNumber).toBe('');
    expect(bare.customerName).toBe('');
    expect(bare.date).toBe('');
    expect(bare.complaintStatus).toBe('pending');
  });
});
