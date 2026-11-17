import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Pill, Skeleton, cn, toast } from '@yiji/ui';
import { CAMPAIGN_FIELD_SPEC, DEFAULT_MONEY_MODEL, LOCKED_WHEN_LIVE } from '@yiji/shared-types';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { useEngine, useEngineChoice } from '../../engine/index.js';
import { resetSampleEngine } from '../../engine/sample.js';
import { PageHeader, PAGE_BODY, SECTION_CARD } from '../../components/shell/Page.js';
import { AreaTabs, KeyValue, Panel, SampleDataPill, pct, sar, useEngineQuery } from './shared.js';

function useTabs() {
  const { t } = useTranslation();
  return [
    {
      to: '/settings',
      label: t('promo.settings.tabGeneral', { defaultValue: 'Coupon rules' }),
      end: true,
    },
    {
      to: '/settings/stacking',
      label: t('promo.settings.tabStacking', { defaultValue: 'Stacking & compatibility' }),
    },
    {
      to: '/settings/brands-menus',
      label: t('promo.settings.tabBrands', { defaultValue: 'Brands & menus' }),
    },
    {
      to: '/settings/field-spec',
      label: t('promo.settings.tabFields', { defaultValue: 'Field specification' }),
    },
    {
      to: '/settings/architecture',
      label: t('promo.settings.tabArchitecture', { defaultValue: 'Architecture & API' }),
    },
  ];
}

