import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, cn, FormField, Textarea } from '@yiji/ui';
import { couponCountsAsCompensation } from '@yiji/shared-types';
import type { CouponRequestRow } from '../coupons/api.js';
import { CouponRequestDialog } from '../coupons/CouponRequestDialog.js';
import type { TicketRow } from './api.js';
import { customerPhone } from './api.js';
import type { StoreRow } from './useStoreMatch.js';

/**
 * A TICKET'S COMPENSATION FOLLOWS ITS COUPON (owner, 2026-10-21, EMA-80).
 *
 * For whoever holds `manage_ticket_compensation` (WeCare Admin / Supervisor by
 * default) the Compensation field is no longer a free choice:
 *
 *   - a coupon linked to the ticket (not rejected, not removed) means
 *     "Compensated", and choosing "Not Compensated" REMOVES it - the record is
 *     kept, and the workers take it off the customer's Yiji app;
 *   - with no coupon, "Compensated" cannot be chosen - "Assign a coupon" is
 *     offered instead, which raises a request for THIS ticket.
 *
 * Everyone else keeps the field exactly as it was.
 */

export const COMPENSATED = 'Compensated';
export const NOT_COMPENSATED = 'Not Compensated';

export interface TicketCompensationState {
  /** Coupons that make the ticket "Compensated". */
  active: CouponRequestRow[];
  /** Active coupons that "Not Compensated" can still take back. */
  removable: CouponRequestRow[];
  /** Active coupons the customer already spent - kept whatever is chosen. */
  used: CouponRequestRow[];
  /** What the field shows. */
  value: string;
  /** May the field say "Compensated" at all? */
  compensatedAllowed: boolean;
}

/**
 * What the Compensation field must say, from the ticket's coupons.
 *
 * A ticket with NO coupon rows at all keeps its stored value: those are tickets
 * compensated before coupon requests existed (or imported), and calling them
 * "Not Compensated" would be the same lie in the other direction.
 */
export function ticketCompensationState(
  coupons: readonly CouponRequestRow[],
  stored: string | null | undefined,
): TicketCompensationState {
  const active = coupons.filter(couponCountsAsCompensation);
  const used = active.filter((c) => c.removal_status === 'used');
  const removable = active.filter(
    (c) => c.removal_status !== 'used' && c.removal_status !== 'pending',
  );
  const legacy = coupons.length === 0;
  const storedValue = (stored ?? '').trim();
  return {
    active,
    removable,
    used,
    value: active.length > 0 ? COMPENSATED : legacy ? storedValue : NOT_COMPENSATED,
    compensatedAllowed: active.length > 0 || (legacy && storedValue === COMPENSATED),
  };
}

/** True when saving this draft must take the ticket's coupons back. */
export function wantsCouponRemoval(state: TicketCompensationState, draftValue: string): boolean {
  return state.removable.length > 0 && draftValue.trim() !== COMPENSATED;
}

const couponLabel = (c: CouponRequestRow): string =>
  `${c.coupon_code ?? '—'} (${c.coupon_percent != null ? `${c.coupon_percent}%` : `${c.coupon_value ?? 0} SAR`})`;

/**
 * The Compensation control in the ticket's Edit form, for managers.
 *
 * Two buttons rather than a dropdown: there are only two honest answers, and
 * "Compensated" with no coupon is not one of them - the button says so and
 * points at "Assign a coupon" instead of silently accepting it.
 */
