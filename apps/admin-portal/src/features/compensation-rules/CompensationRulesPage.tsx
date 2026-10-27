import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  ConfirmDialog,
  Drawer,
  EmptyState,
  FormField,
  Input,
  Pill,
  SelectMenu,
  Skeleton,
  Textarea,
  cn,
  toast,
} from '@yiji/ui';
import {
  ISSUING_SIDES,
  compensationRuleProblems,
  isPercentageCategory,
  parseDeliveryTypes,
  toggleDeliveryType,
  type CompensationRule,
} from '@yiji/shared-types';
import { PAGE_BODY, PageHeader } from '../../components/shell/Page.js';
import { optionsWith, useOptionLists } from '../../lib/option-lists.js';
import {
  useCompensationRules,
  useDeleteCompensationRule,
  useRuleLimitSetting,
  useSaveCompensationRule,
  useSaveRuleLimit,
  useToggleCompensationRule,
  type RuleValues,
} from './api.js';

/**
 * COMPENSATION RULES (owner, 2026-10-27) - operations' compensation policy as
 * data: for a complaint, the coupon to offer by default.
 *
 * A rule only SUGGESTS. On the agent portal it pre-fills a new ticket's coupon
 * section (the agent can accept, adjust or switch it off); on a ticket Yiji
 * sends without a coupon it raises a PENDING request. A WeCare supervisor
 * approves every one, exactly as before. With no rules, nothing changes.
 */

const DELIVERY_TYPES = ['All', 'Delivery', 'Pickup', 'Carhop', 'Takeout', 'Dine-in'];
const COUPON_TYPES = ['Private', 'Public'];

/** The editor's state: every number as typed, so an empty box stays empty. */
interface Form {
  name: string;
  active: boolean;
  priority: string;
  complaint_type: string;
  service_type: string;
  min_delay_minutes: string;
  min_order_value: string;
  max_order_value: string;
  discount_category: string;
  coupon_value: string;
  coupon_percent: string;
  max_discount: string;
  validity_days: string;
  usage_limit: string;
  delivery_type: string;
  coupon_type: string;
  issuing_side: string;
  no_other_discounts: boolean;
  note: string;
}

const EMPTY: Form = {
  name: '',
  active: true,
  priority: '0',
  complaint_type: '',
  service_type: '',
  min_delay_minutes: '',
  min_order_value: '',
  max_order_value: '',
  discount_category: 'Amount',
  coupon_value: '',
  coupon_percent: '',
  max_discount: '',
  validity_days: '',
  usage_limit: '1',
  delivery_type: 'All',
  coupon_type: 'Private',
  issuing_side: 'Customer Care',
  no_other_discounts: false,
  note: '',
};

const txt = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v));

function formOf(r: CompensationRule): Form {
  return {
    name: r.name ?? '',
    active: r.active !== false,
    priority: txt(r.priority),
    complaint_type: r.complaint_type ?? '',
    service_type: r.service_type ?? '',
    min_delay_minutes: txt(r.min_delay_minutes),
    min_order_value: txt(r.min_order_value),
    max_order_value: txt(r.max_order_value),
    discount_category: r.discount_category || 'Amount',
    coupon_value: txt(r.coupon_value),
    coupon_percent: txt(r.coupon_percent),
    max_discount: txt(r.max_discount),
    validity_days: txt(r.validity_days),
    usage_limit: txt(r.usage_limit) || '1',
    delivery_type: r.delivery_type || 'All',
    coupon_type: r.coupon_type || 'Private',
    issuing_side: r.issuing_side || 'Customer Care',
    no_other_discounts: r.no_other_discounts === true,
    note: r.note ?? '',
  };
}

const numOrNull = (s: string): number | null => (s.trim() === '' ? null : Number(s));

