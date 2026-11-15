import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * EDIT AN APPROVED COUPON from the Coupon approvals card (owner, 2026-11-15:
 * "we want it in the Coupon approvals page in the admin portal", not on the
 * ticket). Offered only to `edit_approved_coupons`, only on an approval that
 * can still be edited, and Save hands the workers the WHOLE edited coupon
 * (judged against the stored one, so one changed value keeps every other),
 * the reason, and the version the editor opened. The card never asks Yiji
 * anything - "was it used?" is the workers' question.
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

const edit = vi.hoisted(() => ({ mutateAsync: vi.fn() }));
const api = vi.hoisted(() => ({
  useCouponApprovals: vi.fn(),
  useDecideCoupon: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useSaveCouponTerms: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useRetryCouponDelivery: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useEditApprovedCoupon: vi.fn(() => ({ mutateAsync: edit.mutateAsync, isPending: false })),
}));
vi.mock('../src/features/coupon-approvals/api.js', () => api);

const maintenance = vi.hoisted(() => ({ paused: false }));
vi.mock('../src/features/coupon-approvals/maintenance.js', () => ({
  useCouponsUnderMaintenance: () => maintenance.paused,
  assertCouponsOpen: async () => {},
}));

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

import { couponTermsVersion } from '@yiji/shared-types';
import {
  CouponApprovalsPage,
  canOfferCouponEdit,
} from '../src/features/coupon-approvals/CouponApprovalsPage.js';

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

/* The page opens on the pending queue; a delivered coupon lives under the
   Approved tab (or All), so every test looks where the card is. */
function renderPage(rows: unknown[], view: 'approved' | 'all' = 'approved') {
  api.useCouponApprovals.mockReturnValue({ data: rows, isLoading: false });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const r = render(<CouponApprovalsPage />, { wrapper: Wrapper });
  fireEvent.click(screen.getByRole('button', { name: view }));
  return r;
}

beforeEach(() => {
  grants.edit = true;
  maintenance.paused = false;
  replacements.links = new Map();
  replacements.mutate.mockReset();
  edit.mutateAsync.mockReset();
  edit.mutateAsync.mockResolvedValue({ state: 'done', note: null });
  commerceCalls.length = 0;
});

const user = () => userEvent.setup({ delay: null });
/* The card's notices live in its open body. */
const expandFirst = () => fireEvent.click(screen.getAllByRole('button', { expanded: false })[0]!);
const REASON = 'Why is this approved coupon being changed?';

describe('who sees "Edit coupon" on an approval card', () => {
  it('a holder of the privilege, on a delivered coupon that can still be edited', () => {
    renderPage([approved]);
    expect(screen.getByRole('button', { name: 'Edit coupon' })).toBeInTheDocument();
  });
  it('nobody without the privilege', () => {
    grants.edit = false;
    renderPage([approved]);
    expect(screen.queryByRole('button', { name: 'Edit coupon' })).not.toBeInTheDocument();
  });
  it('not on a pending request (that one has the amend "Edit"), nor a rejected one', () => {
    renderPage(
      [
        { ...approved, id: 'p1', status: 'pending', yiji_coupon_user_id: null },
        { ...approved, id: 'r1', status: 'rejected' },
      ],
      'all',
    );
    expect(screen.queryByRole('button', { name: 'Edit coupon' })).not.toBeInTheDocument();
  });
  it('not on a used, removed, replaced or frozen (edit running) coupon', () => {
    const base = { id: 'x', status: 'assigned', removal_status: null, yiji_used_order: null };
    expect(canOfferCouponEdit(base as never, null, true)).toBe(true);
    expect(canOfferCouponEdit({ ...base, yiji_used_order: '1374000' } as never, null, true)).toBe(
      false,
    );
    expect(canOfferCouponEdit({ ...base, removal_status: 'removed' } as never, null, true)).toBe(
      false,
    );
    expect(canOfferCouponEdit({ ...base, removal_status: 'pending' } as never, null, true)).toBe(
      false,
    );
    expect(canOfferCouponEdit(base as never, { id: 'new' }, true)).toBe(false);
    expect(canOfferCouponEdit({ ...base, edit_state: 'frozen' } as never, null, true)).toBe(false);
    expect(canOfferCouponEdit(base as never, null, false)).toBe(false);
  });
  it('an edit still running shows as such, with no button', () => {
    renderPage([{ ...approved, edit_state: 'frozen' }]);
    expect(screen.queryByRole('button', { name: 'Edit coupon' })).not.toBeInTheDocument();
    expandFirst();
    expect(screen.queryByRole('button', { name: 'Edit coupon' })).not.toBeInTheDocument();
    expect(screen.getByText(/being edited/i)).toBeInTheDocument();
  });
  it("a refused edit says why, in the workers' words", () => {
    renderPage([{ ...approved, edit_state: 'refused', edit_detail: 'used on order 1374000' }]);
    expandFirst();
    expect(screen.getByText(/last edit not applied: used on order 1374000/i)).toBeInTheDocument();
  });
  it('coupons under maintenance: the notice, not a button', () => {
    maintenance.paused = true;
    renderPage([approved]);
    expect(screen.queryByRole('button', { name: 'Edit coupon' })).not.toBeInTheDocument();
    expandFirst();
    expect(screen.queryByRole('button', { name: 'Edit coupon' })).not.toBeInTheDocument();
    expect(screen.getByText(/coupons under maintenance/i)).toBeInTheDocument();
  });
});

