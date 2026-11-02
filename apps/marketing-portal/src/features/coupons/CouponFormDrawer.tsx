import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MARKETING_BRANDS,
  marketingCouponProblems,
  newMarketingCouponCode,
} from '@yiji/shared-types';
import { Button, DateField, Drawer, FormField, Input, Select, Textarea, toast } from '@yiji/ui';
import { useSaveCoupon, type CouponForm, type MarketingCoupon } from './api.js';

const today = () => new Date().toISOString().slice(0, 10);
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

function blank(): CouponForm {
  return {
    code: newMarketingCouponCode(),
    title: '',
    description: '',
    discount_category: 'Amount',
    coupon_value: '',
    coupon_percent: '',
    max_discount: '',
    order_minimum: '',
    valid_from: today(),
    valid_to: inDays(30),
    total_uses: 100,
    uses_per_customer: 1,
    delivery_type: '',
    yiji_brand_id: null,
    brand_name: null,
    no_other_discounts: false,
  };
}

function fromRow(c: MarketingCoupon): CouponForm {
  return {
    code: c.code,
    title: c.title,
    description: c.description ?? '',
    discount_category: c.discount_category,
    coupon_value: c.coupon_value ?? '',
    coupon_percent: c.coupon_percent ?? '',
    max_discount: c.max_discount ?? '',
    order_minimum: c.order_minimum ?? '',
    valid_from: String(c.valid_from).slice(0, 10),
    valid_to: String(c.valid_to).slice(0, 10),
    total_uses: c.total_uses,
    uses_per_customer: c.uses_per_customer,
    delivery_type: c.delivery_type ?? '',
    yiji_brand_id: c.yiji_brand_id ?? null,
    brand_name: c.brand_name ?? null,
    no_other_discounts: c.no_other_discounts === true,
  };
}

/** Empty strings go to the database as nothing, not as zero. */
function clean(f: CouponForm): CouponForm {
  const num = (v: unknown) => (v === '' || v === null || v === undefined ? null : Number(v));
  return {
    ...f,
    code: f.code.trim().toUpperCase(),
    title: f.title.trim(),
    description: (f.description ?? '').trim() || null,
    coupon_value: f.discount_category === 'Amount' ? num(f.coupon_value) : null,
    coupon_percent: f.discount_category === 'Percentage' ? num(f.coupon_percent) : null,
    max_discount: f.discount_category === 'Percentage' ? num(f.max_discount) : null,
    order_minimum: num(f.order_minimum),
    total_uses: Number(f.total_uses),
    uses_per_customer: Number(f.uses_per_customer),
    delivery_type: f.delivery_type || null,
  };
}

/**
 * Create or change a marketing coupon. Saving keeps it as a draft; "Submit for
 * approval" sends it to a manager. Nothing here talks to Yiji.
 */
