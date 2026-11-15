import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, FormField, Input, Select, Textarea, cn, toast } from '@yiji/ui';
import {
  AUDIENCE_CONDITIONS,
  CAMPAIGN_OBJECTIVES,
  CHANNELS,
  CampaignDraft,
  OBJECTIVE_CATALOGUE,
  OFFER_TYPES,
  ORDER_TYPES,
  PAYMENT_METHODS,
  forecastCampaign,
  objectiveSpec,
  offerLabel,
  type CampaignObjective,
  type CampaignForecast,
} from '@yiji/shared-types';
import { useEngine } from '../../engine/index.js';
import { CampaignDraftFromSpec } from '../../engine/sample.js';
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
 */
type Draft = CampaignDraft;
const STEPS = 7;

function emptyDraft(objective: CampaignObjective): Draft {
  const spec = objectiveSpec(objective);
  const start = today();
  const end = new Date(Date.now() + spec.recommended.validityDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return CampaignDraftFromSpec(spec, {
    name: { en: '', ar: '' },
    validity: { startDate: start, endDate: end, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] },
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
    setDraft(rest as Draft);
    setLoaded(true);
  }
  const [study, setStudy] = useState({
    customersMatched: 2_400,
    redemptionRatePct: 24,
    avgOrderSar: 67,
  });
  const forecast: CampaignForecast = useMemo(() => forecastCampaign(draft, study), [draft, study]);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const problems = useMemo(() => stepProblems(draft, t), [draft, t]);
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
                  label={t('promo.wizard.objectiveLabel', { defaultValue: 'Coupon objective *' })}
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
                    label={t('promo.wizard.nameEn', { defaultValue: 'Campaign name (English) *' })}
                    hint={t('promo.wizard.nameHint', {
                      defaultValue: 'Customers see this on the coupon. Max 60.',
                    })}
                  >
                    <Input
                      value={draft.name.en}
                      maxLength={60}
                      onChange={(e) => set('name', { ...draft.name, en: e.target.value })}
                    />
                  </FormField>
                  <FormField
                    label={t('promo.wizard.nameAr', { defaultValue: 'Campaign name (Arabic) *' })}
                  >
                    <Input
                      dir="rtl"
                      value={draft.name.ar}
                      maxLength={60}
                      onChange={(e) => set('name', { ...draft.name, ar: e.target.value })}
                    />
                  </FormField>
                  <FormField
                    label={t('promo.wizard.funding', { defaultValue: 'Who pays for the discount' })}
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
                      {['YIJI_MARKETING', 'BRAND', 'PARTNER', 'SHARED'].map((v) => (
                        <option key={v} value={v}>
                          {v.replace('_', ' ')}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                  {(draft.funding.source === 'PARTNER' || draft.funding.source === 'SHARED') && (
                    <FormField
                      label={t('promo.wizard.partnerShare', { defaultValue: 'Partner pays (%)' })}
                    >
                      <Input
                        type="number"
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
                  {draft.objective === 'SERVICE_RECOVERY' && (
                    <FormField
                      label={t('promo.wizard.reasonCode', {
                        defaultValue: 'Compensation reason *',
                      })}
                    >
                      <Select
                        value={draft.reasonCode ?? ''}
                        onChange={(e) => set('reasonCode', e.target.value)}
                      >
                        <option value="">—</option>
                        {['LATE_ORDER', 'MISSING_ITEM', 'QUALITY', 'DRIVER', 'APP_ISSUE'].map(
                          (v) => (
                            <option key={v} value={v}>
                              {v.replace('_', ' ')}
                            </option>
                          ),
                        )}
                      </Select>
                    </FormField>
                  )}
                  <FormField
                    label={t('promo.wizard.notes', { defaultValue: 'Internal note (optional)' })}
                    className="sm:col-span-2"
                  >
                    <Textarea
                      value={draft.notes ?? ''}
                      onChange={(e) => set('notes', e.target.value)}
                      rows={2}
                    />
                  </FormField>
                </div>
              </div>
            )}
            {step === 2 && (
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField
                  label={t('promo.wizard.discountType', { defaultValue: 'Discount type *' })}
                  className="sm:col-span-2"
                >
                  <div className="flex flex-wrap gap-1.5">
                    {OFFER_TYPES.map((ty) => (
                      <button
                        key={ty}
                        type="button"
                        aria-pressed={draft.offer.type === ty}
                        onClick={() => set('offer', { ...draft.offer, type: ty })}
                        className={cn(
                          'rounded-full px-3 py-1 text-xs font-semibold ring-1 ring-inset',
                          draft.offer.type === ty
                            ? 'bg-ink text-ink-foreground ring-transparent'
                            : 'bg-card ring-foreground/[0.08]',
                        )}
                      >
                        {ty.replace('_', ' ')}
                      </button>
                    ))}
                  </div>
                </FormField>
                {(draft.offer.type === 'PERCENT' || draft.offer.type === 'CASHBACK') && (
                  <FormField
                    label={t('promo.wizard.percent', { defaultValue: 'Discount percentage *' })}
                  >
                    <Input
                      type="number"
                      min={1}
                      max={100}
                      value={draft.offer.percent ?? ''}
                      onChange={(e) =>
                        set('offer', { ...draft.offer, percent: Number(e.target.value) })
                      }
                    />
                  </FormField>
                )}
                {draft.offer.type === 'FIXED' && (
                  <FormField
                    label={t('promo.wizard.amount', { defaultValue: 'Discount amount (SAR) *' })}
                  >
                    <Input
                      type="number"
                      min={1}
                      value={draft.offer.amountSar ?? ''}
                      onChange={(e) =>
                        set('offer', { ...draft.offer, amountSar: Number(e.target.value) })
                      }
                    />
                  </FormField>
                )}
                {(draft.offer.type === 'PERCENT' || draft.offer.type === 'CASHBACK') && (
                  <FormField
                    label={t('promo.wizard.maxDiscount', {
                      defaultValue: 'Maximum discount (SAR) *',
                    })}
                    hint={t('promo.wizard.maxDiscountHint', {
                      defaultValue: 'Caps the saving on large orders.',
                    })}
                  >
                    <Input
                      type="number"
                      min={1}
                      value={draft.offer.maxDiscountSar ?? ''}
                      onChange={(e) =>
                        set('offer', { ...draft.offer, maxDiscountSar: Number(e.target.value) })
                      }
                    />
                  </FormField>
                )}
                {draft.offer.type === 'FREE_ITEM' && (
                  <FormField label={t('promo.wizard.freeItem', { defaultValue: 'Free item *' })}>
                    <Select
                      value={draft.offer.freeItem?.productId ?? ''}
                      onChange={(e) => {
                        const p = products.find((x) => x.id === e.target.value);
                        set('offer', {
                          ...draft.offer,
                          freeItem: { productId: e.target.value, quantity: 1 },
                          amountSar: p?.priceSar,
                        });
                      }}
                    >
                      <option value="">—</option>
                      {products.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} · SAR {p.priceSar}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                )}
                {draft.offer.type === 'BXGY' && (
                  <>
                    <FormField label={t('promo.wizard.buyQty', { defaultValue: 'Customer buys' })}>
                      <Input
                        type="number"
                        min={1}
                        value={draft.offer.bxgy?.buyQty ?? 1}
                        onChange={(e) =>
                          set('offer', {
                            ...draft.offer,
                            bxgy: {
                              buyQty: Number(e.target.value),
                              getQty: draft.offer.bxgy?.getQty ?? 1,
                              productIds: draft.offer.bxgy?.productIds ?? [],
                            },
                          })
                        }
                      />
                    </FormField>
                    <FormField
                      label={t('promo.wizard.getQty', { defaultValue: 'Customer gets free' })}
                    >
                      <Input
                        type="number"
                        min={1}
                        value={draft.offer.bxgy?.getQty ?? 1}
                        onChange={(e) =>
                          set('offer', {
                            ...draft.offer,
                            bxgy: {
                              buyQty: draft.offer.bxgy?.buyQty ?? 1,
                              getQty: Number(e.target.value),
                              productIds: draft.offer.bxgy?.productIds ?? [],
                            },
                          })
                        }
                      />
                    </FormField>
                  </>
                )}
                {draft.offer.type === 'BUNDLE' && (
                  <FormField
                    label={t('promo.wizard.bundlePrice', { defaultValue: 'Bundle price (SAR) *' })}
                  >
                    <Input
                      type="number"
                      min={1}
                      value={draft.offer.bundle?.priceSar ?? ''}
                      onChange={(e) =>
                        set('offer', {
                          ...draft.offer,
                          bundle: {
                            productIds: draft.offer.bundle?.productIds ?? [],
                            priceSar: Number(e.target.value),
                          },
                        })
                      }
                    />
                  </FormField>
                )}
                {draft.offer.type === 'FREE_DELIVERY' && (
                  <FormField
                    label={t('promo.wizard.deliveryCovered', {
                      defaultValue: 'Delivery fee covered',
                    })}
                  >
                    <Select
                      value={
                        draft.offer.deliveryFeeCovered === 'FULL' ||
                        draft.offer.deliveryFeeCovered === undefined
                          ? 'FULL'
                          : 'PART'
                      }
                      onChange={(e) =>
                        set('offer', {
                          ...draft.offer,
                          deliveryFeeCovered: e.target.value === 'FULL' ? 'FULL' : 10,
                        })
                      }
                    >
                      <option value="FULL">
                        {t('promo.wizard.full', { defaultValue: 'Full' })}
                      </option>
                      <option value="PART">
                        {t('promo.wizard.part', { defaultValue: 'SAR 10' })}
                      </option>
                    </Select>
                  </FormField>
                )}
                {draft.offer.type === 'CASHBACK' && (
                  <FormField
                    label={t('promo.wizard.creditValidity', {
                      defaultValue: 'Credit can be used for (days)',
                    })}
                  >
                    <Input
                      type="number"
                      min={1}
                      value={draft.offer.cashback?.creditValidityDays ?? 14}
                      onChange={(e) =>
                        set('offer', {
                          ...draft.offer,
                          cashback: { creditValidityDays: Number(e.target.value) },
                        })
                      }
                    />
                  </FormField>
                )}
                <FormField
                  label={t('promo.wizard.posCode', { defaultValue: 'POS discount code' })}
                  hint={t('promo.wizard.posCodeHint', {
                    defaultValue: 'Matches the discount line in the restaurant POS.',
                  })}
                >
                  <Input
                    value={draft.offer.posDiscountCode ?? ''}
                    onChange={(e) =>
                      set('offer', { ...draft.offer, posDiscountCode: e.target.value })
                    }
                  />
                </FormField>
                <FormField
                  label={t('promo.wizard.onRefund', { defaultValue: 'If the order is refunded' })}
                >
                  <Select
                    value={draft.offer.onRefund}
                    onChange={(e) =>
                      set('offer', {
                        ...draft.offer,
                        onRefund: e.target.value as Draft['offer']['onRefund'],
                      })
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
                  label={t('promo.wizard.onCancel', {
                    defaultValue: 'If the order is cancelled before delivery',
                  })}
                >
                  <Select
                    value={draft.offer.onCancelBeforeCompletion}
                    onChange={(e) =>
                      set('offer', {
                        ...draft.offer,
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
                  <div className="sm:col-span-2 rounded-xl bg-secondary/40 p-3">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={draft.experiment.enabled}
                        onChange={(e) =>
                          set('experiment', { ...draft.experiment, enabled: e.target.checked })
                        }
                      />{' '}
                      {t('promo.wizard.experiment', {
                        defaultValue: 'Test two discount values against each other',
                      })}
                    </label>
                    {draft.experiment.enabled && (
                      <div className="mt-2 grid gap-3 sm:grid-cols-3">
                        <FormField
                          label={t('promo.wizard.variantB', { defaultValue: 'Version B amount' })}
                        >
                          <Input
                            type="number"
                            value={draft.experiment.variantB?.value ?? ''}
                            onChange={(e) =>
                              set('experiment', {
                                ...draft.experiment,
                                variantB: { value: Number(e.target.value) },
                              })
                            }
                          />
                        </FormField>
                        <FormField
                          label={t('promo.wizard.splitA', {
                            defaultValue: 'Share who get version A (%)',
                          })}
                        >
                          <Input
                            type="number"
                            min={10}
                            max={90}
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
                          label={t('promo.wizard.winner', { defaultValue: 'Pick the winner by' })}
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
                            {['PROFIT', 'REDEMPTIONS', 'REVENUE'].map((v) => (
                              <option key={v} value={v}>
                                {v.toLowerCase()}
                              </option>
                            ))}
                          </Select>
                        </FormField>
                      </div>
                    )}
                  </div>
                )}
                {draft.objective === 'FREQUENT_ORDER' && (
                  <div className="sm:col-span-2 grid gap-3 rounded-xl bg-secondary/40 p-3 sm:grid-cols-3">
                    <FormField
                      label={t('promo.wizard.stamps', { defaultValue: 'Stamps required' })}
                    >
                      <Input
                        type="number"
                        min={2}
                        value={draft.loyalty?.stampsRequired ?? 5}
                        onChange={(e) =>
                          set('loyalty', {
                            ...(draft.loyalty ?? {
                              stampExpiryDays: 60,
                              milestones: [],
                              minOrderToCountSar: 30,
                              countOrdersFrom: 'ANY',
                              repeat: true,
                              progressMessages: true,
                            }),
                            stampsRequired: Number(e.target.value),
                          })
                        }
                      />
                    </FormField>
                    <FormField label={t('promo.wizard.stampReward', { defaultValue: 'Reward' })}>
                      <Input
                        value={draft.loyalty?.reward ?? ''}
                        onChange={(e) =>
                          set('loyalty', {
                            ...(draft.loyalty ?? {
                              stampExpiryDays: 60,
                              milestones: [],
                              minOrderToCountSar: 30,
                              countOrdersFrom: 'ANY',
                              repeat: true,
                              progressMessages: true,
                            }),
                            reward: e.target.value,
                          })
                        }
                      />
                    </FormField>
                    <FormField
                      label={t('promo.wizard.stampExpiry', {
                        defaultValue: 'Stamps expire after (days)',
                      })}
                    >
                      <Input
                        type="number"
                        min={1}
                        value={draft.loyalty?.stampExpiryDays ?? 60}
                        onChange={(e) =>
                          set('loyalty', {
                            ...(draft.loyalty ?? {
                              milestones: [],
                              minOrderToCountSar: 30,
                              countOrdersFrom: 'ANY',
                              repeat: true,
                              progressMessages: true,
                            }),
                            stampExpiryDays: Number(e.target.value),
                          })
                        }
                      />
                    </FormField>
                  </div>
                )}
                {draft.objective === 'OCCASION' && (
                  <div className="sm:col-span-2 grid gap-3 rounded-xl bg-secondary/40 p-3 sm:grid-cols-3">
                    <FormField label={t('promo.wizard.occasion', { defaultValue: 'Celebrate' })}>
                      <Select
                        value={draft.trigger.birthday?.occasion ?? 'BIRTHDAY'}
                        onChange={(e) =>
                          set('trigger', {
                            birthday: {
                              ...(draft.trigger.birthday ?? {
                                issueDaysBefore: 3,
                                missingDateOfBirth: 'ASK',
                              }),
                              occasion: e.target.value as 'BIRTHDAY' | 'REGISTRATION_ANNIVERSARY',
                            },
                          })
                        }
                      >
                        <option value="BIRTHDAY">
                          {t('promo.wizard.birthday', { defaultValue: 'Birthday' })}
                        </option>
                        <option value="REGISTRATION_ANNIVERSARY">
                          {t('promo.wizard.anniversary', {
                            defaultValue: 'Registration anniversary',
                          })}
                        </option>
                      </Select>
                    </FormField>
                    <FormField
                      label={t('promo.wizard.issueBefore', {
                        defaultValue: 'Send the gift (days before)',
                      })}
                    >
                      <Input
                        type="number"
                        min={0}
                        max={30}
                        value={draft.trigger.birthday?.issueDaysBefore ?? 3}
                        onChange={(e) =>
                          set('trigger', {
                            birthday: {
                              ...(draft.trigger.birthday ?? {
                                occasion: 'BIRTHDAY',
                                missingDateOfBirth: 'ASK',
                              }),
                              issueDaysBefore: Number(e.target.value),
                            },
                          })
                        }
                      />
                    </FormField>
                    <FormField
                      label={t('promo.wizard.missingDob', {
                        defaultValue: 'Customers without a date of birth',
                      })}
                    >
                      <Select
                        value={draft.trigger.birthday?.missingDateOfBirth ?? 'ASK'}
                        onChange={(e) =>
                          set('trigger', {
                            birthday: {
                              ...(draft.trigger.birthday ?? {
                                occasion: 'BIRTHDAY',
                                issueDaysBefore: 3,
                              }),
                              missingDateOfBirth: e.target.value as 'ASK' | 'SKIP',
                            },
                          })
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
                  </div>
                )}
              </div>
            )}
            {step === 3 && (
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField
                  label={t('promo.wizard.audienceMode', {
                    defaultValue: 'How do you want to choose customers? *',
                  })}
                  className="sm:col-span-2"
                >
                  <div className="flex flex-wrap gap-1.5">
                    {(['SEGMENT', 'LIST', 'PHONES', 'ALL'] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        aria-pressed={draft.audience.mode === m}
                        onClick={() => set('audience', { ...draft.audience, mode: m })}
                        className={cn(
                          'rounded-full px-3 py-1 text-xs font-semibold ring-1 ring-inset',
                          draft.audience.mode === m
                            ? 'bg-ink text-ink-foreground ring-transparent'
                            : 'bg-card ring-foreground/[0.08]',
                        )}
                      >
                        {
                          {
                            SEGMENT: t('promo.wizard.segment', {
                              defaultValue: 'By behaviour (segment)',
                            }),
                            LIST: t('promo.wizard.list', { defaultValue: 'A saved list' }),
                            PHONES: t('promo.wizard.phones', { defaultValue: 'Phone numbers' }),
                            ALL: t('promo.wizard.everyone', { defaultValue: 'Everyone' }),
                          }[m]
                        }
                      </button>
                    ))}
                  </div>
                </FormField>
                {draft.audience.mode === 'SEGMENT' && (
                  <div className="sm:col-span-2 space-y-2">
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
                )}
                {draft.audience.mode === 'PHONES' && (
                  <FormField
                    label={t('promo.wizard.phoneNumbers', {
                      defaultValue: 'Customer phone numbers (+9665…, one per line)',
                    })}
                    className="sm:col-span-2"
                  >
                    <Textarea
                      rows={4}
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
                  <FormField label={t('promo.wizard.listId', { defaultValue: 'Saved list' })}>
                    <Input
                      value={draft.audience.listId ?? ''}
                      onChange={(e) =>
                        set('audience', { ...draft.audience, listId: e.target.value })
                      }
                      placeholder="list-…"
                    />
                  </FormField>
                )}
                <FormField
                  label={t('promo.wizard.visibility', {
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
                  label={t('promo.wizard.controlGroup', { defaultValue: 'Measurement group (%)' })}
                  hint={t('promo.wizard.controlGroupHint', {
                    defaultValue:
                      '0–20. A small share of matching customers does not get the coupon, so you can see how many extra orders it really created. 5–10% is enough.',
                  })}
                >
                  <Input
                    type="number"
                    min={0}
                    max={20}
                    value={draft.audience.controlGroupPct}
                    onChange={(e) =>
                      set('audience', {
                        ...draft.audience,
                        controlGroupPct: Number(e.target.value),
                      })
                    }
                  />
                </FormField>
                <label className="flex items-center gap-2 text-sm sm:col-span-2">
                  <input
                    type="checkbox"
                    checked={draft.audience.excludeDiscountSensitive}
                    onChange={(e) =>
                      set('audience', {
                        ...draft.audience,
                        excludeDiscountSensitive: e.target.checked,
                      })
                    }
                  />{' '}
                  {t('promo.wizard.excludeSensitive', {
                    defaultValue: 'Leave out customers who almost only order with coupons',
                  })}
                </label>
              </div>
            )}
            {step === 4 && (
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField
                  label={t('promo.wizard.minOrder', { defaultValue: 'Minimum order (SAR) *' })}
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
                <FormField
                  label={t('promo.wizard.maxOrder', {
                    defaultValue: 'Maximum eligible order (SAR, optional)',
                  })}
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
                  label={t('promo.wizard.previousOrders', {
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
                    {['ANY', 'NONE', 'ONE_PLUS', 'THREE_PLUS'].map((v) => (
                      <option key={v} value={v}>
                        {v.replace('_', ' ').toLowerCase()}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <label className="flex items-center gap-2 self-end text-sm">
                  <input
                    type="checkbox"
                    checked={draft.rules.firstOrderOnly}
                    onChange={(e) =>
                      set('rules', { ...draft.rules, firstOrderOnly: e.target.checked })
                    }
                  />{' '}
                  {t('promo.wizard.firstOrderOnly', {
                    defaultValue: 'Only valid on the customer’s first order',
                  })}
                </label>
                <FormField
                  label={t('promo.wizard.paymentMethods', { defaultValue: 'Payment methods *' })}
                  className="sm:col-span-2"
                >
                  <div className="flex flex-wrap gap-1.5">
                    {PAYMENT_METHODS.map((m) => (
                      <Toggle
                        key={m}
                        on={draft.rules.paymentMethods.includes(m)}
                        label={m.replace('_', ' ')}
                        onClick={() =>
                          set('rules', {
                            ...draft.rules,
                            paymentMethods: draft.rules.paymentMethods.includes(m)
                              ? draft.rules.paymentMethods.filter((x) => x !== m)
                              : [...draft.rules.paymentMethods, m],
                          })
                        }
                      />
                    ))}
                  </div>
                </FormField>
                <FormField
                  label={t('promo.wizard.brands', { defaultValue: 'Brands (none = all)' })}
                  className="sm:col-span-2"
                >
                  <div className="flex flex-wrap gap-1.5">
                    {brands.map((b) => (
                      <Toggle
                        key={b.id}
                        on={draft.scope.brandIds.includes(b.id)}
                        label={b.name}
                        onClick={() =>
                          set('scope', {
                            ...draft.scope,
                            brandIds: draft.scope.brandIds.includes(b.id)
                              ? draft.scope.brandIds.filter((x) => x !== b.id)
                              : [...draft.scope.brandIds, b.id],
                          })
                        }
                      />
                    ))}
                  </div>
                </FormField>
                <FormField
                  label={t('promo.wizard.orderTypes', { defaultValue: 'Order types *' })}
                  className="sm:col-span-2"
                >
                  <div className="flex flex-wrap gap-1.5">
                    {ORDER_TYPES.map((o) => (
                      <Toggle
                        key={o}
                        on={draft.scope.orderTypes.includes(o)}
                        label={o.replace('_', ' ').toLowerCase()}
                        onClick={() =>
                          set('scope', {
                            ...draft.scope,
                            orderTypes: draft.scope.orderTypes.includes(o)
                              ? draft.scope.orderTypes.filter((x) => x !== o)
                              : [...draft.scope.orderTypes, o],
                          })
                        }
                      />
                    ))}
                  </div>
                </FormField>
                <FormField
                  label={t('promo.wizard.perCustomer', {
                    defaultValue: 'Redemptions per customer',
                  })}
                >
                  <Select
                    value={draft.limits.perCustomerMode}
                    onChange={(e) =>
                      set('limits', {
                        ...draft.limits,
                        perCustomerMode: e.target.value as Draft['limits']['perCustomerMode'],
                      })
                    }
                  >
                    <option value="ONE">{t('promo.wizard.once', { defaultValue: 'Once' })}</option>
                    <option value="MONTHLY">
                      {t('promo.wizard.monthly', { defaultValue: 'Monthly limit' })}
                    </option>
                    <option value="UNLIMITED">
                      {t('promo.wizard.unlimited', { defaultValue: 'Unlimited' })}
                    </option>
                  </Select>
                </FormField>
                {draft.limits.perCustomerMode === 'MONTHLY' && (
                  <FormField
                    label={t('promo.wizard.perCustomerMax', {
                      defaultValue: 'Maximum per customer per month',
                    })}
                  >
                    <Input
                      type="number"
                      min={1}
                      value={draft.limits.perCustomerMax ?? 3}
                      onChange={(e) =>
                        set('limits', { ...draft.limits, perCustomerMax: Number(e.target.value) })
                      }
                    />
                  </FormField>
                )}
                <FormField
                  label={t('promo.wizard.totalRedemptions', {
                    defaultValue: 'Total redemption limit *',
                  })}
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
                  label={t('promo.wizard.budget', { defaultValue: 'Discount budget (SAR) *' })}
                  hint={t('promo.wizard.budgetHint', {
                    defaultValue: 'The campaign pauses when it is used up.',
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
                  label={t('promo.wizard.daily', {
                    defaultValue: 'Daily redemption limit (0 = none)',
                  })}
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
                <FormField label={t('promo.wizard.codeType', { defaultValue: 'Coupon code' })}>
                  <Select
                    value={draft.distribution.codeType}
                    onChange={(e) =>
                      set('distribution', {
                        ...draft.distribution,
                        codeType: e.target.value as Draft['distribution']['codeType'],
                      })
                    }
                  >
                    <option value="NONE">
                      {t('promo.wizard.noCode', { defaultValue: 'No code - added to the wallet' })}
                    </option>
                    <option value="SHARED">
                      {t('promo.wizard.sharedCode', { defaultValue: 'One shared code' })}
                    </option>
                    <option value="UNIQUE">
                      {t('promo.wizard.uniqueCodes', { defaultValue: 'Unique codes' })}
                    </option>
                  </Select>
                </FormField>
                {draft.distribution.codeType === 'SHARED' && (
                  <FormField label={t('promo.wizard.code', { defaultValue: 'Shared code *' })}>
                    <Input
                      value={draft.distribution.code ?? ''}
                      onChange={(e) =>
                        set('distribution', {
                          ...draft.distribution,
                          code: e.target.value.toUpperCase(),
                        })
                      }
                    />
                  </FormField>
                )}
                {draft.distribution.codeType === 'UNIQUE' && (
                  <FormField
                    label={t('promo.wizard.uniqueCount', {
                      defaultValue: 'Number of unique codes',
                    })}
                  >
                    <Input
                      type="number"
                      min={1}
                      value={draft.distribution.uniqueCodeCount ?? 5000}
                      onChange={(e) =>
                        set('distribution', {
                          ...draft.distribution,
                          uniqueCodeCount: Number(e.target.value),
                        })
                      }
                    />
                  </FormField>
                )}
                <div className="sm:col-span-2 grid gap-2 rounded-xl bg-secondary/40 p-3 sm:grid-cols-3">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.stacking.combineWithOtherOffers}
                      onChange={(e) =>
                        set('stacking', {
                          ...draft.stacking,
                          combineWithOtherOffers: e.target.checked,
                        })
                      }
                    />{' '}
                    {t('promo.wizard.withOffers', {
                      defaultValue: 'Can be used with other offers',
                    })}
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.stacking.combineWithLoyalty}
                      onChange={(e) =>
                        set('stacking', { ...draft.stacking, combineWithLoyalty: e.target.checked })
                      }
                    />{' '}
                    {t('promo.wizard.withLoyalty', {
                      defaultValue: 'Can be combined with loyalty benefits',
                    })}
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.stacking.combineWithOtherCoupons}
                      onChange={(e) =>
                        set('stacking', {
                          ...draft.stacking,
                          combineWithOtherCoupons: e.target.checked,
                        })
                      }
                    />{' '}
                    {t('promo.wizard.withCoupons', {
                      defaultValue: 'Can be combined with other discounts',
                    })}
                  </label>
                </div>
              </div>
            )}
            {step === 5 && (
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField label={t('promo.wizard.startDate', { defaultValue: 'Start date *' })}>
                  <Input
                    type="date"
                    value={draft.validity.startDate}
                    onChange={(e) =>
                      set('validity', { ...draft.validity, startDate: e.target.value })
                    }
                  />
                </FormField>
                <FormField label={t('promo.wizard.endDate', { defaultValue: 'End date *' })}>
                  <Input
                    type="date"
                    value={draft.validity.endDate}
                    onChange={(e) =>
                      set('validity', { ...draft.validity, endDate: e.target.value })
                    }
                  />
                </FormField>
                <FormField
                  label={t('promo.wizard.startTime', { defaultValue: 'From time (optional)' })}
                >
                  <Input
                    type="time"
                    value={draft.validity.startTime ?? ''}
                    onChange={(e) =>
                      set('validity', { ...draft.validity, startTime: e.target.value || undefined })
                    }
                  />
                </FormField>
                <FormField
                  label={t('promo.wizard.endTime', { defaultValue: 'To time (optional)' })}
                >
                  <Input
                    type="time"
                    value={draft.validity.endTime ?? ''}
                    onChange={(e) =>
                      set('validity', { ...draft.validity, endTime: e.target.value || undefined })
                    }
                  />
                </FormField>
                <FormField
                  label={t('promo.wizard.days', { defaultValue: 'Days of the week' })}
                  className="sm:col-span-2"
                >
                  <div className="flex flex-wrap gap-1.5">
                    {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => (
                      <Toggle
                        key={d}
                        on={draft.validity.daysOfWeek.includes(i)}
                        label={d}
                        onClick={() =>
                          set('validity', {
                            ...draft.validity,
                            daysOfWeek: draft.validity.daysOfWeek.includes(i)
                              ? draft.validity.daysOfWeek.filter((x) => x !== i)
                              : [...draft.validity.daysOfWeek, i].sort(),
                          })
                        }
                      />
                    ))}
                  </div>
                </FormField>
              </div>
            )}
            {step === 6 && (
              <FormField
                label={t('promo.wizard.channels', { defaultValue: 'Channels *' })}
                hint={t('promo.wizard.channelsHint', {
                  defaultValue:
                    'The wallet and push are free; SMS and WhatsApp cost per message and are counted in the business case.',
                })}
              >
                <div className="flex flex-wrap gap-1.5">
                  {CHANNELS.map((c) => (
                    <Toggle
                      key={c}
                      on={draft.distribution.channels.includes(c)}
                      label={c.replace(/_/g, ' ').toLowerCase()}
                      onClick={() =>
                        set('distribution', {
                          ...draft.distribution,
                          channels: draft.distribution.channels.includes(c)
                            ? draft.distribution.channels.filter((x) => x !== c)
                            : [...draft.distribution.channels, c],
                        })
                      }
                    />
                  ))}
                </div>
              </FormField>
            )}
            {step === 7 && (
              <div className="grid gap-4">
                <Preview draft={draft} />
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
                      t('promo.wizard.minOrder', { defaultValue: 'Minimum order (SAR) *' }).replace(
                        ' *',
                        '',
                      ),
                      sar(draft.rules.minOrderSar),
                    ],
                    [
                      t('promo.wizard.validity', { defaultValue: 'Valid' }),
                      `${draft.validity.startDate} → ${draft.validity.endDate}`,
                    ],
                    [
                      t('promo.wizard.limits', { defaultValue: 'Limits' }),
                      `${int(draft.limits.totalRedemptions)} · ${sar(draft.limits.budgetSar)}`,
                    ],
                    [
                      t('promo.wizard.channels', { defaultValue: 'Channels *' }).replace(' *', ''),
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

/** What the customer sees in the app's wallet. */
export function Preview({
  draft,
}: {
  draft: Pick<Draft, 'name' | 'offer' | 'rules' | 'validity'>;
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
        min. SAR {draft.rules.minOrderSar} · valid to {draft.validity.endDate}
      </div>
    </div>
  );
}

function stepProblems(d: Draft, t: (k: string, o: { defaultValue: string }) => string): string[][] {
  const p: string[][] = [[], [], [], [], [], [], []];
  if (!d.name.en.trim() || !d.name.ar.trim())
    p[0]!.push(t('promo.wizard.pName', { defaultValue: 'Both campaign names are required.' }));
  if (d.objective === 'SERVICE_RECOVERY' && !d.reasonCode)
    p[0]!.push(t('promo.wizard.pReason', { defaultValue: 'A compensation reason is required.' }));
  if (
    (d.offer.type === 'PERCENT' || d.offer.type === 'CASHBACK') &&
    (!(d.offer.percent! > 0) || !(d.offer.maxDiscountSar! > 0))
  )
    p[1]!.push(
      t('promo.wizard.pPercent', {
        defaultValue: 'A percentage needs its percent and a maximum discount.',
      }),
    );
  if (d.offer.type === 'FIXED' && !(d.offer.amountSar! > 0))
    p[1]!.push(t('promo.wizard.pAmount', { defaultValue: 'A fixed discount needs an amount.' }));
  if (d.offer.type === 'FREE_ITEM' && !d.offer.freeItem?.productId)
    p[1]!.push(t('promo.wizard.pFreeItem', { defaultValue: 'Pick the free item.' }));
  if (d.audience.mode === 'SEGMENT' && d.audience.conditions.length === 0)
    p[2]!.push(
      t('promo.wizard.pConditions', {
        defaultValue: 'Add at least one condition, or choose Everyone.',
      }),
    );
  if (d.audience.mode === 'PHONES' && d.audience.phoneNumbers.length === 0)
    p[2]!.push(t('promo.wizard.pPhones', { defaultValue: 'Add the phone numbers.' }));
  if (d.rules.paymentMethods.length === 0)
    p[3]!.push(t('promo.wizard.pPayment', { defaultValue: 'Pick at least one payment method.' }));
  if (d.scope.orderTypes.length === 0)
    p[3]!.push(t('promo.wizard.pOrderTypes', { defaultValue: 'Pick at least one order type.' }));
  if (!(d.limits.totalRedemptions > 0) || !(d.limits.budgetSar > 0))
    p[3]!.push(
      t('promo.wizard.pLimits', { defaultValue: 'Set the total redemption limit and the budget.' }),
    );
  if (d.distribution.codeType === 'SHARED' && !d.distribution.code?.trim())
    p[3]!.push(t('promo.wizard.pCode', { defaultValue: 'Type the shared code.' }));
  if (!d.validity.startDate || !d.validity.endDate || d.validity.endDate < d.validity.startDate)
    p[4]!.push(
      t('promo.wizard.pDates', {
        defaultValue: 'The end date must be on or after the start date.',
      }),
    );
  if (d.validity.daysOfWeek.length === 0)
    p[4]!.push(t('promo.wizard.pDays', { defaultValue: 'Pick at least one day.' }));
  if (d.distribution.channels.length === 0)
    p[5]!.push(t('promo.wizard.pChannels', { defaultValue: 'Pick at least one channel.' }));
  return p;
}
