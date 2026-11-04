import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@yiji/ui';

/*
 * "Coupons are under maintenance" - shown wherever a coupon used to be raised
 * (owner, 2026-11-04; see ./maintenance.ts). Calm, not an error: the rest of
 * the work goes on as normal, so the notice reads as planned work.
 *
 * Motion: the wrench gives a small turn every few seconds and the halo
 * breathes - both `motion-safe:` only, so reduced motion shows them still.
 */

function WrenchGlyph({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cn('shrink-0', className)}
    >
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

/** The animated mark: a tinted disc, a breathing halo, a turning wrench. */
function MaintenanceMark({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const box = size === 'sm' ? 'h-6 w-6' : 'h-10 w-10';
  return (
    <span aria-hidden className={cn('relative inline-flex shrink-0', box)}>
      <span className="absolute inset-0 rounded-full bg-warning/25 motion-safe:animate-soft-pulse" />
      <span className="relative inline-flex h-full w-full items-center justify-center rounded-full bg-warning-tint text-warning ring-1 ring-inset ring-warning/30">
        <WrenchGlyph
          size={size === 'sm' ? 13 : 18}
          className="origin-center motion-safe:animate-tool-nudge"
        />
      </span>
    </span>
  );
}

/** Full notice: in the Create-ticket coupon box and in the coupon drawer. */
export function CouponMaintenancePanel({ className }: { className?: string }): JSX.Element {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      data-testid="coupon-maintenance"
      className={cn(
        'flex items-start gap-3.5 rounded-2xl bg-warning-tint/60 p-4 ring-1 ring-inset ring-warning/20 motion-safe:animate-fade-in',
        className,
      )}
    >
      <MaintenanceMark />
      <div className="min-w-0 space-y-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
          {t('coupons.maintenance.title', { defaultValue: 'Coupons are under maintenance' })}
        </p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t('coupons.maintenance.body', {
            defaultValue:
              'We are improving how coupons are issued, so new coupons cannot be created for now. Everything else works as usual, and coupons customers already have are not affected.',
          })}
        </p>
      </div>
    </div>
  );
}

/** Compact chip: where a button used to be (Late orders table, a ticket). */
export function CouponMaintenancePill({ className }: { className?: string }): JSX.Element {
  const { t } = useTranslation();
  return (
    <span
      role="status"
      data-testid="coupon-maintenance"
      title={t('coupons.maintenance.body', {
        defaultValue:
          'We are improving how coupons are issued, so new coupons cannot be created for now. Everything else works as usual, and coupons customers already have are not affected.',
      })}
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-warning-tint py-0.5 pe-2.5 ps-0.5 text-2xs font-semibold text-warning ring-1 ring-inset ring-warning/25',
        className,
      )}
    >
      <MaintenanceMark size="sm" />
      {t('coupons.maintenance.short', { defaultValue: 'Coupons under maintenance' })}
    </span>
  );
}

/** Icon only: the Late orders board, where each row has one round slot. */
export function CouponMaintenanceIcon(): JSX.Element {
  const { t } = useTranslation();
  const label = t('coupons.maintenance.short', { defaultValue: 'Coupons under maintenance' });
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-testid="coupon-maintenance"
      className="inline-flex h-8 w-8 items-center justify-center"
    >
      <MaintenanceMark size="sm" />
    </span>
  );
}