/** The row to write. The money field that does not apply is cleared. */
export function valuesOf(f: Form): RuleValues {
  const pct = isPercentageCategory(f.discount_category);
  return {
    name: f.name.trim(),
    active: f.active,
    priority: numOrNull(f.priority) ?? 0,
    complaint_type: f.complaint_type,
    service_type: f.service_type || null,
    min_delay_minutes: numOrNull(f.min_delay_minutes),
    min_order_value: numOrNull(f.min_order_value),
    max_order_value: numOrNull(f.max_order_value),
    discount_category: pct ? 'Percentage' : 'Amount',
    coupon_value: pct ? null : numOrNull(f.coupon_value),
    coupon_percent: pct ? numOrNull(f.coupon_percent) : null,
    max_discount: pct ? numOrNull(f.max_discount) : null,
    validity_days: numOrNull(f.validity_days),
    usage_limit: numOrNull(f.usage_limit) ?? 1,
    delivery_type: f.delivery_type || 'All',
    coupon_type: f.coupon_type || 'Private',
    issuing_side: f.issuing_side || 'Customer Care',
    no_other_discounts: f.no_other_discounts,
    note: f.note.trim() || null,
  };
}

/** "30 SAR" or "20% (max 40 SAR)", plus validity - the outcome in one line. */
function useOutcome() {
  const { t } = useTranslation();
  return (r: CompensationRule) => {
    const money = isPercentageCategory(r.discount_category)
      ? t('compRules.outcomePercent', {
          defaultValue: '{{percent}}% (max {{max}} SAR)',
          percent: r.coupon_percent ?? '—',
          max: r.max_discount ?? '—',
        })
      : t('compRules.outcomeAmount', {
          defaultValue: '{{value}} SAR',
          value: r.coupon_value ?? '—',
        });
    const days = r.validity_days
      ? t('compRules.validDays', { defaultValue: '{{n}} days', n: r.validity_days })
      : t('compRules.validMonth', { defaultValue: '1 month' });
    return `${money} · ${days}`;
  };
}

function useConditions() {
  const { t } = useTranslation();
  return (r: CompensationRule) =>
    [
      r.service_type,
      r.min_delay_minutes != null
        ? t('compRules.condDelay', { defaultValue: '≥ {{n}} min late', n: r.min_delay_minutes })
        : null,
      r.min_order_value != null
        ? t('compRules.condMin', { defaultValue: 'order ≥ {{n}} SAR', n: r.min_order_value })
        : null,
      r.max_order_value != null
        ? t('compRules.condMax', { defaultValue: 'order ≤ {{n}} SAR', n: r.max_order_value })
        : null,
    ]
      .filter(Boolean)
      .join(' · ');
}

