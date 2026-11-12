import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * EDIT AN APPROVED COUPON from the Coupon approvals card (owner, 2026-10-27):
 * offered only to `edit_approved_coupons`, only on an approval that can still
 * be edited, and Save hands over the WHOLE edited coupon plus the reason. The
 * card never asks Yiji anything - "was it used?" is the workers' question.
 */
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

const grants = vi.hoisted(() => ({ edit: true }));
vi.mock('../src/lib/auth/AuthContext.js', () => ({
  useAuth: () => ({
    user: { id: 'sup-1', first_name: 'Nadia' },
    can: (priv: string) => (priv === 'edit_approved_coupons' ? grants.edit : true),
  }),
}));

const api = vi.hoisted(() => ({
  useCouponApprovals: vi.fn(),
  useDecideCoupon: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useSaveCouponTerms: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useRetryCouponDelivery: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));
vi.mock('../src/features/coupon-approvals/api.js', () => api);

const replacements = vi.hoisted(() => ({
  links: new Map<string, unknown>(),
  mutate: vi.fn(),
}));
vi.mock('../src/features/coupon-approvals/replacements.js', () => ({
  useCouponReplacements: () => ({ data: replacements.links }),
  useReplaceCoupon: () => ({ mutate: replacements.mutate, isPending: false }),
}));
/* The card must never call Yiji: every commerce method is a recorded spy. */
const commerceCalls = vi.hoisted(() => [] as string[]);
vi.mock('../src/lib/commerce-client.js', () => ({
  commerce: new Proxy(
    {},
    {
      get: (_t, key) =>
        typeof key === 'symbol' || key === 'then'
          ? undefined
          : () => {
              commerceCalls.push(String(key));
              return Promise.resolve(null);
            },
    },
  ),
}));

import { CouponApprovalsPage } from '../src/features/coupon-approvals/CouponApprovalsPage.js';

const future = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
const approved = {
  id: 'ca1',
  coupon_code: 'OPS-OLD11111',
  coupon_value: 25,
  coupon_percent: null,
  compensation: 'Compensated',
  reason: 'Missing items',
  status: 'assigned' as const,
  title: '0545808075',
  issuing_side: 'Operations',
  delivery_type: 'All',
  coupon_type: 'Private',
  discount_category: 'Amount',
  valid_from: '2026-10-01',
  valid_to: future,
  max_discount: 25,
  usage_limit: 1,
  total_discount_limit: '25.00000',
  item_name: null,
  item_sku: null,
  no_other_discounts: false,
  customer_phone: null,
  brand_id: null,
  restaurant_id: null,
  edited_by_admin: false,
  yiji_coupon_user_id: '27507',
  yiji_pushed_at: '2026-10-01T10:00:00Z',
  yiji_push_error: null,
  delivery_excluded: false,
  delivery_excluded_reason: null,
  decided_at: '2026-10-01T10:00:00Z',
  decision_note: null,
  date_created: '2026-10-01T09:00:00Z',
  order_id: null,
  ticket: { id: 't1', subject: 'Missing item' },
  contact: { id: 'k1', name: 'Saad', phone: '0545808075' },
  requested_by: { id: 'a1', first_name: 'Sara', email: 's@x' },
  decided_by: { id: 'sup-0', first_name: 'Omar', email: 'o@x' },
};

function renderPage(rows: unknown[]) {
  api.useCouponApprovals.mockReturnValue({ data: rows, isLoading: false });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<CouponApprovalsPage />, { wrapper: Wrapper });
}

beforeEach(() => {
  grants.edit = true;
  replacements.links = new Map();
  replacements.mutate.mockReset();
  commerceCalls.length = 0;
});

/* EDIT AN APPROVED COUPON was REMOVED (owner, 2026-11-12): an approved coupon
   is never changed after it is assigned - not even by a holder of the old
   privilege, and never by the Yiji-unsafe remove-and-reissue. */
describe('editing an approved coupon was removed', () => {
  it('no Edit coupon on an approved card, even with the old privilege', () => {
    grants.edit = true;
    renderPage([approved]);
    expect(screen.queryByRole('button', { name: 'Edit coupon' })).not.toBeInTheDocument();
    expect(replacements.mutate).not.toHaveBeenCalled();
  });
});
