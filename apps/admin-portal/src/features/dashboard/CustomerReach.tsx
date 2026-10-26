import type { JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { aggregate } from '@directus/sdk';
import { ProgressRing, SplitBar, UsersIcon } from '@yiji/ui';
import { directus } from '../../lib/directus.js';
import { BentoCard, CountUp } from '../../components/dash/Dash.js';

/**
 * How many of our customers are actually in the Yiji app.
 *
 * A contact carries `external_customer_id` when it has ever been resolved to a
 * Yiji customer — which is what "has an account" means in every part of this
 * product that matters: it is the id order lookups, purchase history and
 * coupon delivery are all keyed on. A contact without one can still be helped,
 * but every one of those becomes manual.
 *
 * FOLLOWS THE DASHBOARD'S FILTERS (owner, 2026-10-26). With nothing applied
 * it is the whole customer base, as before. Once a date range or any filter is
 * applied it becomes the customers behind the tickets in view - otherwise it
 * kept showing the unfiltered base beside numbers that had all moved, which
 * read as wrong data. The hint under the title says which one is showing.
 *
 * Counted with Directus `aggregate` rather than by reading the rows: this only
 * ever needs two numbers, and pulling every contact to length-check an array
 * would grow with the customer base for no gain.
 */

interface Props {
  className?: string;
  /**
   * The customers behind the dashboard's filtered tickets, or null when no
   * filter is applied (then the card counts the whole customer base).
   */
  scoped?: { total: number; withYiji: number } | null;
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

function useCustomerReach(enabled: boolean) {
  return useQuery({
    queryKey: ['customer-reach'],
    enabled,
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

export function CustomerReach({ className, scoped = null }: Props): JSX.Element | null {
  const { t } = useTranslation();
  const q = useCustomerReach(!scoped);

  // A permissions gap or a dead request should cost the dashboard a card, not
  // put a zero on screen that reads as "nobody uses the app".
  if (!scoped && q.isError) return null;

  const d = scoped
    ? {
        total: scoped.total,
        withYiji: Math.min(scoped.withYiji, scoped.total),
        without: Math.max(scoped.total - scoped.withYiji, 0),
      }
    : q.data;
  const pct = d && d.total > 0 ? (d.withYiji / d.total) * 100 : 0;

  return (
    <BentoCard
      tone="teal"
      icon={<UsersIcon size={17} />}
      className={className}
      title={t('customerReach.title', { defaultValue: 'Yiji vs non-Yiji customers' })}
      hint={
        scoped
          ? t('customerReach.noteFiltered', {
              defaultValue: 'Customers behind the tickets matching these filters',
            })
          : t('customerReach.note', {
              defaultValue: 'All customers — not the selected range',
            })
      }
    >
      {!d ? (
        <div className="h-20 animate-pulse rounded-xl bg-secondary/60" />
      ) : (
        <div className="grid gap-5">
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
                <span className="text-3xl font-extrabold leading-none tracking-[-0.03em] tabular-nums text-foreground">
                  <CountUp value={d.withYiji} />
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
    </BentoCard>
  );
}
