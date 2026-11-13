/**
 * Directus hook: coupon-terms-guard (owner, 2026-11-12).
 *
 * "Yiji and the CRM must never disagree." Once a coupon is ON YIJI
 * (`yiji_coupon_id` set), its terms change in ONE way only: the workers'
 * edit-in-place job, which switches the coupon off on Yiji, changes it there,
 * reads it back and only then writes the same values here.
 *
 * Roles that approve coupons hold `update` on every coupon_approvals field
 * (approving writes the decision), so before this a PATCH from the API or the
 * Directus app could change a delivered coupon's amount in the CRM alone -
 * the customer kept the old coupon and the reports showed a value nobody got.
 * Now such a PATCH is refused for everyone but the workers' service account
 * (`svc-workers`) - the Administrator included: an emergency change still
 * goes through the edit, never around it.
 *
 * Coupons not on Yiji yet (pending, approved and not sent, withheld) are
 * untouched: the push sends whatever the row holds. A PATCH that resends the
 * SAME values (e.g. a whole-object save) is not a change and passes.
 */
export const COUPON_TERM_FIELDS = [
  'coupon_code',
  'title',
  'issuing_side',
  'delivery_type',
  'coupon_type',
  'discount_category',
  'coupon_value',
  'coupon_percent',
  'max_discount',
  'valid_from',
  'valid_to',
  'usage_limit',
  'total_discount_limit',
  'item_name',
  'item_sku',
  'no_other_discounts',
];

const WRITER_ROLE = 'svc-workers';

class ForbiddenishError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DirectusError';
    this.code = 'FORBIDDEN';
    this.status = 403;
    this.extensions = {};
  }
}
Object.defineProperty(ForbiddenishError.prototype, Symbol.for('directus-error'), { value: true });

/** Same value, however it is spelled: "3.00000" = 3, "" = null, a date by day. */
export function sameTerm(field, a, b) {
  const blank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
  if (blank(a) || blank(b)) return blank(a) && blank(b);
  if (field === 'valid_from' || field === 'valid_to') {
    return String(a).slice(0, 10) === String(b).slice(0, 10);
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    return (a === true || a === 'true' || a === 1) === (b === true || b === 'true' || b === 1);
  }
  const na = Number(a);
  const nb = Number(b);
  if (
    Number.isFinite(na) &&
    Number.isFinite(nb) &&
    String(a).trim() !== '' &&
    String(b).trim() !== ''
  ) {
    return Math.round(na * 100) === Math.round(nb * 100);
  }
  return String(a).trim() === String(b).trim();
}

/**
 * EVERY COUPON IS COMPLETE (owner, 2026-11-14): "No coupon creation should be
 * allowed without entering all the required fields". A request saved from the
 * ticket Edit form on 13 Nov carried only an amount - no type, category, dates,
 * uses or limit. The forms check this; THIS is the backstop behind every door
 * (any screen, the API, the Directus app): a create, a change of terms, or an
 * approval is refused unless the coupon AS IT WOULD BE STORED is complete.
 * Rejecting an incomplete request stays allowed.
 *
 * Mirrors packages/shared-types coupon-request.ts (couponTypeProblem,
 * couponTermsProblems, couponLimitProblem, CouponRequestDraftChecked).
 */
const blankish = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const num = (v) => (blankish(v) ? NaN : Number(v));
const isPct = (c) => String(c ?? '').trim().toLowerCase().startsWith('percent');
const isGeneral = (t) => ['general', 'public'].includes(String(t ?? '').trim().toLowerCase());
const day = (v) => (blankish(v) ? '' : String(v).slice(0, 10));

