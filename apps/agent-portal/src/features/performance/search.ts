import { couponDecision, normalizePhone } from '@yiji/shared-types';

/**
 * ONE SEARCH BOX FOR THE THREE TABS (owner, 2026-10-07): "search by customer
 * number, ticket id, or ticket title".
 *
 * A customer's number reaches an agent in any of three spellings — 05…, +9665…,
 * 9665… — and is stored canonically as 05… (see normalizePhone). Comparing the
 * typed text as-is would make the same customer findable or not depending on
 * how the caller read it out, so the DIGITS of the query are brought to the
 * stored form before they are compared.
 */
export function phoneQueryDigits(query: string): string {
  let d = query.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('966')) {
    const rest = d.slice(3).replace(/^0+/, '');
    d = rest ? `0${rest}` : '';
  }
  return d;
}

export interface SearchableRow {
  /** Phone numbers on the row, in any spelling. */
  phones: Array<string | null | undefined>;
  /** Ids, order numbers, titles, codes, names — matched as plain text. */
  text: Array<string | number | null | undefined>;
}

/** Does the row match what was typed? An empty query matches everything. */
export function matchesSearch(query: string, row: SearchableRow): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (row.text.some((v) => v != null && String(v).toLowerCase().includes(q))) return true;
  /* Three digits at least before a number is treated as a phone: "5" alone
     would match every Saudi mobile on the page. */
  const digits = phoneQueryDigits(q);
  if (digits.length < 3) return false;
  return row.phones.some((p) => {
    const canonical = normalizePhone(p ?? '').replace(/\D/g, '');
    return canonical !== '' && canonical.includes(digits);
  });
}

/** Where a coupon request stands, in the words an agent repeats to a customer. */
export type CouponStage =
  | 'waitingApproval'
  | 'approved'
  | 'delivered'
  | 'createdNotAssigned'
  | 'waitingSignup'
  | 'rejected';

export function couponStage(r: {
  status: string | null | undefined;
  delivery_excluded?: boolean | null;
  yiji_coupon_id?: string | null;
  awaiting_signup_at?: string | null;
}): CouponStage {
  const decision = couponDecision(r.status);
  if (decision === 'rejected') return 'rejected';
  if (decision === 'pending') return 'waitingApproval';
  /* Withheld from the customer but created on Yiji unassigned (owner,
     2026-10-06) — "delivered" would promise the customer something. */
  if (r.delivery_excluded === true && r.yiji_coupon_id) return 'createdNotAssigned';
  if ((r.status ?? '').trim().toLowerCase() === 'assigned') return 'delivered';
  /* Approved but held: the customer has no Yiji account yet (EMA-49). */
  if (r.awaiting_signup_at) return 'waitingSignup';
  return 'approved';
}

/** Middle value, or null for an empty list. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/** Mean, rounded to the second, or null for an empty list. */
export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}