export function SettingsGeneralPage() {
  const { t } = useTranslation();
  const tabs = useTabs();
  const { isOwner } = useAuth();
  const model = useEngineQuery(['money-model'], (e) => e.moneyModel());
  const choice = useEngineChoice();
  const m = model.data ?? DEFAULT_MONEY_MODEL;
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('promo.settings.title', { defaultValue: 'Coupon settings' })}
        description={t('promo.settings.desc', {
          defaultValue:
            'The business rules every campaign is checked against, and who may create and approve.',
        })}
        titleExtra={<SampleDataPill />}
      />
      <div className={PAGE_BODY}>
        <AreaTabs tabs={tabs} />
        <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
          <div className="space-y-4">
            <Panel title={t('promo.settings.businessRules', { defaultValue: 'Business rules' })}>
              <KeyValue
                rows={[
                  [
                    t('promo.settings.approvalAbove', { defaultValue: 'Approval above' }),
                    t('promo.settings.approvalAboveV', {
                      defaultValue: '{{v}} maximum cost per campaign',
                      v: sar(m.approvalAboveSar),
                    }),
                  ],
                  [
                    t('promo.settings.deepDiscounts', { defaultValue: 'Deep discounts' }),
                    t('promo.settings.deepDiscountsV', {
                      defaultValue: 'Discounts above {{p}} always need approval',
                      p: pct(m.deepDiscountPct),
                    }),
                  ],
                  [
                    t('promo.settings.fourEyes', { defaultValue: 'Four-eyes rule' }),
                    t('promo.settings.fourEyesV', {
                      defaultValue: 'The person who creates a campaign cannot approve it',
                    }),
                  ],
                  [
                    t('promo.settings.liveCampaigns', { defaultValue: 'Live campaigns' }),
                    t('promo.settings.liveCampaignsV', {
                      defaultValue: '{{f}} are locked once customers hold the coupon',
                      f: LOCKED_WHEN_LIVE.join(', '),
                    }),
                  ],
                  [
                    t('promo.settings.budgetIncreases', { defaultValue: 'Budget increases' }),
                    t('promo.settings.budgetIncreasesV', {
                      defaultValue: 'Need a second approver',
                    }),
                  ],
                ]}
              />
              <p className="mt-2 text-2xs text-muted-foreground">
                {t('promo.settings.rulesNote', {
                  defaultValue:
                    'These rules are part of the engine. Changing them needs development (see the field specification).',
                })}
              </p>
            </Panel>
            <Panel
              title={t('promo.settings.moneyModel', {
                defaultValue: 'Money model (finance, version {{v}})',
                v: m.version,
              })}
            >
              <KeyValue
                rows={[
                  [t('promo.settings.foodCost', { defaultValue: 'Food cost' }), pct(m.foodCostPct)],
                  [
                    t('promo.settings.packaging', { defaultValue: 'Packaging' }),
                    pct(m.packagingPct),
                  ],
                  [
                    t('promo.settings.channelCost', { defaultValue: 'Channel cost' }),
                    `${t('promo.settings.delivery', { defaultValue: 'delivery' })} ${pct(m.channelCostPct.DELIVERY)} · ${t('promo.settings.pickup', { defaultValue: 'pickup' })} ${pct(m.channelCostPct.PICKUP)} · ${t('promo.settings.carhop', { defaultValue: 'carhop' })} ${pct(m.channelCostPct.CARHOP)}`,
                  ],
                  [
                    t('promo.settings.wouldOrderAnyway', { defaultValue: 'Would order anyway' }),
                    pct(m.wouldOrderAnywayPct),
                  ],
                  [
                    t('promo.settings.messageCost', { defaultValue: 'Message cost' }),
                    `SMS ${m.messageCostSar.SMS} · WhatsApp ${m.messageCostSar.WHATSAPP}`,
                  ],
                ]}
              />
            </Panel>
            <Panel title={t('promo.settings.peopleRoles', { defaultValue: 'People and roles' })}>
              <KeyValue
                rows={[
                  [
                    t('promo.settings.canCreate', { defaultValue: 'Can create' }),
                    t('promo.settings.canCreateV', {
                      defaultValue: 'Roles with “Prepare marketing work”',
                    }),
                  ],
                  [
                    t('promo.settings.canApprove', { defaultValue: 'Can approve' }),
                    t('promo.settings.canApproveV', {
                      defaultValue:
                        'Roles with “Approve marketing work”, except their own campaigns',
                    }),
                  ],
                  [
                    t('promo.settings.managed', { defaultValue: 'Managed in' }),
                    t('promo.settings.managedV', {
                      defaultValue: 'Admin portal → Roles & privileges (Administrator only)',
                    }),
                  ],
                ]}
              />
            </Panel>
          </div>
          <div className="space-y-4">
            <Panel title={t('promo.settings.engine', { defaultValue: 'Engine' })}>
              <p className="text-sm text-foreground">
                {choice.choice === 'live'
                  ? t('promo.settings.engineLive', {
                      defaultValue: 'Live - Yiji v2 through the CRM gateway.',
                    })
                  : t('promo.settings.engineSample', {
                      defaultValue: 'Sample data - until Yiji v2 is connected.',
                    })}
              </p>
              <p className="mt-2 text-2xs text-muted-foreground">
                {t('promo.settings.engineHow', {
                  defaultValue:
                    'To go live: the gateway gets MARKETING_ENGINE_URL and MARKETING_ENGINE_KEY, then the Administrator sets the global setting “marketing_engine” to “live”. No release needed.',
                })}
              </p>
              {isOwner && choice.choice === 'sample' && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-3"
                  onClick={() => {
                    resetSampleEngine();
                    toast.success(
                      t('promo.settings.sampleRestored', {
                        defaultValue: 'Sample campaigns restored - reload the page.',
                      }),
                    );
                  }}
                >
                  {t('promo.settings.restoreSample', { defaultValue: 'Restore sample campaigns' })}
                </Button>
              )}
            </Panel>
            <Panel title={t('promo.settings.brandsStores', { defaultValue: 'Brands and stores' })}>
              <p className="text-xs text-muted-foreground">
                {t('promo.settings.brandsStoresV', {
                  defaultValue: 'Menus, items and branches come from the engine’s catalogue.',
                })}
              </p>
            </Panel>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SettingsStackingPage() {
  const { t } = useTranslation();
  const tabs = useTabs();
  const campaigns = useEngineQuery(['campaigns', 'live'], (e) =>
    e.listCampaigns({ status: 'live' }),
  );
  const yes = t('promo.settings.yes', { defaultValue: 'Yes' });
  const no = t('promo.settings.no', { defaultValue: 'No' });
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('promo.settings.stackingTitle', { defaultValue: 'Stacking & compatibility' })}
        description={t('promo.settings.stackingDesc', {
          defaultValue:
            'Coupons have three compatibility settings. Each is set per coupon and checked by the engine on every order, so the app cannot be used to get around them.',
        })}
        titleExtra={<SampleDataPill />}
      />
      <div className={PAGE_BODY}>
        <AreaTabs tabs={tabs} />
        <Panel
          title={t('promo.settings.stackingPolicy', {
            defaultValue: 'Stacking policy - one order, every product',
          })}
          className="mb-4"
        >
          <ol className="grid gap-2 sm:grid-cols-4">
            {[
              [
                t('promo.settings.s1', { defaultValue: 'Promotional offer' }),
                t('promo.settings.s1b', {
                  defaultValue:
                    'App offers such as 20% off or free delivery apply first, to the order subtotal.',
                }),
              ],
              [
                t('promo.settings.s2', { defaultValue: 'Coupon' }),
                t('promo.settings.s2b', {
                  defaultValue:
                    'One coupon per order unless the coupon allows other discounts. Applied to what is left after the offer.',
                }),
              ],
              [
                t('promo.settings.s3', { defaultValue: 'Loyalty benefit' }),
                t('promo.settings.s3b', {
                  defaultValue:
                    'Points, cashback or VIP benefits apply last among discounts, if the coupon allows loyalty.',
                }),
              ],
              [
                t('promo.settings.s4', { defaultValue: 'Gift card' }),
                t('promo.settings.s4b', {
                  defaultValue:
                    'Pays the remaining amount. It is a payment method, not a discount, so it never blocks a coupon unless the gift card product says so.',
                }),
              ],
            ].map(([h, b], i) => (
              <li key={h} className="rounded-xl bg-secondary/40 p-3">
                <div className="text-2xs font-bold text-muted-foreground">{i + 1}</div>
                <div className="text-sm font-semibold text-foreground">{h}</div>
                <p className="text-2xs text-muted-foreground">{b}</p>
              </li>
            ))}
          </ol>
        </Panel>
        <Panel
          title={t('promo.settings.liveMarketing', { defaultValue: 'Live marketing coupons' })}
        >
          {campaigns.isLoading && <Skeleton className="h-24 w-full" />}
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 text-start">
                  {t('promo.settings.coupon', { defaultValue: 'Coupon' })}
                </th>
                <th>{t('promo.settings.withOffers', { defaultValue: 'With offers' })}</th>
                <th>{t('promo.settings.withLoyalty', { defaultValue: 'With loyalty' })}</th>
                <th>
                  {t('promo.settings.withOtherDiscounts', { defaultValue: 'With other discounts' })}
                </th>
                <th>{t('promo.settings.partial', { defaultValue: 'Partial' })}</th>
              </tr>
            </thead>
            <tbody>
              {(campaigns.data ?? []).map((c) => (
                <tr key={c.id} className="border-t border-foreground/[0.06] text-center">
                  <td className="py-1.5 text-start text-foreground">{c.name.en}</td>
                  <td>
                    <Pill
                      tone={c.stacking.combineWithOtherOffers ? 'success' : 'neutral'}
                      size="sm"
                    >
                      {c.stacking.combineWithOtherOffers ? yes : no}
                    </Pill>
                  </td>
                  <td>
                    <Pill tone={c.stacking.combineWithLoyalty ? 'success' : 'neutral'} size="sm">
                      {c.stacking.combineWithLoyalty ? yes : no}
                    </Pill>
                  </td>
                  <td>
                    <Pill
                      tone={c.stacking.combineWithOtherCoupons ? 'success' : 'neutral'}
                      size="sm"
                    >
                      {c.stacking.combineWithOtherCoupons ? yes : no}
                    </Pill>
                  </td>
                  <td>
                    <Pill
                      tone={c.offer.partialRedemption?.enabled ? 'success' : 'neutral'}
                      size="sm"
                    >
                      {c.offer.partialRedemption?.enabled ? yes : no}
                    </Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-2xs text-muted-foreground">
            {t('promo.settings.changeInStep4', {
              defaultValue: 'Change these in each coupon, step 4 (Eligibility).',
            })}
          </p>
        </Panel>
      </div>
    </div>
  );
}

export function SettingsBrandsPage() {
  const { t } = useTranslation();
  const tabs = useTabs();
  const catalogue = useEngineQuery(['catalogue'], (e) => e.catalogue());
  const [brandId, setBrandId] = useState<string>('');
  const [q, setQ] = useState('');
  const c = catalogue.data;
  const brand = c?.brands.find((b) => b.id === brandId) ?? c?.brands[0];
  const items = (c?.products ?? []).filter(
    (p) =>
      p.brandId === brand?.id &&
      (!q || `${p.id} ${p.name}`.toLowerCase().includes(q.toLowerCase())),
  );
  const cat = (id: string) => c?.categories.find((x) => x.id === id)?.name ?? '';
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('promo.settings.brandsTitle', { defaultValue: 'Brands & menus' })}
        description={t('promo.settings.brandsDesc', {
          defaultValue:
            '{{n}} items from the engine’s menu catalogue. These are the items coupons can include, exclude, give free or bundle.',
          n: c?.products.length ?? 0,
        })}
        titleExtra={<SampleDataPill />}
      />
      <div className={PAGE_BODY}>
        <AreaTabs tabs={tabs} />
        <div className="mb-3 flex flex-wrap gap-2">
          {(c?.brands ?? []).map((b) => (
            <button
              key={b.id}
              type="button"
              aria-pressed={brand?.id === b.id}
              onClick={() => setBrandId(b.id)}
              className={cn(
                SECTION_CARD,
                'px-4 py-2 text-start',
                brand?.id === b.id && 'ring-2 ring-primary/50',
              )}
            >
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: b.colour }} />
                <span className="text-sm font-semibold text-foreground">{b.name}</span>
              </div>
              <div className="text-2xs text-muted-foreground">
                {t('promo.settings.brandLine', {
                  defaultValue: '{{i}} items · {{c}} categories · {{b}} branches',
                  i: (c?.products ?? []).filter((p) => p.brandId === b.id).length,
                  c: (c?.categories ?? []).filter((x) => x.brandId === b.id).length,
                  b: (c?.branches ?? []).filter((x) => x.brandId === b.id).length,
                })}
              </div>
            </button>
          ))}
        </div>
        <Panel
          title={brand?.name ?? ''}
          aside={
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('promo.settings.searchItems', {
                defaultValue: 'Search item, category or ID',
              })}
              className="h-8 w-60"
            />
          }
        >
          {catalogue.isLoading && <Skeleton className="h-40 w-full" />}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1 text-start">ID</th>
                  <th className="text-start">
                    {t('promo.settings.item', { defaultValue: 'Item' })}
                  </th>
                  <th className="text-start">
                    {t('promo.settings.category', { defaultValue: 'Category' })}
                  </th>
                  <th className="text-end">
                    {t('promo.settings.price', { defaultValue: 'Price' })}
                  </th>
                  <th className="text-start ps-3">
                    {t('promo.settings.availableFor', { defaultValue: 'Available for' })}
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <tr key={p.id} className="border-t border-foreground/[0.06]">
                    <td className="py-1 font-mono text-2xs text-success">{p.id}</td>
                    <td className="font-semibold text-foreground">{p.name}</td>
                    <td className="text-muted-foreground">{cat(p.categoryId)}</td>
                    <td className="text-end tabular-nums">SAR {p.priceSar}</td>
                    <td className="ps-3">
                      {p.orderTypes.map((o) => (
                        <Pill key={o} tone="neutral" size="sm" className="me-1">
                          {o.toLowerCase()}
                        </Pill>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </div>
  );
}

export function SettingsFieldSpecPage() {
  const { t } = useTranslation();
  const tabs = useTabs();
  const copy = async () => {
    /* The design's own columns first (docs/marketing/ayman-draft-fields.csv), then ours. */
    const q = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
    const csv = [
      'step,field,api_path,type,required,notes,default,when',
      ...CAMPAIGN_FIELD_SPEC.map((f) =>
        [f.step, f.label, f.path, f.type, f.required, f.notes, f.default, f.when ?? '']
          .map(q)
          .join(','),
      ),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(csv);
      toast.success(t('promo.settings.copied', { defaultValue: 'Fields copied as CSV.' }));
    } catch {
      toast.error(t('promo.settings.copyFailed', { defaultValue: 'Could not copy.' }));
    }
  };
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('promo.settings.fieldsTitle', { defaultValue: 'Field specification' })}
        description={t('promo.settings.fieldsDesc', {
          defaultValue:
            'Generated from the same schema that drives the campaign form, so it always matches. {{n}} fields in 7 steps. Times are Saudi time (Asia/Riyadh).',
          n: CAMPAIGN_FIELD_SPEC.length,
        })}
        titleExtra={<SampleDataPill />}
        actions={
          <Button variant="ghost" onClick={copy}>
            {t('promo.settings.copyCsv', { defaultValue: 'Copy fields as CSV' })}
          </Button>
        }
      />
      <div className={PAGE_BODY}>
        <AreaTabs tabs={tabs} />
        <div className={cn(SECTION_CARD, 'overflow-x-auto')}>
          <table className="w-full min-w-[72rem] text-xs">
            <thead className="text-muted-foreground">
              <tr>
                {[
                  t('promo.settings.step', { defaultValue: 'Step' }),
                  t('promo.settings.fieldLabel', { defaultValue: 'Field' }),
                  t('promo.settings.fieldPath', { defaultValue: 'API path' }),
                  t('promo.settings.type', { defaultValue: 'Type' }),
                  t('promo.settings.required', { defaultValue: 'Required' }),
                  t('promo.settings.default', { defaultValue: 'Default' }),
                  t('promo.settings.when', { defaultValue: 'Shown when' }),
                  t('promo.settings.notes', { defaultValue: 'Notes' }),
                ].map((h) => (
                  <th key={h} className="px-3 py-2 text-start">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {CAMPAIGN_FIELD_SPEC.map((f) => (
                <tr key={f.path} className="border-t border-foreground/[0.06]">
                  <td className="px-3 py-1.5">{f.step}</td>
                  <td className="px-3">{t(`promo.field.${f.key}`, { defaultValue: f.label })}</td>
                  <td className="px-3 font-mono text-success">{f.path}</td>
                  <td className="px-3">{f.type}</td>
                  <td className="px-3">{f.required}</td>
                  <td className="px-3 font-mono">{f.default}</td>
                  <td className="px-3 text-muted-foreground">{f.when ?? ''}</td>
                  <td className="px-3 text-muted-foreground">{f.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export function SettingsArchitecturePage() {
  const { t } = useTranslation();
  const tabs = useTabs();
  const engine = useEngine();
  const api: Array<[string, string, string]> = [
    ['GET', '/v1/home', 'The five area summaries and the alerts.'],
    ['GET', '/v1/catalogue', 'Brands, branches, categories, products.'],
    ['GET', '/v1/money-model', 'Finance’s cost model, versioned.'],
    [
      'GET/POST/PUT',
      '/v1/campaigns, /v1/campaigns/{id}',
      'Campaigns with the full field set; locked fields enforced once live.',
    ],
    [
      'POST',
      '/v1/campaigns/{id}/submit · /decision · /status',
      'Approval with the forecast fixed; four-eyes; live / paused / ended.',
    ],
    [
      'POST',
      '/v1/issuance',
      'Places the coupon in customer wallets; returns a batch id and who was skipped.',
    ],
    [
      'GET',
      '/v1/campaigns/{id}/performance · /redemptions',
      'Actuals with control-group response, per day; the redemption list.',
    ],
    ['POST', '/v1/checkout/simulate', 'The same compatibility and balance rules checkout applies.'],
    ['GET', '/v1/liability', 'Outstanding value by product, at face value and at cost.'],
    ['GET/POST/PUT', '/v1/gift-cards/products · /stats · /activity', 'Gift cards.'],
    [
      'GET/POST/PUT',
      '/v1/rewards/earning-rules · /campaigns · /items · /stats · /members',
      'Cashback and points.',
    ],
    ['GET', '/v1/orders/export', 'Completed orders by date range, for the pre-studies.'],
    [
      'GET/PUT',
      '/v1/studies · /opportunities · /customer-groups',
      'Studies, scenarios and the groups.',
    ],
    [
      'Webhooks',
      'redemption.created, campaign.budget_reached, study.approved, liability.threshold',
      'Events for the CRM.',
    ],
  ];
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('promo.settings.archTitle', { defaultValue: 'Architecture & API' })}
        description={t('promo.settings.archDesc', {
          defaultValue: 'What Yiji v2 provides and how this portal reaches it. Today: {{e}}.',
          e:
            engine.kind === 'live'
              ? t('promo.settings.engineLiveShort', { defaultValue: 'the live engine' })
              : t('promo.settings.engineSampleShort', {
                  defaultValue: 'the sample engine in this browser',
                }),
        })}
        titleExtra={<SampleDataPill />}
      />
      <div className={PAGE_BODY}>
        <AreaTabs tabs={tabs} />
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title={t('promo.settings.services', { defaultValue: 'Where things run' })}>
            <ul className="space-y-1.5 text-xs text-foreground">
              <li>
                <b>
                  {t('promo.settings.svcEngine', { defaultValue: 'Promotion engine (Yiji v2)' })}
                </b>
                :{' '}
                {t('promo.settings.svcEngineV', {
                  defaultValue:
                    'checkout validation, redemptions, the value ledger, issuance, the catalogue.',
                })}
              </li>
              <li>
                <b>{t('promo.settings.svcPortal', { defaultValue: 'This portal (CRM)' })}</b>:{' '}
                {t('promo.settings.svcPortalV', {
                  defaultValue:
                    'studies, campaign set-up, approvals, performance, gift cards and rewards management, settings.',
                })}
              </li>
              <li>
                <b>{t('promo.settings.svcGateway', { defaultValue: 'CRM gateway' })}</b>:{' '}
                {t('promo.settings.svcGatewayV', {
                  defaultValue:
                    'the only path to the engine; checks the person may use the portal, adds the engine key, forwards 1:1.',
                })}
              </li>
              <li>
                <b>{t('promo.settings.svcRoles', { defaultValue: 'Roles' })}</b>:{' '}
                {t('promo.settings.svcRolesV', {
                  defaultValue:
                    'Prepare marketing work (create), Approve marketing work (approve, never one’s own), managed by the Administrator.',
                })}
              </li>
            </ul>
          </Panel>
          <Panel
            title={t('promo.settings.goLive', { defaultValue: 'Go-live checklist (2 hours)' })}
          >
            <ol className="list-decimal space-y-1 ps-5 text-xs text-foreground">
              <li>
                {t('promo.settings.gl1', {
                  defaultValue:
                    'Yiji v2 exposes the endpoints below with a service key for the CRM.',
                })}
              </li>
              <li>
                {t('promo.settings.gl2', {
                  defaultValue:
                    'The CRM gateway gets MARKETING_ENGINE_URL and MARKETING_ENGINE_KEY (staging first).',
                })}
              </li>
              <li>
                {t('promo.settings.gl3', {
                  defaultValue:
                    'The Administrator sets the global setting “marketing_engine” to “live”.',
                })}
              </li>
              <li>
                {t('promo.settings.gl4', {
                  defaultValue:
                    'Open Home: the “Sample data” badge is gone and the numbers are Yiji’s.',
                })}
              </li>
            </ol>
          </Panel>
        </div>
        <Panel
          title={t('promo.settings.apiContract', { defaultValue: 'API contract' })}
          className="mt-4"
        >
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 text-start">
                  {t('promo.settings.method', { defaultValue: 'Method' })}
                </th>
                <th className="text-start">
                  {t('promo.settings.endpoint', { defaultValue: 'Endpoint' })}
                </th>
                <th className="text-start">
                  {t('promo.settings.purpose', { defaultValue: 'Purpose' })}
                </th>
              </tr>
            </thead>
            <tbody>
              {api.map(([m, p, d]) => (
                <tr key={p} className="border-t border-foreground/[0.06]">
                  <td className="py-1.5 pe-3 font-bold">{m}</td>
                  <td className="pe-3 font-mono text-success">{p}</td>
                  <td className="text-muted-foreground">{d}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-2xs text-muted-foreground">
            {t('promo.settings.contractDoc', {
              defaultValue:
                'The full contract with every field: docs/MARKETING-ENGINE-CONTRACT.md in the CRM repository.',
            })}
          </p>
        </Panel>
      </div>
    </div>
  );
}
