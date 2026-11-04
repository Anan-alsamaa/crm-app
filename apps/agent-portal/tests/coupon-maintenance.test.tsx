import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * COUPONS UNDER MAINTENANCE (owner, 2026-11-04).
 *
 * Until the total limit is fixed, no coupon may be raised from this portal.
 * The flag is the REAL one here - this file fails the moment someone turns
 * coupons back on without the fix, which is the point.
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

import { COUPONS_UNDER_MAINTENANCE } from '../src/features/coupons/maintenance.js';
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

beforeEach(() => {
  sdk.request.mockReset();
  producer.replaceCoupon.mockReset();
});

describe('coupons under maintenance', () => {
  it('is ON until the total-limit fix ships', () => {
    expect(COUPONS_UNDER_MAINTENANCE).toBe(true);
  });

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
    expect(sdk.request).not.toHaveBeenCalled();
  });
});
