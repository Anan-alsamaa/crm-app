import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * COUPONS UNDER MAINTENANCE (owner, 2026-11-04; a live switch 2026-11-05).
 *
 * The Administrator's switch (Roles & privileges -> Global settings) is one
 * `app_settings` row. The REAL module is used here: the setting read goes
 * through the mocked Directus client, and anything but an explicit "false"
 * keeps coupons paused.
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
    i18n: { language: 'en', changeLanguage: vi.fn(), dir: () => 'ltr' },
  }),
}));
const sdk = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request: sdk.request } }));
const producer = vi.hoisted(() => ({ replaceCoupon: vi.fn(), removeCoupon: vi.fn() }));
vi.mock('../src/lib/job-producer.js', () => ({ jobProducer: producer }));
vi.mock('../src/lib/auth/AuthContext.js', () => ({
  useAuth: () => ({ user: { id: 'agent-1' } }),
}));

import { parseCouponsMaintenance } from '@yiji/shared-types';
import { useRequestCouponApproval } from '../src/features/coupons/api.js';
import { CouponRequestDialog } from '../src/features/coupons/CouponRequestDialog.js';
import { CouponMaintenancePill } from '../src/features/coupons/CouponMaintenance.js';

const wrap = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
  >
    {children}
  </QueryClientProvider>
);

/* The switch row as Directus returns it; ON unless a test says otherwise. */
const setting = { value: 'true' as unknown };
beforeEach(() => {
  setting.value = 'true';
  sdk.request.mockReset();
  sdk.request.mockImplementation(async () => [{ value: setting.value }]);
  producer.replaceCoupon.mockReset();
});

describe('the switch is fail-safe', () => {
  it('only an explicit off resumes coupons', () => {
    expect(parseCouponsMaintenance('false')).toBe(false);
    expect(parseCouponsMaintenance(false)).toBe(false);
    expect(parseCouponsMaintenance('off')).toBe(false);
    for (const v of ['true', true, undefined, null, '', 'yes', 'garbage']) {
      expect(parseCouponsMaintenance(v)).toBe(true);
    }
  });

  it('a failed read keeps coupons paused', async () => {
    sdk.request.mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useRequestCouponApproval(), { wrapper: wrap });
    await expect(
      result.current.mutateAsync({ id: 'r1', title: '0501234567' } as never),
    ).rejects.toThrow(/under maintenance/);
  });

  it('switched OFF, the coupon form opens with the total discount limit box', async () => {
    setting.value = 'false';
    render(
      <CouponRequestDialog
        open
        onClose={vi.fn()}
        contactId="k1"
        customerPhone="0501234567"
        description={null}
        brandId={null}
        restaurantId={null}
        requestedBy="agent-1"
      />,
      { wrapper: wrap },
    );
    expect(await screen.findByLabelText(/coupon value/i)).toBeInTheDocument();
    expect(screen.queryByTestId('coupon-maintenance')).not.toBeInTheDocument();
  });
});

describe('coupons under maintenance', () => {
  it('the coupon form shows the notice, with nothing to send', async () => {
    const onClose = vi.fn();
    render(
      <CouponRequestDialog
        open
        onClose={onClose}
        contactId="k1"
        customerPhone="0501234567"
        description={null}
        brandId={null}
        restaurantId={null}
        requestedBy="agent-1"
      />,
      {
        wrapper: wrap,
      },
    );
    expect(screen.getAllByText('Coupons are under maintenance').length).toBeGreaterThan(0);
    expect(screen.getByTestId('coupon-maintenance')).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('button', { name: /send|request/i })).not.toBeInTheDocument();
    /* The drawer's own X and the footer's Close: both just close it. */
    const closes = screen.getAllByRole('button', { name: 'Close' });
    await userEvent.click(closes[closes.length - 1]!);
    expect(onClose).toHaveBeenCalled();
  });

  /* White warning ink on the pale wash measured ~1.3:1 - unreadable (seen on
     staging 2026-11-04). The chip uses the warning hue itself. */
  it('the chip is readable: never the white warning ink on the pale wash', () => {
    render(<CouponMaintenancePill />);
    const chip = screen.getByTestId('coupon-maintenance');
    expect(chip.className).not.toMatch(/text-warning-foreground/);
    expect(chip.className.split(' ')).toContain('text-warning');
    expect(chip).toHaveTextContent('Coupons under maintenance');
  });

  it('a request that still gets through is refused before anything is written', async () => {
    const { result } = renderHook(() => useRequestCouponApproval(), { wrapper: wrap });
    await expect(
      result.current.mutateAsync({ id: 'r1', title: '0501234567' } as never),
    ).rejects.toThrow(/under maintenance/);
    /* Only the switch was read - nothing was written. */
    expect(sdk.request).toHaveBeenCalledTimes(1);
  });
});
