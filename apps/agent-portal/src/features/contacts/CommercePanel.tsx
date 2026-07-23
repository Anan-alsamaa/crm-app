import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Skeleton } from '@yiji/ui';
import type { YijiPurchaseActivity } from '@yiji/shared-types';
import { commerce } from '../../lib/commerce-client.js';
import { CustomerOrders } from '../commerce/OrderViews.js';

/**
 * Commerce side panel.
 *
 * Consumes the ai-gateway commerce PROXY (C-2) — the Yiji API key stays on the
 * server. Renders lifetime value + the customer's latest orders as expandable
 * rows (id/status/total collapsed; items + full details on click). Every section
 * degrades gracefully — if the proxy returns null the panel shows a soft
 * "Commerce data unavailable" notice rather than crashing.
 */

interface Props {
  yijiVendorId: string;
  externalCustomerId: string;
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function CommercePanel({ yijiVendorId, externalCustomerId }: Props) {
  const { t } = useTranslation();

  const activity = useQuery({
    queryKey: ['yiji-activity', yijiVendorId, externalCustomerId],
    enabled: !!yijiVendorId && !!externalCustomerId,
    queryFn: () => commerce.getPurchaseActivity(yijiVendorId, externalCustomerId),
    staleTime: 60_000,
  });

  if (!yijiVendorId || !externalCustomerId) {
    return (
      <div className="rounded-2xl bg-card/60 ring-1 ring-foreground/[0.04] px-5 py-4">
        <p className="text-xs text-muted-foreground">
          {t('commerce.noLink', {
            defaultValue: 'No Yiji customer linked — commerce data not available.',
          })}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Activity summary */}
      <div className="rounded-2xl bg-card/70 ring-1 ring-foreground/[0.04] shadow-soft px-5 py-4">
        <h3 className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {t('commerce.activity', { defaultValue: 'Lifetime activity' })}
        </h3>
        {activity.isLoading ? (
          <div className="mt-3 space-y-2">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-4 w-20" />
          </div>
        ) : activity.data ? (
          <ActivitySummary data={activity.data} />
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            {t('commerce.unavailable', { defaultValue: 'Commerce data unavailable.' })}
          </p>
        )}
      </div>

      {/* Latest orders — expandable rows (direct data, no AI) */}
      <CustomerOrders vendorId={yijiVendorId} customerId={externalCustomerId} limit={5} />
    </div>
  );
}

function ActivitySummary({ data }: { data: YijiPurchaseActivity }) {
  const { t } = useTranslation();
  return (
    <div className="mt-2 space-y-2">
      <div className="flex items-baseline gap-3">
        <span className="text-2xl font-semibold tracking-tight tabular-nums text-foreground">
          {formatMoney(data.lifetimeValue, 'SAR')}
        </span>
        <span className="text-xs text-muted-foreground">
          {t('commerce.ltv', { defaultValue: 'lifetime value' })}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-muted-foreground tabular-nums">
        <span>
          <strong className="font-medium text-foreground">{data.orderCount}</strong>{' '}
          {t('commerce.orders', { defaultValue: 'orders' })}
        </span>
        {data.lastOrderAt && (
          <span>
            {t('commerce.lastOrder', { defaultValue: 'last order' })}:{' '}
            <strong className="font-medium text-foreground">
              {new Date(data.lastOrderAt).toLocaleDateString()}
            </strong>
          </span>
        )}
      </div>
    </div>
  );
}
