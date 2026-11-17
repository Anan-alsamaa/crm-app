import { useMemo, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Input, Pill, Skeleton, cn, toast } from '@yiji/ui';
import {
  OBJECTIVE_CATALOGUE,
  OBJECTIVE_GOALS,
  canApproveCampaign,
  offerLabel,
  type Campaign,
  type CampaignStatus,
} from '@yiji/shared-types';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { useEngine } from '../../engine/index.js';
import { PageHeader, PAGE_BODY, SECTION_CARD } from '../../components/shell/Page.js';
import {
  AreaTabs,
  KeyValue,
  Panel,
  SampleDataPill,
  StatusPill,
  Tile,
  WorkflowStrip,
  dateLabel,
  int,
  sar,
  useEngineQuery,
  useGoalLabels,
  useObjectiveLabels,
} from './shared.js';

function useCouponTabs(waiting: number) {
  const { t } = useTranslation();
  return [
    {
      to: '/coupons',
      label: t('promo.coupons.tabTypes', { defaultValue: 'Coupon types' }),
      end: true,
    },
    { to: '/coupons/all', label: t('promo.coupons.tabAll', { defaultValue: 'All coupons' }) },
    {
      to: '/coupons/approvals',
      label: t('promo.coupons.tabApprovals', { defaultValue: 'Approvals' }),
      badge: waiting,
    },
  ];
}

/* ── Coupon types: the 16 goals, each with its recommended set-up ────────── */

