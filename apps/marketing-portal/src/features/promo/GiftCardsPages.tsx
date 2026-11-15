import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  FormField,
  Input,
  Pill,
  Skeleton,
  SplitBar,
  TrendChart,
  cn,
  toast,
} from '@yiji/ui';
import type { GiftCardProduct } from '@yiji/shared-types';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { useEngine } from '../../engine/index.js';
import { PageHeader, PAGE_BODY, SECTION_CARD } from '../../components/shell/Page.js';
import {
  AreaTabs,
  Panel,
  SampleDataPill,
  Tile,
  dateLabel,
  dayLabel,
  daysAgo,
  int,
  sar,
  today,
  useEngineQuery,
} from './shared.js';

function useTabs() {
  const { t } = useTranslation();
  return [
    {
      to: '/gift-cards',
      label: t('promo.gift.tabOverview', { defaultValue: 'Overview' }),
      end: true,
    },
    {
      to: '/gift-cards/products',
      label: t('promo.gift.tabProducts', { defaultValue: 'Products' }),
    },
    {
      to: '/gift-cards/design',
      label: t('promo.gift.tabDesign', { defaultValue: 'Design studio' }),
    },
    {
      to: '/gift-cards/activity',
      label: t('promo.gift.tabActivity', { defaultValue: 'Activity' }),
    },
  ];
}

