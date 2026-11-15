import { type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { cn, Pill } from '@yiji/ui';
import type { CampaignStatus, MarketingEngine } from '@yiji/shared-types';
import { useEngine } from '../../engine/index.js';
import { SECTION_CARD } from '../../components/shell/Page.js';

/* ── formatting ──────────────────────────────────────────────────────────── */

export const sar = (n: number | null | undefined, digits = 0): string =>
  n === null || n === undefined
    ? '—'
    : `SAR ${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
export const int = (n: number | null | undefined): string =>
  n === null || n === undefined ? '—' : n.toLocaleString('en-US');
export const pct = (n: number | null | undefined, digits = 0): string =>
  n === null || n === undefined ? '—' : `${n.toFixed(digits)}%`;
export const dayLabel = (d: string): string =>
  new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
export const dateLabel = (d: string | null | undefined): string =>
  d
    ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    : '—';
export const today = (): string => new Date().toISOString().slice(0, 10);
export const daysAgo = (n: number): string =>
  new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/* ── one query helper so every page reads the engine the same way ────────── */

export function useEngineQuery<T>(
  key: readonly unknown[],
  fn: (engine: MarketingEngine) => Promise<T>,
  opts: { enabled?: boolean } = {},
): UseQueryResult<T> {
  const engine = useEngine();
  return useQuery({
    queryKey: ['promo', engine.kind, ...key],
    queryFn: () => fn(engine),
    enabled: opts.enabled ?? true,
    staleTime: 15_000,
  });
}

/* ── the five-step workflow strip (Ayman's "Find → Build → Launch → Measure → Evaluate") ─ */

export function WorkflowStrip({ current }: { current: 1 | 2 | 3 | 4 | 5 }) {
  const { t } = useTranslation();
  const steps = [
    {
      n: 1,
      to: '/pre-studies',
      title: t('promo.flow.find', { defaultValue: 'Find opportunities' }),
      body: t('promo.flow.findBody', { defaultValue: 'Pre-study on your orders' }),
    },
    {
      n: 2,
      to: '/pre-studies/cases',
      title: t('promo.flow.build', { defaultValue: 'Build the business case' }),
      body: t('promo.flow.buildBody', { defaultValue: 'Compare scenarios, get approval' }),
    },
    {
      n: 3,
      to: '/coupons',
      title: t('promo.flow.launch', { defaultValue: 'Launch the coupon' }),
      body: t('promo.flow.launchBody', { defaultValue: 'Configure, preview in the app, publish' }),
    },
    {
      n: 4,
      to: '/performance',
      title: t('promo.flow.measure', { defaultValue: 'Measure' }),
      body: t('promo.flow.measureBody', { defaultValue: 'Plan vs actual' }),
    },
    {
      n: 5,
      to: '/performance/evaluations',
      title: t('promo.flow.evaluate', { defaultValue: 'Evaluate' }),
      body: t('promo.flow.evaluateBody', { defaultValue: 'Lessons for next time' }),
    },
  ] as const;
  return (
    <ol
      className="mb-4 grid gap-2 sm:grid-cols-5"
      aria-label={t('promo.flow.label', { defaultValue: 'Campaign workflow' })}
    >
      {steps.map((s) => (
        <li key={s.n}>
          <NavLink
            to={s.to}
            className={cn(
              'block rounded-xl px-3 py-2 ring-1 ring-inset transition-colors duration-fast',
              s.n === current
                ? 'bg-primary-tint ring-primary/40'
                : 'bg-card ring-foreground/[0.06] hover:bg-secondary',
            )}
            aria-current={s.n === current ? 'step' : undefined}
          >
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'grid h-5 w-5 place-items-center rounded-full text-2xs font-bold',
                  s.n === current
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-secondary text-muted-foreground',
                )}
              >
                {s.n}
              </span>
              <span className="text-xs font-semibold text-foreground">{s.title}</span>
            </div>
            <p className="mt-0.5 text-2xs text-muted-foreground">{s.body}</p>
          </NavLink>
        </li>
      ))}
    </ol>
  );
}

/* ── sub-navigation tabs inside an area ──────────────────────────────────── */

export function AreaTabs({
  tabs,
}: {
  tabs: ReadonlyArray<{ to: string; label: string; end?: boolean; badge?: number }>;
}) {
  return (
    <nav className="mb-4 flex flex-wrap gap-1.5" aria-label="Section">
      {tabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.end ?? false}
          className={({ isActive }) =>
            cn(
              'rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors duration-fast ease-out',
              isActive
                ? 'bg-ink text-ink-foreground'
                : 'bg-glass/60 text-foreground/80 ring-1 ring-inset ring-glass/80 hover:bg-glass/90 hover:text-foreground',
            )
          }
        >
          {tab.label}
          {tab.badge ? (
            <span className="ms-1.5 rounded-full bg-primary px-1.5 text-2xs text-primary-foreground">
              {tab.badge}
            </span>
          ) : null}
        </NavLink>
      ))}
    </nav>
  );
}

/* ── small building blocks ───────────────────────────────────────────────── */

export function Tile({
  label,
  value,
  caption,
  tone = 'default',
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  caption?: ReactNode;
  tone?: 'default' | 'primary' | 'success' | 'warning' | 'destructive';
  className?: string;
}) {
  const tones = {
    default: '',
    primary: 'bg-primary-tint',
    success: 'bg-success-tint',
    warning: 'bg-warning-tint',
    destructive: 'bg-destructive/10',
  } as const;
  return (
    <div className={cn(SECTION_CARD, 'p-4', tones[tone], className)}>
      <div className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-xl font-extrabold tabular-nums tracking-[-0.03em] text-foreground">
        {value}
      </div>
      {caption ? <div className="mt-0.5 text-2xs text-muted-foreground">{caption}</div> : null}
    </div>
  );
}

export function Panel({
  title,
  aside,
  children,
  className,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn(SECTION_CARD, 'p-4 sm:p-5', className)}>
      {(title || aside) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          {title ? <h2 className="text-sm font-semibold text-foreground">{title}</h2> : <span />}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

export function KeyValue({ rows }: { rows: ReadonlyArray<[ReactNode, ReactNode]> }) {
  return (
    <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
      {rows.map(([k, v], i) => (
        <div
          key={i}
          className="flex items-baseline justify-between gap-3 border-b border-foreground/[0.06] pb-1.5 text-sm"
        >
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="text-end font-medium text-foreground">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SampleDataPill() {
  const { t } = useTranslation();
  const engine = useEngine();
  if (engine.kind !== 'sample') return null;
  return (
    <Pill
      tone="warning"
      size="sm"
      dot
      title={t('promo.sampleHint', {
        defaultValue: 'Sample data until Yiji v2 is connected. Nothing here is real money.',
      })}
    >
      {t('promo.sample', { defaultValue: 'Sample data' })}
    </Pill>
  );
}

const STATUS_TONE: Record<
  CampaignStatus,
  'neutral' | 'primary' | 'success' | 'warning' | 'destructive' | 'highlight'
> = {
  draft: 'neutral',
  finance_review: 'highlight',
  waiting_approval: 'warning',
  approved: 'primary',
  live: 'success',
  paused: 'warning',
  ended: 'neutral',
  rejected: 'destructive',
};

export function StatusPill({ status }: { status: CampaignStatus }) {
  const { t } = useTranslation();
  const labels: Record<CampaignStatus, string> = {
    draft: t('promo.status.draft', { defaultValue: 'Draft' }),
    finance_review: t('promo.status.finance_review', { defaultValue: 'Finance review' }),
    waiting_approval: t('promo.status.waiting_approval', { defaultValue: 'Waiting approval' }),
    approved: t('promo.status.approved', { defaultValue: 'Approved' }),
    live: t('promo.status.live', { defaultValue: 'Live' }),
    paused: t('promo.status.paused', { defaultValue: 'Paused' }),
    ended: t('promo.status.ended', { defaultValue: 'Ended' }),
    rejected: t('promo.status.rejected', { defaultValue: 'Rejected' }),
  };
  return (
    <Pill tone={STATUS_TONE[status]} size="sm" dot>
      {labels[status]}
    </Pill>
  );
}

export function useObjectiveLabels(): Record<string, { title: string; body: string }> {
  const { t } = useTranslation();
  return {
    NEW_CUSTOMER: {
      title: t('promo.obj.NEW_CUSTOMER', { defaultValue: 'New customer acquisition' }),
      body: t('promo.obj.NEW_CUSTOMER_body', {
        defaultValue: 'Turn people who installed or registered into first-time buyers.',
      }),
    },
    LAPSED_REACTIVATION: {
      title: t('promo.obj.LAPSED_REACTIVATION', { defaultValue: 'Lapsed customer reactivation' }),
      body: t('promo.obj.LAPSED_REACTIVATION_body', {
        defaultValue:
          'Bring back customers who stopped ordering 30–60 days ago, before they are lost.',
      }),
    },
    RETENTION: {
      title: t('promo.obj.RETENTION', { defaultValue: 'Customer retention' }),
      body: t('promo.obj.RETENTION_body', {
        defaultValue:
          'Keep active customers ordering, using next-order rewards instead of deep discounts.',
      }),
    },
    LOYALTY_REWARD: {
      title: t('promo.obj.LOYALTY_REWARD', { defaultValue: 'Loyalty rewards' }),
      body: t('promo.obj.LOYALTY_REWARD_body', {
        defaultValue:
          'Thank loyal customers with wallet credit or a free extra on milestone orders.',
      }),
    },
    FREQUENT_ORDER: {
      title: t('promo.obj.FREQUENT_ORDER', { defaultValue: 'Frequent-order loyalty' }),
      body: t('promo.obj.FREQUENT_ORDER_body', {
        defaultValue:
          'Reward customers who order often: a stamp card, an order challenge or order milestones.',
      }),
    },
    FIRST_ORDER: {
      title: t('promo.obj.FIRST_ORDER', { defaultValue: 'First order discount' }),
      body: t('promo.obj.FIRST_ORDER_body', {
        defaultValue: 'Give customers with no orders a simple reason to place the first one.',
      }),
    },
    REPEAT_PURCHASE: {
      title: t('promo.obj.REPEAT_PURCHASE', { defaultValue: 'Repeat purchase incentive' }),
      body: t('promo.obj.REPEAT_PURCHASE_body', {
        defaultValue:
          'Turn customers who ordered once into repeat customers: the biggest drop-off point.',
      }),
    },
    SPECIFIC_ITEM: {
      title: t('promo.obj.SPECIFIC_ITEM', { defaultValue: 'Specific meal / item promotion' }),
      body: t('promo.obj.SPECIFIC_ITEM_body', {
        defaultValue: 'Launch a new dish or move a high-margin item.',
      }),
    },
    MIN_ORDER_VALUE: {
      title: t('promo.obj.MIN_ORDER_VALUE', { defaultValue: 'Minimum order value promotion' }),
      body: t('promo.obj.MIN_ORDER_VALUE_body', {
        defaultValue: 'Grow basket size: set the minimum 15–30% above today’s average order.',
      }),
    },
    UPSELL: {
      title: t('promo.obj.UPSELL', { defaultValue: 'Upselling and cross-selling' }),
      body: t('promo.obj.UPSELL_body', {
        defaultValue: 'Add a side, drink or dessert to the basket at a small price.',
      }),
    },
    PICKUP: {
      title: t('promo.obj.PICKUP', { defaultValue: 'Pickup promotion' }),
      body: t('promo.obj.PICKUP_body', {
        defaultValue: 'Shift orders to pickup, which costs less than delivery.',
      }),
    },
    DELIVERY: {
      title: t('promo.obj.DELIVERY', { defaultValue: 'Delivery promotion' }),
      body: t('promo.obj.DELIVERY_body', {
        defaultValue: 'Remove the delivery fee, the most common reason people leave at checkout.',
      }),
    },
    SLOW_HOURS: {
      title: t('promo.obj.SLOW_HOURS', { defaultValue: 'Slow hours and days' }),
      body: t('promo.obj.SLOW_HOURS_body', {
        defaultValue: 'Fill the afternoon lull and quiet weekdays.',
      }),
    },
    NEW_BRANCH: {
      title: t('promo.obj.NEW_BRANCH', { defaultValue: 'New branch or city launch' }),
      body: t('promo.obj.NEW_BRANCH_body', {
        defaultValue: 'Introduce a new branch to the people around it.',
      }),
    },
    OCCASION: {
      title: t('promo.obj.OCCASION', { defaultValue: 'Occasions and birthdays' }),
      body: t('promo.obj.OCCASION_body', {
        defaultValue: 'A gift on the customer’s day, National Day, Ramadan and Eid.',
      }),
    },
    SERVICE_RECOVERY: {
      title: t('promo.obj.SERVICE_RECOVERY', { defaultValue: 'Service recovery' }),
      body: t('promo.obj.SERVICE_RECOVERY_body', {
        defaultValue:
          'Win back a customer after a bad experience, with a coupon they did not expect.',
      }),
    },
  };
}

export function useGoalLabels(): Record<string, string> {
  const { t } = useTranslation();
  return {
    WIN_NEW_AND_LAPSED: t('promo.goal.WIN_NEW_AND_LAPSED', {
      defaultValue: 'Win new and lapsed customers',
    }),
    KEEP_AND_REWARD: t('promo.goal.KEEP_AND_REWARD', { defaultValue: 'Keep and reward customers' }),
    GROW_ORDER_VALUE: t('promo.goal.GROW_ORDER_VALUE', { defaultValue: 'Grow order value' }),
    SHIFT_ORDER_CHANNEL: t('promo.goal.SHIFT_ORDER_CHANNEL', {
      defaultValue: 'Shift order channel',
    }),
    OCCASIONS_AND_RECOVERY: t('promo.goal.OCCASIONS_AND_RECOVERY', {
      defaultValue: 'Occasions and service recovery',
    }),
  };
}