export function CouponFormDrawer({
  open,
  coupon,
  onClose,
}: {
  open: boolean;
  /** The draft or rejected coupon being changed; null for a new one. */
  coupon: MarketingCoupon | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const save = useSaveCoupon();
  const [form, setForm] = useState<CouponForm>(blank);
  const [tried, setTried] = useState(false);
  useEffect(() => {
    if (open) {
      setForm(coupon ? fromRow(coupon) : blank());
      setTried(false);
    }
  }, [open, coupon]);

  const problems = useMemo(() => marketingCouponProblems(clean(form)), [form]);
  const set = <K extends keyof CouponForm>(k: K, v: CouponForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const pct = form.discount_category === 'Percentage';

  const submit = async (send: boolean) => {
    setTried(true);
    if (send && problems.length) return;
    if (!form.code.trim() || !form.title.trim()) return;
    try {
      await save.mutateAsync({ id: coupon?.id, form: clean(form), submit: send });
      toast.success(
        send
          ? t('coupons.submitted', { defaultValue: 'Sent to a manager for approval' })
          : t('coupons.saved', { defaultValue: 'Draft saved' }),
      );
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      toast.error(
        /unique|duplicate/i.test(msg)
          ? t('coupons.codeTaken', { defaultValue: 'That code is already used. Pick another.' })
          : t('coupons.saveFailed', { defaultValue: 'Could not save the coupon' }),
      );
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="lg"
      title={
        coupon
          ? t('coupons.editTitle', { defaultValue: 'Change marketing coupon' })
          : t('coupons.newTitle', { defaultValue: 'New marketing coupon' })
      }
      description={t('coupons.formDesc', {
        defaultValue:
          'A code anyone can enter in the Yiji app. It reaches Yiji only after a manager approves it, and cannot be changed after that.',
      })}
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('actions.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button variant="outline" disabled={save.isPending} onClick={() => void submit(false)}>
            {t('coupons.saveDraft', { defaultValue: 'Save draft' })}
          </Button>
          <Button variant="brand" disabled={save.isPending} onClick={() => void submit(true)}>
            {t('coupons.submit', { defaultValue: 'Submit for approval' })}
          </Button>
        </div>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={t('coupons.code', { defaultValue: 'Code' })}>
          <Input value={form.code} onChange={(e) => set('code', e.target.value.toUpperCase())} />
        </FormField>
        <FormField
          label={t('coupons.name', { defaultValue: 'Name customers see' })}
          className="sm:col-span-1"
        >
          <Input value={form.title} onChange={(e) => set('title', e.target.value)} />
        </FormField>
        <FormField
          label={t('coupons.why', { defaultValue: 'Why (internal)' })}
          className="sm:col-span-2"
        >
          <Textarea
            rows={2}
            value={form.description ?? ''}
            onChange={(e) => set('description', e.target.value)}
          />
        </FormField>
        <FormField label={t('coupons.category', { defaultValue: 'Discount' })}>
          <Select
            value={form.discount_category}
            onChange={(e) => set('discount_category', e.target.value as 'Amount' | 'Percentage')}
          >
            <option value="Amount">{t('coupons.amount', { defaultValue: 'Amount (SAR)' })}</option>
            <option value="Percentage">
              {t('coupons.percentage', { defaultValue: 'Percentage' })}
            </option>
          </Select>
        </FormField>
        {pct ? (
          <>
            <FormField label={t('coupons.percent', { defaultValue: 'Percentage off' })}>
              <Input
                type="number"
                inputMode="decimal"
                value={String(form.coupon_percent ?? '')}
                onChange={(e) => set('coupon_percent', e.target.value)}
              />
            </FormField>
            <FormField label={t('coupons.cap', { defaultValue: 'Maximum discount (SAR)' })}>
              <Input
                type="number"
                inputMode="decimal"
                value={String(form.max_discount ?? '')}
                onChange={(e) => set('max_discount', e.target.value)}
              />
            </FormField>
          </>
        ) : (
          <FormField label={t('coupons.value', { defaultValue: 'Amount off (SAR)' })}>
            <Input
              type="number"
              inputMode="decimal"
              value={String(form.coupon_value ?? '')}
              onChange={(e) => set('coupon_value', e.target.value)}
            />
          </FormField>
        )}
        <FormField label={t('coupons.minimum', { defaultValue: 'Minimum order (SAR, optional)' })}>
          <Input
            type="number"
            inputMode="decimal"
            value={String(form.order_minimum ?? '')}
            onChange={(e) => set('order_minimum', e.target.value)}
          />
        </FormField>
        <FormField label={t('coupons.from', { defaultValue: 'First day' })}>
          <DateField value={form.valid_from} onChange={(v) => set('valid_from', v)} />
        </FormField>
        <FormField label={t('coupons.to', { defaultValue: 'Last day' })}>
          <DateField value={form.valid_to} onChange={(v) => set('valid_to', v)} />
        </FormField>
        <FormField label={t('coupons.total', { defaultValue: 'Total uses (everyone)' })}>
          <Input
            type="number"
            inputMode="numeric"
            value={String(form.total_uses)}
            onChange={(e) => set('total_uses', e.target.value)}
          />
        </FormField>
        <FormField label={t('coupons.each', { defaultValue: 'Uses per customer' })}>
          <Input
            type="number"
            inputMode="numeric"
            value={String(form.uses_per_customer)}
            onChange={(e) => set('uses_per_customer', e.target.value)}
          />
        </FormField>
        <FormField label={t('coupons.brand', { defaultValue: 'Brand' })}>
          <Select
            value={form.yiji_brand_id == null ? '' : String(form.yiji_brand_id)}
            onChange={(e) => {
              const b = MARKETING_BRANDS.find((x) => String(x.yijiId) === e.target.value);
              setForm((f) => ({
                ...f,
                yiji_brand_id: b ? b.yijiId : null,
                brand_name: b ? b.name : null,
              }));
            }}
          >
            <option value="">{t('coupons.allBrands', { defaultValue: 'Every brand' })}</option>
            {MARKETING_BRANDS.map((b) => (
              <option key={b.yijiId} value={b.yijiId}>
                {b.name}
              </option>
            ))}
          </Select>
        </FormField>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input
            type="checkbox"
            checked={form.no_other_discounts === true}
            onChange={(e) => set('no_other_discounts', e.target.checked)}
          />
          {t('coupons.noOther', { defaultValue: 'Cannot be used with other discounts' })}
        </label>
      </div>
      {tried && problems.length > 0 && (
        <ul
          role="alert"
          className="mt-5 list-disc space-y-1 rounded-xl bg-destructive/10 px-6 py-3 text-sm text-destructive"
        >
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </Drawer>
  );
}
