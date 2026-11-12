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

  filter('coupon_approvals.items.update', async (payload, meta, context) => {
    if (!payload || typeof payload !== 'object') return payload;
    const touched = COUPON_TERM_FIELDS.filter((f) => f in payload);
    if (touched.length === 0) return payload;
    const acc = context?.accountability;
    /* No accountability = Directus itself (migrations, flows run as system). */
    if (!acc) return payload;
    if ((await roleName(acc.role)) === WRITER_ROLE) return payload;

    const keys = Array.isArray(meta?.keys) ? meta.keys : [];
    if (keys.length === 0) return payload;
    const rows = await database('coupon_approvals')
      .whereIn('id', keys)
      .whereNotNull('yiji_coupon_id')
      .select(['id', 'coupon_code', ...touched]);
    for (const row of rows) {
      const changed = touched.filter((f) => !sameTerm(f, row[f], payload[f]));
      if (changed.length) {
        throw new ForbiddenishError(
          `Coupon ${row.coupon_code ?? row.id} is already on Yiji: its terms (${changed.join(', ')}) change only through "Edit coupon" on its ticket, so Yiji and the CRM stay the same.`,
        );
      }
    }
    return payload;
  });
};
