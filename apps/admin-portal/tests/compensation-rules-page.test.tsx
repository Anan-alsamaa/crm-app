import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CompensationRule } from '@yiji/shared-types';

/**
 * THE COMPENSATION RULES PAGE (owner, 2026-10-27): list, create/edit, turn
 * on/off, delete, the optional per-customer limit - and gated on
 * `manage_compensation_rules`.
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown> & { defaultValue?: string }) => {
      let s = (o?.defaultValue ?? k) as string;
      for (const [key, val] of Object.entries(o ?? {})) {
        if (key !== 'defaultValue')
          s = s.replace(new RegExp(`{{\\s*${key}\\s*}}`, 'g'), String(val));
      }
      return s;
    },
    i18n: { language: 'en', changeLanguage: vi.fn(), dir: () => 'ltr' },
  }),
}));

const api = vi.hoisted(() => ({
  useCompensationRules: vi.fn(),
  useSaveCompensationRule: vi.fn(),
  useToggleCompensationRule: vi.fn(),
  useDeleteCompensationRule: vi.fn(),
  useRuleLimitSetting: vi.fn(),
  useSaveRuleLimit: vi.fn(),
}));
vi.mock('../src/features/compensation-rules/api.js', () => api);
vi.mock('../src/lib/option-lists.js', async (orig) => {
  const actual = await orig<typeof import('../src/lib/option-lists.js')>();
  return { ...actual, useOptionLists: () => ({ data: undefined }) };
});

import {
  CompensationRulesPage,
  valuesOf,
} from '../src/features/compensation-rules/CompensationRulesPage.js';
import { navItemAllowed } from '../src/nav.js';
import { PolicyPills } from '../src/features/coupon-approvals/PolicyPills.js';

/** A portal file, whether the suite runs from the repo root or the app. */
const readSrc = (rel: string) =>
  readFileSync(
    [resolve(process.cwd(), rel), resolve(process.cwd(), 'apps/admin-portal', rel)].find((f) =>
      existsSync(f),
    )!,
    'utf8',
  );

const RULE: CompensationRule = {
  id: 'r1',
  name: 'Late order 30',
  active: true,
  priority: 2,
  complaint_type: 'Late order',
  service_type: 'Delivery',
  min_delay_minutes: 45,
  discount_category: 'Amount',
  coupon_value: 30,
  validity_days: 14,
  usage_limit: 1,
  delivery_type: 'All',
  coupon_type: 'Private',
  issuing_side: 'Customer Care',
};

const save = vi.fn();
const toggle = vi.fn();
const remove = vi.fn();
const saveLimit = vi.fn();

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<CompensationRulesPage />, { wrapper: Wrapper });
}

beforeEach(() => {
  for (const f of [save, toggle, remove, saveLimit]) f.mockReset();
  api.useCompensationRules.mockReturnValue({ data: [RULE], isLoading: false, isError: false });
  api.useSaveCompensationRule.mockReturnValue({ mutate: save, isPending: false });
  api.useToggleCompensationRule.mockReturnValue({ mutate: toggle, isPending: false });
  api.useDeleteCompensationRule.mockReturnValue({ mutate: remove, isPending: false });
  api.useRuleLimitSetting.mockReturnValue({
    data: { rowId: null, enabled: false, maxPerCustomer: null, windowDays: null, effective: null },
    isLoading: false,
  });
  api.useSaveRuleLimit.mockReturnValue({ mutate: saveLimit, isPending: false });
});

describe('CompensationRulesPage', () => {
  it('lists each rule with its conditions and the coupon it gives', () => {
    renderPage();
    const row = screen.getByText('Late order 30').closest('tr')!;
    expect(within(row).getByText('Late order')).toBeTruthy();
    expect(row.textContent).toContain('Delivery · ≥ 45 min late');
    expect(row.textContent).toContain('30 SAR · 14 days');
    expect(row.textContent).toContain('Active');
  });

  it('shows a clear empty state when there are no rules', () => {
    api.useCompensationRules.mockReturnValue({ data: [], isLoading: false, isError: false });
    renderPage();
    expect(screen.getByText('No compensation rules yet')).toBeTruthy();
    expect(screen.getByText(/nothing is pre-filled for agents/)).toBeTruthy();
  });

  it('turns a rule off without opening it', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    expect(toggle).toHaveBeenCalledWith({ id: 'r1', active: false }, expect.anything());
  });

  it('deletes only after confirming', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(remove).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(remove).toHaveBeenCalledWith('r1', expect.anything());
  });

  it('edits a rule: the form opens on its values and saves the same row', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const name = screen.getByLabelText('Name') as HTMLInputElement;
    expect(name.value).toBe('Late order 30');
    await userEvent.clear(name);
    await userEvent.type(name, 'Late order 35');
    const value = screen.getByLabelText('Value (SAR)') as HTMLInputElement;
    await userEvent.clear(value);
    await userEvent.type(value, '35');
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));
    expect(save).toHaveBeenCalledTimes(1);
    const [{ id, values }] = save.mock.calls[0]!;
    expect(id).toBe('r1');
    expect(values).toMatchObject({
      name: 'Late order 35',
      coupon_value: 35,
      coupon_percent: null,
      complaint_type: 'Late order',
      service_type: 'Delivery',
      min_delay_minutes: 45,
      validity_days: 14,
    });
  });

  it('a new rule cannot be saved until it is complete', async () => {
    renderPage();
    await userEvent.click(screen.getAllByRole('button', { name: 'New rule' })[0]!);
    const saveBtn = within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' });
    expect((saveBtn as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText('Give the rule a name.').length).toBeGreaterThan(0);
  });

  it('the per-customer limit: off by default, saved as a whole', async () => {
    renderPage();
    const max = screen.getByLabelText('At most') as HTMLInputElement;
    expect(max.disabled).toBe(true);
    await userEvent.click(screen.getByLabelText('Limit rule coupons per customer'));
    await userEvent.type(max, '2');
    await userEvent.type(screen.getByLabelText('In the last (days)'), '30');
    const saveButtons = screen.getAllByRole('button', { name: 'Save' });
    await userEvent.click(saveButtons[saveButtons.length - 1]!);
    expect(saveLimit).toHaveBeenCalledWith(
      { rowId: null, enabled: true, maxPerCustomer: 2, windowDays: 30 },
      expect.anything(),
    );
  });
});

