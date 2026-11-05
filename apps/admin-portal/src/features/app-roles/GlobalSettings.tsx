import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createItem, readItems, updateItem } from '@directus/sdk';
import { useTranslation } from 'react-i18next';
import { cn, toast } from '@yiji/ui';
import {
  COUPONS_MAINTENANCE_SETTING_KEY,
  couponsMaintenanceValue,
  parseCouponsMaintenance,
} from '@yiji/shared-types';
import { directus } from '../../lib/directus.js';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { SECTION_CARD } from '../../components/shell/Page.js';

/**
 * GLOBAL SETTINGS (owner, 2026-11-05): switches that apply to EVERY user at
 * once, not to one role - so they sit beside the roles, not inside one.
 *
 * Today: "Coupons under maintenance". On = no coupon is raised from the agent
 * portal by anyone (the notice shows in every coupon place). Only the
 * Administrator may flip it; everyone else sees its state.
 */
const KEY = ['app-settings', COUPONS_MAINTENANCE_SETTING_KEY] as const;

interface SettingRow {
  id: string;
  value: unknown;
}

function useCouponsMaintenanceSetting() {
  return useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const rows = (await directus.request(
        readItems(
          'app_settings' as never,
          {
            filter: { key: { _eq: COUPONS_MAINTENANCE_SETTING_KEY } },
            fields: ['id', 'value'],
            limit: 1,
          } as never,
        ),
      )) as unknown as SettingRow[];
      const row = rows[0] ?? null;
      return { rowId: row?.id ?? null, on: parseCouponsMaintenance(row?.value) };
    },
  });
}

export function GlobalSettingsCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { isOwner } = useAuth();
  const setting = useCouponsMaintenanceSetting();
  const save = useMutation({
    mutationFn: async (on: boolean) => {
      const value = couponsMaintenanceValue(on);
      const rowId = setting.data?.rowId ?? null;
      return rowId
        ? directus.request(updateItem('app_settings' as never, rowId, { value } as never))
        : directus.request(
            createItem(
              'app_settings' as never,
              { key: COUPONS_MAINTENANCE_SETTING_KEY, value } as never,
            ),
          );
    },
    onSuccess: (_d, on) => {
      void qc.invalidateQueries({ queryKey: KEY });
      toast.success(
        on
          ? t('globalSettings.couponsPaused', {
              defaultValue: 'Coupons are now under maintenance for every user.',
            })
          : t('globalSettings.couponsResumed', {
              defaultValue: 'Coupons are back on for every user.',
            }),
      );
    },
    onError: () =>
      toast.error(t('globalSettings.saveError', { defaultValue: 'Could not save that setting' })),
  });

  const on = setting.data?.on ?? true;
  const disabled = !isOwner || setting.isLoading || save.isPending;

  return (
    <section
      data-testid="global-settings"
      className={cn(SECTION_CARD, 'mt-5 overflow-hidden')}
      aria-labelledby="global-settings-title"
    >
      <div className="border-b border-foreground/[0.07] px-4 py-3">
        <h2
          id="global-settings-title"
          className="text-sm font-semibold tracking-tight text-foreground"
        >
          {t('globalSettings.title', { defaultValue: 'Global settings' })}
        </h2>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          {t('globalSettings.subtitle', {
            defaultValue: 'These apply to every user at once, whatever their role.',
          })}
        </p>
      </div>
      <label
        className={cn(
          'flex items-start gap-3 px-4 py-3.5',
          disabled ? 'cursor-not-allowed' : 'cursor-pointer',
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-foreground">
            {t('globalSettings.couponsMaintenance', {
              defaultValue: 'Coupons under maintenance',
            })}
          </span>
          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
            {t('globalSettings.couponsMaintenanceHint', {
              defaultValue:
                'On: no coupon can be raised from the agent portal by anyone, and agents see the maintenance notice. Off: coupons work as normal.',
            })}
          </span>
          {!isOwner && (
            <span className="mt-1 block text-2xs font-medium text-muted-foreground">
              {t('globalSettings.ownerOnly', {
                defaultValue: 'Only the Administrator can change this.',
              })}
            </span>
          )}
        </span>
        <span className={cn('relative mt-0.5 inline-flex shrink-0', disabled && 'opacity-60')}>
          <input
            type="checkbox"
            role="switch"
            data-testid="coupons-maintenance-switch"
            className="peer sr-only"
            checked={on}
            disabled={disabled}
            aria-checked={on}
            onChange={(e) => save.mutate(e.target.checked)}
          />
          <span
            aria-hidden
            className="block h-6 w-11 rounded-full bg-foreground/15 transition-colors duration-fast peer-checked:bg-warning peer-focus-visible:ring-2 peer-focus-visible:ring-ring/50 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-card"
          />
          <span
            aria-hidden
            className="pointer-events-none absolute start-0.5 top-0.5 h-5 w-5 rounded-full bg-card shadow-md transition-all duration-fast peer-checked:start-[1.375rem] motion-reduce:transition-none"
          />
        </span>
      </label>
    </section>
  );
}
