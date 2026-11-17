import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, FormField, Input, Select, Textarea, cn, toast } from '@yiji/ui';
import {
  AUDIENCE_CONDITIONS,
  CAMPAIGN_FIELD_SPEC,
  CAMPAIGN_OBJECTIVES,
  CAMPAIGN_TENANTS,
  CHANNELS,
  COMPENSATION_REASONS,
  CampaignDraft,
  CampaignDraftShape,
  FUNDING_SOURCES,
  LOYALTY_MILESTONES,
  OBJECTIVE_CATALOGUE,
  OFFER_TYPES,
  ORDER_TYPES,
  PAYMENT_METHODS,
  bundlePriceProblem,
  campaignDraftIssues,
  forecastCampaign,
  objectiveSpec,
  offerLabel,
  readCampaignDraft,
  type CampaignObjective,
  type CampaignForecast,
  type EngineProduct,
  type OfferType,
} from '@yiji/shared-types';
import { useEngine } from '../../engine/index.js';
import { CampaignDraftFromSpec, scheduleFor } from '../../engine/sample.js';
import { PageHeader, PAGE_BODY, SECTION_CARD } from '../../components/shell/Page.js';
import {
  KeyValue,
  Panel,
  SampleDataPill,
  int,
  pct,
  sar,
  today,
  useEngineQuery,
  useGoalLabels,
  useObjectiveLabels,
} from './shared.js';

/**
 * CREATE A COUPON - the seven steps of the operations draft: Objective,
 * Discount, Target customers, Eligibility, Validity, Distribution, Preview &
 * publish. The recommended set-up for the chosen goal is pre-filled; the
 * business case on the right recomputes on every change (the same function
 * the approval card uses, so the two never disagree). Save as draft at any
 * step; "Review & publish" sends it for approval with the forecast fixed.
 *
 * FIELD PARITY (owner, 2026-11-17): every one of the approved design's 107
 * fields (CAMPAIGN_FIELD_SPEC, from docs/marketing/ayman-draft-fields.csv) is
 * on its step here, labelled `promo.field.<key>` in English and Arabic; the
 * problems on each step are the schema's own rules (campaignDraftIssues).
 */
type Draft = CampaignDraft;
type LoyaltyType = NonNullable<Draft['loyalty']>['type'];
const STEPS = 7;
const GROUP = 'sm:col-span-2 grid gap-3 rounded-xl bg-secondary/40 p-3 sm:grid-cols-3';
/** A required field's label, the way the form has always marked it. */
const req = (s: string) => `${s} *`;
/** An empty number box is "not set", never 0. */
const num = (v: string): number | undefined => (v.trim() === '' ? undefined : Number(v));

const LOYALTY_DEFAULTS: NonNullable<Draft['loyalty']> = {
  type: 'STAMP',
  ordersRequired: 5,
  stampExpiryDays: 60,
  milestones: [],
  minOrderToCountSar: 30,
  countOrdersFrom: 'ANY',
  repeat: true,
  progressMessages: true,
};
const BIRTHDAY_DEFAULTS: NonNullable<Draft['trigger']['birthday']> = {
  occasion: 'BIRTHDAY',
  issueDaysBefore: 3,
  missingDateOfBirth: 'ASK',
};

function emptyDraft(objective: CampaignObjective): Draft {
  const spec = objectiveSpec(objective);
  return CampaignDraftFromSpec(spec, {
    name: { en: '', ar: '' },
    schedule: scheduleFor(today(), spec.recommended.validityDays),
  });
}

