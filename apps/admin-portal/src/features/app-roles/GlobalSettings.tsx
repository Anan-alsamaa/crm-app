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

  const hint = t('globalSettings.couponsMaintenanceHint', {
    defaultValue:
      'On: no coupon can be raised from the agent portal by anyone, and agents see the maintenance notice. Off: coupons work as normal.',
  });
  const ownerOnly = t('globalSettings.ownerOnly', {
    defaultValue: 'Only the Administrator can change this.',
  });

  /* A compact control in the page header's top corner (owner, 2026-11-05):
     a switch for EVERY user belongs above the roles, not under their list.
     Amber while coupons are paused, so the state reads at a glance. */
  return (
    <section
      data-testid="global-settings"
      aria-labelledby="global-settings-title"
      title={isOwner ? hint : `${hint}\n${ownerOnly}`}
      className={cn(
        'rounded-2xl shadow-soft ring-1 transition-colors duration-fast',
        on ? 'bg-warning/10 ring-warning/40' : 'bg-card ring-foreground/[0.06]',
      )}
    >
      <label
        className={cn(
          'flex items-center gap-3 py-2 pe-3 ps-4',
          disabled ? 'cursor-not-allowed' : 'cursor-pointer',
        )}
      >
        <span className="min-w-0">
          <span
            id="global-settings-title"
            className="block text-2xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            {t('globalSettings.eyebrow', { defaultValue: 'Global setting · every user' })}
          </span>
          <span className="block text-sm font-semibold text-foreground">
            {t('globalSettings.couponsMaintenance', {
              defaultValue: 'Coupons under maintenance',
            })}
          </span>
          <span className="sr-only">
            {t('globalSettings.subtitle', {
              defaultValue: 'These apply to every user at once, whatever their role.',
            })}{' '}
            {hint}
          </span>
          {!isOwner && (
            <span className="block text-2xs font-medium text-muted-foreground">{ownerOnly}</span>
          )}
        </span>
        <span
          aria-hidden
          className={cn(
            'text-xs font-semibold tabular-nums',
            on ? 'text-foreground' : 'text-muted-foreground',
          )}
        >
          {on
            ? t('globalSettings.on', { defaultValue: 'On' })
            : t('globalSettings.off', { defaultValue: 'Off' })}
        </span>
        <span className={cn('relative inline-flex shrink-0', disabled && 'opacity-60')}>
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
