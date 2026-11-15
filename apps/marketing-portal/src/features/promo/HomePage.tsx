import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, Pill, Skeleton, cn } from '@yiji/ui';
import { staffDisplayName } from '@yiji/shared-types';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { PageHeader, PAGE_BODY, SECTION_CARD } from '../../components/shell/Page.js';
import { int, pct, sar, SampleDataPill, useEngineQuery } from './shared.js';

/**
 * HOME: "where every part of your marketing stands today" - one card per area
 * with its three numbers, and what needs attention (Ayman's Home/Summary).
 */
export function HomePage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const home = useEngineQuery(['home'], (e) => e.home());
  const d = home.data;
  const areas = d
    ? [
        {
          to: '/coupons',
          tone: 'bg-rose-400/20 text-rose-500',
          title: t('promo.area.coupons', { defaultValue: 'Coupons' }),
          body: t('promo.area.couponsBody', { defaultValue: 'Marketing coupons by type' }),
          stats: [
            [int(d.coupons.live), t('promo.home.liveNow', { defaultValue: 'live now' })],
            [int(d.coupons.redeemed), t('promo.home.redeemed', { defaultValue: 'redeemed' })],
            [
              sar(d.coupons.discountSar),
              t('promo.home.discountGiven', { defaultValue: 'discount given' }),
            ],
          ],
          note: d.coupons.waitingApproval
            ? t('promo.home.waitingApproval', {
                defaultValue: '{{n}} waiting approval',
                n: d.coupons.waitingApproval,
              })
            : null,
          noteTo: '/coupons/approvals',
        },
        {
          to: '/pre-studies',
          tone: 'bg-sky/20 text-sky',
          title: t('promo.area.studies', { defaultValue: 'Pre-studies' }),
          body: t('promo.area.studiesBody', { defaultValue: 'Opportunities and business cases' }),
          stats: [
            [int(d.studies.total), t('promo.home.studies', { defaultValue: 'studies' })],
            [int(d.studies.inReview), t('promo.home.inReview', { defaultValue: 'in review' })],
            [
              int(d.studies.readyToLaunch),
              t('promo.home.readyToLaunch', { defaultValue: 'ready to launch' }),
            ],
          ],
          note: d.studies.inReview
            ? t('promo.home.reviewCases', { defaultValue: 'Next: review the business cases' })
            : null,
          noteTo: '/pre-studies/cases',
        },
        {
          to: '/performance',
          tone: 'bg-violet/20 text-violet',
          title: t('promo.area.performance', { defaultValue: 'Performance' }),
          body: t('promo.area.performanceBody', { defaultValue: 'Results of every campaign' }),
          stats: [
            [
              sar(d.performance.extraSalesSar),
              t('promo.home.extraSales', { defaultValue: 'extra sales' }),
            ],
            [
              pct(d.performance.roiPct),
              t('promo.home.returnOnCost', { defaultValue: 'return on cost' }),
            ],
            [
              int(d.performance.campaignsMeasured),
              t('promo.home.campaignsMeasured', { defaultValue: 'campaigns measured' }),
            ],
          ],
          note: d.performance.alerts
            ? t('promo.home.alerts', { defaultValue: '{{n}} alerts', n: d.performance.alerts })
            : null,
          noteTo: '/home/alerts',
        },
        {
          to: '/gift-cards',
          tone: 'bg-orange-400/20 text-orange-500',
          title: t('promo.area.giftCards', { defaultValue: 'Gift cards' }),
          body: t('promo.area.giftCardsBody', { defaultValue: 'Sold and redeemed' }),
          stats: [
            [int(d.giftCards.cards), t('promo.home.cards', { defaultValue: 'cards' })],
            [sar(d.giftCards.soldSar), t('promo.home.sold', { defaultValue: 'sold' })],
            [
              sar(d.giftCards.outstandingSar),
              t('promo.home.balanceOpen', { defaultValue: 'balance open' }),
            ],
          ],
          note: null,
          noteTo: '/gift-cards',
        },
        {
          to: '/rewards',
          tone: 'bg-emerald-400/20 text-emerald-500',
          title: t('promo.area.rewards', { defaultValue: 'Rewards' }),
          body: t('promo.area.rewardsBody', { defaultValue: 'Cashback and points' }),
          stats: [
            [
              int(d.rewards.activeMembers),
              t('promo.home.activeMembers', { defaultValue: 'active members' }),
            ],
            [
              int(d.rewards.pointsIssued),
              t('promo.home.pointsIssued', { defaultValue: 'points issued' }),
            ],
            [
              pct(d.rewards.repeatRatePct),
              t('promo.home.repeatRate', { defaultValue: 'repeat rate' }),
            ],
          ],
          note: null,
          noteTo: '/rewards',
        },
      ]
    : [];
  const greeting =
    new Date().getHours() < 12
      ? t('promo.home.morning', { defaultValue: 'Good morning' })
      : t('promo.home.afternoon', { defaultValue: 'Good afternoon' });
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={`${greeting}, ${staffDisplayName(user, '')}`}
        description={t('promo.home.desc', {
          defaultValue: 'Here is where every part of your marketing stands today.',
        })}
        titleExtra={<SampleDataPill />}
        actions={
          <div className="flex gap-2">
            <Button
              variant="ghost"
              onClick={() => (window.location.href = '/pre-studies/cases?new=1')}
            >
              {t('promo.home.newStudy', { defaultValue: 'New study' })}
            </Button>
            <Button onClick={() => (window.location.href = '/coupons/new')}>
              {t('promo.home.createCoupon', { defaultValue: '+ Create coupon' })}
            </Button>
          </div>
        }
      />
      <div className={PAGE_BODY}>
        {home.isLoading && <Skeleton className="h-40 w-full" />}
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          {areas.map((a) => (
            <NavLink
              key={a.to}
              to={a.to}
              className={cn(
                SECTION_CARD,
                'block p-4 transition-shadow duration-fast hover:shadow-float',
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div
                    className={cn(
                      'mb-2 inline-flex h-8 w-8 items-center justify-center rounded-lg text-sm font-bold',
                      a.tone,
                    )}
                  >
                    {a.title.slice(0, 1)}
                  </div>
                  <h2 className="text-sm font-semibold text-foreground">{a.title}</h2>
                  <p className="text-2xs text-muted-foreground">{a.body}</p>
                </div>
                <span className="text-muted-foreground" aria-hidden>
                  →
                </span>
              </div>
              <dl className="mt-3 grid grid-cols-3 gap-2">
                {a.stats.map(([v, l]) => (
                  <div key={String(l)}>
                    <dd className="text-sm font-extrabold tabular-nums text-foreground">{v}</dd>
                    <dt className="text-2xs text-muted-foreground">{l}</dt>
                  </div>
                ))}
              </dl>
              {a.note ? (
                <div className="mt-3">
                  <Pill tone="warning" size="sm">
                    {a.note}
                  </Pill>
                </div>
              ) : null}
            </NavLink>
          ))}
        </div>
        {d && (
          <section className={cn(SECTION_CARD, 'mt-4 p-4 sm:p-5')}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground">
                {t('promo.home.needsAttention', { defaultValue: 'Needs attention' })}
              </h2>
              <NavLink to="/home/alerts" className="text-xs font-semibold text-primary">
                {t('promo.home.allAlerts', { defaultValue: 'All alerts →' })}
              </NavLink>
            </div>
            {d.alerts.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('promo.home.noAlerts', { defaultValue: 'Nothing needs attention right now.' })}
              </p>
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {d.alerts.slice(0, 6).map((al) => (
                  <li
                    key={al.id}
                    className={cn(
                      'rounded-xl border-s-4 bg-secondary/40 p-3',
                      al.severity === 'danger'
                        ? 'border-destructive'
                        : al.severity === 'warning'
                          ? 'border-warning'
                          : 'border-sky',
                    )}
                  >
                    <div className="text-sm font-semibold text-foreground">{al.title}</div>
                    <p className="text-xs text-muted-foreground">{al.body}</p>
                    <div className="mt-1 text-2xs uppercase tracking-wide text-muted-foreground">
                      {al.area.replace('_', ' ')}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

export function AlertsPage() {
  const { t } = useTranslation();
  const home = useEngineQuery(['home'], (e) => e.home());
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('promo.home.alertsTitle', { defaultValue: 'Alerts' })}
        description={t('promo.home.alertsDesc', {
          defaultValue:
            'Everything that needs a decision or a look, across coupons, gift cards, rewards and performance.',
        })}
        titleExtra={<SampleDataPill />}
      />
      <div className={PAGE_BODY}>
        <ul className="grid gap-3 sm:grid-cols-2">
          {(home.data?.alerts ?? []).map((al) => (
            <li
              key={al.id}
              className={cn(
                SECTION_CARD,
                'border-s-4 p-4',
                al.severity === 'danger'
                  ? 'border-destructive'
                  : al.severity === 'warning'
                    ? 'border-warning'
                    : 'border-sky',
              )}
            >
              <div className="text-sm font-semibold text-foreground">{al.title}</div>
              <p className="mt-1 text-sm text-muted-foreground">{al.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
