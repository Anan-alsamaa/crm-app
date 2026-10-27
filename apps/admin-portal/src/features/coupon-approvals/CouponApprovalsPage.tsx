import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  ConfirmDialog,
  ChevronDownIcon,
  cn,
  DateField,
  EmptyState,
  formatDateTime,
  InboxIcon,
  InfoIcon,
  Input,
  Pill,
  Skeleton,
  SparkleIcon,
  toast,
} from '@yiji/ui';
import {
  isRestaurantOrderNumber,
  COUPON_APPROVAL_STATUSES,
  couponTermsProblems,
  isPercentageCategory,
  type CouponApprovalStatus,
  couponDecision,
  displayContactName,
  normalizePhone,
  type StoreIndex,
  normalizeOrderId,
  couponEditBlock,
  couponIsExpired,
  defaultCouponDates,
  replacementTermsProblem,
  type CouponReplacementTerms,
} from '@yiji/shared-types';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { FIELD_LABEL, FILTER_CARD, PAGE_BODY, PageHeader } from '../../components/shell/Page.js';
import { businessDayWindow } from '../../lib/date-range.js';
import { ClearFiltersButton } from '../../components/ClearFiltersButton.js';
import { SearchField } from '../../components/SearchField.js';
import { useStoreIndex } from '../restaurants/api.js';
import {
  useCouponApprovals,
  useDecideCoupon,
  useRetryCouponDelivery,
  useSaveCouponTerms,
  type CouponApprovalRow,
} from './api.js';
import { correctionOf, useCorrectionStamps, type CorrectionStamp } from './correction-stamps.js';
import {
  useCouponReplacements,
  useReplaceCoupon,
  type CouponReplacementLink,
} from './replacements.js';

/**
 * The supervisor's queue: every coupon an agent wants to give away, decided one
 * after another.
 *
 * Built to be worked at speed, because that is what it is for — a supervisor
 * sits here and clears the list. So: opens on pending, one row per request with
 * everything needed to decide already on it, and Approve is a single click. No
 * drawer, no confirmation dialog, no navigating to the ticket and back.
 *
 * REJECTING asks for a reason, and will not proceed without one. An agent told
 * only "no" cannot answer the customer who is still waiting, and "no" with no
 * reason is the fastest way to make a control like this resented.
 */
// Wider than CouponApprovalStatus on purpose: the push worker moves a row to
// `assigned` once Yiji has it, and that state still has to render.
/* Every state in COUPON_APPROVAL_STATUSES, so none falls through to a default
 * that would paint a rejection like an approval. `edited` is an approval on
 * amended terms; `assigned` is an approval Yiji has taken. */
const TONE: Record<string, 'warning' | 'success' | 'destructive' | 'highlight'> = {
  pending: 'highlight',
  approved: 'success',
  edited: 'success',
  assigned: 'success',
  rejected: 'destructive',
};

function money(n: number | null, currency = 'SAR'): string | null {
  if (n == null) return null;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(n);
  } catch {
    return `${n} ${currency}`;
  }
}

/** One labelled input in the amend form. */
function EditField({
  label,
  value,
  onChange,
  type = 'text',
  hint,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: 'text' | 'number' | 'date';
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className="block space-y-1">
      <span className="block text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </span>
      {/* Dates get the dd/mm/yyyy field rather than the native control, which
          Chrome renders in its own locale regardless of what the page asks
          for. Same ISO value either way, so nothing downstream changes. */}
      {type === 'date' ? (
        <DateField value={value} onChange={onChange} aria-label={label} />
      ) : (
        <Input
          type={type}
          {...(type === 'number' ? { min: 0, step: '0.01' } : {})}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
          disabled={disabled}
        />
      )}
      {hint && <span className="block text-2xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

/**
 * The card's detail grids: two columns on a phone, four on a laptop, six on a
 * wide screen. Long values (customer, branch, ticket, validity, delivery
 * types) span two cells rather than truncating to nothing.
 */
const TILE_GRID = 'mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-6';

/** One term as a compact label-over-value tile. */
function Term({
  label,
  value,
  mono,
  className,
}: {
  label: string;
  value: React.ReactNode;
  /** For values read aloud character by character — a coupon code. */
  mono?: boolean;
  className?: string;
}) {
  const shown = value == null || value === '' ? '—' : value;
  return (
    <div
      className={cn(
        'min-w-0 rounded-xl bg-secondary/40 px-3 py-2 ring-1 ring-inset ring-foreground/[0.05]',
        className,
      )}
    >
      <dt className="truncate text-2xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        {label}
      </dt>
      <dd
        dir="auto"
        title={typeof shown === 'string' || typeof shown === 'number' ? String(shown) : undefined}
        className={cn('mt-0.5 truncate text-xs font-semibold text-foreground', mono && 'font-mono')}
      >
        {shown}
      </dd>
    </div>
  );
}

function PencilIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('h-3.5 w-3.5 shrink-0', className)}
      aria-hidden
    >
      <path d="M11.5 2.5a1.4 1.4 0 0 1 2 2L6 12l-3 1 1-3 7.5-7.5z" />
    </svg>
  );
}

/** "Corrected by <agent> · <time>" — the agent's own fix to a pending request. */
function CorrectedMark({ who, at, className }: { who: string; at: string; className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-2xs font-medium text-primary',
        className,
      )}
    >
      <PencilIcon className="h-3 w-3" />
      {t('couponApprovals.correctedBy', {
        defaultValue: 'Corrected by {{who}} · {{when}}',
        who,
        when: formatDateTime(at),
      })}
    </span>
  );
}

/** An inline notice: something that changes what approving this means. */
const NOTICE =
  'mt-3 flex items-start gap-2 rounded-xl bg-warning-tint px-3.5 py-2.5 text-xs leading-relaxed text-foreground ring-1 ring-inset ring-warning/25';

/** The full set of terms a supervisor may amend before approving. */
export interface TermEdits {
  /** Editable until the coupon exists on Yiji (owner, 2026-10-11). */
  coupon_code: string;
  /** Reference only - coupons go to the phone, never the order (2026-10-11). */
  order_id: string;
  title: string;
  issuing_side: string;
  delivery_type: string;
  coupon_type: string;
  discount_category: string;
  valid_from: string;
  valid_to: string;
  amount: string;
  max_discount: string;
  usage_limit: string;
  item_name: string;
  reason: string;
}

function seedEdits(row: CouponApprovalRow): TermEdits {
  const pct = (row.discount_category ?? '').toLowerCase() === 'percentage';
  return {
    coupon_code: row.coupon_code ?? '',
    order_id: row.order_id ?? row.ticket?.order_id ?? '',
    title: row.title ?? '',
    issuing_side: row.issuing_side ?? '',
    delivery_type: row.delivery_type ?? '',
    coupon_type: row.coupon_type ?? '',
    discount_category: row.discount_category ?? '',
    valid_from: row.valid_from?.slice(0, 10) ?? '',
    valid_to: row.valid_to?.slice(0, 10) ?? '',
    amount: String((pct ? row.coupon_percent : row.coupon_value) ?? ''),
    max_discount: String(row.max_discount ?? ''),
    usage_limit: String(row.usage_limit ?? ''),
    item_name: row.item_name ?? '',
    reason: row.reason ?? '',
  };
}

/**
 * The amended terms, as a patch of only what actually changed. Empty object =
 * nothing changed, so approving records a straight approval, not an amendment.
 */
function diffEdits(row: CouponApprovalRow, e: TermEdits): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const str = (k: keyof TermEdits, col: string, cur: string | null) => {
    if (e[k].trim() !== (cur ?? '')) out[col] = e[k].trim() || null;
  };
  /* The CODE, as Yiji will see it: upper-case, no spaces. An emptied box
     keeps the old code rather than saving none. */
  const code = e.coupon_code.trim().toUpperCase().replace(/\s+/g, '');
  if (code && code !== (row.coupon_code ?? '')) out.coupon_code = code;
  /* The ORDER NUMBER on the request (the reference shown on the card). */
  const order = e.order_id.trim();
  if (order !== (row.order_id ?? row.ticket?.order_id ?? '')) out.order_id = order || null;
  str('title', 'title', row.title);
  str('issuing_side', 'issuing_side', row.issuing_side);
  str('delivery_type', 'delivery_type', row.delivery_type);
  str('coupon_type', 'coupon_type', row.coupon_type);
  str('discount_category', 'discount_category', row.discount_category);
  str('valid_from', 'valid_from', row.valid_from?.slice(0, 10) ?? null);
  str('valid_to', 'valid_to', row.valid_to?.slice(0, 10) ?? null);
  str('item_name', 'item_name', row.item_name);
  str('reason', 'reason', row.reason);

  // Which money column the amount lands in follows the (possibly amended)
  // category, and the OTHER column is cleared — an amended percentage must
  // never arrive as an amount.
  const category = (out.discount_category as string) ?? row.discount_category ?? '';
  const pct = isPercentageCategory(category);
  const a = Number(e.amount);
  const currentAmount = pct ? row.coupon_percent : row.coupon_value;
  if (
    e.amount.trim() !== '' &&
    Number.isFinite(a) &&
    a > 0 &&
    (a !== (currentAmount ?? null) || 'discount_category' in out)
  ) {
    if (pct) {
      out.coupon_percent = a;
      out.coupon_value = null;
    } else {
      out.coupon_value = a;
      out.coupon_percent = null;
    }
  }
  // Stored as a decimal STRING ("28.00000"), so compare as numbers — a strict
  // compare against the string called every save a cap change.
  const storedCap = row.max_discount == null ? null : Number(row.max_discount);
  if (pct) {
    const cap = Number(e.max_discount);
    if (e.max_discount.trim() !== '' && Number.isFinite(cap) && cap >= 0 && cap !== storedCap) {
      out.max_discount = cap;
    }
  } else {
    // For a flat amount the ceiling IS the amount, always, and is never typed.
    // OPS-SGVAVXW6 (2026-10-07): a supervisor typed 28 into a free "Maximum
    // discount" box on a 56 SAR coupon; the save wrote the cap alone, and the
    // record then failed its own terms check, so Approve stayed disabled. An
    // existing mismatch is repaired by the next save too.
    const value =
      typeof out.coupon_value === 'number' ? out.coupon_value : Number(row.coupon_value ?? NaN);
    if (Number.isFinite(value) && value > 0 && value !== storedCap) {
      out.max_discount = value;
    }
  }
  const u = Number(e.usage_limit);
  if (
    e.usage_limit.trim() !== '' &&
    Number.isInteger(u) &&
    u > 0 &&
    u !== (row.usage_limit ?? null)
  ) {
    out.usage_limit = u;
  }
  return out;
}