export function CouponTypesPage() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const labels = useObjectiveLabels();
  const goals = useGoalLabels();
  const [goal, setGoal] = useState<string>('all');
  const campaigns = useEngineQuery(['campaigns', 'all'], (e) => e.listCampaigns({ status: 'all' }));
  const perf = useEngineQuery(['campaigns', 'all-perf'], async (e) => {
    const cs = await e.listCampaigns({ status: 'all' });
    const out: Record<
      string,
      { redeemed: number; revenueSar: number; roiPct: number; campaigns: number; live: number }
    > = {};
    for (const c of cs) {
      const p = await e.performance(c.id);
      const o = (out[c.objective] ??= {
        redeemed: 0,
        revenueSar: 0,
        roiPct: 0,
        campaigns: 0,
        live: 0,
      });
      o.redeemed += p.redeemed;
      o.revenueSar += p.revenueSar;
      o.roiPct = p.roiPct || o.roiPct;
      o.campaigns += 1;
      if (c.status === 'live') o.live += 1;
    }
    return out;
  });
  const waiting = (campaigns.data ?? []).filter((c) => c.status === 'waiting_approval').length;
  const tabs = useCouponTabs(waiting);
  const totals = useMemo(() => {
    const cs = campaigns.data ?? [];
    const p = Object.values(perf.data ?? {});
    return {
      types: OBJECTIVE_CATALOGUE.length,
      campaigns: cs.length,
      live: cs.filter((c) => c.status === 'live').length,
      redeemed: p.reduce((s, x) => s + x.redeemed, 0),
      revenue: p.reduce((s, x) => s + x.revenueSar, 0),
    };
  }, [campaigns.data, perf.data]);
  const list = OBJECTIVE_CATALOGUE.filter((o) => goal === 'all' || o.goal === goal);
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('promo.coupons.title', { defaultValue: 'Coupons' })}
        description={t('promo.coupons.desc', {
          defaultValue:
            'Sixteen coupon types, one for each marketing goal. Pick the goal; the recommended set-up is pre-filled.',
        })}
        titleExtra={<SampleDataPill />}
        actions={
          <Button onClick={() => nav('/coupons/new')}>
            {t('promo.home.createCoupon', { defaultValue: '+ Create coupon' })}
          </Button>
        }
      />
      <div className={PAGE_BODY}>
        <WorkflowStrip current={3} />
        <AreaTabs tabs={tabs} />
        <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Tile
            label={t('promo.coupons.types', { defaultValue: 'Coupon types' })}
            value={totals.types}
            caption={t('promo.coupons.typesCaption', {
              defaultValue: 'one for each marketing goal',
            })}
            tone="primary"
          />
          <Tile
            label={t('promo.coupons.campaigns', { defaultValue: 'Campaigns' })}
            value={int(totals.campaigns)}
            caption={t('promo.coupons.liveNow', { defaultValue: '{{n}} live now', n: totals.live })}
          />
          <Tile
            label={t('promo.coupons.redeemed', { defaultValue: 'Coupons redeemed' })}
            value={int(totals.redeemed)}
          />
          <Tile
            label={t('promo.coupons.sales', { defaultValue: 'Sales with a coupon' })}
            value={sar(totals.revenue)}
          />
        </div>
        <div className="mb-4 flex flex-wrap gap-1.5">
          {['all', ...OBJECTIVE_GOALS].map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => setGoal(g)}
              aria-pressed={goal === g}
              className={cn(
                'rounded-full px-3 py-1 text-xs font-semibold ring-1 ring-inset',
                goal === g
                  ? 'bg-ink text-ink-foreground ring-transparent'
                  : 'bg-card text-foreground/80 ring-foreground/[0.08]',
              )}
            >
              {g === 'all' ? t('promo.coupons.allTypes', { defaultValue: 'All types' }) : goals[g]}
              <span className="ms-1 text-muted-foreground">
                ·{' '}
                {g === 'all'
                  ? OBJECTIVE_CATALOGUE.length
                  : OBJECTIVE_CATALOGUE.filter((o) => o.goal === g).length}
              </span>
            </button>
          ))}
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {list.map((o) => {
            const p = perf.data?.[o.key];
            const rec = o.recommended;
            return (
              <article key={o.key} className={cn(SECTION_CARD, 'flex flex-col p-4')}>
                <div className="flex items-start justify-between gap-2">
                  <h2 className="text-sm font-semibold text-foreground">{labels[o.key]?.title}</h2>
                  {p?.live ? (
                    <Pill tone="success" size="sm" dot>
                      {t('promo.coupons.nLive', { defaultValue: '{{n}} live', n: p.live })}
                    </Pill>
                  ) : null}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{labels[o.key]?.body}</p>
                <div className="mt-3 rounded-xl bg-ink p-3 text-ink-foreground">
                  <div className="text-2xs font-semibold uppercase tracking-[0.12em] opacity-70">
                    {t('promo.coupons.recommended', { defaultValue: 'Recommended setup' })}
                  </div>
                  <KeyValueDark
                    rows={[
                      [
                        t('promo.coupons.offer', { defaultValue: 'Offer' }),
                        `${offerLabel({ ...rec.offer, onRefund: 'RETURN_IF_VALID', onCancelBeforeCompletion: 'REISSUE_IF_VALID' } as Campaign['offer'])} · min. SAR ${rec.minOrderSar}`,
                      ],
                      [
                        t('promo.coupons.customers', { defaultValue: 'Customers' }),
                        rec.audience.conditions
                          .map((c) => `${c.c.replace(/_/g, ' ').toLowerCase()} ${c.p}`)
                          .join(', ') || t('promo.coupons.everyone', { defaultValue: 'Everyone' }),
                      ],
                      [
                        t('promo.coupons.validFor', { defaultValue: 'Valid for' }),
                        t('promo.coupons.days', {
                          defaultValue: '{{n}} days',
                          n: rec.validityDays,
                        }),
                      ],
                      [
                        t('promo.coupons.channels', { defaultValue: 'Channels' }),
                        rec.channels.map((c) => c.replace(/_/g, ' ').toLowerCase()).join(' · '),
                      ],
                    ]}
                  />
                </div>
                {p ? (
                  <dl className="mt-3 grid grid-cols-4 gap-2 text-center">
                    {[
                      [
                        int(p.campaigns),
                        t('promo.coupons.campaigns', { defaultValue: 'Campaigns' }),
                      ],
                      [
                        int(p.redeemed),
                        t('promo.coupons.redeemedShort', { defaultValue: 'redeemed' }),
                      ],
                      [sar(p.revenueSar), t('promo.coupons.salesShort', { defaultValue: 'sales' })],
                      [`${p.roiPct}%`, t('promo.coupons.return', { defaultValue: 'return' })],
                    ].map(([v, l]) => (
                      <div key={String(l)}>
                        <dd className="text-xs font-bold tabular-nums text-foreground">{v}</dd>
                        <dt className="text-2xs text-muted-foreground">{l}</dt>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <p className="mt-3 text-2xs italic text-muted-foreground">
                    {t('promo.coupons.notUsedYet', { defaultValue: 'Not used yet' })}
                  </p>
                )}
                <div className="mt-auto flex gap-2 pt-3">
                  <Button size="sm" onClick={() => nav(`/coupons/new?objective=${o.key}`)}>
                    {t('promo.coupons.create', { defaultValue: '+ Create' })}
                  </Button>
                  {p?.campaigns ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => nav(`/coupons/all?objective=${o.key}`)}
                    >
                      {t('promo.coupons.viewN', {
                        defaultValue: 'View {{n}} campaigns',
                        n: p.campaigns,
                      })}
                    </Button>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function KeyValueDark({ rows }: { rows: ReadonlyArray<[string, string]> }) {
  return (
    <dl className="mt-1 space-y-1 text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="flex gap-2">
          <dt className="w-20 shrink-0 opacity-60">{k}</dt>
          <dd className="font-medium">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ── All coupons: every campaign, filterable ─────────────────────────────── */

export function AllCouponsPage() {
  const { t } = useTranslation();
  const labels = useObjectiveLabels();
  const params = new URLSearchParams(window.location.search);
  const [status, setStatus] = useState<CampaignStatus | 'all'>('all');
  const [q, setQ] = useState('');
  const objective = params.get('objective');
  const campaigns = useEngineQuery(['campaigns', 'all'], (e) => e.listCampaigns({ status: 'all' }));
  const waiting = (campaigns.data ?? []).filter((c) => c.status === 'waiting_approval').length;
  const tabs = useCouponTabs(waiting);
  const rows = (campaigns.data ?? []).filter(
    (c) =>
      (status === 'all' || c.status === status) &&
      (!objective || c.objective === objective) &&
      (!q || `${c.id} ${c.name.en} ${c.name.ar}`.toLowerCase().includes(q.toLowerCase())),
  );
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('promo.coupons.allTitle', { defaultValue: 'All coupons' })}
        description={t('promo.coupons.allDesc', {
          defaultValue:
            'Every campaign, whatever its stage, with who created it and what it gives.',
        })}
        titleExtra={<SampleDataPill />}
      />
      <div className={PAGE_BODY}>
        <WorkflowStrip current={3} />
        <AreaTabs tabs={tabs} />
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {(
            [
              'all',
              'draft',
              'finance_review',
              'waiting_approval',
              'approved',
              'live',
              'paused',
              'ended',
              'rejected',
            ] as const
          ).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(s)}
              aria-pressed={status === s}
              className={cn(
                'rounded-full px-3 py-1 text-xs font-semibold ring-1 ring-inset',
                status === s
                  ? 'bg-ink text-ink-foreground ring-transparent'
                  : 'bg-card text-foreground/80 ring-foreground/[0.08]',
              )}
            >
              {s === 'all' ? (
                t('promo.coupons.allStatuses', { defaultValue: 'All' })
              ) : (
                <StatusText status={s} />
              )}
            </button>
          ))}
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('promo.coupons.search', { defaultValue: 'Search by code or name' })}
            className="ms-auto h-8 w-60"
          />
        </div>
        {campaigns.isLoading && <Skeleton className="h-40 w-full" />}
        <div className="grid gap-3">
          {rows.map((c) => (
            <NavLink
              key={c.id}
              to={`/coupons/${c.id}`}
              className={cn(
                SECTION_CARD,
                'grid gap-2 p-4 hover:shadow-float sm:grid-cols-[1fr_auto_auto_auto] sm:items-center',
              )}
            >
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-2xs text-muted-foreground">{c.id}</span>
                  <StatusPill status={c.status} />
                </div>
                <div className="mt-1 text-sm font-semibold text-foreground">{c.name.en}</div>
                <div className="text-xs text-muted-foreground">
                  {labels[c.objective]?.title} · {offerLabel(c.offer)} ·{' '}
                  {t('promo.coupons.minOrder', {
                    defaultValue: 'min. SAR {{n}}',
                    n: c.rules.minOrderSar,
                  })}
                </div>
              </div>
              <div className="text-xs text-muted-foreground">
                {dateLabel(c.schedule.startDate)} → {dateLabel(c.schedule.endDate)}
              </div>
              <div className="text-xs text-muted-foreground">
                {t('promo.coupons.by', { defaultValue: 'by {{who}}', who: c.createdBy })}
              </div>
              <div className="text-xs font-semibold text-foreground">{sar(c.limits.budgetSar)}</div>
            </NavLink>
          ))}
          {!campaigns.isLoading && rows.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {t('promo.coupons.none', { defaultValue: 'No campaigns match.' })}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusText({ status }: { status: CampaignStatus }) {
  const { t } = useTranslation();
  const m: Record<CampaignStatus, string> = {
    draft: t('promo.status.draft', { defaultValue: 'Draft' }),
    finance_review: t('promo.status.finance_review', { defaultValue: 'Finance review' }),
    waiting_approval: t('promo.status.waiting_approval', { defaultValue: 'Waiting approval' }),
    approved: t('promo.status.approved', { defaultValue: 'Approved' }),
    live: t('promo.status.live', { defaultValue: 'Live' }),
    paused: t('promo.status.paused', { defaultValue: 'Paused' }),
    ended: t('promo.status.ended', { defaultValue: 'Ended' }),
    rejected: t('promo.status.rejected', { defaultValue: 'Rejected' }),
  };
  return <>{m[status]}</>;
}

/* ── Approvals: four eyes ────────────────────────────────────────────────── */

export function CampaignApprovalsPage() {
  const { t } = useTranslation();
  const { user, can } = useAuth();
  const engine = useEngine();
  const qc = useQueryClient();
  const labels = useObjectiveLabels();
  const campaigns = useEngineQuery(['campaigns', 'all'], (e) => e.listCampaigns({ status: 'all' }));
  const waiting = (campaigns.data ?? []).filter((c) => c.status === 'waiting_approval');
  const tabs = useCouponTabs(waiting.length);
  const [note, setNote] = useState<Record<string, string>>({});
  const decide = useMutation({
    mutationFn: (v: { id: string; decision: 'approve' | 'reject'; note: string }) =>
      engine.decideCampaign(v.id, v.decision, v.note),
    onSuccess: (c) => {
      toast.success(
        c.status === 'approved'
          ? t('promo.approvals.approved', { defaultValue: '{{id}} approved.', id: c.id })
          : t('promo.approvals.rejected', { defaultValue: '{{id}} rejected.', id: c.id }),
      );
      void qc.invalidateQueries({ queryKey: ['promo'] });
    },
    onError: (e) =>
      toast.error(t('promo.approvals.failed', { defaultValue: 'Could not record the decision' }), {
        description: (e as Error).message,
      }),
  });
  const me = user?.id ?? '';
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('promo.approvals.title', { defaultValue: 'Approvals' })}
        description={t('promo.approvals.desc', {
          defaultValue:
            'Campaigns that could cost more than the approval threshold, give a deep discount, or forecast a loss need a second person. The person who made the request can never approve it.',
        })}
        titleExtra={<SampleDataPill />}
      />
      <div className={PAGE_BODY}>
        <WorkflowStrip current={3} />
        <AreaTabs tabs={tabs} />
        {waiting.length === 0 && !campaigns.isLoading && (
          <p className="text-sm text-muted-foreground">
            {t('promo.approvals.none', { defaultValue: 'Nothing is waiting for approval.' })}
          </p>
        )}
        <div className="grid gap-4">
          {waiting.map((c) => {
            const gate = canApproveCampaign(c, me);
            const f = c.snapshot;
            return (
              <Panel
                key={c.id}
                title={
                  <span>
                    {c.name.en}{' '}
                    <span className="ms-2 font-mono text-2xs text-muted-foreground">
                      {c.id} ·{' '}
                      {t('promo.coupons.by', { defaultValue: 'by {{who}}', who: c.createdBy })} ·{' '}
                      {dateLabel(c.approval.requestedAt)}
                    </span>
                  </span>
                }
                aside={
                  f ? (
                    <Pill tone={f.needsApproval ? 'warning' : 'success'} size="sm">
                      {f.needsApproval
                        ? t('promo.approvals.needs', {
                            defaultValue:
                              'Needs approval: most it can cost is {{cost}} (limit {{limit}})',
                            cost: sar(f.mostItCanCostSar),
                            limit: sar(20000),
                          })
                        : t('promo.approvals.withinLimits', { defaultValue: 'Within limits' })}
                    </Pill>
                  ) : null
                }
              >
                <KeyValue
                  rows={[
                    [
                      t('promo.wizard.objective', { defaultValue: 'Objective' }),
                      labels[c.objective]?.title ?? c.objective,
                    ],
                    [
                      t('promo.approvals.targetCustomers', { defaultValue: 'Target customers' }),
                      f
                        ? t('promo.approvals.willReceive', {
                            defaultValue: '{{n}} will receive it',
                            n: int(f.customersMatched),
                          })
                        : c.audience.mode,
                    ],
                    [t('promo.coupons.offer', { defaultValue: 'Offer' }), offerLabel(c.offer)],
                    [
                      t('promo.coupons.minOrder', {
                        defaultValue: 'min. SAR {{n}}',
                        n: c.rules.minOrderSar,
                      }),
                      c.scope.orderTypes.join(', '),
                    ],
                    [
                      t('promo.approvals.usageLimits', { defaultValue: 'Usage limits' }),
                      `${c.limits.perCustomerMode === 'ONE' ? '1 per customer' : c.limits.perCustomerMode} · ${int(c.limits.totalRedemptions)} in total · ${t('promo.approvals.budget', { defaultValue: 'budget {{b}}', b: sar(c.limits.budgetSar) })}`,
                    ],
                    [
                      t('promo.approvals.expectedCost', { defaultValue: 'Expected cost' }),
                      f
                        ? `${sar(f.discountSar + f.messageCostSar)} (${t('promo.approvals.mostItCanCost', { defaultValue: 'most it can cost {{m}}', m: sar(f.mostItCanCostSar) })})`
                        : '—',
                    ],
                    [
                      t('promo.approvals.expectedReturn', { defaultValue: 'Expected return' }),
                      f ? `${sar(f.netSar)} · ${f.roiPct}%` : '—',
                    ],
                  ]}
                />
                {f && f.netSar < 0 && (
                  <p className="mt-3 rounded-lg bg-warning-tint px-3 py-2 text-xs text-foreground ring-1 ring-inset ring-warning/25">
                    {t('promo.approvals.lossWarning', {
                      defaultValue:
                        'The forecast shows a loss: the discount is expected to cost more than the extra profit it brings.',
                    })}
                  </p>
                )}
                {!gate.ok && gate.reason === 'own' && (
                  <p className="mt-3 rounded-lg bg-secondary px-3 py-2 text-xs text-muted-foreground">
                    {t('promo.approvals.ownCampaign', {
                      defaultValue: 'You created this campaign, so another user must approve it.',
                    })}
                  </p>
                )}
                {gate.ok && can('approve_marketing') && (
                  <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-foreground/[0.07] pt-3">
                    <Input
                      value={note[c.id] ?? ''}
                      onChange={(e) => setNote({ ...note, [c.id]: e.target.value })}
                      placeholder={t('promo.approvals.notePlaceholder', {
                        defaultValue: 'A note for the requester (required to reject)',
                      })}
                      className="h-9 min-w-[16rem] flex-1"
                    />
                    <Button
                      size="sm"
                      disabled={decide.isPending}
                      onClick={() =>
                        decide.mutate({ id: c.id, decision: 'approve', note: note[c.id] ?? '' })
                      }
                    >
                      {t('promo.approvals.approve', { defaultValue: 'Approve' })}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      disabled={decide.isPending || !(note[c.id] ?? '').trim()}
                      onClick={() =>
                        decide.mutate({ id: c.id, decision: 'reject', note: note[c.id] ?? '' })
                      }
                    >
                      {t('promo.approvals.reject', { defaultValue: 'Reject' })}
                    </Button>
                  </div>
                )}
              </Panel>
            );
          })}
        </div>
      </div>
    </div>
  );
}
