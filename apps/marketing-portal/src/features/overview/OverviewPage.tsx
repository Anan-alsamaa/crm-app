import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { staffDisplayName } from '@yiji/shared-types';
import { cn } from '@yiji/ui';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { PageHeader, PAGE_BODY, SECTION_CARD } from '../../components/shell/Page.js';
import type { Privilege } from '../../lib/privileges.js';

interface Area {
  to: string;
  title: string;
  body: string;
  requires: Privilege;
  ready: boolean;
}

/**
 * The landing page: what this portal is for, and which parts are open to this
 * person. Each area says plainly whether it is ready yet.
 */
export function OverviewPage() {
  const { t } = useTranslation();
  const { user, can } = useAuth();
  const areas: Area[] = [
    {
      to: '/coupons',
      title: t('overview.coupons', { defaultValue: 'Marketing coupons' }),
      body: t('overview.couponsBody', {
        defaultValue: 'One coupon, set up once, sent after approval.',
      }),
      requires: 'manage_marketing',
      ready: true,
    },
    {
      to: '/bulk',
      title: t('overview.bulk', { defaultValue: 'Bulk coupons' }),
      body: t('overview.bulkBody', {
        defaultValue: 'A coupon for a whole list of customers, checked and paced.',
      }),
      requires: 'manage_marketing',
      ready: true,
    },
    {
      to: '/campaigns',
      title: t('overview.campaigns', { defaultValue: 'Campaigns' }),
      body: t('overview.campaignsBody', {
        defaultValue: 'Dates, budget and results for a group of coupons and offers.',
      }),
      requires: 'manage_marketing',
      ready: true,
    },
    {
      to: '/points',
      title: t('overview.points', { defaultValue: 'Points' }),
      body: t('overview.pointsBody', { defaultValue: 'Loyalty points rules and programmes.' }),
      requires: 'manage_marketing',
      ready: true,
    },
    {
      to: '/approvals',
      title: t('overview.approvals', { defaultValue: 'Approvals' }),
      body: t('overview.approvalsBody', {
        defaultValue: 'A manager approves marketing work before it reaches customers.',
      }),
      requires: 'approve_marketing',
      ready: true,
    },
  ];
  const open = areas.filter((a) => can(a.requires));

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('overview.hello', {
          defaultValue: 'Welcome, {{name}}',
          name: staffDisplayName(user, ''),
        })}
        description={t('overview.desc', {
          defaultValue:
            'Run marketing coupons, bulk sends, campaigns and points from one place. Everything is approved by a manager and logged.',
        })}
      />
      <div className={PAGE_BODY}>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {open.map((a) => (
            <NavLink
              key={a.to}
              to={a.to}
              className={cn(
                SECTION_CARD,
                'block p-5 transition-shadow duration-fast ease-out hover:shadow-float focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-md font-semibold text-foreground">{a.title}</h2>
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-2xs font-medium',
                    a.ready ? 'bg-success-tint text-success' : 'bg-secondary text-muted-foreground',
                  )}
                >
                  {a.ready
                    ? t('overview.ready', { defaultValue: 'Ready' })
                    : t('overview.next', { defaultValue: 'Coming next' })}
                </span>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">{a.body}</p>
            </NavLink>
          ))}
        </div>
      </div>
    </div>
  );
}