/**
 * The edited terms as a whole coupon (owner, 2026-10-27): an approved coupon
 * is edited by REPLACING it, so the replacement carries every term, not a
 * patch. Same money rules as an amendment: one money column by category, and
 * an amount's ceiling is the amount.
 */
export function termsFromEdits(row: CouponApprovalRow, e: TermEdits): CouponReplacementTerms {
  const pct = isPercentageCategory(e.discount_category);
  const amount = e.amount.trim() === '' ? null : Number(e.amount);
  const cap = e.max_discount.trim() === '' ? null : Number(e.max_discount);
  const item = e.item_name.trim();
  return {
    title: e.title.trim(),
    issuing_side: e.issuing_side.trim(),
    delivery_type: e.delivery_type.trim(),
    coupon_type: e.coupon_type.trim(),
    discount_category: e.discount_category.trim(),
    valid_from: e.valid_from,
    valid_to: e.valid_to,
    coupon_value: pct ? null : amount,
    coupon_percent: pct ? amount : null,
    max_discount: pct ? cap : amount,
    usage_limit: Number(e.usage_limit),
    item_name: item || null,
    // The picked item's id only while the item is the one it was picked for.
    item_sku: item && item === (row.item_name ?? '').trim() ? row.item_sku : null,
    no_other_discounts: row.no_other_discounts === true,
    reason: e.reason.trim() || null,
  };
}

/**
 * EDIT AN APPROVED COUPON (owner, 2026-10-27) - the amend form, reused, in
 * REPLACE mode: Save creates a new coupon with these terms and a fresh code,
 * and the workers take the old one out of the customer's Yiji app before the
 * new one is sent. Applies at once (no second approval). A coupon the customer
 * already used is refused by the workers, and nothing changes.
 */
