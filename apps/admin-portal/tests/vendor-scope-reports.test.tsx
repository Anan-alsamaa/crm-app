import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/*
 * MV-7: the compensation reports and the late-orders register follow the
 * shared report vendor filter. With ONE active vendor the control does not
 * render and every request is byte-identical to before (no vendor clause, no
 * `vendorId` param); with 2+ vendors a chosen vendor scopes each read.
 */

const db = vi.hoisted(() => ({
  vendors: [] as Array<{ id: string; name: string; status?: string }>,
  calls: [] as Array<{ collection: string; query: Record<string, unknown> }>,
}));

vi.mock('@directus/sdk', () => ({
  readItems: (collection: string, query: Record<string, unknown> = {}) => ({ collection, query }),
}));
vi.mock('../src/lib/directus.js', () => ({
  directus: {
    request: vi.fn(async (req: { collection: string; query: Record<string, unknown> }) => {
      if (req.collection === 'vendors') return db.vendors;
      db.calls.push(req);
      return [];
    }),
  },
}));
const commerce = vi.hoisted(() => ({
  getLateOrders: vi.fn(async () => ({ rows: [] })),
  getOrderEventTimes: vi.fn(async () => ({})),
}));
vi.mock('../src/lib/commerce-client.js', () => ({ commerce }));
vi.mock('../src/lib/auth/AuthContext.js', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
    i18n: { language: 'en' },
  }),
}));

import { resetReportVendor, useReportVendor } from '../src/lib/report-vendor.js';
import { useAllCoupons } from '../src/features/coupon-approvals/AllCompensationPage.js';
import {
  CouponReportPage,
  useCouponFacts,
} from '../src/features/coupon-approvals/CouponReportPage.js';
import {
  useLateOrderDecisions,
  useLateOrderEventTimes,
  useLateOrderQueue,
} from '../src/features/late-orders/api.js';

const ONE = [
  { id: 'v-yiji', name: 'Yiji', status: 'active' },
  { id: 'v-two', name: 'Second', status: 'inactive' },
];
const TWO = [
  { id: 'v-yiji', name: 'Yiji', status: 'active' },
  { id: 'v-two', name: 'Second', status: 'active' },
];

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

/**
 * Loads the vendor list (as the page's filter control does), waits for it, and
 * with 2+ vendors picks the second one, as an admin would in the control.
 */
async function vendorsLoaded(show: boolean) {
  const { result } = renderHook(() => useReportVendor(), { wrapper: wrapper() });
  await waitFor(() => expect(result.current.show).toBe(show));
  if (show) {
    act(() => result.current.setVendor('v-two'));
    await waitFor(() => expect(result.current.vendor).toBe('v-two'));
  }
}

const callsTo = (collection: string) => db.calls.filter((c) => c.collection === collection);

/* The choice is module state shared across files in one fork: leave none behind. */
afterAll(() => resetReportVendor());

beforeEach(() => {
  db.calls = [];
  commerce.getLateOrders.mockClear();
  commerce.getOrderEventTimes.mockClear();
  resetReportVendor();
});

describe('compensation reports', () => {
  it('one vendor: no filter control, and the coupon reads carry no vendor clause', async () => {
    db.vendors = ONE;
    render(<CouponReportPage />, { wrapper: wrapper() });
    await waitFor(() => expect(callsTo('coupon_approvals')).toHaveLength(1));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.queryByText('Vendor')).toBeNull();
    expect(callsTo('coupon_approvals')[0]!.query).not.toHaveProperty('filter');

    db.calls = [];
    renderHook(() => useAllCoupons(), { wrapper: wrapper() });
    await waitFor(() => expect(callsTo('coupon_approvals')).toHaveLength(1));
    expect(callsTo('coupon_approvals')[0]!.query).not.toHaveProperty('filter');
  });

  it('two vendors: the control shows and a chosen vendor scopes both reports', async () => {
    db.vendors = TWO;
    await vendorsLoaded(true);
    render(<CouponReportPage />, { wrapper: wrapper() });
    expect(await screen.findByText('Vendor')).toBeTruthy();
    await waitFor(() =>
      expect(
        callsTo('coupon_approvals').some((c) =>
          JSON.stringify(c.query.filter ?? null).includes('"vendor":{"_eq":"v-two"}'),
        ),
      ).toBe(true),
    );

    db.calls = [];
    renderHook(() => useAllCoupons(), { wrapper: wrapper() });
    await waitFor(() => expect(callsTo('coupon_approvals')).toHaveLength(1));
    expect(callsTo('coupon_approvals')[0]!.query.filter).toEqual({
      _and: [{ vendor: { _eq: 'v-two' } }],
    });

    db.calls = [];
    renderHook(() => useCouponFacts(), { wrapper: wrapper() });
    await waitFor(() => expect(callsTo('coupon_approvals')).toHaveLength(1));
    expect(callsTo('coupon_approvals')[0]!.query.filter).toEqual({
      _and: [{ vendor: { _eq: 'v-two' } }],
    });
  });
});

describe('late-orders register', () => {
  const FROM = '2026-10-01T00:00:00';
  const TO = '2026-10-08T00:00:00';

  it('one vendor: the gateway is asked exactly as before and decisions are unfiltered', async () => {
    db.vendors = ONE;
    await vendorsLoaded(false);
    const w = wrapper();
    renderHook(() => useLateOrderQueue(FROM, TO), { wrapper: w });
    renderHook(() => useLateOrderEventTimes(['111', '222']), { wrapper: w });
    renderHook(() => useLateOrderDecisions(FROM, TO), { wrapper: w });
    await waitFor(() => expect(commerce.getLateOrders).toHaveBeenCalled());
    await waitFor(() => expect(commerce.getOrderEventTimes).toHaveBeenCalled());
    await waitFor(() => expect(callsTo('late_order_decisions')).toHaveLength(1));
    // No second argument at all — not even `undefined`.
    expect(commerce.getLateOrders.mock.calls[0]).toEqual([
      { from: '2026-10-01', to: '2026-10-08' },
    ]);
    expect(commerce.getOrderEventTimes.mock.calls[0]).toEqual([['111', '222']]);
    expect(callsTo('late_order_decisions')[0]!.query.filter).toEqual({
      date_created: { _between: [FROM, TO] },
    });
  });

  it("two vendors: the chosen vendor's CRM id goes to the gateway and the decisions", async () => {
    db.vendors = TWO;
    await vendorsLoaded(true);
    const w = wrapper();
    renderHook(() => useLateOrderQueue(FROM, TO), { wrapper: w });
    renderHook(() => useLateOrderEventTimes(['111']), { wrapper: w });
    renderHook(() => useLateOrderDecisions(FROM, TO), { wrapper: w });
    await waitFor(() => expect(commerce.getLateOrders).toHaveBeenCalled());
    await waitFor(() => expect(commerce.getOrderEventTimes).toHaveBeenCalled());
    await waitFor(() => expect(callsTo('late_order_decisions')).toHaveLength(1));
    expect(commerce.getLateOrders.mock.calls[0]).toEqual([
      { from: '2026-10-01', to: '2026-10-08' },
      'v-two',
    ]);
    expect(commerce.getOrderEventTimes.mock.calls[0]).toEqual([['111'], 'v-two']);
    expect(callsTo('late_order_decisions')[0]!.query.filter).toEqual({
      _and: [{ date_created: { _between: [FROM, TO] } }, { vendor: { _eq: 'v-two' } }],
    });
  });
});
