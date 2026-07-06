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
  COMPENSATION_STATUSES: [
    'Pending',
    'Acknowledged',
    'Calculating Compensation',
    'Generating Coupon',
    'Assign Coupon to User',
    'Accepted',
    'Closed',
    'Rejected',
  ],
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
  h.mutate = vi.fn((_vars, opts) => {
    opts?.onSuccess?.();
    opts?.onSettled?.();
  });
});

describe('Compensation queue', () => {
  it('lists requests and filters by status', () => {
    h.requests = {
      data: [
        { ...reqBase, id: 'a', request_code: 'CR-A', status: 'Pending' },
        { ...reqBase, id: 'b', request_code: 'CR-B', status: 'Accepted' },
      ],
      isLoading: false,
      isError: false,
    };
    renderAt('/compensation');
    expect(screen.getByText('CR-A')).toBeInTheDocument();
    expect(screen.getByText('CR-B')).toBeInTheDocument();

    // Filter to Accepted → only CR-B remains.
    fireEvent.click(screen.getByRole('button', { name: 'Accepted' }));
    expect(screen.queryByText('CR-A')).not.toBeInTheDocument();
    expect(screen.getByText('CR-B')).toBeInTheDocument();
  });

  it('shows an empty state when there are no requests', () => {
    renderAt('/compensation');
    expect(screen.getByText('No compensation requests')).toBeInTheDocument();
  });
});

// Exact mirror of the Directus admin `links-ycdmfv` button bar (order + labels).
const BAR: Array<[label: string, flowId: string]> = [
  ['Acknowledge', 'f6fc9809-e036-40e8-921c-b1aae3fa4ef5'],
  ['Accept', '6482d337-286e-4606-98de-21b734796b84'],
  ['Reject', '9335c8fb-5744-43cc-9964-6fa0de0bb4d1'],
  ['Calculate Compensation', '90a0639c-1c2d-4eeb-814f-4a4885625ea0'],
  ['Generate Coupon', 'fd7dd27e-fcbe-4447-9864-82817da5fc78'],
  ['User Assign Coupon', '9a09201e-ef25-4202-8afc-5088873b5905'],
  ['Close task', '13011877-701e-4d9c-b31e-711d196d097e'],
];

describe('Compensation detail — action bar mirrors Directus exactly', () => {
  it('renders all 7 buttons in the exact order, for every status', () => {
    const labels = BAR.map(([l]) => l);
    for (const status of ['Pending', 'Acknowledged', 'Accepted', 'Rejected']) {
      h.request = { data: { ...reqBase, status }, isLoading: false };
      const { unmount } = renderAt('/compensation/req-1');
      const bar = screen
        .getAllByRole('button')
        .map((b) => b.textContent?.trim())
        .filter((x) => labels.includes(x ?? ''));
      expect(bar).toEqual(labels);
      unmount();
    }
  });

  it('does not render actions outside the production bar (e.g. Refund)', () => {
    h.request = { data: { ...reqBase, status: 'Pending' }, isLoading: false };
    renderAt('/compensation/req-1');
    expect(screen.queryByRole('button', { name: 'Refund amount' })).not.toBeInTheDocument();
  });
});

describe('Compensation detail — one-click flow triggers (thin surface)', () => {
  it('each button fires its flow directly — no confirm step, no inputs', async () => {
    h.request = { data: { ...reqBase, status: 'Pending' }, isLoading: false };
    renderAt('/compensation/req-1');

    // No confirm/inputs anywhere — one click = one flow run.
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Reason')).not.toBeInTheDocument();

    for (const [label, flowId] of BAR) {
      h.mutate.mockClear();
      fireEvent.click(screen.getByRole('button', { name: label }));
      await waitFor(() => expect(h.mutate).toHaveBeenCalledTimes(1));
      const arg = h.mutate.mock.calls[0]![0];
      expect(arg).toEqual({ flowId, requestId: 'req-1' });
      expect(arg).not.toHaveProperty('inputs');
    }
  });

  it('Close task uses its own flow id (13011877), distinct from Accept', async () => {
    h.request = { data: { ...reqBase, status: 'Accepted' }, isLoading: false };
    renderAt('/compensation/req-1');
    fireEvent.click(screen.getByRole('button', { name: 'Close task' }));
    await waitFor(() => expect(h.mutate).toHaveBeenCalled());
    expect(h.mutate.mock.calls[0]![0]).toMatchObject({
      flowId: '13011877-701e-4d9c-b31e-711d196d097e',
    });
    expect(h.mutate.mock.calls[0]![0].flowId).not.toBe('6482d337-286e-4606-98de-21b734796b84');
  });
});