export function CampaignWizardPage() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const engine = useEngine();
  const qc = useQueryClient();
  const labels = useObjectiveLabels();
  const goals = useGoalLabels();
  const editId = params.get('edit');
  const existing = useEngineQuery(['campaign', editId], (e) => e.getCampaign(editId!), {
    enabled: !!editId,
  });
  const catalogue = useEngineQuery(['catalogue'], (e) => e.catalogue());
  const initialObjective =
    (params.get('objective') as CampaignObjective | null) ?? 'REPEAT_PURCHASE';
  const [step, setStep] = useState(1);
  const [draft, setDraft] = useState<Draft>(() =>
    emptyDraft(
      CAMPAIGN_OBJECTIVES.includes(initialObjective) ? initialObjective : 'REPEAT_PURCHASE',
    ),
  );
  const [loaded, setLoaded] = useState(false);
  if (existing.data && !loaded) {
    const {
      id: _id,
      status: _s,
      createdBy: _c,
      createdAt: _a,
      updatedAt: _u,
      approval: _ap,
      snapshot: _sn,
      changeLog: _cl,
      ...rest
    } = existing.data;
    setDraft(readCampaignDraft(rest));
    setLoaded(true);
  }
  const [study, setStudy] = useState({
    customersMatched: 2_400,
    redemptionRatePct: 24,
    avgOrderSar: 67,
  });
  const forecast: CampaignForecast = useMemo(() => forecastCampaign(draft, study), [draft, study]);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const setOffer = (patch: Partial<Draft['offer']>) =>
    setDraft((d) => ({ ...d, offer: { ...d.offer, ...patch } }));
  const setBxgy = (patch: Partial<NonNullable<Draft['offer']['bxgy']>>) =>
    setDraft((d) => ({
      ...d,
      offer: {
        ...d.offer,
        bxgy: { buyQty: 1, getQty: 1, productId: '', ...d.offer.bxgy, ...patch },
      },
    }));
  const partial = draft.offer.partialRedemption ?? {
    enabled: false,
    balanceExpiry: 'SAME' as const,
    onOrderCancel: 'RESTORE' as const,
  };
  const setPartial = (patch: Partial<typeof partial>) =>
    setDraft((d) => ({
      ...d,
      offer: {
        ...d.offer,
        partialRedemption: { ...partial, ...d.offer.partialRedemption, ...patch },
      },
    }));
  const birthday = draft.trigger.birthday ?? BIRTHDAY_DEFAULTS;
  const setBirthday = (patch: Partial<typeof birthday>) =>
    setDraft((d) => ({
      ...d,
      trigger: {
        ...d.trigger,
        birthday: { ...BIRTHDAY_DEFAULTS, ...d.trigger.birthday, ...patch },
      },
    }));
  const setLoyalty = (patch: Partial<NonNullable<Draft['loyalty']>>) =>
    setDraft((d) => ({ ...d, loyalty: { ...(d.loyalty ?? LOYALTY_DEFAULTS), ...patch } }));
  const setSchedule = (patch: Partial<Draft['schedule']>) =>
    setDraft((d) => ({ ...d, schedule: { ...d.schedule, ...patch } }));
  const comm = draft.communication;
  const setComm = (patch: Partial<Draft['communication']>) =>
    setDraft((d) => ({ ...d, communication: { ...d.communication, ...patch } }));
  const problems = useMemo(
    () => stepProblems(draft, catalogue.data?.products ?? [], t),
    [draft, catalogue.data, t],
  );
  const save = useMutation({
    mutationFn: async (submit: boolean) => {
      const parsed = CampaignDraft.safeParse(draft);
      if (!parsed.success)
        throw new Error(
          parsed.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .slice(0, 3)
            .join('; '),
        );
      const c = await engine.saveCampaign(parsed.data, editId ?? undefined);
      if (submit) return engine.submitForApproval(c.id, forecast);
      return c;
    },
    onSuccess: (c, submit) => {
      void qc.invalidateQueries({ queryKey: ['promo'] });
      toast.success(
        submit
          ? t('promo.wizard.sent', { defaultValue: '{{id}} sent for approval.', id: c.id })
          : t('promo.wizard.saved', { defaultValue: '{{id}} saved as draft.', id: c.id }),
      );
      nav(`/coupons/${c.id}`);
    },
    onError: (e) =>
      toast.error(t('promo.wizard.saveFailed', { defaultValue: 'Could not save the campaign' }), {
        description: (e as Error).message,
        durationMs: 0,
      }),
  });
  const stepTitles = [
    t('promo.wizard.s1', { defaultValue: 'Objective' }),
    t('promo.wizard.s2', { defaultValue: 'Discount' }),
    t('promo.wizard.s3', { defaultValue: 'Target customers' }),
    t('promo.wizard.s4', { defaultValue: 'Eligibility' }),
    t('promo.wizard.s5', { defaultValue: 'Validity' }),
    t('promo.wizard.s6', { defaultValue: 'Distribution' }),
    t('promo.wizard.s7', { defaultValue: 'Preview & publish' }),
  ];
  const stepHints = [
    t('promo.wizard.s1h', { defaultValue: 'What should it achieve?' }),
    t('promo.wizard.s2h', { defaultValue: 'What does the customer get?' }),
    t('promo.wizard.s3h', { defaultValue: 'Who receives it?' }),
    t('promo.wizard.s4h', { defaultValue: 'Which orders qualify?' }),
    t('promo.wizard.s5h', { defaultValue: 'When can it be used?' }),
    t('promo.wizard.s6h', { defaultValue: 'How do customers get it?' }),
    t('promo.wizard.s7h', { defaultValue: 'Check and go live' }),
  ];
  const done = problems.filter((p) => p.length === 0).length;
  const brands = catalogue.data?.brands ?? [];
  const products = catalogue.data?.products ?? [];
  const branches = catalogue.data?.branches ?? [];
  const categories = catalogue.data?.categories ?? [];
  const brandName = (id: string) => brands.find((b) => b.id === id)?.name ?? id;
  const yes = t('promo.wizard.yes', { defaultValue: 'Yes' });
  const no = t('promo.wizard.no', { defaultValue: 'No' });
  const productIdPlaceholder = t('promo.wizard.productIdPlaceholder', {
    defaultValue: 'Menu product ID',
  });
  const dayNames = [
    t('promo.wizard.sun', { defaultValue: 'Sun' }),
    t('promo.wizard.mon', { defaultValue: 'Mon' }),
    t('promo.wizard.tue', { defaultValue: 'Tue' }),
    t('promo.wizard.wed', { defaultValue: 'Wed' }),
    t('promo.wizard.thu', { defaultValue: 'Thu' }),
    t('promo.wizard.fri', { defaultValue: 'Fri' }),
    t('promo.wizard.sat', { defaultValue: 'Sat' }),
  ];
  const offerTypeLabels: Record<OfferType, string> = {
    PERCENT: t('promo.wizard.typePercent', { defaultValue: 'Percentage' }),
    FIXED: t('promo.wizard.typeFixed', { defaultValue: 'Fixed amount' }),
    BXGY: t('promo.wizard.typeBxgy', { defaultValue: 'Buy X get Y' }),
    FREE_ITEM: t('promo.wizard.typeFreeItem', { defaultValue: 'Free item' }),
    BUNDLE: t('promo.wizard.typeBundle', { defaultValue: 'Bundle' }),
    FREE_DELIVERY: t('promo.wizard.typeFreeDelivery', { defaultValue: 'Free delivery' }),
    CASHBACK: t('promo.wizard.typeCashback', { defaultValue: 'Cashback' }),
  };
  const reasonLabels: Record<(typeof COMPENSATION_REASONS)[number], string> = {
    LATE_ORDER: t('promo.wizard.reasonLate', { defaultValue: 'Late order' }),
    MISSING_ITEM: t('promo.wizard.reasonMissing', { defaultValue: 'Missing item' }),
    QUALITY: t('promo.wizard.reasonQuality', { defaultValue: 'Food quality' }),
    DRIVER: t('promo.wizard.reasonDriver', { defaultValue: 'Driver' }),
    APP_ISSUE: t('promo.wizard.reasonApp', { defaultValue: 'App issue' }),
  };
  const fundingLabels: Record<(typeof FUNDING_SOURCES)[number], string> = {
    YIJI_MARKETING: t('promo.wizard.fundYiji', { defaultValue: 'Yiji marketing' }),
    BRAND: t('promo.wizard.fundBrand', { defaultValue: 'The brand' }),
    PARTNER: t('promo.wizard.fundPartner', { defaultValue: 'A partner' }),
    SHARED: t('promo.wizard.fundShared', { defaultValue: 'Shared with a partner' }),
  };
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={
          editId
            ? t('promo.wizard.editTitle', { defaultValue: 'Edit campaign' })
            : t('promo.wizard.title', { defaultValue: 'Create coupon' })
        }
        description={t('promo.wizard.desc', {
          defaultValue: 'Step {{n}} of 7 · {{title}}',
          n: step,
          title: stepTitles[step - 1],
        })}
        titleExtra={<SampleDataPill />}
        actions={
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => nav(-1)}>
              {t('actions.cancel', { ns: 'common', defaultValue: 'Cancel' })}
            </Button>
            <Button variant="ghost" disabled={save.isPending} onClick={() => save.mutate(false)}>
              {t('promo.wizard.saveDraft', { defaultValue: 'Save as draft' })}
            </Button>
            <Button
              disabled={save.isPending || problems.some((p) => p.length > 0)}
              title={problems.flat()[0]}
              onClick={() => save.mutate(true)}
            >
              {t('promo.wizard.review', { defaultValue: 'Review & publish' })}
            </Button>
          </div>
        }
      />
      <div className={PAGE_BODY}>
        <div className="grid gap-4 lg:grid-cols-[14rem_1fr_18rem]">
          <ol className={cn(SECTION_CARD, 'self-start p-2')}>
            <li className="px-2 pb-2 text-2xs text-muted-foreground">
              {t('promo.wizard.progress', { defaultValue: '{{done}} of 7 steps complete', done })}
            </li>
            {stepTitles.map((title, i) => (
              <li key={title}>
                <button
                  type="button"
                  onClick={() => setStep(i + 1)}
                  aria-current={step === i + 1 ? 'step' : undefined}
                  className={cn(
                    'flex w-full items-start gap-2 rounded-lg px-2 py-2 text-start',
                    step === i + 1 ? 'bg-primary-tint' : 'hover:bg-secondary',
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-2xs font-bold',
                      problems[i]?.length === 0
                        ? 'bg-success text-primary-foreground'
                        : step === i + 1
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-secondary text-muted-foreground',
                    )}
                  >
                    {i + 1}
                  </span>
                  <span>
                    <span className="block text-xs font-semibold text-foreground">{title}</span>
                    <span className="block text-2xs text-muted-foreground">{stepHints[i]}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
          <div className={cn(SECTION_CARD, 'p-4 sm:p-5')}>
            {step === 1 && (
              <div>
                <FormField
                  label={req(t('promo.field.objective', { defaultValue: 'Coupon objective' }))}
                  hint={t('promo.wizard.objectiveHint', {
                    defaultValue: 'Pick the goal. We pre-fill sensible settings you can change.',
                  })}
                >
                  <div className="grid gap-2 sm:grid-cols-2">
                    {OBJECTIVE_CATALOGUE.map((o) => (
                      <button
                        key={o.key}
                        type="button"
                        aria-pressed={draft.objective === o.key}
                        onClick={() => {
                          const next = emptyDraft(o.key);
                          setDraft({ ...next, name: draft.name });
                        }}
                        className={cn(
                          'rounded-xl p-3 text-start ring-1 ring-inset',
                          draft.objective === o.key
                            ? 'bg-primary-tint ring-primary/40'
                            : 'ring-foreground/[0.08] hover:bg-secondary',
                        )}
                      >
                        <div className="text-xs font-semibold text-foreground">
                          {labels[o.key]?.title}
                        </div>
                        <div className="text-2xs text-muted-foreground">{labels[o.key]?.body}</div>
                        <div className="mt-1 text-2xs text-primary">
                          {goals[o.goal]} ·{' '}
                          {t('promo.wizard.suggested', {
                            defaultValue: 'Suggested: {{s}}',
                            s: offerLabel({
                              ...o.recommended.offer,
                              onRefund: 'RETURN_IF_VALID',
                              onCancelBeforeCompletion: 'REISSUE_IF_VALID',
                            } as Draft['offer']),
                          })}
                        </div>
                      </button>
                    ))}
                  </div>
                </FormField>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <FormField
                    label={req(
                      t('promo.field.name_en', { defaultValue: 'Campaign name (English)' }),
                    )}
                    hint={t('promo.wizard.nameUniqueHint', {
                      defaultValue: 'Unique; max 60 characters. Customers see it on the coupon.',
                    })}
                  >
                    <Input
                      value={draft.name.en}
                      maxLength={60}
                      onChange={(e) => set('name', { ...draft.name, en: e.target.value })}
                    />
                  </FormField>
                  <FormField
                    label={req(
                      t('promo.field.name_ar', { defaultValue: 'Campaign name (Arabic)' }),
                    )}
                    hint={t('promo.wizard.nameArHint', {
                      defaultValue: 'Shown in the Arabic app. Max 60.',
                    })}
                  >
                    <Input
                      dir="rtl"
                      value={draft.name.ar}
                      maxLength={60}
                      onChange={(e) => set('name', { ...draft.name, ar: e.target.value })}
                    />
                  </FormField>
                  {draft.objective === 'SERVICE_RECOVERY' && (
                    <FormField
                      label={req(
                        t('promo.field.reasonCode', { defaultValue: 'Compensation reason' }),
                      )}
                      hint={t('promo.wizard.reasonHint', {
                        defaultValue: 'Required for compensation; kept for audit.',
                      })}
                    >
                      <Select
                        value={draft.reasonCode ?? ''}
                        onChange={(e) => set('reasonCode', e.target.value || undefined)}
                      >
                        <option value="">—</option>
                        {COMPENSATION_REASONS.map((v) => (
                          <option key={v} value={v}>
                            {reasonLabels[v]}
                          </option>
                        ))}
                      </Select>
                    </FormField>
                  )}
                  <FormField
                    label={t('promo.field.funding_source', {
                      defaultValue: 'Who pays for the discount',
                    })}
                  >
                    <Select
                      value={draft.funding.source}
                      onChange={(e) =>
                        set('funding', {
                          ...draft.funding,
                          source: e.target.value as Draft['funding']['source'],
                        })
                      }
                    >
                      {FUNDING_SOURCES.map((v) => (
                        <option key={v} value={v}>
                          {fundingLabels[v]}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                  {(draft.funding.source === 'PARTNER' || draft.funding.source === 'SHARED') && (
                    <FormField
                      label={req(
                        t('promo.field.funding_partnerSharePct', { defaultValue: 'Partner pays' }),
                      )}
                      hint={t('promo.wizard.partnerShareHint', {
                        defaultValue:
                          '% of the discount. Recorded for reconciliation with the partner.',
                      })}
                    >
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        value={draft.funding.partnerSharePct}
                        onChange={(e) =>
                          set('funding', {
                            ...draft.funding,
                            partnerSharePct: Number(e.target.value),
                          })
                        }
                      />
                    </FormField>
                  )}
                  <FormField label={req(t('promo.field.tenantId', { defaultValue: 'Tenant' }))}>
                    <Select
                      value={draft.tenantId}
                      onChange={(e) => set('tenantId', e.target.value)}
                    >
                      {[...new Set<string>([...CAMPAIGN_TENANTS, draft.tenantId])].map((v) => (
                        <option key={v} value={v}>
                          {v === 'yiji' ? 'Yiji' : v}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                  <FormField
                    label={t('promo.field.notes', { defaultValue: 'Internal note (optional)' })}
                    className="sm:col-span-2"
                  >
                    <Textarea
                      value={draft.notes ?? ''}
                      maxLength={1000}
                      onChange={(e) => set('notes', e.target.value || undefined)}
                      rows={2}
                    />
                  </FormField>
                </div>
              </div>
            )}
            {step === 2 && (
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField
                  label={req(t('promo.field.offer_type', { defaultValue: 'Discount type' }))}
                  className="sm:col-span-2"
                >
                  <Choice
                    cards
                    value={draft.offer.type}
                    options={OFFER_TYPES.map((ty) => [ty, offerTypeLabels[ty]] as const)}
                    onChange={(ty) => setOffer({ type: ty })}
                  />
                </FormField>
                {(draft.offer.type === 'PERCENT' || draft.offer.type === 'CASHBACK') && (
                  <FormField
                    label={req(
                      t('promo.field.offer_percent', { defaultValue: 'Discount percentage' }),
                    )}
                    hint="1–100 %"
                  >
                    <Input
                      type="number"
                      min={1}
                      max={100}
                      value={draft.offer.percent ?? ''}
                      onChange={(e) => setOffer({ percent: num(e.target.value) })}
                    />
                  </FormField>
                )}
                {draft.offer.type === 'FIXED' && (
                  <FormField
                    label={req(
                      t('promo.field.offer_amountSar', { defaultValue: 'Discount amount' }),
                    )}
                    hint={t('promo.wizard.sarAboveZero', { defaultValue: 'SAR, greater than 0.' })}
                  >
                    <Input
                      type="number"
                      min={1}
                      value={draft.offer.amountSar ?? ''}
                      onChange={(e) => setOffer({ amountSar: num(e.target.value) })}
                    />
                  </FormField>
                )}
                {(draft.offer.type === 'PERCENT' || draft.offer.type === 'CASHBACK') && (
                  <FormField
                    label={req(
                      t('promo.field.offer_maxDiscountSar', { defaultValue: 'Maximum discount' }),
                    )}
                    hint={t('promo.wizard.maxDiscountHint2', {
                      defaultValue: 'SAR. Mandatory for percentage and cashback; caps the saving.',
                    })}
                  >
                    <Input
                      type="number"
                      min={1}
                      value={draft.offer.maxDiscountSar ?? ''}
                      onChange={(e) => setOffer({ maxDiscountSar: num(e.target.value) })}
                    />
                  </FormField>
                )}
                {draft.offer.type === 'BXGY' && (
                  <>
                    <FormField
                      label={req(
                        t('promo.field.offer_bxgy_buyQty', { defaultValue: 'Customer buys' }),
                      )}
                    >
                      <Input
                        type="number"
                        min={1}
                        value={draft.offer.bxgy?.buyQty ?? 1}
                        onChange={(e) => setBxgy({ buyQty: Number(e.target.value) })}
                      />
                    </FormField>
                    <FormField
                      label={req(
                        t('promo.field.offer_bxgy_getQty', { defaultValue: 'Customer gets free' }),
                      )}
                    >
                      <Input
                        type="number"
                        min={1}
                        value={draft.offer.bxgy?.getQty ?? 1}
                        onChange={(e) => setBxgy({ getQty: Number(e.target.value) })}
                      />
                    </FormField>
                    <FormField
                      label={req(
                        t('promo.field.offer_bxgy_productId', { defaultValue: 'Applies to item' }),
                      )}
                      hint={t('promo.wizard.bxgyItemHint', {
                        defaultValue: 'The free item is the same or a cheaper one.',
                      })}
                      className="sm:col-span-2"
                    >
                      <ItemSelect
                        products={products}
                        value={draft.offer.bxgy?.productId ?? ''}
                        onChange={(id) => setBxgy({ productId: id })}
                        placeholder={productIdPlaceholder}
                      />
                    </FormField>
                  </>
                )}
                {draft.offer.type === 'FREE_ITEM' && (
                  <>
                    <FormField
                      label={req(
                        t('promo.field.offer_freeItem_productId', { defaultValue: 'Free item' }),
                      )}
                    >
                      <ItemSelect
                        products={products}
                        value={draft.offer.freeItem?.productId ?? ''}
                        onChange={(id) => {
                          const p = products.find((x) => x.id === id);
                          setOffer({
                            freeItem: {
                              productId: id,
                              quantity: draft.offer.freeItem?.quantity ?? 1,
                            },
                            amountSar: p?.priceSar ?? draft.offer.amountSar,
                          });
                        }}
                        placeholder={productIdPlaceholder}
                      />
                    </FormField>
                    <FormField
                      label={t('promo.field.offer_freeItem_quantity', { defaultValue: 'Quantity' })}
                    >
                      <Input
                        type="number"
                        min={1}
                        value={draft.offer.freeItem?.quantity ?? 1}
                        onChange={(e) =>
                          setOffer({
                            freeItem: {
                              productId: draft.offer.freeItem?.productId ?? '',
                              quantity: Number(e.target.value),
                            },
                          })
                        }
                      />
                    </FormField>
                  </>
                )}
                {draft.offer.type === 'BUNDLE' && (
                  <>
                    <FormField
                      label={req(
                        t('promo.field.offer_bundle_productIds', {
                          defaultValue: 'Items in the bundle',
                        }),
                      )}
                      hint={t('promo.wizard.bundleItemsHint', {
                        defaultValue: 'At least 2 menu items.',
                      })}
                      className="sm:col-span-2"
                    >
                      <ItemPicker
                        products={products}
                        values={draft.offer.bundle?.productIds ?? []}
                        onChange={(ids) =>
                          setOffer({
                            bundle: {
                              productIds: ids,
                              priceSar: draft.offer.bundle?.priceSar ?? 0,
                            },
                          })
                        }
                        placeholder={productIdPlaceholder}
                        removeLabel={t('promo.wizard.remove', { defaultValue: 'Remove' })}
                      />
                    </FormField>
                    <FormField
                      label={req(
                        t('promo.field.offer_bundle_priceSar', { defaultValue: 'Bundle price' }),
                      )}
                      hint={t('promo.wizard.bundlePriceHint', {
                        defaultValue: 'SAR, below the items’ normal total.',
                      })}
                    >
                      <Input
                        type="number"
                        min={1}
                        value={draft.offer.bundle?.priceSar || ''}
                        onChange={(e) =>
                          setOffer({
                            bundle: {
                              productIds: draft.offer.bundle?.productIds ?? [],
                              priceSar: Number(e.target.value),
                            },
                          })
                        }
                      />
                    </FormField>
                  </>
                )}
                {draft.offer.type === 'FREE_DELIVERY' && (
                  <FormField
                    label={t('promo.field.offer_deliveryFeeCoveredSar', {
                      defaultValue: 'Delivery fee covered',
                    })}
                  >
                    <Select
                      value={String(draft.offer.deliveryFeeCoveredSar ?? 'FULL')}
                      onChange={(e) =>
                        setOffer({
                          deliveryFeeCoveredSar:
                            e.target.value === 'FULL' ? 'FULL' : Number(e.target.value),
                        })
                      }
                    >
                      <option value="FULL">
                        {t('promo.wizard.full', { defaultValue: 'Full' })}
                      </option>
                      {[5, 10, 15].map((v) => (
                        <option key={v} value={v}>
                          {sar(v)}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                )}
                <FormField
                  label={req(t('promo.field.rules_minOrderSar', { defaultValue: 'Minimum order' }))}
                  hint={t('promo.wizard.minOrderHint', {
                    defaultValue: '0 = no minimum. Counts eligible items only.',
                  })}
                >
                  <Input
                    type="number"
                    min={0}
                    value={draft.rules.minOrderSar}
                    onChange={(e) =>
                      set('rules', { ...draft.rules, minOrderSar: Number(e.target.value) })
                    }
                  />
                </FormField>
                {draft.offer.type === 'CASHBACK' && (
                  <FormField
                    label={t('promo.field.offer_cashback_creditValidityDays', {
                      defaultValue: 'Credit can be used for',
                    })}
                    hint={t('promo.wizard.daysUnit', { defaultValue: 'Days.' })}
                  >
                    <Input
                      type="number"
                      min={1}
                      max={365}
                      value={draft.offer.cashback?.creditValidityDays ?? ''}
                      onChange={(e) => {
                        const v = num(e.target.value);
                        setOffer({
                          cashback: v === undefined ? undefined : { creditValidityDays: v },
                        });
                      }}
                    />
                  </FormField>
                )}
                <FormField
                  label={t('promo.field.offer_posDiscountCode', {
                    defaultValue: 'POS discount code',
                  })}
                  hint={t('promo.wizard.posCodeHint', {
                    defaultValue: 'Matches the discount line in the restaurant POS.',
                  })}
                >
                  <Input
                    value={draft.offer.posDiscountCode ?? ''}
                    maxLength={64}
                    onChange={(e) => setOffer({ posDiscountCode: e.target.value || undefined })}
                  />
                </FormField>
                <FormField
                  label={t('promo.field.offer_onRefund', {
                    defaultValue: 'If the order is refunded',
                  })}
                >
                  <Select
                    value={draft.offer.onRefund}
                    onChange={(e) =>
                      setOffer({ onRefund: e.target.value as Draft['offer']['onRefund'] })
                    }
                  >
                    <option value="RETURN_IF_VALID">
                      {t('promo.wizard.returnIfValid', {
                        defaultValue: 'Return the coupon if still valid',
                      })}
                    </option>
                    <option value="KEEP">
                      {t('promo.wizard.keep', { defaultValue: 'Keep it used' })}
                    </option>
                    <option value="NEVER_RETURN">
                      {t('promo.wizard.neverReturn', { defaultValue: 'Never return' })}
                    </option>
                  </Select>
                </FormField>
                <FormField
                  label={t('promo.field.offer_onCancelBeforeCompletion', {
                    defaultValue: 'If the order is cancelled before delivery',
                  })}
                >
                  <Select
                    value={draft.offer.onCancelBeforeCompletion}
                    onChange={(e) =>
                      setOffer({
                        onCancelBeforeCompletion: e.target
                          .value as Draft['offer']['onCancelBeforeCompletion'],
                      })
                    }
                  >
                    <option value="REISSUE_IF_VALID">
                      {t('promo.wizard.reissue', { defaultValue: 'Reissue if still valid' })}
                    </option>
                    <option value="KEEP">
                      {t('promo.wizard.keep', { defaultValue: 'Keep it used' })}
                    </option>
                    <option value="NEVER_RETURN">
                      {t('promo.wizard.neverReturn', { defaultValue: 'Never return' })}
                    </option>
                  </Select>
                </FormField>
                {(draft.offer.type === 'PERCENT' ||
                  draft.offer.type === 'FIXED' ||
                  draft.offer.type === 'CASHBACK') && (
                  <div className={GROUP}>
                    <Check
                      className="sm:col-span-3"
                      checked={draft.experiment.enabled}
                      onChange={(v) => set('experiment', { ...draft.experiment, enabled: v })}
                      label={t('promo.field.experiment_enabled', {
                        defaultValue: 'Test two discount values against each other',
                      })}
                    />
                    {draft.experiment.enabled && (
                      <>
                        <FormField
                          label={req(
                            t('promo.field.experiment_variantB_value', {
                              defaultValue: 'Version B amount',
                            }),
                          )}
                          hint={t('promo.wizard.variantBHint', {
                            defaultValue: 'Version A is the main discount value.',
                          })}
                        >
                          <Input
                            type="number"
                            min={1}
                            value={draft.experiment.variantB?.value ?? ''}
                            onChange={(e) => {
                              const v = num(e.target.value);
                              set('experiment', {
                                ...draft.experiment,
                                variantB: v === undefined ? undefined : { value: v },
                              });
                            }}
                          />
                        </FormField>
                        <FormField
                          label={t('promo.field.experiment_splitPctA', {
                            defaultValue: 'Share who get version A',
                          })}
                          hint={t('promo.wizard.splitHint', {
                            defaultValue: '{{a}}% get A, {{b}}% get B (10–90%).',
                            a: draft.experiment.splitPctA,
                            b: 100 - draft.experiment.splitPctA,
                          })}
                        >
                          <input
                            type="range"
                            min={10}
                            max={90}
                            step={5}
                            className="w-full accent-primary"
                            value={draft.experiment.splitPctA}
                            onChange={(e) =>
                              set('experiment', {
                                ...draft.experiment,
                                splitPctA: Number(e.target.value),
                              })
                            }
                          />
                        </FormField>
                        <FormField
                          label={t('promo.field.experiment_winnerMetric', {
                            defaultValue: 'Pick the winner by',
                          })}
                        >
                          <Select
                            value={draft.experiment.winnerMetric}
                            onChange={(e) =>
                              set('experiment', {
                                ...draft.experiment,
                                winnerMetric: e.target.value as Draft['experiment']['winnerMetric'],
                              })
                            }
                          >
                            <option value="PROFIT">
                              {t('promo.wizard.byProfit', { defaultValue: 'Profit' })}
                            </option>
                            <option value="REDEMPTIONS">
                              {t('promo.wizard.byRedemptions', { defaultValue: 'Redemptions' })}
                            </option>
                            <option value="REVENUE">
                              {t('promo.wizard.byRevenue', { defaultValue: 'Revenue' })}
                            </option>
                          </Select>
                        </FormField>
                        <FormField
                          label={t('promo.field.experiment_autoWinnerAfterDays', {
                            defaultValue: 'Send everyone the winner after',
                          })}
                          hint={t('promo.wizard.winnerDaysHint', {
                            defaultValue: 'Days; 0 = choose by hand.',
                          })}
                        >
                          <Input
                            type="number"
                            min={0}
                            max={90}
                            value={draft.experiment.autoWinnerAfterDays}
                            onChange={(e) =>
                              set('experiment', {
                                ...draft.experiment,
                                autoWinnerAfterDays: Number(e.target.value),
                              })
                            }
                          />
                        </FormField>
                      </>
                    )}
                  </div>
                )}
                {draft.objective === 'OCCASION' && (
                  <div className={GROUP}>
                    <FormField
                      label={t('promo.field.trigger_birthday_occasion', {
                        defaultValue: 'Celebrate',
                      })}
                      className="sm:col-span-3"
                    >
                      <Choice
                        value={birthday.occasion}
                        options={[
                          ['BIRTHDAY', t('promo.wizard.birthday', { defaultValue: 'Birthday' })],
                          [
                            'REGISTRATION_ANNIVERSARY',
                            t('promo.wizard.anniversary', {
                              defaultValue: 'Registration anniversary',
                            }),
                          ],
                        ]}
                        onChange={(v) => setBirthday({ occasion: v })}
                      />
                    </FormField>
                    <FormField
                      label={t('promo.field.trigger_birthday_issueDaysBefore', {
                        defaultValue: 'Send the gift',
                      })}
                      hint={t('promo.wizard.issueBeforeHint', {
                        defaultValue: 'Days before (0–30). One gift per occasion per year.',
                      })}
                    >
                      <Input
                        type="number"
                        min={0}
                        max={30}
                        value={birthday.issueDaysBefore}
                        onChange={(e) => setBirthday({ issueDaysBefore: Number(e.target.value) })}
                      />
                    </FormField>
                    <FormField
                      label={t('promo.field.trigger_birthday_missingDateOfBirth', {
                        defaultValue: 'Customers without a date of birth',
                      })}
                      hint={t('promo.wizard.dobHint', {
                        defaultValue:
                          'Date of birth can be edited only once, to stop repeated gifts.',
                      })}
                    >
                      <Select
                        value={birthday.missingDateOfBirth}
                        onChange={(e) =>
                          setBirthday({ missingDateOfBirth: e.target.value as 'ASK' | 'SKIP' })
                        }
                      >
                        <option value="ASK">
                          {t('promo.wizard.askDob', { defaultValue: 'Ask once in the app' })}
                        </option>
                        <option value="SKIP">
                          {t('promo.wizard.skipDob', { defaultValue: 'Skip them' })}
                        </option>
                      </Select>
                    </FormField>
                    <Check
                      checked={birthday.tierBoost?.enabled ?? false}
                      onChange={(v) =>
                        setBirthday({
                          tierBoost: { enabled: v, extraSar: birthday.tierBoost?.extraSar ?? 10 },
                        })
                      }
                      label={t('promo.field.trigger_birthday_tierBoost_enabled', {
                        defaultValue: 'Give Gold and VIP members a bigger gift',
                      })}
                    />
                    {birthday.tierBoost?.enabled && (
                      <FormField
                        label={req(
                          t('promo.field.trigger_birthday_tierBoost_extraSar', {
                            defaultValue: 'Extra value for Gold and VIP',
                          }),
                        )}
                        hint={t('promo.wizard.sarAboveZero', {
                          defaultValue: 'SAR, greater than 0.',
                        })}
                      >
                        <Input
                          type="number"
                          min={1}
                          value={birthday.tierBoost.extraSar}
                          onChange={(e) =>
                            setBirthday({
                              tierBoost: { enabled: true, extraSar: Number(e.target.value) },
                            })
                          }
                        />
                      </FormField>
                    )}
                  </div>
                )}
                {(draft.objective === 'FREQUENT_ORDER' || draft.loyalty) && (
                  <div className={GROUP}>
                    <FormField
                      label={req(
                        t('promo.field.loyalty_type', {
                          defaultValue: 'How customers earn the reward',
                        }),
                      )}
                      className="sm:col-span-3"
                    >
                      <Choice
                        cards
                        value={draft.loyalty?.type ?? ''}
                        options={[
                          ['STAMP', t('promo.wizard.loyaltyStamp', { defaultValue: 'Stamp card' })],
                          [
                            'CHALLENGE',
                            t('promo.wizard.loyaltyChallenge', { defaultValue: 'Challenge' }),
                          ],
                          [
                            'MILESTONE',
                            t('promo.wizard.loyaltyMilestone', { defaultValue: 'Milestone' }),
                          ],
                        ]}
                        onChange={(v) => setLoyalty({ type: v as LoyaltyType })}
                      />
                    </FormField>
                    {(draft.loyalty?.type === 'STAMP' || draft.loyalty?.type === 'CHALLENGE') && (
                      <FormField
                        label={req(
                          t('promo.field.loyalty_ordersRequired', {
                            defaultValue: 'Orders per stamp card',
                          }),
                        )}
                        hint="2–50"
                      >
                        <Input
                          type="number"
                          min={2}
                          max={50}
                          value={draft.loyalty.ordersRequired ?? ''}
                          onChange={(e) => setLoyalty({ ordersRequired: num(e.target.value) })}
                        />
                      </FormField>
                    )}
                    {draft.loyalty?.type === 'CHALLENGE' && (
                      <FormField
                        label={req(t('promo.field.loyalty_windowDays', { defaultValue: 'Within' }))}
                        hint={t('promo.wizard.daysUnit', { defaultValue: 'Days.' })}
                      >
                        <Input
                          type="number"
                          min={1}
                          max={365}
                          value={draft.loyalty.windowDays ?? ''}
                          onChange={(e) => setLoyalty({ windowDays: num(e.target.value) })}
                        />
                      </FormField>
                    )}
                    {draft.loyalty && (
                      <>
                        <FormField
                          label={t('promo.field.loyalty_stampExpiryDays', {
                            defaultValue: 'Stamps expire after',
                          })}
                          hint={t('promo.wizard.daysUnit', { defaultValue: 'Days.' })}
                        >
                          <Input
                            type="number"
                            min={1}
                            max={365}
                            value={draft.loyalty.stampExpiryDays}
                            onChange={(e) =>
                              setLoyalty({ stampExpiryDays: Number(e.target.value) })
                            }
                          />
                        </FormField>
                        {draft.loyalty.type === 'MILESTONE' && (
                          <FormField
                            label={req(
                              t('promo.field.loyalty_milestones', {
                                defaultValue: 'Reward on lifetime order number',
                              }),
                            )}
                            className="sm:col-span-3"
                          >
                            <Multi
                              values={draft.loyalty.milestones}
                              options={LOYALTY_MILESTONES.map((m) => [m, `#${m}`] as const)}
                              onChange={(v) => setLoyalty({ milestones: v })}
                            />
                          </FormField>
                        )}
                        <FormField
                          label={t('promo.field.loyalty_minOrderToCountSar', {
                            defaultValue: 'An order counts if it is at least',
                          })}
                          hint="SAR"
                        >
                          <Input
                            type="number"
                            min={0}
                            value={draft.loyalty.minOrderToCountSar}
                            onChange={(e) =>
                              setLoyalty({ minOrderToCountSar: Number(e.target.value) })
                            }
                          />
                        </FormField>
                        <FormField
                          label={t('promo.field.loyalty_countOrdersFrom', {
                            defaultValue: 'Which orders count',
                          })}
                          className="sm:col-span-2"
                        >
                          <Choice
                            value={draft.loyalty.countOrdersFrom}
                            options={[
                              ['ANY', t('promo.wizard.countAny', { defaultValue: 'Any brand' })],
                              [
                                'THIS_BRAND',
                                t('promo.wizard.countBrand', { defaultValue: 'This brand' }),
                              ],
                              [
                                'THIS_BRANCH',
                                t('promo.wizard.countBranch', { defaultValue: 'This branch' }),
                              ],
                            ]}
                            onChange={(v) => setLoyalty({ countOrdersFrom: v })}
                          />
                        </FormField>
                        <Check
                          checked={draft.loyalty.repeat}
                          onChange={(v) => setLoyalty({ repeat: v })}
                          label={t('promo.field.loyalty_repeat', {
                            defaultValue: 'Start a new card after each reward',
                          })}
                        />
                        <Check
                          className="sm:col-span-2"
                          checked={draft.loyalty.progressMessages}
                          onChange={(v) => setLoyalty({ progressMessages: v })}
                          label={t('promo.field.loyalty_progressMessages', {
                            defaultValue:
                              'Send a progress message after each order (e.g. “2 more orders to go”)',
                          })}
                        />
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
            {step === 3 && (
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField
                  label={req(
                    t('promo.field.audience_mode', {
                      defaultValue: 'How do you want to choose customers?',
                    }),
                  )}
                  className="sm:col-span-2"
                >
                  <Choice
                    value={draft.audience.mode}
                    options={[
                      [
                        'SEGMENT',
                        t('promo.wizard.segment', { defaultValue: 'By behaviour (segment)' }),
                      ],
                      ['LIST', t('promo.wizard.list', { defaultValue: 'A saved list' })],
                      ['PHONES', t('promo.wizard.phones', { defaultValue: 'Phone numbers' })],
                      ['ALL', t('promo.wizard.everyone', { defaultValue: 'Everyone' })],
                    ]}
                    onChange={(m) => set('audience', { ...draft.audience, mode: m })}
                  />
                </FormField>
                {draft.audience.mode === 'SEGMENT' && (
                  <FormField
                    label={req(
                      t('promo.field.audience_conditions', { defaultValue: 'Conditions' }),
                    )}
                    hint={t('promo.wizard.conditionsHint', {
                      defaultValue:
                        'Each a condition and a value; combined by Match all (AND) or any (OR).',
                    })}
                    className="sm:col-span-2"
                  >
                    <div className="space-y-2">
                      {draft.audience.conditions.map((c, i) => (
                        <div key={i} className="flex flex-wrap items-center gap-2">
                          <Select
                            value={c.c}
                            onChange={(e) => {
                              const cs = [...draft.audience.conditions];
                              cs[i] = { ...c, c: e.target.value as typeof c.c };
                              set('audience', { ...draft.audience, conditions: cs });
                            }}
                            className="w-56"
                          >
                            {AUDIENCE_CONDITIONS.map((k) => (
                              <option key={k} value={k}>
                                {k.replace(/_/g, ' ').toLowerCase()}
                              </option>
                            ))}
                          </Select>
                          <Input
                            value={c.p}
                            maxLength={200}
                            onChange={(e) => {
                              const cs = [...draft.audience.conditions];
                              cs[i] = { ...c, p: e.target.value };
                              set('audience', { ...draft.audience, conditions: cs });
                            }}
                            className="w-40"
                            placeholder={t('promo.wizard.value', { defaultValue: 'value' })}
                          />
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              set('audience', {
                                ...draft.audience,
                                conditions: draft.audience.conditions.filter((_, j) => j !== i),
                              })
                            }
                          >
                            {t('promo.wizard.remove', { defaultValue: 'Remove' })}
                          </Button>
                        </div>
                      ))}
                      <div className="flex items-center gap-3">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            set('audience', {
                              ...draft.audience,
                              conditions: [
                                ...draft.audience.conditions,
                                { c: 'ORDERED_ONCE', p: '' },
                              ],
                            })
                          }
                        >
                          {t('promo.wizard.addCondition', { defaultValue: '+ Add condition' })}
                        </Button>
                        <label className="text-xs text-muted-foreground">
                          {t('promo.wizard.match', { defaultValue: 'Match' })}{' '}
                          <Select
                            value={draft.audience.match}
                            onChange={(e) =>
                              set('audience', {
                                ...draft.audience,
                                match: e.target.value as 'ALL' | 'ANY',
                              })
                            }
                            className="ms-1 inline-block w-24"
                          >
                            <option value="ALL">
                              {t('promo.wizard.matchAll', { defaultValue: 'all' })}
                            </option>
                            <option value="ANY">
                              {t('promo.wizard.matchAny', { defaultValue: 'any' })}
                            </option>
                          </Select>
                        </label>
                      </div>
                    </div>
                  </FormField>
                )}
                {draft.audience.mode === 'PHONES' && (
                  <FormField
                    label={req(
                      t('promo.field.audience_phoneNumbers', {
                        defaultValue: 'Customer phone numbers',
                      }),
                    )}
                    hint={t('promo.wizard.phonesHint', {
                      defaultValue: 'Saudi mobile numbers +9665XXXXXXXX, one per line.',
                    })}
                    className="sm:col-span-2"
                  >
                    <Textarea
                      rows={4}
                      dir="ltr"
                      value={draft.audience.phoneNumbers.join('\n')}
                      onChange={(e) =>
                        set('audience', {
                          ...draft.audience,
                          phoneNumbers: e.target.value.split(/\s+/).filter(Boolean),
                        })
                      }
                    />
                  </FormField>
                )}
                {draft.audience.mode === 'LIST' && (
                  <FormField label={req(t('promo.wizard.listId', { defaultValue: 'Saved list' }))}>
                    <Input
                      value={draft.audience.listId ?? ''}
                      onChange={(e) =>
                        set('audience', { ...draft.audience, listId: e.target.value || undefined })
                      }
                      placeholder="list-…"
                    />
                  </FormField>
                )}
                <FormField
                  label={t('promo.field.audience_visibility', {
                    defaultValue: 'Who can see the coupon in the app?',
                  })}
                >
                  <Select
                    value={draft.audience.visibility}
                    onChange={(e) =>
                      set('audience', {
                        ...draft.audience,
                        visibility: e.target.value as 'TARGETED' | 'PUBLIC',
                      })
                    }
                  >
                    <option value="TARGETED">
                      {t('promo.wizard.targeted', { defaultValue: 'Only the target customers' })}
                    </option>
                    <option value="PUBLIC">
                      {t('promo.wizard.public', { defaultValue: 'Everyone (public)' })}
                    </option>
                  </Select>
                </FormField>
                <FormField
                  label={t('promo.field.audience_controlGroupPct', {
                    defaultValue: 'Measurement group',
                  })}
                  hint={t('promo.wizard.controlGroupHint2', {
                    defaultValue:
                      '{{n}}% (0–20%). They do not get the coupon, so the extra orders it creates can be measured. 5–10% is enough.',
                    n: draft.audience.controlGroupPct,
                  })}
                >
                  <input
                    type="range"
                    min={0}
                    max={20}
                    className="w-full accent-primary"
                    value={draft.audience.controlGroupPct}
                    onChange={(e) =>
                      set('audience', {
                        ...draft.audience,
                        controlGroupPct: Number(e.target.value),
                      })
                    }
                  />
                </FormField>
                <Check
                  className="sm:col-span-2"
                  checked={draft.audience.excludeDiscountSensitive}
                  onChange={(v) =>
                    set('audience', { ...draft.audience, excludeDiscountSensitive: v })
                  }
                  label={t('promo.field.audience_excludeDiscountSensitive', {
                    defaultValue: 'Leave out customers who almost only order with coupons',
                  })}
                />
              </div>
            )}
            {step === 4 && (
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField
                  label={t('promo.field.rules_maxOrderSar', {
                    defaultValue: 'Maximum eligible order (optional)',
                  })}
                  hint={t('promo.wizard.maxOrderHint', { defaultValue: 'SAR; 0 = no maximum.' })}
                >
                  <Input
                    type="number"
                    min={0}
                    value={draft.rules.maxOrderSar}
                    onChange={(e) =>
                      set('rules', { ...draft.rules, maxOrderSar: Number(e.target.value) })
                    }
                  />
                </FormField>
                <FormField
                  label={t('promo.field.rules_previousOrders', {
                    defaultValue: 'Number of previous orders',
                  })}
                >
                  <Select
                    value={draft.rules.previousOrders}
                    onChange={(e) =>
                      set('rules', {
                        ...draft.rules,
                        previousOrders: e.target.value as Draft['rules']['previousOrders'],
                      })
                    }
                  >
                    <option value="ANY">
                      {t('promo.wizard.prevAny', { defaultValue: 'Any' })}
                    </option>
                    <option value="NONE">
                      {t('promo.wizard.prevNone', { defaultValue: 'None yet' })}
                    </option>
                    <option value="ONE_PLUS">
                      {t('promo.wizard.prevOnePlus', { defaultValue: '1 or more' })}
                    </option>
                    <option value="THREE_PLUS">
                      {t('promo.wizard.prevThreePlus', { defaultValue: '3 or more' })}
                    </option>
                  </Select>
                </FormField>
                <Check
                  className="sm:col-span-2"
                  checked={draft.rules.firstOrderOnly}
                  onChange={(v) =>
                    setDraft((d) => ({
                      ...d,
                      rules: { ...d.rules, firstOrderOnly: v },
                      /* the design: one per phone and device is mandatory for first-order coupons */
                      fraud: v ? { ...d.fraud, onePerPhoneAndDevice: true } : d.fraud,
                    }))
                  }
                  label={t('promo.field.rules_firstOrderOnly', {
                    defaultValue: 'Only valid on the customer’s first order',
                  })}
                />
                <FormField
                  label={req(
                    t('promo.field.rules_paymentMethods', { defaultValue: 'Payment methods' }),
                  )}
                  className="sm:col-span-2"
                >
                  <Multi
                    values={draft.rules.paymentMethods}
                    options={PAYMENT_METHODS.map((m) => [m, m.replace('_', ' ')] as const)}
                    onChange={(v) => set('rules', { ...draft.rules, paymentMethods: v })}
                  />
                </FormField>
                <Check
                  className="sm:col-span-2"
                  checked={draft.scope.allBrands}
                  onChange={(v) =>
                    set('scope', {
                      ...draft.scope,
                      allBrands: v,
                      brandIds: v ? [] : draft.scope.brandIds,
                    })
                  }
                  label={t('promo.field.scope_allBrands', {
                    defaultValue: 'All brands and branches, including future ones',
                  })}
                />
                {!draft.scope.allBrands && (
                  <FormField
                    label={req(t('promo.field.scope_brandIds', { defaultValue: 'Brands' }))}
                    className="sm:col-span-2"
                  >
                    <Multi
                      values={draft.scope.brandIds}
                      options={brands.map((b) => [b.id, b.name] as const)}
                      onChange={(v) => set('scope', { ...draft.scope, brandIds: v })}
                    />
                  </FormField>
                )}
                <FormField
                  label={t('promo.field.scope_branchIds', { defaultValue: 'Branches (optional)' })}
                  className="sm:col-span-2"
                >
                  <Multi
                    values={draft.scope.branchIds}
                    options={branches
                      .filter(
                        (b) => draft.scope.allBrands || draft.scope.brandIds.includes(b.brandId),
                      )
                      .map((b) => [b.id, b.name] as const)}
                    onChange={(v) => set('scope', { ...draft.scope, branchIds: v })}
                    empty={t('promo.wizard.noneInMenu', { defaultValue: 'None in the catalogue.' })}
                  />
                </FormField>
                <FormField
                  label={t('promo.field.scope_categoryIds', {
                    defaultValue: 'Menu categories (optional)',
                  })}
                  className="sm:col-span-2"
                >
                  <Multi
                    values={draft.scope.categoryIds}
                    options={categories
                      .filter(
                        (c) => draft.scope.allBrands || draft.scope.brandIds.includes(c.brandId),
                      )
                      .map((c) => [c.id, `${brandName(c.brandId)} | ${c.name}`] as const)}
                    onChange={(v) => set('scope', { ...draft.scope, categoryIds: v })}
                    empty={t('promo.wizard.noneInMenu', { defaultValue: 'None in the catalogue.' })}
                  />
                </FormField>
                <FormField
                  label={t('promo.field.scope_productIds', {
                    defaultValue: 'Only these items (optional)',
                  })}
                  className="sm:col-span-2"
                >
                  <ItemPicker
                    products={products}
                    values={draft.scope.productIds}
                    onChange={(v) => set('scope', { ...draft.scope, productIds: v })}
                    placeholder={productIdPlaceholder}
                    removeLabel={t('promo.wizard.remove', { defaultValue: 'Remove' })}
                  />
                </FormField>
                <FormField
                  label={t('promo.field.scope_excludedProductIds', {
                    defaultValue: 'Excluded items (optional)',
                  })}
                  className="sm:col-span-2"
                >
                  <ItemPicker
                    products={products}
                    values={draft.scope.excludedProductIds}
                    onChange={(v) => set('scope', { ...draft.scope, excludedProductIds: v })}
                    placeholder={productIdPlaceholder}
                    removeLabel={t('promo.wizard.remove', { defaultValue: 'Remove' })}
                  />
                </FormField>
                <FormField
                  label={req(t('promo.field.scope_orderTypes', { defaultValue: 'Order types' }))}
                  className="sm:col-span-2"
                >
                  <Multi
                    values={draft.scope.orderTypes}
                    options={ORDER_TYPES.map(
                      (o) => [o, o.replace('_', ' ').toLowerCase()] as const,
                    )}
                    onChange={(v) => set('scope', { ...draft.scope, orderTypes: v })}
                  />
                </FormField>
                <FormField
                  label={t('promo.field.limits_perCustomerMode', {
                    defaultValue: 'Redemptions per customer',
                  })}
                >
                  <Choice
                    value={draft.limits.perCustomerMode}
                    options={[
                      ['ONE', t('promo.wizard.once', { defaultValue: 'Once' })],
                      ['MONTHLY', t('promo.wizard.monthly', { defaultValue: 'Monthly limit' })],
                      ['UNLIMITED', t('promo.wizard.unlimited', { defaultValue: 'Unlimited' })],
                    ]}
                    onChange={(v) => set('limits', { ...draft.limits, perCustomerMode: v })}
                  />
                </FormField>
                {draft.limits.perCustomerMode === 'MONTHLY' && (
                  <FormField
                    label={req(
                      t('promo.field.limits_perCustomerMax', {
                        defaultValue: 'Maximum per customer',
                      }),
                    )}
                    hint={t('promo.wizard.perMonth', { defaultValue: 'Per month.' })}
                  >
                    <Input
                      type="number"
                      min={1}
                      value={draft.limits.perCustomerMax ?? ''}
                      onChange={(e) =>
                        set('limits', { ...draft.limits, perCustomerMax: num(e.target.value) })
                      }
                    />
                  </FormField>
                )}
                <FormField
                  label={req(
                    t('promo.field.limits_totalRedemptions', {
                      defaultValue: 'Total redemption limit',
                    }),
                  )}
                  hint={t('promo.wizard.totalRedemptionsHint', {
                    defaultValue: 'Stops the campaign when reached.',
                  })}
                >
                  <Input
                    type="number"
                    min={1}
                    value={draft.limits.totalRedemptions}
                    onChange={(e) =>
                      set('limits', { ...draft.limits, totalRedemptions: Number(e.target.value) })
                    }
                  />
                </FormField>
                <FormField
                  label={t('promo.field.limits_dailyRedemptions', {
                    defaultValue: 'Daily redemption limit (optional)',
                  })}
                  hint={t('promo.wizard.zeroNone', { defaultValue: '0 = none.' })}
                >
                  <Input
                    type="number"
                    min={0}
                    value={draft.limits.dailyRedemptions}
                    onChange={(e) =>
                      set('limits', { ...draft.limits, dailyRedemptions: Number(e.target.value) })
                    }
                  />
                </FormField>
                <FormField
                  label={req(
                    t('promo.field.limits_budgetSar', { defaultValue: 'Discount budget' }),
                  )}
                  hint={t('promo.wizard.budgetHint2', {
                    defaultValue: 'SAR. The campaign pauses when it is used up.',
                  })}
                >
                  <Input
                    type="number"
                    min={1}
                    value={draft.limits.budgetSar}
                    onChange={(e) =>
                      set('limits', { ...draft.limits, budgetSar: Number(e.target.value) })
                    }
                  />
                </FormField>
                <FormField
                  label={t('promo.field.distribution_codeType', { defaultValue: 'Coupon code' })}
                  className="sm:col-span-2"
                >
                  <Choice
                    value={draft.distribution.codeType}
                    options={[
                      [
                        'NONE',
                        t('promo.wizard.noCode', { defaultValue: 'No code - added to the wallet' }),
                      ],
                      ['SHARED', t('promo.wizard.sharedCode', { defaultValue: 'One shared code' })],
                      ['UNIQUE', t('promo.wizard.uniqueCodes', { defaultValue: 'Unique codes' })],
                    ]}
                    onChange={(v) => set('distribution', { ...draft.distribution, codeType: v })}
                  />
                </FormField>
                {draft.distribution.codeType === 'SHARED' && (
                  <FormField
                    label={req(t('promo.field.distribution_code', { defaultValue: 'Shared code' }))}
                    hint={t('promo.wizard.codeHint', {
                      defaultValue: 'Unique across live campaigns.',
                    })}
                  >
                    <Input
                      value={draft.distribution.code ?? ''}
                      maxLength={32}
                      onChange={(e) =>
                        set('distribution', {
                          ...draft.distribution,
                          code: e.target.value.toUpperCase() || undefined,
                        })
                      }
                    />
                  </FormField>
                )}
                {draft.distribution.codeType === 'UNIQUE' && (
                  <FormField
                    label={req(
                      t('promo.field.distribution_uniqueCodeCount', {
                        defaultValue: 'Number of unique codes',
                      }),
                    )}
                  >
                    <Input
                      type="number"
                      min={1}
                      value={draft.distribution.uniqueCodeCount ?? ''}
                      onChange={(e) =>
                        set('distribution', {
                          ...draft.distribution,
                          uniqueCodeCount: num(e.target.value),
                        })
                      }
                    />
                  </FormField>
                )}
                <div className={cn(GROUP, 'sm:grid-cols-1')}>
                  <YesNo
                    label={t('promo.field.stacking_combineWithOtherOffers', {
                      defaultValue: 'Can this coupon be used with other offers?',
                    })}
                    hint={t('promo.wizard.offersHint', {
                      defaultValue: 'Checked by the checkout service.',
                    })}
                    value={draft.stacking.combineWithOtherOffers}
                    onChange={(v) =>
                      set('stacking', { ...draft.stacking, combineWithOtherOffers: v })
                    }
                    yes={yes}
                    no={no}
                  />
                  <YesNo
                    label={t('promo.field.stacking_combineWithLoyalty', {
                      defaultValue: 'Can this coupon be combined with loyalty benefits?',
                    })}
                    hint={t('promo.wizard.loyaltyHint', {
                      defaultValue:
                        'Loyalty benefits: cashback redemption, points redemption, VIP benefits, loyalty discounts and promotions.',
                    })}
                    value={draft.stacking.combineWithLoyalty}
                    onChange={(v) => set('stacking', { ...draft.stacking, combineWithLoyalty: v })}
                    yes={yes}
                    no={no}
                  />
                  <YesNo
                    label={t('promo.field.stacking_combineWithOtherCoupons', {
                      defaultValue: 'Can this coupon be combined with other discounts?',
                    })}
                    hint={t('promo.wizard.couponsHint', {
                      defaultValue: 'Other coupon discounts and promo codes.',
                    })}
                    value={draft.stacking.combineWithOtherCoupons}
                    onChange={(v) =>
                      set('stacking', { ...draft.stacking, combineWithOtherCoupons: v })
                    }
                    yes={yes}
                    no={no}
                  />
                </div>
                {draft.offer.type === 'FIXED' && (
                  <div className={GROUP}>
                    <YesNo
                      className="sm:col-span-3"
                      label={t('promo.field.offer_partialRedemption_enabled', {
                        defaultValue: 'Allow partial redemption?',
                      })}
                      hint={t('promo.wizard.partialHint', {
                        defaultValue:
                          'Fixed-amount coupons only. A ledger keeps the remaining balance per customer.',
                      })}
                      value={partial.enabled}
                      onChange={(v) => setPartial({ enabled: v })}
                      yes={yes}
                      no={no}
                    />
                    {partial.enabled && (
                      <>
                        <FormField
                          label={t('promo.field.offer_partialRedemption_maxPerOrderSar', {
                            defaultValue: 'Maximum per order (optional)',
                          })}
                          hint="SAR"
                        >
                          <Input
                            type="number"
                            min={1}
                            value={partial.maxPerOrderSar ?? ''}
                            onChange={(e) => setPartial({ maxPerOrderSar: num(e.target.value) })}
                          />
                        </FormField>
                        <FormField
                          label={t('promo.field.offer_partialRedemption_balanceExpiry', {
                            defaultValue: 'Remaining balance expiry',
                          })}
                        >
                          <Select
                            value={partial.balanceExpiry}
                            onChange={(e) =>
                              setPartial({
                                balanceExpiry: e.target.value as typeof partial.balanceExpiry,
                              })
                            }
                          >
                            <option value="SAME">
                              {t('promo.wizard.balanceSame', {
                                defaultValue: 'Same as the coupon',
                              })}
                            </option>
                            <option value="DAYS_30">
                              {t('promo.wizard.balance30', { defaultValue: '30 days' })}
                            </option>
                            <option value="DAYS_90">
                              {t('promo.wizard.balance90', { defaultValue: '90 days' })}
                            </option>
                          </Select>
                        </FormField>
                        <FormField
                          label={t('promo.field.offer_partialRedemption_onOrderCancel', {
                            defaultValue: 'If an order is cancelled or refunded',
                          })}
                          hint={t('promo.wizard.restoreHint', {
                            defaultValue:
                              'Each redemption can be restored once; a second cancellation gives no credit.',
                          })}
                        >
                          <Select
                            value={partial.onOrderCancel}
                            onChange={(e) =>
                              setPartial({
                                onOrderCancel: e.target.value as typeof partial.onOrderCancel,
                              })
                            }
                          >
                            <option value="RESTORE">
                              {t('promo.wizard.restore', { defaultValue: 'Restore the balance' })}
                            </option>
                            <option value="KEEP">
                              {t('promo.wizard.keep', { defaultValue: 'Keep it used' })}
                            </option>
                          </Select>
                        </FormField>
                      </>
                    )}
                  </div>
                )}
                <FormField
                  label={t('promo.field.rules_binRanges', {
                    defaultValue: 'Bank card ranges (partner offers, optional)',
                  })}
                  hint={t('promo.wizard.binHint', {
                    defaultValue:
                      'The card’s first 6–8 digits, or a range such as 400000-499999. One per line.',
                  })}
                  className="sm:col-span-2"
                >
                  <Textarea
                    rows={2}
                    dir="ltr"
                    value={draft.rules.binRanges.join('\n')}
                    onChange={(e) =>
                      set('rules', {
                        ...draft.rules,
                        binRanges: e.target.value.split(/[\s,]+/).filter(Boolean),
                      })
                    }
                  />
                </FormField>
                <div className={cn(GROUP, 'sm:grid-cols-1')}>
                  <Check
                    checked={draft.fraud.onePerPhoneAndDevice}
                    onChange={(v) => set('fraud', { ...draft.fraud, onePerPhoneAndDevice: v })}
                    label={t('promo.field.fraud_onePerPhoneAndDevice', {
                      defaultValue: 'One use per phone number and device, even across accounts',
                    })}
                    hint={t('promo.wizard.onePerPhoneHint', {
                      defaultValue: 'Mandatory for first-order and new-customer coupons.',
                    })}
                  />
                  <Check
                    checked={draft.fraud.excludeStaffAndTestAccounts}
                    onChange={(v) =>
                      set('fraud', { ...draft.fraud, excludeStaffAndTestAccounts: v })
                    }
                    label={t('promo.field.fraud_excludeStaffAndTestAccounts', {
                      defaultValue: 'Exclude staff and test accounts',
                    })}
                  />
                  <Check
                    checked={draft.fraud.blockFlaggedCustomers}
                    onChange={(v) => set('fraud', { ...draft.fraud, blockFlaggedCustomers: v })}
                    label={t('promo.field.fraud_blockFlaggedCustomers', {
                      defaultValue: 'Block customers flagged for coupon abuse',
                    })}
                  />
                </div>
              </div>
            )}
            {step === 5 && (
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField
                  label={req(
                    t('promo.field.schedule_startDate', { defaultValue: 'Campaign start date' }),
                  )}
                >
                  <Input
                    type="date"
                    value={draft.schedule.startDate}
                    onChange={(e) => setSchedule({ startDate: e.target.value })}
                  />
                </FormField>
                <FormField
                  label={req(
                    t('promo.field.schedule_endDate', { defaultValue: 'Campaign end date' }),
                  )}
                >
                  <Input
                    type="date"
                    value={draft.schedule.endDate}
                    onChange={(e) => setSchedule({ endDate: e.target.value })}
                  />
                </FormField>
                <Check
                  className="sm:col-span-2"
                  checked={draft.schedule.allDay}
                  onChange={(v) =>
                    setSchedule({ allDay: v, timeWindow: v ? {} : draft.schedule.timeWindow })
                  }
                  label={t('promo.field.schedule_allDay', { defaultValue: 'Valid all day' })}
                />
                {!draft.schedule.allDay && (
                  <>
                    <FormField
                      label={t('promo.field.schedule_timeWindow_from', {
                        defaultValue: 'Start time',
                      })}
                    >
                      <Input
                        type="time"
                        value={draft.schedule.timeWindow.from ?? ''}
                        onChange={(e) =>
                          setSchedule({
                            timeWindow: {
                              ...draft.schedule.timeWindow,
                              from: e.target.value || undefined,
                            },
                          })
                        }
                      />
                    </FormField>
                    <FormField
                      label={t('promo.field.schedule_timeWindow_to', { defaultValue: 'End time' })}
                    >
                      <Input
                        type="time"
                        value={draft.schedule.timeWindow.to ?? ''}
                        onChange={(e) =>
                          setSchedule({
                            timeWindow: {
                              ...draft.schedule.timeWindow,
                              to: e.target.value || undefined,
                            },
                          })
                        }
                      />
                    </FormField>
                  </>
                )}
                <Check
                  className="sm:col-span-2"
                  checked={draft.schedule.onlyDuringBranchHours}
                  onChange={(v) => setSchedule({ onlyDuringBranchHours: v })}
                  label={t('promo.field.schedule_onlyDuringBranchHours', {
                    defaultValue: 'Only during each branch’s opening hours',
                  })}
                />
                <FormField
                  label={req(
                    t('promo.field.schedule_daysOfWeek', { defaultValue: 'Days of the week' }),
                  )}
                  className="sm:col-span-2"
                >
                  <Multi
                    values={draft.schedule.daysOfWeek}
                    options={dayNames.map((d, i) => [i, d] as const)}
                    onChange={(v) => setSchedule({ daysOfWeek: [...v].sort((a, b) => a - b) })}
                  />
                </FormField>
                <FormField
                  label={req(
                    t('promo.field.schedule_expiresAfterIssueDays', {
                      defaultValue: 'Coupon expires after it is issued',
                    }),
                  )}
                  hint={t('promo.wizard.expiresHint', {
                    defaultValue: 'Days (1–365); never later than the campaign end date.',
                  })}
                >
                  <Input
                    type="number"
                    min={1}
                    max={365}
                    value={draft.schedule.expiresAfterIssueDays ?? ''}
                    onChange={(e) =>
                      setSchedule({ expiresAfterIssueDays: num(e.target.value) as number })
                    }
                  />
                </FormField>
                <div className={cn(GROUP, 'sm:grid-cols-2')}>
                  <Check
                    className="sm:col-span-2"
                    checked={draft.schedule.limitedTime.enabled}
                    onChange={(v) =>
                      setSchedule({ limitedTime: { ...draft.schedule.limitedTime, enabled: v } })
                    }
                    label={t('promo.field.schedule_limitedTime_enabled', {
                      defaultValue: 'Limited-time redemption (flash offer)',
                    })}
                  />
                  {draft.schedule.limitedTime.enabled && (
                    <FormField
                      label={req(
                        t('promo.field.schedule_limitedTime_hours', {
                          defaultValue: 'Must be used within',
                        }),
                      )}
                      hint={t('promo.wizard.hoursHint', {
                        defaultValue: 'Hours after it is issued (1–168).',
                      })}
                    >
                      <Input
                        type="number"
                        min={1}
                        max={168}
                        value={draft.schedule.limitedTime.hours ?? ''}
                        onChange={(e) =>
                          setSchedule({
                            limitedTime: { enabled: true, hours: num(e.target.value) },
                          })
                        }
                      />
                    </FormField>
                  )}
                </div>
              </div>
            )}
            {step === 6 && (
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField
                  label={req(t('promo.field.distribution_channels', { defaultValue: 'Channels' }))}
                  hint={t('promo.wizard.channelsHint', {
                    defaultValue:
                      'The wallet and push are free; SMS and WhatsApp cost per message and are counted in the business case.',
                  })}
                  className="sm:col-span-2"
                >
                  <Multi
                    cards
                    values={draft.distribution.channels}
                    options={CHANNELS.map((c) => [c, c.replace(/_/g, ' ').toLowerCase()] as const)}
                    onChange={(v) => set('distribution', { ...draft.distribution, channels: v })}
                  />
                </FormField>
                <FormField
                  label={t('promo.field.distribution_addMode', {
                    defaultValue: 'How is the coupon added to the customer?',
                  })}
                  className="sm:col-span-2"
                >
                  <Choice
                    cards
                    value={draft.distribution.addMode}
                    options={[
                      [
                        'AUTO_WALLET',
                        t('promo.wizard.addAuto', {
                          defaultValue: 'Added to the wallet automatically',
                        }),
                      ],
                      [
                        'CUSTOMER_CLAIMS',
                        t('promo.wizard.addClaim', { defaultValue: 'The customer claims it' }),
                      ],
                    ]}
                    onChange={(v) => set('distribution', { ...draft.distribution, addMode: v })}
                  />
                </FormField>
                <FormField
                  label={t('promo.field.distribution_issueMode', {
                    defaultValue: 'How is the coupon issued?',
                  })}
                  className="sm:col-span-2"
                >
                  <Choice
                    value={draft.distribution.issueMode}
                    options={[
                      [
                        'ALL_AT_ONCE',
                        t('promo.wizard.issueAll', { defaultValue: 'To everyone at once' }),
                      ],
                      [
                        'WHEN_ELIGIBLE',
                        t('promo.wizard.issueEligible', {
                          defaultValue: 'To each customer when they qualify',
                        }),
                      ],
                    ]}
                    onChange={(v) => set('distribution', { ...draft.distribution, issueMode: v })}
                  />
                </FormField>
                {draft.distribution.channels.includes('PUSH') && (
                  <>
                    <FormField
                      label={req(
                        t('promo.field.communication_push_title_en', {
                          defaultValue: 'Notification title (English)',
                        }),
                      )}
                    >
                      <Input
                        value={comm.push.title.en}
                        maxLength={65}
                        onChange={(e) =>
                          setComm({
                            push: {
                              ...comm.push,
                              title: { ...comm.push.title, en: e.target.value },
                            },
                          })
                        }
                      />
                    </FormField>
                    <FormField
                      label={req(
                        t('promo.field.communication_push_title_ar', {
                          defaultValue: 'Notification title (Arabic)',
                        }),
                      )}
                    >
                      <Input
                        dir="rtl"
                        value={comm.push.title.ar}
                        maxLength={65}
                        onChange={(e) =>
                          setComm({
                            push: {
                              ...comm.push,
                              title: { ...comm.push.title, ar: e.target.value },
                            },
                          })
                        }
                      />
                    </FormField>
                  </>
                )}
                <FormField
                  label={t('promo.field.communication_sendTime', { defaultValue: 'Send' })}
                >
                  <Select
                    value={comm.sendTime}
                    onChange={(e) => setComm({ sendTime: e.target.value as typeof comm.sendTime })}
                  >
                    <option value="ON_ISSUE">
                      {t('promo.wizard.sendOnIssue', { defaultValue: 'When the coupon is issued' })}
                    </option>
                    <option value="ON_START_DATE">
                      {t('promo.wizard.sendOnStart', {
                        defaultValue: 'On the campaign start date',
                      })}
                    </option>
                    <option value="BEST_TIME">
                      {t('promo.wizard.sendBestTime', {
                        defaultValue: 'At each customer’s best time',
                      })}
                    </option>
                  </Select>
                </FormField>
                {draft.distribution.channels.includes('PUSH') && (
                  <>
                    <FormField
                      label={req(
                        t('promo.field.communication_push_body_en', {
                          defaultValue: 'Message (English)',
                        }),
                      )}
                      className="sm:col-span-2"
                    >
                      <Textarea
                        rows={2}
                        maxLength={240}
                        value={comm.push.body.en}
                        onChange={(e) =>
                          setComm({
                            push: { ...comm.push, body: { ...comm.push.body, en: e.target.value } },
                          })
                        }
                      />
                    </FormField>
                    <FormField
                      label={req(
                        t('promo.field.communication_push_body_ar', {
                          defaultValue: 'Message (Arabic)',
                        }),
                      )}
                      className="sm:col-span-2"
                    >
                      <Textarea
                        rows={2}
                        dir="rtl"
                        maxLength={240}
                        value={comm.push.body.ar}
                        onChange={(e) =>
                          setComm({
                            push: { ...comm.push, body: { ...comm.push.body, ar: e.target.value } },
                          })
                        }
                      />
                    </FormField>
                  </>
                )}
                {draft.distribution.channels.includes('IN_APP_BANNER') && (
                  <>
                    <FormField
                      label={req(
                        t('promo.field.communication_banner_text_en', {
                          defaultValue: 'Banner headline (English)',
                        }),
                      )}
                    >
                      <Input
                        value={comm.banner.text.en}
                        maxLength={80}
                        onChange={(e) =>
                          setComm({ banner: { text: { ...comm.banner.text, en: e.target.value } } })
                        }
                      />
                    </FormField>
                    <FormField
                      label={req(
                        t('promo.field.communication_banner_text_ar', {
                          defaultValue: 'Banner headline (Arabic)',
                        }),
                      )}
                    >
                      <Input
                        dir="rtl"
                        value={comm.banner.text.ar}
                        maxLength={80}
                        onChange={(e) =>
                          setComm({ banner: { text: { ...comm.banner.text, ar: e.target.value } } })
                        }
                      />
                    </FormField>
                  </>
                )}
                {draft.distribution.channels.includes('SMS') && (
                  <>
                    <FormField
                      label={req(
                        t('promo.field.communication_sms_text_en', {
                          defaultValue: 'SMS text (English)',
                        }),
                      )}
                      className="sm:col-span-2"
                    >
                      <Textarea
                        rows={2}
                        maxLength={320}
                        value={comm.sms.text.en}
                        onChange={(e) =>
                          setComm({ sms: { text: { ...comm.sms.text, en: e.target.value } } })
                        }
                      />
                    </FormField>
                    <FormField
                      label={req(
                        t('promo.field.communication_sms_text_ar', {
                          defaultValue: 'SMS text (Arabic)',
                        }),
                      )}
                      className="sm:col-span-2"
                    >
                      <Textarea
                        rows={2}
                        dir="rtl"
                        maxLength={320}
                        value={comm.sms.text.ar}
                        onChange={(e) =>
                          setComm({ sms: { text: { ...comm.sms.text, ar: e.target.value } } })
                        }
                      />
                    </FormField>
                  </>
                )}
                <FormField
                  label={t('promo.field.communication_frequencyCap', {
                    defaultValue: 'Maximum promotional messages per customer',
                  })}
                  hint={t('promo.wizard.capHint', {
                    defaultValue:
                      'Shared limit across campaigns; enforced by the notification service.',
                  })}
                >
                  <Select
                    value={comm.frequencyCap}
                    onChange={(e) =>
                      setComm({ frequencyCap: e.target.value as typeof comm.frequencyCap })
                    }
                  >
                    <option value="ONE_PER_DAY">
                      {t('promo.wizard.capDay', { defaultValue: '1 per day' })}
                    </option>
                    <option value="THREE_PER_WEEK">
                      {t('promo.wizard.capThreeWeek', { defaultValue: '3 per week' })}
                    </option>
                    <option value="ONE_PER_WEEK">
                      {t('promo.wizard.capWeek', { defaultValue: '1 per week' })}
                    </option>
                    <option value="NO_LIMIT">
                      {t('promo.wizard.capNone', { defaultValue: 'No limit' })}
                    </option>
                  </Select>
                </FormField>
                <div className={cn(GROUP, 'sm:grid-cols-1')}>
                  <Check
                    checked={comm.quietHours}
                    onChange={(v) => setComm({ quietHours: v })}
                    label={t('promo.field.communication_quietHours', {
                      defaultValue: 'No messages between 23:00 and 09:00',
                    })}
                  />
                  <Check
                    checked={comm.respectConsent}
                    onChange={(v) => setComm({ respectConsent: v })}
                    label={t('promo.field.communication_respectConsent', {
                      defaultValue: 'Only message customers who agreed to marketing messages',
                    })}
                    hint={t('promo.wizard.consentHint', {
                      defaultValue:
                        'Must stay on for SMS and email (PDPL); customers can opt out at any time.',
                    })}
                  />
                </div>
              </div>
            )}
            {step === 7 && (
              <div className="grid gap-4">
                <Preview draft={draft} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <FormField
                    label={t('promo.field.forecast_baselineOrderRatePct', {
                      defaultValue: 'Customers who would order anyway',
                    })}
                    hint={t('promo.wizard.baselineHint', {
                      defaultValue:
                        '% of the audience. Planning input; empty = estimated from the audience.',
                    })}
                  >
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      value={draft.forecast.baselineOrderRatePct ?? ''}
                      onChange={(e) =>
                        set('forecast', {
                          ...draft.forecast,
                          baselineOrderRatePct: num(e.target.value),
                        })
                      }
                    />
                  </FormField>
                  <FormField
                    label={t('promo.field.forecast_expectedUpliftPts', {
                      defaultValue: 'Extra customers the coupon brings',
                    })}
                    hint={t('promo.wizard.upliftHint', {
                      defaultValue:
                        'Percentage points. Planning input; empty = estimated from the objective.',
                    })}
                  >
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      value={draft.forecast.expectedUpliftPts ?? ''}
                      onChange={(e) =>
                        set('forecast', {
                          ...draft.forecast,
                          expectedUpliftPts: num(e.target.value),
                        })
                      }
                    />
                  </FormField>
                </div>
                <KeyValue
                  rows={[
                    [
                      t('promo.wizard.objective', { defaultValue: 'Objective' }),
                      labels[draft.objective]?.title ?? draft.objective,
                    ],
                    [t('promo.coupons.offer', { defaultValue: 'Offer' }), offerLabel(draft.offer)],
                    [
                      t('promo.coupons.customers', { defaultValue: 'Customers' }),
                      draft.audience.mode === 'SEGMENT'
                        ? draft.audience.conditions
                            .map((c) => `${c.c.replace(/_/g, ' ').toLowerCase()} ${c.p}`)
                            .join(` ${draft.audience.match.toLowerCase()} `)
                        : draft.audience.mode,
                    ],
                    [
                      t('promo.field.rules_minOrderSar', { defaultValue: 'Minimum order' }),
                      sar(draft.rules.minOrderSar),
                    ],
                    [
                      t('promo.wizard.validity', { defaultValue: 'Valid' }),
                      `${draft.schedule.startDate} → ${draft.schedule.endDate}`,
                    ],
                    [
                      t('promo.wizard.limits', { defaultValue: 'Limits' }),
                      `${int(draft.limits.totalRedemptions)} · ${sar(draft.limits.budgetSar)}`,
                    ],
                    [
                      t('promo.field.distribution_channels', { defaultValue: 'Channels' }),
                      draft.distribution.channels.join(', '),
                    ],
                  ]}
                />
                {problems.flat().length > 0 && (
                  <ul className="rounded-lg bg-warning-tint px-3 py-2 text-xs text-foreground ring-1 ring-inset ring-warning/25">
                    {problems.flat().map((p) => (
                      <li key={p}>• {p}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <div className="mt-5 flex items-center justify-between border-t border-foreground/[0.07] pt-3">
              <Button variant="ghost" disabled={step === 1} onClick={() => setStep(step - 1)}>
                {t('promo.wizard.back', { defaultValue: '← Back' })}
              </Button>
              <span className="text-2xs text-muted-foreground">
                {t('promo.wizard.autosave', { defaultValue: 'Nothing is sent until you publish.' })}
              </span>
              {step < STEPS ? (
                <Button onClick={() => setStep(step + 1)}>
                  {t('promo.wizard.next', { defaultValue: 'Next: {{s}} →', s: stepTitles[step] })}
                </Button>
              ) : (
                <Button
                  disabled={save.isPending || problems.some((p) => p.length > 0)}
                  onClick={() => save.mutate(true)}
                >
                  {t('promo.wizard.publish', { defaultValue: 'Send for approval' })}
                </Button>
              )}
            </div>
          </div>
          <aside className="space-y-3 self-start">
            <Panel
              title={t('promo.wizard.preStudy', { defaultValue: 'Pre-study' })}
              aside={
                <span className="text-2xs text-muted-foreground">
                  {t('promo.wizard.preStudyHint', {
                    defaultValue: 'Recommended, but hard to measure',
                  })}
                </span>
              }
            >
              <div className="grid gap-2">
                <FormField
                  label={t('promo.wizard.customersMatch', { defaultValue: 'Customers who match' })}
                >
                  <Input
                    type="number"
                    min={0}
                    value={study.customersMatched}
                    onChange={(e) =>
                      setStudy({ ...study, customersMatched: Number(e.target.value) })
                    }
                  />
                </FormField>
                <FormField
                  label={t('promo.wizard.redemptionRate', {
                    defaultValue: 'Expected redemption (%)',
                  })}
                >
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={study.redemptionRatePct}
                    onChange={(e) =>
                      setStudy({ ...study, redemptionRatePct: Number(e.target.value) })
                    }
                  />
                </FormField>
                <FormField
                  label={t('promo.wizard.avgOrder', { defaultValue: 'Average order (SAR)' })}
                >
                  <Input
                    type="number"
                    min={1}
                    value={study.avgOrderSar}
                    onChange={(e) => setStudy({ ...study, avgOrderSar: Number(e.target.value) })}
                  />
                </FormField>
              </div>
            </Panel>
            <Panel title={t('promo.wizard.atAGlance', { defaultValue: 'At a glance' })}>
              <KeyValue
                rows={[
                  [
                    t('promo.wizard.discount', { defaultValue: 'Discount' }),
                    offerLabel(draft.offer),
                  ],
                  [
                    t('promo.wizard.willReceive', { defaultValue: 'Will receive it' }),
                    int(forecast.customersMatched),
                  ],
                  [
                    t('promo.wizard.expectedCost', { defaultValue: 'Expected cost' }),
                    sar(forecast.discountSar + forecast.messageCostSar),
                  ],
                  [
                    t('promo.wizard.mostItCanCost', { defaultValue: 'Most it can cost' }),
                    sar(forecast.mostItCanCostSar),
                  ],
                  [
                    t('promo.wizard.extraOrders', { defaultValue: 'Extra orders expected' }),
                    int(forecast.expectedOrders),
                  ],
                  [
                    t('promo.wizard.expectedNet', { defaultValue: 'Expected net' }),
                    <span className={forecast.netSar < 0 ? 'text-destructive' : 'text-success'}>
                      {sar(forecast.netSar)} · {pct(forecast.roiPct)}
                    </span>,
                  ],
                ]}
              />
              {forecast.needsApproval && (
                <p className="mt-2 text-2xs text-warning">
                  {t('promo.wizard.needsApproval', {
                    defaultValue: 'Needs a second person: {{why}}',
                    why: forecast.approvalReasons.map((r) => r.replace(/_/g, ' ')).join(', '),
                  })}
                </p>
              )}
            </Panel>
          </aside>
        </div>
      </div>
    </div>
  );
}

function Toggle({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'rounded-full px-3 py-1 text-xs font-semibold ring-1 ring-inset',
        on
          ? 'bg-ink text-ink-foreground ring-transparent'
          : 'bg-card text-foreground/80 ring-foreground/[0.08]',
      )}
    >
      {label}
    </button>
  );
}

/** One of a few (the design's "radio" and "cards"): pills, or larger cards. */
function Choice<V extends string>({
  value,
  options,
  onChange,
  cards,
}: {
  value: V | '';
  options: ReadonlyArray<readonly [V, string]>;
  onChange: (v: V) => void;
  cards?: boolean;
}) {
  return (
    <div role="radiogroup" className={cn('flex flex-wrap gap-1.5', cards && 'grid sm:grid-cols-3')}>
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={cn(
            'ring-1 ring-inset',
            cards
              ? 'rounded-xl px-3 py-2 text-start text-xs font-semibold'
              : 'rounded-full px-3 py-1 text-xs font-semibold',
            value === v
              ? cards
                ? 'bg-primary-tint text-foreground ring-primary/40'
                : 'bg-ink text-ink-foreground ring-transparent'
              : 'bg-card text-foreground/80 ring-foreground/[0.08] hover:bg-secondary',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Any of a set (the design's "multi" and "multicards"). */
function Multi<V extends string | number>({
  values,
  options,
  onChange,
  cards,
  empty,
}: {
  values: readonly V[];
  options: ReadonlyArray<readonly [V, string]>;
  onChange: (v: V[]) => void;
  cards?: boolean;
  empty?: string;
}) {
  if (!options.length && empty) return <p className="text-2xs text-muted-foreground">{empty}</p>;
  return (
    <div className={cn('flex flex-wrap gap-1.5', cards && 'grid sm:grid-cols-3')}>
      {options.map(([v, label]) => (
        <Toggle
          key={String(v)}
          on={values.includes(v)}
          label={label}
          onClick={() =>
            onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v])
          }
        />
      ))}
    </div>
  );
}

/** A switch with its label (the design's "bool"). */
function Check({
  checked,
  onChange,
  label,
  hint,
  className,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  className?: string;
}) {
  return (
    <label className={cn('flex items-start gap-2 text-sm', className)}>
      <input
        type="checkbox"
        className="mt-1"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        {label}
        {hint && <span className="block text-2xs text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );
}

/** A question answered Yes or No (the design's "yesno"). */
function YesNo({
  label,
  hint,
  value,
  onChange,
  yes,
  no,
  className,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  yes: string;
  no: string;
  className?: string;
}) {
  return (
    <FormField label={label} hint={hint} className={className}>
      <Choice
        value={value ? 'yes' : 'no'}
        options={[
          ['yes', yes],
          ['no', no],
        ]}
        onChange={(v) => onChange(v === 'yes')}
      />
    </FormField>
  );
}

/** One menu item (the design's "itemselect"); a product id box when the menu is not known. */
function ItemSelect({
  products,
  value,
  onChange,
  placeholder,
}: {
  products: readonly EngineProduct[];
  value: string;
  onChange: (id: string) => void;
  placeholder: string;
}) {
  if (!products.length)
    return (
      <Input
        dir="ltr"
        value={value}
        maxLength={64}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value.trim())}
      />
    );
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">—</option>
      {products.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name} · SAR {p.priceSar}
        </option>
      ))}
    </Select>
  );
}

/** Several menu items (the design's "itempicker"): the chosen ones, and one more to add. */
function ItemPicker({
  products,
  values,
  onChange,
  placeholder,
  removeLabel,
}: {
  products: readonly EngineProduct[];
  values: readonly string[];
  onChange: (ids: string[]) => void;
  placeholder: string;
  removeLabel: string;
}) {
  const [typed, setTyped] = useState('');
  const name = (id: string) => products.find((p) => p.id === id)?.name ?? id;
  const add = (id: string) => {
    const v = id.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
  };
  return (
    <div className="space-y-2">
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {values.map((id) => (
            <button
              key={id}
              type="button"
              title={removeLabel}
              aria-label={`${removeLabel} ${name(id)}`}
              onClick={() => onChange(values.filter((x) => x !== id))}
              className="rounded-full bg-ink px-3 py-1 text-xs font-semibold text-ink-foreground"
            >
              {name(id)} ×
            </button>
          ))}
        </div>
      )}
      {products.length ? (
        <Select value="" onChange={(e) => add(e.target.value)}>
          <option value="">+</option>
          {products
            .filter((p) => !values.includes(p.id))
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · SAR {p.priceSar}
              </option>
            ))}
        </Select>
      ) : (
        <Input
          dir="ltr"
          value={typed}
          placeholder={placeholder}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add(typed);
              setTyped('');
            }
          }}
          onBlur={() => {
            add(typed);
            setTyped('');
          }}
        />
      )}
    </div>
  );
}

/** What the customer sees in the app's wallet. */
export function Preview({
  draft,
}: {
  draft: Pick<Draft, 'name' | 'offer' | 'rules' | 'schedule'>;
}) {
  return (
    <div className="mx-auto w-full max-w-xs rounded-2xl bg-ink p-4 text-ink-foreground shadow-float">
      <div className="text-2xs uppercase tracking-[0.14em] opacity-60">Coupon</div>
      <div className="mt-1 text-lg font-extrabold">{offerLabel(draft.offer)}</div>
      <div className="text-sm">{draft.name.en || '…'}</div>
      <div dir="rtl" className="text-sm opacity-80">
        {draft.name.ar || '…'}
      </div>
      <div className="mt-3 text-2xs opacity-70">
        min. SAR {draft.rules.minOrderSar} · valid to {draft.schedule.endDate}
      </div>
    </div>
  );
}

/* ── the problems on each step: the schema's own rules ─────────────────── */

/** Which step a top-level section of the draft is filled in on. */
const SECTION_STEP: Record<string, number> = {
  objective: 1,
  name: 1,
  reasonCode: 1,
  funding: 1,
  tenantId: 1,
  notes: 1,
  offer: 2,
  experiment: 2,
  trigger: 2,
  loyalty: 2,
  audience: 3,
  rules: 4,
  scope: 4,
  limits: 4,
  stacking: 4,
  fraud: 4,
  schedule: 5,
  distribution: 6,
  communication: 6,
  forecast: 7,
};
const SPEC_PATHS = CAMPAIGN_FIELD_SPEC.map((f) => ({
  f,
  p: f.path.replace(/^campaign\./, '').replace(/\[\]/g, ''),
}));

/** The design's field an issue path (`audience.phoneNumbers.0`) belongs to. */
export function fieldForIssue(path: string) {
  let best: (typeof SPEC_PATHS)[number] | undefined;
  for (const x of SPEC_PATHS)
    if ((path === x.p || path.startsWith(`${x.p}.`)) && (!best || x.p.length > best.p.length))
      best = x;
  return best?.f;
}

type TFn = (k: string, o: { defaultValue: string; [k: string]: unknown }) => string;

/**
 * Every rule the engine will refuse the draft on, worded for the step it is
 * on. The field types and ranges (CampaignDraftShape) and the cross-field
 * rules (campaignDraftIssues) are both checked, so a problem shows on its
 * step before the engine ever sees the draft.
 */
export function stepProblems(
  d: Draft,
  products: ReadonlyArray<{ id: string; priceSar: number }>,
  t: TFn,
): string[][] {
  const p: string[][] = [[], [], [], [], [], [], []];
  const seen = new Set<string>();
  const push = (path: string, text: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    const f = fieldForIssue(path);
    const step = f?.step ?? SECTION_STEP[path.split('.')[0]!] ?? 7;
    const label = f
      ? t(`promo.field.${f.key}`, { defaultValue: f.label })
      : path === 'audience.listId'
        ? t('promo.wizard.listId', { defaultValue: 'Saved list' })
        : path;
    p[step - 1]!.push(`${label}: ${text}`);
  };
  const shape = CampaignDraftShape.safeParse(d);
  if (!shape.success)
    for (const i of shape.error.issues)
      push(i.path.join('.'), t('promo.rule.invalid', { defaultValue: 'Check this value.' }));
  let issues: ReturnType<typeof campaignDraftIssues> = [];
  try {
    issues = campaignDraftIssues(shape.success ? shape.data : readCampaignDraft(d));
  } catch {
    /* a section too broken to judge: the shape problems above already name it */
  }
  for (const i of issues) push(i.path, t(`promo.rule.${i.rule}`, { defaultValue: i.message }));
  if (bundlePriceProblem(d.offer, products))
    push(
      'offer.bundle.priceSar',
      t('promo.rule.bundleBelowTotal', { defaultValue: 'Must be below the items’ normal total.' }),
    );
  return p;
}
