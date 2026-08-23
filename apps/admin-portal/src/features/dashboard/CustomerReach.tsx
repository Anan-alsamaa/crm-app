import type { JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { aggregate } from '@directus/sdk';
import { cn, ProgressRing, SplitBar } from '@yiji/ui';
import { directus } from '../../lib/directus.js';

/**
 * How many of our customers are actually in the Yiji app.
 *
 * A contact carries `external_customer_id` when it has ever been resolved to a
 * Yiji customer — which is what "has an account" means in every part of this
 * product that matters: it is the id order lookups, purchase history and
 * coupon delivery are all keyed on. A contact without one can still be helped,
 * but every one of those becomes manual.
 *
 * NOT filtered by the dashboard's date range, and the card says so. "What
 * share of our customers use the app" is a question about the customer base,
 * not about a fortnight; scoping it to the range would make the number swing
 * on how many people happened to write in that week, which is a different
 * question wearing this one's clothes.
 *
 * Counted with Directus `aggregate` rather than by reading the rows: this only
 * ever needs two numbers, and pulling every contact to length-check an array
 * would grow with the customer base for no gain.
 */

interface Props {
  className?: string;
}

/*
 * `_nempty`, not `_neq: ''` — Directus rejects an empty-string comparison
 * outright ("You can't filter for an empty string in _neq"), which returned a
 * 400 and left the card spinning on its skeleton forever. `_nempty` covers
 * both null and '' on its own, so the null check is redundant beside it.
 */
const HAS_YIJI = {
  external_customer_id: { _nempty: true },
} as const;

function useCustomerReach() {
  return useQuery({
    queryKey: ['customer-reach'],
    // The base moves slowly; a minute of staleness is invisible here and saves
    // two round trips on every dashboard filter change.
    staleTime: 60_000,
    queryFn: async () => {
      const count = async (filter?: Record<string, unknown>): Promise<number> => {
        const res = (await directus.request(
          aggregate(
            'contacts' as never,
            {
              aggregate: { count: '*' },
              ...(filter ? { query: { filter } } : {}),
            } as never,
          ),
        )) as unknown as Array<{ count: string | number | null }>;
        const raw = res?.[0]?.count ?? 0;
        return typeof raw === 'number' ? raw : Number(raw) || 0;
      };
      const [total, withYiji] = await Promise.all([count(), count(HAS_YIJI as never)]);
      // Clamped: a filter that silently matched nothing must not produce a
      // negative "without" that then renders as a backwards bar.
      return { total, withYiji: Math.min(withYiji, total), without: Math.max(total - withYiji, 0) };
    },
  });
}

const NUM = new Intl.NumberFormat('en-US');

export function CustomerReach({ className }: Props): JSX.Element | null {
  const { t } = useTranslation();
  const q = useCustomerReach();

  // A permissions gap or a dead request should cost the dashboard a card, not
  // put a zero on screen that reads as "nobody uses the app".
  if (q.isError) return null;

  const d = q.data;
  const pct = d && d.total > 0 ? (d.withYiji / d.total) * 100 : 0;

  return (
    <div
      className={cn(
        'rounded-2xl bg-card px-5 py-4 shadow-soft ring-1 ring-foreground/[0.06] motion-safe:animate-rise-in',
        className,
      )}
    >
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold tracking-tight text-foreground">
          {t('customerReach.title', { defaultValue: 'Yiji vs non-Yiji customers' })}
        </h3>
        <span className="text-2xs text-muted-foreground">
          {t('customerReach.note', { defaultValue: 'All customers — not the selected range' })}
        </span>
      </div>

      {!d ? (
        <div className="h-20 animate-pulse rounded-xl bg-secondary/60" />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[auto_1fr]">
          <div className="flex items-center gap-4">
            <ProgressRing
              value={pct}
              size={72}
              stroke={7}
              tone="primary"
              label={`${Math.round(pct)}%`}
            />
            <div>
              <div className="flex items-baseline gap-1.5">
                <span className="text-3xl font-extrabold leading-none tracking-[-0.03em] tabular-nums text-primary">
                  {NUM.format(d.withYiji)}
                </span>
                <span className="text-xs font-semibold text-muted-foreground">
                  {t('customerReach.of', {
                    defaultValue: 'of {{total}}',
                    total: NUM.format(d.total),
                  })}
                </span>
              </div>
              <div className="mt-1.5 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {t('customerReach.haveAccount', { defaultValue: 'have an app account' })}
              </div>
            </div>
          </div>

          <div className="min-w-0 space-y-3">
            <SplitBar
              parts={[
                {
                  label: t('customerReach.registered', { defaultValue: 'In the app' }),
                  value: d.withYiji,
                  tone: 'primary',
                },
                {
                  label: t('customerReach.walkIn', { defaultValue: 'No app account' }),
                  value: d.without,
                  tone: 'warning',
                },
              ]}
            />
            <p className="text-2xs text-muted-foreground">
              {t('customerReach.explain', {
                defaultValue:
                  'Order history, coupons and compensation resolve automatically for app customers. The rest have to be handled by hand.',
              })}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
