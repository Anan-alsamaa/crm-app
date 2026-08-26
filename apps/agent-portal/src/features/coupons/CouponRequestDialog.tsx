import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  DateField,
  Drawer,
  DrawerSection,
  FormField,
  Input,
  SelectMenu,
  toast,
} from '@yiji/ui';
import {
  compensationFlag,
  couponPrefix,
  CouponRequestDraftChecked,
  defaultCouponDates,
  generateCouponCode,
  isPercentageCategory,
  isHighValueCoupon,
  COUPON_ALERT_THRESHOLD_SAR,
  parseDeliveryTypes,
  toggleDeliveryType,
  type CouponRequestDraft,
} from '@yiji/shared-types';
import { optionsFor, useOptionLists } from '../tickets/option-lists.js';
import { useCouponCodeTaken, useRequestCouponApproval } from './api.js';

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
  /** Display names for the resolved brand/branch, shown read-only. */
  brandName?: string | null;
  branchName?: string | null;
  /**
   * The order's line-item names, offered for the optional Item field so a
   * coupon can name the specific item it compensates (e.g. the missing one).
   */
  /**
   * The order's lines. Carries the PRICE as well as the name so that choosing
   * an item can fill the coupon value with what that item actually cost.
   */
  /* `sku` rides along so a PICKED item records Yiji's id, not just its name —
     see `item_sku` in the draft for why a name cannot be the key. */
  orderItems?: Array<{ name: string; price?: number | null; sku?: string | null }>;
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
  brandName,
  branchName,
  orderItems,
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
    // Every channel by default: a compensation coupon is nearly always meant
    // to work however the customer next orders, and an agent who wanted it
    // narrower can still narrow it.
    delivery_type: 'All',
    coupon_type: 'Private',
    discount_category: 'Amount',
    valid_from: dates.valid_from,
    valid_to: dates.valid_to,
    coupon_value: null,
    coupon_percent: null,
    max_discount: 0,
    usage_limit: 1,
    compensation_reason: description ?? '',
    brand_id: brandId,
    restaurant_id: restaurantId,
    item_name: null,
    item_sku: null,
  }));
  /**
   * Whether the agent has typed into the reason themselves. Until they do, the
   * field keeps FOLLOWING the ticket's description — the common flow is to open
   * this dialog first and write the complaint after, and a reason captured on
   * the opening edge alone stays empty forever in that order of events.
   */
  const [reasonTouched, setReasonTouched] = useState(false);

  /**
   * One setter, because three of these fields move together.
   *
   * For a flat AMOUNT the ceiling IS the amount, so writing the value writes
   * the cap and the two can never disagree. Switching category clears the money
   * field that no longer applies: carrying the number across would silently
   * turn "50 SAR off" into "50% off", which is a different promise to the
   * customer and a much more expensive one.
   *
   * This lives in the setter rather than an effect so the draft is never
   * briefly inconsistent — the validator reads it on every render.
   */
  /*
   * A duplicate code is not cosmetic. The coupon push sends it to Yiji as the
   * `idempotency-key`, so a second request carrying an existing code reads as a
   * RETRY of the first and silently delivers nothing.
   */
  const { data: codeTaken = false } = useCouponCodeTaken(draft.code);

  // Same function the Directus hook mirrors, so the notice and the alert agree
  // on what "high value" means — see COUPON_ALERT_THRESHOLD_SAR.
  const highValue = isHighValueCoupon(draft);

  /* Whether the agent has typed in the code field. Guards the automatic
     re-stamp in `setIssuingSide` — see the note there. */
  const [codeTouched, setCodeTouched] = useState(false);

  const set = <K extends keyof CouponRequestDraft>(key: K, value: CouponRequestDraft[K]) =>
    setDraft((d) => {
      const next = { ...d, [key]: value } as CouponRequestDraft;
      if (key === 'discount_category') {
        if (isPercentageCategory(next.discount_category)) next.coupon_value = null;
        else next.coupon_percent = null;
      }
      if (!isPercentageCategory(next.discount_category)) {
        next.max_discount = next.coupon_value ?? 0;
      }
      return next;
    });

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
   * overwritten while they are working. The brand/branch are the exception:
   * they are not editable here, so they always take the form's CURRENT choice —
   * an agent who changed the branch after a first look must not attach the
   * coupon to the branch they moved away from.
   */
  useEffect(() => {
    if (!open) return;
    setDraft((d) => ({
      ...d,
      title: d.title || (customerPhone ?? ''),
      compensation_reason: reasonTouched ? d.compensation_reason : (description ?? ''),
      brand_id: brandId,
      restaurant_id: restaurantId,
    }));
    // Deliberately the opening edge only — see above.
  }, [open]);

  /**
   * While the dialog is OPEN and the reason untouched, keep it in step with the
   * description being typed on the ticket form behind it. The moment the agent
   * edits the reason here, their words win and the following stops.
   */
  useEffect(() => {
    if (!open || reasonTouched) return;
    setDraft((d) =>
      d.compensation_reason === (description ?? '')
        ? d
        : { ...d, compensation_reason: description ?? '' },
    );
  }, [open, reasonTouched, description]);

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
        item_name: d.item_name ?? null,
        item_sku: d.item_sku ?? null,
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

  /**
   * The code is auto-generated but hand-editable, and this is where those two
   * meet.
   *
   * The code carries the issuing side as a prefix, so changing the side used to
   * re-stamp the code unconditionally. That was safe while the field was
   * read-only and is data loss now: an agent who typed the code a branch had
   * already printed, then corrected the issuing side, watched their code
   * silently vanish — with no way to get it back, because it was never theirs
   * to begin with.
   *
   * So: re-stamp only a code this dialog itself generated and the agent has not
   * touched. `codeTouched` is set by the input's own onChange, which fires for
   * typing and pasting but not for the two programmatic writes here and in the
   * regenerate button.
   */
  const setIssuingSide = (v: string) =>
    setDraft((d) => ({
      ...d,
      issuing_side: v,
      code: codeTouched ? d.code : generateCouponCode(Math.random, couponPrefix(v)),
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
            /* A taken code blocks the send outright. Letting it through would
               hand Yiji a duplicate idempotency-key and deliver nothing. */
            disabled={!parsed.success || codeTaken}
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
            defaultValue: 'Generated, and readable down a phone line. Type your own or regenerate.',
          })}
          error={
            codeTaken
              ? t('coupons.codeTaken', {
                  defaultValue: 'That code is already in use. Pick another.',
                })
              : undefined
          }
        >
          <div className="flex gap-2">
            {/* Typed, not just generated — agents reuse a code a branch already
                printed, or match one from the ops sheet. Upper-cased as they
                type because every stored code is, and a lower-case twin would
                pass the duplicate check and then collide anyway. */}
            <Input
              value={draft.code}
              invalid={codeTaken}
              onChange={(e) => {
                setCodeTouched(true);
                set('code', e.target.value.toUpperCase().replace(/\s+/g, ''));
              }}
              aria-label={t('coupons.code', { defaultValue: 'Coupon code' })}
              className="flex-1 font-mono"
            />
            <Button
              type="button"
              variant="secondary"
              // The prefix belongs to the issuing side, so a REGENERATED code
              // has to carry it too. Without this the button handed back a
              // SARA- code on an Operations coupon, and the prefix is how
              // anyone reading a code aloud knows who issued it.
              onClick={() => {
                // Explicitly asking for a new code hands the field back to the
                // generator, so the issuing side re-stamps it again after this.
                setCodeTouched(false);
                set('code', generateCouponCode(Math.random, couponPrefix(draft.issuing_side)));
              }}
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
          <FormField
            label={t('lists.deliveryType', { defaultValue: 'Delivery types' })}
            hint={t('coupons.deliveryTypesHint', {
              defaultValue: 'Pick every channel this coupon works on. "All" covers all of them.',
            })}
          >
            {/* Multi-select as toggle pills: a coupon can be valid on several
                channels at once, and "All" is shorthand for every one of them —
                so it never combines with a specific pick. */}
            <div
              role="group"
              aria-label={t('lists.deliveryType', { defaultValue: 'Delivery types' })}
              className="flex flex-wrap gap-1.5"
            >
              {optionsFor(lists.data, 'delivery_type').map((v) => {
                const selected = parseDeliveryTypes(draft.delivery_type).includes(v);
                return (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={selected}
                    onClick={() =>
                      set(
                        'delivery_type',
                        toggleDeliveryType(
                          draft.delivery_type,
                          v,
                          optionsFor(lists.data, 'delivery_type'),
                        ),
                      )
                    }
                    className={
                      selected
                        ? 'rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors duration-fast ease-out'
                        : 'rounded-full bg-secondary px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors duration-fast ease-out hover:text-foreground'
                    }
                  >
                    {v}
                  </button>
                );
              })}
            </div>
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
        <FormField
          label={t('coupons.itemField', { defaultValue: 'Item (optional)' })}
          hint={
            orderItems && orderItems.length > 0
              ? t('coupons.itemHint', {
                  defaultValue:
                    'The order item this compensates — e.g. the one that was missing or wrong.',
                })
              : t('coupons.itemHintManual', {
                  defaultValue:
                    'No order attached, so type the item — e.g. the one that was missing or wrong.',
                })
          }
        >
          {orderItems && orderItems.length > 0 ? (
            // From the inbox the order is known, so the item is a CHOICE from
            // its lines — a picked name always matches what was actually
            // ordered.
            <SelectMenu
              fullWidth
              value={draft.item_name ?? ''}
              onChange={(v) => {
                const picked = orderItems?.find((it) => it.name === v);
                set('item_name', v || null);
                // The id travels with the name. Cleared alongside it, so
                // "not about one item" cannot leave a stale sku behind.
                set('item_sku', (v && picked?.sku) || null);
                // Compensating for one item means compensating what that item
                // cost, so the amount follows the choice. It stays editable —
                // this is the agent's starting point, not the answer, and a
                // supervisor can still amend it on the way through.
                const price = picked?.price;
                if (v && typeof price === 'number' && price > 0) set('coupon_value', price);
              }}
              options={[
                {
                  value: '',
                  label: t('coupons.itemNone', { defaultValue: 'Not about one item' }),
                },
                // De-duplicated: an order with 2× the same line offers it once.
                ...Array.from(new Map(orderItems.map((it) => [it.name, it])).values()).map(
                  (it) => ({
                    value: it.name,
                    label:
                      typeof it.price === 'number' && it.price > 0
                        ? `${it.name} · ${it.price}`
                        : it.name,
                  }),
                ),
              ]}
              aria-label={t('coupons.itemField', { defaultValue: 'Item (optional)' })}
            />
          ) : (
            // A manually raised ticket has no order to choose from — the agent
            // heard the item down a phone line, so they type it.
            <Input
              value={draft.item_name ?? ''}
              onChange={(e) => {
                set('item_name', e.target.value || null);
                /* No order to pick from, so there is no id — and a typed name
                   must never inherit one from a previous pick. */
                set('item_sku', null);
              }}
              placeholder={t('coupons.itemPlaceholder', {
                defaultValue: 'e.g. Vegetable Pasta',
              })}
              aria-label={t('coupons.itemField', { defaultValue: 'Item (optional)' })}
            />
          )}
        </FormField>
        {(brandName || branchName) && (
          // Where this coupon lands, said rather than assumed: the branch is
          // resolved from the ticket's order/branch choice and not editable here.
          <p className="rounded-lg bg-secondary/50 px-3 py-2 text-xs text-muted-foreground">
            {t('coupons.branchContext', { defaultValue: 'For' })}{' '}
            <span className="font-medium text-foreground">
              {[brandName, branchName].filter(Boolean).join(' · ')}
            </span>
          </p>
        )}
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
            <DateField value={draft.valid_from} onChange={(v) => set('valid_from', v)} />
          </FormField>
          <FormField label={t('performance.to', { defaultValue: 'To' })}>
            <DateField value={draft.valid_to} onChange={(v) => set('valid_to', v)} />
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
          {/* ALWAYS SHOWN — it is the number the supervisor approves against and
              the ceiling the customer is held to, so a coupon that does not
              display one reads as uncapped.

              Only EDITABLE for a percentage, though. For a flat amount the most
              it can ever be worth IS the amount, and asking twice invites the
              two to disagree — which they did: an amount of 568 was approved
              with a cap of 55, and whichever number that customer was promised,
              one of them was a lie. So for an amount it tracks the value
              instead, visible and locked rather than hidden. */}
          <FormField
            label={t('coupons.maxDiscount', { defaultValue: 'Maximum discount' })}
            hint={
              isPercentageCategory(draft.discount_category)
                ? t('coupons.maxDiscountHint', {
                    defaultValue: 'The most this coupon can ever be worth.',
                  })
                : t('coupons.maxDiscountFixedHint', {
                    defaultValue:
                      'A flat amount is its own ceiling, so this follows the coupon value.',
                  })
            }
          >
            <Input
              type="number"
              min={0}
              step="0.01"
              readOnly={!isPercentageCategory(draft.discount_category)}
              aria-readonly={!isPercentageCategory(draft.discount_category)}
              className={
                isPercentageCategory(draft.discount_category)
                  ? undefined
                  : 'bg-secondary/60 text-muted-foreground'
              }
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
        {/* Said BEFORE sending, not discovered afterwards.
            The alert fires server-side either way (a Directus hook — the agent
            portal cannot be the enforcement point when the row is written
            straight from the browser). This is only so the agent is not
            surprised to hear an admin was paged about their coupon. It is not a
            block: large compensations are legitimate, they just get watched. */}
        {highValue && (
          <p className="mt-3 flex items-start gap-2 rounded-xl bg-warning/10 px-3 py-2 text-2xs leading-relaxed text-warning-foreground ring-1 ring-inset ring-warning/25">
            <span aria-hidden>!</span>
            <span>
              {t('coupons.highValueNotice', {
                threshold: COUPON_ALERT_THRESHOLD_SAR,
                defaultValue: `Above SAR ${COUPON_ALERT_THRESHOLD_SAR}, so an admin is alerted as soon as this is sent. It still goes through the normal approval.`,
              })}
            </span>
          </p>
        )}
      </DrawerSection>

      <DrawerSection
        title={t('coupons.why', { defaultValue: 'Why' })}
        description={t('coupons.whyHint', {
          defaultValue: 'Carried over from the ticket. This is what the supervisor reads.',
        })}
      >
        <FormField label={t('tickets.description', { defaultValue: 'Compensation reason' })}>
          <Input
            value={draft.compensation_reason}
            onChange={(e) => {
              // The agent's own words now own this field — stop following the
              // ticket description.
              setReasonTouched(true);
              set('compensation_reason', e.target.value);
            }}
          />
        </FormField>
      </DrawerSection>
    </Drawer>
  );
}
