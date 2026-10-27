import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';
import type { CompensationRule } from '@yiji/shared-types';

/*
 * THE COMPENSATION RULES ON THE ADD-TICKET FORM (owner, 2026-10-27).
 *
 * Picking the complaint type pre-fills the coupon section with the matching
 * rule's suggestion. Accepted as is, the request names the rule and does NOT
 * differ from policy; adjusted, it carries `differs_from_policy`; switched off,
 * no coupon is requested and nothing is pre-filled again; no rule, nothing.
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown> & { defaultValue?: string }) => {
      let s = (o?.defaultValue ?? k) as string;
      for (const [key, val] of Object.entries(o ?? {})) {
        if (key !== 'defaultValue') s = s.replace(`{{${key}}}`, String(val));
      }
      return s;
    },
    i18n: { language: 'en' },
  }),
}));
vi.mock('../src/lib/auth/AuthContext.js', () => ({
  useAuth: () => ({ user: { id: 'agent-1' }, can: () => true }),
}));

vi.mock('../src/lib/directus.js', () => ({
  directus: {
    request: async (cmd: () => { method?: string; path: string }) => {
      const c = cmd();
      if ((c.method ?? 'GET') === 'GET' && c.path.startsWith('/items/contacts/')) {
        return {
          id: 'contact-1',
          phone: '0500000000',
          name: null,
          external_customer_id: null,
          vendor: 'vendor-yiji',
        };
      }
      return (c.method ?? 'GET') === 'GET' ? [] : {};
    },
  },
  isForbidden: () => false,
  assetUrl: (id: string) => id,
  DIRECTUS_URL: 'http://directus.test',
}));

const hooks = vi.hoisted(() => ({
  useCreateTicketFromConversation: vi.fn(),
  useConversationAttachmentIds: vi.fn(() => ({ data: [] })),
  useStoreNotifyTypes: vi.fn(() => ({ data: [] })),
  useUpdateTicket: vi.fn(),
}));
vi.mock('../src/features/tickets/api.js', () => hooks);

const coupons = vi.hoisted(() => ({
  useRequestCouponApproval: vi.fn(),
  useCouponCodeTaken: vi.fn(() => ({ data: false })),
}));
vi.mock('../src/features/coupons/api.js', () => coupons);

const rules = vi.hoisted(() => ({
  list: [] as CompensationRule[],
  limit: { reached: false, limit: null as null | { maxPerCustomer: number; windowDays: number } },
}));
vi.mock('../src/features/coupons/compensation-rules.js', () => ({
  useCompensationRules: () => ({ data: rules.list, isLoading: false }),
  useRuleLimitReached: () => ({ data: rules.limit }),
}));

const store = vi.hoisted(() => ({
  id: 's1',
  code: 'LCP-001',
  name: 'Test Branch',
  city: 'Riyadh',
  areaManager: 'AM',
  chainManager: 'CM',
  brandName: 'Casa Pasta',
  brandYijiName: null,
  yijiRestaurantId: '9',
}));
vi.mock('../src/features/tickets/useStoreMatch.js', () => ({
  useStores: () => ({ data: [store], isLoading: false }),
  useStoreIndex: () => ({ index: {}, isLoading: false, count: 1 }),
  toStoreRecord: (s: unknown) => s,
  useOrderStore: () => ({
    store: null,
    via: 'none',
    restaurantName: '',
    brandName: '',
    city: '',
    areaManager: '',
    chainManager: '',
  }),
}));

import { CreateTicketDialog } from '../src/features/tickets/CreateTicketDialog.js';

const DRAFT_KEY = 'yiji.agent.ticketDraft.agent-1.standalone';

const RULE: CompensationRule = {
  id: 'rule-missing',
  name: 'Missing item 30',
  active: true,
  priority: 0,
  complaint_type: 'Missing item',
  discount_category: 'Amount',
  coupon_value: 30,
};

function seedDraft(extra: Record<string, unknown> = {}) {
  sessionStorage.setItem(
    DRAFT_KEY,
    JSON.stringify({
      v: 1,
      savedAt: new Date().toISOString(),
      form: {
        description: 'The fries were missing',
        priority: 'medium',
        complaint: {},
        typedOrderId: '',
        lookupId: '',
        storeId: 's1',
        assignCoupon: false,
        collectedCoupon: null,
        includeOrder: true,
        includeFiles: true,
        ...extra,
      },
    }),
  );
}

let createTicket: ReturnType<typeof vi.fn>;
let requestCoupon: ReturnType<typeof vi.fn>;

function renderForm() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const onCreated = vi.fn();
  render(
    <CreateTicketDialog
      contactId="contact-1"
      vendorId="vendor-yiji"
      conversationId={null}
      onClose={vi.fn()}
      onCreated={onCreated}
    />,
    { wrapper: Wrapper },
  );
  return { onCreated };
}

async function chooseComplaintType(label: string) {
  const field = screen.getByText('Ticket type').parentElement!.querySelector('input')!;
  await userEvent.click(field);
  await userEvent.clear(field);
  await userEvent.type(field, label);
  await userEvent.click(await screen.findByRole('option', { name: label }));
}

const couponBox = () => screen.getByRole('checkbox', { name: /Assign a coupon/ });

async function submit() {
  const btn = document.querySelector('button[type="submit"]') as HTMLButtonElement;
  await waitFor(() => expect(btn.disabled).toBe(false));
  await userEvent.click(btn);
}

beforeEach(() => {
  sessionStorage.clear();
  rules.list = [RULE];
  rules.limit = { reached: false, limit: null };
  createTicket = vi.fn().mockResolvedValue({ id: 'tk-1', storeNotify: 'skip' });
  requestCoupon = vi.fn().mockResolvedValue({ id: 'ca1' });
  hooks.useCreateTicketFromConversation.mockReturnValue({ mutateAsync: createTicket });
  hooks.useUpdateTicket.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}) });
  coupons.useRequestCouponApproval.mockReturnValue({ mutateAsync: requestCoupon });
  seedDraft();
});

describe('pre-fill from the compensation rules', () => {
  it('picking the complaint type pre-fills the rule’s coupon; accepted, it names the rule and does not differ', async () => {
    const { onCreated } = renderForm();
    expect(couponBox()).not.toBeChecked();
    await chooseComplaintType('Missing item');
    await waitFor(() => expect(couponBox()).toBeChecked());
    expect(screen.getByTestId('coupon-rule-line').textContent).toContain('Missing item 30');
    expect(screen.queryByText('Differs from policy')).toBeNull();

    await submit();
    await waitFor(() => expect(requestCoupon).toHaveBeenCalledTimes(1));
    const input = requestCoupon.mock.calls[0]![0];
    expect(input).toMatchObject({
      ticket: 'tk-1',
      contact: 'contact-1',
      coupon_value: 30,
      max_discount: 30,
      discount_category: 'Amount',
      coupon_type: 'Private',
      issuing_side: 'Customer Care',
      policy_rule: 'rule-missing',
      differs_from_policy: false,
      // Filled at send time from the form, not from when the rule matched.
      title: '0500000000',
      restaurant_id: '9',
      brand_id: 'Casa Pasta',
      reason: 'The fries were missing',
    });
    expect(input.coupon_code).toMatch(/^CC-/);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('tk-1'));
  });

  it('no matching rule: nothing is pre-filled and no coupon is requested', async () => {
    rules.list = [{ ...RULE, complaint_type: 'Order cold' }];
    renderForm();
    await chooseComplaintType('Missing item');
    expect(couponBox()).not.toBeChecked();
    expect(screen.queryByTestId('coupon-rule-line')).toBeNull();
    await submit();
    await waitFor(() => expect(createTicket).toHaveBeenCalled());
    expect(requestCoupon).not.toHaveBeenCalled();
  });

  it('switched off: no coupon, and changing the type does not pre-fill it again', async () => {
    rules.list = [
      RULE,
      { ...RULE, id: 'rule-cold', name: 'Cold 10', complaint_type: 'Order cold' },
    ];
    renderForm();
    await chooseComplaintType('Missing item');
    await waitFor(() => expect(couponBox()).toBeChecked());
    await userEvent.click(couponBox());
    expect(couponBox()).not.toBeChecked();
    await chooseComplaintType('Order cold');
    expect(couponBox()).not.toBeChecked();
    await submit();
    await waitFor(() => expect(createTicket).toHaveBeenCalled());
    expect(requestCoupon).not.toHaveBeenCalled();
  });

  it('an untouched suggestion follows the type: another rule replaces it', async () => {
    rules.list = [
      RULE,
      { ...RULE, id: 'rule-cold', name: 'Cold 10', complaint_type: 'Order cold', coupon_value: 10 },
    ];
    renderForm();
    await chooseComplaintType('Missing item');
    await waitFor(() => expect(couponBox()).toBeChecked());
    await chooseComplaintType('Order cold');
    await waitFor(() =>
      expect(screen.getByTestId('coupon-rule-line').textContent).toContain('Cold 10'),
    );
    await submit();
    await waitFor(() => expect(requestCoupon).toHaveBeenCalledTimes(1));
    expect(requestCoupon.mock.calls[0]![0]).toMatchObject({
      policy_rule: 'rule-cold',
      coupon_value: 10,
    });
  });

  it('adjusted: the pill shows and the request carries differs_from_policy', async () => {
    const suggested = {
      title: '',
      code: 'CC-AAAA2222',
      issuing_side: 'Customer Care',
      delivery_type: 'All',
      coupon_type: 'Private',
      discount_category: 'Amount',
      valid_from: '2026-10-27',
      valid_to: '2026-11-27',
      coupon_value: 30,
      coupon_percent: null,
      max_discount: 30,
      usage_limit: 1,
      compensation_reason: '',
      brand_id: null,
      restaurant_id: null,
      item_name: null,
      item_sku: null,
      no_other_discounts: false,
      delivery_excluded: false,
      delivery_excluded_reason: null,
    };
    seedDraft({
      complaint: { complaint_type: 'Missing item' },
      assignCoupon: true,
      collectedCoupon: { ...suggested, coupon_value: 50, max_discount: 50 },
      couponRule: { id: 'rule-missing', name: 'Missing item 30', suggested },
    });
    renderForm();
    expect(screen.getByText('Differs from policy')).toBeTruthy();
    await submit();
    await waitFor(() => expect(requestCoupon).toHaveBeenCalledTimes(1));
    expect(requestCoupon.mock.calls[0]![0]).toMatchObject({
      coupon_value: 50,
      policy_rule: 'rule-missing',
      differs_from_policy: true,
    });
  });

  it('the customer at the per-customer limit: nothing pre-filled, the agent is told', async () => {
    rules.limit = { reached: true, limit: { maxPerCustomer: 2, windowDays: 30 } };
    renderForm();
    await chooseComplaintType('Missing item');
    expect(couponBox()).not.toBeChecked();
    expect(screen.getByText(/already had 2 rule coupon\(s\) in the last 30 days/)).toBeTruthy();
  });

  it('a coupon the agent made by hand (no rule) never carries the policy fields', async () => {
    rules.list = [];
    const manual = {
      title: '0500000000',
      code: 'CC-HAND2222',
      issuing_side: 'Customer Care',
      delivery_type: 'All',
      coupon_type: 'Private',
      discount_category: 'Amount',
      valid_from: '2026-10-27',
      valid_to: '2026-11-27',
      coupon_value: 15,
      coupon_percent: null,
      max_discount: 15,
      usage_limit: 1,
      compensation_reason: 'by hand',
      brand_id: null,
      restaurant_id: '9',
      item_name: null,
      item_sku: null,
      no_other_discounts: false,
      delivery_excluded: false,
      delivery_excluded_reason: null,
    };
    seedDraft({ assignCoupon: true, collectedCoupon: manual });
    renderForm();
    await chooseComplaintType('Missing item');
    await submit();
    await waitFor(() => expect(requestCoupon).toHaveBeenCalledTimes(1));
    const input = requestCoupon.mock.calls[0]![0];
    expect(input).not.toHaveProperty('policy_rule');
    expect(input).not.toHaveProperty('differs_from_policy');
  });
});