export function GiftCardsOverviewPage() {
  const { t } = useTranslation();
  const tabs = useTabs();
  const [days, setDays] = useState(30);
  const stats = useEngineQuery(['gift-stats', days], (e) =>
    e.giftCardStats({ from: daysAgo(days), to: today() }),
  );
  const s = stats.data;
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('promo.gift.title', { defaultValue: 'Gift cards' })}
        description={t('promo.gift.desc', {
          defaultValue: 'How gift cards are selling and being used.',
        })}
        titleExtra={<SampleDataPill />}
      />
      <div className={PAGE_BODY}>
        <AreaTabs tabs={tabs} />
        <div className="mb-3 flex gap-1.5">
          {[1, 7, 30, 90].map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={days === d}
              onClick={() => setDays(d)}
              className={cn(
                'rounded-full px-3 py-1 text-xs font-semibold ring-1 ring-inset',
                days === d
                  ? 'bg-ink text-ink-foreground ring-transparent'
                  : 'bg-card ring-foreground/[0.08]',
              )}
            >
              {d === 1
                ? t('promo.gift.today', { defaultValue: 'Today' })
                : t('promo.gift.lastDays', { defaultValue: 'Last {{n}} days', n: d })}
            </button>
          ))}
        </div>
        {stats.isLoading && <Skeleton className="h-40 w-full" />}
        {s && (
          <>
            <div className="mb-4 grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
              <Tile
                label={t('promo.gift.sold', { defaultValue: 'Gift cards sold' })}
                value={int(s.sold)}
                caption={t('promo.gift.inPeriod', { defaultValue: 'in the selected period' })}
                tone="warning"
              />
              <Tile
                label={t('promo.gift.salesValue', { defaultValue: 'Sales value' })}
                value={sar(s.salesSar)}
                caption={t('promo.gift.avgCard', {
                  defaultValue: 'average {{a}} per card',
                  a: sar(s.sold ? s.salesSar / s.sold : 0),
                })}
                tone="success"
              />
              <Tile
                label={t('promo.gift.redeemedValue', { defaultValue: 'Redeemed value' })}
                value={sar(s.redeemedSar)}
                caption={t('promo.gift.redemptions', {
                  defaultValue: '{{n}} redemptions',
                  n: int(s.redemptions),
                })}
              />
              <Tile
                label={t('promo.gift.outstanding', { defaultValue: 'Outstanding balance' })}
                value={sar(s.outstandingSar)}
                caption={t('promo.gift.allTime', { defaultValue: 'on live cards, all time' })}
                tone="primary"
              />
              <Tile
                label={t('promo.gift.active', { defaultValue: 'Active gift cards' })}
                value={int(s.activeCards)}
                caption={t('promo.gift.withBalance', { defaultValue: 'with balance left' })}
              />
              <Tile
                label={t('promo.gift.unused', { defaultValue: 'Unused gift cards' })}
                value={int(s.unusedCards)}
                caption={t('promo.gift.neverUsed', {
                  defaultValue: '{{v}} never used',
                  v: sar(s.unusedSar),
                })}
              />
            </div>
            <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
              <Panel
                title={t('promo.gift.salesAndRedemptions', {
                  defaultValue: 'Sales and redemptions',
                })}
              >
                <TrendChart
                  points={s.perDay.map((d) => ({
                    label: dayLabel(d.day),
                    values: { sales: d.salesSar, redeemed: d.redeemedSar },
                  }))}
                  series={[
                    {
                      key: 'sales',
                      label: t('promo.gift.salesValue', { defaultValue: 'Sales value' }),
                      tone: 'warning',
                    },
                    {
                      key: 'redeemed',
                      label: t('promo.gift.redeemedValue', { defaultValue: 'Redeemed value' }),
                      tone: 'success',
                    },
                  ]}
                  format={(v) => sar(v)}
                  height={200}
                />
              </Panel>
              <Panel
                title={t('promo.gift.selfVsGift', { defaultValue: 'Self-purchase vs gifting' })}
              >
                <SplitBar
                  parts={[
                    {
                      label: t('promo.gift.sentAsGift', { defaultValue: 'Sent as a gift' }),
                      value: s.sentAsGift,
                      tone: 'primary',
                    },
                    {
                      label: t('promo.gift.forThemselves', {
                        defaultValue: 'Bought for themselves',
                      }),
                      value: s.boughtForSelf,
                      tone: 'sky',
                    },
                  ]}
                />
                <p className="mt-3 text-xs text-muted-foreground">
                  {t('promo.gift.expiring', {
                    defaultValue: '{{n}} cards ({{v}}) expire in the next {{d}} days.',
                    n: s.expiringSoon.cards,
                    v: sar(s.expiringSoon.valueSar),
                    d: s.expiringSoon.withinDays,
                  })}
                </p>
              </Panel>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function GiftCardsProductsPage() {
  const { t } = useTranslation();
  const tabs = useTabs();
  const { can } = useAuth();
  const engine = useEngine();
  const qc = useQueryClient();
  const products = useEngineQuery(['gift-products'], (e) => e.giftCardProducts());
  const [draft, setDraft] = useState<Omit<GiftCardProduct, 'id'> | null>(null);
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const save = useMutation({
    mutationFn: (p: Omit<GiftCardProduct, 'id'>) => engine.saveGiftCardProduct(p, editing),
    onSuccess: () => {
      toast.success(t('promo.gift.saved', { defaultValue: 'Gift card product saved.' }));
      setDraft(null);
      setEditing(undefined);
      void qc.invalidateQueries({ queryKey: ['promo'] });
    },
  });
  const start = (p?: GiftCardProduct) => {
    setEditing(p?.id);
    setDraft(
      p
        ? { ...p }
        : {
            name: { en: '', ar: '' },
            valueSar: 100,
            priceSar: 100,
            validityDays: 365,
            design: { background: '#1d1b3a', accent: '#f3a712', message: 'Enjoy a meal on us' },
            active: true,
            canCombineWithCoupons: false,
          },
    );
  };
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('promo.gift.productsTitle', { defaultValue: 'Gift card products' })}
        description={t('promo.gift.productsDesc', {
          defaultValue:
            'The cards customers can buy: value, price, validity and whether they combine with coupons.',
        })}
        titleExtra={<SampleDataPill />}
        actions={
          can('manage_marketing') ? (
            <Button onClick={() => start()}>
              {t('promo.gift.newProduct', { defaultValue: '+ New gift card' })}
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
                ? t('promo.gift.editProduct', { defaultValue: 'Edit gift card' })
                : t('promo.gift.newProduct', { defaultValue: '+ New gift card' })
            }
            className="mb-4"
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <FormField label={t('promo.gift.nameEn', { defaultValue: 'Name (English)' })}>
                <Input
                  value={draft.name.en}
                  onChange={(e) =>
                    setDraft({ ...draft, name: { ...draft.name, en: e.target.value } })
                  }
                />
              </FormField>
              <FormField label={t('promo.gift.nameAr', { defaultValue: 'Name (Arabic)' })}>
                <Input
                  dir="rtl"
                  value={draft.name.ar}
                  onChange={(e) =>
                    setDraft({ ...draft, name: { ...draft.name, ar: e.target.value } })
                  }
                />
              </FormField>
              <FormField label={t('promo.gift.value', { defaultValue: 'Value (SAR)' })}>
                <Input
                  type="number"
                  min={1}
                  value={draft.valueSar}
                  onChange={(e) => setDraft({ ...draft, valueSar: Number(e.target.value) })}
                />
              </FormField>
              <FormField label={t('promo.gift.price', { defaultValue: 'Price (SAR)' })}>
                <Input
                  type="number"
                  min={1}
                  value={draft.priceSar}
                  onChange={(e) => setDraft({ ...draft, priceSar: Number(e.target.value) })}
                />
              </FormField>
              <FormField label={t('promo.gift.validity', { defaultValue: 'Valid for (days)' })}>
                <Input
                  type="number"
                  min={1}
                  value={draft.validityDays}
                  onChange={(e) => setDraft({ ...draft, validityDays: Number(e.target.value) })}
                />
              </FormField>
              <div className="flex flex-col justify-end gap-2 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={draft.active}
                    onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
                  />{' '}
                  {t('promo.gift.activeLabel', { defaultValue: 'On sale' })}
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={draft.canCombineWithCoupons}
                    onChange={(e) =>
                      setDraft({ ...draft, canCombineWithCoupons: e.target.checked })
                    }
                  />{' '}
                  {t('promo.gift.combine', { defaultValue: 'Can be used with coupons' })}
                </label>
              </div>
            </div>
            <div className="mt-3 flex gap-2">
              <Button
                disabled={save.isPending || !draft.name.en.trim()}
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
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {(products.data ?? []).map((p) => (
            <div key={p.id} className={cn(SECTION_CARD, 'p-4')}>
              <GiftCardArt product={p} />
              <div className="mt-3 flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold text-foreground">{p.name.en}</div>
                  <div className="text-2xs text-muted-foreground">
                    {t('promo.gift.cardLine', {
                      defaultValue: 'SAR {{v}} for SAR {{p}} · {{d}} days',
                      v: p.valueSar,
                      p: p.priceSar,
                      d: p.validityDays,
                    })}
                  </div>
                </div>
                <Pill tone={p.active ? 'success' : 'neutral'} size="sm">
                  {p.active
                    ? t('promo.gift.onSale', { defaultValue: 'On sale' })
                    : t('promo.gift.off', { defaultValue: 'Off' })}
                </Pill>
              </div>
              {can('manage_marketing') && (
                <Button size="sm" variant="ghost" className="mt-2" onClick={() => start(p)}>
                  {t('promo.detail.edit', { defaultValue: 'Edit' })}
                </Button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function GiftCardArt({
  product,
}: {
  product: Pick<GiftCardProduct, 'name' | 'valueSar' | 'design'>;
}) {
  return (
    <div
      className="rounded-xl p-4 text-white shadow-soft"
      style={{
        background: `linear-gradient(135deg, ${product.design.background}, ${product.design.accent}55)`,
      }}
    >
      <div className="text-2xs uppercase tracking-[0.14em] opacity-70">Gift card</div>
      <div className="mt-4 text-2xl font-extrabold">SAR {product.valueSar}</div>
      <div className="text-xs opacity-80">{product.design.message}</div>
      <div className="mt-3 h-1.5 w-12 rounded-full" style={{ background: product.design.accent }} />
    </div>
  );
}

export function GiftCardsDesignPage() {
  const { t } = useTranslation();
  const tabs = useTabs();
  const { can } = useAuth();
  const engine = useEngine();
  const qc = useQueryClient();
  const products = useEngineQuery(['gift-products'], (e) => e.giftCardProducts());
  const [id, setId] = useState<string>('');
  const chosen = (products.data ?? []).find((p) => p.id === id) ?? products.data?.[0];
  const [design, setDesign] = useState<GiftCardProduct['design'] | null>(null);
  const d = design ?? chosen?.design ?? { background: '#1d1b3a', accent: '#f3a712', message: '' };
  const save = useMutation({
    mutationFn: () => engine.saveGiftCardProduct({ ...chosen!, design: d }, chosen!.id),
    onSuccess: () => {
      toast.success(t('promo.gift.designSaved', { defaultValue: 'Design saved.' }));
      void qc.invalidateQueries({ queryKey: ['promo'] });
    },
  });
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('promo.gift.designTitle', { defaultValue: 'Design studio' })}
        description={t('promo.gift.designDesc', {
          defaultValue: 'Colours and the message on the card the customer receives.',
        })}
        titleExtra={<SampleDataPill />}
      />
      <div className={PAGE_BODY}>
        <AreaTabs tabs={tabs} />
        <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
          <Panel title={t('promo.gift.designControls', { defaultValue: 'Design' })}>
            <div className="grid gap-3">
              <FormField label={t('promo.gift.product', { defaultValue: 'Product' })}>
                <select
                  className="w-full rounded-xl bg-input px-3 py-2 text-sm"
                  value={chosen?.id ?? ''}
                  onChange={(e) => {
                    setId(e.target.value);
                    setDesign(null);
                  }}
                >
                  {(products.data ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name.en}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label={t('promo.gift.background', { defaultValue: 'Background' })}>
                <Input
                  type="color"
                  value={d.background}
                  onChange={(e) => setDesign({ ...d, background: e.target.value })}
                />
              </FormField>
              <FormField label={t('promo.gift.accent', { defaultValue: 'Accent' })}>
                <Input
                  type="color"
                  value={d.accent}
                  onChange={(e) => setDesign({ ...d, accent: e.target.value })}
                />
              </FormField>
              <FormField label={t('promo.gift.message', { defaultValue: 'Message' })}>
                <Input
                  value={d.message}
                  maxLength={60}
                  onChange={(e) => setDesign({ ...d, message: e.target.value })}
                />
              </FormField>
              {can('manage_marketing') && (
                <Button disabled={!chosen || save.isPending} onClick={() => save.mutate()}>
                  {t('actions.save', { ns: 'common', defaultValue: 'Save' })}
                </Button>
              )}
            </div>
          </Panel>
          <Panel title={t('promo.gift.preview', { defaultValue: 'Preview' })}>
            <div className="mx-auto max-w-sm">
              {chosen && <GiftCardArt product={{ ...chosen, design: d }} />}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

export function GiftCardsActivityPage() {
  const { t } = useTranslation();
  const tabs = useTabs();
  const rows = useEngineQuery(['gift-activity'], (e) => e.giftCardActivity(60));
  const kind: Record<string, string> = {
    sold: t('promo.gift.kSold', { defaultValue: 'Sold' }),
    redeemed: t('promo.gift.kRedeemed', { defaultValue: 'Redeemed' }),
    expired: t('promo.gift.kExpired', { defaultValue: 'Expired' }),
    refunded: t('promo.gift.kRefunded', { defaultValue: 'Refunded' }),
  };
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('promo.gift.activityTitle', { defaultValue: 'Gift card activity' })}
        description={t('promo.gift.activityDesc', {
          defaultValue: 'Every sale, redemption, expiry and refund, newest first.',
        })}
        titleExtra={<SampleDataPill />}
      />
      <div className={PAGE_BODY}>
        <AreaTabs tabs={tabs} />
        {rows.isLoading && <Skeleton className="h-40 w-full" />}
        <div className={cn(SECTION_CARD, 'overflow-x-auto')}>
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-start">
                  {t('promo.detail.when', { defaultValue: 'When' })}
                </th>
                <th className="px-3 text-start">
                  {t('promo.gift.kind', { defaultValue: 'What' })}
                </th>
                <th className="px-3 text-start">
                  {t('promo.gift.card', { defaultValue: 'Card' })}
                </th>
                <th className="px-3 text-start">
                  {t('promo.gift.customer', { defaultValue: 'Customer' })}
                </th>
                <th className="px-3 text-end">SAR</th>
              </tr>
            </thead>
            <tbody>
              {(rows.data ?? []).map((r) => (
                <tr key={r.id} className="border-t border-foreground/[0.06]">
                  <td className="px-3 py-1.5">{dateLabel(r.at)}</td>
                  <td className="px-3">
                    <Pill
                      tone={
                        r.kind === 'sold'
                          ? 'success'
                          : r.kind === 'redeemed'
                            ? 'primary'
                            : r.kind === 'expired'
                              ? 'neutral'
                              : 'warning'
                      }
                      size="sm"
                    >
                      {kind[r.kind]}
                    </Pill>
                  </td>
                  <td className="px-3 font-mono">{r.cardId}</td>
                  <td className="px-3">{r.customer}</td>
                  <td className="px-3 text-end tabular-nums">{r.amountSar}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
