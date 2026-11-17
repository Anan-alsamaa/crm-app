import { useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  FormField,
  Input,
  Select,
  Skeleton,
  Textarea,
  TrendChart,
  cn,
  toast,
} from '@yiji/ui';
import {
  LOCKED_WHEN_LIVE,
  canApproveCampaign,
  offerLabel,
  type OrderType,
} from '@yiji/shared-types';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { useEngine } from '../../engine/index.js';
import { PageHeader, PAGE_BODY, SECTION_CARD } from '../../components/shell/Page.js';
import { Preview } from './CampaignWizard.js';
import {
  KeyValue,
  Panel,
  SampleDataPill,
  StatusPill,
  Tile,
  dateLabel,
  dayLabel,
  int,
  pct,
  sar,
  useEngineQuery,
  useObjectiveLabels,
} from './shared.js';

/**
 * ONE CAMPAIGN: what it is, where it stands, what it did (plan vs actual),
 * who may do what next - and the checkout test that runs the same
 * compatibility rules the engine applies on every order.
 */
export function CampaignDetailPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { user, can } = useAuth();
  const engine = useEngine();
  const qc = useQueryClient();
  const labels = useObjectiveLabels();
  const campaign = useEngineQuery(['campaign', id], (e) => e.getCampaign(id));
  const perf = useEngineQuery(['performance', id], (e) => e.performance(id), {
    enabled: !!campaign.data,
  });
  const redemptions = useEngineQuery(['redemptions', id], (e) => e.redemptions(id, 20), {
    enabled:
      campaign.data?.status === 'live' ||
      campaign.data?.status === 'ended' ||
      campaign.data?.status === 'paused',
  });
  const catalogue = useEngineQuery(['catalogue'], (e) => e.catalogue());
  const c = campaign.data;
  const refresh = () => void qc.invalidateQueries({ queryKey: ['promo'] });
  const status = useMutation({
    mutationFn: (s: 'live' | 'paused' | 'ended') => engine.setCampaignStatus(id, s),
    onSuccess: (x) => {
      toast.success(
        t('promo.detail.statusChanged', {
          defaultValue: '{{id}} is now {{s}}.',
          id: x.id,
          s: x.status,
        }),
      );
      refresh();
    },
  });
  const decide = useMutation({
    mutationFn: (v: { decision: 'approve' | 'reject'; note: string }) =>
      engine.decideCampaign(id, v.decision, v.note),
    onSuccess: () => {
      toast.success(t('promo.detail.decided', { defaultValue: 'Decision recorded.' }));
      refresh();
    },
  });
  const issue = useMutation({
    mutationFn: (ids: string[]) => engine.issue(id, ids),
    onSuccess: (r) =>
      toast.success(
        t('promo.detail.issued', {
          defaultValue: 'Issued to {{n}} of {{m}} customers (batch {{b}}).',
          n: r.issued,
          m: r.requested,
          b: r.batchId,
        }),
      ),
  });
  const [note, setNote] = useState('');
  const [ids, setIds] = useState('');
  const [sim, setSim] = useState({
    brandId: 'casapasta',
    orderType: 'DELIVERY' as OrderType,
    subtotalSar: 85,
    otherOffer: false,
    otherCoupon: false,
    loyalty: false,
  });
  const simulate = useMutation({
    mutationFn: () => engine.simulateCheckout({ campaignId: id, ...sim }),
  });
  if (campaign.isLoading)
    return (
      <div className={PAGE_BODY}>
        <Skeleton className="h-40 w-full" />
      </div>
    );
  if (!c)
    return (
      <div className={PAGE_BODY}>
        <p className="text-sm text-muted-foreground">
          {t('promo.detail.notFound', { defaultValue: 'No campaign with that id.' })}
        </p>
      </div>
    );
  const gate = canApproveCampaign(c, user?.id ?? '');
  const p = perf.data;
  const locked = c.status === 'live' || c.status === 'paused' || c.status === 'ended';
  const editable =
    (c.status === 'draft' || c.status === 'rejected' || c.status === 'approved') &&
    can('manage_marketing');
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={c.name.en}
        description={`${c.id} · ${labels[c.objective]?.title ?? c.objective} · ${t('promo.coupons.by', { defaultValue: 'by {{who}}', who: c.createdBy })} · ${dateLabel(c.createdAt)}`}
        titleExtra={
          <span className="flex items-center gap-2">
            <StatusPill status={c.status} />
            <SampleDataPill />
          </span>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {editable && (
              <Button variant="ghost" onClick={() => nav(`/coupons/new?edit=${c.id}`)}>
                {t('promo.detail.edit', { defaultValue: 'Edit' })}
              </Button>
            )}
            {c.status === 'approved' && can('manage_marketing') && (
              <Button onClick={() => status.mutate('live')}>
                {t('promo.detail.goLive', { defaultValue: 'Publish - go live' })}
              </Button>
            )}
            {c.status === 'live' && can('manage_marketing') && (
              <Button variant="ghost" onClick={() => status.mutate('paused')}>
                {t('promo.detail.pause', { defaultValue: 'Pause' })}
              </Button>
            )}
            {c.status === 'paused' && can('manage_marketing') && (
              <Button onClick={() => status.mutate('live')}>
                {t('promo.detail.resume', { defaultValue: 'Resume' })}
              </Button>
            )}
            {(c.status === 'live' || c.status === 'paused') && can('manage_marketing') && (
              <Button
                variant="ghost"
                className="text-destructive"
                onClick={() => status.mutate('ended')}
              >
                {t('promo.detail.end', { defaultValue: 'End campaign' })}
              </Button>
            )}
          </div>
        }
      />
      <div className={PAGE_BODY}>
        <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
          <div className="space-y-4">
            {c.status === 'waiting_approval' && can('approve_marketing') && (
              <Panel title={t('promo.detail.approvalTitle', { defaultValue: 'Approval' })}>
                {gate.ok ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder={t('promo.approvals.notePlaceholder', {
                        defaultValue: 'A note for the requester (required to reject)',
                      })}
                      className="h-9 min-w-[16rem] flex-1"
                    />
                    <Button size="sm" onClick={() => decide.mutate({ decision: 'approve', note })}>
                      {t('promo.approvals.approve', { defaultValue: 'Approve' })}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      disabled={!note.trim()}
                      onClick={() => decide.mutate({ decision: 'reject', note })}
                    >
                      {t('promo.approvals.reject', { defaultValue: 'Reject' })}
                    </Button>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t('promo.approvals.ownCampaign', {
                      defaultValue: 'You created this campaign, so another user must approve it.',
                    })}
                  </p>
                )}
              </Panel>
            )}
            {c.approval.note && (
              <p className="rounded-lg bg-secondary px-3 py-2 text-xs text-muted-foreground">
                {t('promo.detail.decisionNote', {
                  defaultValue: 'Decision by {{who}} on {{when}}: {{note}}',
                  who: c.approval.decidedBy ?? '—',
                  when: dateLabel(c.approval.decidedAt),
                  note: c.approval.note,
                })}
              </p>
            )}
            {p && (p.issued > 0 || p.plan) && (
              <>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <Tile
                    label={t('promo.detail.issued', { defaultValue: 'Issued' })}
                    value={int(p.issued)}
                    caption={
                      p.plan
                        ? t('promo.detail.planned', {
                            defaultValue: 'planned {{n}}',
                            n: int(p.plan.customersMatched),
                          })
                        : undefined
                    }
                  />
                  <Tile
                    label={t('promo.detail.redeemed', { defaultValue: 'Redeemed' })}
                    value={int(p.redeemed)}
                    caption={
                      p.plan
                        ? t('promo.detail.planned', {
                            defaultValue: 'planned {{n}}',
                            n: int(p.plan.expectedRedemptions),
                          })
                        : undefined
                    }
                    tone="primary"
                  />
                  <Tile
                    label={t('promo.detail.discountGiven', { defaultValue: 'Discount given' })}
                    value={sar(p.discountSar)}
                    caption={t('promo.detail.ofBudget', {
                      defaultValue: 'of {{b}} budget',
                      b: sar(c.limits.budgetSar),
                    })}
                    tone={p.discountSar > c.limits.budgetSar * 0.85 ? 'warning' : 'default'}
                  />
                  <Tile
                    label={t('promo.detail.return', { defaultValue: 'Return on cost' })}
                    value={pct(p.roiPct)}
                    caption={
                      p.plan
                        ? t('promo.detail.planned', {
                            defaultValue: 'planned {{n}}',
                            n: pct(p.plan.roiPct),
                          })
                        : undefined
                    }
                    tone={p.roiPct < 0 ? 'destructive' : 'success'}
                  />
                </div>
                {p.perDay.length > 0 && (
                  <Panel
                    title={t('promo.detail.perDay', {
                      defaultValue: 'Issued and redeemed, per day',
                    })}
                  >
                    <TrendChart
                      points={p.perDay.map((d) => ({
                        label: dayLabel(d.day),
                        values: { issued: d.issued, redeemed: d.redeemed },
                      }))}
                      series={[
                        {
                          key: 'issued',
                          label: t('promo.detail.issued', { defaultValue: 'Issued' }),
                          tone: 'sky',
                        },
                        {
                          key: 'redeemed',
                          label: t('promo.detail.redeemed', { defaultValue: 'Redeemed' }),
                          tone: 'primary',
                        },
                      ]}
                      format={(v) => int(v)}
                      height={180}
                    />
                  </Panel>
                )}
                {p.controlGroup && (
                  <Panel
                    title={t('promo.detail.controlGroup', {
                      defaultValue: 'Did it create extra orders?',
                    })}
                  >
                    <KeyValue
                      rows={[
                        [
                          t('promo.detail.cgSize', {
                            defaultValue: 'Measurement group (did not get the coupon)',
                          }),
                          int(p.controlGroup.size),
                        ],
                        [
                          t('promo.detail.cgRate', { defaultValue: 'Their order rate' }),
                          pct(p.controlGroup.orderRatePct),
                        ],
                        [
                          t('promo.detail.exposedRate', {
                            defaultValue: 'Order rate with the coupon',
                          }),
                          pct(p.controlGroup.exposedOrderRatePct),
                        ],
                        [
                          t('promo.detail.extraOrders', { defaultValue: 'Extra orders' }),
                          int(p.extraOrders),
                        ],
                        [
                          t('promo.detail.extraProfit', { defaultValue: 'Extra profit' }),
                          sar(p.extraProfitSar),
                        ],
                      ]}
                    />
                  </Panel>
                )}
              </>
            )}
            <Panel
              title={t('promo.detail.setup', { defaultValue: 'Set-up' })}
              aside={
                locked ? (
                  <span className="text-2xs text-muted-foreground">
                    {t('promo.detail.lockedHint', {
                      defaultValue:
                        'Discount, customers, code, rules and start date are locked once customers hold the coupon.',
                    })}
                  </span>
                ) : null
              }
            >
              <KeyValue
                rows={[
                  [t('promo.coupons.offer', { defaultValue: 'Offer' }), offerLabel(c.offer)],
                  [
                    t('promo.coupons.customers', { defaultValue: 'Customers' }),
                    c.audience.mode === 'SEGMENT'
                      ? c.audience.conditions
                          .map((x) => `${x.c.replace(/_/g, ' ').toLowerCase()} ${x.p}`)
                          .join(` ${c.audience.match.toLowerCase()} `)
                      : c.audience.mode.toLowerCase(),
                  ],
                  [
                    t('promo.wizard.minOrder', { defaultValue: 'Minimum order (SAR) *' }).replace(
                      ' *',
                      '',
                    ),
                    sar(c.rules.minOrderSar),
                  ],
                  [
                    t('promo.wizard.orderTypes', { defaultValue: 'Order types *' }).replace(
                      ' *',
                      '',
                    ),
                    c.scope.orderTypes.join(', '),
                  ],
                  [
                    t('promo.wizard.brands', { defaultValue: 'Brands (none = all)' }),
                    c.scope.brandIds.length
                      ? c.scope.brandIds.join(', ')
                      : t('promo.detail.allBrands', { defaultValue: 'All brands' }),
                  ],
                  [
                    t('promo.wizard.validity', { defaultValue: 'Valid' }),
                    `${c.schedule.startDate} → ${c.schedule.endDate}${c.schedule.timeWindow?.from ? ` · ${c.schedule.timeWindow.from}–${c.schedule.timeWindow.to ?? ''}` : ''}`,
                  ],
                  [
                    t('promo.wizard.limits', { defaultValue: 'Limits' }),
                    `${c.limits.perCustomerMode.toLowerCase()} per customer · ${int(c.limits.totalRedemptions)} total · ${sar(c.limits.budgetSar)}`,
                  ],
                  [
                    t('promo.wizard.channels', { defaultValue: 'Channels *' }).replace(' *', ''),
                    c.distribution.channels.join(', '),
                  ],
                  [
                    t('promo.detail.stacking', { defaultValue: 'Stacking' }),
                    [
                      c.stacking.combineWithOtherOffers
                        ? t('promo.detail.offersYes', { defaultValue: 'with offers' })
                        : t('promo.detail.offersNo', { defaultValue: 'not with offers' }),
                      c.stacking.combineWithLoyalty
                        ? t('promo.detail.loyaltyYes', { defaultValue: 'with loyalty' })
                        : t('promo.detail.loyaltyNo', { defaultValue: 'not with loyalty' }),
                      c.stacking.combineWithOtherCoupons
                        ? t('promo.detail.couponsYes', { defaultValue: 'with other coupons' })
                        : t('promo.detail.couponsNo', { defaultValue: 'one coupon per order' }),
                    ].join(' · '),
                  ],
                  [
                    t('promo.detail.lockedFields', { defaultValue: 'Locked when live' }),
                    LOCKED_WHEN_LIVE.join(', '),
                  ],
                ]}
              />
            </Panel>
            {(c.status === 'live' || c.status === 'approved') &&
              can('manage_marketing') &&
              c.audience.mode !== 'ALL' && (
                <Panel
                  title={t('promo.detail.issueTitle', { defaultValue: 'Issue to customers' })}
                  aside={
                    <span className="text-2xs text-muted-foreground">
                      {t('promo.detail.issueHint', {
                        defaultValue:
                          'Customer ids, one per line. The engine paces the batch and reports who was skipped.',
                      })}
                    </span>
                  }
                >
                  <Textarea
                    rows={3}
                    value={ids}
                    onChange={(e) => setIds(e.target.value)}
                    placeholder="u-1001&#10;u-1002"
                  />
                  <div className="mt-2 flex items-center gap-2">
                    <Button
                      size="sm"
                      disabled={issue.isPending || !ids.trim()}
                      onClick={() => issue.mutate(ids.split(/\s+/).filter(Boolean))}
                    >
                      {t('promo.detail.issueNow', { defaultValue: 'Issue now' })}
                    </Button>
                    {issue.data && (
                      <span className="text-xs text-muted-foreground">
                        {t('promo.detail.issueResult', {
                          defaultValue: '{{n}} issued, {{s}} skipped',
                          n: issue.data.issued,
                          s: issue.data.skipped.length,
                        })}
                      </span>
                    )}
                  </div>
                </Panel>
              )}
            {redemptions.data && redemptions.data.length > 0 && (
              <Panel
                title={t('promo.detail.recentRedemptions', { defaultValue: 'Recent redemptions' })}
              >
                <table className="w-full text-xs">
                  <thead className="text-start text-muted-foreground">
                    <tr>
                      <th className="py-1 text-start">
                        {t('promo.detail.when', { defaultValue: 'When' })}
                      </th>
                      <th className="text-start">
                        {t('promo.detail.order', { defaultValue: 'Order' })}
                      </th>
                      <th className="text-start">
                        {t('promo.detail.branch', { defaultValue: 'Branch' })}
                      </th>
                      <th className="text-end">SAR</th>
                    </tr>
                  </thead>
                  <tbody>
                    {redemptions.data.map((r) => (
                      <tr
                        key={r.id}
                        className={cn(
                          'border-t border-foreground/[0.06]',
                          r.reversed && 'line-through opacity-60',
                        )}
                      >
                        <td className="py-1">{dateLabel(r.at)}</td>
                        <td className="font-mono">{r.orderId}</td>
                        <td>{r.branchId}</td>
                        <td className="text-end tabular-nums">{r.amountSar}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
            )}
            <Panel title={t('promo.detail.history', { defaultValue: 'History' })}>
              <ol className="space-y-1 text-xs text-muted-foreground">
                {c.changeLog.map((e, i) => (
                  <li key={i}>
                    {dateLabel(e.at)} · {e.by} · {e.what}
                  </li>
                ))}
              </ol>
            </Panel>
          </div>
          <aside className="space-y-4 self-start">
            <Preview draft={c} />
            <Panel
              title={t('promo.detail.checkoutTest', { defaultValue: 'Checkout test' })}
              aside={
                <span className="text-2xs text-muted-foreground">
                  {t('promo.detail.checkoutHint', {
                    defaultValue: 'The same rules the engine applies at checkout.',
                  })}
                </span>
              }
            >
              <div className="grid gap-2">
                <FormField label={t('promo.detail.brand', { defaultValue: 'Brand' })}>
                  <Select
                    value={sim.brandId}
                    onChange={(e) => setSim({ ...sim, brandId: e.target.value })}
                  >
                    {(catalogue.data?.brands ?? []).map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <FormField label={t('promo.detail.orderType', { defaultValue: 'Order type' })}>
                  <Select
                    value={sim.orderType}
                    onChange={(e) => setSim({ ...sim, orderType: e.target.value as OrderType })}
                  >
                    {['DELIVERY', 'PICKUP', 'CARHOP', 'DINE_IN'].map((o) => (
                      <option key={o} value={o}>
                        {o.toLowerCase()}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <FormField
                  label={t('promo.detail.subtotal', { defaultValue: 'Order subtotal (SAR)' })}
                >
                  <Input
                    type="number"
                    min={0}
                    value={sim.subtotalSar}
                    onChange={(e) => setSim({ ...sim, subtotalSar: Number(e.target.value) })}
                  />
                </FormField>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={sim.otherOffer}
                    onChange={(e) => setSim({ ...sim, otherOffer: e.target.checked })}
                  />{' '}
                  {t('promo.detail.offerInCart', { defaultValue: 'Promotional offer in cart' })}
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={sim.otherCoupon}
                    onChange={(e) => setSim({ ...sim, otherCoupon: e.target.checked })}
                  />{' '}
                  {t('promo.detail.couponInCart', { defaultValue: 'Other coupon in cart' })}
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={sim.loyalty}
                    onChange={(e) => setSim({ ...sim, loyalty: e.target.checked })}
                  />{' '}
                  {t('promo.detail.loyaltyBenefit', { defaultValue: 'Loyalty benefit' })}
                </label>
                <Button size="sm" disabled={simulate.isPending} onClick={() => simulate.mutate()}>
                  {t('promo.detail.checkOut', { defaultValue: 'Check out' })}
                </Button>
                {simulate.data && (
                  <div
                    className={cn(
                      'rounded-lg px-3 py-2 text-xs',
                      simulate.data.allowed
                        ? 'bg-success-tint text-success'
                        : 'bg-warning-tint text-foreground',
                    )}
                  >
                    {simulate.data.message}
                    {simulate.data.appliedOrder.length ? (
                      <div className="mt-1 text-2xs opacity-80">
                        {t('promo.detail.applyOrder', {
                          defaultValue: 'Applied in order: {{o}}',
                          o: simulate.data.appliedOrder.join(' → '),
                        })}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            </Panel>
            <NavLink
              to="/performance/results"
              className={cn(
                SECTION_CARD,
                'block p-3 text-center text-xs font-semibold text-primary',
              )}
            >
              {t('promo.detail.allResults', { defaultValue: 'All campaign results →' })}
            </NavLink>
          </aside>
        </div>
      </div>
    </div>
  );
}