describe('saving an edit from the card', () => {
  it('opens the form on the stored values, code locked, and needs a reason', async () => {
    const u = user();
    renderPage([approved]);
    await u.click(screen.getByRole('button', { name: 'Edit coupon' }));
    expect(screen.getByLabelText('Coupon code')).toBeDisabled();
    expect(screen.getByLabelText('Coupon code')).toHaveValue('OPS-OLD11111');
    expect(screen.getByLabelText(/coupon value/i)).toHaveValue(25);
    /* The request's order box belongs to a pending request, not to an edit. */
    expect(screen.queryByLabelText(/yiji order/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await u.type(screen.getByPlaceholderText(REASON), 'Agreed with the customer');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('a save that changes nothing sends nothing', async () => {
    const u = user();
    renderPage([approved]);
    await u.click(screen.getByRole('button', { name: 'Edit coupon' }));
    await u.type(screen.getByPlaceholderText(REASON), 'no change');
    await u.click(screen.getByRole('button', { name: 'Save' }));
    expect(edit.mutateAsync).not.toHaveBeenCalled();
  });

  it('one changed value goes out as the WHOLE coupon, with the reason and the opened version', async () => {
    const u = user();
    renderPage([approved]);
    await u.click(screen.getByRole('button', { name: 'Edit coupon' }));
    const amount = screen.getByLabelText(/coupon value/i);
    await u.clear(amount);
    await u.type(amount, '30');
    await u.type(screen.getByPlaceholderText(REASON), 'Agreed 30');
    await u.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(edit.mutateAsync).toHaveBeenCalledTimes(1));
    const sent = edit.mutateAsync.mock.calls[0]![0] as {
      id: string;
      terms: Record<string, unknown>;
      reason: string;
      basedOn: string;
    };
    expect(sent.id).toBe('ca1');
    expect(sent.reason).toBe('Agreed 30');
    expect(sent.basedOn).toBe(couponTermsVersion(approved as never));
    /* The money moved: value, its ceiling and the Private total follow. */
    expect(sent.terms).toMatchObject({
      coupon_value: 30,
      coupon_percent: null,
      max_discount: 30,
      total_discount_limit: 30,
      usage_limit: 1,
      coupon_type: 'Private',
      discount_category: 'Amount',
      valid_from: '2026-10-01',
      valid_to: future,
      title: '0545808075',
      issuing_side: 'Operations',
      reason: 'Missing items',
    });
    /* The form closes on a settled outcome; nothing was asked of Yiji. */
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument(),
    );
    expect(commerceCalls).toEqual([]);
    expect(replacements.mutate).not.toHaveBeenCalled();
  });

  it('a refusal from the workers is shown and the form closes', async () => {
    edit.mutateAsync.mockResolvedValue({ state: 'refused', note: 'the customer used it' });
    const u = user();
    renderPage([approved]);
    await u.click(screen.getByRole('button', { name: 'Edit coupon' }));
    const amount = screen.getByLabelText(/coupon value/i);
    await u.clear(amount);
    await u.type(amount, '30');
    await u.type(screen.getByPlaceholderText(REASON), 'x');
    await u.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(edit.mutateAsync).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument(),
    );
  });
});