export function TicketCompensationField({
  state,
  value,
  onChange,
  reason,
  onReasonChange,
  onAssign,
  blocked,
  onBlocked,
}: {
  state: TicketCompensationState;
  value: string;
  onChange: (value: string) => void;
  reason: string;
  onReasonChange: (reason: string) => void;
  onAssign: () => void;
  /** Shown after somebody tried "Compensated" with no coupon. */
  blocked: boolean;
  onBlocked: (blocked: boolean) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const removing = wantsCouponRemoval(state, value);
  const allUsed = state.active.length > 0 && state.removable.length === 0 && state.used.length > 0;
  const pick = (next: string) => {
    if (next === COMPENSATED && !state.compensatedAllowed) {
      onBlocked(true);
      return;
    }
    onBlocked(false);
    onChange(next);
  };
  const options: Array<[string, string]> = [
    [COMPENSATED, t('complaint.compensated', { defaultValue: 'Compensated' })],
    [NOT_COMPENSATED, t('complaint.notCompensated', { defaultValue: 'Not Compensated' })],
  ];

  return (
    <div className="space-y-3">
      <FormField label={t('complaint.compensation', { defaultValue: 'Compensation' })}>
        <div
          role="radiogroup"
          aria-label={t('complaint.compensation', { defaultValue: 'Compensation' })}
          className="flex flex-wrap items-center gap-2"
        >
          {options.map(([v, label]) => {
            const checked = value.trim() === v;
            const disabled = v === NOT_COMPENSATED && allUsed;
            return (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={checked}
                disabled={disabled}
                onClick={() => pick(v)}
                className={cn(
                  'rounded-full px-3.5 py-1.5 text-xs font-semibold ring-1 ring-inset transition-colors duration-fast ease-out disabled:cursor-not-allowed disabled:opacity-50',
                  checked
                    ? 'bg-primary text-primary-foreground ring-primary'
                    : 'bg-card text-foreground ring-border-strong hover:bg-secondary',
                )}
              >
                {label}
              </button>
            );
          })}
          <Button type="button" size="sm" variant="ghost" onClick={onAssign}>
            {t('complaint.assignCoupon', { defaultValue: 'Assign a coupon' })}
          </Button>
        </div>
      </FormField>

      {blocked && (
        <p role="alert" className="rounded-xl bg-warning/10 px-3 py-2 text-xs text-foreground">
          {t('complaint.compensatedNeedsCoupon', {
            defaultValue:
              'A ticket is Compensated only when a coupon is linked to it. Use “Assign a coupon” to raise one for this ticket.',
          })}
        </p>
      )}

      {allUsed && (
        <p className="rounded-xl bg-secondary/60 px-3 py-2 text-xs text-foreground">
          {t('complaint.couponAlreadyUsed', {
            defaultValue:
              'The customer already used this coupon on an order, so it cannot be removed. The ticket stays Compensated.',
          })}
        </p>
      )}

      {removing && (
        <div className="space-y-2 rounded-xl bg-destructive/[0.08] px-3 py-2.5">
          <p role="alert" className="text-xs leading-relaxed text-foreground">
            {t('complaint.removeCouponWarning', {
              defaultValue:
                'Saving removes {{coupons}} from this ticket. If it is already in the customer’s Yiji app it is taken out of it, so the customer no longer sees it. A coupon the customer already used cannot be removed.',
              coupons: state.removable.map(couponLabel).join(', '),
            })}
          </p>
          <FormField
            label={t('complaint.removeCouponReason', {
              defaultValue: 'Why is the coupon being removed?',
            })}
          >
            <Textarea
              rows={2}
              dir="auto"
              value={reason}
              onChange={(e) => onReasonChange(e.target.value)}
            />
          </FormField>
        </div>
      )}
    </div>
  );
}

/**
 * "Assign a coupon" for THIS ticket: the same dialog and approval flow as the
 * Add-ticket form, prefilled from the ticket (customer, phone, brand, branch,
 * order lines) the way CreateTicketDialog prefills it.
 */
export function AssignTicketCouponDialog({
  open,
  onClose,
  ticket,
  branch,
  requestedBy,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  ticket: TicketRow;
  branch: StoreRow | null;
  requestedBy: string | null;
  onCreated: () => void;
}): JSX.Element | null {
  if (!open) return null;
  const order = ticket.order_snapshot ?? null;
  return (
    <CouponRequestDialog
      open={open}
      onClose={onClose}
      ticketId={ticket.id}
      contactId={ticket.contact?.id ?? null}
      customerPhone={customerPhone(ticket)}
      description={ticket.description ?? null}
      // YIJI's identifiers, as CreateTicketDialog sends them.
      brandId={
        branch?.brand?.yiji_brand_name?.trim() || branch?.brand?.name || order?.brandName || null
      }
      restaurantId={branch?.yiji_restaurant_id || order?.restaurantId || null}
      brandName={branch?.brand?.name ?? order?.brandName ?? null}
      branchName={branch?.name ?? order?.restaurantName ?? null}
      orderItems={(order?.items ?? []).map((it) => ({
        name: it.name,
        price: it.price ?? null,
        qty: it.qty ?? null,
        sku: it.sku ?? null,
      }))}
      requestedBy={requestedBy}
      onCreated={onCreated}
    />
  );
}

/** One line on a removed (or not removable) coupon, for the coupon list. */
export function removalTone(
  status: string | null | undefined,
): 'neutral' | 'warning' | 'destructive' | 'highlight' | null {
  switch (status) {
    case 'removed':
    case 'not_on_yiji':
      return 'neutral';
    case 'used':
      return 'warning';
    case 'failed':
      return 'destructive';
    case 'pending':
      return 'highlight';
    default:
      return null;
  }
}
