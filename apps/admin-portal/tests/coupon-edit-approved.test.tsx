import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

describe('Edit coupon on an approved card', () => {
  it('is offered to a holder of edit_approved_coupons', () => {
    renderPage([approved]);
    expect(screen.getByRole('button', { name: 'Edit coupon' })).toBeInTheDocument();
  });

  it('is not offered without the privilege', () => {
    grants.edit = false;
    renderPage([approved]);
    expect(screen.queryByRole('button', { name: 'Edit coupon' })).not.toBeInTheDocument();
  });

  it('is not offered on a pending request, a replaced coupon or one already used', () => {
    renderPage([
      { ...approved, id: 'p', status: 'pending', ticket: { id: 't2', subject: 'Pending one' } },
      { ...approved, id: 'u', removal_status: 'used', ticket: { id: 't3', subject: 'Used one' } },
    ]);
    expect(screen.queryByRole('button', { name: 'Edit coupon' })).not.toBeInTheDocument();
  });

  it('a replaced coupon says so and offers no edit', () => {
    replacements.links = new Map([
      [
        'ca1',
        {
          id: 'ca1',
          status: 'assigned',
          replaces: null,
          replacedBy: { id: 'ca2', code: 'OPS-NEW22222' },
          reason: 'typo',
          superseded: true,
        },
      ],
    ]);
    renderPage([approved]);
    expect(screen.getByText('Replaced by OPS-NEW22222')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit coupon' })).not.toBeInTheDocument();
  });

  it('Save needs a reason, then hands over the whole edited coupon - and never calls Yiji', async () => {
    const user = userEvent.setup();
    renderPage([approved]);
    await user.click(screen.getByRole('button', { name: 'Edit coupon' }));
    const save = screen.getByRole('button', { name: 'Save and replace' });
    expect(save).toBeDisabled();

    const value = screen.getByLabelText('Coupon value (SAR)');
    await user.clear(value);
    await user.type(value, '40');
    await user.type(
      screen.getByPlaceholderText('Why is this approved coupon being changed?'),
      'Wrong amount',
    );
    expect(save).toBeEnabled();
    await user.click(save);

    expect(replacements.mutate).toHaveBeenCalledTimes(1);
    const [input] = replacements.mutate.mock.calls[0]!;
    expect(input).toMatchObject({
      reason: 'Wrong amount',
      editorId: 'sup-1',
      old: { id: 'ca1' },
      terms: {
        coupon_value: 40,
        max_discount: 40,
        coupon_percent: null,
        issuing_side: 'Operations',
      },
    });
    expect(commerceCalls).toEqual([]);
  });

  it('an EXPIRED coupon says editing creates a fresh one', async () => {
    const user = userEvent.setup();
    renderPage([{ ...approved, valid_to: '2026-01-01' }]);
    await user.click(screen.getByRole('button', { name: 'Edit coupon' }));
    expect(screen.getByText(/expired on 2026-01-01/)).toBeInTheDocument();
  });
});