export function CompensationRulesPage(): JSX.Element {
  const { t } = useTranslation();
  const rules = useCompensationRules();
  const toggle = useToggleCompensationRule();
  const remove = useDeleteCompensationRule();
  const [editing, setEditing] = useState<CompensationRule | 'new' | null>(null);
  const [deleting, setDeleting] = useState<CompensationRule | null>(null);
  const outcome = useOutcome();
  const conditions = useConditions();
  const list = rules.data ?? [];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader
        title={t('nav.compensationRules', { defaultValue: 'Compensation rules' })}
        actions={
          <Button type="button" size="sm" onClick={() => setEditing('new')}>
            {t('compRules.new', { defaultValue: 'New rule' })}
          </Button>
        }
      />
      <div className={cn(PAGE_BODY, 'space-y-4')}>
        <section className="rounded-2xl bg-card p-5 shadow-soft ring-1 ring-foreground/[0.06]">
          <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
            {t('compRules.help', {
              defaultValue:
                'A rule decides the coupon a complaint gets by default. On a new ticket the agent sees it pre-filled and can accept, adjust or switch it off; a ticket from Yiji without a coupon gets it automatically. Every coupon still waits for a WeCare supervisor’s approval. When several rules match, the most specific one wins, then the highest priority.',
            })}
          </p>
        </section>

        <section className="overflow-hidden rounded-2xl bg-card shadow-soft ring-1 ring-foreground/[0.06]">
          {rules.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full rounded-xl" />
              ))}
            </div>
          ) : rules.isError ? (
            <p className="p-8 text-center text-sm text-destructive">
              {t('compRules.loadError', {
                defaultValue:
                  'Could not load the rules. If this environment was just updated, the compensation_rules collection may not be applied yet.',
              })}
            </p>
          ) : list.length === 0 ? (
            <EmptyState
              title={t('compRules.emptyTitle', { defaultValue: 'No compensation rules yet' })}
              description={t('compRules.emptyHelp', {
                defaultValue:
                  'Until a rule exists nothing is pre-filled for agents, and tickets from Yiji get no automatic coupon. Add the first rule from the ops compensation policy.',
              })}
              action={
                <Button type="button" size="sm" onClick={() => setEditing('new')}>
                  {t('compRules.new', { defaultValue: 'New rule' })}
                </Button>
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground shadow-[inset_0_-1px_0_oklch(var(--foreground)/0.07)]">
                    <th className="h-11 px-4 ps-5 text-start font-semibold">
                      {t('compRules.colRule', { defaultValue: 'Rule' })}
                    </th>
                    <th className="h-11 px-4 text-start font-semibold">
                      {t('compRules.colWhen', { defaultValue: 'When' })}
                    </th>
                    <th className="h-11 px-4 text-start font-semibold">
                      {t('compRules.colCoupon', { defaultValue: 'Coupon' })}
                    </th>
                    <th className="h-11 px-4 text-end font-semibold">
                      {t('compRules.colPriority', { defaultValue: 'Priority' })}
                    </th>
                    <th className="h-11 px-4 pe-5 text-end font-semibold">
                      <span className="sr-only">
                        {t('compRules.colActions', { defaultValue: 'Actions' })}
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={r.id} className="border-t border-foreground/[0.06] align-top">
                      <td className="px-4 py-3.5 ps-5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span dir="auto" className="font-medium text-foreground">
                            {r.name}
                          </span>
                          <Pill tone={r.active ? 'success' : 'muted'} size="sm">
                            {r.active
                              ? t('compRules.active', { defaultValue: 'Active' })
                              : t('compRules.inactive', { defaultValue: 'Off' })}
                          </Pill>
                        </div>
                      </td>
                      <td className="px-4 py-3.5 text-muted-foreground">
                        <span className="text-foreground">{r.complaint_type}</span>
                        {conditions(r) && <span className="block text-xs">{conditions(r)}</span>}
                      </td>
                      <td className="px-4 py-3.5 tabular-nums">{outcome(r)}</td>
                      <td className="px-4 py-3.5 text-end tabular-nums">{r.priority ?? 0}</td>
                      <td className="px-4 py-3.5 pe-5">
                        <div className="flex justify-end gap-1.5">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={toggle.isPending}
                            onClick={() =>
                              toggle.mutate(
                                { id: r.id, active: !r.active },
                                {
                                  onError: () =>
                                    toast.error(
                                      t('compRules.saveError', {
                                        defaultValue: 'Could not save the rule',
                                      }),
                                    ),
                                },
                              )
                            }
                          >
                            {r.active
                              ? t('compRules.turnOff', { defaultValue: 'Turn off' })
                              : t('compRules.turnOn', { defaultValue: 'Turn on' })}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => setEditing(r)}
                          >
                            {t('compRules.edit', { defaultValue: 'Edit' })}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="destructive-soft"
                            onClick={() => setDeleting(r)}
                          >
                            {t('compRules.delete', { defaultValue: 'Delete' })}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <CustomerLimitCard />
      </div>

      <RuleEditor
        open={editing !== null}
        rule={editing === 'new' ? null : editing}
        onClose={() => setEditing(null)}
      />
      <ConfirmDialog
        open={!!deleting}
        destructive
        title={t('compRules.deleteTitle', { defaultValue: 'Delete this rule?' })}
        description={t('compRules.deleteHelp', {
          defaultValue:
            'Coupons it already produced are kept; they simply stop naming a rule. To pause a rule instead, turn it off.',
        })}
        confirmLabel={t('compRules.delete', { defaultValue: 'Delete' })}
        loading={remove.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return;
          remove.mutate(deleting.id, {
            onSuccess: () => setDeleting(null),
            onError: () =>
              toast.error(
                t('compRules.deleteError', { defaultValue: 'Could not delete the rule' }),
              ),
          });
        }}
      />
    </div>
  );
}

