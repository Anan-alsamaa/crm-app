import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Drawer, DrawerSection, FormField, Input, SelectMenu, toast } from '@yiji/ui';
import {
  compensationFlag,
  couponPrefix,
  CouponRequestDraftChecked,
  defaultCouponDates,
  generateCouponCode,
  type CouponRequestDraft,
} from '@yiji/shared-types';
import { optionsFor, useOptionLists } from '../tickets/option-lists.js';
import { useRequestCouponApproval } from './api.js';

/**
 * The coupon an agent asks a supervisor to approve.
 *
 * Two things are deliberately NOT on this form:
 *
 *   The brand and restaurant, which are resolved from the ticket's order. A
 *   coupon belongs to the branch the complaint was about, and letting an agent
 *   pick would let them compensate against the wrong one.
 *
 *   The times. A coupon runs for whole days — see `couponWindow` in the shared
 *   contract — so asking for a time would only invite a wrong one.
 *
 * The code is generated rather than typed, and the title starts as the
 * customer's phone number because that is what operations search by.
 */
export interface CouponRequestDialogProps {
  open: boolean;
  onClose: () => void;
  ticketId: string;
  contactId: string | null;
  /** Seeds the title — what operations search by. */
  customerPhone: string | null;
  /** Carried over from the complaint, editable here. */
  description: string | null;
  /** Resolved from the order, not asked for. */
  brandId: string | null;
  restaurantId: string | null;
  requestedBy: string | null;
  onCreated?: () => void;
  /**
   * Collect the coupon instead of raising it.
   *
   * On the add-ticket form there is no ticket yet, so there is nothing to attach
   * a request to. In that case the dialog hands the validated draft back and the
   * ticket-create flow raises the request once the ticket exists — which also
   * means a failed coupon can never leave a half-created ticket behind.
   */
  onCollect?: (draft: CouponRequestDraft) => void;
}

