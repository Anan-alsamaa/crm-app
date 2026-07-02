import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? _k,
  }),
}));

// Control the data + flow-trigger via a hoisted handle.
const h = vi.hoisted(() => ({
  requests: { data: [] as unknown[], isLoading: false, isError: false },
  request: { data: null as unknown, isLoading: false },
  items: { data: [] as unknown[] },
  mutate: vi.fn(),
}));
vi.mock('../src/features/compensation/api.js', () => ({
  COMPENSATION_STATUSES: ['Pending', 'In Progress', 'Approved', 'Rejected'],
  useCompensationRequests: () => h.requests,
  useCompensationRequest: () => h.request,
  useCompensationItems: () => h.items,
  useTriggerCompensationFlow: () => ({ mutate: h.mutate, isPending: false }),
}));

import { CompensationPage } from '../src/features/compensation/CompensationPage.js';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/compensation" element={<CompensationPage />} />
        <Route path="/compensation/:id" element={<CompensationPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const reqBase = {
  id: 'req-1',
  request_code: 'CR-1001',
  customer_name: 'Sara A.',
  customer_mobile: '+966500000011',
  customer_id: 'c1',
  order_id: 'ORD-1',
  order_total: 100,
  brand_name: 'Burger Palace',
  restaurant_name: 'BP Olaya',
  user_complaint_amount: 25,
  complaint_type: { id: 'missing', name: 'Missing items' },
  com_issue: null,
  coupons: null,
  description: 'Missing fries',
  date_created: '2026-06-25T10:00:00Z',
};

beforeEach(() => {
  h.requests = { data: [], isLoading: false, isError: false };
  h.request = { data: null, isLoading: false };
  h.items = { data: [] };
  h.mutate = vi.fn((_vars, opts) => opts?.onSuccess?.());
});

describe('Compensation queue', () => {
  it('lists requests and filters by status', () => {
    h.requests = {
      data: [
        { ...reqBase, id: 'a', request_code: 'CR-A', status: 'Pending' },
        { ...reqBase, id: 'b', request_code: 'CR-B', status: 'Approved' },
      ],
      isLoading: false,
      isError: false,
    };
    renderAt('/compensation');
    expect(screen.getByText('CR-A')).toBeInTheDocument();
    expect(screen.getByText('CR-B')).toBeInTheDocument();

    // Filter to Approved → only CR-B remains.
    fireEvent.click(screen.getByRole('button', { name: 'Approved' }));
    expect(screen.queryByText('CR-A')).not.toBeInTheDocument();
    expect(screen.getByText('CR-B')).toBeInTheDocument();
  });

  it('shows an empty state when there are no requests', () => {
    renderAt('/compensation');
    expect(screen.getByText('No compensation requests')).toBeInTheDocument();
  });
});

// Exact mirror of the Directus admin `links-ycdmfv` button bar.
const EXPECTED_BAR = [
  'Acknowledge',
  'Accept',
  'Reject',
  'Calculate Compensation',
  'Generate Coupon',
  'User Assign Coupon',
  'Close task',
];

describe('Compensation detail — action bar mirrors Directus exactly', () => {
  it('renders all 7 buttons in the exact order, for every status', () => {
    for (const status of ['Pending', 'In Progress', 'Approved', 'Rejected']) {
      h.request = { data: { ...reqBase, status }, isLoading: false };
      const { unmount } = renderAt('/compensation/req-1');
      const bar = screen
        .getAllByRole('button')
        .map((b) => b.textContent?.trim())
        .filter((x) => EXPECTED_BAR.includes(x ?? ''));
      expect(bar).toEqual(EXPECTED_BAR);
      unmount();
    }
  });

  it('does not render actions that are not in the production bar (e.g. Refund)', () => {
    h.request = { data: { ...reqBase, status: 'In Progress' }, isLoading: false };
    renderAt('/compensation/req-1');
    expect(screen.queryByRole('button', { name: 'Refund amount' })).not.toBeInTheDocument();
  });
});

describe('Compensation detail — triggering flows', () => {
  it('Acknowledge (no inputs) triggers its flow after confirm', async () => {
    h.request = { data: { ...reqBase, status: 'Pending' }, isLoading: false };
    renderAt('/compensation/req-1');
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(h.mutate).toHaveBeenCalled());
    expect(h.mutate.mock.calls[0]![0]).toMatchObject({
      flowId: 'f6fc9809-e036-40e8-921c-b1aae3fa4ef5',
      requestId: 'req-1',
      inputs: {},
    });
  });

  it('Reject requires a reason before it will trigger', async () => {
    h.request = { data: { ...reqBase, status: 'Pending' }, isLoading: false };
    renderAt('/compensation/req-1');
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    // Confirm with empty reason → validation error, no trigger.
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(h.mutate).not.toHaveBeenCalled();
    // Fill reason → triggers with the reason input.
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Out of SLA' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(h.mutate).toHaveBeenCalled());
    expect(h.mutate.mock.calls[0]![0]).toMatchObject({
      flowId: '9335c8fb-5744-43cc-9964-6fa0de0bb4d1',
      inputs: { reason: 'Out of SLA' },
    });
  });

  it('Close task triggers the same flow as Accept (6482d337)', async () => {
    h.request = { data: { ...reqBase, status: 'In Progress' }, isLoading: false };
    renderAt('/compensation/req-1');
    fireEvent.click(screen.getByRole('button', { name: 'Close task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(h.mutate).toHaveBeenCalled());
    expect(h.mutate.mock.calls[0]![0]).toMatchObject({
      flowId: '6482d337-286e-4606-98de-21b734796b84',
      requestId: 'req-1',
    });
  });
});