/** The optional "max N rule coupons per customer per X days" (default off). */
function CustomerLimitCard(): JSX.Element {
  const { t } = useTranslation();
  const setting = useRuleLimitSetting();
  const save = useSaveRuleLimit();
  const [enabled, setEnabled] = useState(false);
  const [max, setMax] = useState('');
  const [days, setDays] = useState('');
  useEffect(() => {
    if (!setting.data) return;
    setEnabled(setting.data.enabled);
    setMax(txt(setting.data.maxPerCustomer));
    setDays(txt(setting.data.windowDays));
  }, [setting.data]);

  const maxN = Number(max);
  const daysN = Number(days);
  const invalid =
    enabled && (!Number.isInteger(maxN) || maxN < 1 || !Number.isInteger(daysN) || daysN < 1);

  return (
    <section className="rounded-2xl bg-card p-5 shadow-soft ring-1 ring-foreground/[0.06]">
      <h2 className="text-base font-semibold tracking-tight text-foreground">
        {t('compRules.limitTitle', { defaultValue: 'Per-customer limit' })}
      </h2>
      <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
        {t('compRules.limitHelp', {
          defaultValue:
            'Optional. When on, a customer who already had this many rule coupons in the window gets no new one from a rule (rejected coupons do not count). An agent can still request a coupon by hand.',
        })}
      </p>
      <div className="mt-4 flex flex-wrap items-end gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          {t('compRules.limitOn', { defaultValue: 'Limit rule coupons per customer' })}
        </label>
        <FormField label={t('compRules.limitMax', { defaultValue: 'At most' })}>
          <Input
            type="number"
            min={1}
            className="w-24"
            value={max}
            disabled={!enabled}
            onChange={(e) => setMax(e.target.value)}
          />
        </FormField>
        <FormField label={t('compRules.limitDays', { defaultValue: 'In the last (days)' })}>
          <Input
            type="number"
            min={1}
            className="w-24"
            value={days}
            disabled={!enabled}
            onChange={(e) => setDays(e.target.value)}
          />
        </FormField>
        <Button
          type="button"
          size="sm"
          disabled={invalid || save.isPending || setting.isLoading}
          loading={save.isPending}
          onClick={() =>
            save.mutate(
              {
                rowId: setting.data?.rowId ?? null,
                enabled,
                maxPerCustomer: max ? maxN : null,
                windowDays: days ? daysN : null,
              },
              {
                onSuccess: () =>
                  toast.success(t('compRules.limitSaved', { defaultValue: 'Limit saved' })),
                onError: () =>
                  toast.error(
                    t('compRules.saveError', { defaultValue: 'Could not save the rule' }),
                  ),
              },
            )
          }
        >
          {t('compRules.save', { defaultValue: 'Save' })}
        </Button>
      </div>
    </section>
  );
}