export function CouponRequestDialog({
  open,
  onClose,
  ticketId,
  contactId,
  customerPhone,
  description,
  brandId,
  restaurantId,
  requestedBy,
  onCreated,
  onCollect,
}: CouponRequestDialogProps) {
  const { t } = useTranslation();
  const lists = useOptionLists();
  const create = useRequestCouponApproval();

  // Today, and a month out. Computed once per opening so the dates do not shift
  // under the agent while they are filling the form in.
  const dates = useMemo(() => defaultCouponDates(new Date()), [open]);

  const [draft, setDraft] = useState<CouponRequestDraft>(() => ({
    title: customerPhone ?? '',
    code: generateCouponCode(),
    issuing_side: '',
    delivery_type: '',
    coupon_type: 'Private',
    discount_category: 'Amount',
    valid_from: dates.valid_from,
    valid_to: dates.valid_to,
    coupon_value: 0,
    coupon_percent: null,
    max_discount: 0,
    usage_limit: 1,
    compensation_reason: description ?? '',
    brand_id: brandId,
    restaurant_id: restaurantId,
  }));

  const set = <K extends keyof CouponRequestDraft>(key: K, value: CouponRequestDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  /**
   * Seed the form from the ticket each time it opens.
   *
   * The state above only runs its initialiser on the first render, and on the
   * add-ticket page this dialog is mounted from the moment the page is — long
   * before the agent has typed the complaint. So the reason, the phone and the
   * branch were captured while all of them were still empty, and the agent was
   * asked to type the complaint out a second time.
   *
   * Only on the opening edge, so nothing the agent has typed in here is
   * overwritten while they are working.
   */
  useEffect(() => {
    if (!open) return;
    setDraft((d) => ({
      ...d,
      title: d.title || (customerPhone ?? ''),
      compensation_reason: d.compensation_reason || (description ?? ''),
      brand_id: d.brand_id ?? brandId,
      restaurant_id: d.restaurant_id ?? restaurantId,
    }));
    // Deliberately the opening edge only — see above.
  }, [open]);

  const parsed = CouponRequestDraftChecked.safeParse(draft);
  /** The first thing wrong, named — not "check the highlighted fields". */
  const blockedReason = parsed.success ? '' : (parsed.error.issues[0]?.message ?? '');

  const submit = () => {
    if (!parsed.success) return;
    const d = parsed.data;
    if (onCollect) {
      // No ticket to attach to yet — hand it back and let the caller raise it.
      onCollect(d);
      onClose();
      return;
    }
    create
      .mutateAsync({
        ticket: ticketId,
        contact: contactId,
        requested_by: requestedBy,
        // The supervisor reads this, so it is the agent's own words.
        reason: d.compensation_reason,
        // Requesting a coupon IS the compensation decision, so the flag follows
        // from the request rather than being asked again.
        compensation: compensationFlag(true),
        coupon_code: d.code,
        // Which of the two money fields carries the number depends on the
        // category, and only one of them is ever set.
        // As entered, not derived from the cap: they answer different questions.
        coupon_value: d.discount_category === 'Percentage' ? null : (d.coupon_value ?? null),
        coupon_percent: d.discount_category === 'Percentage' ? (d.coupon_percent ?? null) : null,
        title: d.title,
        issuing_side: d.issuing_side,
        delivery_type: d.delivery_type,
        coupon_type: d.coupon_type,
        discount_category: d.discount_category,
        valid_from: d.valid_from,
        valid_to: d.valid_to,
        max_discount: d.max_discount,
        usage_limit: d.usage_limit,
        brand_id: d.brand_id ?? null,
        restaurant_id: d.restaurant_id ?? null,
      })
      .then(() => {
        toast.success(
          t('coupons.requested', {
            defaultValue: 'Sent for approval. It reaches the customer once a supervisor approves.',
          }),
        );
        onCreated?.();
        onClose();
      })
      .catch(() =>
        toast.error(t('coupons.requestFailed', { defaultValue: 'Could not send that request.' })),
      );
  };

  const setIssuingSide = (v: string) =>
    setDraft((d) => ({
      ...d,
      issuing_side: v,
      // The code carries the issuing side, so changing one re-stamps the other.
      code: generateCouponCode(Math.random, couponPrefix(v)),
    }));

  const sel = (key: keyof CouponRequestDraft, list: string, label: string) => (
    <SelectMenu
      fullWidth
      value={String(draft[key] ?? '')}
      onChange={(v) => set(key, v as never)}
      options={optionsFor(lists.data, list, String(draft[key] ?? '')).map((v) => ({
        value: v,
        label: v,
      }))}
      aria-label={label}
    />
  );

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="md"
      title={t('coupons.requestTitle', { defaultValue: 'Request a coupon' })}
      description={t('coupons.requestHint', {
        defaultValue:
          'A supervisor approves this before anything reaches the customer. The branch comes from the order on this ticket.',
      })}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          {blockedReason && (
            <span className="me-auto text-2xs text-muted-foreground">{blockedReason}</span>
          )}
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('actions.cancel', { ns: 'common' })}
          </Button>
          <Button
            type="button"
            loading={create.isPending}
            disabled={!parsed.success}
            onClick={submit}
          >
            {onCollect
              ? t('coupons.attach', { defaultValue: 'Attach to this ticket' })
              : t('coupons.send', { defaultValue: 'Send for approval' })}
          </Button>
        </div>
      }
    >
      <DrawerSection title={t('coupons.theCoupon', { defaultValue: 'The coupon' })}>
        <FormField label={t('coupons.titleField', { defaultValue: 'Coupon title' })}>
          <Input
            value={draft.title}
            onChange={(e) => set('title', e.target.value)}
            placeholder={t('coupons.titlePlaceholder', { defaultValue: "The customer's phone" })}
          />
        </FormField>
        <FormField
          label={t('coupons.code', { defaultValue: 'Coupon code' })}
          hint={t('coupons.codeHint', {
            defaultValue: 'Generated, and readable down a phone line. Regenerate if you prefer.',
          })}
        >
          <div className="flex gap-2">
            <Input
              value={draft.code}
              readOnly
              aria-label={t('coupons.code', { defaultValue: 'Coupon code' })}
              className="flex-1 font-mono"
            />
            <Button
              type="button"
              variant="secondary"
              onClick={() => set('code', generateCouponCode())}
            >
              {t('coupons.regenerate', { defaultValue: 'New code' })}
            </Button>
          </div>
        </FormField>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label={t('lists.issuingSide', { defaultValue: 'Issuing side' })}>
            <SelectMenu
              fullWidth
              value={draft.issuing_side}
              onChange={setIssuingSide}
              options={optionsFor(lists.data, 'issuing_side', draft.issuing_side).map((v) => ({
                value: v,
                label: v,
              }))}
              aria-label={t('lists.issuingSide', { defaultValue: 'Issuing side' })}
            />
          </FormField>
          <FormField label={t('lists.deliveryType', { defaultValue: 'Delivery type' })}>
            {sel(
              'delivery_type',
              'delivery_type',
              t('lists.deliveryType', { defaultValue: 'Delivery type' }),
            )}
          </FormField>
          <FormField
            label={t('lists.couponType', { defaultValue: 'Coupon type' })}
            hint={t('coupons.typeHint', {
              defaultValue: 'Private is one customer; public is a campaign.',
            })}
          >
            {sel(
              'coupon_type',
              'coupon_type',
              t('lists.couponType', { defaultValue: 'Coupon type' }),
            )}
          </FormField>
          <FormField label={t('lists.discountCategory', { defaultValue: 'Discount category' })}>
            {sel(
              'discount_category',
              'discount_category',
              t('lists.discountCategory', { defaultValue: 'Discount category' }),
            )}
          </FormField>
        </div>
      </DrawerSection>

      <DrawerSection
        title={t('coupons.whenAndHowMuch', { defaultValue: 'When, and how much' })}
        description={t('coupons.datesHint', {
          defaultValue:
            'Whole days: a coupon is live from the start of the first day to the end of the last.',
        })}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label={t('performance.from', { defaultValue: 'From' })}>
            <Input
              type="date"
              value={draft.valid_from}
              onChange={(e) => set('valid_from', e.target.value)}
            />
          </FormField>
          <FormField label={t('performance.to', { defaultValue: 'To' })}>
            <Input
              type="date"
              value={draft.valid_to}
              onChange={(e) => set('valid_to', e.target.value)}
            />
          </FormField>
          {draft.discount_category === 'Percentage' ? (
            <FormField
              label={t('coupons.couponPercent', { defaultValue: 'Coupon percentage %' })}
              hint={t('coupons.couponPercentHint', { defaultValue: 'How much comes off, as a %.' })}
            >
              <Input
                type="number"
                min={0}
                max={100}
                step="1"
                value={String(draft.coupon_percent ?? '')}
                onChange={(e) =>
                  set('coupon_percent', e.target.value === '' ? null : Number(e.target.value))
                }
              />
            </FormField>
          ) : (
            <FormField
              label={t('coupons.couponValue', { defaultValue: 'Coupon value (SAR)' })}
              hint={t('coupons.couponValueHint', { defaultValue: 'The flat amount off.' })}
            >
              <Input
                type="number"
                min={0}
                step="0.01"
                value={String(draft.coupon_value ?? '')}
                onChange={(e) =>
                  set('coupon_value', e.target.value === '' ? null : Number(e.target.value))
                }
              />
            </FormField>
          )}
          <FormField
            label={t('coupons.maxDiscount', { defaultValue: 'Maximum discount' })}
            hint={t('coupons.maxDiscountHint', {
              defaultValue: 'The most this coupon can ever be worth.',
            })}
          >
            <Input
              type="number"
              min={0}
              step="0.01"
              value={String(draft.max_discount)}
              onChange={(e) => set('max_discount', Number(e.target.value))}
            />
          </FormField>
          <FormField
            label={t('coupons.usageLimit', { defaultValue: 'Number of uses' })}
            hint={t('coupons.usageLimitHint', {
              defaultValue: 'How many times it may be redeemed.',
            })}
          >
            <Input
              type="number"
              min={1}
              step="1"
              value={String(draft.usage_limit)}
              onChange={(e) => set('usage_limit', Number(e.target.value))}
            />
          </FormField>
        </div>
      </DrawerSection>

      <DrawerSection
        title={t('coupons.why', { defaultValue: 'Why' })}
        description={t('coupons.whyHint', {
          defaultValue: 'Carried over from the complaint. This is what the supervisor reads.',
        })}
      >
        <FormField label={t('tickets.description', { defaultValue: 'Compensation reason' })}>
          <Input
            value={draft.compensation_reason}
            onChange={(e) => set('compensation_reason', e.target.value)}
          />
        </FormField>
      </DrawerSection>
    </Drawer>
  );
}
