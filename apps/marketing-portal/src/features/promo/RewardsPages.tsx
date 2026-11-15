import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, FormField, HBarChart, Input, Pill, Skeleton, cn, toast } from '@yiji/ui';
import type { EarningRule } from '@yiji/shared-types';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { useEngine } from '../../engine/index.js';
import { PageHeader, PAGE_BODY, SECTION_CARD } from '../../components/shell/Page.js';
import {
  AreaTabs,
  KeyValue,
  Panel,
  SampleDataPill,
  Tile,
  dateLabel,
  int,
  pct,
  sar,
  useEngineQuery,
} from './shared.js';

function useTabs() {
  const { t } = useTranslation();
  return [
    {
      to: '/rewards',
      label: t('promo.rewards.tabOverview', { defaultValue: 'Overview' }),
      end: true,
    },
    { to: '/rewards/earn', label: t('promo.rewards.tabEarn', { defaultValue: 'Earn' }) },
    { to: '/rewards/redeem', label: t('promo.rewards.tabRedeem', { defaultValue: 'Redeem' }) },
    { to: '/rewards/members', label: t('promo.rewards.tabMembers', { defaultValue: 'Members' }) },
  ];
}

export function RewardsOverviewPage() {
  const { t } = useTranslation();
  const tabs = useTabs();
  const stats = useEngineQuery(['rewards-stats'], (e) => e.rewardsStats());
  const rules = useEngineQuery(['earning-rules'], (e) => e.earningRules());
  const camps = useEngineQuery(['rewards-campaigns'], (e) => e.rewardsCampaigns());
  const items = useEngineQuery(['rewards-items'], (e) => e.rewardsItems());
  const s = stats.data;
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('promo.rewards.title', { defaultValue: 'Rewards' })}
        description={t('promo.rewards.desc', {
          defaultValue:
            'Customers earn cashback, it becomes points, and points buy meals in the rewards marketplace. Cashback is no longer deducted at checkout.',
        })}
        titleExtra={<SampleDataPill />}
      />
      <div className={PAGE_BODY}>
        <AreaTabs tabs={tabs} />
        {stats.isLoading && <Skeleton className="h-40 w-full" />}
        {s && (
          <>
            <div className="mb-4 grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
              <Tile
                label={t('promo.rewards.outstanding', { defaultValue: 'Outstanding points' })}
                value={int(s.outstandingPoints)}
                caption={t('promo.rewards.liability', {
                  defaultValue: 'liability {{v}} at face value',
                  v: sar(s.outstandingSar),
                })}
                tone="primary"
              />
              <Tile
                label={t('promo.rewards.issued', { defaultValue: 'Points issued (6 months)' })}
                value={int(s.issuedPoints6m)}
              />
              <Tile
                label={t('promo.rewards.redeemed', { defaultValue: 'Points redeemed' })}
                value={int(s.redeemedPoints6m)}
                caption={t('promo.rewards.redemptionRate', {
                  defaultValue: '{{p}} redemption rate',
                  p: pct((s.redeemedPoints6m / s.issuedPoints6m) * 100),
                })}
              />
              <Tile
                label={t('promo.rewards.expired', { defaultValue: 'Points expired' })}
                value={int(s.expiredPoints6m)}
                caption={t('promo.rewards.breakage', {
                  defaultValue: 'breakage {{p}}',
                  p: pct((s.expiredPoints6m / s.issuedPoints6m) * 100),
                })}
              />
              <Tile
                label={t('promo.rewards.realCost', { defaultValue: 'Real cost of redemptions' })}
                value={sar(s.realCostSar)}
                caption={t('promo.rewards.atFoodCost', { defaultValue: 'at food cost' })}
              />
              <Tile
                label={t('promo.rewards.members', { defaultValue: 'Members earning / redeeming' })}
                value={`${int(s.activeMembers)} / ${int(s.redeemingMembers)}`}
                caption={t('promo.rewards.earnersRedeem', {
                  defaultValue: '{{p}} of earners redeemed',
                  p: pct((s.redeemingMembers / s.activeMembers) * 100),
                })}
              />
            </div>
            <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
              <Panel
                title={t('promo.rewards.chart', {
                  defaultValue: 'Points issued, redeemed and expired',
                })}
              >
                <HBarChart
                  rows={s.perMonth.map((m) => ({
                    label: m.month,
                    values: { issued: m.issued, redeemed: m.redeemed, expired: m.expired },
                  }))}
                  series={[
                    {
                      key: 'issued',
                      label: t('promo.rewards.issuedShort', { defaultValue: 'Issued' }),
                      tone: 'warning',
                    },
                    {
                      key: 'redeemed',
                      label: t('promo.rewards.redeemedShort', { defaultValue: 'Redeemed' }),
                      tone: 'success',
                    },
                    {
                      key: 'expired',
                      label: t('promo.rewards.expiredShort', { defaultValue: 'Expired' }),
                      tone: 'sky',
                    },
                  ]}
                  format={(v) => int(v)}
                />
              </Panel>
              <Panel title={t('promo.home.needsAttention', { defaultValue: 'Needs attention' })}>
                <p className="rounded-lg bg-warning-tint px-3 py-2 text-xs text-foreground">
                  {t('promo.rewards.expiringSoon', {
                    defaultValue: '{{p}} points expire in the next {{d}} days for {{c}} customers.',
                    p: int(s.expiringSoon.points),
                    d: s.expiringSoon.withinDays,
                    c: int(s.expiringSoon.customers),
                  })}
                </p>
                <KeyValue
                  rows={(camps.data ?? [])
                    .filter((c) => c.active)
                    .map((c) => [
                      c.name,
                      `${pct((c.usedPoints / c.budgetPoints) * 100)} ${t('promo.rewards.ofBudget', { defaultValue: 'of budget' })}`,
                    ])}
                />
              </Panel>
            </div>
            <div className="mt-4 grid gap-4 lg:grid-cols-3">
              <Panel title={t('promo.rewards.earningRules', { defaultValue: 'Earning rules' })}>
                <KeyValue
                  rows={(rules.data ?? []).map((r) => [
                    r.name,
                    `${r.cashbackPct.DELIVERY}% delivery · ${r.cashbackPct.PICKUP}% pickup · ${r.cashbackPct.CARHOP}% carhop`,
                  ])}
                />
              </Panel>
              <Panel title={t('promo.rewards.liveCampaigns', { defaultValue: 'Live campaigns' })}>
                <KeyValue
                  rows={(camps.data ?? [])
                    .filter((c) => c.active)
                    .map((c) => [c.name, c.kind.toLowerCase()])}
                />
              </Panel>
              <Panel
                title={t('promo.rewards.marketplace', { defaultValue: 'Rewards marketplace' })}
              >
                <KeyValue
                  rows={[
                    [
                      t('promo.rewards.liveRewards', { defaultValue: 'Live rewards' }),
                      `${(items.data ?? []).filter((i) => i.active).length} of ${items.data?.length ?? 0}`,
                    ],
                    [
                      t('promo.rewards.premium', { defaultValue: 'Premium (boosted)' }),
                      int((items.data ?? []).filter((i) => i.premium).length),
                    ],
                  ]}
                />
              </Panel>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function RewardsEarnPage() {
  const { t } = useTranslation();
  const tabs = useTabs();
  const { can } = useAuth();
  const engine = useEngine();
  const qc = useQueryClient();
  const rules = useEngineQuery(['earning-rules'], (e) => e.earningRules());
  const camps = useEngineQuery(['rewards-campaigns'], (e) => e.rewardsCampaigns());
  const [draft, setDraft] = useState<Omit<EarningRule, 'id'> | null>(null);
  const [editing, setEditing] = useState<string | undefined>();
  const save = useMutation({
    mutationFn: (r: Omit<EarningRule, 'id'>) => engine.saveEarningRule(r, editing),
    onSuccess: () => {
      toast.success(t('promo.rewards.ruleSaved', { defaultValue: 'Earning rule saved.' }));
      setDraft(null);
      setEditing(undefined);
      void qc.invalidateQueries({ queryKey: ['promo'] });
    },
  });
  const start = (r?: EarningRule) => {
    setEditing(r?.id);
    setDraft(
      r
        ? { ...r }
        : {
            name: '',
            cashbackPct: { DELIVERY: 5, PICKUP: 8, CARHOP: 10, DINE_IN: 5 },
            brandIds: [],
            active: true,
            validFrom: new Date().toISOString().slice(0, 10),
            validTo: null,
          },
    );
  };
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('promo.rewards.earnTitle', { defaultValue: 'Earn' })}
        description={t('promo.rewards.earnDesc', {
          defaultValue:
            'How customers earn: cashback percentages by order type, and the points campaigns on top.',
        })}
        titleExtra={<SampleDataPill />}
        actions={
          can('manage_marketing') ? (
            <Button onClick={() => start()}>
              {t('promo.rewards.newRule', { defaultValue: '+ New earning rule' })}
            </Button>
          ) : undefined
        }
      />
      <div className={PAGE_BODY}>
        <AreaTabs tabs={tabs} />
        {draft && (
          <Panel
            title={
              editing
                ? t('promo.rewards.editRule', { defaultValue: 'Edit earning rule' })
                : t('promo.rewards.newRule', { defaultValue: '+ New earning rule' })
            }
            className="mb-4"
          >
            <div className="grid gap-3 sm:grid-cols-5">
              <FormField label={t('promo.rewards.ruleName', { defaultValue: 'Name' })}>
                <Input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </FormField>
              {(['DELIVERY', 'PICKUP', 'CARHOP', 'DINE_IN'] as const).map((k) => (
                <FormField key={k} label={`${k.replace('_', ' ').toLowerCase()} %`}>
                  <Input
                    type="number"
                    min={0}
                    max={50}
                    value={draft.cashbackPct[k]}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        cashbackPct: { ...draft.cashbackPct, [k]: Number(e.target.value) },
                      })
                    }
                  />
                </FormField>
              ))}
            </div>
            <div className="mt-3 flex gap-2">
              <Button
                disabled={!draft.name.trim() || save.isPending}
                onClick={() => save.mutate(draft)}
              >
                {t('actions.save', { ns: 'common', defaultValue: 'Save' })}
              </Button>
              <Button variant="ghost" onClick={() => setDraft(null)}>
                {t('actions.cancel', { ns: 'common', defaultValue: 'Cancel' })}
              </Button>
            </div>
          </Panel>
        )}
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title={t('promo.rewards.earningRules', { defaultValue: 'Earning rules' })}>
            {rules.isLoading && <Skeleton className="h-24 w-full" />}
            <ul className="space-y-2">
              {(rules.data ?? []).map((r) => (
                <li
                  key={r.id}
                  className="flex items-center justify-between gap-3 rounded-xl bg-secondary/40 p-3"
                >
                  <div>
                    <div className="text-sm font-semibold text-foreground">{r.name}</div>
                    <div className="text-2xs text-muted-foreground">
                      {r.cashbackPct.DELIVERY}% delivery · {r.cashbackPct.PICKUP}% pickup ·{' '}
                      {r.cashbackPct.CARHOP}% carhop ·{' '}
                      {r.brandIds.length
                        ? r.brandIds.join(', ')
                        : t('promo.detail.allBrands', { defaultValue: 'All brands' })}{' '}
                      · {dateLabel(r.validFrom)}
                      {r.validTo ? ` → ${dateLabel(r.validTo)}` : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Pill tone={r.active ? 'success' : 'neutral'} size="sm">
                      {r.active
                        ? t('promo.status.live', { defaultValue: 'Live' })
                        : t('promo.gift.off', { defaultValue: 'Off' })}
                    </Pill>
                    {can('manage_marketing') && (
                      <Button size="sm" variant="ghost" onClick={() => start(r)}>
                        {t('promo.detail.edit', { defaultValue: 'Edit' })}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
          <Panel title={t('promo.rewards.pointsCampaigns', { defaultValue: 'Points campaigns' })}>
            <ul className="space-y-2">
              {(camps.data ?? []).map((c) => (
                <li key={c.id} className="rounded-xl bg-secondary/40 p-3">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold text-foreground">{c.name}</div>
                    <Pill tone={c.active ? 'success' : 'neutral'} size="sm">
                      {c.kind.toLowerCase()}
                    </Pill>
                  </div>
                  <div className="mt-1 text-2xs text-muted-foreground">
                    {c.points
                      ? t('promo.rewards.pointsEach', {
                          defaultValue: '{{n}} points each · ',
                          n: c.points,
                        })
                      : ''}
                    {int(c.usedPoints)} / {int(c.budgetPoints)}{' '}
                    {t('promo.rewards.pointsUsed', { defaultValue: 'points used' })} (
                    {pct((c.usedPoints / c.budgetPoints) * 100)})
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}

export function RewardsRedeemPage() {
  const { t } = useTranslation();
  const tabs = useTabs();
  const items = useEngineQuery(['rewards-items'], (e) => e.rewardsItems());
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('promo.rewards.redeemTitle', { defaultValue: 'Redeem' })}
        description={t('promo.rewards.redeemDesc', {
          defaultValue:
            'The rewards marketplace: what points buy, what each reward really costs, and how often it is taken.',
        })}
        titleExtra={<SampleDataPill />}
      />
      <div className={PAGE_BODY}>
        <AreaTabs tabs={tabs} />
        {items.isLoading && <Skeleton className="h-40 w-full" />}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {(items.data ?? []).map((i) => (
            <div key={i.id} className={cn(SECTION_CARD, 'p-4')}>
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-foreground">{i.name.en}</div>
                {i.premium && (
                  <Pill tone="primary" size="sm">
                    {t('promo.rewards.premiumShort', { defaultValue: 'Premium' })}
                  </Pill>
                )}
              </div>
              <div className="mt-2 text-lg font-extrabold tabular-nums text-foreground">
                {int(i.pointsCost)}{' '}
                <span className="text-xs font-medium text-muted-foreground">
                  {t('promo.rewards.points', { defaultValue: 'points' })}
                </span>
              </div>
              <div className="text-2xs text-muted-foreground">
                {t('promo.rewards.costsUs', {
                  defaultValue: 'costs us {{c}} · taken {{n}} times',
                  c: sar(i.costSar),
                  n: int(i.redeemed),
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function RewardsMembersPage() {
  const { t } = useTranslation();
  const tabs = useTabs();
  const [q, setQ] = useState('');
  const members = useEngineQuery(['rewards-members', q], (e) => e.rewardsMembers(q, 60));
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('promo.rewards.membersTitle', { defaultValue: 'Members' })}
        description={t('promo.rewards.membersDesc', {
          defaultValue:
            'Who holds points, their tier, and what they earned and redeemed in the last year.',
        })}
        titleExtra={<SampleDataPill />}
      />
      <div className={PAGE_BODY}>
        <AreaTabs tabs={tabs} />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('promo.rewards.search', { defaultValue: 'Search by name or phone' })}
          className="mb-3 h-9 w-72"
        />
        <div className={cn(SECTION_CARD, 'overflow-x-auto')}>
          <table className="w-full min-w-[48rem] text-xs">
            <thead className="text-muted-foreground">
              <tr>
                {[
                  t('promo.rewards.member', { defaultValue: 'Member' }),
                  t('promo.rewards.tier', { defaultValue: 'Tier' }),
                  t('promo.rewards.points', { defaultValue: 'points' }),
                  t('promo.rewards.earned12m', { defaultValue: 'Earned (12 m)' }),
                  t('promo.rewards.redeemed12m', { defaultValue: 'Redeemed (12 m)' }),
                  t('promo.rewards.lastOrder', { defaultValue: 'Last order' }),
                ].map((h, i) => (
                  <th key={h} className={cn('px-3 py-2', i < 2 ? 'text-start' : 'text-end')}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(members.data ?? []).map((m) => (
                <tr key={m.customerId} className="border-t border-foreground/[0.06]">
                  <td className="px-3 py-1.5">
                    <div className="font-semibold text-foreground">{m.name}</div>
                    <div className="text-2xs text-muted-foreground">{m.phone}</div>
                  </td>
                  <td className="px-3">
                    <Pill
                      tone={
                        m.tier === 'VIP' ? 'primary' : m.tier === 'GOLD' ? 'warning' : 'neutral'
                      }
                      size="sm"
                    >
                      {m.tier}
                    </Pill>
                  </td>
                  <td className="px-3 text-end tabular-nums">{int(m.points)}</td>
                  <td className="px-3 text-end tabular-nums">{int(m.earned12m)}</td>
                  <td className="px-3 text-end tabular-nums">{int(m.redeemed12m)}</td>
                  <td className="px-3 text-end">{dateLabel(m.lastOrderAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
