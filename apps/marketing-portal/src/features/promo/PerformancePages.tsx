import { useMemo } from 'react';
import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { HBarChart, Skeleton, cn } from '@yiji/ui';
import type { Campaign, CampaignPerformance } from '@yiji/shared-types';
import { PageHeader, PAGE_BODY, SECTION_CARD } from '../../components/shell/Page.js';
import {
  AreaTabs,
  KeyValue,
  Panel,
  SampleDataPill,
  StatusPill,
  Tile,
  WorkflowStrip,
  int,
  pct,
  sar,
  useEngineQuery,
  useObjectiveLabels,
} from './shared.js';

/**
 * PERFORMANCE (Ayman): which campaigns pay back, plan vs actual for the
 * studied ones, the evaluations (lessons) and the open liability.
 */
function useTabs() {
  const { t } = useTranslation();
  return [
    {
      to: '/performance',
      label: t('promo.perf.tabOverview', { defaultValue: 'Overview' }),
      end: true,
    },
    {
      to: '/performance/results',
      label: t('promo.perf.tabResults', { defaultValue: 'Campaign results' }),
    },
    {
      to: '/performance/plan-vs-actual',
      label: t('promo.perf.tabPlan', { defaultValue: 'Plan vs actual' }),
    },
    {
      to: '/performance/evaluations',
      label: t('promo.perf.tabEvaluations', { defaultValue: 'Evaluations' }),
    },
  ];
}

function useResults() {
  return useEngineQuery(['results'], async (e) => {
    const cs = await e.listCampaigns({ status: 'all' });
    const measured = cs.filter((c) => ['live', 'paused', 'ended'].includes(c.status));
    const perf = await Promise.all(measured.map((c) => e.performance(c.id)));
    const liability = await e.liability();
    return { campaigns: measured, perf, liability };
  });
}

function Header({ title, description }: { title: string; description: string }) {
  return <PageHeader title={title} description={description} titleExtra={<SampleDataPill />} />;
}