export function couponIncomplete(row) {
  const out = [];
  const type = String(row.coupon_type ?? '').trim().toLowerCase();
  if (!['private', 'general', 'public'].includes(type)) out.push('coupon type (Private or General)');
  if (blankish(row.discount_category)) out.push('discount category');
  const pct = isPct(row.discount_category);
  const value = num(row.coupon_value);
  const percent = num(row.coupon_percent);
  const cap = num(row.max_discount);
  if (pct) {
    if (!(percent > 0 && percent <= 100)) out.push('percentage');
    if (!(cap > 0)) out.push('maximum discount');
  } else if (!blankish(row.discount_category) && !(value > 0)) out.push('coupon value');
  const from = day(row.valid_from);
  const to = day(row.valid_to);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) out.push('valid from date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) out.push('valid to date');
  else if (from && to < from) out.push('valid to date (it is before the start date)');
  const uses = num(row.usage_limit);
  if (!(Number.isInteger(uses) && uses >= 1)) out.push('number of uses');
  const perUse = pct ? cap : value;
  const stored = num(row.total_discount_limit);
  const limit = stored > 0 ? stored : isGeneral(row.coupon_type) ? NaN : uses > 0 && perUse > 0 ? uses * perUse : NaN;
  if (!(limit > 0)) out.push('total discount limit');
  else if (perUse > 0 && limit < perUse) out.push('total discount limit (below one use)');
  return out;
}

const incompleteMessage = (code, missing) =>
  `Coupon ${code ? code + ' ' : ''}is not complete - missing or wrong: ${missing.join(', ')}. Every coupon needs its type, category, amount, dates, number of uses and total limit.`;

export default ({ filter }, { database }) => {
  const roleNames = new Map();
  async function roleName(id) {
    if (!id) return null;
    if (!roleNames.has(id)) {
      const row = await database('directus_roles').where({ id }).first('name');
      roleNames.set(id, row?.name ?? null);
    }
    return roleNames.get(id);
  }

  filter('coupon_approvals.items.create', async (payload, _meta, context) => {
    if (!payload || typeof payload !== 'object') return payload;
    if (!context?.accountability) return payload;
    if ((await roleName(context.accountability.role)) === WRITER_ROLE) return payload;
    const missing = couponIncomplete(payload);
    if (missing.length) throw new ForbiddenishError(incompleteMessage(payload.coupon_code, missing));
    return payload;
  });

  filter('coupon_approvals.items.update', async (payload, meta, context) => {
    if (!payload || typeof payload !== 'object') return payload;
    const touched = COUPON_TERM_FIELDS.filter((f) => f in payload);
    const approving = payload.status === 'approved';
    if (touched.length === 0 && !approving) return payload;
    const acc = context?.accountability;
    /* No accountability = Directus itself (migrations, flows run as system). */
    if (!acc) return payload;
    if ((await roleName(acc.role)) === WRITER_ROLE) return payload;

    const ids = Array.isArray(meta?.keys) ? meta.keys : [];
    if (ids.length === 0) return payload;
    const current = await database('coupon_approvals')
      .whereIn('id', ids)
      .select(['id', 'status', 'yiji_coupon_id', ...COUPON_TERM_FIELDS]);
    for (const row of current) {
      const changed = touched.filter((f) => !sameTerm(f, row[f], payload[f]));
      /* 1. On Yiji: terms change only through the workers' edit. */
      if (row.yiji_coupon_id != null && changed.length) {
        throw new ForbiddenishError(
          `Coupon ${row.coupon_code ?? row.id} is already on Yiji: its terms (${changed.join(', ')}) change only through "Edit coupon" on its ticket, so Yiji and the CRM stay the same.`,
        );
      }
      /* 2. Complete, judged on the coupon AS IT WILL BE after this save (the
         stored row with this payload on top - an edit of one value keeps every
         other). Only when a term really changes or it is being approved: a
         re-save of the same values is not a new coupon. */
      if (changed.length || (approving && row.status !== 'approved')) {
        const missing = couponIncomplete({ ...row, ...payload });
        if (missing.length) throw new ForbiddenishError(incompleteMessage(row.coupon_code, missing));
      }
    }
    return payload;
  });
};