describe('valuesOf', () => {
  it('clears the money field that does not apply', () => {
    const base = {
      name: ' R ',
      active: true,
      priority: '',
      complaint_type: 'Order cold',
      service_type: '',
      min_delay_minutes: '',
      min_order_value: '',
      max_order_value: '',
      discount_category: 'Percentage',
      coupon_value: '50',
      coupon_percent: '20',
      max_discount: '40',
      validity_days: '',
      usage_limit: '',
      delivery_type: '',
      coupon_type: '',
      issuing_side: '',
      no_other_discounts: false,
      note: ' ',
    };
    expect(valuesOf(base)).toMatchObject({
      name: 'R',
      priority: 0,
      service_type: null,
      discount_category: 'Percentage',
      coupon_value: null,
      coupon_percent: 20,
      max_discount: 40,
      validity_days: null,
      usage_limit: 1,
      delivery_type: 'All',
      coupon_type: 'Private',
      issuing_side: 'Customer Care',
      note: null,
    });
  });
});

describe('privilege gating', () => {
  const app = readSrc('src/App.tsx');

  it('the route is guarded by manage_compensation_rules', () => {
    expect(app).toMatch(
      /path="\/compensation-rules"\s*element=\{\s*<ProtectedRoute requires="manage_compensation_rules">/,
    );
  });

  it('the nav entry is shown only to a holder', () => {
    expect(app).toMatch(/to: '\/compensation-rules',\s*requires: 'manage_compensation_rules'/);
    const item = { requires: 'manage_compensation_rules' as const };
    expect(navItemAllowed(item, { can: () => false, isOwner: false })).toBe(false);
    expect(
      navItemAllowed(item, { can: (p) => p === 'manage_compensation_rules', isOwner: false }),
    ).toBe(true);
  });
});

describe('i18n: every new key has EN and AR', () => {
  const read = (lang: string) =>
    JSON.parse(readSrc(`src/i18n/${lang}.json`)) as Record<string, Record<string, unknown>>;
  it('compRules + the nav, role and approval-card keys', () => {
    const en = read('en');
    const ar = read('ar');
    expect(Object.keys(ar.compRules ?? {}).sort()).toEqual(Object.keys(en.compRules ?? {}).sort());
    expect(Object.keys(en.compRules ?? {}).length).toBeGreaterThan(40);
    for (const tree of [en, ar]) {
      expect(tree.nav?.compensationRules).toBeTruthy();
      expect((tree.roles?.p as Record<string, string>)?.manageCompensationRules).toBeTruthy();
      expect(tree.couponApprovals?.differsFromPolicy).toBeTruthy();
      expect(tree.couponApprovals?.fromRule).toBeTruthy();
    }
    expect(ar.compRules?.emptyTitle).not.toBe(en.compRules?.emptyTitle);
  });
});

describe('the approval card pills', () => {
  it('names the rule, and flags a coupon that differs from it', () => {
    const { rerender } = render(
      <PolicyPills rule={{ id: 'r1', name: 'Late 30' }} differs={false} />,
    );
    expect(screen.getByText('Rule: Late 30')).toBeTruthy();
    expect(screen.queryByText('Differs from policy')).toBeNull();
    rerender(<PolicyPills rule={{ id: 'r1', name: 'Late 30' }} differs />);
    expect(screen.getByText('Differs from policy')).toBeTruthy();
    rerender(<PolicyPills rule={null} differs />);
    expect(screen.queryByText('Differs from policy')).toBeNull();
    expect(screen.queryByText(/Rule:/)).toBeNull();
  });
});