function RuleEditor({
  open,
  rule,
  onClose,
}: {
  open: boolean;
  rule: CompensationRule | null;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const lists = useOptionLists(open);
  const save = useSaveCompensationRule();
  const [form, setForm] = useState<Form>(EMPTY);
  useEffect(() => {
    if (open) setForm(rule ? formOf(rule) : EMPTY);
  }, [open, rule]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const pct = isPercentageCategory(form.discount_category);
  const values = useMemo(() => valuesOf(form), [form]);
  const problems = compensationRuleProblems(values);
  const firstProblem = Object.entries(problems)[0];

  const complaintTypes = optionsWith(lists.data, 'complaint_type', [form.complaint_type]);
  const serviceTypes = optionsWith(lists.data, 'service_type', [form.service_type]);
  const num = (k: keyof Form, label: string, hint?: string) => (
    <FormField label={label} hint={hint} error={problems[k as string]}>
      <Input
        type="number"
        min={0}
        step="any"
        value={form[k] as string}
        onChange={(e) => set(k, e.target.value as never)}
      />
    </FormField>
  );

  const submit = () => {
    if (firstProblem) return;
    save.mutate(
      { id: rule?.id ?? null, values },
      {
        onSuccess: () => {
          toast.success(t('compRules.saved', { defaultValue: 'Rule saved' }));
          onClose();
        },
        onError: () =>
          toast.error(t('compRules.saveError', { defaultValue: 'Could not save the rule' })),
      },
    );
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="md"
      title={
        rule
          ? t('compRules.editTitle', { defaultValue: 'Edit rule' })
          : t('compRules.newTitle', { defaultValue: 'New compensation rule' })
      }
      description={t('compRules.editorHelp', {
        defaultValue: 'The coupon this rule suggests. A supervisor still approves every coupon.',
      })}
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-2.5">
          {firstProblem && (
            <span className="me-auto min-w-0 flex-1 basis-40 text-xs text-muted-foreground">
              {firstProblem[1]}
            </span>
          )}
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('compRules.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            type="button"
            onClick={submit}
            disabled={!!firstProblem || save.isPending}
            loading={save.isPending}
          >
            {t('compRules.save', { defaultValue: 'Save' })}
          </Button>
        </div>
      }
    >
      <div className="grid gap-4">
        <FormField label={t('compRules.fName', { defaultValue: 'Name' })} error={problems.name}>
          <Input value={form.name} onChange={(e) => set('name', e.target.value)} dir="auto" />
        </FormField>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary"
            checked={form.active}
            onChange={(e) => set('active', e.target.checked)}
          />
          {t('compRules.fActive', { defaultValue: 'Active' })}
        </label>

        <h3 className="text-sm font-semibold text-foreground">
          {t('compRules.when', { defaultValue: 'When' })}
        </h3>
        <FormField
          label={t('compRules.fComplaintType', { defaultValue: 'Complaint type' })}
          error={problems.complaint_type}
        >
          <SelectMenu
            fullWidth
            value={form.complaint_type}
            onChange={(v) => set('complaint_type', v)}
            placeholder={t('compRules.pick', { defaultValue: 'Choose…' })}
            options={complaintTypes.map((v) => ({ value: v, label: v }))}
            aria-label={t('compRules.fComplaintType', { defaultValue: 'Complaint type' })}
          />
        </FormField>
        <FormField label={t('compRules.fServiceType', { defaultValue: 'Service type' })}>
          <SelectMenu
            fullWidth
            value={form.service_type}
            onChange={(v) => set('service_type', v)}
            options={[
              { value: '', label: t('compRules.any', { defaultValue: 'Any' }) },
              ...serviceTypes.map((v) => ({ value: v, label: v })),
            ]}
            aria-label={t('compRules.fServiceType', { defaultValue: 'Service type' })}
          />
        </FormField>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {num(
            'min_delay_minutes',
            t('compRules.fMinDelay', { defaultValue: 'Min. delay (minutes)' }),
            t('compRules.optional', { defaultValue: 'Optional' }),
          )}
          {num(
            'min_order_value',
            t('compRules.fMinOrder', { defaultValue: 'Min. order (SAR)' }),
            t('compRules.optional', { defaultValue: 'Optional' }),
          )}
          {num(
            'max_order_value',
            t('compRules.fMaxOrder', { defaultValue: 'Max. order (SAR)' }),
            t('compRules.optional', { defaultValue: 'Optional' }),
          )}
        </div>
        {num(
          'priority',
          t('compRules.fPriority', { defaultValue: 'Priority' }),
          t('compRules.priorityHint', {
            defaultValue: 'Higher wins when two equally specific rules match.',
          }),
        )}

        <h3 className="text-sm font-semibold text-foreground">
          {t('compRules.then', { defaultValue: 'Coupon' })}
        </h3>
        <FormField label={t('compRules.fCategory', { defaultValue: 'Discount category' })}>
          <SelectMenu
            fullWidth
            value={pct ? 'Percentage' : 'Amount'}
            onChange={(v) => set('discount_category', v)}
            options={[
              { value: 'Amount', label: t('compRules.amount', { defaultValue: 'Amount' }) },
              {
                value: 'Percentage',
                label: t('compRules.percentage', { defaultValue: 'Percentage' }),
              },
            ]}
            aria-label={t('compRules.fCategory', { defaultValue: 'Discount category' })}
          />
        </FormField>
        {pct ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {num('coupon_percent', t('compRules.fPercent', { defaultValue: 'Percent off' }))}
            {num(
              'max_discount',
              t('compRules.fMaxDiscount', { defaultValue: 'Max. discount (SAR)' }),
            )}
          </div>
        ) : (
          num('coupon_value', t('compRules.fValue', { defaultValue: 'Value (SAR)' }))
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {num(
            'validity_days',
            t('compRules.fValidity', { defaultValue: 'Valid for (days)' }),
            t('compRules.validityHint', { defaultValue: 'Empty = one month' }),
          )}
          {num('usage_limit', t('compRules.fUsage', { defaultValue: 'Usage limit' }))}
        </div>
        <FormField label={t('compRules.fDelivery', { defaultValue: 'Delivery types' })}>
          <div className="flex flex-wrap gap-2">
            {DELIVERY_TYPES.map((d) => {
              const on = parseDeliveryTypes(form.delivery_type).includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    set(
                      'delivery_type',
                      toggleDeliveryType(form.delivery_type, d, DELIVERY_TYPES) || 'All',
                    )
                  }
                  className={cn(
                    'rounded-full px-3 py-1.5 text-xs font-medium',
                    on ? 'bg-ink text-ink-foreground' : 'bg-secondary text-foreground/80',
                  )}
                >
                  {d}
                </button>
              );
            })}
          </div>
        </FormField>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label={t('compRules.fCouponType', { defaultValue: 'Coupon type' })}>
            <SelectMenu
              fullWidth
              value={form.coupon_type}
              onChange={(v) => set('coupon_type', v)}
              options={COUPON_TYPES.map((v) => ({ value: v, label: v }))}
              aria-label={t('compRules.fCouponType', { defaultValue: 'Coupon type' })}
            />
          </FormField>
          <FormField label={t('compRules.fIssuingSide', { defaultValue: 'Issuing side' })}>
            <SelectMenu
              fullWidth
              value={form.issuing_side}
              onChange={(v) => set('issuing_side', v)}
              options={ISSUING_SIDES.map((s) => ({ value: s.value, label: s.value }))}
              aria-label={t('compRules.fIssuingSide', { defaultValue: 'Issuing side' })}
            />
          </FormField>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary"
            checked={form.no_other_discounts}
            onChange={(e) => set('no_other_discounts', e.target.checked)}
          />
          {t('compRules.fNoOther', { defaultValue: 'Cannot be combined with other discounts' })}
        </label>
        <FormField label={t('compRules.fNote', { defaultValue: 'Note' })}>
          <Textarea value={form.note} onChange={(e) => set('note', e.target.value)} rows={2} />
        </FormField>
      </div>
    </Drawer>
  );
}