function ReplaceCouponForm({ row, onClose }: { row: CouponApprovalRow; onClose: () => void }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const replace = useReplaceCoupon();
  const expired = couponIsExpired(row.valid_to, new Date());
  const [edits, setEdits] = useState<TermEdits>(() => {
    const seeded = seedEdits(row);
    // An expired coupon is replaced by a VALID one: fresh dates to start from.
    if (!expired) return seeded;
    const d = defaultCouponDates(new Date());
    return { ...seeded, valid_from: d.valid_from, valid_to: d.valid_to };
  });
  const [reason, setReason] = useState('');
  const setEdit = (k: keyof TermEdits, v: string) => setEdits((e) => ({ ...e, [k]: v }));
  const terms = termsFromEdits(row, edits);
  const problem = replacementTermsProblem(terms);
  const pctNow = isPercentageCategory(edits.discount_category);

  const save = () =>
    replace.mutate(
      { old: row, terms, reason, editorId: user?.id ?? null },
      {
        onSuccess: (r) => {
          if (r.state === 'done') {
            toast.success(
              t('couponApprovals.replaceDone', {
                defaultValue:
                  'Coupon edited — {{code}} replaces {{old}} and is on its way to the customer.',
                code: r.code,
                old: row.coupon_code ?? '—',
              }),
            );
            onClose();
          } else if (r.state === 'refused') {
            toast.error(
              t('couponApprovals.replaceRefused', { defaultValue: 'The coupon was not changed' }),
              { description: r.note ?? undefined, durationMs: 0 },
            );
            onClose();
          } else {
            toast.success(
              t('couponApprovals.replaceWorking', {
                defaultValue:
                  'Edit sent — still swapping the coupon in the customer’s app. This card updates when it is done.',
              }),
            );
            onClose();
          }
        },
        onError: (err) =>
          toast.error(
            t('couponApprovals.replaceFailed', { defaultValue: 'Could not edit this coupon' }),
            { description: err instanceof Error ? err.message : undefined },
          ),
      },
    );

  return (
    <div className="mt-4 space-y-3 border-t border-foreground/[0.07] pt-3.5">
      <p className="text-xs font-semibold text-foreground">
        {t('couponApprovals.replaceTitle', { defaultValue: 'Edit this approved coupon' })}
      </p>
      <p className="text-2xs leading-relaxed text-muted-foreground">
        {t('couponApprovals.replaceHint', {
          defaultValue:
            'Saving applies at once: a new coupon with a new code replaces this one, and if this one is already in the customer’s Yiji app it is taken out first. A coupon the customer already used cannot be edited. This one is kept as history.',
        })}
      </p>
      {expired && (
        <p role="note" className={NOTICE}>
          <InfoIcon size={14} className="mt-0.5 shrink-0 text-foreground/70" aria-hidden />
          {t('couponApprovals.replaceExpired', {
            defaultValue:
              'This coupon expired on {{date}}. Editing it creates a fresh, valid coupon — check the new dates.',
            date: (row.valid_to ?? '').slice(0, 10),
          })}
        </p>
      )}
      <div className="grid w-full gap-3 rounded-xl bg-secondary/40 p-3.5 ring-1 ring-inset ring-foreground/[0.05] sm:grid-cols-2 lg:grid-cols-3">
        <EditField
          label={t('coupons.code', { defaultValue: 'Coupon code' })}
          value={t('couponApprovals.replaceNewCode', { defaultValue: 'A new code is generated' })}
          onChange={() => undefined}
          disabled
        />
        <EditField
          label={t('coupons.titleField', { defaultValue: 'Coupon title' })}
          value={edits.title}
          onChange={(v) => setEdit('title', v)}
        />
        <EditField
          label={t('lists.issuingSide', { defaultValue: 'Issuing side' })}
          value={edits.issuing_side}
          onChange={(v) => setEdit('issuing_side', v)}
        />
        <EditField
          label={t('lists.deliveryType', { defaultValue: 'Delivery types' })}
          value={edits.delivery_type}
          onChange={(v) => setEdit('delivery_type', v)}
          hint={t('couponApprovals.deliveryEditHint', {
            defaultValue: 'Comma-separated, or "All".',
          })}
        />
        <EditField
          label={t('lists.couponType', { defaultValue: 'Coupon type' })}
          value={edits.coupon_type}
          onChange={(v) => setEdit('coupon_type', v)}
        />
        <EditField
          label={t('lists.discountCategory', { defaultValue: 'Discount category' })}
          value={edits.discount_category}
          onChange={(v) => setEdit('discount_category', v)}
          hint={t('couponApprovals.categoryEditHint', {
            defaultValue: '"Amount" or "Percentage" — decides what the value means.',
          })}
        />
        <EditField
          label={
            pctNow
              ? t('coupons.couponPercent', { defaultValue: 'Coupon percentage %' })
              : t('coupons.couponValue', { defaultValue: 'Coupon value (SAR)' })
          }
          type="number"
          value={edits.amount}
          onChange={(v) => setEdit('amount', v)}
        />
        <EditField
          label={t('performance.from', { defaultValue: 'From' })}
          type="date"
          value={edits.valid_from}
          onChange={(v) => setEdit('valid_from', v)}
        />
        <EditField
          label={t('performance.to', { defaultValue: 'To' })}
          type="date"
          value={edits.valid_to}
          onChange={(v) => setEdit('valid_to', v)}
        />
        {pctNow && (
          <EditField
            label={t('coupons.maxDiscount', { defaultValue: 'Maximum discount' })}
            type="number"
            value={edits.max_discount}
            onChange={(v) => setEdit('max_discount', v)}
          />
        )}
        <EditField
          label={t('coupons.usageLimit', { defaultValue: 'Number of uses' })}
          type="number"
          value={edits.usage_limit}
          onChange={(v) => setEdit('usage_limit', v)}
        />
        <EditField
          label={t('coupons.itemShort', { defaultValue: 'Item' })}
          value={edits.item_name}
          onChange={(v) => setEdit('item_name', v)}
        />
        <div className="sm:col-span-2 lg:col-span-3">
          <EditField
            label={t('couponApprovals.description', { defaultValue: 'Description' })}
            value={edits.reason}
            onChange={(v) => setEdit('reason', v)}
          />
        </div>
        <div className="sm:col-span-2 lg:col-span-3">
          <label
            htmlFor={`replace-reason-${row.id}`}
            className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground"
          >
            {t('couponApprovals.editReason', { defaultValue: 'Reason for the change' })}
          </label>
          <Input
            id={`replace-reason-${row.id}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('couponApprovals.replaceReasonPlaceholder', {
              defaultValue: 'Why is this approved coupon being changed?',
            })}
            className="mt-1 h-9 w-full"
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          loading={replace.isPending}
          disabled={replace.isPending || !!problem || !reason.trim()}
          title={
            problem ??
            (reason.trim()
              ? undefined
              : t('couponApprovals.editReasonRequired', {
                  defaultValue: 'Give a reason for the change first.',
                }))
          }
          onClick={save}
        >
          {replace.isPending
            ? t('couponApprovals.replaceApplying', { defaultValue: 'Applying…' })
            : t('couponApprovals.replaceSave', { defaultValue: 'Save and replace' })}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={replace.isPending}
          onClick={onClose}
        >
          {t('actions.cancel', { ns: 'common', defaultValue: 'Cancel' })}
        </Button>
        {problem && (
          <span role="alert" className="text-2xs text-destructive">
            {problem}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * THE BRANCH, IN NAMES (owner spec §18, 2026-09-29).
 *
 * Three sources, in order of how readable they are:
 *
 *   1. the TICKET'S STORE — the branch the complaint was filed against, already
 *      joined and already named;
 *   2. the STORE MASTER, looked up by the coupon's own `restaurant_id`, which is
 *      Yiji's identifier — right to send, useless to read;
 *   3. nothing.
 *
 * (2) is the fix. A coupon raised from the LATE-ORDERS queue has no ticket with
 * a store — the order carries Yiji ids and nothing else — so the branch line
 * showed a bare "—" while the detail panel below it printed the raw numeric ids
 * side by side. Both said the same thing badly: we know which branch this is and
 * are showing the machine's word for it.
 *
 * Returns the id as a LAST RESORT rather than nothing, because a store missing
 * from the master is a data gap somebody must chase — and an id they can search
 * for beats an em dash that hides it.
 */
export function branchLabel(
  row: Pick<CouponApprovalRow, 'ticket' | 'brand_id' | 'restaurant_id'>,
  index: StoreIndex | null,
): string | null {
  const fromTicket = [row.ticket?.store?.brand?.name, row.ticket?.store?.name]
    .filter(Boolean)
    .join(' · ');
  if (fromTicket) return fromTicket;

  const store = row.restaurant_id
    ? (index?.byYijiId.get(String(row.restaurant_id).trim()) ?? null)
    : null;
  const fromMaster = [store?.brandName, store?.name].filter(Boolean).join(' · ');
  if (fromMaster) return fromMaster;

  /* Unmapped: show what we do have rather than pretending we have nothing. */
  const ids = [row.brand_id, row.restaurant_id].filter(Boolean).join(' · ');
  return ids || null;
}

function Row({
  row,
  onDecide,
  busy,
  correction,
  replacement,
}: {
  row: CouponApprovalRow;
  onDecide: (approve: boolean, note: string, edits?: Record<string, unknown>) => void;
  busy: boolean;
  /** Set when the requesting agent corrected this pending request. */
  correction: CorrectionStamp | null;
  /** This coupon's part in an edit-after-approval, when it has one. */
  replacement?: CouponReplacementLink | undefined;
}) {
  const { t } = useTranslation();
  /**
   * Deciding a coupon is a money decision, so it is its own privilege rather
   * than something everyone who can SEE the queue inherits. The route already
   * requires it; this is the second lock, so a future change that surfaces the
   * queue read-only somewhere cannot quietly hand out the buttons with it.
   */
  const { can: hasPrivilege } = useAuth();
  const canDecide = hasPrivilege('approve_coupons');
  /* EDIT AN APPROVED COUPON (owner, 2026-10-27): its own privilege - WeCare
     Supervisor / WeCare Admin / Administrator by default. */
  const canEditApproved = hasPrivilege('edit_approved_coupons');
  const [replacing, setReplacing] = useState(false);
  const replacedBy = replacement?.replacedBy ?? null;
  const replaces = replacement?.replaces ?? null;
  const isReplaced = Boolean(replacedBy);
  /* Why it cannot be edited (null = it can). Read from what the card already
     holds - "was it used?" is asked by the workers, on Save, never here. */
  const editBlock = couponEditBlock({
    status: row.status,
    removal_status: row.removal_status ?? null,
    replaced_by: replacedBy?.id ?? null,
  });
  const canReplace = canEditApproved && editBlock === null;
  /* The store master, for turning Yiji's restaurant id into a name. Cached by
     React Query and shared with every other card, so a queue of twenty is one
     fetch. */
  const { index: storeIndex } = useStoreIndex();
  const [note, setNote] = useState('');
  const [rejecting, setRejecting] = useState(false);
  /**
   * Amended terms, held until the supervisor approves.
   *
   * A supervisor who thinks the amount is too high had two options and needed a
   * third: reject it, approve it as asked, or approve a smaller one. The third
   * is what actually happens, and it used to mean rejecting and asking the
   * agent to start again. Every term is editable — two lonely number boxes used
   * to be the whole form, which made "fix the dates" a rejection.
   */
  /**
   * Collapsed until asked for.
   *
   * A queue of twenty full-height cards is a page nobody can compare across.
   * Opening one is a click; deciding on one usually is not — the summary line
   * carries enough to say yes.
   */
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  /** Why the terms are being changed. Required before Save will commit. */
  const [editReason, setEditReason] = useState('');
  const [edits, setEdits] = useState<TermEdits>(() => seedEdits(row));
  /**
   * WHY THIS COUPON IS BEING WITHHELD, typed here and committed on blur.
   *
   * Local rather than saved per keystroke: this is a text field on a card that
   * writes straight through, and a mutation per character would be a write
   * storm on a money record.
   *
   * Seeded from the row and re-seeded when the row changes identity, so a
   * reason saved earlier is shown for editing rather than appearing blank.
   */
  const [withholdReason, setWithholdReason] = useState(row.delivery_excluded_reason ?? '');
  const setEdit = (k: keyof TermEdits, v: string) => setEdits((e) => ({ ...e, [k]: v }));
  const saveTerms = useSaveCouponTerms();
  const retry = useRetryCouponDelivery();
  const pending = row.status === 'pending';
  /* Delivery only means anything once a decision has been made, and only an
   * APPROVAL is owed to anybody — a rejected coupon was never going to Yiji. */
  // Any approval, including one with amended terms (`edited`) — the worker's
  // push filter includes it, so the retry affordance must too.
  const approvedNotPending = couponDecision(row.status) === 'approved';
  /*
   * AN ORDER *OR* A PHONE — a supervisor has to know which, BEFORE they decide.
   *
   * There are two ways a coupon can reach the customer, and this used to know
   * only the first:
   *
   *  1. `CreateCouponUserFromOrder` attaches it to an ORDER and resolves the
   *     customer from it. No order, no call.
   *  2. `AddCompensationCoupon` grants it to a USER and takes no order at all —
   *     its `orderId` is nullable. The worker reaches it by looking the phone up
   *     with `GetfilteredCustomers`.
   *
   * This comment previously said Yiji's API had "no lookup by phone" and that an
   * order-less coupon could never be delivered. BOTH WERE WRONG, verified
   * against the live Swagger and admin API on 2026-10-01 — see
   * [[yiji-coupon-without-order]].
   *
   * So a phone is now a real chance of delivery, not a dead end. It is only a
   * CHANCE: a walk-in may have no Yiji account at all, and roughly a third of
   * this queue are such people. The warning below therefore fires only when
   * there is neither an order nor a number — the one case where nothing can
   * possibly reach them — and the softer notice covers "we will try".
   */
  /*
   * THE PHONE DECIDES (owner, 2026-10-11): every coupon goes to the customer's
   * phone number, never to an order - so a coupon with no phone cannot be
   * delivered, whatever order number it carries. Same order of preference as
   * the worker: the request's number, the contact's, a phone-shaped title.
   */
  const deliveryPhone =
    [row.customer_phone, row.contact?.phone, row.title]
      .map((v) => (v ?? '').trim())
      .find((v) => v.replace(/\D/g, '').length >= 9) ?? '';
  const canBeDelivered = Boolean(deliveryPhone);
  /*
   * Can this number actually be reached on Yiji? THE CARD NEVER ASKS YIJI
   * (prod incident, 2026-10-26: a per-card lookup - 378 for the All tab,
   * re-asked on every refocus - rate-limited Yiji and froze the late-orders
   * TV). The workers look each pending request's phone up ONCE and store the
   * answer on the row; this only reads it. `false` is a definite no; null or
   * absent (not checked yet, or the field not applied) says nothing.
   */
  const noYijiAccount = pending && row.yiji_customer_found === false;

  /**
   * What is wrong with the numbers as they now stand — the amended terms while
   * editing, the requested ones otherwise. Same rules as the agent's form, from
   * the same function, because both write the same two columns and a rule
   * enforced on one side only is not a rule.
   */
  const termsProblems = useMemo(() => {
    if (!editing) {
      return couponTermsProblems({
        discount_category: row.discount_category,
        coupon_value: row.coupon_value,
        coupon_percent: row.coupon_percent,
        max_discount: row.max_discount,
      });
    }
    const pctNow = isPercentageCategory(edits.discount_category);
    const amount = edits.amount.trim() === '' ? null : Number(edits.amount);
    const cap = edits.max_discount.trim() === '' ? null : Number(edits.max_discount);
    return couponTermsProblems({
      discount_category: edits.discount_category,
      coupon_value: pctNow ? null : amount,
      coupon_percent: pctNow ? amount : null,
      // An amount's ceiling is derived on save, so judge it the same way here
      // rather than warning about a cap the supervisor is not being asked for.
      max_discount: pctNow ? cap : amount,
    });
  }, [editing, edits, row]);

  const worth = [
    money(row.coupon_value),
    row.coupon_percent != null ? `${row.coupon_percent}%` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  /** The branch, as a person would say it. */
  const branch = branchLabel(row, storeIndex);

  const requester = row.requested_by?.first_name?.trim() || row.requested_by?.email?.trim() || '—';
  const orderRef = normalizeOrderId(row.ticket?.order_id || row.order_id)
    ? `#${row.ticket?.order_id || row.order_id}`
    : null;
  /*
   * THE CUSTOMER MUST MATCH THE COUPON TITLE (owner spec §18).
   *
   * Both when both are known: the name is who it is, the phone is what a
   * supervisor searches by and reads back on a call. `customer_phone` covers a
   * LATE-ORDERS coupon, which has no CONTACT row. Through `displayContactName`
   * (owner, 2026-10-05) so a stored `+966…` name renders as `05…`, and deduped
   * against the phone — most customers have no real name, so the "name" IS
   * the number, and the pair exists to show two facts, not one twice.
   */
  const phone =
    normalizePhone(row.contact?.phone ?? row.customer_phone ?? '') ||
    row.contact?.phone ||
    row.customer_phone ||
    '';
  const name = displayContactName(row.contact?.name, phone);
  const customer = [name === phone ? '' : name, phone].filter(Boolean).join(' · ') || null;
  /* The readable branch. The ticket's store when there is one, otherwise
     resolved from the store master by Yiji's restaurant id — a late-order
     coupon has no ticket store at all (owner spec §18). */
  const branchFull =
    [
      row.ticket?.store?.brand?.name,
      row.ticket?.store?.code,
      row.ticket?.store?.name,
      row.ticket?.store?.city,
    ]
      .filter(Boolean)
      .join(' · ') ||
    branch ||
    null;
  const title =
    row.ticket?.subject ??
    row.title ??
    t('couponApprovals.noTicket', { defaultValue: 'No ticket' });

  return (
    <li
      className={cn(
        'rounded-2xl bg-card shadow-soft ring-1 ring-foreground/[0.06] transition-shadow duration-base ease-out',
        expanded && 'shadow-float',
      )}
    >
      {/*
        THE HEADER, always visible — and, collapsed, the whole card.

        One line a supervisor triages on: what it is about and what it costs on
        the left, its state as two pills, then the reference facts (order,
        branch, who asked, when) as ONE quiet run of text rather than five
        loose fragments, and the decision buttons at the end.

        The toggle is a STRETCHED OVERLAY sitting under the content, not a
        <button> wrapped around it: the whole header highlights and clicks,
        while Approve/Edit/Reject sit above it and keep their own clicks (a
        button inside a button is invalid). Same pattern the order cards in the
        agent portal use.
      */}
      <div
        className={cn(
          'relative flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl px-4 py-3.5 sm:px-5',
          'transition-colors duration-fast ease-out hover:bg-secondary/40',
          expanded && 'rounded-b-none',
        )}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={title}
          className="absolute inset-0 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
        />
        {/* Above the overlay so it renders, but passing clicks through to it. */}
        <div className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-3">
          <ChevronDownIcon
            size={14}
            className={cn(
              'shrink-0 text-muted-foreground transition-transform duration-fast',
              expanded && 'rotate-180',
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
              {/* The ticket is what the request is ABOUT, so it leads. */}
              <span
                dir="auto"
                className="min-w-0 max-w-[18rem] truncate text-sm font-semibold text-foreground"
              >
                {title}
              </span>
              {worth && (
                <span className="shrink-0 text-lg font-extrabold leading-none tabular-nums tracking-[-0.03em] text-foreground">
                  {worth}
                </span>
              )}
              <Pill tone={TONE[row.status] ?? 'success'} size="sm">
                {t(`couponApprovals.status.${row.status}`, { defaultValue: row.status })}
              </Pill>
              {/* WHETHER IT GOES TO THE YIJI APP, on every row (owner,
                  2026-10-05) — a supervisor approving from the row must see
                  that a coupon is set to be withheld. "No" is the exception
                  worth noticing, so it carries the warning tone. */}
              <Pill tone={row.delivery_excluded ? 'warning' : 'muted'} size="sm">
                {row.delivery_excluded
                  ? t('couponApprovals.sendOnAppNo', { defaultValue: 'Send on app: No' })
                  : t('couponApprovals.sendOnAppYes', { defaultValue: 'Send on app: Yes' })}
              </Pill>
              {correction && (
                <CorrectedMark who={requester} at={correction.at} className="shrink-0" />
              )}
              {/* EDITED AFTER APPROVAL (owner, 2026-10-27): which side of a
                  replacement this card is. */}
              {replacedBy && (
                <Pill tone="muted" size="sm">
                  {t('couponApprovals.replacedBy', {
                    defaultValue: 'Replaced by {{code}}',
                    code: replacedBy.code ?? '—',
                  })}
                </Pill>
              )}
              {replaces && (
                <Pill
                  tone={couponDecision(row.status) === 'rejected' ? 'warning' : 'highlight'}
                  size="sm"
                >
                  {couponDecision(row.status) === 'rejected'
                    ? t('couponApprovals.replaceAbandoned', {
                        defaultValue: 'Edit of {{code}} not applied',
                        code: replaces.code ?? '—',
                      })
                    : t('couponApprovals.replaces', {
                        defaultValue: 'Replaces {{code}}',
                        code: replaces.code ?? '—',
                      })}
                </Pill>
              )}
            </div>
            <p className="mt-1 truncate text-2xs text-muted-foreground">
              {orderRef && <span className="font-mono">{orderRef}</span>}
              {orderRef && ' · '}
              {[branch, requester, formatDateTime(row.date_created)].filter(Boolean).join(' · ')}
            </p>
          </div>
        </div>
        {/* Above the overlay AND clickable: deciding must not be a side effect
            of trying to expand, nor the other way round. */}
        {approvedNotPending && canReplace && !expanded && (
          <div className="relative flex shrink-0 items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setExpanded(true);
                setReplacing(true);
              }}
            >
              {t('couponApprovals.editCoupon', { defaultValue: 'Edit coupon' })}
            </Button>
          </div>
        )}
        {pending && canDecide && !rejecting && !expanded && (
          <div className="relative flex shrink-0 items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              /* Gated on the TERMS, not on a ticket: a late-order coupon has no
                 ticket by design and is still perfectly deliverable (owner,
                 2026-09-28). */
              disabled={busy || termsProblems.length > 0}
              title={termsProblems[0]?.message}
              onClick={() => onDecide(true, note)}
            >
              {t('couponApprovals.approve', { defaultValue: 'Approve' })}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setExpanded(true);
                setEditing(true);
                setEdits(seedEdits(row));
              }}
            >
              {t('couponApprovals.edit', { defaultValue: 'Edit' })}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={busy}
              onClick={() => {
                setExpanded(true);
                setRejecting(true);
              }}
            >
              {t('couponApprovals.reject', { defaultValue: 'Reject' })}
            </Button>
          </div>
        )}
      </div>

      {expanded && (
        <div className="border-t border-foreground/[0.07] px-4 pb-4 pt-4 sm:px-5 sm:pb-5">
          {/*
            TWO SECTIONS, each a grid of label/value tiles (owner, 2026-10-26:
            "the cards could be better designed").

            REQUEST is who and what it is about; COUPON is what is being signed
            off. They used to be a run of inline pairs followed by a grey
            four-column block, which read as one long flat paragraph. Tiles in a
            responsive grid give every value the same shape and the eye a column
            to run down.
          */}
          <section aria-labelledby={`req-${row.id}`}>
            <h4 id={`req-${row.id}`} className="text-xs font-semibold text-foreground">
              {t('couponApprovals.sectionRequest', { defaultValue: 'Request' })}
            </h4>
            <dl className={TILE_GRID}>
              <Term
                label={t('couponApprovals.agent', { defaultValue: 'Asked by' })}
                value={requester}
              />
              <Term
                label={t('couponApprovals.customer', { defaultValue: 'Customer' })}
                value={customer}
                className="sm:col-span-2"
              />
              {/* Date AND time: the timestamp is what gets quoted in an audit. */}
              <Term
                label={t('couponApprovals.requestedAt', { defaultValue: 'Requested' })}
                value={row.date_created ? formatDateTime(row.date_created) : null}
              />
              <Term
                label={t('couponApprovals.branch', { defaultValue: 'Branch' })}
                value={branchFull}
                className="sm:col-span-2"
              />
              <Term
                label={t('couponApprovals.ticket', { defaultValue: 'Ticket' })}
                value={
                  [
                    row.ticket?.subject,
                    normalizeOrderId(row.ticket?.order_id) ? `#${row.ticket?.order_id}` : null,
                    row.ticket?.priority,
                    row.ticket?.status,
                  ]
                    .filter(Boolean)
                    .join(' · ') || null
                }
                className="sm:col-span-2"
              />
              {/* EMA-57 (operations, 2026-10-07): where the complaint came in,
                  exactly as the agent set it. A late-order coupon has no ticket,
                  and says so. */}
              <Term
                label={t('couponApprovals.ticketSource', { defaultValue: 'Ticket source' })}
                value={
                  row.ticket?.complaint_source?.trim() ||
                  (!row.ticket && row.order_id
                    ? t('couponApprovals.sourceLateOrder', { defaultValue: 'Late orders' })
                    : null)
                }
              />
            </dl>
          </section>

          {/* The COMPLETE terms, not the two that fit a summary: a supervisor is
              signing off on all of them, so all of them are on the card. */}
          <section className="mt-4" aria-labelledby={`cpn-${row.id}`}>
            <h4 id={`cpn-${row.id}`} className="text-xs font-semibold text-foreground">
              {t('couponApprovals.sectionCoupon', { defaultValue: 'Coupon' })}
            </h4>
            <dl className={TILE_GRID}>
              {/* The CODE leads: it is the one value a customer reads back down
                  a phone, and the header deliberately does not carry it. */}
              <Term
                label={t('coupons.code', { defaultValue: 'Coupon code' })}
                value={row.coupon_code}
                mono
              />
              <Term
                label={t('coupons.titleField', { defaultValue: 'Coupon title' })}
                value={row.title}
              />
              {/* THE ORDER, on every card (owner, 2026-10-11). Reference only:
                  the coupon goes to the customer's PHONE, never to this number.
                  For Dine-in / Takeout it is the restaurant's own number. */}
              <Term
                label={
                  isRestaurantOrderNumber(row.delivery_type)
                    ? t('couponApprovals.restaurantOrder', { defaultValue: 'Restaurant order no.' })
                    : t('couponApprovals.yijiOrder', { defaultValue: 'Yiji order' })
                }
                value={row.order_id ?? row.ticket?.order_id ?? null}
                mono
              />
              <Term
                label={t('lists.couponType', { defaultValue: 'Coupon type' })}
                value={row.coupon_type}
              />
              <Term
                label={t('lists.discountCategory', { defaultValue: 'Discount category' })}
                value={row.discount_category}
              />
              <Term
                label={t('coupons.maxDiscount', { defaultValue: 'Maximum discount' })}
                value={row.max_discount != null ? money(Number(row.max_discount)) : null}
              />
              <Term
                label={t('lists.deliveryType', { defaultValue: 'Delivery types' })}
                value={row.delivery_type}
                className="sm:col-span-2"
              />
              <Term
                label={t('couponApprovals.validity', { defaultValue: 'Valid' })}
                value={
                  row.valid_from || row.valid_to
                    ? `${row.valid_from?.slice(0, 10) ?? '…'} → ${row.valid_to?.slice(0, 10) ?? '…'}`
                    : null
                }
                className="sm:col-span-2"
              />
              <Term
                label={t('coupons.usageLimit', { defaultValue: 'Number of uses' })}
                value={row.usage_limit}
              />
              {/* ALWAYS rendered, never hidden when empty: "no item" says so
                  out loud rather than reading as a missing field. */}
              <Term
                label={t('coupons.itemShort', { defaultValue: 'Item' })}
                value={row.item_name}
              />
              <Term
                label={t('lists.issuingSide', { defaultValue: 'Issuing side' })}
                value={row.issuing_side}
              />
              {/* A real term, approved rather than discovered. The column is a
                  NEGATIVE — "Yes" means the customer is restricted. */}
              <Term
                label={t('coupons.noOtherDiscounts', {
                  defaultValue: 'Cannot be used with other discounts',
                })}
                value={
                  row.no_other_discounts
                    ? t('common.yes', { defaultValue: 'Yes' })
                    : t('common.no', { defaultValue: 'No' })
                }
              />
              {/* NAMES, not Yiji's ids (owner spec §18) — `branchLabel` falls
                  back to the ids only when the store master lacks the branch. */}
              {branch && (
                <Term
                  label={t('couponApprovals.brandBranch', { defaultValue: 'Brand / branch' })}
                  value={branch}
                  className="sm:col-span-2"
                />
              )}
            </dl>
          </section>

          {/*
            ONE BOX, NOT TWO (owner, 2026-10-07): the agent's reason, or the
            ticket's description when they left it empty. LABELLED like every
            term above it (owner, 2026-10-25) — "Description" is the word the
            Edit form uses for this field (`reason`).
          */}
          {(row.reason?.trim() || row.ticket?.description?.trim()) && (
            <div className="mt-3 rounded-xl bg-secondary/40 px-3.5 py-2.5 ring-1 ring-inset ring-foreground/[0.05]">
              <p className="text-2xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                {t('couponApprovals.description', { defaultValue: 'Description' })}
              </p>
              <p
                dir="auto"
                className="mt-0.5 whitespace-pre-line text-xs leading-relaxed text-foreground"
              >
                {row.reason?.trim() || row.ticket?.description?.trim()}
              </p>
            </div>
          )}

          {/*
            THE SUPERVISOR'S OVERRIDE on whether it reaches the Yiji app.

            The agent chooses this when they raise the request — a customer who
            wants a refund will not accept an app coupon (owner, 2026-10-01) —
            and the supervisor deciding the coupon may know better by the time
            they see it. So it is editable here rather than only displayed.

            DISABLED ONCE IT HAS BEEN PUSHED. A grant is irreversible from our
            side: deleting the CRM row does not revoke it on Yiji, so a control
            that appeared to un-send a delivered coupon would be a lie. After
            delivery this reads as a plain statement of fact instead.
          */}
          {/* Also gone once a WITHHELD coupon exists on Yiji (owner,
              2026-10-06): its code is taken there, and unticking would route
              a coupon that must never be assigned into the assignment path. */}
          {!row.yiji_coupon_user_id && !row.yiji_coupon_id && !isReplaced && (
            <div className="mt-3 rounded-xl bg-secondary/40 px-3.5 py-2.5 ring-1 ring-inset ring-foreground/[0.05]">
              <label
                className={cn(
                  'flex items-start gap-2.5',
                  canDecide ? 'cursor-pointer' : 'cursor-default',
                )}
              >
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                  disabled={!canDecide}
                  checked={row.delivery_excluded === true}
                  onChange={(e) => {
                    /* The LOCAL draft follows the server value, or unchecking
                       would clear the stored reason while leaving the old text
                       in the box — and re-checking would show a reason that is
                       no longer recorded anywhere. */
                    if (!e.target.checked) setWithholdReason('');
                    saveTerms.mutate({
                      id: row.id,
                      edits: {
                        delivery_excluded: e.target.checked,
                        /* Clearing the flag clears its reason too: a "why it was
                           withheld" left on a coupon that IS being sent reads as
                           a contradiction on this very card. */
                        ...(e.target.checked ? {} : { delivery_excluded_reason: null }),
                      },
                    });
                  }}
                />
                <span className="min-w-0">
                  <span className="block text-xs font-medium text-foreground">
                    {t('couponApprovals.withhold', {
                      defaultValue: 'Don’t assign the coupon to the customer on Yiji',
                    })}
                  </span>
                  <span className="mt-0.5 block text-2xs leading-relaxed text-muted-foreground">
                    {t('couponApprovals.withholdHint', {
                      defaultValue:
                        'For a customer who wants a refund instead. The coupon is still approved and created on Yiji — it is just not given to the customer.',
                    })}
                  </span>
                </span>
              </label>
              {/*
                WHY IT WAS WITHHELD — AN INPUT, NOT JUST A READOUT.
                
                The field existed and the card could DISPLAY a reason, but
                nothing ever wrote one: there was no input. Measured on
                production 2026-10-05 — all 4 withheld coupons carry a blank
                reason. Money is being held back from a customer with nothing on
                record saying why, and the person who decided is not the person
                who answers for it three weeks later.

                Committed on BLUR rather than per keystroke: this card writes
                straight through, and a mutation per character on a money record
                is a write storm. An unchanged value saves nothing.
              */}
              {row.delivery_excluded && (
                <label className="mt-2 block ps-7">
                  <span className="block text-2xs font-medium text-muted-foreground">
                    {t('couponApprovals.withholdReasonLabel', {
                      defaultValue: 'Why it is being withheld',
                    })}
                  </span>
                  <Input
                    className="mt-1 h-8 text-xs"
                    value={withholdReason}
                    onChange={(e) => setWithholdReason(e.target.value)}
                    onBlur={() => {
                      const next = withholdReason.trim();
                      if (next === (row.delivery_excluded_reason ?? '').trim()) return;
                      saveTerms.mutate({
                        id: row.id,
                        edits: { delivery_excluded_reason: next || null },
                      });
                    }}
                    placeholder={t('couponApprovals.withholdReasonPlaceholder', {
                      defaultValue: 'e.g. customer asked for a refund instead',
                    })}
                  />
                </label>
              )}
            </div>
          )}

          {/*
            DID IT ACTUALLY REACH THE CUSTOMER?
            The decision and the delivery are different facts, and only one of
            them puts a coupon in someone's app. An approved row that Yiji
            refused looks identical to one the worker has not got to yet, so an
            agent would tell a customer about compensation that does not exist.
            Both states are named here, and the refusal carries Yiji's own words
            plus the only action that un-parks it.
          */}
          {/*
            Shown while it is still PENDING as well as after, because it changes
            what the decision means rather than merely reporting on it.
          */}
          {/* NOT WHEN IT IS BEING WITHHELD ON PURPOSE. A missing order matters
              because Yiji cannot attach a coupon without one — but nothing is
              being sent to Yiji here, so the warning would be describing an
              obstacle to something nobody is attempting, and it tells the
              supervisor this "cannot be approved" when it can. */}
          {!canBeDelivered && !row.delivery_excluded && (
            <p role="note" className={NOTICE}>
              <InfoIcon size={14} className="mt-0.5 shrink-0 text-foreground/70" aria-hidden />
              {t('couponApprovals.noOrderNoPhone', {
                defaultValue:
                  'No customer phone on this request, so it cannot reach the customer on Yiji (coupons go to the phone number, never to an order). Approving still records the compensation, but nothing will arrive in the app — add the customer’s number first.',
              })}
            </p>
          )}

          {/* AN ORDER-LESS COUPON WITH A PHONE IS A CHANCE, NOT A PROMISE.
              The worker looks the number up on Yiji; a customer who has never
              used the app resolves to nobody and the coupon stays visibly owed.
              Saying so here is what stops an agent telling them it is on the
              way. */}
          {/*
            ONLY WHEN THE ANSWER IS ACTUALLY NO.

            This used to carry a standing caveat on every order-less coupon
            ("if they have never used the app it cannot be delivered"), which is
            noise on the great majority that deliver perfectly well and trains
            a supervisor to ignore the line that matters (owner, 2026-10-01).

            So the number is resolved against Yiji, exactly as the delivery
            worker will - but by the WORKERS, once, stored on the row
            (`yiji_customer_found`), never by this page. A customer who exists
            gets no notice at all. One who does not gets a real warning,
            because approving that coupon records a compensation nothing will
            deliver — and an agent must not tell them it is on the way.

            Nothing is said until the answer is stored: an unanswered question
            is not evidence of absence.
          */}
          {Boolean(deliveryPhone) && !row.delivery_excluded && noYijiAccount && (
            <p role="note" className={NOTICE}>
              <InfoIcon size={14} className="mt-0.5 shrink-0 text-foreground/70" aria-hidden />
              {t('couponApprovals.noYijiAccount', {
                defaultValue:
                  '{{phone}} has no Yiji account yet — the coupon is held and sent automatically if they sign up. Until then honour it in the branch.',
                phone: normalizePhone(deliveryPhone) || deliveryPhone,
              })}
            </p>
          )}

          {/* Never-send outranks every other delivery state: there is nothing
              to report on and nothing to retry. */}
          {approvedNotPending && !isReplaced && row.delivery_excluded && (
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {t('couponApprovals.deliveryExcluded', {
                defaultValue: 'Not sent to the customer — {{why}}',
                why:
                  row.delivery_excluded_reason?.trim() ||
                  t('couponApprovals.deliveryExcludedDefault', {
                    defaultValue: 'marked never-send',
                  }),
              })}
            </p>
          )}
          {/*
            A WITHHELD COUPON IS STILL CREATED ON YIJI, assigned to nobody
            (owner, 2026-10-06) — so the card says whether that has happened,
            with Yiji's coupon id to find it in their portal. A refusal (a
            duplicate code, say) is shown in Yiji's own words.
          */}
          {approvedNotPending &&
            !isReplaced &&
            row.delivery_excluded &&
            (row.yiji_coupon_id ? (
              <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <Pill tone="muted" size="sm" dot>
                  {t('couponApprovals.withheldCreated', {
                    defaultValue: 'Created on Yiji, not sent to the customer — Yiji coupon #{{id}}',
                    id: row.yiji_coupon_id,
                  })}
                </Pill>
              </p>
            ) : row.yiji_push_error ? (
              <p className="mt-1 rounded-lg bg-warning-tint px-3 py-2 text-xs leading-relaxed text-foreground ring-1 ring-inset ring-warning/25">
                {t('couponApprovals.withheldRefused', {
                  defaultValue: 'Not created on Yiji — Yiji said: {{why}}',
                  why: row.yiji_push_error,
                })}
              </p>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">
                {t('couponApprovals.withheldPending', {
                  defaultValue: 'Not created on Yiji yet',
                })}
              </p>
            ))}

          {approvedNotPending &&
            !isReplaced &&
            !row.delivery_excluded &&
            canBeDelivered &&
            (row.yiji_coupon_user_id ? (
              <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <Pill tone="success" size="sm" dot>
                  {t('couponApprovals.delivered', { defaultValue: 'Delivered to Yiji' })}
                </Pill>
                <span className="tabular-nums">
                  {t('couponApprovals.deliveredRef', {
                    defaultValue: 'reference {{ref}}',
                    ref: row.yiji_coupon_user_id,
                  })}
                </span>
              </p>
            ) : row.yiji_push_error ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-warning-tint px-3 py-2 text-xs leading-relaxed text-foreground ring-1 ring-inset ring-warning/25">
                <span className="min-w-0 flex-1">
                  {t('couponApprovals.notDelivered', {
                    defaultValue: 'Not delivered — Yiji said: {{why}}',
                    why: row.yiji_push_error,
                  })}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7"
                  disabled={retry.isPending}
                  onClick={() => retry.mutate(row.id)}
                >
                  {t('couponApprovals.retryDelivery', { defaultValue: 'Try again' })}
                </Button>
              </div>
            ) : row.awaiting_signup_at ? (
              /* Held until the customer joins Yiji (owner, 2026-10-07, EMA-49):
                 nothing exists on Yiji yet, and the number is looked up again
                 on a schedule — say so, and when it was last looked at. */
              <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <Pill tone="warning" size="sm" dot>
                  {t('couponApprovals.awaitingSignup', {
                    defaultValue: 'Waiting for the customer to join Yiji',
                  })}
                </Pill>
                <span>
                  {t('couponApprovals.awaitingSignupHint', {
                    defaultValue:
                      'It is sent to their account automatically when they sign up with this number. Last checked {{when}}.',
                    when: new Date(
                      row.signup_checked_at ?? row.awaiting_signup_at,
                    ).toLocaleString(),
                  })}
                </span>
              </p>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">
                {t('couponApprovals.deliveryPending', {
                  defaultValue: 'Approved — waiting to be sent to Yiji.',
                })}
              </p>
            ))}

          {row.status !== 'pending' && row.decision_note && (
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {t('couponApprovals.decidedBy', {
                defaultValue: 'Decided by {{who}}: {{note}}',
                who: row.decided_by?.first_name?.trim() || row.decided_by?.email?.trim() || '—',
                note: row.decision_note,
              })}
            </p>
          )}

          {replacedBy && (
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {t('couponApprovals.replacedNote', {
                defaultValue:
                  'Edited after approval: {{code}} replaced this coupon, which is kept as history and no longer counts in any total.',
                code: replacedBy.code ?? '—',
              })}
              {replacement?.reason ? ` — ${replacement.reason}` : ''}
            </p>
          )}
          {replaces && couponDecision(row.status) === 'approved' && (
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {t('couponApprovals.replacesNote', {
                defaultValue: 'Edited after approval: this coupon replaces {{code}}.',
                code: replaces.code ?? '—',
              })}
              {replacement?.reason ? ` — ${replacement.reason}` : ''}
            </p>
          )}
          {approvedNotPending &&
            canReplace &&
            (replacing ? (
              <ReplaceCouponForm row={row} onClose={() => setReplacing(false)} />
            ) : (
              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-foreground/[0.07] pt-3.5">
                <Button type="button" size="sm" variant="ghost" onClick={() => setReplacing(true)}>
                  {t('couponApprovals.editCoupon', { defaultValue: 'Edit coupon' })}
                </Button>
              </div>
            ))}
          {approvedNotPending && canEditApproved && editBlock === 'used' && (
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {t('couponApprovals.cannotEditUsed', {
                defaultValue: 'The customer already used this coupon, so it cannot be edited.',
              })}
            </p>
          )}

          {pending && (
            // The decision strip sits on its own hairline band — the card's footer,
            // so the actions read as one place rather than a loose button cluster.
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-foreground/[0.07] pt-3.5">
              {rejecting ? (
                <>
                  <Input
                    autoFocus
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder={t('couponApprovals.reasonPlaceholder', {
                      defaultValue: 'Why not? The agent has to tell the customer something.',
                    })}
                    className="h-9 min-w-[16rem] flex-1"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    disabled={busy || !note.trim()}
                    onClick={() => onDecide(false, note)}
                  >
                    {t('couponApprovals.confirmReject', { defaultValue: 'Reject' })}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setRejecting(false)}
                  >
                    {t('actions.cancel', { ns: 'common', defaultValue: 'Cancel' })}
                  </Button>
                </>
              ) : (
                <>
                  {editing && (
                    <div className="mb-1 grid w-full gap-3 rounded-xl bg-secondary/40 p-3.5 ring-1 ring-inset ring-foreground/[0.05] sm:grid-cols-2 lg:grid-cols-3">
                      {/* CODE and ORDER, editable (owner, 2026-10-11). The code is
                          locked once the coupon exists on Yiji: their copy keeps
                          the code it was created with. */}
                      <EditField
                        label={t('coupons.code', { defaultValue: 'Coupon code' })}
                        value={edits.coupon_code}
                        onChange={(v) => setEdit('coupon_code', v)}
                        disabled={Boolean(row.yiji_coupon_user_id || row.yiji_coupon_id)}
                        hint={
                          row.yiji_coupon_user_id || row.yiji_coupon_id
                            ? t('couponApprovals.codeLocked', {
                                defaultValue: 'Already on Yiji — the code can no longer change.',
                              })
                            : undefined
                        }
                      />
                      <EditField
                        label={
                          isRestaurantOrderNumber(edits.delivery_type || row.delivery_type)
                            ? t('couponApprovals.restaurantOrder', {
                                defaultValue: 'Restaurant order no.',
                              })
                            : t('couponApprovals.yijiOrder', { defaultValue: 'Yiji order' })
                        }
                        value={edits.order_id}
                        onChange={(v) => setEdit('order_id', v)}
                        hint={t('couponApprovals.orderEditHint', {
                          defaultValue:
                            'For reference — the coupon always goes to the customer’s phone.',
                        })}
                      />
                      <EditField
                        label={t('coupons.titleField', { defaultValue: 'Coupon title' })}
                        value={edits.title}
                        onChange={(v) => setEdit('title', v)}
                      />
                      <EditField
                        label={t('lists.issuingSide', { defaultValue: 'Issuing side' })}
                        value={edits.issuing_side}
                        onChange={(v) => setEdit('issuing_side', v)}
                      />
                      <EditField
                        label={t('lists.deliveryType', { defaultValue: 'Delivery types' })}
                        value={edits.delivery_type}
                        onChange={(v) => setEdit('delivery_type', v)}
                        hint={t('couponApprovals.deliveryEditHint', {
                          defaultValue: 'Comma-separated, or "All".',
                        })}
                      />
                      <EditField
                        label={t('lists.couponType', { defaultValue: 'Coupon type' })}
                        value={edits.coupon_type}
                        onChange={(v) => setEdit('coupon_type', v)}
                      />
                      <EditField
                        label={t('lists.discountCategory', { defaultValue: 'Discount category' })}
                        value={edits.discount_category}
                        onChange={(v) => setEdit('discount_category', v)}
                        hint={t('couponApprovals.categoryEditHint', {
                          defaultValue: '"Amount" or "Percentage" — decides what the value means.',
                        })}
                      />
                      <EditField
                        label={
                          edits.discount_category.trim().toLowerCase() === 'percentage'
                            ? t('coupons.couponPercent', { defaultValue: 'Coupon percentage %' })
                            : t('coupons.couponValue', { defaultValue: 'Coupon value (SAR)' })
                        }
                        type="number"
                        value={edits.amount}
                        onChange={(v) => setEdit('amount', v)}
                      />
                      <EditField
                        label={t('performance.from', { defaultValue: 'From' })}
                        type="date"
                        value={edits.valid_from}
                        onChange={(v) => setEdit('valid_from', v)}
                      />
                      <EditField
                        label={t('performance.to', { defaultValue: 'To' })}
                        type="date"
                        value={edits.valid_to}
                        onChange={(v) => setEdit('valid_to', v)}
                      />
                      {/* Only a percentage has a ceiling to type: an amount's
                          ceiling is the amount itself (OPS-SGVAVXW6). */}
                      {isPercentageCategory(edits.discount_category) && (
                        <EditField
                          label={t('coupons.maxDiscount', { defaultValue: 'Maximum discount' })}
                          type="number"
                          value={edits.max_discount}
                          onChange={(v) => setEdit('max_discount', v)}
                        />
                      )}
                      <EditField
                        label={t('coupons.usageLimit', { defaultValue: 'Number of uses' })}
                        type="number"
                        value={edits.usage_limit}
                        onChange={(v) => setEdit('usage_limit', v)}
                      />
                      <EditField
                        label={t('coupons.itemShort', { defaultValue: 'Item' })}
                        value={edits.item_name}
                        onChange={(v) => setEdit('item_name', v)}
                      />
                      {/* "Description", on its own full row (owner, 2026-10-07):
                          it is the long text the card shows before Edit, and
                          squeezed into one column it could not be read. */}
                      <div className="sm:col-span-2 lg:col-span-3">
                        <EditField
                          label={t('couponApprovals.description', { defaultValue: 'Description' })}
                          value={edits.reason}
                          onChange={(v) => setEdit('reason', v)}
                        />
                      </div>
                      {/* WHY the terms were changed, and it is required.
                          
                          Changing what an agent asked for without saying why
                          leaves them looking at a different number with no
                          explanation, and leaves whoever audits it later with
                          a changed record and no account of the change. The
                          reject flow already demands a reason for the same
                          reason. */}
                      <div className="sm:col-span-2 lg:col-span-3">
                        <label
                          htmlFor={`edit-reason-${row.id}`}
                          className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground"
                        >
                          {t('couponApprovals.editReason', {
                            defaultValue: 'Reason for the change',
                          })}
                        </label>
                        <Input
                          id={`edit-reason-${row.id}`}
                          value={editReason}
                          onChange={(e) => setEditReason(e.target.value)}
                          placeholder={t('couponApprovals.editReasonPlaceholder', {
                            defaultValue: 'Why are these terms different from what was asked for?',
                          })}
                          className="mt-1 h-9 w-full"
                        />
                      </div>
                      <p className="text-2xs leading-relaxed text-muted-foreground sm:col-span-2 lg:col-span-3">
                        {t('couponApprovals.editHint', {
                          defaultValue:
                            'Save keeps these terms and leaves the request waiting. Approving now grants them instead of what was asked for, and is recorded as an amendment.',
                        })}
                      </p>
                    </div>
                  )}
                  {/*
                    TWO MODES, never both at once.

                    While an edit is open the only questions are "keep this
                    change" and "throw it away", so Approve and Reject go. They
                    were a genuine hazard sitting there: Approve mid-edit
                    committed a half-finished amendment, and Reject threw the
                    typing away with no warning that it would. Deciding is a
                    different act from editing, and the strip now says which one
                    is in progress.
                  */}
                  {editing ? (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        disabled={
                          busy ||
                          saveTerms.isPending ||
                          termsProblems.length > 0 ||
                          !editReason.trim()
                        }
                        title={
                          termsProblems[0]?.message ??
                          (editReason.trim()
                            ? undefined
                            : t('couponApprovals.editReasonRequired', {
                                defaultValue: 'Give a reason for the change first.',
                              }))
                        }
                        // Solid ink: while an edit is open, Save is the one
                        // action that commits, so it carries the primary weight
                        // Approve has outside the editor.
                        onClick={() => {
                          const patch = diffEdits(row, edits);
                          if (Object.keys(patch).length === 0) {
                            toast.success(
                              t('couponApprovals.nothingChanged', {
                                defaultValue: 'Nothing changed.',
                              }),
                            );
                            return;
                          }
                          saveTerms.mutate(
                            // The reason rides WITH the change, in one write. Two
                            // writes could leave amended terms on record with no
                            // account of why if the second one failed.
                            { id: row.id, edits: { ...patch, decision_note: editReason.trim() } },
                            {
                              onSuccess: () => {
                                toast.success(
                                  t('couponApprovals.termsSaved', {
                                    defaultValue: 'Terms saved. Still waiting on a decision.',
                                  }),
                                );
                                // Saved terms are no longer a draft, so the form
                                // closes and Save goes with it. Leaving an open
                                // editor behind invites a second press that would
                                // find nothing changed.
                                setEditing(false);
                                setEditReason('');
                              },
                              onError: () =>
                                toast.error(
                                  t('couponApprovals.termsSaveFailed', {
                                    defaultValue: 'Could not save those terms.',
                                  }),
                                ),
                            },
                          );
                        }}
                      >
                        {t('actions.save', { ns: 'common', defaultValue: 'Save' })}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={busy || saveTerms.isPending}
                        onClick={() => {
                          // Discard, not just close: re-seeding from the row
                          // means reopening the editor shows what was ASKED
                          // for, never the abandoned draft.
                          setEditing(false);
                          setEditReason('');
                          setEdits(seedEdits(row));
                        }}
                      >
                        {t('actions.cancel', { ns: 'common', defaultValue: 'Cancel' })}
                      </Button>
                      <span className="ms-auto text-end text-2xs text-muted-foreground">
                        {t('couponApprovals.editingHint', {
                          defaultValue: 'Save or cancel this change before deciding.',
                        })}
                      </span>
                    </>
                  ) : (
                    <>
                      {/*
                        APPROVAL IS NOT GATED ON A TICKET — OR ON AN ORDER.
                        
                        This refused approval whenever there was no ticket, which
                        was right when every coupon came from a complaint: with
                        nothing to stamp, approving wrote nothing and the
                        supervisor believed they had issued money that did not
                        exist.
                        
                        A LATE-ORDER coupon has no complaint behind it by design.
                        It carries `order_id` itself, Yiji's
                        `CreateCouponUserFromOrder` attaches the coupon to the
                        ORDER, the worker has read whichever id is present since
                        2026-09-21 (`couponOrderId`), and the approval mutation
                        already skips the ticket patch when there is none. Only
                        this button never learned, so a perfectly deliverable
                        late-order coupon could not be approved at all (owner,
                        2026-09-27).
                        
                        And no order is STILL not a block: a walk-in who scanned
                        a branch QR code may have no Yiji account and no order,
                        and approving still means something — the decision is
                        recorded and the branch honours it in person. Only the
                        in-app delivery is impossible, which the warning above
                        already says. Blocking here would take away a decision a
                        supervisor is entitled to make.
                      */}
                      {/* A supervisor approving is the last gate before a customer is
                      promised money, so the same rules the agent's form enforces
                      are checked again HERE against the terms as they now stand.
                      Both rows already in the system failed one of them. */}
                      {canDecide && (
                        <Button
                          type="button"
                          size="sm"
                          disabled={busy || termsProblems.length > 0}
                          title={termsProblems[0]?.message}
                          onClick={() => {
                            // Terms amended earlier in this session are already
                            // saved on the row, so a straight approval is what
                            // this is — nothing is pending to ride along.
                            onDecide(true, note);
                          }}
                        >
                          {t('couponApprovals.approve', { defaultValue: 'Approve' })}
                        </Button>
                      )}
                      {/* Said in words, not only in a hover title: a greyed-out
                          Approve with no visible reason is how OPS-SGVAVXW6 was
                          reported as a bug (2026-10-07). */}
                      {canDecide && termsProblems.length > 0 && (
                        <span role="alert" className="text-2xs text-destructive">
                          {termsProblems[0]?.message}{' '}
                          {t('couponApprovals.fixWithEdit', {
                            defaultValue: 'Use Edit to correct it.',
                          })}
                        </span>
                      )}
                      {canDecide && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => {
                            setEditing(true);
                            // Seed from what was asked for, so the supervisor adjusts a
                            // value rather than recalling it.
                            setEdits(seedEdits(row));
                          }}
                        >
                          {t('couponApprovals.edit', { defaultValue: 'Edit' })}
                        </Button>
                      )}
                      {canDecide && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          disabled={busy}
                          onClick={() => setRejecting(true)}
                        >
                          {t('couponApprovals.reject', { defaultValue: 'Reject' })}
                        </Button>
                      )}
                      <span className="ms-auto text-end text-2xs text-muted-foreground">
                        {row.ticket?.id
                          ? t('couponApprovals.approveHint', {
                              defaultValue: 'Approving puts the coupon on the ticket.',
                            })
                          : canBeDelivered
                            ? t('couponApprovals.approvePhoneHint', {
                                phone: normalizePhone(deliveryPhone) || deliveryPhone,
                                defaultValue: 'No ticket — the coupon goes to {{phone}} directly.',
                              })
                            : t('couponApprovals.noTicketHint', {
                                defaultValue:
                                  'No ticket and no customer phone on this request — there is nobody to send the coupon to.',
                              })}
                      </span>
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export function CouponApprovalsPage() {
  const { t } = useTranslation();
  const { user, can } = useAuth();
  /* A reader who cannot decide (the CEO, owner 2026-10-15) has no "pending
     to work": they open on every status. Deciders still open on pending. */
  const canDecide = can('approve_coupons');
  const [view, setView] = useState<CouponApprovalStatus | 'all'>(() =>
    canDecide ? 'pending' : 'all',
  );
  const approvals = useCouponApprovals(view);
  const decide = useDecideCoupon();
  /* Agents' own corrections of pending requests — a mark on the card only. */
  const stamps = useCorrectionStamps();
  /* Edits after approval: which card replaced which (best-effort read). */
  const replacements = useCouponReplacements();

  const all = approvals.data ?? [];
  const [query, setQuery] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  /**
   * Filtered in the browser, not the query.
   *
   * The whole queue is already loaded — it is one supervisor's working set, not
   * a table scan — so searching it here answers instantly and keeps the status
   * tabs honest: the counts above never disagree with the list below because
   * both come from the same array.
   *
   * Order id, phone and coupon code are what a supervisor is holding when they
   * come to this page: a customer on the phone, or a code somebody queried.
   */
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((r) => {
      /* BUSINESS days, not calendar days (owner, 2026-09-30): a coupon raised at
         01:00 belongs to the night before, and `T00:00:00`/`T23:59:59` put it on
         the wrong day at both edges. */
      if (from || to) {
        const w = businessDayWindow(from || '0000-01-01', to || '9999-12-31');
        const at = r.date_created ?? '';
        if (from && at < w.fromIso) return false;
        if (to && at > w.toIso) return false;
      }
      if (!q) return true;
      /* BOTH HOMES OF THE ORDER AND THE PHONE. A late-order coupon has neither
         a ticket nor a contact, so its order and number live on the row itself —
         reading only `ticket.order_id`/`contact.phone` compared every term
         against undefined and found nothing. Measured on live production, 12 of
         32 requests were unfindable by their own order number. `AllCompensation`
         already did this correctly; this queue did not. */
      return [
        r.coupon_code,
        r.ticket?.order_id,
        r.order_id,
        r.contact?.phone,
        r.customer_phone,
        r.contact?.name,
        r.title,
        r.ticket?.store?.name,
        r.ticket?.store?.code,
      ]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
  }, [all, query, from, to]);

  /*
   * APPROVE ALL — everything currently on screen, after the filters.
   *
   * Scope is what the supervisor can SEE (owner, 2026-09-28): the status tab
   * and the search/date filters already narrow the list, so filtering to one
   * branch or one day and pressing this approves exactly that. A button that
   * silently reached rows off screen is how somebody grants more money than
   * they meant to.
   *
   * SKIPS INVALID TERMS. A request whose numbers fail `couponTermsProblems`
   * has its own Approve disabled — 0 SAR, or a percentage over the cap — and
   * forcing it through here would approve terms our own rules reject. They are
   * counted and reported rather than silently dropped.
   *
   * A coupon with no ORDER is NOT skipped: it cannot be delivered in the app,
   * but approving still records a real decision the branch honours in person,
   * which is the same rule the individual button follows.
   */
  const approvable = useMemo(
    () =>
      rows.filter(
        (r) =>
          r.status === 'pending' &&
          couponTermsProblems({
            discount_category: r.discount_category,
            coupon_value: r.coupon_value,
            coupon_percent: r.coupon_percent,
            max_discount: r.max_discount,
          }).length === 0,
      ),
    [rows],
  );
  const skipped = rows.filter((r) => r.status === 'pending').length - approvable.length;
  const [confirmAll, setConfirmAll] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  const approveAll = async () => {
    setBulkBusy(true);
    let done = 0;
    try {
      /* SEQUENTIAL. Each approval writes the coupon and queues its delivery;
         a parallel burst against Yiji's production API is not something to
         start, and on a partial failure nobody could say which coupons had
         been granted. One at a time means the count reported is the count
         actually approved. */
      for (const r of approvable) {
        await decide.mutateAsync({
          row: r,
          approve: true,
          note: '',
          supervisorId: user?.id ?? null,
        });
        done += 1;
      }
      toast.success(
        t('couponApprovals.approvedAll', {
          count: done,
          defaultValue: '{{count}} coupons approved.',
        }),
      );
    } catch {
      toast.error(
        done > 0
          ? t('couponApprovals.approvedAllPartial', {
              count: done,
              defaultValue: 'Approved {{count}}, then stopped — the rest are untouched.',
            })
          : t('errors.updateFailed', { ns: 'common' }),
      );
    }
    setBulkBusy(false);
    setConfirmAll(false);
  };

  const onDecide = (
    row: CouponApprovalRow,
    approve: boolean,
    note: string,
    edits?: Record<string, unknown>,
  ) => {
    decide.mutate(
      { row, approve, note, supervisorId: user?.id ?? null, edits },
      {
        onSuccess: () =>
          toast.success(
            approve
              ? edits
                ? // Say that the terms changed, so nobody thinks the agent's
                  // numbers went through untouched.
                  t('couponApprovals.approvedEdited', {
                    defaultValue: 'Approved with changes — the amended coupon is on the ticket',
                  })
                : t('couponApprovals.approved', {
                    // Not "on the ticket": a coupon given from the late-orders
                    // queue has no ticket, and the delivery is what the
                    // supervisor is actually being told about either way.
                    defaultValue: 'Approved — the coupon is on its way to the customer',
                  })
              : t('couponApprovals.rejected', { defaultValue: 'Rejected' }),
          ),
        onError: (err) =>
          toast.error(
            // Named, because "could not record that decision" would leave a
            // supervisor retrying a click that can never work.
            err instanceof Error && err.message === 'COUPON_APPROVAL_NO_ORDER'
              ? t('couponApprovals.approveUnreachable', {
                  /* The message must name the REAL precondition, or it sends a
                     supervisor hunting for an order number that is not needed.
                     A coupon reaches the customer by its order OR by their
                     phone; only a request with neither can be refused. */
                  defaultValue:
                    'This request has no order number and no customer phone, so there is no way to deliver the coupon. Ask the agent for either one.',
                })
              : t('couponApprovals.decideError', {
                  defaultValue: 'Could not record that decision',
                }),
          ),
      },
    );
  };

  return (
    // The shell's <main> is overflow-hidden by design — every page owns its
    // scroll. This one didn't, so a queue longer than a screen was unreachable,
    // and with no header band the filter pills sat jammed under the navbar.
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader
        title={t('nav.couponApprovals', { defaultValue: 'Coupon approvals' })}
        actions={
          /* Only when there is something it would actually do. A permanently
             visible bulk action on an empty queue invites a click that grants
             nothing and teaches nothing. */
          canDecide && approvable.length > 0 ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={bulkBusy}
              onClick={() => setConfirmAll(true)}
            >
              {t('couponApprovals.approveAll', {
                count: approvable.length,
                defaultValue: 'Approve all ({{count}})',
              })}
            </Button>
          ) : undefined
        }
      />

      {/* Full width on the header's gutter (Rapport skin): the queue used to
          sit in a centred 4xl column, visibly off-centre from its own title. */}
      <div className={cn(PAGE_BODY, 'overflow-x-hidden')}>
        <div className="space-y-4">
          {/* Status, search and period in ONE frosted filter card - the
              Dashboard's pattern. */}
          <div className={cn(FILTER_CARD, 'space-y-3')}>
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  'pending',
                  ...COUPON_APPROVAL_STATUSES.filter((s) => s !== 'pending'),
                  'all',
                ] as const
              ).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setView(s)}
                  aria-pressed={view === s}
                  className={cn(
                    'rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors duration-fast ease-out',
                    view === s
                      ? // The selected filter is a solid ink chip (Rapport skin).
                        'bg-ink text-ink-foreground'
                      : 'bg-glass/60 text-foreground/80 ring-1 ring-inset ring-glass/80 hover:bg-glass/90 hover:text-foreground',
                  )}
                >
                  {t(`couponApprovals.status.${s}`, { defaultValue: s })}
                </button>
              ))}
            </div>

            {/* Search and period. Both narrow the list the tabs above produced,
              so a supervisor can hold a status AND a date range at once. */}
            <div className="flex flex-wrap items-end gap-2">
              <SearchField
                className="min-w-[min(16rem,100%)] flex-1"
                inputClassName="h-9"
                value={query}
                onValueChange={setQuery}
                aria-label={t('couponApprovals.search', {
                  defaultValue: 'Order ID, phone, or coupon code',
                })}
                placeholder={t('couponApprovals.search', {
                  defaultValue: 'Order ID, phone, or coupon code',
                })}
              />
              <label className="flex flex-col gap-1">
                <span className={FIELD_LABEL}>
                  {t('complaintDash.from', { defaultValue: 'From' })}
                </span>
                <DateField
                  size="md"
                  className="w-[9.5rem]"
                  value={from}
                  onChange={(v) => setFrom(v)}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className={FIELD_LABEL}>{t('complaintDash.to', { defaultValue: 'To' })}</span>
                <DateField size="md" className="w-[9.5rem]" value={to} onChange={(v) => setTo(v)} />
              </label>
              {/* The page opens with no search and no dates, so anything in
                  either is something to clear. The status tabs are not part
                  of Clear and never were. */}
              <ClearFiltersButton
                className="self-end"
                active={!!(query || from || to)}
                onClear={() => {
                  setQuery('');
                  setFrom('');
                  setTo('');
                }}
                label={t('complaintDash.clear', { defaultValue: 'Clear' })}
              />
              <span className="ms-auto self-end pb-2.5 text-xs tabular-nums text-muted-foreground">
                {t('couponApprovals.showing', {
                  shown: rows.length,
                  total: all.length,
                  defaultValue: '{{shown}} of {{total}}',
                })}
              </span>
            </div>
          </div>

          {approvals.isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-32 w-full rounded-2xl" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            // Composed, not a bare sentence adrift in a card: a cleared queue is
            // the good ending of this page and should look like one.
            <div className="rounded-2xl bg-card shadow-soft ring-1 ring-foreground/[0.06]">
              <EmptyState
                icon={view === 'pending' ? <SparkleIcon size={22} /> : <InboxIcon size={22} />}
                title={
                  view === 'pending'
                    ? t('couponApprovals.clear', {
                        defaultValue: 'Nothing waiting. The queue is clear.',
                      })
                    : t('couponApprovals.none', { defaultValue: 'Nothing here.' })
                }
                description={
                  // Only the good ending gets a second line — it tells the
                  // supervisor where the decided requests went, which is the
                  // question a suddenly empty queue raises.
                  view === 'pending'
                    ? t('couponApprovals.clearHint', {
                        defaultValue: 'Decided requests move to the Approved and Rejected tabs.',
                      })
                    : undefined
                }
              />
            </div>
          ) : (
            <ul className="space-y-3">
              {rows.map((row) => (
                <Row
                  key={row.id}
                  row={row}
                  busy={decide.isPending}
                  correction={correctionOf(row, stamps.data)}
                  replacement={replacements.data?.get(row.id)}
                  onDecide={(approve, note, edits) => onDecide(row, approve, note, edits)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      {/*
        A COUPON GRANT IS IRREVERSIBLE from our side — deleting the CRM row does
        not revoke it on Yiji. So this states the count, the total money, and
        what it will NOT touch, rather than asking "are you sure".
      */}
      <ConfirmDialog
        open={confirmAll}
        title={t('couponApprovals.approveAllTitle', {
          count: approvable.length,
          defaultValue: 'Approve {{count}} coupons?',
        })}
        description={
          <div className="space-y-2">
            <p>
              {t('couponApprovals.approveAllBody', {
                defaultValue:
                  'Every request shown by the current filters is approved and sent to the customer. This cannot be undone.',
              })}
            </p>
            {skipped > 0 && (
              <p className="text-muted-foreground">
                {t('couponApprovals.approveAllSkipped', {
                  count: skipped,
                  defaultValue:
                    '{{count}} are left alone because their terms are invalid — decide those one at a time.',
                })}
              </p>
            )}
          </div>
        }
        confirmLabel={t('couponApprovals.approve', { defaultValue: 'Approve' })}
        cancelLabel={t('actions.cancel', { ns: 'common', defaultValue: 'Cancel' })}
        loading={bulkBusy}
        onConfirm={() => void approveAll()}
        onCancel={() => setConfirmAll(false)}
      />
    </div>
  );
}