export function PerformanceOverviewPage() {
  const { t } = useTranslation();
  const tabs = useTabs();
  const r = useResults();
  const totals = useMemo(() => {
    const p = r.data?.perf ?? [];
    const cost = p.reduce((s, x) => s + x.discountSar, 0);
    const profit = p.reduce((s, x) => s + x.extraProfitSar, 0);
    return {
      extraSales: p.reduce((s, x) => s + x.revenueSar, 0),
      profit,
      cost,
      roi: cost ? Math.round(((profit - cost) / cost) * 100) : 0,
      redeemed: p.reduce((s, x) => s + x.redeemed, 0),
      issued: p.reduce((s, x) => s + x.issued, 0),
    };
  }, [r.data]);
  const rows = useMemo(
    () =>
      r.data
        ? r.data.campaigns
            .map((c, i) => ({ c, p: r.data!.perf[i]! }))
            .sort((a, b) => b.p.roiPct - a.p.roiPct)
        : [],
    [r.data],
  );
  const studied = rows.filter((x) => x.p.plan);
  const onTrack = studied.filter(
    (x) => x.p.plan && x.p.extraProfitSar >= x.p.plan.extraProfitSar * 0.8,
  ).length;
  return (
    <div className="flex h-full flex-col">
      <Header
        title={t('promo.perf.title', { defaultValue: 'Performance' })}
        description={t('promo.perf.desc', {
          defaultValue:
            'Return on cost = extra profit minus the campaign cost, measured against the customers who did not get the coupon.',
        })}
      />
      <div className={PAGE_BODY}>
        <WorkflowStrip current={4} />
        <AreaTabs tabs={tabs} />
        <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Tile
            label={t('promo.perf.roi', { defaultValue: 'Return on cost' })}
            value={pct(totals.roi)}
            caption={t('promo.perf.roiCaption', { defaultValue: 'extra profit ÷ campaign cost' })}
            tone="primary"
          />
          <Tile
            label={t('promo.perf.extraSales', { defaultValue: 'Extra sales' })}
            value={sar(totals.extraSales)}
            caption={t('promo.perf.extraSalesCaption', {
              defaultValue: 'above customers without a coupon',
            })}
          />
          <Tile
            label={t('promo.perf.extraProfit', { defaultValue: 'Extra profit' })}
            value={sar(totals.profit - totals.cost)}
            caption={t('promo.perf.extraProfitCaption', {
              defaultValue: 'after discount and message costs',
            })}
          />
          <Tile
            label={t('promo.perf.redeemed', { defaultValue: 'Coupons redeemed' })}
            value={int(totals.redeemed)}
            caption={t('promo.perf.ofIssued', {
              defaultValue: '{{p}} of issued',
              p: pct(totals.issued ? (totals.redeemed / totals.issued) * 100 : 0),
            })}
          />
        </div>
        <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
          <Panel
            title={t('promo.perf.whichPay', { defaultValue: 'Which campaigns pay back?' })}
            aside={
              <NavLink to="/performance/results" className="text-xs font-semibold text-primary">
                {t('promo.perf.allResults', { defaultValue: 'All results →' })}
              </NavLink>
            }
          >
            {r.isLoading && <Skeleton className="h-40 w-full" />}
            <HBarChart
              rows={rows.slice(0, 8).map((x) => ({
                label: x.c.name.en,
                values: { roi: Math.max(0, x.p.roiPct) },
                note: `${x.p.roiPct}%`,
                highlight: x.p.roiPct < 0,
              }))}
              series={[
                {
                  key: 'roi',
                  label: t('promo.perf.roi', { defaultValue: 'Return on cost' }),
                  tone: 'primary',
                },
              ]}
              format={(v) => `${Math.round(v)}%`}
            />
          </Panel>
          <div className="space-y-3">
            <Tile
              label={t('promo.perf.planVsActual', { defaultValue: 'Plan vs actual' })}
              value={`${onTrack} / ${studied.length}`}
              caption={t('promo.perf.onTrack', {
                defaultValue: 'studied campaigns on track (≥80% of planned profit)',
              })}
            />
            <Tile
              label={t('promo.perf.evaluations', { defaultValue: 'Evaluations' })}
              value={rows.filter((x) => x.c.status === 'ended').length}
              caption={t('promo.perf.waitingLessons', {
                defaultValue: 'finished campaigns waiting for lessons learned',
              })}
            />
            <Tile
              label={t('promo.perf.openLiability', { defaultValue: 'Open liability' })}
              value={sar(r.data?.liability.totalFaceValueSar)}
              caption={t('promo.perf.liabilityCaption', {
                defaultValue: 'unused value customers can still redeem',
              })}
              tone="warning"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export function PerformanceResultsPage() {
  const { t } = useTranslation();
  const tabs = useTabs();
  const labels = useObjectiveLabels();
  const r = useResults();
  const rows = r.data
    ? r.data.campaigns
        .map((c, i) => ({ c, p: r.data!.perf[i]! }))
        .sort((a, b) => b.p.revenueSar - a.p.revenueSar)
    : [];
  return (
    <div className="flex h-full flex-col">
      <Header
        title={t('promo.perf.resultsTitle', { defaultValue: 'Campaign results' })}
        description={t('promo.perf.resultsDesc', {
          defaultValue:
            'Every measured campaign: what it cost, what it brought, and whether it created orders that would not have happened.',
        })}
      />
      <div className={PAGE_BODY}>
        <WorkflowStrip current={4} />
        <AreaTabs tabs={tabs} />
        {r.isLoading && <Skeleton className="h-40 w-full" />}
        <div className={cn(SECTION_CARD, 'overflow-x-auto')}>
          <table className="w-full min-w-[56rem] text-xs">
            <thead className="text-muted-foreground">
              <tr>
                {[
                  t('promo.perf.campaign', { defaultValue: 'Campaign' }),
                  t('promo.detail.issued', { defaultValue: 'Issued' }),
                  t('promo.detail.redeemed', { defaultValue: 'Redeemed' }),
                  t('promo.perf.sales', { defaultValue: 'Sales' }),
                  t('promo.perf.discount', { defaultValue: 'Discount' }),
                  t('promo.perf.extraOrders', { defaultValue: 'Extra orders' }),
                  t('promo.perf.extraProfit', { defaultValue: 'Extra profit' }),
                  t('promo.perf.roi', { defaultValue: 'Return on cost' }),
                ].map((h, i) => (
                  <th key={h} className={cn('px-3 py-2', i === 0 ? 'text-start' : 'text-end')}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ c, p }) => (
                <tr key={c.id} className="border-t border-foreground/[0.06]">
                  <td className="px-3 py-2">
                    <NavLink to={`/coupons/${c.id}`} className="font-semibold text-primary">
                      {c.name.en}
                    </NavLink>
                    <div className="text-2xs text-muted-foreground">
                      {labels[c.objective]?.title} · <StatusPill status={c.status} />
                    </div>
                  </td>
                  <td className="px-3 text-end tabular-nums">{int(p.issued)}</td>
                  <td className="px-3 text-end tabular-nums">{int(p.redeemed)}</td>
                  <td className="px-3 text-end tabular-nums">{sar(p.revenueSar)}</td>
                  <td className="px-3 text-end tabular-nums">{sar(p.discountSar)}</td>
                  <td className="px-3 text-end tabular-nums">{int(p.extraOrders)}</td>
                  <td className="px-3 text-end tabular-nums">{sar(p.extraProfitSar)}</td>
                  <td
                    className={cn(
                      'px-3 text-end font-bold tabular-nums',
                      p.roiPct < 0 ? 'text-destructive' : 'text-success',
                    )}
                  >
                    {pct(p.roiPct)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export function PerformancePlanPage() {
  const { t } = useTranslation();
  const tabs = useTabs();
  const r = useResults();
  const rows: Array<{ c: Campaign; p: CampaignPerformance }> = r.data
    ? r.data.campaigns.map((c, i) => ({ c, p: r.data!.perf[i]! })).filter((x) => x.p.plan)
    : [];
  return (
    <div className="flex h-full flex-col">
      <Header
        title={t('promo.perf.planTitle', { defaultValue: 'Plan vs actual' })}
        description={t('promo.perf.planDesc', {
          defaultValue:
            'The forecast fixed at approval beside what actually happened. A campaign is on track above 80% of its planned profit.',
        })}
      />
      <div className={PAGE_BODY}>
        <WorkflowStrip current={4} />
        <AreaTabs tabs={tabs} />
        {rows.length === 0 && !r.isLoading && (
          <p className="text-sm text-muted-foreground">
            {t('promo.perf.noPlan', { defaultValue: 'No campaign with an approved forecast yet.' })}
          </p>
        )}
        <div className="grid gap-4 lg:grid-cols-2">
          {rows.map(({ c, p }) => {
            const plan = p.plan!;
            const track = plan.extraProfitSar ? (p.extraProfitSar / plan.extraProfitSar) * 100 : 0;
            return (
              <Panel
                key={c.id}
                title={
                  <NavLink to={`/coupons/${c.id}`} className="text-primary">
                    {c.name.en}
                  </NavLink>
                }
                aside={
                  <span
                    className={cn(
                      'text-xs font-bold',
                      track >= 80 ? 'text-success' : 'text-warning',
                    )}
                  >
                    {track >= 80
                      ? t('promo.perf.onTrackShort', { defaultValue: 'On track' })
                      : t('promo.perf.behind', { defaultValue: 'Behind plan' })}{' '}
                    · {pct(track)}
                  </span>
                }
              >
                <table className="w-full text-xs">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="text-start"></th>
                      <th className="text-end">{t('promo.perf.plan', { defaultValue: 'Plan' })}</th>
                      <th className="text-end">
                        {t('promo.perf.actual', { defaultValue: 'Actual' })}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      [
                        t('promo.detail.redeemed', { defaultValue: 'Redeemed' }),
                        int(plan.expectedRedemptions),
                        int(p.redeemed),
                      ],
                      [
                        t('promo.perf.sales', { defaultValue: 'Sales' }),
                        sar(plan.revenueSar),
                        sar(p.revenueSar),
                      ],
                      [
                        t('promo.perf.discount', { defaultValue: 'Discount' }),
                        sar(plan.discountSar),
                        sar(p.discountSar),
                      ],
                      [
                        t('promo.perf.extraProfit', { defaultValue: 'Extra profit' }),
                        sar(plan.extraProfitSar),
                        sar(p.extraProfitSar),
                      ],
                      [
                        t('promo.perf.roi', { defaultValue: 'Return on cost' }),
                        pct(plan.roiPct),
                        pct(p.roiPct),
                      ],
                    ].map(([k, a, b]) => (
                      <tr key={String(k)} className="border-t border-foreground/[0.06]">
                        <td className="py-1 text-muted-foreground">{k}</td>
                        <td className="text-end tabular-nums">{a}</td>
                        <td className="text-end font-semibold tabular-nums">{b}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function PerformanceEvaluationsPage() {
  const { t } = useTranslation();
  const tabs = useTabs();
  const r = useResults();
  const ended = r.data
    ? r.data.campaigns
        .map((c, i) => ({ c, p: r.data!.perf[i]! }))
        .filter((x) => x.c.status === 'ended')
    : [];
  const lesson = (p: CampaignPerformance): string => {
    if (p.roiPct >= 100)
      return t('promo.perf.lessonGreat', {
        defaultValue:
          'Strong return - repeat it on the same segment; try a smaller discount next time to test the floor.',
      });
    if (p.roiPct >= 0)
      return t('promo.perf.lessonOk', {
        defaultValue:
          'Paid for itself. The extra orders were modest: narrow the audience to the customers who actually responded.',
      });
    return t('promo.perf.lessonLoss', {
      defaultValue:
        'A loss: most redeemers would have ordered anyway. Use a smaller amount, a higher minimum order, or a tighter segment.',
    });
  };
  return (
    <div className="flex h-full flex-col">
      <Header
        title={t('promo.perf.evalTitle', { defaultValue: 'Evaluations' })}
        description={t('promo.perf.evalDesc', {
          defaultValue: 'Lessons for next time, one per finished campaign.',
        })}
      />
      <div className={PAGE_BODY}>
        <WorkflowStrip current={5} />
        <AreaTabs tabs={tabs} />
        {ended.length === 0 && !r.isLoading && (
          <p className="text-sm text-muted-foreground">
            {t('promo.perf.noEnded', { defaultValue: 'No finished campaign yet.' })}
          </p>
        )}
        <div className="grid gap-4 lg:grid-cols-2">
          {ended.map(({ c, p }) => (
            <Panel
              key={c.id}
              title={
                <NavLink to={`/coupons/${c.id}`} className="text-primary">
                  {c.name.en}
                </NavLink>
              }
            >
              <KeyValue
                rows={[
                  [t('promo.perf.roi', { defaultValue: 'Return on cost' }), pct(p.roiPct)],
                  [
                    t('promo.perf.extraOrders', { defaultValue: 'Extra orders' }),
                    int(p.extraOrders),
                  ],
                  [t('promo.perf.discount', { defaultValue: 'Discount' }), sar(p.discountSar)],
                ]}
              />
              <p className="mt-3 rounded-lg bg-secondary/50 px-3 py-2 text-xs text-foreground">
                {lesson(p)}
              </p>
            </Panel>
          ))}
        </div>
        {r.data && (
          <Panel
            title={t('promo.perf.liabilityTitle', { defaultValue: 'Open liability by product' })}
            className="mt-4"
          >
            <KeyValue
              rows={r.data.liability.byProduct.map((b) => [
                b.product.replace('_', ' '),
                `${sar(b.faceValueSar)} · ${t('promo.perf.atCost', { defaultValue: 'at cost {{c}}', c: sar(b.atCostSar) })}`,
              ])}
            />
          </Panel>
        )}
      </div>
    </div>
  );
}
